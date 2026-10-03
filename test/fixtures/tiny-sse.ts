// A tiny MCP server for tests on the older SSE transport (as many existing servers still are): one tool.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
const transports = new Map<string, SSEServerTransport>();
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/sse") {
    const s = new McpServer({ name: "tiny-sse", version: "1" });
    s.registerTool("ping", { description: "replies pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const t = new SSEServerTransport("/messages", res);
    transports.set(t.sessionId, t);
    await s.connect(t);
    return;
  }
  if (req.method === "POST" && url.pathname === "/messages") {
    const t = transports.get(url.searchParams.get("sessionId") ?? "");
    if (t) return void t.handlePostMessage(req, res);
  }
  res.writeHead(404).end("not found");
});
http.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`http://127.0.0.1:${(http.address() as any).port}/sse`));
