import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerConfig } from "../settings.js";
import type { ToolContext, ToolHost } from "./host.js";
import { registerTools } from "./tools.js";

/**
 * Overtime's own tools, served over MCP (Streamable HTTP) on localhost.
 * Every session gets a URL with its own token, so a call always knows which agent and session made it.
 */
export class ToolServer {
  private server: Server | null = null;
  private port = 0;
  private contexts = new Map<string, ToolContext>();

  constructor(private readonly host: ToolHost) {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const m = /^\/mcp\/([a-f0-9]{32})\/?$/.exec(req.url ?? "");
      const ctx = m ? this.contexts.get(m[1]) : undefined;
      if (!ctx) {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        // Stateless server: no server-initiated streams.
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      try {
        const body = await readBody(req);
        const mcp = new McpServer({ name: "overtime", version: "0.2.1" });
        registerTools(mcp, ctx, this.host);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e?.message ?? e) }, id: null }));
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as any).port;
  }

  /** Register a live session and get the MCP server entry to pass in ACP session/new. */
  open(ctx: Omit<ToolContext, "token" | "wakeChosen">): { ctx: ToolContext; mcp: McpServerConfig } {
    const token = randomBytes(16).toString("hex");
    const full: ToolContext = { ...ctx, token, wakeChosen: false };
    this.contexts.set(token, full);
    return { ctx: full, mcp: { name: "overtime", url: `http://127.0.0.1:${this.port}/mcp/${token}` } };
  }

  close(token: string): void {
    this.contexts.delete(token);
  }

  async stop(): Promise<void> {
    this.contexts.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
