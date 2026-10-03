import { describe, it, expect } from "vitest";
import { describeStep } from "../src/daemon/steps.js";

describe("what an agent is doing, in a few calm words", () => {
  it("never shows a tool's internal name or the details", () => {
    expect(describeStep({ title: "mcp__overtime__send", kind: "other" })).toBe("Writing to you");
    expect(describeStep({ title: "mcp__overtime__spawn" })).toBe("Starting a helper");
    expect(describeStep({ title: "mcp__github__create_pull_request" })).toBe("Using github");
    expect(describeStep({ title: "Terminal", kind: "execute", rawInput: { command: "npm test -- --watch=false" } })).toBe("Running a command");
    expect(describeStep({ title: "Read File", kind: "read", locations: [{ path: "/a/b/calc.py" }] })).toBe("Reading files");
    expect(describeStep({ title: "Edit", kind: "edit" })).toBe("Editing files");
    expect(describeStep({ title: "Preparing file…", kind: "edit" })).toBe("Writing files");
    expect(describeStep({ title: "Fetch", kind: "fetch", rawInput: { url: "https://ghibli.jp/works" } })).toBe("Looking things up");
    expect(describeStep({ title: "Read", kind: "other" })).toBeNull();
  });
});
