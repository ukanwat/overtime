import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import {
  auth,
  computeScopeUnion,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  UnauthorizedError,
  validateAuthorizationResponseIssuer,
  type AuthProvider,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { home } from "../paths.js";

/**
 * Signing in to MCP servers that need it, as the MCP authorization spec describes (OAuth 2.1:
 * protected-resource and authorization-server discovery, PKCE, resource indicators, RFC 9207 issuer
 * checks, step-up of scopes), using the MCP SDK's implementation and adding the checks the spec asks of
 * a client that the SDK leaves to it. Overtime is the client: the person signs in once in their
 * browser, and the login is kept per server URL, so every agent with that server uses it. Agents reach
 * URL servers through Overtime's own connection (see tools/bridge.ts), which uses the login and renews
 * it when the server asks, whichever coding CLI the agent runs on.
 */

interface Saved {
  url: string;
  /** The loopback port registered as the redirect address; kept so the registration stays valid. */
  port?: number;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  savedAt?: number;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  /** Scopes the server asked for beyond the current grant: requested at the next sign-in (step-up). */
  requestedScope?: string;
}

const dir = () => join(home(), "mcp-auth");
const fileFor = (url: string) => join(dir(), `${createHash("sha256").update(url).digest("hex").slice(0, 24)}.json`);

async function load(url: string): Promise<Saved> {
  try {
    return { ...(JSON.parse(await readFile(fileFor(url), "utf8")) as Saved), url };
  } catch {
    return { url };
  }
}

/** Change some fields of a server's saved sign-in, on top of what's on disk now (other connections write too). */
async function update(url: string, patch: Partial<Saved>, drop: (keyof Saved)[] = []): Promise<Saved> {
  return withFileLock(url, async () => {
    const next: Saved = { ...(await load(url)), ...patch };
    for (const k of drop) delete next[k];
    await mkdir(dir(), { recursive: true, mode: 0o700 });
    const tmp = `${fileFor(url)}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, fileFor(url));
    await chmod(fileFor(url), 0o600).catch(() => {});
    return next;
  });
}

/** The locks the current chain of work holds, so a nested call doesn't wait on itself. */
const holding = new AsyncLocalStorage<ReadonlySet<string>>();
/** Within this process, one holder per server at a time (the file lock covers other processes). */
const queues = new Map<string, Promise<unknown>>();

/**
 * One writer at a time for a server's sign-in: within this process (two requests on one connection)
 * and across processes (each agent's connection is its own process). A nested call from the same
 * chain of work goes straight through. A lock file older than 30 seconds is from a process that died.
 */
async function withFileLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const mine = holding.getStore();
  if (mine?.has(url)) return fn();
  const prev = queues.get(url) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => turn);
  queues.set(url, tail);
  await prev.catch(() => {});
  try {
    await mkdir(dir(), { recursive: true, mode: 0o700 });
    const lock = `${fileFor(url)}.lock`;
    for (let waited = 0; ; waited += 100) {
      try {
        await (await open(lock, "wx", 0o600)).close();
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
        if (age > 30_000) await rm(lock, { force: true });
        else if (waited > 60_000) throw new Error("Timed out waiting for another connection to finish renewing the sign-in.");
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      return await holding.run(new Set([...(mine ?? []), url]), fn);
    } finally {
      await rm(lock, { force: true });
    }
  } finally {
    release();
    if (queues.get(url) === tail) queues.delete(url);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** OAuth addresses must be HTTPS (the spec); plain HTTP only to this machine itself. */
function secureUrl(u: string | URL | undefined, what: string): void {
  if (!u) return;
  const p = new URL(u);
  if (p.protocol === "https:" || (p.protocol === "http:" && LOOPBACK.has(p.hostname))) return;
  throw new Error(`The server's ${what} (${p.origin}) isn't HTTPS, so Overtime won't sign in through it.`);
}

/**
 * The SDK's view of one server's saved sign-in. "sign-in" runs the interactive flow; "connection" is
 * for agents' connections: it may renew the login but never registers a client, starts a browser
 * sign-in or reuses discovery from earlier (so a change of authorization server is noticed).
 */
class Provider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private stateValue = randomBytes(16).toString("hex");
  /** The refresh token this provider last read, so a failed renewal only discards that one. */
  private readRefresh: string | undefined;

  constructor(
    private readonly url: string,
    private readonly port: number | undefined,
    private readonly mode: "sign-in" | "connection",
  ) {
    if (mode === "connection") (this as any).saveClientInformation = undefined; // never registers
  }

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
      application_type: "native",
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation() {
    return (await load(this.url)).client;
  }

  async saveClientInformation(c: StoredOAuthClientInformation) {
    await update(this.url, { client: c });
  }

  async tokens() {
    const t = (await load(this.url)).tokens;
    this.readRefresh = t?.refresh_token;
    return t;
  }

  async saveTokens(t: StoredOAuthTokens) {
    // Granted: scopes asked for earlier are now part of it (or were refused); don't ask again.
    await update(this.url, { tokens: t, savedAt: Date.now() }, ["requestedScope"]);
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(v: string) {
    if (this.mode === "sign-in") await update(this.url, { verifier: v });
  }

  async codeVerifier() {
    const v = (await load(this.url)).verifier;
    if (!v) throw new Error("No sign-in is in progress for this server.");
    return v;
  }

  async discoveryState() {
    return this.mode === "sign-in" ? (await load(this.url)).discovery : undefined;
  }

  async saveDiscoveryState(d: OAuthDiscoveryState) {
    if (this.mode === "sign-in") await update(this.url, { discovery: d });
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const now = await load(this.url);
    const drop: (keyof Saved)[] = [];
    // Tokens: only the ones that failed. If another connection renewed them meanwhile, those stay.
    if ((scope === "all" || scope === "tokens") && now.tokens?.refresh_token === this.readRefresh) drop.push("tokens");
    if (scope === "all" || scope === "client") drop.push("client");
    if (scope === "all" || scope === "verifier") drop.push("verifier");
    if (scope === "all" || scope === "discovery") drop.push("discovery");
    if (drop.length) await update(this.url, {}, drop);
  }
}

/** Whether there's a saved sign-in for this server. */
export async function signedIn(url: string): Promise<boolean> {
  return !!(await load(url)).tokens?.access_token;
}

/** Forget the sign-in for this server (and the client registration that came with it). */
export async function signOut(url: string): Promise<void> {
  await withFileLock(url, () => rm(fileFor(url), { force: true }));
}

/** The server asked for scopes the login doesn't have: they're asked for at the next sign-in. */
export async function needScope(url: string, scope: string | undefined): Promise<void> {
  const s = await load(url);
  await update(url, { requestedScope: computeScopeUnion(s.requestedScope, s.tokens?.scope, scope) });
}

/**
 * For an agent's connection to a server: its sign-in, if there is one. The current token goes on each
 * request; when the server refuses it, the login is renewed once with the refresh token (by one
 * connection at a time; the others use what it got). When it can't be renewed, the request fails with
 * UnauthorizedError: the person has to sign in again.
 */
export async function connectionAuth(url: string): Promise<AuthProvider | undefined> {
  if (!(await signedIn(url))) return undefined;
  let sent: string | undefined;
  return {
    token: async () => (sent = (await load(url)).tokens?.access_token),
    onUnauthorized: async (ctx) => {
      await withFileLock(url, async () => {
        const now = await load(url);
        if (now.tokens?.access_token && now.tokens.access_token !== sent) return; // renewed by another connection
        if (!now.tokens?.refresh_token) throw new UnauthorizedError();
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
        const p = new Provider(url, now.port, "connection");
        const r = await auth(p, { serverUrl: ctx.serverUrl, resourceMetadataUrl, scope, fetchFn: ctx.fetchFn }).catch(() => "FAILED");
        if (r !== "AUTHORIZED") throw new UnauthorizedError();
      });
    },
  };
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

/** What a server says about signing in when asked without a login: its resource metadata and scope. */
async function challenge(url: string, fetchFn: FetchLike): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 401 ? extractWWWAuthenticateParams(res) : {};
  } catch {
    return {};
  }
}

const pending = new Map<string, Promise<void>>();

/**
 * Start signing in to a server: checks it supports the standard sign-in, opens the person's browser at
 * its sign-in page and returns that address (to show in case the browser didn't open). `done` settles
 * once they've signed in, after 10 minutes, or if the server refuses.
 */
export async function beginSignIn(url: string, open = openBrowser, fetchFn: FetchLike = fetch): Promise<{ authorizationUrl: string | null; done: Promise<void> }> {
  if (pending.has(url)) throw new Error("A sign-in to this server is already waiting for you in your browser.");
  const before = await load(url);

  // Discovery, fresh each time, with the checks the spec asks of the client.
  const ch = await challenge(url, fetchFn);
  const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl: ch.resourceMetadataUrl, fetchFn });
  if (!info.resourceMetadata) throw new Error("This server doesn't describe its sign-in the standard way (OAuth protected resource metadata), so Overtime can't sign in to it. If it gives you a token, put it in the server's headers instead.");
  const meta = info.authorizationServerMetadata;
  if (!meta) throw new Error("Couldn't find the server's sign-in service (authorization server metadata).");
  if (!meta.code_challenge_methods_supported?.includes("S256")) throw new Error("The server's sign-in doesn't support PKCE (S256), which the MCP spec requires, so Overtime won't use it.");
  secureUrl(info.authorizationServerUrl, "sign-in service");
  secureUrl(meta.authorization_endpoint, "sign-in page");
  secureUrl(meta.token_endpoint, "token address");
  secureUrl(meta.registration_endpoint, "registration address");

  const { server, port } = await freePort(before.port);
  // A different port than the one registered means a different redirect address: register again.
  await update(url, { port, discovery: { authorizationServerUrl: String(info.authorizationServerUrl), resourceMetadataUrl: ch.resourceMetadataUrl?.toString(), resourceMetadata: info.resourceMetadata, authorizationServerMetadata: meta } }, before.port === port ? [] : ["client"]);
  const p = new Provider(url, port, "sign-in");
  const scope = computeScopeUnion(before.requestedScope, ch.scope) ?? undefined;
  let result: string;
  try {
    result = await auth(p, { serverUrl: url, resourceMetadataUrl: ch.resourceMetadataUrl, scope, fetchFn, forceReauthorization: true });
  } catch (e) {
    server.close();
    throw e;
  }
  if (result === "AUTHORIZED" || !p.authorizationUrl) {
    server.close();
    return { authorizationUrl: null, done: Promise.resolve() };
  }
  const authorizationUrl = p.authorizationUrl;
  try {
    secureUrl(authorizationUrl, "sign-in page");
  } catch (e) {
    server.close();
    throw e;
  }

  let handled = false;
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
      if (handled) return page("Already done", "This sign-in was already handled. You can close this tab.");
      handled = true;
      // RFC 9207: the response must come from the authorization server the sign-in started with. On a
      // mismatch nothing in it is used or shown.
      try {
        validateAuthorizationResponseIssuer({ iss: q.searchParams.get("iss") ?? undefined, expectedIssuer: meta.issuer, issParameterSupported: (meta as any).authorization_response_iss_parameter_supported === true });
      } catch {
        page("Not signed in", "The sign-in response didn't come from the server's sign-in service. Try again from Overtime.");
        return finish(new Error("The sign-in response didn't come from the server's own sign-in service, so it wasn't used."));
      }
      const err = q.searchParams.get("error");
      if (err) {
        page("Not signed in", "The server didn't sign you in. You can close this tab and try again from Overtime.");
        return finish(new Error(`The server didn't sign you in (${err}).`));
      }
      const code = q.searchParams.get("code");
      if (!code) {
        page("Not signed in", "The server didn't send a sign-in code. Try again from Overtime.");
        return finish(new Error("The server didn't send a sign-in code."));
      }
      try {
        await auth(p, { serverUrl: url, authorizationCode: code, iss: q.searchParams.get("iss") ?? undefined, resourceMetadataUrl: ch.resourceMetadataUrl, fetchFn });
        await update(url, {}, ["verifier"]);
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
  open(authorizationUrl.href);
  return { authorizationUrl: authorizationUrl.href, done };
}
