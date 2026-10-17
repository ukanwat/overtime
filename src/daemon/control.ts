import { connect, createServer, type Server, type Socket } from "node:net";
import { describeStep } from "./steps.js";
import { listSkills } from "../skills.js";
import { buildId } from "./build.js";
import { existsSync, unlinkSync } from "node:fs";
import { paths } from "../paths.js";
import { listAgents, loadAgent, effectiveSettings, allMcpServers } from "../agent/agent.js";
import { readLimits, usageToday } from "../runtime/usage.js";
import { loadSettings } from "../settings.js";
import { reflectEnabled, type Runtime, type ChangeEvent, type SettingsPatch } from "./runtime.js";

/** Summary of one agent for the agent list. */
export interface AgentSummary {
  name: string;
  status: string;
  activity: string;
  /** The agent's own status line (set with send status), or "" when it hasn't set one. */
  ownStatus: string;
  /** While it works: what the turn is about, in Overtime's words (shown when it has no status line of its own); else "". */
  turnAbout: string;
  /** Why it's paused, when it is. */
  pauseReason: "budget" | "limit" | null;
  /** Paused by a usage limit: when the backend said it resets. */
  limitResetsAt?: string | null;
  /** It (or one of its helpers) can't reach its backend: since when, and which. */
  /** Can't reach its backend, or (signIn) its backend isn't signed in. */
  trouble: { since: string; backend: string; signIn?: boolean } | null;
  /** When this machine lost its internet connection, or null. */
  offlineSince: string | null;
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
  /** When it last ran a turn (null if never). */
  lastRunAt: string | null;
  dir: string;
}

/** One running session's live output: the text it is writing and the step it is on. */
export interface LiveState {
  agent: string;
  kind: string;
  threadId?: string;
  helperId?: string;
  text: string;
  step: string | null;
  startedAt: string;
}

const liveKey = (e: { agent: string; kind: string; threadId?: string; helperId?: string }) => `${e.agent}|${e.kind}|${e.threadId ?? e.helperId ?? ""}`;

type Handler = (params: any, sock: Socket) => Promise<unknown>;

/**
 * What a request made from inside an agent (it carries the agent's name as "caller") may do: only
 * look. Everything else (sending, answering, changing or stopping agents) is the person's, and a
 * message sent from an agent's shell would otherwise land as if the person wrote it.
 */
const AGENT_CALLS = new Set(["ping", "agents", "agent", "messages", "settings", "skills", "mcpList", "limits", "live", "backends", "backendStatus", "models", "subscribe"]);

/** Requests that put words in an agent's conversation: what an agent does for that is message it, or the person. */
const MESSAGING = new Set(["send", "answer"]);

/** Why an agent can't make a request (a CLI command or daemon method) that only the person may. */
export function personOnly(what: string, request: string | undefined, caller: string, name?: unknown): string {
  if (!MESSAGING.has(request ?? "")) return `${what} can only be done by the person. If it needs doing, ask them with your send tool.`;
  return name === caller
    ? `${what} can only be done by the person; ${caller} reaches the person with its own send tool.`
    : `${what} can only be done by the person. To reach another agent, use your message tool.`;
}

/**
 * The daemon's control socket: newline-delimited JSON requests ({id, method, params}) and responses
 * ({id, result} or {id, error}). "subscribe" turns the connection into a live event stream as well.
 */
export class ControlServer {
  private server: Server | null = null;
  private subscribers = new Set<Socket>();

  /** What each running session is writing and doing right now, streamed to the app as it happens. */
  private live = new Map<string, LiveState & { timer?: NodeJS.Timeout }>();

  private opened!: () => void;
  private readonly ready = new Promise<void>((r) => (this.opened = r));

  constructor(private readonly rt: Runtime, private readonly log: (s: string) => void, private readonly onShutdown: () => void) {
    rt.on("change", (e: ChangeEvent) => this.broadcast({ event: "change", ...e }));
    rt.on("update", (e: { agent: string; kind: string; threadId?: string; helperId?: string; update: any }) => this.onUpdate(e));
    rt.on("step", (e: { agent: string; kind: string; helperId?: string; step: string }) => this.setStep(e, e.step));
    rt.on("turnEnd", (e: { agent: string; kind: string; threadId?: string; helperId?: string }) => {
      const key = liveKey(e);
      const cur = this.live.get(key);
      if (cur?.timer) clearTimeout(cur.timer);
      this.live.delete(key);
      this.broadcast({ event: "live", ...e, text: "", step: null, done: true });
    });
  }

  /** Each agent's MCP server names, to tell which server a tool call goes to (refreshed every 30s). */
  private servers = new Map<string, { names: string[]; at: number }>();

  private serverNames(agent: string): string[] {
    const c = this.servers.get(agent);
    if (!c || Date.now() - c.at > 30_000) {
      this.servers.set(agent, { names: c?.names ?? [], at: Date.now() });
      void loadAgent(agent)
        .then((a) => allMcpServers(a))
        .then((list) => this.servers.set(agent, { names: list.map((x) => x.server.name), at: Date.now() }))
        .catch(() => {});
    }
    return this.servers.get(agent)!.names;
  }

