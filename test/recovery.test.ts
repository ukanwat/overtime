import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const { Store } = await import("../src/store/store.js");

const meta = (a: string) => join(home, "agents", a, ".overtime");
const delivered = (a: string) => (existsSync(join(meta(a), "inbox-delivered.jsonl")) ? readFileSync(join(meta(a), "inbox-delivered.jsonl"), "utf8") : "");

const logs: string[] = [];
let rt = new Runtime((l) => logs.push(l));
afterAll(() => { if (process.env.SHOWLOG) console.log(logs.join("\n")); });
afterAll(async () => rt.stop());

/** Create an agent and give it its job, so it's an ordinary agent at rest. */
async function employ(name: string, md?: string) {
  await rt.create(name);
  if (md) {
    const f = join(home, "agents", name, "AGENT.md");
    writeFileSync(f, `---\n${md}\n---\n\n` + readFileSync(f, "utf8"));
  }
  const [g] = await rt.store(name).threads();
  await rt.send(name, "Your job is testing.", g.id);
  await until(async () => (await loadAgent(name)).state.status === "asleep", 30_000, `${name} settled`);
}

describe("after a crash, nothing is lost", () => {
  it("returns in-flight inbox items, reports cut-off helpers, and answers unanswered chats", async () => {
    await rt.start();
    await employ("crashy");
    await rt.stop();

    // What a daemon killed mid-turn leaves behind.
    const store = new Store("crashy");
    mkdirSync(join(meta("crashy"), "inflight"), { recursive: true });
    writeFileSync(join(meta("crashy"), "inflight", "main_dead.json"), JSON.stringify([{ id: "in_x", t: new Date().toISOString(), type: "message", text: "RECOVERED_MSG" }]));
    await store.saveHelper({ id: "helper_dead", task: "a task", workdir: join(meta("crashy"), "helpers", "helper_dead", "work"), parent: "main", depth: 1, status: "running", startedAt: new Date().toISOString() });
    const tid = await store.startThread({ kind: "conversation", title: "ping", from: "you", text: "unanswered PING", baseDir: join(home, "agents", "crashy") });

    rt = new Runtime((l) => logs.push(l));
    await rt.start();
    await until(async () => delivered("crashy").includes("RECOVERED_MSG"), 30_000, "in-flight item delivered");
    const h = (await rt.store("crashy").helpers()).find((x) => x.id === "helper_dead")!;
    expect(h.status).toBe("failed");
    await until(async () => delivered("crashy").includes("helper_dead"), 30_000, "cut-off helper reported");
    await until(async () => (await rt.store("crashy").thread(tid))?.entries.some((e) => e.from === "agent" && e.text.includes("unanswered PING")), 30_000, "chat answered");
    expect(existsSync(join(meta("crashy"), "inflight", "main_dead.json"))).toBe(false);
  });
});

describe("stopping an agent", () => {
  it("cancels its running turn, stays stopped, and keeps the message for later", async () => {
    await employ("stoppy");
    const [g] = await rt.store("stoppy").threads();
    await rt.send("stoppy", "PASS SLOW", g.id);
    await until(async () => (await loadAgent("stoppy")).state.status === "working", 30_000, "working");
    await rt.stopAgent("stoppy");
    await new Promise((r) => setTimeout(r, 3000));
    const a = await loadAgent("stoppy");
    expect(a.state.status).toBe("stopped");
    expect(a.state.nextWake).toBeNull();
    expect((await rt.store("stoppy").inbox()).some((i) => i.text.includes("PASS SLOW"))).toBe(true);
    const ps = execFileSync("ps", ["-eo", "command"]).toString();
    expect(ps.split("\n").filter((l) => l.includes("fake-agent.ts") && l.includes(home))).toHaveLength(0);
    // Started again, it picks the message up.
    await rt.startAgent("stoppy");
    expect((await loadAgent("stoppy")).state.status).not.toBe("stopped");
  });
});

describe("helpers", () => {
  it("can be cancelled, and the agent hears what they got done", async () => {
    await employ("boss");
    await rt.send("boss", "PASS SPAWN_SLOW");
    const h = await until(async () => (await rt.store("boss").helpers()).find((x) => x.status === "running"), 30_000, "helper running");
    // Let it report its progress first (it calls done straight away, then works on).
    await new Promise((r) => setTimeout(r, 4000));
    await until(async () => rt.cancelHelper("boss", h.id), 10_000, "cancel accepted");
    const done = await until(async () => (await rt.store("boss").helpers()).find((x) => x.id === h.id && x.status !== "running"), 30_000, "helper ended");
    expect(done.status).toBe("cancelled");
    expect(done.result).toContain("partial: got halfway");
    await until(async () => delivered("boss").includes(`Cancelled (${h.id})`), 30_000, "agent told");
  });

  it("get a copy of a small non-git workspace, never the agent's own bookkeeping", async () => {
    const ws = join(home, "plainws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "data.txt"), "hello");
    await employ("copier", `workspace: ${ws}`);
    await rt.send("copier", "PASS SPAWN");
    const h = await until(async () => (await rt.store("copier").helpers()).find((x) => x.status !== "running"), 60_000, "helper done");
    expect(h.status, h.result).toBe("done");
    expect(readFileSync(join(h.workdir, "data.txt"), "utf8")).toBe("hello");
    expect(existsSync(join(ws, "result.txt"))).toBe(false);
  });
});

describe("budgets and settings", () => {
  it("doesn't spend in chats once the daily budget is used, and keeps the message", async () => {
    await employ("thrifty", "dailyBudgetUsd: 0.005");
    const tid = await rt.send("thrifty", "are you there?");
    await until(async () => (await rt.store("thrifty").thread(tid))?.entries.some((e) => e.from === "overtime" && /budget/.test(e.text)), 20_000, "budget note");
    expect((await rt.store("thrifty").inbox()).some((i) => i.threadId === tid)).toBe(true);
  });

  it("keeps a settings edit the person makes while a turn is running", async () => {
    await employ("edited");
    const [g] = await rt.store("edited").threads();
    await rt.send("edited", "PASS SLOW", g.id);
    await until(async () => (await loadAgent("edited")).state.status === "working", 30_000, "working");
    const f = join(home, "agents", "edited", "AGENT.md");
    writeFileSync(f, `---\ndailyBudgetUsd: 42\n---\n\n` + readFileSync(f, "utf8").replace(/^---[\s\S]*?---\n\n?/, ""));
    await until(async () => (await loadAgent("edited")).state.status === "asleep", 90_000, "turn over");
    expect((await loadAgent("edited")).settings.dailyBudgetUsd).toBe(42);
    expect(readFileSync(f, "utf8")).toContain("dailyBudgetUsd: 42");
  });

  it("won't wake a new agent that hasn't been given a job", async () => {
    await rt.create("fresh");
    await expect(rt.wakeNow("fresh")).rejects.toThrow(/doesn't have a job/);
  });
});
