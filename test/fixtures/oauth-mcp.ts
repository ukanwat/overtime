// An MCP server that requires signing in, the standard way (the MCP authorization spec): protected-
// resource and authorization-server metadata, dynamic client registration, PKCE, refresh tokens.
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function startOAuthMcp(): Promise<{ url: string; server: Server; issued: string[]; expireAll: () => void; close: () => void }> {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { challenge: string; client: string }>();
  const valid = new Set<string>();
  const refresh = new Map<string, string>();
  const issued: string[] = [];
  let base = "";
  const body = (req: any) => new Promise<string>((r) => { let b = ""; req.on("data", (c: any) => (b += c)); req.on("end", () => r(b)); });
  const json = (res: any, code: number, v: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
  const token = () => {
    const t = "tok_" + randomBytes(6).toString("hex");
    valid.add(t);
    issued.push(t);
    const r = "ref_" + randomBytes(6).toString("hex");
    refresh.set(r, t);
    return { access_token: t, token_type: "Bearer", expires_in: 3600, refresh_token: r };
  };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", base);
    if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (u.pathname === "/register" && req.method === "POST") {
      const meta = JSON.parse(await body(req));
      const id = "client_" + randomBytes(4).toString("hex");
      clients.set(id, meta.redirect_uris);
      return json(res, 201, { ...meta, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (u.pathname === "/authorize") {
      const client = u.searchParams.get("client_id")!;
      const redirect = u.searchParams.get("redirect_uri")!;
      if (!clients.get(client)?.includes(redirect)) return json(res, 400, { error: "invalid_request" });
      const code = "code_" + randomBytes(4).toString("hex");
      codes.set(code, { challenge: u.searchParams.get("code_challenge")!, client });
      const to = new URL(redirect);
      to.searchParams.set("code", code);
      to.searchParams.set("state", u.searchParams.get("state") ?? "");
      return res.writeHead(302, { location: to.href }).end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await body(req));
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        const s256 = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== s256) return json(res, 400, { error: "invalid_grant" });
        codes.delete(f.get("code")!);
        return json(res, 200, token());
      }
      if (f.get("grant_type") === "refresh_token") {
        const old = refresh.get(f.get("refresh_token") ?? "");
        if (!old) return json(res, 400, { error: "invalid_grant" });
        refresh.delete(f.get("refresh_token")!);
        valid.delete(old);
        return json(res, 200, token());
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (u.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !valid.has(auth.slice(7)))
        return res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
      const s = new McpServer({ name: "oauth-mcp", version: "1" });
      s.registerTool("whoami", { description: "who you are" }, async () => ({ content: [{ type: "text", text: "signed in" }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await s.connect(t);
      const raw = req.method === "POST" ? JSON.parse(await body(req)) : undefined;
      return t.handleRequest(req, res, raw);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { url: `${base}/mcp`, server, issued, expireAll: () => valid.clear(), close: () => server.close() };
}
