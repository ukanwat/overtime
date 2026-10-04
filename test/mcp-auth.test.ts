import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { fakeHome, here } from "./helpers.js";
import { startOAuthMcp } from "./fixtures/oauth-mcp.js";

fakeHome();
const { checkServer } = await import("../src/daemon/mcp-admin.js");
const { beginSignIn, connectionAuth, signedIn, signOut } = await import("../src/runtime/mcp-auth.js");
const { toAcpMcp } = await import("../src/acp/session.js");
const srv = await startOAuthMcp();
let waiting: Client | null = null;
afterAll(() => srv.close());

/** What the person's browser does: follow the server's sign-in page back to Overtime. */
async function browser(url: string) {
  const r = await fetch(url, { redirect: "manual" });
  await fetch(r.headers.get("location")!);
}

/** Connect to a server the way an agent's backend does: through the command Overtime gives it. */
async function asBackend(cfg: { name: string; url: string; headers?: Record<string, string> }) {
  const [s] = toAcpMcp([cfg], true) as any[];
  const client = new Client({ name: "backend", version: "1" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...(process.env as Record<string, string>), ...Object.fromEntries(s.env.map((e: any) => [e.name, e.value])) }, stderr: "pipe" }));
  return client;
}

describe("signing in to an MCP server, the standard way, for every backend", () => {
  it("a server that needs it says so, to you and to the agent", async () => {
    expect(await checkServer({ name: "secure", url: srv.url }, 10_000)).toMatchObject({ ok: false, needsSignIn: true });
    // The agent's CLI still gets a working connection, which says why there's nothing in it yet.
    const c = await asBackend({ name: "secure", url: srv.url });
    expect(c.getInstructions()).toMatch(/needs you to sign in.*Ask the person to sign in to it in Overtime/);
    expect((await c.listTools()).tools).toEqual([]);
    const call = await c.callTool({ name: "whoami" }).catch((e) => e);
    expect(String(call?.message ?? JSON.stringify(call))).toMatch(/sign in/);
    waiting = c;
  });

  it("signs in through the browser; the agent's connection then works, on Overtime's login", async () => {
    const changed = new Promise<void>((r) => waiting!.setNotificationHandler(ToolListChangedNotificationSchema, () => r()));
    const { authorizationUrl, done } = await beginSignIn(srv.url, (u) => void browser(u));
    expect(authorizationUrl).toContain("/authorize");
    await done;
    // A connection that was already open picks up the sign-in by itself, and its tools appear.
    await changed;
    expect((await waiting!.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]);
    await waiting!.close();
    expect(await signedIn(srv.url)).toBe(true);
    expect(await checkServer({ name: "secure", url: srv.url }, 10_000)).toMatchObject({ ok: true, tools: ["whoami"] });
    const c = await asBackend({ name: "secure", url: srv.url });
    expect(((await c.callTool({ name: "whoami" })) as any).content[0].text).toBe("signed in");
    await c.close();
  });

  it("renews the login when the server stops accepting it", async () => {
    srv.expireAll();
    const before = srv.issued.length;
    const c = await asBackend({ name: "secure", url: srv.url });
    expect(((await c.callTool({ name: "whoami" })) as any).content[0].text).toBe("signed in");
    await c.close();
    expect(srv.issued.length).toBe(before + 1);
  });

  it("keeps headers out of the command line, and a token you set yourself wins", async () => {
    const [s] = toAcpMcp([{ name: "x", url: srv.url, headers: { Authorization: "Bearer mine" } }], true) as any[];
    expect(s.args.join(" ")).not.toContain("mine");
    expect(s.env).toEqual([{ name: "OVERTIME_MCP_HEADERS", value: JSON.stringify({ Authorization: "Bearer mine" }) }]);
    const c = await asBackend({ name: "x", url: srv.url, headers: { Authorization: "Bearer mine" } });
    expect(c.getInstructions()).toMatch(/sign in/); // "mine" isn't valid there, and Overtime's login isn't swapped in
    await c.close();
  });

  it("signing out forgets the login", async () => {
    await signOut(srv.url);
    expect(await signedIn(srv.url)).toBe(false);
    expect(await connectionAuth(srv.url)).toBeUndefined();
  });
});

describe("older MCP servers (HTTP+SSE)", () => {
  it("are reached through the spec's fallback, by the check and by the agent's connection", async () => {
    const { spawn } = await import("node:child_process");
    const p = spawn(join(here, "..", "node_modules", ".bin", "tsx"), [join(here, "fixtures", "tiny-sse.ts")]);
    const url = await new Promise<string>((r) => p.stdout.once("data", (d) => r(String(d).trim())));
    try {
      expect(await checkServer({ name: "old", url }, 10_000)).toMatchObject({ ok: true, tools: ["ping"] });
      const c = await asBackend({ name: "old", url });
      expect(((await c.callTool({ name: "ping" })) as any).content[0].text).toBe("pong");
      await c.close();
    } finally {
      p.kill();
    }
  });
});
