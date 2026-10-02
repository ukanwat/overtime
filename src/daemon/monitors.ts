import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Store } from "../store/store.js";
import type { Monitor } from "../store/types.js";

export interface MonitorEvents {
  /** The monitor fired: wake the agent with this output. */
  fire(agent: string, m: Monitor, output: string): void;
  /** The monitor keeps failing: tell the agent so it can fix or remove it. */
  failing(agent: string, m: Monitor, detail: string): void;
  log(line: string): void;
}

interface Running {
  agent: string;
  id: string;
  proc?: ChildProcess;
  timer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  cooldownTimer?: NodeJS.Timeout;
  /** Lines held back during a cooldown, delivered together when it ends. */
  held: string[];
  stopped: boolean;
}

const RUN_TIMEOUT_MS = 2 * 60_000;
const MAX_HELD_LINES = 200;
const FAILURES_BEFORE_REPORT = 3;

/**
 * Runs agents' monitor scripts without any model. Long-running scripts: each printed line is an event.
 * Repeating scripts: run on a schedule, fire when output changes (the first run only sets the baseline).
 */
export class MonitorRunner {
  private running = new Map<string, Running>();

  constructor(private readonly ev: MonitorEvents, private readonly storeFor: (agent: string) => Store, private readonly cwdFor: (agent: string) => string) {}

  private key(agent: string, id: string) {
    return `${agent}/${id}`;
  }

  async startAll(agent: string): Promise<void> {
    for (const m of await this.storeFor(agent).monitors()) if (m.status !== "removed") this.start(agent, m.id);
  }

  start(agent: string, id: string): void {
    const k = this.key(agent, id);
    if (this.running.has(k)) return;
    const r: Running = { agent, id, held: [], stopped: false };
    this.running.set(k, r);
    void this.storeFor(agent).monitors().then((ms) => {
      const m = ms.find((x) => x.id === id);
      if (!m || r.stopped) return this.running.delete(k);
      if (m.everyMs) this.startRepeating(r, m);
      else this.startLong(r, m);
    });
  }

  stop(agent: string, id: string): void {
    const k = this.key(agent, id);
    const r = this.running.get(k);
    if (!r) return;
    r.stopped = true;
    if (r.timer) clearInterval(r.timer);
    if (r.restartTimer) clearTimeout(r.restartTimer);
    if (r.cooldownTimer) clearTimeout(r.cooldownTimer);
    if (r.proc && r.proc.exitCode === null) killTree(r.proc);
    this.running.delete(k);
  }

  stopAgent(agent: string): void {
    for (const r of [...this.running.values()]) if (r.agent === agent) this.stop(agent, r.id);
  }

  stopAll(): void {
    for (const r of [...this.running.values()]) this.stop(r.agent, r.id);
  }

  private async current(r: Running): Promise<Monitor | null> {
    return (await this.storeFor(r.agent).monitors()).find((m) => m.id === r.id && m.status !== "removed") ?? null;
  }

  /** Fire now, or hold the output until the cooldown ends so a noisy monitor can't wake the agent constantly. */
  private async deliver(r: Running, lines: string[]): Promise<void> {
    const m = await this.current(r);
    if (!m || r.stopped) return;
    r.held.push(...lines);
    if (r.held.length > MAX_HELD_LINES) r.held = r.held.slice(-MAX_HELD_LINES);
    if (r.cooldownTimer) return;
    const since = m.lastFiredAt ? Date.now() - new Date(m.lastFiredAt).getTime() : Infinity;
    const wait = Math.max(0, m.cooldownMs - since);
    const flush = async () => {
      r.cooldownTimer = undefined;
      const out = r.held.join("\n");
      r.held = [];
      if (!out || r.stopped) return;
      const fresh = await this.storeFor(r.agent).patchMonitor(r.id, { lastFiredAt: new Date().toISOString(), failures: 0, status: "active" });
      if (fresh) this.ev.fire(r.agent, fresh, out);
    };
    if (wait === 0) await flush();
    else r.cooldownTimer = setTimeout(() => void flush(), wait);
  }

  private async failed(r: Running, detail: string): Promise<void> {
    const store = this.storeFor(r.agent);
    const m = await this.current(r);
    if (!m) return;
    const failures = m.failures + 1;
    const patched = await store.patchMonitor(r.id, { failures, status: failures >= FAILURES_BEFORE_REPORT ? "failing" : m.status });
    this.ev.log(`[${r.agent}] monitor ${r.id} failed (${failures}): ${detail.slice(0, 300)}`);
    if (patched && failures === FAILURES_BEFORE_REPORT) this.ev.failing(r.agent, patched, detail);
  }

  private startLong(r: Running, m: Monitor): void {
    const run = () => {
      if (r.stopped) return;
      const started = Date.now();
      const proc = spawn("/bin/sh", ["-c", m.run], { cwd: this.cwdFor(r.agent), stdio: ["ignore", "pipe", "pipe"], detached: true });
      r.proc = proc;
      let stderr = "";
      proc.stderr?.on("data", (c) => (stderr = (stderr + c.toString()).slice(-2000)));
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        if (line.trim()) void this.deliver(r, [line]);
      });
      proc.on("error", (e) => void this.failed(r, `could not start: ${e.message}`));
      proc.on("exit", (code, sig) => {
        rl.close();
        if (r.stopped) return;
        const ranFor = Date.now() - started;
        // A long-running monitor that exits is restarted. Quick exits count as failures and back off.
        if (ranFor < 30_000 || code !== 0) void this.failed(r, `exited (${sig ?? code}) after ${Math.round(ranFor / 1000)}s. ${stderr.trim()}`);
        void this.current(r).then((cur) => {
          if (!cur || r.stopped) return;
          const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(8, cur.failures));
          r.restartTimer = setTimeout(run, delay);
        });
      });
    };
    run();
  }

  private startRepeating(r: Running, m: Monitor): void {
    let busy = false;
    const tick = async () => {
      if (busy || r.stopped) return;
      busy = true;
      try {
        const { code, stdout, stderr } = await runOnce(m.run, this.cwdFor(r.agent), RUN_TIMEOUT_MS);
        if (r.stopped) return;
        if (code !== 0) {
          await this.failed(r, `exit ${code}. ${stderr.trim() || stdout.trim()}`.slice(0, 1000));
          return;
        }
        const cur = await this.current(r);
        if (!cur) return;
        const out = stdout.trim();
        if (cur.lastOutput === null) {
          await this.storeFor(r.agent).patchMonitor(r.id, { lastOutput: out, failures: 0, status: "active" });
          return;
        }
        if (out !== cur.lastOutput) {
          await this.storeFor(r.agent).patchMonitor(r.id, { lastOutput: out, failures: 0, status: "active" });
          await this.deliver(r, [out || "(output is now empty)"]);
        } else if (cur.failures) {
          await this.storeFor(r.agent).patchMonitor(r.id, { failures: 0, status: "active" });
        }
      } finally {
        busy = false;
      }
    };
    void tick();
    r.timer = setInterval(() => void tick(), m.everyMs!);
  }
}

function killTree(p: ChildProcess): void {
  try {
    if (p.pid) process.kill(-p.pid, "SIGTERM");
  } catch {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
}

function runOnce(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("/bin/sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (c) => (stdout = (stdout + c.toString()).slice(-200_000)));
    p.stderr?.on("data", (c) => (stderr = (stderr + c.toString()).slice(-20_000)));
    const t = setTimeout(() => killTree(p), timeoutMs);
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: 127, stdout, stderr: e.message });
    });
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
