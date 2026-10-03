#!/usr/bin/env node
/**
 * stdio ⇄ HTTP MCP bridge. Some ACP backends only start MCP servers as local commands (stdio); Overtime's
 * tools, and any MCP server you configured by URL, speak HTTP. Overtime gives such backends this bridge
 * as the command: it forwards every message between the backend (on stdio) and the HTTP server, unchanged.
 *
 * Usage: bridge <url> [headers-json]
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, headersJson] = process.argv.slice(2);
if (!url) {
  process.stderr.write("usage: bridge <url> [headers-json]\n");
  process.exit(2);
}
const headers: Record<string, string> = headersJson ? JSON.parse(headersJson) : {};

const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });

const fail = (why: string) => {
  process.stderr.write(`overtime mcp bridge: ${why}\n`);
  process.exit(1);
};

remote.onmessage = (m) => void local.send(m).catch((e) => fail(String(e?.message ?? e)));
local.onmessage = (m) => void remote.send(m).catch((e) => fail(`can't reach ${url}: ${String(e?.message ?? e)}`));
remote.onerror = (e) => process.stderr.write(`overtime mcp bridge: ${e.message}\n`);
local.onclose = () => void remote.close().finally(() => process.exit(0));

await remote.start();
await local.start();
