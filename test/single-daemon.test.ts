import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";
import { paths } from "../src/paths.js";
import { DaemonClient, ensureDaemon } from "../src/daemon/client.js";
import { takeLock } from "../src/daemon/lock.js";

/** A pid that certainly belonged to a process that has ended. */
function deadPid(): number {
  return Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const count = (text: string, what: string) => text.split(what).length - 1;

describe("several daemons starting at once", () => {
  it("leave exactly one running, which every client reaches; the others exit before touching anything", async () => {
    const home = fakeHome();
    const N = 5;
    let seen = 0;
    let leftover: "none" | "stale" | "killed" | "stopped" | "stopping" = "none";
    for (let round = 0; round < 20; round++) {
      if (leftover === "stale") {
        // Locks left by a daemon that died, in the old place and the new one, and its socket file.
        const pid = deadPid();
        writeFileSync(paths.daemonLock(), String(pid));
        mkdirSync(paths.daemonLocks(), { recursive: true });
        writeFileSync(join(paths.daemonLocks(), "7"), String(pid));
      }
      // As when app windows reconnect together: each finds no daemon and starts one.
      const clients = await Promise.all(Array.from({ length: N }, () => ensureDaemon()));
      const pids = await Promise.all(clients.map((c) => c.call<{ pid: number }>("ping").then((p) => p.pid)));
      const winner = pids[0];
      expect(new Set(pids)).toEqual(new Set([winner]));
      // Every other daemon has given up.
      const log = await until(async () => {
        const l = readFileSync(paths.daemonLog(), "utf8").slice(seen);
        return count(l, "another daemon is running; exiting") >= N - 1 && l;
      }, 30_000, "the other daemons to exit");
      expect(count(log, "runtime started"), `round ${round} (${leftover}):\n${log}`).toBe(1);
      expect(count(log, "overtimed ready")).toBe(1);
      expect(count(log, "another daemon is running; exiting")).toBe(N - 1);
      expect(log).not.toMatch(/answering on its socket|can't open the control socket|uncaught|unhandled/);
      expect(log).toContain(`overtimed ready (pid ${winner},`);
      expect(readFileSync(paths.daemonLock(), "utf8")).toBe(String(winner));
      // Requests other than ping work too: the runtime has started.
      expect(await clients[1].call("agents")).toEqual([]);

      leftover = (["killed", "stopped", "stopping", "stale", "none"] as const)[round % 5];
      if (leftover === "stopping") {
        // As in the upgrade that showed this: the daemon is still finishing (here held up by open
        // connections) when the clients start new ones, which wait for it and then all go at once.
        await clients[0].call("shutdown").catch(() => {});
        setTimeout(() => clients.forEach((c) => c.close()), 1_500);
        await until(() => DaemonClient.connect().then((c) => (c.close(), false), () => true), 10_000, "the daemon to stop taking connections");
        seen = readFileSync(paths.daemonLog(), "utf8").length;
        continue;
      }
      if (leftover === "killed") {
        // Dies without cleaning up: its lock and socket file stay behind.
        process.kill(winner, "SIGKILL");
        await until(async () => !alive(winner), 10_000, "the daemon to die");
        expect(existsSync(paths.socket())).toBe(true);
      } else {
        await clients[0].call("shutdown").catch(() => {});
        for (const c of clients) c.close();
        await until(async () => !alive(winner), 30_000, "the daemon to stop");
        expect(existsSync(paths.daemonLock())).toBe(false);
      }
      seen = readFileSync(paths.daemonLog(), "utf8").length;
      if (leftover === "none") {
        // Nothing at all left from before.
        execFileSync("rm", ["-rf", paths.daemonLocks(), paths.daemonLock(), paths.socket()]);
      }
    }
    expect(home).toBeTruthy();
  }, 300_000);
});

describe("the daemon lock", () => {
  it("is taken over from a dead daemon by adding a newer generation, never by replacing its file, and a clean stop releases it", async () => {
    fakeHome();
    const dir = paths.daemonLocks();
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(join(dir, "2"), String(dead));
    writeFileSync(join(dir, "3"), String(dead));
    writeFileSync(join(dir, `.tmp-${dead}-4`), String(dead));
    const lock = await takeLock();
    expect(lock).toBeTruthy();
    expect(readdirSync(dir)).toEqual(["4"]);
    expect(readFileSync(join(dir, "4"), "utf8")).toBe(String(process.pid));
    lock!.announce();
    expect(readFileSync(paths.daemonLock(), "utf8")).toBe(String(process.pid));
    lock!.release();
    expect(existsSync(paths.daemonLock())).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["4", "5"]);
    expect(readFileSync(join(dir, "5"), "utf8")).toBe("0");
    const again = await takeLock();
    expect(again).toBeTruthy();
    expect(readdirSync(dir)).toEqual(["6"]);
  });
});
