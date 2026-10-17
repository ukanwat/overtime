import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

/**
 * Overtime restarting (an update, the app replacing the daemon, a crash) in the middle of work: the main
 * turn and helpers that were running carry on by themselves in their own sessions, nothing is handed over
 * twice, and a turn that had already ended isn't run again.
 */
const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { Updater } = await import("../src/daemon/update.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");
const { Store } = await import("../src/store/store.js");
const { packageVersion } = await import("../src/daemon/build.js");

const meta = (a: string) => join(home, "agents", a, ".overtime");
const logs: string[] = [];
let rt = new Runtime((l) => logs.push(l));
afterAll(() => {
  if (process.env.SHOWLOG) console.log(logs.join("\n"));
});
afterAll(async () => rt.stop());

/** Every run of an agent: its id, how it started (kind, session, fresh, reason) and the prompt it was sent. */
function runs(agent: string): { id: string; kind: string; sessionId: string; fresh: boolean; reason: string; prompt: string; ended: boolean }[] {
  const dir = join(meta(agent), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const ev = readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const start = ev.find((e) => e.event === "start")?.data ?? {};
      return { id: f.replace(/\.jsonl$/, ""), kind: start.kind, sessionId: start.sessionId, fresh: start.fresh, reason: start.reason ?? "", prompt: ev.find((e) => e.event === "prompt")?.data?.text ?? "", ended: ev.some((e) => e.event === "end") };
    });
}

