/**
 * What kind of trouble an error is, read from what the backend says in structured form wherever it
 * says it: the ACP error code, the adapter's error data (Claude's `errorKind`, Codex's `codexErrorInfo`
 * and its HTTP status), and the operating system's error codes. Only an error that carries none of
 * these (a custom backend that sends plain text) is judged by its wording, as a last resort.
 */

/** An error from a backend, with its structure kept: the JSON-RPC code and data, or the system's code. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly backend: string,
    /** JSON-RPC error code (number), or a system error code such as "ENOENT" (string). */
    readonly code?: number | string,
    readonly data?: unknown,
    /** The backend's command couldn't be started at all. */
    readonly spawnFailed = false,
  ) {
    super(message);
  }
}

/** The backend's process ended (crashed, or exited on arguments it doesn't know). */
export class BackendExitedError extends BackendError {}

/**
 * - install: the backend's command isn't on this machine.
 * - signin: the backend needs the person to sign in.
 * - credit: the account is out of credit or quota (a person has to top it up).
 * - limit: a subscription usage limit; it resets by itself.
 * - transient: overloaded, rate limited, a 5xx, a dropped connection; it passes by itself.
 * - null: anything else (a real failure).
 */
export type Trouble = "install" | "signin" | "credit" | "limit" | "transient" | null;

/** ACP's "authentication required" error code. */
const ACP_AUTH_REQUIRED = -32000;

/** Claude's adapter: `error.data.errorKind`, the provider's own error type. */
const CLAUDE_KINDS: Record<string, Trouble> = {
  authentication_failed: "signin",
  oauth_org_not_allowed: "signin",
  billing_error: "credit",
  account_on_hold: "credit",
  rate_limit: "transient",
  overloaded: "transient",
  server_error: "transient",
  transport_lost: "transient",
  worker_shutdown: "transient",
};

/** Codex's adapter: `error.data.codexErrorInfo`, a name or an object keyed by one. */
const CODEX_KINDS: Record<string, Trouble> = {
  unauthorized: "signin",
  usageLimitExceeded: "limit",
  rateLimitExceeded: "transient",
  serverOverloaded: "transient",
  internalServerError: "transient",
  flexUnavailable: "transient",
  httpConnectionFailed: "transient",
  responseStreamConnectionFailed: "transient",
  responseStreamDisconnected: "transient",
  responseTooManyFailedAttempts: "transient",
};

/** Error codes the model providers themselves use, which some backends pass on as they are. */
const PROVIDER_CODES: Record<string, Trouble> = {
  // OpenAI
  insufficient_quota: "credit",
  rate_limit_exceeded: "transient",
  invalid_api_key: "signin",
  server_error: "transient",
  // Anthropic
  authentication_error: "signin",
  rate_limit_error: "transient",
  overloaded_error: "transient",
  api_error: "transient",
  // Google: a used-up quota (it comes back by itself) and a busy service
  RESOURCE_EXHAUSTED: "limit",
  UNAVAILABLE: "transient",
  UNAUTHENTICATED: "signin",
};

/** Network failures, by the system's error code. */
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

function byStatus(status: number): Trouble {
  if (status === 401) return "signin";
  if (status === 402) return "credit";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return null;
}

/** The trouble an error's structure names, or undefined if it carries no structure to go on. */
function fromStructure(e: any): Trouble | undefined {
  if (!e || typeof e !== "object") return undefined;
  const code = e.code ?? e.cause?.code;
  if (e instanceof BackendError && e.spawnFailed) return code === "ENOENT" ? "install" : null;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return "transient";
  if (code === ACP_AUTH_REQUIRED) return "signin";
  const data = e.data;
  if (data && typeof data === "object") {
    const kind = (data as any).errorKind;
    if (typeof kind === "string") return CLAUDE_KINDS[kind] ?? null;
    const info = (data as any).codexErrorInfo;
    if (typeof info === "string") return CODEX_KINDS[info] ?? null;
    if (info && typeof info === "object") {
      const [name, details] = Object.entries(info)[0] ?? [];
      const status = (details as any)?.httpStatusCode;
      const s = typeof status === "number" ? byStatus(status) : null;
      if (s) return s;
      if (name) return CODEX_KINDS[name] ?? null;
    }
    // Providers' own error codes, as they pass through a backend (OpenAI's error.code and type,
    // Anthropic's error.type, Google's status), at the top level or under "error".
    for (const src of [data, (data as any).error]) {
      if (!src || typeof src !== "object") continue;
      for (const key of ["code", "type", "status"]) {
        const v = (src as any)[key];
        if (typeof v === "string" && PROVIDER_CODES[v] !== undefined) return PROVIDER_CODES[v];
      }
    }
    const status = (data as any).status ?? (data as any).statusCode ?? (data as any).httpStatusCode;
    if (typeof status === "number") return byStatus(status);
  }
  if (typeof e.status === "number") return byStatus(e.status);
  return undefined;
}

/**
 * The last resort, for a backend that gives nothing but text: the words providers commonly use. Never
 * consulted when the error has a structured kind.
 */
function fromWording(message: string): Trouble {
  const m = message.toLowerCase();
  const has = (...words: string[]) => words.some((w) => m.includes(w));
  if (has("authentication required", "not logged in", "not signed in", "please log in", "please login", "invalid api key", "invalid x-api-key", "unauthorized", "unauthorised", "oauth token has expired", "login required")) return "signin";
  if (has("credit balance is too low", "insufficient credit", "insufficient_quota", "insufficient quota", "insufficient funds", "payment required", "exceeded your current quota")) return "credit";
  if (has("usage limit", "quota exceeded", "resource_exhausted", "resource exhausted", "hit your limit")) return "limit";
  if (has("overloaded", "rate limit", "rate_limit", "too many requests", "temporarily unavailable", "service unavailable", "bad gateway", "gateway timeout", "gateway time-out", "internal server error", "socket hang up", "fetch failed", "connection reset", "network error")) return "transient";
  return null;
}

export function classify(e: unknown): Trouble {
  const s = fromStructure(e);
  if (s !== undefined) return s;
  return fromWording(String((e as any)?.message ?? e));
}

/**
 * Errors the agent can't fix by retrying, as one plain instruction for the person; null for anything
 * else.
 */
export function needsPerson(e: unknown, backend: string, agent: string): string | null {
  const signIn: Record<string, string> = {
    claude: "Open a terminal, run `claude`, and sign in",
    codex: "Open a terminal and run `codex login`",
    gemini: "Open a terminal, run `gemini`, and sign in",
    opencode: "Open a terminal and run `opencode auth login`",
  };
  switch (classify(e)) {
    case "install":
      return `The ${backend} backend isn't installed on this machine, so ${agent} can't run. Install it, or switch ${agent} to another backend (Ctrl+T in the app, or \`overtime set ${agent} backend=claude\`).`;
    case "signin":
      return `${backend} isn't signed in, so ${agent} can't run. ${signIn[backend] ?? `Sign in to ${backend}`}, then wake ${agent} (Ctrl+R in the app, or \`overtime wake ${agent}\`). If ${backend} already works in your terminal, open the app again: it restarts Overtime's background process, which may have lost your sign-in.`;
    case "credit":
      return `${backend} says the account is out of credit or quota, so ${agent} can't run. Top it up, then wake ${agent} (Ctrl+R).`;
    default:
      return null;
  }
}

/** A problem on the provider's side that passes by itself. Retried quietly; never counts as the agent failing. */
export function isTransient(e: unknown): boolean {
  return classify(e) === "transient";
}
