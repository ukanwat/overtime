import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeHome, until } from "./helpers.js";
import { startOAuthMcp } from "./fixtures/oauth-mcp.js";
import { startModernMcp } from "./fixtures/modern-mcp.js";
import { startSessionMcp } from "./fixtures/session-mcp.js";

fakeHome();
const { checkServer } = await import("../src/daemon/mcp-admin.js");
const { beginSignIn, signedIn, signOut } = await import("../src/runtime/mcp-auth.js");
const { toAcpMcp } = await import("../src/acp/session.js");
const { connectRemote } = await import("../src/mcp/remote.js");
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function browser(url: string) {
  const r = await fetch(url, { redirect: "manual" });
  await fetch(r.headers.get("location")!);
}

/** An agent's CLI (speaking the earlier, initialize-based protocol) connecting through Overtime's connection. */
async function asBackend(cfg: { name: string; url: string; headers?: Record<string, string> }) {
  const [s] = toAcpMcp([cfg], true) as any[];
  const client = new Client({ name: "cli", version: "1" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...(process.env as Record<string, string>), ...Object.fromEntries(s.env.map((e: any) => [e.name, e.value])) }, stderr: process.env.BRIDGE_LOG ? "inherit" : "pipe" }));
  return client;
}

describe("MCP versions", () => {
  it("a server on the current spec only (2026-07-28) works for a CLI on the earlier one", async () => {
    const srv = await startModernMcp();
    closers.push(srv.close);
    expect(await checkServer({ name: "modern", url: srv.url }, 10_000)).toMatchObject({ ok: true, tools: ["now"] });
    const r = await connectRemote({ name: "modern", url: srv.url });
    expect(r.client.getProtocolEra()).toBe("modern");
    await r.close();
    const c = await asBackend({ name: "modern", url: srv.url });
    expect(((await c.callTool({ name: "now" })) as any).content[0].text).toBe("modern");
    await c.close();
  });
});

describe("sessions (earlier spec)", () => {
  it("a session the server forgot is started again, and the server is told when one ends", async () => {
    const srv = await startSessionMcp();
    closers.push(srv.close);
    const r = await connectRemote({ name: "s", url: srv.url });
    expect(r.client.getProtocolEra()).toBe("legacy");
    await r.close();
    const c = await asBackend({ name: "s", url: srv.url });
    expect(((await c.callTool({ name: "echo" })) as any).content[0].text).toBe("hello");
    srv.forget(); // e.g. the server restarted
    expect(((await c.callTool({ name: "echo" })) as any).content[0].text).toBe("hello");
    const before = srv.deletes.length;
    await c.close();
    await until(async () => srv.deletes.length > before, 10_000, "DELETE when the session ends");
    // The status check ends its session too.
    const n = srv.deletes.length;
    expect(await checkServer({ name: "s", url: srv.url }, 10_000)).toMatchObject({ ok: true });
    expect(srv.deletes.length).toBe(n + 1);
  });
});

describe("sign-in, as the spec asks of a client", () => {
  it("rejects a sign-in response from another issuer (RFC 9207), and uses nothing in it", async () => {
    const srv = await startOAuthMcp({ iss: "wrong" });
    closers.push(srv.close);
    const { done } = await beginSignIn(srv.url, (u) => void browser(u));
    await expect(done).rejects.toThrow(/didn't come from the server's own sign-in service/);
    expect(await signedIn(srv.url)).toBe(false);
  });

  it("accepts the right issuer", async () => {
    const srv = await startOAuthMcp({ iss: "right" });
    closers.push(srv.close);
    const { done } = await beginSignIn(srv.url, (u) => void browser(u));
    await done;
    expect(await signedIn(srv.url)).toBe(true);
    await signOut(srv.url);
  });

  it("refuses a sign-in service without PKCE", async () => {
    const srv = await startOAuthMcp({ pkce: false });
    closers.push(srv.close);
    await expect(beginSignIn(srv.url, () => {})).rejects.toThrow(/PKCE/);
  });

  it("registers as a native app, and keeps the server's own headers away from its sign-in service", async () => {
    const srv = await startOAuthMcp();
    closers.push(srv.close);
    await (await beginSignIn(srv.url, (u) => void browser(u))).done;
    const reg = srv.seen.find((x) => x.path === "/register");
    expect(reg).toBeTruthy();
    srv.expireAll(); // the next request renews the login, through the connection
    const c = await asBackend({ name: "k", url: srv.url, headers: { "X-Api-Key": "secret-k" } });
    expect(((await c.callTool({ name: "whoami" })) as any).content[0].text).toBe("signed in");
    await c.close();
    expect(srv.seen.filter((x) => x.path === "/mcp").some((x) => x.headers["x-api-key"] === "secret-k")).toBe(true);
    expect(srv.seen.filter((x) => x.path !== "/mcp").every((x) => x.headers["x-api-key"] === undefined)).toBe(true);
    await signOut(srv.url);
  });

  it("two agents renewing the same login at once both carry on, and the login survives", async () => {
    const srv = await startOAuthMcp();
    closers.push(srv.close);
    await (await beginSignIn(srv.url, (u) => void browser(u))).done;
    const agents = await Promise.all(["a", "b", "c"].map((n) => asBackend({ name: n, url: srv.url })));
    for (let round = 0; round < 3; round++) {
      srv.expireAll();
      // Every agent at once, two requests each.
      const results = await Promise.all(agents.flatMap((c) => [c.callTool({ name: "whoami" }), c.callTool({ name: "whoami" })]));
      expect(results.map((r: any) => r.content[0].text)).toEqual(Array(6).fill("signed in"));
      expect(await signedIn(srv.url)).toBe(true);
    }
    await Promise.all(agents.map((c) => c.close()));
  });

  it("a server asking for more access (step-up): the agent is told, and the next sign-in asks for it", async () => {
    const srv = await startOAuthMcp({ needScope: "files:write" });
    closers.push(srv.close);
    await (await beginSignIn(srv.url, (u) => void browser(u))).done;
    const st = await checkServer({ name: "scoped", url: srv.url }, 10_000);
    expect(st).toMatchObject({ ok: false, needsSignIn: true });
    expect(st.error).toMatch(/sign in again.*files:write/);
    // Signing in again asks for the union of what it had and what the server asked for.
    const { authorizationUrl, done } = await beginSignIn(srv.url, (u) => void browser(u));
    expect(new URL(authorizationUrl!).searchParams.get("scope")).toContain("files:write");
    await done;
    expect(await checkServer({ name: "scoped", url: srv.url }, 10_000)).toMatchObject({ ok: true, tools: ["whoami"] });
  });
});
