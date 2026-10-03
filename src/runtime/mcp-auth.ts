import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { home } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";

/**
 * Signing in to MCP servers that need it, the standard way: the MCP authorization spec (OAuth 2.1 with
 * PKCE, discovery and dynamic client registration), as the MCP SDK implements it. Overtime is the
 * client: you sign in once in your browser, and the login is kept per server URL (so every agent with
 * that server uses it). Agents reach URL servers through Overtime's own connection (tools/bridge.ts),
 * which uses this login and renews it when the server asks, whichever backend the agent runs on.
 */

interface Saved {
  url: string;
  /** The loopback port registered as the redirect address; kept so the registration stays valid. */
  port?: number;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the tokens were saved (ms). */
  savedAt?: number;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
}

const dir = () => join(home(), "mcp-auth");
const fileFor = (url: string) => join(dir(), `${createHash("sha256").update(url).digest("hex").slice(0, 24)}.json`);

async function load(url: string): Promise<Saved> {
  return readJson<Saved>(fileFor(url), { url });
}

async function save(s: Saved): Promise<void> {
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  await writeJson(fileFor(s.url), s);
  await chmod(fileFor(s.url), 0o600).catch(() => {});
}

/** The SDK's view of one server's saved sign-in. `interactive` says what to do when it needs a browser. */
class Provider implements OAuthClientProvider {
  /** Set when the flow needs the person in a browser: where to send them. */
  authorizationUrl: URL | null = null;
  private stateValue = randomBytes(16).toString("hex");

  constructor(
    private s: Saved,
    private readonly port: number | undefined,
  ) {}

  get redirectUrl(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/callback` : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Overtime",
      redirect_uris: this.port ? [`http://127.0.0.1:${this.port}/callback`] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation() {
    return this.s.client;
  }

  async saveClientInformation(c: OAuthClientInformationMixed) {
    this.s.client = c;
    await save(this.s);
  }

  /** From disk each time: another connection to the same server may have renewed it meanwhile. */
  async tokens() {
    this.s = { ...this.s, ...(await load(this.s.url)) };
    return this.s.tokens;
  }

  async saveTokens(t: OAuthTokens) {
    this.s.tokens = t;
    this.s.savedAt = Date.now();
    await save(this.s);
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(v: string) {
    this.s.verifier = v;
    await save(this.s);
  }

  codeVerifier() {
    if (!this.s.verifier) throw new Error("No sign-in is in progress for this server.");
    return this.s.verifier;
  }

  discoveryState() {
    return this.s.discovery;
  }

  async saveDiscoveryState(d: OAuthDiscoveryState) {
    this.s.discovery = d;
    await save(this.s);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.s.client;
    if (scope === "all" || scope === "tokens") delete this.s.tokens;
    if (scope === "all" || scope === "verifier") delete this.s.verifier;
    if (scope === "all" || scope === "discovery") delete this.s.discovery;
    await save(this.s);
  }
}

/**
 * For a connection to a server you signed in to: the sign-in, kept current the standard way (when the
 * server refuses the token, it's renewed with the refresh token). Undefined when there's no sign-in.
 * It never opens a browser: a sign-in that can't be renewed is reported as needing the person.
 */
export async function connectionAuth(url: string): Promise<OAuthClientProvider | undefined> {
  const s = await load(url);
  if (!s.tokens?.access_token) return undefined;
  return new Provider(s, s.port);
}

/** Whether there's a saved sign-in for this server. */
export async function signedIn(url: string): Promise<boolean> {
  return !!(await load(url)).tokens?.access_token;
}

/** Forget the sign-in for this server (and the client registration that came with it). */
export async function signOut(url: string): Promise<void> {
  await rm(fileFor(url), { force: true });
}

function freePort(prefer?: number): Promise<{ server: Server; port: number }> {
  const listen = (port: number) =>
    new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve({ server, port: (server.address() as any).port }));
    });
  return prefer ? listen(prefer).catch(() => listen(0)) : listen(0);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [url], () => {});
}

const pending = new Map<string, Promise<void>>();

/**
 * Start signing in to a server: opens the person's browser at the server's sign-in page and returns
 * that address (to show in case the browser didn't open). `done` settles when they've signed in (or
 * after 10 minutes, or if the server refuses).
 */
export async function beginSignIn(url: string, open = openBrowser): Promise<{ authorizationUrl: string | null; done: Promise<void> }> {
  if (pending.has(url)) throw new Error("A sign-in to this server is already waiting for you in your browser.");
  const s = await load(url);
  const { server, port } = await freePort(s.port);
  // A different port than the one registered means a different redirect address: register again.
  if (s.port !== port) {
    delete s.client;
    s.port = port;
    await save(s);
  }
  const p = new Provider(s, port);
  let result: "AUTHORIZED" | "REDIRECT";
  try {
    result = await auth(p, { serverUrl: url });
  } catch (e) {
    server.close();
    throw e;
  }
  if (result === "AUTHORIZED" || !p.authorizationUrl) {
    server.close();
    return { authorizationUrl: null, done: Promise.resolve() };
  }
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The sign-in wasn't finished within 10 minutes.")), 10 * 60_000);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      server.close();
      pending.delete(url);
      err ? reject(err) : resolve();
    };
    server.on("request", async (req, res) => {
      const q = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (q.pathname !== "/callback") return void res.writeHead(404).end();
      const page = (title: string, body: string) =>
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4em auto;max-width:32em"><h2>${title}</h2><p>${body}</p></body>`);
      if (q.searchParams.get("state") !== p.state()) return page("Sign-in didn't match", "This page doesn't belong to the sign-in Overtime started. Start it again from Overtime.");
      const err = q.searchParams.get("error");
      if (err) {
        page("Not signed in", "The server didn't sign you in. You can close this tab and try again from Overtime.");
        return finish(new Error(`The server didn't sign you in (${err}).`));
      }
      const code = q.searchParams.get("code");
      if (!code) return page("Not signed in", "The server didn't send a sign-in code. Try again from Overtime.");
      try {
        await auth(p, { serverUrl: url, authorizationCode: code });
        page("Signed in", "Overtime is signed in. You can close this tab.");
        finish();
      } catch (e: any) {
        page("Not signed in", "Overtime couldn't finish signing in. Try again from Overtime.");
        finish(new Error(`Couldn't finish signing in: ${e?.message ?? e}`));
      }
    });
  });
  pending.set(url, done);
  done.catch(() => {});
  open(p.authorizationUrl.href);
  return { authorizationUrl: p.authorizationUrl.href, done };
}
