// A server that speaks only the current MCP spec (2026-07-28): no initialize, no sessions.
import { createServer, type Server } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

export async function startModernMcp(): Promise<{ url: string; server: Server; close: () => void }> {
  const handler = createMcpHandler(
    () => {
      const s = new McpServer({ name: "modern", version: "1" });
      s.registerTool("now", { description: "says modern" }, async () => ({ content: [{ type: "text", text: "modern" }] }));
      return s;
    },
    { legacy: "reject" },
  );
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await handler.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body as any) res.write(c);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, server, close: () => server.close() };
}
