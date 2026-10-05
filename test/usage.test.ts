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
  fakeHome();
  const { limitInfo, writeLimit, clearLimit, LIMIT_RECHECK_MS } = await import("../src/runtime/usage.js");
  it("is tried again after 15 minutes even when its reset is hours away, and cleared by a turn that gets through", async () => {
    const now = Date.now();
    const resetsAt = Math.floor((now + 5 * 3600_000) / 1000);
    await writeLimit({ backend: "x", status: "rejected", resetsAt, updatedAt: new Date(now).toISOString() });
    const info = await limitInfo("x", now);
    expect(info?.resetsAt?.getTime()).toBe(resetsAt * 1000);
    expect(info?.retryAt.getTime()).toBe(now + LIMIT_RECHECK_MS);
    expect(await limitInfo("x", now + LIMIT_RECHECK_MS + 1)).toBeNull(); // time to try again
    // A reset sooner than the recheck: tried at the reset.
    await writeLimit({ backend: "y", status: "rejected", resetsAt: Math.floor((now + 60_000) / 1000), updatedAt: new Date(now).toISOString() });
    expect((await limitInfo("y", now))!.retryAt.getTime()).toBeLessThanOrEqual(now + 60_000);
    await clearLimit("x");
    expect(await limitInfo("x", now)).toBeNull();
  });
});
