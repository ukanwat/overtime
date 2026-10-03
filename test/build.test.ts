import { describe, it, expect } from "vitest";
import { compareBuilds } from "../src/daemon/client.js";
import { buildId } from "../src/daemon/build.js";

describe("daemon builds", () => {
  it("know which build they are", () => {
    expect(buildId()).toMatch(/^\d+\.\d+\.\d+.*\+\d+$/);
  });
  it("only an older daemon gets replaced", () => {
    expect(compareBuilds("0.2.0+5", "0.3.0+1")).toBeLessThan(0);
    expect(compareBuilds("0.3.0+9", "0.3.0+5")).toBeGreaterThan(0);
    expect(compareBuilds("0.10.0+1", "0.9.0+9")).toBeGreaterThan(0);
    expect(compareBuilds("0.3.0+5", "0.3.0+5")).toBe(0);
  });
});
