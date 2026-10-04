import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerConfig } from "../settings.js";

/** MCP servers in the app: checking a server works, and showing one without its secrets. */

/** The server as one line, with secrets hidden: "npx -y @scope/server", "https://mcp.example.com/mcp". */
export function describeServer(cfg: McpServerConfig): string {
  const secret = (o?: Record<string, string>) => (o && Object.keys(o).length ? ` (${Object.keys(o).join(", ")} set)` : "");
  return cfg.url ? `${cfg.url}${secret(cfg.headers)}` : `${[cfg.command, ...(cfg.args ?? [])].join(" ")}${secret(cfg.env)}`;
}

/** Start the server (or reach it) and list its tools, to show it works. Never throws. */
export async function checkServer(cfg: McpServerConfig, timeoutMs = 25_000): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const clients: Client[] = [];
  // Each attempt gets its own client: one that failed to connect isn't reused.
  const attempt = async (transport: any) => {
    const client = new Client({ name: "overtime-check", version: "1" });
    clients.push(client);
    await client.connect(transport);
    const r = await client.listTools();
    return r.tools.map((t) => t.name);
  };
  const run = async (): Promise<string[]> => {
    if (cfg.url) {
      const init = { requestInit: { headers: cfg.headers ?? {} } };
      try {
        return await attempt(new StreamableHTTPClientTransport(new URL(cfg.url), init));
      } catch (e) {
        // Older servers speak the earlier SSE transport.
        try {
          return await attempt(new SSEClientTransport(new URL(cfg.url), init));
        } catch {
          throw e;
        }
      }
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    return attempt(new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [], env: { ...env, ...(cfg.env ?? {}) }, stderr: "pipe" }));
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const tools = await Promise.race([
      run(),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs))),
    ]);
    return { ok: true, tools };
  } catch (e: any) {
    // The system's own error codes, not the wording of messages.
    if (e?.code === "ENOENT") return { ok: false, tools: [], error: `${cfg.command} isn't installed or isn't on your PATH` };
    if (e?.code === "ECONNREFUSED" || e?.cause?.code === "ECONNREFUSED") return { ok: false, tools: [], error: "nothing is listening at that address" };
    // HTTP servers: the status the server answered with, from the client's error code.
    const status = e instanceof UnauthorizedError ? 401 : e instanceof StreamableHTTPError || e instanceof SseError ? e.code : undefined;
    if (status === 401 || status === 403) return { ok: false, tools: [], error: `the server wants a sign-in (HTTP ${status}): put its token in the server's headers, e.g. "Authorization": "Bearer …"` };
    if (status === 404) return { ok: false, tools: [], error: "the server says there's nothing at that URL (HTTP 404): check the address" };
    if (typeof status === "number" && status >= 500) return { ok: false, tools: [], error: `the server had an error (HTTP ${status}); try again later` };
    return { ok: false, tools: [], error: String(e?.message ?? e).split("\n")[0].slice(0, 300) };
  } finally {
    clearTimeout(timer);
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}
