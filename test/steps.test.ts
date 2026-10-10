import { describe, it, expect } from "vitest";
import { describeStep, ownToolStep } from "../src/daemon/steps.js";

describe("what an agent is doing, in a few calm words", () => {
  it("comes from the call's kind, never a tool's internal name or the details", () => {
    expect(describeStep({ title: "npm test -- --watch=false", kind: "execute", rawInput: { command: "npm test -- --watch=false" } })).toBe("Running a command");
    expect(describeStep({ title: "Read File", kind: "read", locations: [{ path: "/a/b/calc.py" }] })).toBe("Reading files");
    expect(describeStep({ title: "Preparing file…", kind: "edit" })).toBe("Editing files");
    expect(describeStep({ title: "Fetch", kind: "fetch", rawInput: { url: "https://ghibli.jp/works" } })).toBe("Looking things up");
    expect(describeStep({ title: "Read", kind: "other" })).toBeNull();
  });

  it("names the MCP server a call goes to, on every backend", () => {
    // Claude: kind other, the server in the tool's name and (in newer versions) in _meta.
    expect(describeStep({ title: "mcp__github__create_pull_request", kind: "other", _meta: { claudeCode: { toolName: "mcp__github__create_pull_request" } } }, ["github"])).toBe("Using github");
    expect(describeStep({ title: "x", kind: "other", _meta: { claudeCode: { mcpServer: { name: "linear" } } } })).toBe("Using linear");
    // Codex: kind execute, marked as an MCP call, the server in rawInput.
    expect(describeStep({ title: "mcp.github.create_issue", kind: "execute", rawInput: { server: "github", tool: "create_issue" }, _meta: { is_mcp_tool_call: true } })).toBe("Using github");
    // A server name the agent doesn't have isn't guessed at.
    expect(describeStep({ title: "mcp__other__x", kind: "other" }, ["github"])).toBeNull();
  });

  it("leaves Overtime's own tools to Overtime, which reports them as they run", () => {
    expect(describeStep({ title: "mcp__overtime__send", kind: "other" })).toBeNull();
    expect(describeStep({ title: "mcp.overtime.send", kind: "execute", rawInput: { server: "overtime", tool: "send" }, _meta: { is_mcp_tool_call: true } })).toBeNull();
    expect(ownToolStep("send")).toBe("Writing to you");
    expect(ownToolStep("spawn")).toBe("Starting a helper");
    expect(ownToolStep("tell")).toBe("Writing to a helper");
  });
});
