import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { DaemonClient } from "./client.js";
import { execFileSync } from "node:child_process";
import { paths, home } from "../paths.js";
import { Runtime } from "./runtime.js";
import { ControlServer } from "./control.js";

/** overtimed: the always-on process. One per machine (per OVERTIME_HOME). */
async function main() {
  mkdirSync(home(), { recursive: true });
  const log = (line: string) => {
    const l = `${new Date().toISOString()} ${line}\n`;
    try {
      appendFileSync(paths.daemonLog(), l);
    } catch {}
    if (process.stdout.isTTY) process.stdout.write(l);
  };

  // Single instance. The lock is created exclusively, so two daemons starting at once can't both win.
  // A lock left by a dead process is taken over; one held by a live daemon that answers means we exit.
  const lock = paths.daemonLock();
  if (!(await takeLock(lock))) {
    log("another daemon is running; exiting");
    process.exit(0);
  }

  const rt = new Runtime(log);
  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why})`);
    await control.stop().catch(() => {});
    await rt.stop().catch((e) => log(`stop: ${e}`));
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {}
    process.exit(0);
  };
  const control = new ControlServer(rt, log, () => void shutdown("requested"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e: any) => log(`unhandled: ${e?.stack ?? e}`));

  await rt.start();
  await control.start();
  log(`overtimed ready (pid ${process.pid}, home ${home()})`);
}

async function takeLock(lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    let pid = 0;
    try {
      pid = Number(readFileSync(lock, "utf8"));
    } catch {}
    if (!pid) {
      // Just created by another daemon that hasn't written its pid yet.
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (pid !== process.pid && isOvertimeDaemon(pid)) {
      // A live daemon, possibly still starting up: give it time to answer before deciding anything.
      for (let i = 0; i < 20; i++) {
        if (await daemonAnswers()) return false;
        if (!isOvertimeDaemon(pid)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (isOvertimeDaemon(pid)) return false; // alive but silent: never take its place
    }
    // The pid is gone, or belongs to some unrelated process that reused the number: the lock is stale.
    try {
      unlinkSync(lock);
    } catch {}
  }
  return false;
}

/** Whether a pid is a running Overtime daemon (not just any process with that number). */
function isOvertimeDaemon(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