/** The helper results the agent's main session was handed, for one helper. */
function helperResultsDelivered(agent: string, helperId: string): number {
  const f = join(meta(agent), "inbox-delivered.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.type === "helper" && i.data?.helperId === helperId).length;
}

async function employ(name: string) {
  await rt.create(name);
  await rt.send(name, "Your job is testing.");
  await until(async () => (await loadAgent(name)).state.status === "asleep", 30_000, `${name} settled`);
}

describe("Overtime restarting while agents work", () => {
  it("an update mid-turn and mid-helper: both carry on in their own sessions, told why, and the helper's result arrives once", async () => {
    await rt.start();
    await employ("busy");
    // A helper working slowly, then a main turn working slowly beside it.
    await rt.send("busy", "SPAWN_SLOW");
    const h = await until(async () => (await rt.store("busy").helpers()).find((x) => x.status === "running" && x.sessionId), 30_000, "helper running");
    await until(async () => (await loadAgent("busy")).state.status === "asleep", 30_000, "spawning turn done");
    await rt.send("busy", "PASS SLOW work");
    await until(async () => (await loadAgent("busy")).state.inflightTurn?.sessionId, 30_000, "main turn running");
    const mainSession = (await loadAgent("busy")).state.mainSessionId;
    const before = runs("busy").length;

    // The registry has a newer version; installing it works; handing over stops this daemon and starts the next.
    let installed = "";
    const updater = new Updater({
      log: (l) => logs.push(l),
      notify: () => {},
      current: "0.7.8",
      autoUpdate: async () => true,
      latest: async () => "0.7.9",
      install: () => ({ manager: "npm", root: "/opt/node/lib/node_modules/@ukanwat/overtime", prefix: "/opt/node" }),
      run: async (c) => void (installed = c.text),
      installedVersion: () => "0.7.9",
      handover: async () => {
        await rt.stop();
        // What the new version's daemon finds: the last daemon ran an older version.
        writeFileSync(join(home, "update.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "update.json"), "utf8")), running: "0.0.1" }));
        rt = new Runtime((l) => logs.push(l));
        await rt.start();
      },
    });
    expect(await updater.check("test")).toBe("updated");
    expect(installed).toBe("npm i -g @ukanwat/overtime@0.7.9");

    // The helper carries on in its own session and finishes; its result reaches the agent once.
    const done = await until(async () => (await rt.store("busy").helpers()).find((x) => x.id === h.id && x.status === "done"), 60_000, "helper done");
    expect(done.sessionId).toBe(h.sessionId);
    const helperRun = runs("busy").find((r) => r.kind === "helper" && /Overtime restarted \(update to /.test(r.reason));
    expect(helperRun?.sessionId).toBe(h.sessionId);
    expect(helperRun?.fresh).toBe(false);
    expect(helperRun?.prompt).toContain(`Overtime restarted (update to ${packageVersion()}) while you were working`);
    await until(async () => helperResultsDelivered("busy", h.id) > 0, 60_000, "helper result delivered");

    // The main turn carries on in its session, told what happened; what it had been handed is marked as already seen.
    const mainRun = await until(async () => runs("busy").find((r) => r.kind === "main" && r.ended && /Overtime restarted \(update to /.test(r.reason)), 60_000, "main carried on");
    expect(mainRun.sessionId).toBe(mainSession);
    expect(mainRun.fresh).toBe(false);
    expect(mainRun.reason).toContain("Carry on where you were");
    expect(mainRun.prompt).toMatch(/Already handed to you earlier in this session[\s\S]*PASS SLOW work/);
    await until(async () => (await loadAgent("busy")).state.status === "asleep" && !(await loadAgent("busy")).state.inflightTurn, 60_000, "settled");
    expect(runs("busy").length).toBeGreaterThan(before);
    // Settled: the helper's result went to the agent exactly once, and nothing is left in its inbox.
    await new Promise((r) => setTimeout(r, 1500));
    expect(helperResultsDelivered("busy", h.id)).toBe(1);
    expect(await rt.store("busy").inbox()).toEqual([]);
  });

  it("after a crash mid-turn and mid-helper: both carry on, and a turn that had ended isn't run again", async () => {
    await employ("crashed");
    await employ("rested");
    await rt.send("rested", "WATCH_REPEAT");
    await until(async () => (await rt.store("rested").monitors()).length > 0 && (await loadAgent("rested")).state.status === "asleep", 30_000, "watch set");
    await rt.stop();

    // What a daemon killed mid-turn and mid-helper leaves behind: the turn marked running, its items in flight,
    // a helper running in its session.
    const sessionId = (await loadAgent("crashed")).state.mainSessionId!;
    await updateState("crashed", { status: "working", inflightTurn: { runId: "main_cut", reason: "the person sent you a message", at: new Date().toISOString(), sessionId } });
    mkdirSync(join(meta("crashed"), "inflight"), { recursive: true });
    writeFileSync(join(meta("crashed"), "inflight", "main_cut.json"), JSON.stringify([{ id: "in_cut", t: new Date().toISOString(), type: "message", text: "HALF_DONE_TASK" }]));
    const workdir = join(meta("crashed"), "helpers", "helper_cut", "work");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, ".fake-helper"), "1");
    await new Store("crashed").saveHelper({ id: "helper_cut", task: "write result.txt", workdir, parent: "main", depth: 1, status: "running", startedAt: new Date().toISOString(), sessionId: "sess-helper-cut" });
    const restedRuns = runs("rested").length;

    rt = new Runtime((l) => logs.push(l));
    await rt.start();
    const h = await until(async () => (await rt.store("crashed").helpers()).find((x) => x.id === "helper_cut" && x.status === "done"), 60_000, "crashed helper done");
    expect(h.sessionId).toBe("sess-helper-cut");
    expect(readFileSync(join(workdir, "result.txt"), "utf8")).toBe("helper output\n");
    const mainRun = await until(async () => runs("crashed").find((r) => r.kind === "main" && r.ended && /Overtime restarted while you were working/.test(r.reason)), 60_000, "crashed main carried on");
    expect(mainRun.sessionId).toBe(sessionId);
    expect(mainRun.reason).toContain("That turn began because: the person sent you a message");
    expect(mainRun.prompt).toMatch(/Already handed to you earlier in this session[\s\S]*HALF_DONE_TASK/);
    await until(async () => helperResultsDelivered("crashed", "helper_cut") === 1, 60_000, "helper result delivered");

    // The agent at rest isn't woken by the restart, and its watch runs again.
    await until(async () => [...((rt.monitors as any).running as Map<string, unknown>).keys()].some((k) => k.startsWith("rested/")), 10_000, "watch restarted");
    await new Promise((r) => setTimeout(r, 3000));
    expect(runs("rested").length).toBe(restedRuns);
  });

  it("a stopped agent's cut-off turn isn't carried on", async () => {
    await employ("halted");
    await rt.stopAgent("halted");
    await rt.stop();
    await updateState("halted", { inflightTurn: { runId: "main_x", reason: "x", at: new Date().toISOString(), sessionId: null } });
    const n = runs("halted").length;
    rt = new Runtime((l) => logs.push(l));
    await rt.start();
    await new Promise((r) => setTimeout(r, 2000));
    expect(runs("halted").length).toBe(n);
    expect((await loadAgent("halted")).state.inflightTurn).toBeNull();
  });
});
