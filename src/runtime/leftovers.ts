import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { join, sep } from "node:path";
import { paths } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";
import { withLock } from "../store/mutex.js";

const run = promisify(execFile);

/**
 * Processes an agent keeps running in the background (`cmd &`, `nohup`, a dev server). Agents decide
 * what runs how: Overtime doesn't stop these when a session ends. It records them, so the agent sees
 * them every turn (and can stop, restart or keep them) and you see them in its settings; they stop
 * when the agent is stopped or archived.
 *
 * Every backend Overtime starts carries OVERTIME_AGENT=<name> in its environment, and everything it
 * starts inherits it. Where the system lets a process's environment be read (Linux), that marker is
 * what counts: a process that has it and outlived the agent's sessions is the agent's.
 *
 * Elsewhere (macOS hides other processes' environments, and nothing records who started a process once
 * its parent has exited), backends run each shell command in a process group of its own, so what it
 * leaves running is re-parented to init and keeps that shell's group after the shell exits. A process
 * counts as the agent's only if all of these hold:
 * - its parent is gone (ppid 1) and so is the leader of its process group: a shell's leftover. A
 *   process leading its own group is a job you started from a terminal, or a daemon that detached
 *   itself (gradle, bazel), and is never taken.
 * - it started while the agent's sessions ran;
 * - its working folder is the agent's own folder or workspace, and no other agent's session worked
 *   in that folder when it started: there it could be either agent's, so it's neither's.
 * And on every system, a process another agent has already recorded is never taken. Better to miss
 * one of the agent's own (it just isn't listed or stopped) than to stop someone else's.
 */

/** The environment variable that marks a backend, and everything it starts, as an agent's. */
export const AGENT_MARKER = "OVERTIME_AGENT";
export interface BackgroundProcess {
  pid: number;
  /** ps lstart, so a reused pid is never mistaken for this process. */
  started: string;
  command: string;
  cwd: string;
}

/** When each agent's sessions ran and in which folders, so a folder two agents worked in at once isn't taken as proof of either. */
const spans: { agent: string; roots: string[]; from: number; to: number | null }[] = [];
const SPAN_KEEP_MS = 24 * 3600_000;

/** A session of the agent's started, working in these folders. Returns what to call when it ends. */
export function sessionSpan(agent: string, roots: string[]): () => void {
  const span = { agent, roots: roots.map(realOr), from: Date.now(), to: null as number | null };
  spans.push(span);
  return () => {
    span.to = Date.now();
    // Long over: no session still being recorded can overlap it.
    for (let i = spans.length - 1; i >= 0; i--) if (spans[i].to !== null && spans[i].to! < Date.now() - SPAN_KEEP_MS) spans.splice(i, 1);
  };
}

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Whether another agent's session was working in the folder `cwd` is in at time `t`. */
function shared(agent: string | undefined, cwd: string, t: number): boolean {
  return spans.some((s) => s.agent !== agent && s.from - 1000 <= t && t <= (s.to ?? Date.now()) + 1000 && s.roots.some((r) => inside(cwd, r)));
}

/** What other agents have recorded as theirs ("pid started" keys). */
async function othersRecorded(agent: string): Promise<Set<string>> {
  const names = await readdir(paths.agentsDir()).catch(() => [] as string[]);
  const keys = new Set<string>();
  for (const n of names) {
    if (n === agent) continue;
    for (const b of await readJson<BackgroundProcess[]>(file(n), [])) keys.add(`${b.pid} ${b.started}`);
  }
  return keys;
}

const file = (agent: string) => join(paths.meta(agent), "background.json");

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
  command: string;
}

async function ps(): Promise<PsRow[]> {
  try {
    // The C locale, so lstart is always the same five English fields whatever the person's language.
    const { stdout } = await run("ps", ["-x", "-o", "pid=,ppid=,pgid=,lstart=,command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    const rows: PsRow[] = [];
    for (const line of stdout.split("\n")) {
      // lstart is a fixed five-field date: "Sat Oct  3 23:26:41 2026".
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4].replace(/\s+/g, " "), command: m[5] });
    }
    return rows;
  } catch {
    return [];
  }
}

