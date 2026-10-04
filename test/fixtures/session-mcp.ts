// A server on the earlier spec with sessions (Mcp-Session-Id), which can be made to forget them, and
// which records the requests that end them (DELETE).
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function startSessionMcp(): Promise<{ url: string; server: Server; deletes: string[]; forget: () => void; sessions: () => number; close: () => void }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const deletes: string[] = [];
  const server = createServer(async (req, res) => {
    const id = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "DELETE" && id) deletes.push(id);
    let body: any;
    if (req.method === "POST") {
      let b = "";
      for await (const c of req) b += c;
      body = JSON.parse(b);
    }
    let t = id ? transports.get(id) : undefined;
    if (!t) {
      if (id) return void res.writeHead(404).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void transports.set(sid, t!) });
      const s = new McpServer({ name: "sessions", version: "1" });
      s.registerTool("echo", { description: "says hello" }, async () => ({ content: [{ type: "text", text: "hello" }] }));
      await s.connect(t);
    }
    await t.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    server,
    deletes,
    forget: () => transports.clear(),
    sessions: () => transports.size,
    close: () => server.close(),
  };
}
