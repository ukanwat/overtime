import { describe, it, expect } from "vitest";
import { turnCost } from "../src/runtime/usage.js";

describe("a turn's cost, from the totals the backend reported", () => {
  it("is the whole total on a fresh session", () => {
    expect(turnCost(null, 0.01, 0.05)).toBeCloseTo(0.05);
  });
  it("is the increase when the backend carried the session's total over", () => {
    expect(turnCost(0.289, 0.3, 0.375)).toBeCloseTo(0.086);
  });
  it("is the new total when the backend started counting again", () => {
    expect(turnCost(0.0437, 0.005, 0.0136)).toBeCloseTo(0.0136);
  });
});

describe("a recorded usage limit", async () => {
  const { fakeHome } = await import("./helpers.js");
  const home = fakeHome();
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { limitInfo, writeLimit, clearLimit, gotThroughAt, LIMIT_RECHECK_MS } = await import("../src/runtime/usage.js");
  const { limitHold } = await import("../src/daemon/runtime.js");
  it("is tried again after 15 minutes even when its reset is hours away, and cleared by a turn that gets through", async () => {
    const now = Date.now();
    const resetsAt = Math.floor((now + 5 * 3600_000) / 1000);
    await writeLimit({ backend: "x", status: "rejected", resetsAt, updatedAt: new Date(now).toISOString() });
    const info = await limitInfo("x", null, now);
    expect(info?.resetsAt?.getTime()).toBe(resetsAt * 1000);
    expect(info?.retryAt.getTime()).toBe(now + LIMIT_RECHECK_MS);
    expect(await limitInfo("x", null, now + LIMIT_RECHECK_MS + 1)).toBeNull(); // time to try again
    // A reset sooner than the recheck: tried at the reset.
    await writeLimit({ backend: "y", status: "rejected", resetsAt: Math.floor((now + 60_000) / 1000), updatedAt: new Date(now).toISOString() });
    expect((await limitInfo("y", null, now))!.retryAt.getTime()).toBeLessThanOrEqual(now + 60_000);
    await clearLimit("x");
    expect(await limitInfo("x", null, now)).toBeNull();
  });

  it("is kept per model and per limit: other models, and other limits of the same model, don't touch it", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const weekly = Math.floor((now + 2 * 86400_000) / 1000);
    await writeLimit({ backend: "c", model: "opus", status: "rejected", rateLimitType: "seven_day", resetsAt: weekly, updatedAt: at });
    // Another model's reports, and the same model's 5-hour limit, are all allowed.
    await writeLimit({ backend: "c", model: "sonnet", status: "allowed", rateLimitType: "seven_day", updatedAt: at });
    await writeLimit({ backend: "c", model: null, status: "allowed", rateLimitType: "seven_day", updatedAt: at });
    await writeLimit({ backend: "c", model: "opus", status: "allowed_warning", rateLimitType: "five_hour", updatedAt: at });
    expect((await limitInfo("c", "opus", now))?.resetsAt?.getTime()).toBe(weekly * 1000);
    expect(await limitInfo("c", "sonnet", now)).toBeNull();
    expect(await limitInfo("c", null, now)).toBeNull();
    // A turn on another model getting through says nothing about opus.
    await clearLimit("c", "sonnet");
    expect(await limitInfo("c", "opus", now)).not.toBeNull();
    expect(await gotThroughAt("c", "opus")).toBeNull();
    await clearLimit("c", "opus");
    expect(await limitInfo("c", "opus", now)).toBeNull();
    expect(await gotThroughAt("c", "opus")).toBeInstanceOf(Date);
  });

  it("a turn getting through is noted even when its own reports already marked the limit allowed", async () => {
    const at = new Date().toISOString();
    await writeLimit({ backend: "r", model: "opus", status: "rejected", rateLimitType: "seven_day", updatedAt: at });
    await writeLimit({ backend: "r", model: "opus", status: "allowed", rateLimitType: "seven_day", updatedAt: at }); // the turn's own report
    await clearLimit("r", "opus");
    expect(await gotThroughAt("r", "opus")).toBeInstanceOf(Date);
  });

    it("recorded in the old one-per-backend format: one still in force holds for every model until a turn gets through; others are dropped", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    writeFileSync(
      join(home, "limits.json"),
      JSON.stringify({ old: { backend: "old", status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor(now / 1000) + 3600, updatedAt: at }, fine: { backend: "fine", status: "allowed", updatedAt: at } }),
    );
    expect(await limitInfo("old", "opus", now)).not.toBeNull();
    expect(await limitInfo("old", null, now)).not.toBeNull();
    expect(await limitInfo("fine", null, now)).toBeNull();
    await writeLimit({ backend: "fine", model: "m", status: "allowed", updatedAt: at }); // rewritten in the new format
    expect(await limitInfo("old", "opus", now)).not.toBeNull();
    await clearLimit("old", "sonnet");
    expect(await limitInfo("old", "opus", now)).toBeNull();
  });

  it("an agent whose last turns all ended on a limit within one interval is held a full interval after the last", () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(limitHold([ago(30_000), ago(20_000)], now)).toBeNull(); // two is not yet a pattern
    expect(limitHold([ago(30_000), ago(20_000), ago(10_000)], now)?.getTime()).toBe(now - 10_000 + LIMIT_RECHECK_MS);
    // Spread over more than an interval: it was already waiting between tries.
    expect(limitHold([ago(2 * LIMIT_RECHECK_MS + 2000), ago(LIMIT_RECHECK_MS + 1000), ago(1000)], now)).toBeNull();
    expect(limitHold([ago(LIMIT_RECHECK_MS + 3000), ago(LIMIT_RECHECK_MS + 2000), ago(LIMIT_RECHECK_MS + 1000)], now)).toBeNull(); // served
  });
});
