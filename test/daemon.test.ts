import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent, setSettings } = await import("../src/agent/agent.js");
const { usageToday } = await import("../src/runtime/usage.js");

const logs: string[] = [];
const rt = new Runtime((l) => logs.push(l));

/** The agent's first message after the given one, once it exists. */
async function replyAfter(agent: string, id: string, match?: (t: string) => boolean) {
  const all = await rt.store(agent).messages();
  const i = all.findIndex((m) => m.id === id);
  return all.slice(i + 1).find((m) => m.from === "agent" && (!match || match(m.text)));
}

beforeAll(async () => {
  await rt.start();
});
afterAll(async () => {
  await rt.stop();
});

describe("an agent's life", () => {
  it("is created from a name with a free greeting and no identity", async () => {
    await rt.create("tester");
    const a = await loadAgent("tester");
    expect(a.state.status).toBe("new");
    expect(a.identity).toContain("No identity yet");
    const ms = await rt.store("tester").messages();
    expect(ms).toHaveLength(1);
    expect(ms[0].from).toBe("agent");
    expect(await rt.store("tester").unread()).toBe(1);
  });

  it("learns its job from the first message and writes its own AGENT.md and INDEX.md", async () => {
    const m = await rt.send("tester", "Your job is testing.");
    await until(async () => (await loadAgent("tester")).state.status === "asleep", 30_000, "first turn");
    const a = await loadAgent("tester");
    expect(a.identity).toContain("Test job");
    expect(a.index).toContain("notes/");
    expect(a.state.mainSessionId).toBeTruthy();
    expect((await replyAfter("tester", m.id))?.text).toContain("main reply");
    const sched = await rt.store("tester").schedule();
    const inMin = (new Date(sched.wakeAt!).getTime() - Date.now()) / 60000;
    expect(inMin).toBeGreaterThan(25);
    expect(inMin).toBeLessThan(31);
    const u = await usageToday("tester");
    expect(u.costReported).toBe(true);
    expect(u.usd).toBeCloseTo(0.01, 5);
  });

  it("answers your message itself, from its one main session", async () => {
    const m = await rt.send("tester", "how is it going?");
    const e = await until(() => replyAfter("tester", m.id, (t) => t.includes("main reply")), 30_000, "reply");
    expect(e.text).toContain("main reply to: how is it going?");
    await until(async () => (await loadAgent("tester")).state.status === "asleep", 10_000, "asleep again");
  });

  it("uses its final words as the reply when it doesn't call send", async () => {
    const m = await rt.send("tester", "NOREPLYTOOL ping");
    const e = await until(() => replyAfter("tester", m.id, (t) => t.includes("final words")), 30_000, "fallback reply");
    expect(e.text).toContain("final words as reply to: NOREPLYTOOL ping");
  });

  it("wakes for a message and replies", async () => {
    const m = await rt.send("tester", "PASS please do the thing");
    await until(() => replyAfter("tester", m.id, (t) => t.startsWith("main reply")), 40_000, "main reply after pass");
  });

  it("asks without blocking, records the answer and wakes with it", async () => {
    await rt.send("tester", "PASS ASK");
    const q = await until(async () => (await rt.store("tester").openQuestions()).at(-1), 40_000, "question");
    expect(q.category).toBe("test-choice");
    expect(q.options).toEqual(["Bridge", "Ferry"]);
    await rt.answer("tester", undefined, 1);
    const ds = await rt.store("tester").decisions();
    expect(ds.at(-1)).toMatchObject({ category: "test-choice" });
    expect(ds.at(-1)!.answer).toContain("Bridge");
    const answered = await rt.store("tester").message(q.id);
    expect(answered!.answer?.choice).toBe(1);
    expect(await rt.store("tester").openQuestions()).toHaveLength(0);
    await until(async () => (await rt.store("tester").messages()).some((m) => m.from === "agent" && m.text.startsWith("main reply") && m.t > answered!.answer!.t), 40_000, "reply to answer");
    await expect(rt.answer("tester", q.id, 1)).rejects.toThrow(/already answered/);
  });

  it("notices when the person keeps giving the same answer (earned autonomy)", async () => {
    for (let i = 0; i < 2; i++) {
      await rt.send("tester", "PASS ASK");
      await until(async () => (await rt.store("tester").openQuestions()).at(-1), 40_000, "another question");
      await rt.answer("tester", undefined, 1);
    }
    const delivered = join(home, "agents", "tester", ".overtime", "inbox-delivered.jsonl");
    const inbox = join(home, "agents", "tester", ".overtime", "inbox.json");
    await until(async () => (existsSync(delivered) && readFileSync(delivered, "utf8").includes("decide these yourself")) || (existsSync(inbox) && readFileSync(inbox, "utf8").includes("decide these yourself")), 20_000, "autonomy hint");
  });

  it("keeps the exact text of every prompt it sent", async () => {
    const { readdirSync } = await import("node:fs");
    const runs = join(home, "agents", "tester", ".overtime", "runs");
    const any = readdirSync(runs).some((f) => readFileSync(join(runs, f), "utf8").includes('"event":"prompt"'));
    expect(any).toBe(true);
  });

  it("runs a helper in its own git worktree and gets its result", async () => {
    const ws = join(home, "repo");
    mkdirSync(ws, { recursive: true });
    execFileSync("git", ["init", "-q", ws]);
    execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    await setSettings("tester", { workspace: ws });
    await rt.send("tester", "PASS SPAWN");
    const h = await until(async () => (await rt.store("tester").helpers()).find((x) => x.status !== "running"), 60_000, "helper done");
    expect(h.status, h.result).toBe("done");
    expect(h.branch).toMatch(/^overtime\/tester\//);
    expect(existsSync(join(h.workdir, "result.txt"))).toBe(true);
    expect(h.result).toContain("result.txt");
    expect(existsSync(join(ws, "result.txt"))).toBe(false);
  });

  it("wakes on a repeating monitor when its output changes", async () => {
    const folder = join(home, "agents", "tester");
    writeFileSync(join(folder, "watched.txt"), "v1");
    // Monitors run in the agent's own folder.
    await rt.send("tester", "PASS WATCH_REPEAT NOSLEEP");
    const m = await until(async () => (await rt.store("tester").monitors())[0], 40_000, "monitor set");
    await until(async () => (await rt.store("tester").monitors())[0]?.lastOutput === "v1", 20_000, "baseline");
    writeFileSync(join(folder, "watched.txt"), "v2");
    const delivered = join(home, "agents", "tester", ".overtime", "inbox-delivered.jsonl");
    await until(async () => existsSync(delivered) && readFileSync(delivered, "utf8").includes(`Monitor ${m.id} fired`), 40_000, "monitor fired and delivered");
  });

  it("keeps the message and retries after a failed turn", async () => {
    await rt.create("flaky");
    await rt.send("flaky", "FAIL_TURN");
    await until(async () => ((await loadAgent("flaky")).state.failures ?? 0) >= 1, 30_000, "failure recorded");
    const a = await loadAgent("flaky");
    expect(a.state.status).toBe("new");
    expect(a.state.lastError).toContain("scripted failure");
    expect(logs.some((l) => l.includes("scripted failure"))).toBe(true);
    expect((await rt.store("flaky").inbox()).length).toBe(1);
    const s = await rt.store("flaky").schedule();
    expect(new Date(s.wakeAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("pauses at the daily budget and says so once", async () => {
    await rt.create("budget");
    await setSettings("budget", { dailyBudgetUsd: 0.005 });
    await rt.send("budget", "go");
    await until(async () => (await loadAgent("budget")).state.status === "asleep", 30_000, "first turn");
    rt.wakeMain("budget", "test");
    await until(async () => (await loadAgent("budget")).state.status === "paused", 30_000, "paused");
    rt.wakeMain("budget", "test again");
    await new Promise((r) => setTimeout(r, 1500));
    const alerts = (await rt.store("budget").messages()).filter((m) => m.kind === "alert");
    expect(alerts).toHaveLength(1);
  });

  it("never leaves backend processes behind", async () => {
    await new Promise((r) => setTimeout(r, 1000));
    const ps = execFileSync("ps", ["-eo", "command"]).toString();
    const leftovers = ps.split("\n").filter((l) => l.includes("fake-agent.ts") && l.includes(home));
    expect(leftovers).toHaveLength(0);
  });
});
