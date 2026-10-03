import { connect, createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { paths } from "../paths.js";
import { listAgents, loadAgent, effectiveSettings } from "../agent/agent.js";
import { readLimits, usageToday } from "../runtime/usage.js";
import type { Runtime, ChangeEvent } from "./runtime.js";

/** Summary of one agent for the agent list. */
export interface AgentSummary {
  name: string;
  status: string;
  activity: string;
  nextWake: string | null;
  pausedUntil: string | null;
  waiting: number;
  unread: number;
  helpersRunning: number;
  spentUsd: number;
  costReported: boolean;
  tokensToday: number;
  budgetUsd: number;
  backend: string;
  model: string | null;
  lastError: string | null;
  dir: string;
}

type Handler = (params: any, sock: Socket) => Promise<unknown>;

/**
 * The daemon's control socket: newline-delimited JSON requests ({id, method, params}) and responses
 * ({id, result} or {id, error}). "subscribe" turns the connection into a live event stream as well.
 */
export class ControlServer {
  private server: Server | null = null;
  private subscribers = new Set<Socket>();

  constructor(private readonly rt: Runtime, private readonly log: (s: string) => void, private readonly onShutdown: () => void) {
    rt.on("change", (e: ChangeEvent) => this.broadcast({ event: "change", ...e }));
  }

  private methods: Record<string, Handler> = {
    ping: async () => ({ ok: true, pid: process.pid }),
    agents: async () => Promise.all((await listAgents()).map((a) => this.summary(a.name))),
    agent: async ({ name }) => {
      const a = await loadAgent(name);
      const store = this.rt.store(name);
      return {
        summary: await this.summary(name),
        identity: a.identity,
        index: a.index,
        settings: a.settings,
        schedule: await store.schedule(),
        monitors: (await store.monitors()).filter((m) => m.status !== "removed"),
        helpers: await store.helpers(),
        reports: await store.reports(30),
      };
    },
    threads: async ({ name }) => (await this.rt.store(name).threads()).sort((x, y) => x.updatedAt.localeCompare(y.updatedAt)),
    thread: async ({ name, id, markRead }) => {
      const store = this.rt.store(name);
      const th = await store.thread(id);
      if (!th) throw new Error(`No thread ${id}.`);
      if (markRead && th.meta.unread) {
        await store.markRead(id);
        this.rt.changed(name, "threads");
      }
      return th;
    },
    send: async ({ name, text, threadId }) => ({ threadId: await this.rt.send(name, String(text), threadId || undefined) }),
    answer: async ({ name, threadId, choice, text }) => {
      await this.rt.answer(name, threadId, choice ? Number(choice) : undefined, text);
      return { ok: true };
    },
    new: async ({ name, backend, model }) => {
      const a = await this.rt.create(name, { backend, model });
      return { name: a.name, dir: a.dir };
    },
    stop: async ({ name }) => {
      await this.rt.stopAgent(name);
      return { ok: true };
    },
    start: async ({ name }) => {
      await this.rt.startAgent(name);
      return { ok: true };
    },
    wake: async ({ name }) => {
      await this.rt.wakeNow(name);
      return { ok: true };
    },
    limits: async () => readLimits(),
    subscribe: async (_p, sock) => {
      this.subscribers.add(sock);
      sock.on("close", () => this.subscribers.delete(sock));
      return { ok: true };
    },
    shutdown: async () => {
      setTimeout(this.onShutdown, 50);
      return { ok: true };
    },
  };

  async summary(name: string): Promise<AgentSummary> {
    const a = await loadAgent(name);
    const store = this.rt.store(name);
    const eff = await effectiveSettings(a);
    const threads = await store.threads();
    const today = await usageToday(name);
    return {
      name,
      status: a.state.status,
      activity: a.state.activity,
      nextWake: a.state.nextWake,
      pausedUntil: a.state.pausedUntil ?? null,
      waiting: threads.filter((t) => t.status === "waiting_on_you").length,
      unread: threads.reduce((n, t) => n + (t.unread || 0), 0),
      helpersRunning: (await store.helpers()).filter((h) => h.status === "running").length,
      spentUsd: today.usd,
      costReported: today.costReported,
      tokensToday: today.tokens,
      budgetUsd: eff.dailyBudgetUsd,
      backend: eff.backend,
      model: eff.model,
      lastError: a.state.lastError,
      dir: a.dir,
    };
  }

  private broadcast(msg: unknown): void {
    const line = JSON.stringify(msg) + "\n";
    for (const s of this.subscribers) {
      if (!s.destroyed) s.write(line);
    }
  }

  async start(): Promise<void> {
    const sockPath = paths.socket();
    // Only remove a socket nobody answers on: a live one belongs to a running daemon.
    if (existsSync(sockPath)) {
      if (await socketAnswers(sockPath)) throw new Error("Another Overtime daemon is answering on its socket.");
      unlinkSync(sockPath);
    }
    this.server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) void this.handle(line, sock);
        }
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(sockPath, () => resolve());
    });
  }

  private async handle(line: string, sock: Socket): Promise<void> {
    let msg: { id?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (body: object) => !sock.destroyed && sock.write(JSON.stringify({ id: msg.id, ...body }) + "\n");
    const h = msg.method ? this.methods[msg.method] : undefined;
    if (!h) return void reply({ error: `Unknown method ${msg.method}` });
    try {
      reply({ result: await h(msg.params ?? {}, sock) });
    } catch (e: any) {
      reply({ error: String(e?.message ?? e) });
    }
  }

  async stop(): Promise<void> {
    for (const s of this.subscribers) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    try {
      unlinkSync(paths.socket());
    } catch {}
  }
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (v: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(false), 2_000);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
