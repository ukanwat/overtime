import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { paths } from "../paths.js";
import { DaemonClient } from "./client.js";

/**
 * The single-daemon lock: one daemon per OVERTIME_HOME, even when several start at the same moment
 * (app windows reconnecting together after an upgrade) and even over a lock left by a daemon that died.
 *
 * The lock is a series of numbered files in overtimed.locks/ ("generations"), each holding the pid
 * of the daemon that created it. The highest number is the current one. To take the lock a daemon
 * reads the highest generation n; if its daemon is alive it backs off, otherwise it creates n+1.
 * Every file is created with link(), which the OS makes atomic and which fails if the name exists,
 * so each number has exactly one creator, and the file appears with its pid already in it.
 *
 * Nothing is ever replaced or removed to take a lock over, so there is no "judged it stale, deleted
 * it, but meanwhile someone else had taken it" race: two daemons that both found n's owner dead both
 * try to create n+1, and only one can. The rules that keep this correct:
 * - A generation's owner is checked only after its file exists, so "dead" means dead for good
 *   (the pid was written before the file appeared). A pid that now belongs to some other program
 *   counts as dead; one that is another live daemon counts as alive (the safe side).
 * - The highest file is never removed: old ones are removed only by a holder whose own file is higher,
 *   and a daemon that stops cleanly adds a "released" generation (pid 0) above its own instead of
 *   deleting it. So the numbers only go up, and n+1 can't be created twice in the same "era".
 * - Removing old ones means a daemon that read n long ago could still create n+1 if it was removed
 *   meanwhile. That is why a new holder confirms afterwards that no higher generation exists: if one
 *   does, its view was out of date and it gives its file up. If none does, every generation ever
 *   created is at most n+1, n was the highest when it looked, and n's owner was dead: it is the one.
 *
 * overtimed.lock keeps holding the running daemon's pid, for people and for older versions of
 * Overtime (which use that file as their lock); it isn't what decides who runs.
 */
export interface DaemonLock {
  /** Show our pid in overtimed.lock, once we are certainly the daemon that runs. */
  announce(): void;
  /** Give the lock up on a clean stop, so the next daemon starts at once. */
  release(): void;
}

const RELEASED = 0;

export async function takeLock(): Promise<DaemonLock | null> {
  const dir = paths.daemonLocks();
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    const top = highest(dir);
    if (top) {
      const pid = ownerOf(dir, top);
      if (pid && pid !== process.pid && isOvertimeDaemon(pid)) {
        // A live daemon, possibly still starting up: give it time to answer before deciding anything.
        for (let i = 0; i < 20; i++) {
          if (await daemonAnswers()) return null;
          if (!isOvertimeDaemon(pid)) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (isOvertimeDaemon(pid)) return null; // alive but silent: never take its place
        continue; // it died meanwhile: look again
      }
    }
    const mine = top + 1;
    if (!create(dir, mine, process.pid)) continue; // another daemon got this number first
    if (highest(dir) > mine) {
      // Our view was out of date (that number had been cleared away); a newer generation decides.
      remove(join(dir, String(mine)));
      continue;
    }
    // Ours. Clear the older generations and leftovers.
    for (const f of readdirSync(dir)) {
      if (/^\d+$/.test(f) ? Number(f) < mine : !alive(Number(f.split("-")[1]))) remove(join(dir, f));
    }
    return {
      announce() {
        const tmp = paths.daemonLock() + `.tmp-${process.pid}`;
        try {
          writeFileSync(tmp, String(process.pid));
          renameSync(tmp, paths.daemonLock());
        } catch {}
      },
      release() {
        try {
          if (readFileSync(paths.daemonLock(), "utf8") === String(process.pid)) unlinkSync(paths.daemonLock());
        } catch {}
        // Only if ours is still the newest: otherwise there is nothing of ours to give up.
        if (highest(dir) === mine) create(dir, mine + 1, RELEASED);
      },
    };
  }
  return null;
}

/** The highest generation number in the lock folder, 0 if there is none. */
function highest(dir: string): number {
  let top = 0;
  for (const f of readdirSync(dir)) if (/^\d+$/.test(f)) top = Math.max(top, Number(f));
  return top;
}

function ownerOf(dir: string, n: number): number {
  try {
    return Number(readFileSync(join(dir, String(n)), "utf8")) || RELEASED;
  } catch {
    return RELEASED; // cleared away since: the next attempt finds the newer one
  }
}

/** Create generation n holding pid, all at once; false if it already exists. */
function create(dir: string, n: number, pid: number): boolean {
  const tmp = join(dir, `.tmp-${process.pid}-${n}`);
  writeFileSync(tmp, String(pid));
  try {
    linkSync(tmp, join(dir, String(n)));
    return true;
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    return false;
  } finally {
    remove(tmp);
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Whether a pid is a running Overtime daemon (not just any process with that number). */
function isOvertimeDaemon(pid: number): boolean {
  if (!alive(pid)) return false;
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    return /daemon[\/\\]main\.(js|ts)|overtime.* daemon/.test(cmd);
  } catch {
    return true;
  }
}

async function daemonAnswers(): Promise<boolean> {
  try {
    const c = await DaemonClient.connect();
    try {
      await c.call("ping", {}, 3_000);
      return true;
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}
