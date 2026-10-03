import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { sep } from "node:path";

const run = promisify(execFile);

/**
 * Processes a session left running after it ended (`cmd &`, `nohup`, a server started and forgotten).
 * Backends run each shell command in its own process group, so these escape the session's group and
 * are re-parented to init. A process is only counted as left behind if all three hold: its parent is
 * gone (ppid 1), it started while the session ran, and its working folder is the agent's own folder or
 * workspace. Apps and terminals you start yourself never match.
 */
export async function findLeftovers(since: number, roots: string[]): Promise<number[]> {
  const real = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  const inside = (p: string) => real.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
  let out = "";
  try {
    ({ stdout: out } = await run("ps", ["-x", "-o", "pid=,ppid=,lstart="], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m || m[2] !== "1") continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const started = new Date(m[3]).getTime();
    // lstart has one-second resolution.
    if (!Number.isFinite(started) || started < since - 1000) continue;
    const cwd = await cwdOf(pid);
    if (cwd && inside(cwd)) found.push(pid);
  }
  return found;
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

/** Stop what a session left behind: politely, then for good. Returns how many processes it stopped. */
export async function stopLeftovers(since: number, roots: string[]): Promise<number> {
  const pids = await findLeftovers(since, roots);
  const signal = (sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(-pid, sig); // its own group, if it leads one
      } catch {}
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  if (!pids.length) return 0;
  signal("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  signal("SIGKILL");
  return pids.length;
}
