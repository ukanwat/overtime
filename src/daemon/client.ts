import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { paths, home } from "../paths.js";

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
        for (const p of this.pending.values()) p.reject(new Error("The Overtime daemon disconnected."));
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
    if (this.isClosed) return Promise.reject(new Error("The Overtime daemon disconnected."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Overtime daemon didn't answer "${method}" in ${Math.round(timeoutMs / 1000)}s.`));
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

/** Start the daemon in the background if it isn't running, then connect. */
export async function ensureDaemon(): Promise<DaemonClient> {
  try {
    return await DaemonClient.connect();
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
