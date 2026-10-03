import type { McpServerConfig } from "../settings.js";
import { connectRemote, explainMcpError, type Remote } from "../mcp/remote.js";

/** MCP servers in the app: checking a server works, and showing one without its secrets. */

/** The server as one line, with secrets hidden: "npx -y @scope/server", "https://mcp.example.com/mcp". */
export function describeServer(cfg: McpServerConfig): string {
  const secret = (o?: Record<string, string>) => (o && Object.keys(o).length ? ` (${Object.keys(o).join(", ")} set)` : "");
  return cfg.url ? `${cfg.url}${secret(cfg.headers)}` : `${[cfg.command, ...(cfg.args ?? [])].join(" ")}${secret(cfg.env)}`;
}

/**
 * Connect to the server the way an agent's connection does (src/mcp/remote.ts: the same protocol
 * negotiation, transports and sign-in) and list its tools, to show it works. Never throws.
 */
export async function checkServer(cfg: McpServerConfig, timeoutMs = 25_000): Promise<{ ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean }> {
  let remote: Remote | null = null;
  let timer: NodeJS.Timeout | undefined;
  let over = false;
  const run = async () => {
    remote = await connectRemote(cfg);
    if (over) await remote.close().catch(() => {}); // it answered after the check gave up
    const tools: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await remote.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...r.tools.map((t) => t.name));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  };
  try {
    const tools = await Promise.race([run(), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)))]);
    return { ok: true, tools };
  } catch (e: any) {
    return { ok: false, tools: [], ...(await explainMcpError(e, cfg)) };
  } finally {
    over = true;
    clearTimeout(timer);
    await (remote as Remote | null)?.close().catch(() => {});
  }
}
