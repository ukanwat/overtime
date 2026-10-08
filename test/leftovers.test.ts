import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome } from "./helpers.js";

fakeHome();
const { findLeftovers, recordLeftovers, liveBackground, stopBackground, sessionSpan } = await import("../src/runtime/leftovers.js");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Start `sleep` in the background from a shell that then exits, as an agent's `nohup cmd &` would: backends
 * run each command's shell in a session (and process group) of its own. Returns its pid.
 */
function orphan(cwd: string): number {
  return Number(execFileSync("/bin/sh", ["-c", "nohup sleep 60 >/dev/null 2>&1 & echo $!"], { cwd, encoding: "utf8", detached: true } as any).trim());
}

/** The same from a terminal with job control (`npm run dev &`, then closing it): the job leads its own process group. */
function terminalJob(cwd: string): number {
  return Number(execFileSync("/bin/sh", ["-c", "set -m; nohup sleep 60 >/dev/null 2>&1 & echo $!"], { cwd, encoding: "utf8", detached: true } as any).trim());
}

describe("processes an agent keeps running in the background", () => {
  it("are recorded (not stopped), listed while they run, and stopped with the agent", async () => {
    const since = Date.now();
    const mine = mkdtempSync(join(tmpdir(), "ot-bg-mine-"));
    const other = mkdtempSync(join(tmpdir(), "ot-bg-other-"));
    const a = orphan(mine);
    const b = orphan(other);
    await new Promise((r) => setTimeout(r, 300));
    const fresh = await recordLeftovers("bgtest", since, [mine]);
    expect(fresh.map((x) => x.pid)).toEqual([a]);
    expect(fresh[0].command).toContain("sleep 60");
    expect(alive(a)).toBe(true); // kept: the agent decides
    expect((await liveBackground("bgtest")).map((x) => x.pid)).toEqual([a]);
    expect(await stopBackground("bgtest")).toBe(1);
    expect(alive(a)).toBe(false);
    expect(alive(b)).toBe(true); // not the agent's
    expect(await liveBackground("bgtest")).toEqual([]);
    process.kill(b);
    rmSync(mine, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("leave alone anything started before the agent's sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ot-bg-old-"));
    const old = orphan(dir);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await findLeftovers(Date.now(), [dir])).map((x) => x.pid)).not.toContain(old);
    process.kill(old);
    rmSync(dir, { recursive: true, force: true });
  });

  it("drop a record once its process is gone", async () => {
    const since = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "ot-bg-gone-"));
    const p = orphan(dir);
    await new Promise((r) => setTimeout(r, 300));
    await recordLeftovers("gonetest", since, [dir]);
    process.kill(p, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(await liveBackground("gonetest")).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform === "linux")("on Linux, are found by the agent's marker wherever they run, and never another agent's", async () => {
    const since = Date.now();
    const elsewhere = mkdtempSync(join(tmpdir(), "ot-bg-marked-"));
    const mine = mkdtempSync(join(tmpdir(), "ot-bg-mine2-"));
    const run = (cwd: string, agent: string) => Number(execFileSync("/bin/sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { cwd, encoding: "utf8", env: { ...process.env, OVERTIME_AGENT: agent } }).trim());
    const marked = run(elsewhere, "marktest"); // outside its folders, but started for it
    const other = run(mine, "someone-else"); // inside its folder, but another agent's
    await new Promise((r) => setTimeout(r, 300));
    const fresh = await recordLeftovers("marktest", since, [mine]);
    expect(fresh.map((x) => x.pid)).toEqual([marked]);
    expect(await stopBackground("marktest")).toBe(1);
    process.kill(other);
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(mine, { recursive: true, force: true });
  });

  it("aren't taken from a folder another agent was working in at the same time", async () => {
    const since = Date.now();
    const shared = mkdtempSync(join(tmpdir(), "ot-bg-shared-"));
    const own = mkdtempSync(join(tmpdir(), "ot-bg-own-"));
    const endA = sessionSpan("share-a", [own, shared]);
    const endB = sessionSpan("share-b", [shared]);
    const inShared = orphan(shared); // could be either agent's
    const inOwn = orphan(own); // only share-a works here
    await new Promise((r) => setTimeout(r, 300));
    endB();
    expect(await recordLeftovers("share-b", since, [shared])).toEqual([]);
    endA();
    expect((await recordLeftovers("share-a", since, [own, shared])).map((x) => x.pid)).toEqual([inOwn]);
    await stopBackground("share-a");
    expect(alive(inShared)).toBe(true); // stopping one agent never kills what may be the other's
    process.kill(inShared);
    rmSync(shared, { recursive: true, force: true });
    rmSync(own, { recursive: true, force: true });
  });

  it("aren't taken when another agent already recorded them", async () => {
    const since = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "ot-bg-taken-"));
    const p = orphan(dir);
    await new Promise((r) => setTimeout(r, 300));
    expect((await recordLeftovers("taken-a", since, [dir])).map((x) => x.pid)).toEqual([p]);
    expect(await recordLeftovers("taken-b", since, [dir])).toEqual([]);
    // Recorded by both (as lists made before this rule can be): stopping either leaves it running.
    const { writeJson } = await import("../src/fsutil.js");
    const { paths } = await import("../src/paths.js");
    await writeJson(join(paths.meta("taken-b"), "background.json"), await liveBackground("taken-a"));
    expect(await stopBackground("taken-b")).toBe(0);
    expect(await stopBackground("taken-a")).toBe(0);
    expect(alive(p)).toBe(true);
    process.kill(p);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "linux")("leave alone a job the person started from a terminal in the same folder", async () => {
    const since = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "ot-bg-person-"));
    const job = terminalJob(dir);
    const agents = orphan(dir);
    await new Promise((r) => setTimeout(r, 300));
    expect((await recordLeftovers("persontest", since, [dir])).map((x) => x.pid)).toEqual([agents]);
    await stopBackground("persontest");
    expect(alive(job)).toBe(true);
    process.kill(job);
    rmSync(dir, { recursive: true, force: true });
  });
});
