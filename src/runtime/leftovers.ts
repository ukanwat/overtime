import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
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
 * Elsewhere (macOS hides other processes' environments), backends run each shell command in its own
 * process group, so these are re-parented to init when the shell that started them exits. A process
 * counts as the agent's if all three hold: its parent is gone (ppid 1), it started while the agent's
 * sessions ran, and its working folder is the agent's own folder or workspace. Apps and terminals you
 * start yourself never match.
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

const file = (agent: string) => join(paths.meta(agent), "background.json");

interface PsRow {
  pid: number;
  ppid: number;
  started: string;
  command: string;
}

async function ps(): Promise<PsRow[]> {
  try {
    // The C locale, so lstart is always the same five English fields whatever the person's language.
    const { stdout } = await run("ps", ["-x", "-o", "pid=,ppid=,lstart=,command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    const rows: PsRow[] = [];
    for (const line of stdout.split("\n")) {
      // lstart is a fixed five-field date: "Sat Oct  3 23:26:41 2026".
      const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3].replace(/\s+/g, " "), command: m[4] });
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
  const inside = (p: string) => real.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
  const found: BackgroundProcess[] = [];
  for (const r of await ps()) {
    if (r.pid === process.pid) continue;
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
    if (r.ppid !== 1) continue;
    const cwd = await cwdOf(r.pid);
    if (cwd && inside(cwd)) found.push({ pid: r.pid, started: r.started, command: r.command, cwd });
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
  const live = await liveBackground(agent);
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
