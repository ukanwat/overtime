import {
  Client,
  InsufficientScopeError,
  IssuerMismatchError,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type ClientCapabilities,
  type FetchLike,
  type ListChangedHandlers,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "../settings.js";
import { connectionAuth, needScope } from "../runtime/mcp-auth.js";

/**
 * Connecting to an MCP server as a client, the one way Overtime does it (agents' connections and the
 * status check in the app use this, so they can't behave differently):
 * - the protocol version is negotiated with the server: the current spec (2026-07-28) when it speaks
 *   it, the earlier, initialize-based one when it doesn't;
 * - over HTTP, Streamable HTTP, and the older HTTP+SSE transport when the server answers the first
 *   request with 400, 404 or 405 (the spec's backwards-compatibility rule);
 * - Overtime's sign-in to the server, if there is one (runtime/mcp-auth.ts);
 * - headers the person set for the server go to the server only, never to its sign-in service.
 */

export interface Remote {
  client: Client;
  transport: Transport;
  /** End the connection: the server is told the session is over (HTTP DELETE), then it's closed. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** What this client can do for the server (elicitation, sampling, roots). */
  capabilities?: ClientCapabilities;
  /** Called with the new Client before it connects, to register its handlers. */
  setup?: (client: Client) => void;
  listChanged?: ListChangedHandlers;
  version?: string;
}

/** fetch that adds the server's own headers only to requests for the server itself. */
function scopedFetch(serverUrl: string, headers: Record<string, string>): FetchLike {
  const target = new URL(serverUrl);
  return (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const mine = u.origin === target.origin && u.pathname === target.pathname;
    if (!mine || !Object.keys(headers).length) return fetch(input, init);
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) if (!h.has(k)) h.set(k, v);
    return fetch(input, { ...init, headers: h });
  };
}

function newClient(o: ConnectOptions): Client {
  const client = new Client(
    { name: "overtime", version: o.version ?? "1" },
    { capabilities: o.capabilities ?? {}, versionNegotiation: { mode: "auto" }, ...(o.listChanged ? { listChanged: o.listChanged } : {}) },
  );
  o.setup?.(client);
  return client;
}

/** The person's own Authorization header wins over Overtime's sign-in. */
const ownAuthorization = (h?: Record<string, string>) => Object.keys(h ?? {}).some((k) => k.toLowerCase() === "authorization");

export async function connectRemote(cfg: McpServerConfig, o: ConnectOptions = {}): Promise<Remote> {
  if (!cfg.url) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    const transport = new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [], env: { ...env, ...(cfg.env ?? {}) }, stderr: "pipe" });
    const client = newClient(o);
    await client.connect(transport);
    return { client, transport, close: () => client.close() };
  }
  const headers = cfg.headers ?? {};
  const authProvider = ownAuthorization(headers) ? undefined : await connectionAuth(cfg.url);
  const fetchFn = scopedFetch(cfg.url, headers);
  const base = { fetch: fetchFn, ...(authProvider ? { authProvider } : {}) };
  const streamable = new StreamableHTTPClientTransport(new URL(cfg.url), { ...base, onInsufficientScope: "throw" } as any);
  let client = newClient(o);
  try {
    await client.connect(streamable);
    return {
      client,
      transport: streamable,
      close: async () => {
        await streamable.terminateSession().catch(() => {});
        await client.close().catch(() => {});
      },
    };
  } catch (e) {
    await client.close().catch(() => {});
    if (!(SdkHttpError.isInstance(e) && [400, 404, 405].includes(e.status))) throw e;
  }
  // An older server (HTTP+SSE).
  const sse = new SSEClientTransport(new URL(cfg.url), base as any);
  client = newClient(o);
  await client.connect(sse);
  return { client, transport: sse, close: () => client.close().catch(() => {}) };
}

/** Whether an error means the server's session is gone (it must be started again). */
export function sessionGone(e: unknown, r: Remote): boolean {
  return SdkHttpError.isInstance(e) && e.status === 404 && !!(r.transport as any).sessionId;
}

/** What went wrong reaching a server, in plain words; needsSignIn when the person has to sign in (again). */
export async function explainMcpError(e: any, cfg: McpServerConfig): Promise<{ error: string; needsSignIn?: boolean }> {
  const name = cfg.name;
  if (e instanceof InsufficientScopeError) {
    if (cfg.url) await needScope(cfg.url, e.requiredScope).catch(() => {});
    return { needsSignIn: true, error: `needs you to sign in again to allow more access${e.requiredScope ? ` (${e.requiredScope})` : ""}` };
  }
  if (e instanceof UnauthorizedError) return { needsSignIn: true, error: "needs you to sign in" };
  if (e instanceof IssuerMismatchError) return { error: "its sign-in service didn't match what it advertises, so Overtime didn't use it" };
  if (e?.code === "ENOENT") return { error: `${cfg.command} isn't installed or isn't on your PATH` };
  if (e?.code === "ECONNREFUSED" || e?.cause?.code === "ECONNREFUSED") return { error: "nothing is listening at that address" };
  const status = SdkHttpError.isInstance(e) ? e.status : e instanceof SseError && typeof e.code === "number" ? e.code : undefined;
  if (status === 401) return { needsSignIn: true, error: "needs you to sign in" };
  if (status === 403) return { error: "the server refused access (HTTP 403): the account doesn't have permission" };
  if (status === 404) return { error: "the server says there's nothing at that URL (HTTP 404): check the address" };
  if (typeof status === "number" && status >= 500) return { error: `the server had an error (HTTP ${status}); try again later` };
  return { error: `${name}: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}` };
}
