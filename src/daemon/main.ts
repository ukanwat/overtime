import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { paths, home } from "../paths.js";
import { Runtime } from "./runtime.js";
import { ControlServer } from "./control.js";
import { takeLock } from "./lock.js";
import { AGENT_MARKER } from "../runtime/leftovers.js";
import { HANDOVER_EXIT, relaunchAfterExit, Updater } from "./update.js";

/** overtimed: the always-on process. One per machine (per OVERTIME_HOME). */
async function main() {
  // Started from an agent's shell, the daemon would inherit that agent's marker and pass it to
  // everything it starts (watches, other agents' tools). It belongs to no agent.
  delete process.env[AGENT_MARKER];
  mkdirSync(home(), { recursive: true });
  // The log rotates at 10 MB (one older file kept), so it never grows without limit.
  let written = 0;
  const log = (line: string) => {
    const l = `${new Date().toISOString()} ${line}\n`;
    try {
      if ((written += l.length) > 256 * 1024) {
        written = 0;
        if (statSync(paths.daemonLog()).size > 10 * 1024 * 1024) renameSync(paths.daemonLog(), paths.daemonLog() + ".1");
      }
      appendFileSync(paths.daemonLog(), l);
    } catch {}
    if (process.stdout.isTTY) process.stdout.write(l);
  };

  // Single instance: see lock.ts for why two daemons starting at once can't both win. Nothing that
  // touches an agent happens before this process is certainly the one daemon (lock taken and control
  // socket bound), so one that loses exits without side effects.
  const lock = await takeLock();
  if (!lock) {
    log("another daemon is running; exiting");
    process.exit(0);
  }

  const rt = new Runtime(log);
  let shuttingDown = false;
  const shutdown = async (why: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why})`);
    updater.stop();
    await control.stop().catch(() => {});
    await rt.stop().catch((e) => log(`stop: ${e}`));
    lock.release();
    process.exit(code);
  };
  // A newer version installed: its daemon starts once this one has stopped, and carries on what was running.
  const updater = new Updater({
    log,
    notify: (title, body) => rt.notify(title, body),
    onNotice: () => control.noticeReady(),
    handover: async (version, mainJs) => {
      relaunchAfterExit(process.pid, mainJs);
      await shutdown(`handing over to ${version}`, HANDOVER_EXIT);
    },
  });
  const control = new ControlServer(rt, log, () => void shutdown("requested"), updater);
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e: any) => log(`unhandled: ${e?.stack ?? e}`));

  try {
    await control.start();
  } catch (e: any) {
    log(`can't open the control socket: ${e?.message ?? e}; exiting`);
    lock.release();
    process.exit(1);
  }
  lock.announce();
  await rt.start();
  control.open();
  log(`overtimed ready (pid ${process.pid}, home ${home()})`);
  updater.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
