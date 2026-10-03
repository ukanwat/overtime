// A tiny MCP server for tests: one tool, on stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const s = new McpServer({ name: "tiny", version: "1" });
s.registerTool("ping", { description: "replies pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
await s.connect(new StdioServerTransport());
