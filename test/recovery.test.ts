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
  await rt.send(name, "Your job is testing.");
  await until(async () => (await loadAgent(name)).state.status === "asleep", 30_000, `${name} settled`);
}

describe("after a crash, nothing is lost", () => {
  it("returns in-flight inbox items, reports cut-off helpers, and answers a message that never reached the agent", async () => {
    await rt.start();
    await employ("crashy");
    await rt.stop();

    // What a daemon killed mid-turn leaves behind.
    const store = new Store("crashy");
    mkdirSync(join(meta("crashy"), "inflight"), { recursive: true });
    writeFileSync(join(meta("crashy"), "inflight", "main_dead.json"), JSON.stringify([{ id: "in_x", t: new Date().toISOString(), type: "message", text: "RECOVERED_MSG" }]));
    await store.saveHelper({ id: "helper_dead", task: "a task", workdir: join(meta("crashy"), "helpers", "helper_dead", "work"), parent: "main", depth: 1, status: "running", startedAt: new Date().toISOString() });
    const ping = await store.addMessage({ from: "you", kind: "message", text: "unanswered PING", baseDir: join(home, "agents", "crashy") });

    rt = new Runtime((l) => logs.push(l));
    await rt.start();
    await until(async () => delivered("crashy").includes("RECOVERED_MSG"), 30_000, "in-flight item delivered");
    const h = (await rt.store("crashy").helpers()).find((x) => x.id === "helper_dead")!;
    expect(h.status).toBe("failed");
    await until(async () => delivered("crashy").includes("helper_dead"), 30_000, "cut-off helper reported");
    await until(async () => (await rt.store("crashy").messages()).some((e) => e.from === "agent" && e.text.includes("unanswered PING") && e.t >= ping.t), 30_000, "message answered");
    expect(existsSync(join(meta("crashy"), "inflight", "main_dead.json"))).toBe(false);
  });
});

