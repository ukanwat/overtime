import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig } from "../settings.js";

/**
 * Managing MCP servers from the app: reading what the person typed, checking a server works, and
 * showing servers without their secrets.
 */

/** Split a command line into words, keeping quoted parts together. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** A name from what the server is: "@modelcontextprotocol/server-github" -> "github", "mcp.linear.app" -> "linear". */
export function guessName(cfg: McpServerConfig): string {
  let base = "";
  if (cfg.url) {
    try {
      const host = new URL(cfg.url).hostname.split(".").filter((p) => !/^(www|mcp|api|com|app|io|dev|net|org|ai)$/.test(p));
      base = host[0] ?? "";
    } catch {}
  } else {
    const pkg = [...(cfg.args ?? [])].reverse().find((a) => !a.startsWith("-")) ?? cfg.command ?? "";
    base = pkg.split("/").pop()!.replace(/@[\d.]+$/, "").replace(/^(mcp-server-|server-|mcp-)/, "").replace(/(-mcp|-server|\.js|\.py)$/, "");
  }
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "server";
}

/**
 * What the person typed, as a server: a URL (optionally followed by "Header: value" pairs, separated
 * by ";"), or a command line (optionally starting with KEY=value environment variables).
 */
export function parseServerInput(input: string, name?: string): McpServerConfig {
  const text = input.trim();
  if (!text) throw new Error("Type the command that starts the server, or its URL.");
  const url = /^(https?:\/\/\S+)(.*)$/i.exec(text);
  if (url) {
    const headers: Record<string, string> = {};
    for (const part of url[2].split(";")) {
      const h = /^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(part);
      if (h) headers[h[1]] = h[2];
    }
    const cfg: McpServerConfig = { name: "", url: url[1], ...(Object.keys(headers).length ? { headers } : {}) };
    cfg.name = name?.trim() || guessName(cfg);
    return cfg;
  }
  const w = words(text);
  const env: Record<string, string> = {};
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
    const [k, ...v] = w.shift()!.split("=");
    env[k] = v.join("=");
  }
  if (!w.length) throw new Error("There's no command after the environment variables.");
  const cfg: McpServerConfig = { name: "", command: w[0], args: w.slice(1), ...(Object.keys(env).length ? { env } : {}) };
  cfg.name = name?.trim() || guessName(cfg);
  return cfg;
}

/** A name the person can use: short, plain, not Overtime's own. */
export function checkName(name: string, taken: string[]): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) return "Use lowercase letters, digits, - or _ (up to 32), e.g. github.";
  if (name === "overtime") return '"overtime" is Overtime\'s own server. Pick another name.';
  if (taken.includes(name)) return `There's already a server called ${name}.`;
  return null;
}

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
