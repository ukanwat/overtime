import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Store } = await import("../src/store/store.js");
const { MonitorRunner } = await import("../src/daemon/monitors.js");

/** A runner over a real store, recording what it fires and reports. */
function rig(agent: string) {
  const dir = join(home, "agents", agent);
  mkdirSync(dir, { recursive: true });
  const store = new Store(agent);
  const fired: string[] = [];
  const failing: string[] = [];
  const runner = new MonitorRunner(
    { fire: (_a, _m, out) => void fired.push(out), failing: (_a, _m, detail) => void failing.push(detail), log: () => {} },
    () => store,
    () => dir,
  );
  return { store, runner, fired, failing };
}

describe("watches", () => {
  const runners: { stopAll(): void }[] = [];
  afterEach(() => {
    for (const r of runners.splice(0)) r.stopAll();
  });

  it("a burst of lines wakes the agent once, not once per line", async () => {
    const { store, runner, fired } = rig("burst");
    runners.push(runner);
    const m = await store.addMonitor({ run: "for i in 1 2 3 4 5 6 7 8 9 10; do echo line$i; done; sleep 60", everyMs: null, why: "burst", cooldownMs: 10 * 60_000 });
    runner.start("burst", m.id);
    await until(async () => fired.length > 0, 10_000, "first fire");
    await new Promise((r) => setTimeout(r, 1500));
    expect(fired.length).toBe(1);
    expect(fired[0]).toContain("line1");
  });

  it("a schedule or cooldown longer than a timer can hold doesn't make it run nonstop", async () => {
    const { store, runner } = rig("long");
    runners.push(runner);
    const counter = join(home, "agents", "long", "runs.txt");
    const m = await store.addMonitor({ run: `echo x >> ${counter}; date +%s%N`, everyMs: 30 * 86400_000, why: "monthly", cooldownMs: 30 * 86400_000 });
    runner.start("long", m.id);
    await new Promise((r) => setTimeout(r, 1500));
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(counter, "utf8").trim().split("\n").length).toBe(1);
  });
});

describe("bookkeeping files", () => {
  it("a record appended after a torn last line survives", async () => {
    const { appendJsonl, readJsonl } = await import("../src/fsutil.js");
    const { writeFileSync } = await import("node:fs");
    const f = join(home, "torn.jsonl");
    writeFileSync(f, '{"a":1}\n{"half":');
    await appendJsonl(f, { b: 2 });
    expect(await readJsonl(f)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("opening the conversation marks read only what it showed", async () => {
    const store = new Store("reader");
    mkdirSync(join(home, "agents", "reader"), { recursive: true });
    const a = await store.addMessage({ from: "agent", kind: "message", text: "one", baseDir: home });
    await store.addMessage({ from: "agent", kind: "message", text: "two", baseDir: home });
    await store.markRead(a.id);
    expect(await store.unread()).toBe(1);
    await store.markRead();
    expect(await store.unread()).toBe(0);
    await store.markRead(a.id); // never moves backwards
    expect(await store.unread()).toBe(0);
  });
});

describe("time and money", () => {
  it("a daily wake-up keeps its local time across a daylight-saving change", async () => {
    const { step } = await import("../src/store/store.js");
    // In a process with a US time zone: 2026-03-08 is the spring-forward day there.
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, ["--import", "tsx", "-e", `import("${join(import.meta.dirname, "../src/store/store.ts")}").then(({ step }) => { const t = new Date(2026, 2, 7, 9, 0).getTime(); const n = new Date(step(t, 86400000)); console.log(n.getHours() + ":" + n.getMinutes() + " " + n.getDate()); })`], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" });
    expect(out.trim()).toBe("9:0 8");
    expect(step(1000, 3600_000)).toBe(3601_000);
  });

  it("a session resumed after its old usage rows are trimmed isn't charged its whole lifetime again", async () => {
    const { recordTurnUsage, trimUsage, usageToday } = await import("../src/runtime/usage.js");
    const { writeFileSync } = await import("node:fs");
    mkdirSync(join(home, "agents", "sleeper", ".overtime"), { recursive: true });
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const row = (t: string, cost: number) => JSON.stringify({ t, runId: "r", kind: "main", backend: "claude", sessionId: "s1", tokens: null, sessionCostUsd: cost, turnCostUsd: 1, context: null });
    writeFileSync(join(home, "agents", "sleeper", ".overtime", "usage.jsonl"), row(old, 40) + "\n" + row(old, 50) + "\n");
    await trimUsage("sleeper", Date.now() - 30 * 86400_000);
    await recordTurnUsage("sleeper", { runId: "r2", kind: "main", backend: "claude", sessionId: "s1", tokens: null, sessionCostUsd: 52, firstCostUsd: 50.5, context: null });
    expect((await usageToday("sleeper")).usd).toBeCloseTo(2);
  });
});