describe("stopping an agent", () => {
  it("cancels its running turn, stays stopped, and keeps the message for later", async () => {
    await employ("stoppy");
    await rt.send("stoppy", "PASS SLOW");
    await until(async () => (await loadAgent("stoppy")).state.status === "working", 30_000, "working");
    await rt.stopAgent("stoppy");
    // The interrupted turn hands its message back; on a slow machine that takes a moment.
    await until(async () => (await rt.store("stoppy").inbox()).some((i) => i.text.includes("PASS SLOW")), 30_000, "message kept");
    const a = await loadAgent("stoppy");
    expect(a.state.status).toBe("stopped");
    expect(a.state.nextWake).toBeNull();
    await until(async () => execFileSync("ps", ["-eo", "command"]).toString().split("\n").every((l) => !(l.includes("fake-agent.ts") && l.includes(home))), 30_000, "backend gone");
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

describe.runIf(process.platform === "darwin")("protected paths", () => {
  it("stop an agent's session writing to them, whatever it runs", async () => {
    await employ("boxed");
    await rt.send("boxed", "PASS ESCAPE");
    const f = join(home, "agents", "boxed", "escape-result.txt");
    await until(async () => existsSync(f), 40_000, "escape attempt");
    expect(readFileSync(f, "utf8")).toBe("denied");
  });
});

describe("talking to a busy agent", () => {
  it("interrupts its work to answer you within seconds, without counting it as a failure", async () => {
    await employ("busy");
    await rt.send("busy", "SLOW job please"); // the fake works on SLOW for up to a minute
    await until(async () => (await loadAgent("busy")).state.status === "working", 30_000, "working");
    const started = Date.now();
    const m = await rt.send("busy", "quick question");
    await until(async () => (await rt.store("busy").messages()).some((e) => e.from === "agent" && e.text.includes("quick question") && e.t >= m.t), 30_000, "reply while busy");
    expect(Date.now() - started).toBeLessThan(25_000); // not after the minute-long job
    const a = await loadAgent("busy");
    expect(a.state.failures ?? 0).toBe(0);
    expect(a.state.lastError ?? null).toBeNull();
  });
});

describe("instruction updates", () => {
  it("reach a running agent: a session started under older instructions starts fresh, others continue", async () => {
    const { readdirSync } = await import("node:fs");
    await employ("updated");
    const runs = join(meta("updated"), "runs");
    // The most recent main run by its start time (run ids from the same second don't sort by time).
    const lastStart = () =>
      readdirSync(runs)
        .filter((x) => x.startsWith("main"))
        .map((f) => readFileSync(join(runs, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "start"))
        .filter(Boolean)
        .sort((a, b) => a.t.localeCompare(b.t))
        .at(-1).data;
    // Send, and wait for the reply and for the turn to be over.
    const ask = async (text: string) => {
      const m = await rt.send("updated", text);
      await until(async () => (await rt.store("updated").messages()).some((e) => e.from === "agent" && e.text.includes(text) && e.t >= m.t), 30_000, `reply to "${text}"`);
      await until(async () => (await loadAgent("updated")).state.status === "asleep", 30_000, "turn over");
    };
    await ask("second question");
    expect(lastStart().fresh).toBe(false); // same instructions: the session continues (and its cache)
    const { updateState } = await import("../src/agent/agent.js");
    await updateState("updated", { mainSessionPrompt: "older-version" });
    await ask("third question");
    expect(lastStart().fresh).toBe(true); // instructions changed: a fresh session with the new ones
    // …which still knows the conversation so far.
    const latest = readdirSync(runs).filter((x) => x.startsWith("main")).map((f) => readFileSync(join(runs, f), "utf8")).find((t) => t.includes('"fresh":true') && t.includes("third question"))!;
    expect(latest).toContain("Your recent conversation with the person");
    expect(latest).toContain("second question");
    await ask("fourth question");
    expect(lastStart().fresh).toBe(false); // and that one continues from then on
  });
});

describe("budgets and settings", () => {
  it("doesn't spend once the daily budget is used, says so, and keeps the message", async () => {
    await employ("thrifty", "dailyBudgetUsd: 0.005");
    const m = await rt.send("thrifty", "are you there?");
    await until(async () => (await rt.store("thrifty").messages()).some((e) => e.from === "overtime" && /budget/.test(e.text)), 20_000, "budget note");
    expect((await rt.store("thrifty").inbox()).some((i) => i.messageId === m.id)).toBe(true);
  });

  it("keeps a settings edit the person makes while a turn is running", async () => {
    await employ("edited");
    await rt.send("edited", "PASS SLOW");
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

describe("schedules, models and settings", () => {
  it("starts a repeating wake-up at the time it was given", async () => {
    const { Store } = await import("../src/store/store.js");
    const s = new Store("crashy");
    const first = new Date(Date.now() + 5 * 3600_000);
    const loop = await s.addLoop(24 * 3600_000, "daily", first);
    expect(new Date(loop.nextAt).getTime()).toBe(first.getTime());
    const past = await s.addLoop(24 * 3600_000, "daily", new Date(Date.now() - 3600_000));
    expect(new Date(past.nextAt).getTime()).toBeGreaterThan(Date.now() + 22 * 3600_000);
  });

  it("changes settings from the app, clears the model when the backend changes, and rejects bad ones", async () => {
    await rt.create("tuned");
    await rt.setAgentSettings("tuned", { model: "some-model", dailyBudgetUsd: 3 });
    let a = await loadAgent("tuned");
    expect(a.settings.model).toBe("some-model");
    expect(a.settings.dailyBudgetUsd).toBe(3);
    expect(readFileSync(join(home, "agents", "tuned", "AGENT.md"), "utf8")).toContain("dailyBudgetUsd: 3");
    await rt.setAgentSettings("tuned", { backend: "fake" });
    a = await loadAgent("tuned");
    expect(a.settings.model).toBeUndefined();
    await expect(rt.setAgentSettings("tuned", { backend: "nope" })).rejects.toThrow(/Unknown backend/);
  });

  it("lifts a budget pause as soon as the budget is raised", async () => {
    await until(async () => (await loadAgent("thrifty")).state.status !== "working", 30_000, "idle");
    rt.wakeMain("thrifty", "test");
    await until(async () => (await loadAgent("thrifty")).state.status === "paused", 30_000, "paused");
    await rt.setAgentSettings("thrifty", { dailyBudgetUsd: 50 });
    await until(async () => (await loadAgent("thrifty")).state.status !== "paused", 30_000, "unpaused");
  });

  it("archives agents without deleting them", async () => {
    await employ("tidy");
    const dir = await rt.archive("tidy");
    expect(existsSync(join(dir, "AGENT.md"))).toBe(true);
    expect(existsSync(join(home, "agents", "tidy"))).toBe(false);
  });

  it("lists backends, including custom ones", async () => {
    expect(await rt.backends()).toEqual(expect.arrayContaining(["claude", "codex", "gemini", "fake"]));
  });
});

describe("what turns cost and see", () => {
  it("counts what a failed turn spent", async () => {
    await rt.create("spender");
    await rt.send("spender", "COSTLY_FAIL");
    await until(async () => ((await loadAgent("spender")).state.failures ?? 0) >= 1, 30_000, "failure");
    const { usageToday } = await import("../src/runtime/usage.js");
    expect((await usageToday("spender")).usd).toBeCloseTo(0.25, 5);
  });

  it("tells a resumed session that the person edited AGENT.md", async () => {
    await employ("noticer");
    const f = join(home, "agents", "noticer", "AGENT.md");
    writeFileSync(f, readFileSync(f, "utf8") + "\n- New rule: always say hello.\n");
    rt.wakeMain("noticer", "test");
    const { readdirSync } = await import("node:fs");
    const runs = join(meta("noticer"), "runs");
    await until(async () => readdirSync(runs).some((x) => readFileSync(join(runs, x), "utf8").includes("AGENT.md changed since your last turn")), 30_000, "edit notice");
  });

  it("doesn't add an hourly wake-up when a watch already wakes it", async () => {
    await employ("watcher");
    await rt.send("watcher", "PASS WATCH_REPEAT NOSLEEP");
    await until(async () => (await rt.store("watcher").monitors()).length > 0, 30_000, "watch set");
    await until(async () => (await loadAgent("watcher")).state.status === "asleep", 30_000, "turn over");
    const s = await rt.store("watcher").schedule();
    expect(s.wakeReason ?? "").not.toMatch(/default wake-up/);
  });
});

describe("common problems", () => {
  it("says exactly what to do when the backend isn't signed in, once", async () => {
    await rt.create("unsigned");
    await rt.send("unsigned", "NOT_SIGNED_IN");
    const alert = await until(async () => (await rt.store("unsigned").messages()).find((m) => m.kind === "alert"), 30_000, "alert");
    expect(alert.text).toMatch(/isn't signed in/);
    // It retries slowly, not every minute.
    const s = await until(async () => {
      const x = await rt.store("unsigned").schedule();
      return x.wakeAt ? x : null;
    }, 20_000, "retry scheduled");
    expect(new Date(s.wakeAt!).getTime() - Date.now()).toBeGreaterThan(30 * 60_000);
  });

  it("says so plainly when a backend isn't installed", async () => {
    const { needsPerson } = await import("../src/runtime/errors.js");
    expect(needsPerson('Could not start backend "gemini" (gemini): spawn gemini ENOENT', "gemini", "a")).toMatch(/isn't installed/);
    expect(needsPerson("claude: Internal error: Your credit balance is too low", "claude", "a")).toMatch(/out of credit/);
    expect(needsPerson("claude: Internal error: overloaded", "claude", "a")).toBeNull();
  });

  it("survives a damaged state file and keeps the damaged copy", async () => {
    await rt.create("damaged");
    const f = join(meta("damaged"), "conversation.json");
    writeFileSync(f, "{ not json");
    expect(await rt.store("damaged").unread()).toBe(1);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(meta("damaged")).some((x) => x.startsWith("conversation.json.damaged-"))).toBe(true);
    // And keeps working.
    await rt.send("damaged", "Your job is testing.");
    expect((await rt.store("damaged").messages()).length).toBe(2);
  });

  it("never wipes AGENT.md settings when its saved copy is lost", async () => {
    await rt.create("lostcopy", { dailyBudgetUsd: 7 } as any);
    const { rmSync } = await import("node:fs");
    rmSync(join(meta("lostcopy"), "settings.json"));
    const { restoreSettings } = await import("../src/agent/agent.js");
    await restoreSettings("lostcopy");
    expect((await loadAgent("lostcopy")).settings.dailyBudgetUsd).toBe(7);
    expect(readFileSync(join(home, "agents", "lostcopy", "AGENT.md"), "utf8")).toContain("dailyBudgetUsd: 7");
  });
});

describe("one conversation per agent", () => {
  it("copies attached files into the agent's folder and tells the agent where they are", async () => {
    await employ("viewer");
    const src = join(home, "photo.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const m = await rt.send("viewer", "PASS look at this", [src]);
    expect(m.attachments![0].kind).toBe("image");
    expect(m.attachments![0].path).toContain(join("agents", "viewer", "files", "received"));
    expect(existsSync(m.attachments![0].path)).toBe(true);
    const { readdirSync } = await import("node:fs");
    const runs = join(meta("viewer"), "runs");
    await until(async () => readdirSync(runs).some((x) => readFileSync(join(runs, x), "utf8").includes(m.attachments![0].path)), 30_000, "path given to agent");
    await expect(rt.send("viewer", "x", [join(home, "nope.png")])).rejects.toThrow(/no file/);
  });

  it("merges an older agent's threads into one conversation, keeping answers", async () => {
    const name = "oldtimer";
    await rt.create(name);
    const dir = meta(name);
    const { rmSync, mkdirSync: mk } = await import("node:fs");
    rmSync(join(dir, "messages.jsonl"), { force: true });
    rmSync(join(dir, "conversation.json"), { force: true });
    mk(join(dir, "threads"), { recursive: true });
    writeFileSync(join(dir, "threads.json"), JSON.stringify([
      { id: "th_a", kind: "conversation", title: "hi", status: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z", unread: 0 },
      { id: "th_q", kind: "question", title: "Bridge?", status: "answered", createdAt: "2026-01-01T00:02:00Z", updatedAt: "2026-01-01T00:03:00Z", unread: 0, category: "c" },
    ]));
    writeFileSync(join(dir, "threads", "th_a.jsonl"), [
      { id: "m1", t: "2026-01-01T00:00:00Z", from: "agent", text: "hello" },
      { id: "m2", t: "2026-01-01T00:01:00Z", from: "you", text: "hi back" },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(dir, "threads", "th_q.jsonl"), [
      { id: "m3", t: "2026-01-01T00:02:00Z", from: "agent", text: "Bridge?", options: ["Yes", "No"] },
      { id: "m4", t: "2026-01-01T00:03:00Z", from: "you", text: "1. Yes", choice: 1 },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const { Store: S } = await import("../src/store/store.js");
    const ms = await new S(name).messages();
    expect(ms.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(ms[2].kind).toBe("question");
    expect(ms[2].answer?.choice).toBe(1);
    expect(existsSync(join(dir, "threads.json.before-single-conversation"))).toBe(true);
  });
});
