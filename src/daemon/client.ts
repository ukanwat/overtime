import { connect, type Socket } from "node:net";
import { buildId } from "./build.js";
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { paths, home } from "../paths.js";
import { listAgents } from "../agent/agent.js";
import { classify } from "../runtime/errors.js";
import { AGENT_MARKER } from "../runtime/leftovers.js";

/** The daemon went away (or isn't running): the connection is lost, not a request failed. */
export class DaemonGoneError extends Error {
  constructor() {
    super("The Overtime daemon disconnected.");
  }
}

/** The daemon is there but didn't answer in time. */
export class DaemonTimeoutError extends Error {}

/** Whether an error means there's no daemon to talk to: lost, or the socket can't be reached. */
export function isDaemonGone(e: unknown): boolean {
  if (e instanceof DaemonGoneError) return true;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return (e as any)?.syscall === "connect" || code === "EPIPE" || code === "ECONNRESET";
}

/** A connection to the daemon. */
export class DaemonClient {
  private sock: Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: any) => void>();
  private closedFlag = false;
  readonly closed: Promise<void>;

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("error", () => {}); // "close" follows and rejects what's pending
    sock.on("data", (c: string) => {
      this.buf += c;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.event) for (const l of this.listeners) l(msg);
        else if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p?.reject(new Error(msg.error));
          else p?.resolve(msg.result);
        }
      }
    });
    this.closed = new Promise((r) =>
      sock.on("close", () => {
        this.closedFlag = true;
        for (const p of this.pending.values()) p.reject(new DaemonGoneError());
        this.pending.clear();
        r();
      }),
    );
  }

  static connect(): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const s = connect(paths.socket());
      s.once("connect", () => resolve(new DaemonClient(s)));
      s.once("error", reject);
    });
  }

  /** One request. Fails if the daemon is gone or doesn't answer within the timeout. */
  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.isClosed) return Promise.reject(new DaemonGoneError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonTimeoutError(`The Overtime daemon didn't answer "${method}" in ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  get isClosed(): boolean {
    return this.closedFlag || this.sock.destroyed;
  }

  async subscribe(fn: (e: any) => void): Promise<void> {
    this.listeners.add(fn);
    await this.call("subscribe");
  }

  close(): void {
    this.closedFlag = true;
    this.sock.end();
  }
}

/**
 * Whether to keep the running daemon. Only an older one is replaced (never a newer one), so two
 * different installs talking to the same home can't keep replacing each other's daemon.
 */
async function sameBuild(c: DaemonClient): Promise<{ keep: boolean; pid?: number }> {
  try {
    const p = await c.call<{ build?: string; pid?: number }>("ping", {}, 5_000);
    return { keep: !p.build || p.build === buildId() ? !!p.build : compareBuilds(p.build, buildId()) >= 0, pid: p.pid };
  } catch {
    return { keep: true }; // busy or slow: keep it rather than restart on a guess
  }
}

/** At most one sign-in restart per this long, so a backend that really is signed out isn't restarted on every open. */
const SIGNIN_RESTART_GAP_MS = 10 * 60_000;

/**
 * Whether the daemon is stuck on sign-in: an agent's turns fail with "not signed in" and none is working.
 * A daemon left from an earlier login can lose the person's saved sign-ins (a locked keychain) for good,
 * while a fresh one started from here, in their current session, has them. Never from an agent's own
 * processes: they run inside that daemon, so a replacement started by them would be cut off the same way.
 */
export async function stuckOnSignIn(): Promise<boolean> {
  if (process.env[AGENT_MARKER]) return false;
  const marker = join(home(), "signin-restart.json");
  const last = await readFile(marker, "utf8").then((t) => Number(JSON.parse(t).at) || 0, () => 0);
  if (Date.now() - last < SIGNIN_RESTART_GAP_MS) return false;
  const agents = await listAgents().catch(() => []);
  if (agents.some((a) => a.state.status === "working")) return false;
  if (!agents.some((a) => a.state.lastError && classify(new Error(a.state.lastError)) === "signin")) return false;
  await writeFile(marker, JSON.stringify({ at: Date.now() })).catch(() => {});
  return true;
}

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Order two build ids ("0.3.0+1696300000000"): by version, then by build time. */
export function compareBuilds(a: string, b: string): number {
  const [va, ta] = a.split("+");
  const [vb, tb] = b.split("+");
  const pa = va.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = vb.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return Number(ta ?? 0) - Number(tb ?? 0);
}

/** Start the daemon in the background if it isn't running, then connect. */
export async function ensureDaemon(): Promise<DaemonClient> {
  try {
    const c = await DaemonClient.connect();
    const b = await sameBuild(c);
    if (b.keep && !(await stuckOnSignIn())) return c;
    // An older daemon from before an update, or one stuck on sign-in: replace it. Agents carry on where they were. It stops
    // taking connections at once but takes a while to finish (its sessions close properly), and the
    // new one can't start until it has: wait for the process itself to end.
    await c.call("shutdown", {}, 5_000).catch(() => {});
    c.close();
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      if (b.pid ? !alive(b.pid) : await DaemonClient.connect().then((x) => (x.close(), false), () => true)) break;
    }
  } catch {}
  await mkdir(home(), { recursive: true });
  const here = dirname(fileURLToPath(import.meta.url));
  const js = join(here, "main.js");
  const ts = join(here, "main.ts");
  const out = openSync(paths.daemonLog(), "a");
  const [cmd, args] = existsSync(js) ? [process.execPath, [js]] : [process.execPath, ["--import", "tsx", ts]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      return await DaemonClient.connect();
    } catch {}
  }
  throw new Error(`The Overtime daemon didn't start. See ${paths.daemonLog()}.`);
}
