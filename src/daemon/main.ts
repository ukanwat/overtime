import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
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

  // Single instance: a lock file with our pid; a stale lock from a dead process is taken over.
  const lock = paths.daemonLock();
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      if (pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {}
    if (alive && pid !== process.pid) {
      log(`another daemon is running (pid ${pid}); exiting`);
      process.exit(0);
    }
  }
  writeFileSync(lock, String(process.pid));

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
