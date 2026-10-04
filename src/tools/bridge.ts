#!/usr/bin/env node
/**
 * Overtime's connection to an MCP server added by URL. The agent's coding CLI starts it as a local
 * command and talks MCP to it on stdio; it is a client of the real server (src/mcp/remote.ts) and
 * serves the same tools, resources, prompts and completions to the CLI. Because Overtime owns the
 * connection, every CLI gets the same thing:
 * - the protocol version the server speaks (the current spec or the earlier one), negotiated by
 *   Overtime, while the CLI keeps speaking the version it knows;
 * - Overtime's sign-in to the server, renewed when the server asks;
 * - a session the server forgot is started again, and the server is told when the session ends;
 * - requests the server makes of the user (elicitation, sampling, roots) go to the CLI, if it
 *   supports them; changes to the server's lists, progress, logs and cancellation pass through;
 * - when the server can't be used (it needs a sign-in, it's down), the CLI still gets a working
 *   connection whose instructions say why, and the tools appear once it can be used.
 *
 * Usage: bridge <url> [name]. Headers set for the server come in OVERTIME_MCP_HEADERS (JSON).
 */
import { Server, type ServerCapabilities } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { isInitializeRequest, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { connectRemote, explainMcpError, sessionGone, type Remote } from "../mcp/remote.js";
import { signedIn } from "../runtime/mcp-auth.js";

const [url, name = "this server"] = process.argv.slice(2);
if (!url) {
  process.stderr.write("usage: bridge <url> [name]\n");
  process.exit(2);
}
const headers: Record<string, string> = process.env.OVERTIME_MCP_HEADERS ? JSON.parse(process.env.OVERTIME_MCP_HEADERS) : {};
delete process.env.OVERTIME_MCP_HEADERS;
const cfg = { name, url, headers };
const log = (s: string) => process.stderr.write(`overtime mcp bridge (${name}): ${s}\n`);
process.on("unhandledRejection", (e: any) => log(`unexpected: ${e?.message ?? e}`));

// The CLI's first message is its initialize: what it can do decides what Overtime offers the server.
const stdio = new StdioServerTransport();
const held: JSONRPCMessage[] = [];
const first = new Promise<JSONRPCMessage>((resolve) => {
  stdio.onmessage = (m) => {
    held.push(m);
    resolve(m);
  };
});
let shuttingDown = false;
stdio.onclose = () => void shutdown();
process.stdin.on("end", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await stdio.start();
const init = await first;
const cli = isInitializeRequest(init) ? init.params.capabilities : {};

let server: Server;
let remote: Remote | null = null;

const upstreamCaps = {
  ...(cli.elicitation ? { elicitation: cli.elicitation } : {}),
  ...(cli.sampling ? { sampling: cli.sampling } : {}),
  ...(cli.roots ? { roots: { listChanged: !!cli.roots.listChanged } } : {}),
};

async function connect(): Promise<Remote> {
  return connectRemote(cfg, {
    capabilities: upstreamCaps,
    listChanged: {
      tools: { autoRefresh: false, onChanged: () => void server?.sendToolListChanged().catch(() => {}) },
      prompts: { autoRefresh: false, onChanged: () => void server?.sendPromptListChanged().catch(() => {}) },
      resources: { autoRefresh: false, onChanged: () => void server?.sendResourceListChanged().catch(() => {}) },
    },
    setup: (c) => {
      // What the server asks of the user goes to the CLI.
      if (cli.elicitation) c.setRequestHandler("elicitation/create", (req) => server.elicitInput(req.params as any));
      if (cli.sampling) c.setRequestHandler("sampling/createMessage", (req) => server.createMessage(req.params as any));
      if (cli.roots) c.setRequestHandler("roots/list", (req) => server.listRoots(req.params));
      c.setNotificationHandler("notifications/resources/updated", (n) => void server?.sendResourceUpdated(n.params).catch(() => {}));
      c.setNotificationHandler("notifications/message", (n) => void server?.sendLoggingMessage(n.params).catch(() => {}));
    },
  });
}

/** Why the server can't be used right now, if it can't. */
let unavailable: { error: string; needsSignIn?: boolean } | null = null;
try {
  remote = await connect();
} catch (e) {
  unavailable = await explainMcpError(e, cfg);
  log(unavailable.error);
}

const signInHint = () => (unavailable?.needsSignIn ? " Ask the person to sign in to it in Overtime (your settings, under MCP servers)." : "");

/** A request to the server; a session it forgot is started again and the request sent once more. */
async function upstream<T>(call: (r: Remote) => Promise<T>): Promise<T> {
  if (!remote) throw new Error(`${name} can't be used right now: ${unavailable?.error ?? "not connected"}.${signInHint()}`);
  const r = remote;
  try {
    return await call(r);
  } catch (e) {
    if (sessionGone(e, r)) {
      log("the server ended the session; starting a new one");
      await r.close().catch(() => {});
      remote = await connect();
      return call(remote);
    }
    const why = await explainMcpError(e, cfg).catch(() => null);
    // A protocol error from the server itself (a tool's own error) passes through as it is.
    if (!why || why.error.startsWith(`${name}: `)) throw e;
    throw new Error(`${name}: ${why.error}.${why.needsSignIn ? " Ask the person to sign in to it in Overtime (your settings, under MCP servers)." : ""}`);
  }
}

// What the CLI is offered: the server's own capabilities, or, while it can't be used, tools that
// appear once it can.
const caps: ServerCapabilities = remote?.client.getServerCapabilities() ?? {};
const offered: ServerCapabilities = {
  ...(caps.tools || !remote ? { tools: { listChanged: true } } : {}),
  ...(caps.prompts ? { prompts: { listChanged: !!caps.prompts.listChanged } } : {}),
  ...(caps.resources ? { resources: { subscribe: !!caps.resources.subscribe, listChanged: !!caps.resources.listChanged } } : {}),
  ...(caps.completions ? { completions: {} } : {}),
  ...(caps.logging ? { logging: {} } : {}),
};
const instructions = remote ? remote.client.getInstructions() : `${name} can't be used right now: ${unavailable?.error}.${signInHint()}${unavailable?.needsSignIn ? " Its tools appear here once they have." : ""}`;
server = new Server({ name, version: remote?.client.getServerVersion()?.version ?? "1" }, { capabilities: offered, ...(instructions ? { instructions } : {}) });

/** Options for a forwarded request: its cancellation, and its progress passed back to the CLI. */
function opts(req: any, ctx: any): any {
  const token = req.params?._meta?.progressToken;
  return {
    signal: ctx?.mcpReq?.signal,
    ...(token !== undefined ? { onprogress: (p: any) => void server.notification({ method: "notifications/progress", params: { ...p, progressToken: token } }).catch(() => {}) } : {}),
  };
}
const fresh = (req: any, ctx: any): any => ({ ...opts(req, ctx), cacheMode: "bypass" });

server.setRequestHandler("tools/list", async (req, ctx) => (remote ? upstream((r) => r.client.listTools(req.params, fresh(req, ctx))) : { tools: [] }));
server.setRequestHandler("tools/call", (req, ctx) => upstream((r) => r.client.callTool(req.params, opts(req, ctx))) as any);
if (offered.prompts) {
  server.setRequestHandler("prompts/list", (req, ctx) => upstream((r) => r.client.listPrompts(req.params, fresh(req, ctx))));
  server.setRequestHandler("prompts/get", (req, ctx) => upstream((r) => r.client.getPrompt(req.params, opts(req, ctx))));
}
if (offered.resources) {
  server.setRequestHandler("resources/list", (req, ctx) => upstream((r) => r.client.listResources(req.params, fresh(req, ctx))));
  server.setRequestHandler("resources/templates/list", (req, ctx) => upstream((r) => r.client.listResourceTemplates(req.params, fresh(req, ctx))));
  server.setRequestHandler("resources/read", (req, ctx) => upstream((r) => r.client.readResource(req.params, fresh(req, ctx))));
  if (offered.resources.subscribe) {
    server.setRequestHandler("resources/subscribe", (req, ctx) => upstream((r) => r.client.subscribeResource(req.params, opts(req, ctx))));
    server.setRequestHandler("resources/unsubscribe", (req, ctx) => upstream((r) => r.client.unsubscribeResource(req.params, opts(req, ctx))));
  }
}
if (offered.completions) server.setRequestHandler("completion/complete", (req, ctx) => upstream((r) => r.client.complete(req.params, opts(req, ctx))));
if (offered.logging) server.setRequestHandler("logging/setLevel", (req, ctx) => upstream((r) => r.client.setLoggingLevel(req.params.level)));
if (cli.roots?.listChanged) server.setNotificationHandler("notifications/roots/list_changed", () => void remote?.client.sendRootsListChanged().catch(() => {}));

// The server takes over the CLI's connection, starting with the initialize it already sent.
const relay: Transport = {
  start: async () => {},
  send: (m) => stdio.send(m),
  close: () => shutdown(),
};
await server.connect(relay);
stdio.onmessage = (m) => relay.onmessage?.(m);
for (const m of held.splice(0)) relay.onmessage?.(m);

// Not usable yet: try again (once the person has signed in, when that's what it needs), and when it
// connects, its tools appear.
if (!remote) {
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks++;
    if (unavailable?.needsSignIn ? !(await signedIn(url).catch(() => false)) : ticks % 6 !== 0) return;
    try {
      remote = await connect();
      unavailable = null;
      clearInterval(timer);
      log("connected");
      await server.sendToolListChanged().catch(() => {});
    } catch (e) {
      unavailable = await explainMcpError(e, cfg);
    }
  }, 5_000);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await remote?.close().catch(() => {});
  process.exit(0);
}
