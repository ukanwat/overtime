/**
 * A scripted ACP backend for tests: speaks real ACP on stdio and calls Overtime's real tools over MCP,
 * so the daemon can be tested end to end without a model. Behaviour is driven by words in the prompt.
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** --stdio-mcp: act like a backend that only runs MCP servers as local commands (Overtime must bridge). */
const STDIO_ONLY = process.argv.includes("--stdio-mcp");

interface S {
  cwd: string;
  /** Overtime's tools server: a URL, or (for a stdio-only backend) the command to start. */
  tools?: string | { command: string; args: string[] };
  cost: number;
}
const sessions = new Map<string, S>();
let cancelled = false;
/** SLOW: wait up to a minute, ending early (as a real backend does) when the turn is cancelled. */
async function slow(): Promise<boolean> {
  for (let i = 0; i < 600 && !cancelled; i++) await new Promise((r) => setTimeout(r, 100));
  return cancelled;
}

async function tools(where: string | { command: string; args: string[] }) {
  const c = new Client({ name: "fake-agent", version: "1" });
  await c.connect(typeof where === "string" ? new StreamableHTTPClientTransport(new URL(where)) : new StdioClientTransport({ command: where.command, args: where.args }));
  return {
    list: async () => (await c.listTools()).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const r: any = await c.callTool({ name, arguments: args });
      const text = (r.content ?? []).map((x: any) => x.text).join("");
      if (r.isError) throw new Error(`${name}: ${text}`);
      return text;
    },
    close: () => c.close(),
  };
}

async function turn(sessionId: string, text: string, cx: any): Promise<acp.PromptResponse> {
  const s = sessions.get(sessionId)!;
  const say = (t: string) => cx.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
  if (/NOT_SIGNED_IN/.test(text)) throw new acp.RequestError(-32000, "Authentication required");
  if (/COSTLY_FAIL/.test(text)) {
    s.cost += 0.25;
    await cx.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "usage_update", used: 1000, size: 100000, cost: { amount: s.cost, currency: "USD" } } as any });
    throw new acp.RequestError(-32603, "Internal error", { message: "scripted costly failure" });
  }
  if (/OVERLOADED_TURN/.test(text)) throw new acp.RequestError(-32603, "Internal error", { errorKind: "overloaded", message: "API Error: 529" }); // Claude's shape
  if (/FAIL_TURN/.test(text) && !/RECOVERED/.test(text)) throw new acp.RequestError(-32603, "Internal error", { message: "scripted failure" });
  if (!s.tools) {
    await say("no overtime tools");
    return { stopReason: "end_turn" };
  }
  const t = await tools(s.tools);
  const names = await t.list();
  const folder = /# Your folder\n\n(.+)/.exec(text)?.[1];
  try {
    if (/You are a helper/.test(text) || /a helper working for/.test(text)) {
      // FLAKY: the provider fails once with a 502, then works (the retry continues from the folder).
      if (/FLAKY/.test(text)) {
        const mark = join(s.cwd, ".flaky-once");
        if (!existsSync(mark)) {
          writeFileSync(mark, "1");
          throw new acp.RequestError(-32603, "Internal error", { message: "stream error", codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 502 } } }); // Codex's shape
        }
      }
      if (/SLOW/.test(text)) {
        await t.call("done", { result: "partial: got halfway" });
        if (await slow()) return { stopReason: "cancelled" };
      }
      writeFileSync(join(s.cwd, "result.txt"), "helper output\n");
      await t.call("done", { result: `wrote ${join(s.cwd, "result.txt")}` });
      await say("helper done");
    } else if (/The person just wrote:/.test(text)) {
      const msg = /The person just wrote:\n\n([\s\S]*?)\n\nAnswer them/.exec(text)?.[1] ?? text.split("\n").pop();
      if (/PASS/.test(msg ?? "")) await t.call("send", { to: "main", text: `do this: ${msg}` });
      if (!/NOREPLYTOOL/.test(msg ?? "")) await t.call("send", { text: `chat reply to: ${msg}` });
      else await say(`final words as reply to: ${msg}`);
    } else {
      if (/This is your first conversation/.test(text) && folder) {
        // Real backends report their file writes as tool calls; so does the fake.
        await cx.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "w1", title: "Write AGENT.md", kind: "edit", status: "completed", locations: [{ path: join(folder, "AGENT.md") }] } as any });
        writeFileSync(join(folder, "AGENT.md"), "# fake\n\n## Job\nTest job.\n\n## Rules\n- Ask before publishing.\n");
        mkdirSync(join(folder, "notes"), { recursive: true });
        writeFileSync(join(folder, "INDEX.md"), "# Index\n\n- notes/: what I learned\n");
      }
      if (/Message from the person|The person answered|Passed on from your conversation/.test(text)) {
        // Echo each thing the person said, so tests can tell which message got which reply.
        for (const m of text.matchAll(/(?:Message from the person|The person answered)[^\n]*\n([^\n]*)/g)) {
          const said = m[1];
          if (/NOREPLYTOOL/.test(said)) await say(`final words as reply to: ${said}`);
          else await t.call("send", { text: `main reply to: ${said}` });
        }
      }
      if (/SKILLCHECK/.test(text)) writeFileSync(join(s.cwd, "skill-result.txt"), await t.call("skill", { name: "overtime-docs" }));
      if (/ESCAPE/.test(text)) {
        // Try to write into a protected path, as a script or program it wrote would.
        const target = join(process.env.OVERTIME_HOME ?? homedir(), "protected", `escape-${process.pid}`);
        let result = "denied";
        try {
          writeFileSync(target, "x");
          result = "LEAKED";
          rmSync(target, { force: true });
        } catch {}
        writeFileSync(join(s.cwd, "escape-result.txt"), result);
      }
      if (/SPAWN_MISSING/.test(text) && names.includes("spawn")) writeFileSync(join(s.cwd, "spawn-note.txt"), await t.call("spawn", { task: "write result.txt", backend: "not-installed-cli", model: "some-model" }));
      else if (/SPAWN_FLAKY/.test(text) && names.includes("spawn")) await t.call("spawn", { task: "FLAKY write result.txt" });
      else if (/SPAWN_SLOW/.test(text) && names.includes("spawn")) await t.call("spawn", { task: "SLOW write result.txt" });
      else if (/SPAWN/.test(text) && names.includes("spawn")) await t.call("spawn", { task: "write result.txt" });
      if (/SLOW/.test(text) && !/SPAWN_SLOW/.test(text) && !/Helper result/.test(text) && (await slow())) return { stopReason: "cancelled" };
      if (/WATCH_LONG/.test(text)) await t.call("wake", { watch: "for i in 1 2 3; do echo tick $i; sleep 1; done; sleep 600", reason: "long test", cooldown: "1s" });
      if (/WATCH_REPEAT/.test(text)) await t.call("wake", { watch: "cat watched.txt 2>/dev/null || echo none", every: "10s", reason: "repeat test", cooldown: "1s" });
      if (/Message from the person[^\n]*\n[^\n]*\bASK\b/.test(text)) await t.call("ask", { question: "Bridge or ferry?", why: "test", recommendation: "Bridge", options: ["Bridge", "Ferry"], category: "test-choice" });
      if (/LOOP/.test(text)) await t.call("wake", { every: "1m", reason: "loop task" });
      await t.call("send", { status: "fake is working" });
      if (/NOTIFY/.test(text)) await t.call("send", { title: "Fake update", text: "Did a fake thing." });
      if (!/NOSLEEP/.test(text)) await t.call("wake", { in: "30m", reason: "fake rest" });
      await say("main turn done");
    }
  } finally {
    await t.close();
  }
  s.cost += 0.01;
  await cx.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "usage_update", used: 1000, size: 100000, cost: { amount: s.cost, currency: "USD" } } as any });
  return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as any };
}