  private liveFor(e: { agent: string; kind: string; threadId?: string; helperId?: string }) {
    const key = liveKey(e);
    let cur = this.live.get(key);
    if (!cur) this.live.set(key, (cur = { agent: e.agent, kind: e.kind, threadId: e.threadId, helperId: e.helperId, text: "", step: null, startedAt: new Date().toISOString() }));
    return { key, cur };
  }

  private setStep(e: { agent: string; kind: string; helperId?: string }, step: string): void {
    const { key, cur } = this.liveFor(e);
    cur.step = step;
    this.flushSoon(key);
  }

  private onUpdate(e: { agent: string; kind: string; threadId?: string; helperId?: string; update: any }): void {
    const u = e.update;
    const { key, cur } = this.liveFor(e);
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") cur.text = (cur.text + u.content.text).slice(-6000);
    else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      if (u.sessionUpdate === "tool_call" && cur.text && !cur.text.endsWith("\n\n")) cur.text += "\n\n";
      // What it is doing, in plain words ("Running a command", "Editing files"), never a tool's name.
      const step = describeStep(u, this.serverNames(e.agent));
      if (!step) return;
      cur.step = step;
    } else return;
    this.flushSoon(key);
  }

  /** At most ~12 updates a second per session, so a fast model can't flood the app. */
  private flushSoon(key: string): void {
    const cur = this.live.get(key);
    if (!cur || cur.timer) return;
    cur.timer = setTimeout(() => {
      const c = this.live.get(key);
      if (!c) return;
      c.timer = undefined;
      const { timer, ...rest } = c;
      this.broadcast({ event: "live", ...rest, done: false });
    }, 80);
  }

  private methods: Record<string, Handler> = {
    ping: async () => ({ ok: true, pid: process.pid, build: buildId() }),
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
        background: await (await import("../runtime/leftovers.js")).liveBackground(name).catch(() => []),
        skills: (await import("../skills.js")).listSkills(a.dir).map((k) => ({ name: k.name, description: k.description, source: k.source, file: k.file })),
        reports: await store.reports(30),
      };
    },
    messages: async ({ name, limit, before, markRead }) => {
      const store = this.rt.store(name);
      let all = await store.messages();
      if (before) {
        const i = all.findIndex((m) => m.id === before);
        if (i >= 0) all = all.slice(0, i);
      }
      const n = Math.max(1, Math.min(2000, Number(limit) || 300));
      const page = all.slice(-n);
      if (markRead && !before && (await store.unread())) {
        // Read up to what this page shows: a message that arrived meanwhile stays unread.
        await store.markRead(page.at(-1)?.id);
        this.rt.changed(name, "messages");
      }
      return { messages: page, hasMore: all.length > page.length };
    },
    send: async ({ name, text, attachments }) => {
      const m = await this.rt.send(name, String(text ?? ""), Array.isArray(attachments) ? attachments.map(String) : []);
      return { id: m.id };
    },
    mcpList: async ({ name }) => this.rt.mcpList(String(name)),
    skills: async ({ name }) => {
      const a = await loadAgent(String(name));
      return listSkills(a.dir).map((s) => ({ name: s.name, description: s.description }));
    },
    mcpStatus: async ({ name, fresh }) => this.rt.mcpStatus(String(name), !!fresh),
    mcpSignIn: async ({ name, serverName }) => this.rt.mcpSignIn(String(name), String(serverName)),
    mcpSignInWait: async ({ name, serverName }) => {
      await this.rt.mcpSignInWait(String(name), String(serverName));
      return { ok: true };
    },
    mcpSignOut: async ({ name, serverName }) => {
      await this.rt.mcpSignOut(String(name), String(serverName));
      return { ok: true };
    },
    mcpRemove: async ({ name, serverName }) => {
      await this.rt.mcpRemove(String(name), String(serverName));
      return { ok: true };
    },
    mcpSetEnabled: async ({ name, serverName, enabled }) => {
      await this.rt.mcpSetEnabled(String(name), String(serverName), !!enabled);
      return { ok: true };
    },
    dismiss: async ({ name, questionId }) => {
      await this.rt.dismissQuestion(name, String(questionId));
      return { ok: true };
    },
    answer: async ({ name, questionId, choice, choices, replies, text }) => {
      // choices: several options of one question; replies: one per question on a card of several.
      const picks = Array.isArray(choices) ? choices.map(Number) : choice ? Number(choice) : undefined;
      const each = Array.isArray(replies) ? replies.map((r: any) => ({ choices: Array.isArray(r?.choices) ? r.choices.map(Number) : undefined, note: r?.note ? String(r.note) : undefined })) : undefined;
      await this.rt.answer(name, questionId || undefined, picks, text || undefined, each);
      return { ok: true };
    },
    settings: async ({ name }) => {
      const a = await loadAgent(name);
      const eff = await effectiveSettings(a);
      const today = await usageToday(name);
      return {
        backend: eff.backend,
        model: eff.model,
        dailyBudgetUsd: eff.dailyBudgetUsd,
        dailyTokenBudget: eff.dailyTokenBudget,
        workspace: eff.workspace,
        workspaceIsDefault: !a.settings.workspace,
        protect: eff.protect,
        protectOwn: a.settings.protect ?? [],
        visibility: a.settings.visibility ?? "public",
        reflect: reflectEnabled(eff),
        reflectModel: a.settings.reflectModel ?? null,
        spentUsd: today.usd,
        costReported: today.costReported,
        tokensToday: today.tokens,
      };
    },
    new: async ({ name, ...settings }) => {
      const a = await this.rt.newAgent(name, settingsPatch(settings));
      return { name: a.name, dir: a.dir };
    },
    /** What a new agent gets unless the person chooses otherwise. */
    defaults: async () => {
      const g = await loadSettings();
      return { backend: g.backend, model: g.model, dailyBudgetUsd: g.dailyBudgetUsd };
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
    live: async () => [...this.live.values()].map(({ timer, ...rest }) => rest),
    backends: async () => this.rt.backends(),
    /** Each backend, and why it can't run here if it can't (not installed). */
    backendStatus: async () => {
      const { backendMissing } = await import("../acp/backends.js");
      return Promise.all((await this.rt.backends()).map(async (name) => ({ name, missing: await backendMissing(name) })));
    },
    models: async ({ backend }) => this.rt.models(String(backend)),
    set: async ({ name, ...settings }) => {
      await this.rt.setAgentSettings(name, settingsPatch(settings));
      return { ok: true };
    },
    archive: async ({ name }) => ({ dir: await this.rt.archive(name) }),
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
    const open = (await store.openQuestions()).length;
    const unread = await store.unread();
    const today = await usageToday(name);
    return {
      name,
      status: a.state.status,
      activity: a.state.activity,
      ownStatus: a.state.ownStatus ?? "",
      turnAbout: a.state.status === "working" ? a.state.activity : "",
      trouble: await this.rt.trouble(name),
      offlineSince: this.rt.offlineSince,
      pauseReason: a.state.status === "paused" ? (a.state.pauseReason ?? null) : null,
      limitResetsAt: a.state.status === "paused" && a.state.pauseReason === "limit" ? (a.state.limitResetsAt ?? null) : null,
      nextWake: a.state.nextWake,
      pausedUntil: a.state.pausedUntil ?? null,
      waiting: open,
      unread,
      helpersRunning: (await store.helpers()).filter((h) => h.status === "running").length,
      spentUsd: today.usd,
      costReported: today.costReported,
      tokensToday: today.tokens,
      budgetUsd: eff.dailyBudgetUsd,
      backend: eff.backend,
      model: eff.model,
      lastError: a.state.lastError,
      lastRunAt: a.state.lastRunAt ?? null,
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
    // Only the daemon holding the lock gets here (main.ts), so no other daemon of this version is
    // binding the socket at the same time. A socket file left behind is a dead daemon's; one that
    // answers belongs to a daemon that doesn't use this lock (an older version), never replace it.
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

  /** Start answering requests: the runtime has started. */
  open(): void {
    this.opened();
  }

  private async handle(line: string, sock: Socket): Promise<void> {
    let msg: { id?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // The socket is bound before the runtime starts (so a second daemon is turned away before it
    // touches any agent); requests wait until it has. Ping answers at once: it is how others see a daemon is here.
    if (msg.method !== "ping") await this.ready;
    const reply = (body: object) => !sock.destroyed && sock.write(JSON.stringify({ id: msg.id, ...body }) + "\n");
    const h = msg.method ? this.methods[msg.method] : undefined;
    if (!h) return void reply({ error: `Unknown method ${msg.method}` });
    const params: any = msg.params ?? {};
    if (typeof params.caller === "string" && params.caller) {
      if (!AGENT_CALLS.has(msg.method!)) return void reply({ error: personOnly(`"${msg.method}"`, msg.method, params.caller, params.name) });
      // Reading isn't the person reading: their unread count stays as it was.
      params.markRead = false;
    }
    try {
      reply({ result: await h(params, sock) });
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

/** Settings as sent by the app or the CLI (for `set`, and `new` with settings chosen up front). */
function settingsPatch({ backend, model, dailyBudgetUsd, dailyTokenBudget, workspace, protect, visibility, reflect, reflectModel }: Record<string, any>): SettingsPatch {
  return {
    backend: backend || undefined,
    model,
    dailyBudgetUsd: dailyBudgetUsd === undefined ? undefined : Number(dailyBudgetUsd),
    dailyTokenBudget: dailyTokenBudget === undefined ? undefined : dailyTokenBudget === null ? null : Number(dailyTokenBudget),
    workspace,
    protect: protect === undefined ? undefined : protect === null ? null : (Array.isArray(protect) ? protect : [protect]).map(String).filter(Boolean),
    visibility,
    reflect: reflect === undefined ? undefined : reflect === null ? null : reflect !== false && reflect !== "false",
    reflectModel,
  };
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
