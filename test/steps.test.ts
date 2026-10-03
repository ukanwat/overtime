import { describe, it, expect } from "vitest";
import { describeStep } from "../src/daemon/steps.js";

describe("what an agent is doing, in plain words", () => {
  it("never shows a tool's internal name", () => {
    expect(describeStep({ title: "mcp__overtime__send", kind: "other" })).toBe("Writing to you");
    expect(describeStep({ title: "mcp__overtime__wake" })).toBe("Planning when to work next");
    expect(describeStep({ title: "mcp__overtime__spawn" })).toBe("Starting a helper");
    expect(describeStep({ title: "mcp__github__create_pull_request" })).toBe("Using github: create pull request");
    expect(describeStep({ title: "Terminal", kind: "execute" })).toBe("Running a command");
    expect(describeStep({ title: "Read", kind: "other" })).toBeNull();
  });
  it("says what's being run, read, written or looked up", () => {
    expect(describeStep({ title: "Terminal", kind: "execute", rawInput: { command: "npm test -- --watch=false" } })).toBe("Running npm test -- --watch=false");
    expect(describeStep({ title: "Read File", kind: "read", locations: [{ path: "/a/b/calc.py" }] })).toBe("Reading calc.py");
    expect(describeStep({ title: "Edit", kind: "edit", locations: [{ path: "/a/b/README.md" }] })).toBe("Editing README.md");
    expect(describeStep({ title: "Preparing file…", kind: "edit", rawInput: { file_path: "/x/notes.md" } })).toBe("Writing notes.md");
    expect(describeStep({ title: "grep", kind: "search", rawInput: { pattern: "TODO" } })).toBe("Searching for TODO");
    expect(describeStep({ title: "Fetch", kind: "fetch", rawInput: { url: "https://ghibli.jp/works" } })).toBe("Looking up ghibli.jp");
  });
});