/** Where Overtime's tools are, as this backend was given them. A stdio-only backend must be given a command. */
function toolsServer(servers: any[] = []): S["tools"] {
  const m = servers.find((x) => x.name === "overtime");
  if (!m) return undefined;
  if (m.type === "http") return STDIO_ONLY ? undefined : m.url;
  return { command: m.command, args: m.args };
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, mcpCapabilities: { http: !STDIO_ONLY } } }) as any)
  .onRequest("session/new", (ctx: any) => {
    const id = randomUUID();
    const http = toolsServer(ctx.params.mcpServers);
    sessions.set(id, { cwd: ctx.params.cwd, tools: http, cost: 0 });
    // Record which MCP servers this session was given, so tests can check what reached the backend.
    try {
      writeFileSync(join(ctx.params.cwd, ".mcp-seen"), (ctx.params.mcpServers ?? []).map((m: any) => m.name).join(",") + "\n");
    } catch {}
    return { sessionId: id, modes: { availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }], currentModeId: "default" } } as any;
  })
  .onRequest("session/load", (ctx: any) => {
    // A continued session gets the current MCP servers too: record them, as for a new one.
    try {
      writeFileSync(join(ctx.params.cwd, ".mcp-seen"), (ctx.params.mcpServers ?? []).map((m: any) => m.name).join(",") + "\n");
    } catch {}
    const http = toolsServer(ctx.params.mcpServers);
    const prev = sessions.get(ctx.params.sessionId);
    sessions.set(ctx.params.sessionId, { cwd: ctx.params.cwd, tools: http, cost: prev?.cost ?? 0.05 });
    return {} as any;
  })
  .onRequest("session/set_mode", () => ({}) as any)
  .onRequest("session/prompt", (ctx: any) => turn(ctx.params.sessionId, ctx.params.prompt.map((p: any) => p.text ?? "").join("\n"), ctx.client))
  .onNotification("session/cancel", () => {
    cancelled = true;
  })
  .connect(stream);
