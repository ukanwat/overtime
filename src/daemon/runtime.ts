import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAgent, effectiveSettings, listAgents, loadAgent, updateState, type Agent, type AgentState } from "../agent/agent.js";
import { newId } from "../fsutil.js";
import { paths } from "../paths.js";
import { loadSettings } from "../settings.js";
import { Store, clampWake } from "../store/store.js";
import type { HelperRecord, InboxItem, Monitor, ThreadEntry } from "../store/types.js";
import type { ToolContext, ToolHost } from "../tools/host.js";
import { ToolServer } from "../tools/server.js";
import { runTurn, sessionPreamble, UsageLimitError, type TurnResult } from "../runtime/turn.js";
import { blockedUntil, usageToday, type TurnUsage } from "../runtime/usage.js";
import { workingInstructions } from "../runtime/instructions.js";
import { MonitorRunner } from "./monitors.js";

const exec = promisify(execFile);

const TICK_MS = 5_000;
const DEFAULT_WAKE_MS = 60 * 60_000;
/** Start a fresh main session (rebuilt from the agent's files) once the context is this full. */
const FRESH_SESSION_AT = 0.6;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type ChangeEvent = { agent: string; what: "threads" | "state" | "schedule" | "monitors" | "helpers" | "agents" };

/** Everything that happens across all agents. Overtime's daemon. */
export class Runtime extends EventEmitter implements ToolHost {
  readonly tools = new ToolServer(this);
  readonly monitors: MonitorRunner;
  private stores = new Map<string, Store>();
  /** Agents whose main session is running right now. */
  private mainRunning = new Map<string, Promise<void>>();
  /** Wake reasons that arrived while a main turn was running. */
  private pendingWake = new Map<string, string[]>();
  /** One chat turn at a time per thread. */
  private chatQueues = new Map<string, Promise<void>>();
  private helperRuns = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly log: (line: string) => void) {
    super();
    this.monitors = new MonitorRunner(
      {
        fire: (agent, m, output) => void this.monitorFired(agent, m, output),
        failing: (agent, m, detail) => void this.monitorFailing(agent, m, detail),
        log,
      },
      (a) => this.store(a),
      (a) => paths.agent(a),
    );
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    await mkdir(paths.agentsDir(), { recursive: true });
    await this.tools.start();
    for (const a of await listAgents()) {
      if (a.state.status === "working") await updateState(a.name, { status: "asleep" }); // a turn interrupted by a restart
      if (a.state.status !== "stopped") await this.monitors.startAll(a.name);
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
    this.log("runtime started");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.monitors.stopAll();
    this.abort.abort();
    const all = [...this.mainRunning.values(), ...this.chatQueues.values(), ...this.helperRuns.values()];
    await Promise.race([Promise.allSettled(all), new Promise((r) => setTimeout(r, 15_000))]);
    await this.tools.stop();
    this.log("runtime stopped");
  }

  // ---------- ToolHost ----------

  store(agent: string): Store {
    let s = this.stores.get(agent);
    if (!s) this.stores.set(agent, (s = new Store(agent)));
    return s;
  }

  agentDir(agent: string): string {
    return paths.agent(agent);
  }

  changed(agent: string, what: ChangeEvent["what"]): void {
    this.emit("change", { agent, what } satisfies ChangeEvent);
  }

  async setActivity(agent: string, text: string): Promise<void> {
    await updateState(agent, { activity: text.slice(0, 80) });
    this.changed(agent, "state");
  }

  notify(title: string, body: string): void {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
    if (process.platform === "darwin") {
      execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, body], () => {});
    }
  }

  async spentToday(agent: string) {
    const a = await loadAgent(agent);
    const eff = await effectiveSettings(a);
    const u = await usageToday(agent);
    return { usd: u.usd, costReported: u.costReported, tokens: u.tokens, budgetUsd: eff.dailyBudgetUsd, budgetTokens: eff.dailyTokenBudget };
  }

  wakeMain(agent: string, reason: string): void {
    if (this.stopping) return;
    if (this.mainRunning.has(agent)) {
      const q = this.pendingWake.get(agent) ?? [];
      q.push(reason);
      this.pendingWake.set(agent, q);
      return;
    }
    const run = this.runMain(agent, reason).finally(() => {
      this.mainRunning.delete(agent);
      const pending = this.pendingWake.get(agent);
      this.pendingWake.delete(agent);
      if (pending?.length && !this.stopping) this.wakeMain(agent, pending.join("; "));
    });
    this.mainRunning.set(agent, run);
  }

  async helpers(agent: string) {
    return (await this.store(agent).helpers()).map((h) => ({ id: h.id, task: h.task, status: h.status, startedAt: h.startedAt, finishedAt: h.finishedAt, workdir: h.workdir }));
  }

  startMonitor(agent: string, id: string): void {
    this.monitors.start(agent, id);
  }

  stopMonitor(agent: string, id: string): void {
    this.monitors.stop(agent, id);
  }

  // ---------- the clock ----------

  private async tick(): Promise<void> {
    if (this.stopping) return;
    let agents: Agent[];
    try {
      agents = await listAgents();
    } catch (e: any) {
      this.log(`tick: ${e?.message ?? e}`);
      return;
    }
    const now = new Date();
    for (const a of agents) {
      try {
        await this.checkAgent(a, now);
      } catch (e: any) {
        this.log(`[${a.name}] tick: ${e?.message ?? e}`);
      }
    }
  }

  private async checkAgent(a: Agent, now: Date): Promise<void> {
    if (a.state.status === "stopped" || this.mainRunning.has(a.name)) return;
    const store = this.store(a.name);
    if (a.state.status === "paused") {
      if (a.state.pausedUntil && new Date(a.state.pausedUntil) > now) return;
      await updateState(a.name, { status: "asleep", pausedUntil: null });
      this.changed(a.name, "state");
    }
    const sched = await store.schedule();
    // After a failed turn, wait out the back-off even if there's work waiting (a new message from the person still retries at once).
    if ((a.state.failures ?? 0) > 0 && sched.wakeAt && new Date(sched.wakeAt) > now) return;
    // Loops that came due become inbox items, so they wake the agent like anything else.
    for (const l of await store.takeDueLoops(now)) await store.pushInbox({ type: "loop", text: l.task, data: { loopId: l.id } });
    const inbox = await store.inbox();
    if (a.state.status === "new") {
      // A new agent does nothing until it has been told what it's for.
      if (inbox.length) this.wakeMain(a.name, "the person sent you your first message");
      return;
    }
    if (inbox.length) return this.wakeMain(a.name, describeInbox(inbox));
    if (sched.wakeAt && new Date(sched.wakeAt) <= now) return this.wakeMain(a.name, `your scheduled wake-up: ${sched.wakeReason ?? "no reason given"}`);
    if (!sched.wakeAt && a.state.status === "asleep") {
      // Never let an agent go quiet indefinitely.
      await store.setWake(clampWake(new Date(now.getTime() + DEFAULT_WAKE_MS)), "routine check-in (no wake-up was set)");
    }
  }

  // ---------- main sessions ----------

  private async runMain(agentName: string, reason: string): Promise<void> {
    const store = this.store(agentName);
    let agent = await loadAgent(agentName);
    if (agent.state.status === "stopped") return;
    const eff = await effectiveSettings(agent);

    // Subscription limit: pause until the reset, without counting it as a failure.
    const blocked = await blockedUntil(eff.backend);
    if (blocked) {
      await updateState(agentName, { status: "paused", pausedUntil: blocked.toISOString(), activity: `paused: ${eff.backend} usage limit` });
      this.changed(agentName, "state");
      return;
    }

    // Daily budget, from what the backend reported.
    const today = await usageToday(agentName);
    const overUsd = today.costReported && today.usd >= eff.dailyBudgetUsd;
    const overTokens = eff.dailyTokenBudget != null && today.tokens >= eff.dailyTokenBudget;
    if (overUsd || overTokens) {
      const tomorrow = new Date();
      tomorrow.setHours(24, 5, 0, 0);
      const already = agent.state.pausedUntil && new Date(agent.state.pausedUntil) >= tomorrow;
      await updateState(agentName, { status: "paused", pausedUntil: tomorrow.toISOString(), activity: "paused: daily budget used" });
      if (!already) {
        await store.startThread({
          kind: "alert",
          title: "Daily budget used",
          from: "overtime",
          text: overUsd
            ? `${agentName} has used $${today.usd.toFixed(2)} today (budget $${eff.dailyBudgetUsd.toFixed(2)}, as reported by ${eff.backend}). It will resume tomorrow. Raise the budget in its AGENT.md settings if you want it to keep going.`
            : `${agentName} has used ${today.tokens.toLocaleString()} tokens today (budget ${eff.dailyTokenBudget!.toLocaleString()}). It will resume tomorrow.`,
          baseDir: agent.dir,
        });
        this.changed(agentName, "threads");
      }
      this.changed(agentName, "state");
      return;
    }

    const items = await store.takeInbox();
    const firstJob = agent.state.status === "new";
    await updateState(agentName, { status: "working", activity: agent.state.activity && !firstJob ? agent.state.activity : firstJob ? "learning its job" : "working" });
    this.changed(agentName, "state");

    // Continue the main session unless the backend changed or its context is getting full.
    const lastCtx = await lastContext(agentName, agent.state.mainSessionId);
    const resume =
      agent.state.mainSessionId && agent.state.mainSessionBackend === eff.backend && !(lastCtx && lastCtx.size > 0 && lastCtx.used / lastCtx.size >= FRESH_SESSION_AT)
        ? agent.state.mainSessionId
        : null;

    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "main", depth: 0 });
    const settings = await loadSettings();
    let result: TurnResult | null = null;
    try {
      result = await runTurn({
        agent: agentName,
        kind: "main",
        reason,
        text: mainTurnText(items, firstJob, resume === null && !!agent.state.mainSessionId),
        resumeSessionId: resume,
        extraMcp: [mcp],
        timeoutMs: settings.turnTimeoutMinutes * 60_000,
        signal: this.abort.signal,
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "main", update: u }),
        log: this.log,
      });
      agent = await loadAgent(agentName);
      const patch: Partial<AgentState> = { status: "asleep", failures: 0, lastError: null };
      // Keep whatever status line the agent set itself; only replace Overtime's own placeholder.
      if (agent.state.activity === "learning its job" || agent.state.activity === "working") patch.activity = firstJob ? "settled in" : "resting";
      await updateState(agentName, patch);
      if (!ctx.wakeChosen) {
        await store.setWake(clampWake(new Date(Date.now() + DEFAULT_WAKE_MS)), "default wake-up: you didn't choose one last turn (use sleep_until)");
      }
    } catch (e: any) {
      if (items.length) await store.returnInbox(items);
      if (e instanceof UsageLimitError) {
        const until = e.resetsAt ?? new Date(Date.now() + 15 * 60_000);
        await updateState(agentName, { status: "paused", pausedUntil: until.toISOString(), activity: `paused: ${e.backend} usage limit` });
        this.log(`[${agentName}] paused until ${until.toISOString()}: usage limit`);
      } else {
        const failures = (agent.state.failures ?? 0) + 1;
        const wait = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, failures - 1)];
        await updateState(agentName, { status: firstJob ? "new" : "asleep", failures, lastError: String(e?.message ?? e).slice(0, 500) });
        await store.setWake(new Date(Date.now() + wait), `retry after an error: ${String(e?.message ?? e).slice(0, 200)}`);
        this.log(`[${agentName}] main turn failed (${failures}): ${e?.stack ?? e}`);
        if (failures === 3) {
          await store.startThread({ kind: "alert", title: "Something keeps failing", from: "overtime", text: `${agentName}'s last ${failures} turns failed. Latest error:\n\n${String(e?.message ?? e)}\n\nOvertime keeps retrying with longer gaps.`, urgent: true, baseDir: agent.dir });
          this.notify(`${agentName} keeps failing`, String(e?.message ?? e));
          this.changed(agentName, "threads");
        }
      }
    } finally {
      this.tools.close(ctx.token);
      await this.refreshNextWake(agentName);
      this.changed(agentName, "state");
    }
  }

  /** Keep state.nextWake in sync: the earliest of its wake-up and loops. */
  private async refreshNextWake(agent: string): Promise<void> {
    const s = await this.store(agent).schedule();
    const times = [s.wakeAt, ...s.loops.map((l) => l.nextAt)].filter(Boolean).map((t) => new Date(t as string).getTime());
    await updateState(agent, { nextWake: times.length ? new Date(Math.min(...times)).toISOString() : null });
  }

  // ---------- people talking to agents ----------

  /** A message from the person. Returns the thread it went into. */
  async send(agentName: string, text: string, threadId?: string): Promise<string> {
    const agent = await loadAgent(agentName);
    const store = this.store(agentName);
    let tid = threadId;
    if (tid) await store.addToThread(tid, { from: "you", text, baseDir: agent.dir });
    else tid = await store.startThread({ kind: "conversation", title: text.split("\n")[0], from: "you", text, baseDir: agent.dir });
    await store.markRead(tid);
    this.changed(agentName, "threads");
    if (agent.state.status === "new" || agent.state.status === "stopped") {
      // Before it has a job, and while stopped, every message goes straight to its main session.
      await store.pushInbox({ type: "message", text, threadId: tid });
      if (agent.state.status === "new") this.wakeMain(agentName, "the person sent you your first message");
    } else {
      this.queueChat(agentName, tid, text);
    }
    return tid;
  }

  /** The person answered a question: pick an option and/or write something. */
  async answer(agentName: string, threadId: string, choice?: number, text?: string): Promise<void> {
    const agent = await loadAgent(agentName);
    const store = this.store(agentName);
    const th = await store.thread(threadId);
    if (!th) throw new Error(`No thread ${threadId}.`);
    const q = [...th.entries].reverse().find((e) => e.from === "agent" && e.options?.length);
    const picked = choice && q?.options ? q.options[choice - 1] : undefined;
    if (choice && !picked) throw new Error(`There is no option ${choice}.`);
    const answerText = [picked ? `${choice}. ${picked}` : "", text ?? ""].filter(Boolean).join(" — ");
    if (!answerText) throw new Error("Pick an option or write an answer.");
    await store.addToThread(threadId, { from: "you", text: answerText, choice, baseDir: agent.dir });
    await store.patchThread(threadId, { status: "answered", unread: 0 });
    await store.recordDecision({ threadId, category: th.meta.category ?? "uncategorised", question: q?.text ?? th.meta.title, answer: answerText });
    await store.pushInbox({ type: "answer", text: answerText, threadId, data: { question: q?.text ?? th.meta.title } });
    this.changed(agentName, "threads");
    if (agent.state.status !== "stopped") this.wakeMain(agentName, "the person answered one of your questions");
  }

  private queueChat(agentName: string, threadId: string, text: string): void {
    const key = `${agentName}/${threadId}`;
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.runChat(agentName, threadId, text))
      .catch((e) => this.log(`[${agentName}] chat failed: ${e?.stack ?? e}`))
      .finally(() => {
        if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
      });
    this.chatQueues.set(key, next);
  }

  private async runChat(agentName: string, threadId: string, text: string): Promise<void> {
    const store = this.store(agentName);
    const agent = await loadAgent(agentName);
    const th = await store.thread(threadId);
    if (!th) return;
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "chat", threadId, depth: 0 });
    const before = th.entries.length;
    try {
      const state = await this.stateSummary(agentName);
      const history = th.entries
        .slice(0, -1)
        .map((e) => `${e.from === "you" ? "Person" : e.from === "agent" ? "You" : "Overtime"} (${e.t}): ${e.text}`)
        .join("\n\n");
      const r = await runTurn({
        agent: agentName,
        kind: "chat",
        reason: "the person sent you a message in a conversation thread",
        preamble: chatPreamble(agent),
        resumeSessionId: th.meta.chatSessionId ?? null,
        text: `${th.meta.chatSessionId ? "" : `What you are doing right now (from your main session):\n${state}\n\n${history ? `Earlier in this thread:\n${history}\n\n` : ""}`}The person just wrote:\n\n${text}\n\nAnswer them with reply(). If this changes your work or needs real work done, call pass_to_main() with what to do, and tell them you've passed it on.`,
        extraMcp: [mcp],
        timeoutMs: 20 * 60_000,
        signal: this.abort.signal,
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "chat", threadId, update: u }),
        log: this.log,
      });
      await store.patchThread(threadId, { chatSessionId: r.sessionId });
      // If it didn't use reply(), its final words are the reply, so the person always gets an answer.
      const after = (await store.thread(threadId))?.entries ?? [];
      const replied = after.slice(before).some((e) => e.from === "agent");
      if (!replied && r.reply) await store.addToThread(threadId, { from: "agent", text: r.reply, baseDir: agent.dir });
    } catch (e: any) {
      const msg = e instanceof UsageLimitError ? `I'm paused by the ${e.backend} usage limit${e.resetsAt ? ` until ${e.resetsAt.toLocaleTimeString()}` : ""}. I've kept your message and will pick it up then.` : `I couldn't answer just now (${String(e?.message ?? e).slice(0, 200)}). I've passed your message to my main session.`;
      await store.addToThread(threadId, { from: "overtime", text: msg, baseDir: agent.dir });
      await store.pushInbox({ type: "message", text, threadId });
      if (!(e instanceof UsageLimitError)) this.wakeMain(agentName, "a chat session failed, so the person's message came to you");
    } finally {
      this.tools.close(ctx.token);
      this.changed(agentName, "threads");
    }
  }

  private async stateSummary(agentName: string): Promise<string> {
    const a = await loadAgent(agentName);
    const store = this.store(agentName);
    const reports = await store.reports(8);
    const sched = await store.schedule();
    const helpers = (await store.helpers()).filter((h) => h.status === "running");
    const lines = [
      `Status: ${a.state.status}${a.state.activity ? ` — ${a.state.activity}` : ""}`,
      `Next wake: ${sched.wakeAt ?? "not set"}${sched.wakeReason ? ` (${sched.wakeReason})` : ""}`,
      helpers.length ? `Helpers running: ${helpers.map((h) => h.task.split("\n")[0].slice(0, 80)).join("; ")}` : "Helpers running: none",
      reports.length ? `Recent reports:\n${reports.map((r) => `- ${r.t}: ${r.text.split("\n")[0].slice(0, 200)}`).join("\n")}` : "Recent reports: none",
    ];
    return lines.join("\n");
  }

  // ---------- helpers ----------

  async spawnHelper(ctx: ToolContext, req: { role?: string; instructions?: string; task: string; backend?: string; model?: string }): Promise<{ id: string; workdir: string }> {
    const store = this.store(ctx.agent);
    const agent = await loadAgent(ctx.agent);
    const eff = await effectiveSettings(agent);
    const role = req.role ? (await store.roles()).find((r) => r.name === req.role) : undefined;
    if (req.role && !role) throw new Error(`No saved role "${req.role}". Define it with define_role, or pass instructions.`);
    const running = (await store.helpers()).filter((h) => h.status === "running").length;
    if (running >= 6) throw new Error("Six helpers are already running. Wait for some to finish.");
    const id = newId("helper");
    const base = join(paths.meta(ctx.agent), "helpers", id);
    await mkdir(base, { recursive: true });
    let workdir = join(base, "work");
    let branch: string | undefined;
    if (await isGitRepo(eff.workspace)) {
      branch = `overtime/${ctx.agent}/${id}`;
      try {
        await exec("git", ["-C", eff.workspace, "worktree", "add", "-b", branch, workdir], { timeout: 60_000 });
      } catch (e: any) {
        this.log(`[${ctx.agent}] worktree failed, using a scratch folder: ${e?.message ?? e}`);
        branch = undefined;
        await mkdir(workdir, { recursive: true });
      }
    } else {
      await mkdir(workdir, { recursive: true });
    }
    const rec: HelperRecord = {
      id,
      task: req.task,
      role: req.role,
      backend: req.backend ?? role?.backend,
      model: req.model ?? role?.model ?? null,
      workdir,
      branch,
      parent: ctx.helperId ?? "main",
      depth: ctx.depth + 1,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    await store.saveHelper(rec);
    const run = this.runHelper(ctx.agent, rec, role?.instructions ?? req.instructions ?? "", eff.workspace)
      .catch((e) => this.log(`[${ctx.agent}] helper ${id}: ${e?.stack ?? e}`))
      .finally(() => this.helperRuns.delete(`${ctx.agent}/${id}`));
    this.helperRuns.set(`${ctx.agent}/${id}`, run);
    return { id, workdir };
  }

  private async runHelper(agentName: string, rec: HelperRecord, instructions: string, workspace: string): Promise<void> {
    const store = this.store(agentName);
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "helper", helperId: rec.id, depth: rec.depth });
    const preamble = helperPreamble(agentName, rec, instructions, workspace);
    try {
      const r = await runTurn({
        agent: agentName,
        kind: "helper",
        reason: `${agentName} gave you a task`,
        text: `Your task:\n\n${rec.task}`,
        preamble,
        cwd: rec.workdir,
        backend: rec.backend,
        model: rec.model ?? undefined,
        extraMcp: [mcp],
        timeoutMs: (await loadSettings()).turnTimeoutMinutes * 60_000,
        signal: this.abort.signal,
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "helper", helperId: rec.id, update: u }),
        log: this.log,
      });
      rec.status = "done";
      rec.result = ctx.result ?? r.reply ?? "(no result given)";
    } catch (e: any) {
      rec.status = "failed";
      rec.result = `The helper failed: ${String(e?.message ?? e)}`;
    } finally {
      this.tools.close(ctx.token);
    }
    rec.finishedAt = new Date().toISOString();
    await store.saveHelper(rec);
    await store.pushInbox({
      type: "helper",
      text: `${rec.status === "done" ? "Finished" : "Failed"}: ${rec.task.split("\n")[0].slice(0, 120)}\n\n${rec.result}\n\nIts work is in ${rec.workdir}${rec.branch ? ` (git branch ${rec.branch}; review and merge it into the workspace, then remove the worktree with \`git worktree remove ${rec.workdir}\`)` : ""}.`,
      data: { helperId: rec.id },
    });
    this.changed(agentName, "helpers");
    this.wakeMain(agentName, `helper ${rec.id} ${rec.status === "done" ? "finished" : "failed"}`);
  }

  // ---------- monitors ----------

  private async monitorFired(agent: string, m: Monitor, output: string): Promise<void> {
    await this.store(agent).pushInbox({ type: "monitor", text: `Monitor ${m.id} fired.\nYou set it because: ${m.why}\nOutput:\n${output.slice(0, 8000)}`, data: { monitorId: m.id } });
    this.changed(agent, "monitors");
    this.wakeMain(agent, `monitor fired: ${m.why}`);
  }

  private async monitorFailing(agent: string, m: Monitor, detail: string): Promise<void> {
    await this.store(agent).pushInbox({ type: "system", text: `Your monitor ${m.id} keeps failing (${m.why}).\nCommand: ${m.run}\nLatest: ${detail.slice(0, 2000)}\nFix it (unwatch and watch again with a working command) or remove it.`, data: { monitorId: m.id } });
    this.wakeMain(agent, `a monitor keeps failing: ${m.why}`);
  }

  // ---------- managing agents ----------

  async create(name: string, settings: { backend?: string; model?: string | null } = {}): Promise<Agent> {
    const a = await createAgent(name, Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null)) as any);
    // The greeting costs nothing: Overtime writes it, not the model.
    await this.store(name).startThread({
      kind: "conversation",
      title: "Hi, I don't have a job yet",
      from: "agent",
      text: `Hi, I'm ${name}. I don't have a job yet. What should I be looking after, and is there anything I should always check with you first?`,
      baseDir: a.dir,
    });
    this.changed(name, "agents");
    return a;
  }

  async stopAgent(name: string): Promise<void> {
    await updateState(name, { status: "stopped", nextWake: null, activity: "stopped" });
    this.monitors.stopAgent(name);
    this.changed(name, "state");
  }

  async startAgent(name: string): Promise<void> {
    const a = await loadAgent(name);
    if (a.state.status !== "stopped" && a.state.status !== "paused") return;
    const hadJob = (await readFile(join(a.dir, "AGENT.md"), "utf8")).indexOf("No identity yet.") === -1;
    await updateState(name, { status: hadJob ? "asleep" : "new", pausedUntil: null, activity: hadJob ? "resuming" : "waiting for its job" });
    await this.monitors.startAll(name);
    if (hadJob) this.wakeMain(name, "the person started you again");
    this.changed(name, "state");
  }
}

// ---------- prompt text ----------

function describeInbox(items: InboxItem[]): string {
  const kinds = new Set(items.map((i) => i.type));
  const words: Record<string, string> = { message: "a message from the person", answer: "an answer to your question", monitor: "a monitor fired", helper: "a helper finished", loop: "a recurring task came due", system: "a note from Overtime" };
  return [...kinds].map((k) => words[k] ?? k).join(", ");
}

function inboxBlock(items: InboxItem[]): string {
  if (!items.length) return "Your inbox is empty.";
  return (
    `Your inbox (${items.length}):\n\n` +
    items
      .map((i, n) => {
        const head =
          i.type === "message"
            ? `Message from the person${i.threadId ? ` (thread ${i.threadId})` : ""}`
            : i.type === "answer"
              ? `The person answered your question${i.threadId ? ` (thread ${i.threadId})` : ""}: "${String((i.data as any)?.question ?? "").slice(0, 200)}"`
              : i.type === "monitor"
                ? "Monitor fired"
                : i.type === "helper"
                  ? "Helper result"
                  : i.type === "loop"
                    ? "Recurring task"
                    : "From Overtime";
        return `${n + 1}. ${head} — ${i.t}\n${i.text}`;
      })
      .join("\n\n")
  );
}

function mainTurnText(items: InboxItem[], firstJob: boolean, contextReset: boolean): string {
  const parts: string[] = [];
  if (firstJob) {
    parts.push(
      "This is your first conversation. You don't have an identity yet. From what the person tells you, rewrite AGENT.md in your folder: who you are, your job, what good looks like, and your rules (what you must check with them first). Create INDEX.md. Then reply in their thread with a short summary of what you understood and what you'll do first, and start.",
    );
  }
  if (contextReset) parts.push("Note: this is a fresh session. Your earlier conversation isn't carried over; your folder is. Check INDEX.md and your notes for where things stand.");
  parts.push(inboxBlock(items));
  parts.push("Reply to every message with reply(thread_id, ...). Do the work. Before you end this turn, make sure your notes and INDEX.md are current, and call sleep_until with when you should next wake.");
  return parts.join("\n\n");
}

function chatPreamble(agent: Agent): string {
  return `${sessionPreamble(agent)}\n\n---\n\n# This session\n\nThis is a conversation thread with the person, separate from your main work session. Answer from what you know and what's in your folder. Keep replies short and plain. Anything that changes your work or needs real work goes to your main session with pass_to_main.`;
}

function helperPreamble(agentName: string, rec: HelperRecord, instructions: string, workspace: string): string {
  return `${workingInstructions(`a helper working for ${agentName}`)}

---

# This session

You are a helper started by ${agentName} for one task. You start clean: everything you need is in your task, your instructions, and the files you're pointed to. You don't talk to the person; ${agentName} reviews your work.

Work in: ${rec.workdir}${rec.branch ? ` (a git worktree of ${workspace}, on branch ${rec.branch}; commit your work there)` : ""}
The main workspace is ${workspace}; don't change it directly.

When you're finished, call done() with what you did, where the output is, what you checked, and anything left open. Then end your turn.
${instructions ? `\n# Your role\n\n${instructions}\n` : ""}`;
}

async function lastContext(agent: string, sessionId: string | null): Promise<{ used: number; size: number } | null> {
  if (!sessionId) return null;
  const { readJsonl } = await import("../fsutil.js");
  const rows = await readJsonl<TurnUsage>(join(paths.meta(agent), "usage.jsonl"));
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].sessionId === sessionId && rows[i].context) return rows[i].context;
  return null;
}

async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000 });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export type { ThreadEntry };
