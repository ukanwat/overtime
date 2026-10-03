import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
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
 * Backends run each shell command in its own process group, so these are re-parented to init when
 * the shell that started them exits. A process counts as the agent's if all three hold: its parent is
 * gone (ppid 1), it started while the agent's sessions ran, and its working folder is the agent's own
 * folder or workspace. Apps and terminals you start yourself never match.
 */
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
    const { stdout } = await run("ps", ["-x", "-o", "pid=,ppid=,lstart=,command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
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

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Processes left running by sessions that ran since `since`, inside the given folders. */
export async function findLeftovers(since: number, roots: string[]): Promise<BackgroundProcess[]> {
  const real = roots.map(realOr);
  const inside = (p: string) => real.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
  const found: BackgroundProcess[] = [];
  for (const r of await ps()) {
    if (r.ppid !== 1 || r.pid === process.pid) continue;
    const t = new Date(r.started).getTime();
    if (!Number.isFinite(t) || t < since - 1000) continue; // lstart has one-second resolution
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
  const found = await findLeftovers(since, roots);
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
