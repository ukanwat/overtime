import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

// The incident: an agent on one model hit Claude's weekly limit while agents on other models of the same
// account kept getting through and reporting their limits as allowed. Each of their reports and turns
// wiped its limit, so its pause lifted within seconds and it ran into the limit every 5 seconds for hours.
const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");
const { blockedUntil, LIMIT_RECHECK_MS } = await import("../src/runtime/usage.js");

const rt = new Runtime(() => {});
beforeAll(async () => {
  writeFileSync(join(home, "report-limits"), "1");
  await rt.start();
});
afterAll(async () => rt.stop());

const limits = () => JSON.parse(readFileSync(join(home, "limits.json"), "utf8"));
const mainRuns = (name: string) => readdirSync(join(paths.meta(name), "runs")).filter((f) => f.startsWith("main_")).length;
const state = async (name: string) => (await loadAgent(name)).state;
const limitModel = (model: string, resetsAt: number) => writeFileSync(join(home, `limit-model-${model}`), String(resetsAt));
const liftModel = (model: string) => {
  rmSync(join(home, `limit-model-${model}`), { force: true });
  rmSync(join(home, `limit-model-${model}.told`), { force: true });
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function employ(name: string, model: string) {
  await rt.create(name);
  await rt.setAgentSettings(name, { model });
  await rt.send(name, "Your job is testing.");
  await until(async () => (await state(name)).status === "asleep", 30_000, `${name} settled`);
}

describe("a usage limit on one model, while other models of the same backend get through", () => {
  const weekAway = Math.floor(Date.now() / 1000) + 2 * 86400;

  beforeAll(async () => {
    await employ("director", "opus");
    await employ("writer", "sonnet");
    await employ("critic", "opus");
  });

  it("keeps the limited agent paused, without running it, while the other model's turns get through and report allowed", async () => {
    limitModel("opus", weekAway);
    await rt.send("director", "carry on");
    await until(async () => ((await state("director")).status === "paused" ? true : null), 30_000, "director paused");
    const s = await state("director");
    expect(s.pauseReason).toBe("limit");
    expect(s.failures ?? 0).toBe(0);
    expect(new Date(s.limitResetsAt!).getTime()).toBe(weekAway * 1000);
    const before = mainRuns("director");
    // The other model keeps working, turn after turn, each reporting its 5-hour and 7-day limits as allowed.
    for (let i = 0; i < 4; i++) {
      const done = mainRuns("writer");
      await rt.wakeNow("writer");
      await until(async () => (mainRuns("writer") > done && (await state("writer")).status === "asleep" ? true : null), 30_000, "writer turn");
      await wait(1_500);
    }
    expect((await state("director")).status).toBe("paused");
    expect(mainRuns("director")).toBe(before);
    expect(limits()["fake/sonnet"].windows.seven_day.status).toBe("allowed");
    expect(limits()["fake/opus"].windows.seven_day.status).toBe("rejected");
    expect(await blockedUntil("fake", "opus")).toBeInstanceOf(Date);
    expect(await blockedUntil("fake", "sonnet")).toBeNull();
  });

  it("tries it again once its recheck time comes, and then not again for another interval", async () => {
    // The recorded limit and the pause are both 15 minutes old.
    const old = new Date(Date.now() - LIMIT_RECHECK_MS - 60_000).toISOString();
    const l = limits();
    l["fake/opus"].windows.seven_day.updatedAt = old;
    writeFileSync(join(home, "limits.json"), JSON.stringify(l));
    const before = mainRuns("director");
    await updateState("director", { pausedUntil: new Date(Date.now() - 1000).toISOString() });
    await until(async () => (mainRuns("director") === before + 1 && (await state("director")).status === "paused" && new Date((await state("director")).pausedUntil!).getTime() > Date.now() + LIMIT_RECHECK_MS - 60_000 ? true : null), 30_000, "tried once and paused again");
    // Its turn found the limit still there: trusted for another interval, for every agent on the model.
    expect((await blockedUntil("fake", "opus"))!.getTime()).toBeGreaterThan(Date.now() + LIMIT_RECHECK_MS - 60_000);
    expect((await state("director")).failures ?? 0).toBe(0);
    await rt.wakeNow("writer");
    await wait(12_000);
    expect(mainRuns("director")).toBe(before + 1);
    expect((await state("director")).status).toBe("paused");
  });

  it("carries on as soon as a turn on its own model gets through", async () => {
    liftModel("opus");
    // You write to another agent on opus: it tries despite the recorded limit, and gets through.
    await rt.send("critic", "are you there?");
    await until(async () => (await rt.store("critic").messages()).some((m) => m.from === "agent" && m.text.includes("are you there?")), 30_000, "critic answered");
    await until(async () => ((await state("director")).status === "asleep" && !(await rt.store("director").inbox()).length ? true : null), 30_000, "director resumed and handled its message");
    expect(limits()["fake/opus"].windows.seven_day.status).toBe("allowed");
    expect((await state("director")).limitHits).toEqual([]);
  });

  it("carries on when its limit's reset passes", async () => {
    await employ("quick", "haiku");
    const soon = Math.floor(Date.now() / 1000) + 8;
    limitModel("haiku", soon);
    await rt.send("quick", "go on");
    await until(async () => ((await state("quick")).status === "paused" ? true : null), 30_000, "quick paused");
    expect(new Date((await state("quick")).pausedUntil!).getTime()).toBeLessThanOrEqual(soon * 1000);
    liftModel("haiku");
    await until(async () => ((await state("quick")).status === "asleep" && !(await rt.store("quick").inbox()).length ? true : null), 40_000, "quick resumed after its reset");
    expect(new Date((await state("quick")).lastRunAt!).getTime()).toBeGreaterThanOrEqual(soon * 1000);
  });
});

describe("an agent whose turns keep ending on a usage limit", () => {
  it("isn't run again before a full recheck interval, whatever lifted its pause", async () => {
    await employ("hot", "hot-model");
    const t = (ago: number) => new Date(Date.now() - ago).toISOString();
    await updateState("hot", { limitHits: [t(60_000), t(40_000), t(20_000)] });
    const before = mainRuns("hot");
    rt.wakeMain("hot", "test");
    await until(async () => ((await state("hot")).status === "paused" ? true : null), 30_000, "hot held");
    const s = await state("hot");
    expect(s.pauseReason).toBe("limit");
    expect(Math.abs(new Date(s.pausedUntil!).getTime() - (Date.now() - 20_000 + LIMIT_RECHECK_MS))).toBeLessThan(10_000);
    await wait(11_000);
    expect((await state("hot")).status).toBe("paused");
    expect(mainRuns("hot")).toBe(before);
    // You writing to it still tries at once.
    await rt.send("hot", "still there?");
    await until(async () => (await rt.store("hot").messages()).some((m) => m.from === "agent" && m.text.includes("still there?")), 30_000, "hot answered");
  });
});
