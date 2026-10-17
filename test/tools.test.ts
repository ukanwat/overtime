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

describe("ask", () => {
  const added: any[] = [];
  const notes: string[][] = [];
  const host = {
    store: () => ({ addMessage: async (m: any) => (added.push(m), { id: `m_${added.length}`, ...m }) }),
    notify: (title: string, body: string) => void notes.push([title, body]),
  };

  it("lets the person pick several unless single, and asks agents to batch related questions", async () => {
    const { tools } = await connect(host);
    const ask = tools.find((t) => t.name === "ask")!;
    expect(ask.description).toContain("Batch related questions into one ask");
    expect(ask.description).toContain("They may pick several options unless you set single.");
    const props = ask.inputSchema.properties as any;
    expect(props.single.type).toBe("boolean");
    expect(Object.keys(props.questions.items.properties).sort()).toEqual(["options", "question", "recommendation", "single", "why"]);
    // Nothing new is required: a question asked the old way still works.
    expect(ask.inputSchema.required ?? []).toEqual([]);
  });

  it("asks one question the old way, multi-select unless single", async () => {
    const { call } = await connect(host);
    added.length = notes.length = 0;
    expect((await call("ask", { question: "Which platforms?", options: ["macOS", "Linux"] })).text).toContain("Asked (m_1)");
    await call("ask", { question: "Which version?", options: ["2.0.0", "1.9.0"], single: true });
    expect(added[0]).toMatchObject({ kind: "question", text: "Which platforms?", options: ["macOS", "Linux"] });
    expect(added[0].single).toBeUndefined();
    expect(added[1].single).toBe(true);
    expect(notes).toEqual([["ann has a question", "Which platforms?"], ["ann has a question", "Which version?"]]);
  });

  it("puts several questions on one card, with one notification for it", async () => {
    const { call } = await connect(host);
    added.length = notes.length = 0;
    await call("ask", {
      question: "Before I cut 2.0",
      questions: [
        { question: "Which platforms?", options: ["macOS", "Linux"], recommendation: "macOS" },
        { question: "Which version?", options: ["2.0.0", "1.9.0"], single: true },
        { question: "Who to credit?", why: "Three outside fixes" },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      title: "Before I cut 2.0",
      text: "1. Which platforms?\n2. Which version?\n3. Who to credit?",
      questions: [
        { text: "Which platforms?", options: ["macOS", "Linux"], recommendation: "macOS" },
        { text: "Which version?", single: true },
        { text: "Who to credit?", why: "Three outside fixes" },
      ],
    });
    expect(notes).toEqual([["ann has 3 questions", "Before I cut 2.0"]]);
  });

  it("treats a list of one as a plain question, and refuses an ask with no question", async () => {
    const { call } = await connect(host);
    added.length = 0;
    await call("ask", { questions: [{ question: "Merge it?", options: ["Yes", "No"], single: true }] });
    expect(added[0]).toMatchObject({ text: "Merge it?", options: ["Yes", "No"], single: true });
    expect(added[0].questions).toBeUndefined();
    expect(await call("ask", {})).toEqual({ text: "Give a question, or questions.", isError: true });
  });
});