async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === "linux") return readlink(`/proc/${pid}/cwd`).catch(() => null);
  try {
    const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5_000 });
    const n = stdout.split("\n").find((l) => l.startsWith("n"));
    return n ? n.slice(1) : null;
  } catch {
    return null;
  }
}

/** The agent a process was started for, from its environment: null if unmarked, undefined where that can't be read. */
async function markerOf(pid: number): Promise<string | null | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const env = await readFile(`/proc/${pid}/environ`, "utf8");
    const entry = env.split("\0").find((e) => e.startsWith(`${AGENT_MARKER}=`));
    return entry ? entry.slice(AGENT_MARKER.length + 1) : null;
  } catch {
    return null;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Processes left running by the agent's sessions that ran since `since` (inside the given folders, where that's the test). */
export async function findLeftovers(since: number, roots: string[], agent?: string): Promise<BackgroundProcess[]> {
  const real = roots.map(realOr);
  const found: BackgroundProcess[] = [];
  const rows = await ps();
  const running = new Set(rows.map((r) => r.pid));
  const taken = agent ? await othersRecorded(agent) : new Set<string>();
  for (const r of rows) {
    if (r.pid === process.pid || taken.has(`${r.pid} ${r.started}`)) continue;
    const t = new Date(r.started).getTime();
    if (!Number.isFinite(t) || t < since - 1000) continue; // lstart has one-second resolution
    // Marked as this agent's: it is, wherever it runs. Marked as another agent's: it isn't. Unmarked
    // (or where environments can't be read): the parent, start time and folder tell.
    const marker = agent ? await markerOf(r.pid) : undefined;
    if (marker === agent && agent) {
      found.push({ pid: r.pid, started: r.started, command: r.command, cwd: (await cwdOf(r.pid)) ?? "" });
      continue;
    }
    if (marker) continue;
    if (r.ppid !== 1 || r.pgid === r.pid || running.has(r.pgid)) continue;
    const cwd = await cwdOf(r.pid);
    if (cwd && real.some((root) => inside(cwd, root)) && !shared(agent, cwd, t)) found.push({ pid: r.pid, started: r.started, command: r.command, cwd });
  }
  return found;
}

/** The agent's background processes that are still the same processes and still running. */
export async function liveBackground(agent: string): Promise<BackgroundProcess[]> {
  return withLock(`background:${agent}`, async () => {
    const saved = await readJson<BackgroundProcess[]>(file(agent), []);
    if (!saved.length) return [];
    const now = new Map((await ps()).map((r) => [r.pid, r]));
    const live = saved.filter((b) => now.get(b.pid)?.started === b.started);
    if (live.length !== saved.length) await writeJson(file(agent), live);
    return live;
  });
}

/** After the agent's last session ended: remember what it left running. Returns what's new. */
export async function recordLeftovers(agent: string, since: number, roots: string[]): Promise<BackgroundProcess[]> {
  const found = await findLeftovers(since, roots, agent);
  if (!found.length) return [];
  return withLock(`background:${agent}`, async () => {
    const saved = await readJson<BackgroundProcess[]>(file(agent), []);
    const fresh = found.filter((f) => !saved.some((s) => s.pid === f.pid && s.started === f.started));
    if (fresh.length) await writeJson(file(agent), [...saved, ...fresh]);
    return fresh;
  });
}

/** Stop an agent's background processes (the agent was stopped or archived). Returns how many. */
export async function stopBackground(agent: string): Promise<number> {
  // One another agent recorded too (lists from before the rule above) could be either's: left running.
  const taken = await othersRecorded(agent);
  const live = (await liveBackground(agent)).filter((b) => !taken.has(`${b.pid} ${b.started}`));
  const signal = (sig: NodeJS.Signals) => {
    for (const b of live) {
      try {
        process.kill(-b.pid, sig); // its own group, if it leads one (a server and its workers)
      } catch {}
      try {
        process.kill(b.pid, sig);
      } catch {}
    }
  };
  if (!live.length) return 0;
  signal("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  signal("SIGKILL");
  await liveBackground(agent);
  return live.length;
}
