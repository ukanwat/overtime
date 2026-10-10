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
