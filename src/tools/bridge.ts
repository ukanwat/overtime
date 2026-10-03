#!/usr/bin/env node
/**
 * Overtime's connection to an MCP server you added by URL (and, for backends that can't reach HTTP
 * servers, to Overtime's own tools). The backend starts it as a local command and speaks MCP on stdio;
 * it forwards every message to the server and back, unchanged. Overtime owns the connection, so every
 * backend gets the same thing:
 * - the transport the MCP spec describes: Streamable HTTP, falling back to the older HTTP+SSE transport
 *   when the server answers the first request with 400, 404 or 405;
 * - Overtime's sign-in to the server (see runtime/mcp-auth.ts), renewed when the server asks;
 * - a clear error for the agent, rather than a dead connection, when the server can't be used.
 *
 * Usage: bridge <url> [name]. Headers you set for the server come in OVERTIME_MCP_HEADERS (JSON).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { connectionAuth } from "../runtime/mcp-auth.js";

const [url, name = "this server"] = process.argv.slice(2);
if (!url) {
  process.stderr.write("usage: bridge <url> [name]\n");
  process.exit(2);
}
const headers: Record<string, string> = process.env.OVERTIME_MCP_HEADERS ? JSON.parse(process.env.OVERTIME_MCP_HEADERS) : {};
delete process.env.OVERTIME_MCP_HEADERS;
const ownAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
const authProvider = ownAuth ? undefined : await connectionAuth(url);
const init = { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) };

const local = new StdioServerTransport();
let remote: Transport = new StreamableHTTPClientTransport(new URL(url), init);
let first = true;

const wire = (t: Transport) => {
  t.onmessage = (m) => void local.send(m).catch(() => process.exit(1));
  t.onerror = (e) => process.stderr.write(`overtime mcp bridge: ${e.message}\n`);
};

/** Why the server can't be used, in words the agent can pass on. */
function why(e: any): string {
  const status = e instanceof UnauthorizedError ? 401 : e instanceof StreamableHTTPError ? e.code : undefined;
  if (status === 401) return `${name} needs the person to sign in. Ask them to sign in to it in Overtime (your settings, under MCP servers), then try again.`;
  if (status === 403) return `${name} refused access (HTTP 403): the account doesn't have permission for this.`;
  return `Can't reach ${name}: ${String(e?.message ?? e)}`;
}

async function forward(m: JSONRPCMessage): Promise<void> {
  try {
    await remote.send(m);
  } catch (e: any) {
    // The spec's way to find an older server: the first request is refused with 400, 404 or 405.
    if (first && e instanceof StreamableHTTPError && [400, 404, 405].includes(e.code ?? 0)) {
      first = false;
      await remote.close().catch(() => {});
      remote = new SSEClientTransport(new URL(url), init);
      wire(remote);
      await remote.start();
      return forward(m);
    }
    // A request gets an answer the agent can read; a notification has nobody to answer.
    if ("id" in m && "method" in m) await local.send({ jsonrpc: "2.0", id: m.id, error: { code: -32001, message: why(e) } });
    else process.stderr.write(`overtime mcp bridge: ${why(e)}\n`);
  } finally {
    first = false;
  }
}

wire(remote);
local.onmessage = (m) => void forward(m);
local.onclose = () => void remote.close().finally(() => process.exit(0));
await remote.start();
await local.start();
