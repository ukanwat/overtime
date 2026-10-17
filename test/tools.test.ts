import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fakeHome } from "./helpers.js";

fakeHome();
const { registerTools } = await import("../src/tools/tools.js");

/** Overtime's tools for a main session, over a real MCP connection, against a host that records what they ask of it. */
async function connect(host: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const base = { store: () => ({}), agentDir: () => "/tmp", changed: () => {}, ...host };
  const recorded = new Proxy(base, {
    get: (o: any, k: string) =>
      typeof o[k] === "function"
        ? (...args: unknown[]) => {
            calls.push({ method: k, args });
            return o[k](...args);
          }
        : o[k],
  });
  const mcp = new McpServer({ name: "overtime", version: "1" });
  registerTools(mcp, { token: "t", agent: "ann", kind: "main", depth: 0, wakeChosen: false }, recorded as any);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const tools = (await client.listTools()).tools;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: (r.content ?? []).map((x: any) => x.text).join(""), isError: !!r.isError };
  };
  return { tools, call, calls };
}

describe("cancel", () => {
  it("takes an optional why, and asks agents for one when withdrawing a question", async () => {
    const { tools } = await connect();
    const cancel = tools.find((t) => t.name === "cancel")!;
    expect(cancel.inputSchema.required).toEqual(["id"]);
    expect((cancel.inputSchema.properties as any).why.type).toBe("string");
    expect(cancel.description).toMatch(/withdrawing a question, give a short why/);
  });

  it("passes the why along when withdrawing a question, and none when it's blank", async () => {
    const { call, calls } = await connect({ withdrawQuestion: async () => true });
    expect((await call("cancel", { id: "m_1", why: "  you gave me full access " })).text).toContain("Withdrew question m_1");
    await call("cancel", { id: "m_2", why: " " });
    await call("cancel", { id: "m_3" });
    expect(calls.filter((c) => c.method === "withdrawQuestion").map((c) => c.args)).toEqual([
      ["ann", "m_1", "you gave me full access"],
      ["ann", "m_2", undefined],
      ["ann", "m_3", undefined],
    ]);
  });
});
