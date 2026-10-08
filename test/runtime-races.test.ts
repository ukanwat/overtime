import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { getEventListeners } from "node:events";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");

const logs: string[] = [];
let rt = new Runtime((l) => logs.push(l));
afterAll(() => {
  if (process.env.SHOWLOG) console.log(logs.join("\n"));
});
afterAll(async () => rt.stop());

async function employ(name: string) {
  await rt.create(name);
  await rt.send(name, "Your job is testing.");
  await until(async () => (await loadAgent(name)).state.status === "asleep", 30_000, `${name} settled`);
}

const mainCtx = (agent: string) => ({ token: "t", agent, kind: "main" as const, depth: 0, wakeChosen: false });
const helper = async (agent: string, id: string) => (await rt.store(agent).helpers()).find((x) => x.id === id)!;

/** Every prompt this agent's main sessions (or its helpers') were sent, oldest first. */
function prompts(agent: string, kind = "main_"): string[] {
  const dir = join(paths.meta(agent), "runs");
  return readdirSync(dir)
    .filter((f) => f.startsWith(kind))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.event === "prompt")
    .map((e) => e.data.text as string);
}

describe("helpers", () => {
  it("told twice at once after finishing, carry on once: the second note reaches that same run", async () => {
    await rt.start();
    await employ("dbl");
    const h = await rt.spawnHelper(mainCtx("dbl"), { task: "write result.txt" });
    await until(async () => (await helper("dbl", h.id)).status === "done", 30_000, "done");
    let runs = 0;
    const orig = (rt as any).runHelper.bind(rt);
    (rt as any).runHelper = (...a: any[]) => (runs++, orig(...a));
    try {
      await Promise.all([rt.tellHelper("dbl", h.id, "note A"), rt.tellHelper("dbl", h.id, "note B")]);
      await until(async () => (await helper("dbl", h.id)).status === "done" && !(rt as any).helperRuns.has(`dbl/${h.id}`), 30_000, "done again");
    } finally {
      (rt as any).runHelper = orig;
    }
    expect(runs).toBe(1);
    // Both notes reached it (in one turn or two, however the second one arrived).
    const told = prompts("dbl", "helper_").join("\n");
    expect(told).toContain("note A");
    expect(told).toContain("note B");
  });

  it("waiting out provider trouble, stop when the agent is stopped, and don't run again", async () => {
    await employ("stopper");
    const probe = rt.probe;
    rt.probe = async () => (await new Promise((r) => setTimeout(r, 3000)), true); // a slow check keeps it in its retry
    try {
      const h = await rt.spawnHelper(mainCtx("stopper"), { task: "FLAKY write result.txt" });
      await until(async () => (rt as any).helperTrouble.has(h.id), 30_000, "in retry");
      await rt.stopAgent("stopper");
      const end = await until(async () => {
        const x = await helper("stopper", h.id);
        return x.status !== "running" && x;
      }, 30_000, "helper ended");
      expect(end.status).toBe("stopped");
      expect(existsSync(join(h.workdir, "result.txt"))).toBe(false);
      expect((await loadAgent("stopper")).state.status).toBe("stopped");
      // Anything it still had waiting gets a fired signal until it's started again.
      expect((rt as any).signalFor("stopper").aborted).toBe(true);
      await rt.startAgent("stopper");
      expect((rt as any).signalFor("stopper").aborted).toBe(false);
    } finally {
      rt.probe = probe;
    }
  });

  it("waiting for the connection to come back read a note at once", async () => {
    await employ("waiter");
    const probe = rt.probe;
    rt.probe = async () => false;
    (rt as any).lastProgress = 0; // nothing heard from any backend lately: the machine is offline
    try {
      const h = await rt.spawnHelper(mainCtx("waiter"), { task: "FLAKY write result.txt" });
      await until(async () => (rt as any).helperTrouble.has(h.id) && rt.offlineSince, 30_000, "waiting to be online");
      await rt.tellHelper("waiter", h.id, "note while offline");
      await until(async () => existsSync(join(h.workdir, "notes.txt")), 15_000, "note read");
      expect(readFileSync(join(h.workdir, "notes.txt"), "utf8")).toContain("note while offline");
    } finally {
      rt.probe = probe;
      rt.offlineSince = null;
    }
  });
});

