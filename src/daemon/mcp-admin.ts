import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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
    return { ok: false, tools: [], error: String(e?.message ?? e).split("\n")[0].slice(0, 300) };
  } finally {
    clearTimeout(timer);
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}
