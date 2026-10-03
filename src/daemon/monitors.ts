import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { home } from "../paths.js";
import type { Store } from "../store/store.js";
import type { Monitor } from "../store/types.js";
import { sandboxLaunch } from "../runtime/sandbox.js";

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
  /** The agent's protected paths; watches run under the same rules as its sessions. */
  protect?: string[];
}

const RUN_TIMEOUT_MS = 2 * 60_000;
const MAX_HELD_LINES = 200;
const FAILURES_BEFORE_REPORT = 3;

/**
 * Runs agents' monitor scripts without any model. Long-running scripts: each printed line is an event.
 * Repeating scripts: run on a schedule, fire when output changes (the first run only sets the baseline).
 */
const pidFile = () => join(home(), "monitor-pids.json");

/**
 * Long-running monitor processes, by process group, with the command each runs, so a crashed daemon's
 * leftovers can be cleaned up without ever touching a process that merely reused the number.
 */
const livePids = new Map<number, string>();
function savePids() {
  try {
    writeFileSync(pidFile(), JSON.stringify([...livePids].map(([pid, cmd]) => ({ pid, cmd }))));
  } catch {}
}

/** The command line of a running process, or null if there is none. */
function commandOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

/** Kill monitor processes left behind by a previous daemon that didn't shut down cleanly. */
export function reapStaleMonitors(): number {
  let saved: { pid: number; cmd: string }[] = [];
  try {
    const raw = JSON.parse(readFileSync(pidFile(), "utf8"));
    saved = Array.isArray(raw) ? raw.filter((x) => x && typeof x.pid === "number" && typeof x.cmd === "string") : [];
  } catch {}
  let n = 0;
  for (const { pid, cmd } of saved) {
    // Only if that pid is still our shell running that exact watch.
    const now = commandOf(pid);
    if (!now || !now.includes("/bin/sh -c") || !now.includes(cmd.slice(0, 200))) continue;
    try {
      process.kill(-pid, "SIGKILL");
      n++;
    } catch {}
  }
  livePids.clear();
  savePids();
  return n;
}

export class MonitorRunner {
  private running = new Map<string, Running>();

  constructor(
    private readonly ev: MonitorEvents,
    private readonly storeFor: (agent: string) => Store,
    private readonly cwdFor: (agent: string) => string,
    private readonly protectFor: (agent: string) => Promise<string[]> = async () => [],
  ) {}

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
    void Promise.all([this.storeFor(agent).monitors(), this.protectFor(agent).catch(() => [] as string[])]).then(([ms, protect]) => {
      r.protect = protect;
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
    // Everything was just killed: nothing is left for a later daemon to reap.
    livePids.clear();
    savePids();
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
      const l = launch(m.run, r.protect);
      if ("error" in l) return void this.failed(r, l.error);
      const proc = spawn(l.command, l.args, { cwd: this.cwdFor(r.agent), stdio: ["ignore", "pipe", "pipe"], detached: true });
      r.proc = proc;
      if (proc.pid) {
        livePids.set(proc.pid, m.run);
        savePids();
      }
      let stderr = "";
      proc.stderr?.on("data", (c) => (stderr = (stderr + c.toString()).slice(-2000)));
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        if (line.trim()) void this.deliver(r, [line]);
      });
      proc.on("error", (e) => void this.failed(r, `could not start: ${e.message}`));
      proc.on("exit", (code, sig) => {
        rl.close();
        if (proc.pid) {
          livePids.delete(proc.pid);
          savePids();
        }
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
        const { code, stdout, stderr } = await runOnce(m.run, this.cwdFor(r.agent), RUN_TIMEOUT_MS, r.protect);
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
  const sig = (s: NodeJS.Signals) => {
    try {
      if (p.pid) process.kill(-p.pid, s);
    } catch {
      try {
        p.kill(s);
      } catch {}
    }
  };
  sig("SIGTERM");
  setTimeout(() => sig("SIGKILL"), 2000).unref();
}

/** A watch's shell, with the agent's protected paths read-only. Protection that can't be enforced is an error, never a silent bypass. */
function launch(cmd: string, protect: string[] = []): { command: string; args: string[] } | { error: string } {
  const l = sandboxLaunch("/bin/sh", ["-c", cmd], protect);
  return !protect.length || l.sandboxed ? l : { error: `Can't protect the paths in your settings: ${l.why}` };
}

function runOnce(cmd: string, cwd: string, timeoutMs: number, protect?: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const l = launch(cmd, protect);
    if ("error" in l) return resolve({ code: 126, stdout: "", stderr: l.error });
    const p = spawn(l.command, l.args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