describe("the main agent", () => {
  it("leaves no listener behind on the daemon's signal, turn after turn", async () => {
    const sig: AbortSignal = (rt as any).abort.signal;
    const before = getEventListeners(sig, "abort").length;
    await employ("leaky");
    for (let i = 0; i < 3; i++) {
      await rt.send("leaky", `hello ${i}`);
      await until(async () => (await rt.store("leaky").messages()).some((m) => m.from === "agent" && m.text.includes(`hello ${i}`)), 30_000, "reply");
      await until(async () => !(rt as any).mainRunning.has("leaky"), 30_000, "idle");
    }
    expect(getEventListeners(sig, "abort").length).toBe(before);
  });

  it("answers what the person sends during a failure's back-off at once, then waits again", async () => {
    await employ("eager");
    await rt.send("eager", "FAIL_TURN first");
    await until(async () => ((await loadAgent("eager")).state.failures ?? 0) === 1 && !(rt as any).mainRunning.has("eager"), 30_000, "failed once");
    const wakeAt = (await rt.store("eager").schedule()).wakeAt!;
    expect(new Date(wakeAt).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // As if it came in while that turn was failing (its wake-up was dropped with the failure).
    const m = await rt.store("eager").addMessage({ from: "you", kind: "message", text: "RECOVERED now", baseDir: paths.agent("eager") });
    await rt.store("eager").pushInbox({ type: "message", text: "RECOVERED now", messageId: m.id });
    await until(async () => (await rt.store("eager").messages()).some((x) => x.from === "agent" && x.text.includes("RECOVERED now")), 20_000, "answered in the back-off");
  });

  it("isn't handed again, in the same session, what a failed turn already showed it", async () => {
    await employ("once");
    await rt.send("once", "FAIL_AFTER_REPLY first");
    await until(async () => ((await loadAgent("once")).state.failures ?? 0) === 1 && !(rt as any).mainRunning.has("once"), 30_000, "failed after replying");
    // Kept until a turn finishes, marked as shown to that session.
    expect((await rt.store("once").inbox()).find((i) => i.text.includes("FAIL_AFTER_REPLY"))?.shownIn).toBe((await loadAgent("once")).state.mainSessionId);
    await rt.send("once", "RECOVERED second");
    await until(async () => (await rt.store("once").messages()).some((x) => x.from === "agent" && x.text.includes("RECOVERED second")), 30_000, "second answered");
    const replies = (await rt.store("once").messages()).filter((x) => x.from === "agent" && x.text.includes("FAIL_AFTER_REPLY first"));
    expect(replies).toHaveLength(1);
    const last = prompts("once").at(-1)!;
    expect(last).toMatch(/Already handed to you earlier in this session[\s\S]*FAIL_AFTER_REPLY first/);
    expect(await rt.store("once").inbox()).toEqual([]);
  });

  it("starting a fresh session, is handed in full what a failed turn showed the old one", async () => {
    await employ("anew");
    await rt.send("anew", "FAIL_AFTER_REPLY first");
    await until(async () => ((await loadAgent("anew")).state.failures ?? 0) === 1 && !(rt as any).mainRunning.has("anew"), 30_000, "failed after replying");
    await updateState("anew", { failures: 2 }); // the old session keeps failing: the next turn starts a new one
    await rt.send("anew", "RECOVERED second");
    await until(async () => (await rt.store("anew").messages()).some((x) => x.from === "agent" && x.text.includes("RECOVERED second")), 30_000, "second answered");
    const last = prompts("anew").at(-1)!;
    expect(last).not.toContain("Already handed to you");
    expect(last).toMatch(/Message from the person[^\n]*\nFAIL_AFTER_REPLY first/);
  });
});

describe("restarting the daemon", () => {
  it("doesn't hand the agent again the person's last message it already had", async () => {
    await employ("quiet");
    const store = rt.store("quiet");
    // The agent was handed this and dealt with it without writing back.
    const m = await store.addMessage({ from: "you", kind: "message", text: "do it quietly", baseDir: paths.agent("quiet") });
    await store.pushInbox({ type: "message", text: "do it quietly", messageId: m.id });
    await store.takeInbox("main_quiet");
    await store.ackInbox("main_quiet");
    await rt.stop();
    rt = new Runtime((l) => logs.push(l));
    await rt.start();
    await new Promise((r) => setTimeout(r, 6000)); // a tick, which would hand it over again
    const handed = readFileSync(join(paths.meta("quiet"), "inbox-delivered.jsonl"), "utf8").split("\n").filter((l) => l.includes(m.id));
    expect(handed).toHaveLength(1);
    expect((await rt.store("quiet").inbox()).some((i) => i.messageId === m.id)).toBe(false);
  });
});
