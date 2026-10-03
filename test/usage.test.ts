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
