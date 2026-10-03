import { EventEmitter } from "node:events";
import { skillsBlock } from "../skills.js";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { adoptSettingsEdit, createAgent, effectiveSettings, hasIdentity, listAgents, loadAgent, updateState, type Agent, type AgentState } from "../agent/agent.js";
import { newId } from "../fsutil.js";
import { paths } from "../paths.js";
import { loadSettings } from "../settings.js";
import { withLock } from "../store/mutex.js";
import { Store, clampWake } from "../store/store.js";
import type { Attachment, HelperRecord, InboxItem, Message, Monitor } from "../store/types.js";
import { receiveAttachments } from "../store/attachments.js";
import type { ToolContext, ToolHost } from "../tools/host.js";
import { ToolServer } from "../tools/server.js";
import { AcpSession } from "../acp/session.js";
import { runTurn, sessionPreamble, TurnIncompleteError, UsageLimitError, type TurnResult } from "../runtime/turn.js";
import { blockedUntil, usageToday, type TurnUsage } from "../runtime/usage.js";
import { workingInstructions } from "../runtime/instructions.js";
import { MonitorRunner, reapStaleMonitors } from "./monitors.js";
import { needsPerson } from "../runtime/errors.js";

const exec = promisify(execFile);

const TICK_MS = 5_000;
const DEFAULT_WAKE_MS = 60 * 60_000;
/** Start a fresh main session (rebuilt from the agent's files) once the context is this full. */
const FRESH_SESSION_AT = 0.6;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Status lines Overtime itself writes (as opposed to the agent's own): replaced when they stop being true. */
const OVERTIME_ACTIVITY = /^(learning its job|working|resuming|resting|stopped|paused\b.*)$/;
const MAX_HELPERS = 6;
/** Finished helpers' worktrees and copies are removed after this long (git branches are kept). */
const HELPER_KEEP_MS = 7 * 24 * 3600_000;
/** A non-git workspace is copied for a helper only below these sizes; above, the helper gets an empty folder. */
/** Run transcripts older than this are removed. */
const RUN_KEEP_MS = 30 * 24 * 3600_000;
const COPY_MAX_FILES = 5_000;
const COPY_MAX_BYTES = 200 * 1024 * 1024;

export type ChangeEvent = { agent: string; what: "messages" | "state" | "schedule" | "monitors" | "helpers" | "agents" };

/** Why an agent can't spend right now (usage limit or daily budget), or null if it can. */
type Blocked = { kind: "limit"; until: Date; backend: string } | { kind: "budget"; until: Date; text: string };

/** An abort signal that fires when any of the given ones does. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      break;
    }
    s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}

/** Everything that happens across all agents. Overtime's daemon. */
export class Runtime extends EventEmitter implements ToolHost {
  readonly tools = new ToolServer(this);
  readonly monitors: MonitorRunner;
  private stores = new Map<string, Store>();
  /** Agents whose main session is running right now. */
  private mainRunning = new Map<string, Promise<boolean>>();
  /** Wake reasons that arrived while a main turn was running. */
  private pendingWake = new Map<string, string[]>();
  /** One chat turn at a time per thread. */
  private chatQueues = new Map<string, Promise<void>>();
  private helperRuns = new Map<string, Promise<void>>();
  /** Cancels a single helper. */
  private helperAborts = new Map<string, AbortController>();
  /** Cancels everything one agent is running (stopping it). */
  private agentAborts = new Map<string, AbortController>();
  /** Everything (daemon shutdown). */
  private abort = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastCleanup = 0;
  private stopping = false;

  constructor(private readonly log: (line: string) => void) {
    super();
    this.monitors = new MonitorRunner(
      {
        fire: (agent, m, output) => void this.monitorFired(agent, m, output).catch((e) => this.log(`[${agent}] monitor: ${e?.message ?? e}`)),
        failing: (agent, m, detail) => void this.monitorFailing(agent, m, detail).catch((e) => this.log(`[${agent}] monitor: ${e?.message ?? e}`)),
        log,
      },
      (a) => this.store(a),
      (a) => paths.agent(a),
      async (a) => (await effectiveSettings(await loadAgent(a))).protect,
    );
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    await mkdir(paths.agentsDir(), { recursive: true });
    const reaped = reapStaleMonitors();
    if (reaped) this.log(`killed ${reaped} watch process(es) left by an earlier daemon`);
    await this.tools.start();
    for (const a of await listAgents()) {
      try {
        await this.recover(a);
      } catch (e: any) {
        this.log(`[${a.name}] recovery: ${e?.stack ?? e}`);
      }
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
    this.log("runtime started");
  }

  /** Pick up where an earlier daemon left off: nothing the person sent or the agent was due is lost. */
  private async recover(a: Agent): Promise<void> {
    const store = this.store(a.name);
    if (a.state.status === "working") await updateState(a.name, { status: hasIdentity(a) ? "asleep" : "new" });
    const returned = await store.recoverInflight();
    if (returned) this.log(`[${a.name}] ${returned} inbox item(s) from an interrupted turn are back in its inbox`);
    // Helpers that were running when the daemon died can't be resumed: tell the agent, with where their work is.
    for (const h of await store.helpers()) {
      if (h.status !== "running") continue;
      h.status = "failed";
      h.finishedAt = new Date().toISOString();
      h.result = "Overtime was restarted while this helper was running, so it was cut off.";
      await store.saveHelper(h);
      await store.pushInbox({ type: "helper", text: helperInboxText(h), data: { helperId: h.id } });
    }
    if (a.state.status !== "stopped") await this.monitors.startAll(a.name);
    // Conversation messages whose chat turn never ran: answer them now.
    if (a.state.status === "new" || a.state.status === "stopped") return;
    // A message from the person that never got its chat turn: answer it now.
    const all = await store.messages();
    const last = all.at(-1);
    const queued = new Set((await store.inbox()).map((i) => i.messageId).filter(Boolean));
    if (last?.from === "you" && !last.replyTo && !queued.has(last.id)) this.queueChat(a.name, last);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.monitors.stopAll();
    this.abort.abort();
    const all = [...this.mainRunning.values(), ...this.chatQueues.values(), ...this.helperRuns.values()];
    await Promise.race([Promise.allSettled(all), new Promise((r) => setTimeout(r, 25_000))]);
    // Whatever didn't stop politely is killed, so no backend outlives the daemon.
    await AcpSession.closeAll();
    await this.tools.stop();
    this.log("runtime stopped");
  }

  /** The signal for anything an agent runs: fires on shutdown or when the agent is stopped. */
  private signalFor(agent: string, extra?: AbortSignal): AbortSignal {
    let c = this.agentAborts.get(agent);
    if (!c || c.signal.aborted) this.agentAborts.set(agent, (c = new AbortController()));
    return anySignal([this.abort.signal, c.signal, ...(extra ? [extra] : [])]);
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
    if (what === "schedule") void this.refreshNextWake(agent).catch(() => {});
  }

  async setActivity(agent: string, text: string): Promise<void> {
    await updateState(agent, { activity: text.replace(/\s+/g, " ").trim().slice(0, 80) });
    this.changed(agent, "state");
  }

  notify(title: string, body: string): void {
    // Passed as arguments to a fixed script, never spliced into code, so no text can run as AppleScript.
    const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
    if (process.platform === "darwin") {
      execFile("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", clean(title), clean(body)], () => {});
    } else if (process.platform === "linux") {
      execFile("notify-send", ["--", clean(title), clean(body)], () => {});
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
    const run = this.runMain(agent, reason)
      .catch((e) => {
        this.log(`[${agent}] main: ${e?.stack ?? e}`);
        return false;
      })
      .then((ok) => {
        this.mainRunning.delete(agent);
        const pending = this.pendingWake.get(agent);
        this.pendingWake.delete(agent);
        // After a failure, the back-off decides when to try again; the clock picks up anything waiting.
        if (ok && pending?.length && !this.stopping) this.wakeMain(agent, pending.join("; "));
        return ok;
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
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
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
      if (now.getTime() - this.lastCleanup > 3600_000) {
        this.lastCleanup = now.getTime();
        for (const a of agents) {
          await this.cleanupHelpers(a.name).catch((e) => this.log(`[${a.name}] cleanup: ${e?.message ?? e}`));
          await this.cleanupRuns(a.name).catch((e) => this.log(`[${a.name}] cleanup: ${e?.message ?? e}`));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Whether any session of this agent is running (its AGENT.md may be mid-rewrite), other than `self`. */
  private busy(agent: string, self?: "main" | string): boolean {
    if (self !== "main" && this.mainRunning.has(agent)) return true;
    for (const k of this.chatQueues.keys()) if (k.startsWith(`${agent}/`) && k !== self) return true;
    return false;
  }

  /**
   * A changed settings block in AGENT.md while none of the agent's sessions is running can only be the
   * person's edit: adopt it. Checked on every tick and right before each turn, so an edit followed by a
   * message takes effect for that message.
   */
  private async adoptEdits(agent: string, self?: "main" | string): Promise<void> {
    if (!this.busy(agent, self) && (await adoptSettingsEdit(agent))) this.log(`[${agent}] adopted the settings you edited in AGENT.md`);
  }

  private async checkAgent(a: Agent, now: Date): Promise<void> {
    await this.adoptEdits(a.name);
    a = await loadAgent(a.name);
    if (a.state.status === "stopped" || this.mainRunning.has(a.name)) return;
    const store = this.store(a.name);
    if (a.state.status === "paused") {
      // A budget pause lifts as soon as the budget is raised; a limit pause when the limit resets.
      const lifted = a.state.activity === "paused: daily budget used" && !(await this.blocked(a.name));
      if (!lifted && a.state.pausedUntil && new Date(a.state.pausedUntil) > now) return;
      await updateState(a.name, { status: hasIdentity(a) ? "asleep" : "new", pausedUntil: null, ...(OVERTIME_ACTIVITY.test(a.state.activity ?? "") ? { activity: hasIdentity(a) ? "resting" : "waiting for its job" } : {}) });
      this.changed(a.name, "state");
      a = await loadAgent(a.name);
    }
    const sched = await store.schedule();
    // After a failed turn, wait out the back-off even if there's work waiting.
    if ((a.state.failures ?? 0) > 0 && sched.wakeAt && new Date(sched.wakeAt) > now) return;
    if (a.state.status === "new") {
      // A new agent does nothing until it has been told what it's for.
      if ((await store.inbox()).length) this.wakeMain(a.name, "the person sent you your first message");
      return;
    }
    // Loops that came due become inbox items, so they wake the agent like anything else.
    const due = await store.takeDueLoops(now);
    for (const l of due) await store.pushInbox({ type: "loop", text: l.task, data: { loopId: l.id } });
    if (due.length) await this.refreshNextWake(a.name);
    const inbox = await store.inbox();
    if (inbox.length) return this.wakeMain(a.name, describeInbox(inbox));
    if (sched.wakeAt && new Date(sched.wakeAt) <= now) return this.wakeMain(a.name, `your scheduled wake-up: ${sched.wakeReason ?? "no reason given"}`);
    // Never let an agent go quiet indefinitely; a repeating wake or a watch already brings it back.
    const watching = sched.loops.length > 0 || (await store.monitors()).some((m) => m.status !== "removed");
    if (!sched.wakeAt && !watching && a.state.status === "asleep") {
      await store.setWake(clampWake(new Date(now.getTime() + DEFAULT_WAKE_MS)), "routine check-in (no wake-up was set)");
      await this.refreshNextWake(a.name);
      this.changed(a.name, "state");
    }
  }

  /** Usage limit or daily budget: whether this agent may spend right now. */
  private async blocked(agentName: string, backend?: string): Promise<Blocked | null> {
    const agent = await loadAgent(agentName);
    const eff = await effectiveSettings(agent);
    const b = backend ?? eff.backend;
    const until = await blockedUntil(b);
    if (until) return { kind: "limit", until, backend: b };
    const today = await usageToday(agentName);
    const overUsd = today.costReported && today.usd >= eff.dailyBudgetUsd;
    const overTokens = eff.dailyTokenBudget != null && today.tokens >= eff.dailyTokenBudget;
    if (!overUsd && !overTokens) return null;
    const tomorrow = new Date();
    tomorrow.setHours(24, 5, 0, 0);
    const text = overUsd
      ? `${agentName} has used $${today.usd.toFixed(2)} today (budget $${eff.dailyBudgetUsd.toFixed(2)}, as reported by ${eff.backend}). It resumes tomorrow. To keep it going today, raise its daily budget in Settings (→), or run: overtime set ${agentName} budget=…`
      : `${agentName} has used ${today.tokens.toLocaleString()} tokens today (budget ${eff.dailyTokenBudget!.toLocaleString()}). It resumes tomorrow. To keep it going today, raise its token budget in Settings (→), or run: overtime set ${agentName} tokens=…`;
    return { kind: "budget", until: tomorrow, text };
  }

  /** Pause an agent that can't spend; the budget alert is posted once per pause, before any other note about it. */
  private async pauseFor(agentName: string, b: Blocked): Promise<void> {
    const agent = await loadAgent(agentName);
    const already = agent.state.status === "paused" && agent.state.pausedUntil && new Date(agent.state.pausedUntil) >= b.until;
    await updateState(agentName, { status: "paused", pausedUntil: b.until.toISOString(), activity: b.kind === "limit" ? `paused: ${b.backend} usage limit` : "paused: daily budget used" });
    if (b.kind === "budget" && !already) {
      await this.store(agentName).addMessage({ from: "overtime", kind: "alert", title: "Daily budget used", text: b.text, baseDir: agent.dir });
      this.changed(agentName, "messages");
    }
    this.changed(agentName, "state");
  }

  private blockedLine(b: Blocked): string {
    return b.kind === "limit" ? `paused by the ${b.backend} usage limit until ${b.until.toLocaleString()}` : `paused: today's budget is used, back ${b.until.toLocaleString()}`;
  }

  // ---------- main sessions ----------

  /** One main turn. Returns whether it completed. */
  private async runMain(agentName: string, reason: string): Promise<boolean> {
    const store = this.store(agentName);
    await this.adoptEdits(agentName, "main");
    let agent = await loadAgent(agentName);
    if (agent.state.status === "stopped") return true;
    const eff = await effectiveSettings(agent);

    const b = await this.blocked(agentName);
    if (b) {
      await this.pauseFor(agentName, b);
      return true;
    }

    const firstJob = !hasIdentity(agent);
    const runId = newId("main");
    const items = await store.takeInbox(runId);
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "main", depth: 0 });
    let result: TurnResult | null = null;
    try {
      await updateState(agentName, { status: "working", activity: firstJob ? "learning its job" : agent.state.activity && agent.state.activity !== "resting" ? agent.state.activity : "working" });
      this.changed(agentName, "state");

      // Continue the main session unless the backend or model changed, its context is getting full, or
      // resuming it keeps failing (a broken session would otherwise fail forever).
      const lastCtx = await lastContext(agentName, agent.state.mainSessionId);
      const sameModel = (agent.state.mainSessionModel ?? null) === (eff.model ?? null) || agent.state.mainSessionModel === undefined;
      const resume =
        agent.state.mainSessionId && agent.state.mainSessionBackend === eff.backend && sameModel && (agent.state.failures ?? 0) < 2 && !full(lastCtx) && agent.state.mainSessionPrompt === promptVersion("main")
          ? agent.state.mainSessionId
          : null;
      const edits = resume ? await editedSince(agent, agent.state.mainSessionFiles) : "";
      const settings = await loadSettings();
      result = await runTurn({
        runId,
        agent: agentName,
        kind: "main",
        reason,
        // If resuming fails, the backend starts fresh, and the agent is told so.
        text: (fresh) => (fresh ? "" : edits) + mainTurnText(items, firstJob, fresh && !!agent.state.mainSessionId),
        header: await this.turnHeader(agentName),
        resumeSessionId: resume,
        extraMcp: [mcp],
        timeoutMs: settings.turnTimeoutMinutes * 60_000,
        signal: this.signalFor(agentName),
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "main", update: u }),
        log: this.log,
      });
      await store.ackInbox(runId);
      // The person wrote and the agent never answered with send or ask: its final words are the answer,
      // so a message is never left without a reply (whatever the backend made of the tools).
      if (!ctx.sent && result.reply.trim() && items.some((i) => (i.type === "message" && !(i.data as any)?.fromChat) || i.type === "answer")) {
        await store.addMessage({ from: "agent", kind: "message", text: result.reply.trim(), baseDir: agent.dir });
        this.changed(agentName, "messages");
      }
      agent = await loadAgent(agentName);
      if (result.modelIssue) await this.modelIssue(agentName, result.modelIssue);
      const patch: Partial<AgentState> = { status: hasIdentity(agent) ? "asleep" : "new", failures: 0, lastError: null, mainSessionFiles: fileHashes(agent), mainSessionPrompt: promptVersion("main") };
      // Keep whatever status line the agent set itself; only replace Overtime's own placeholder.
      if (OVERTIME_ACTIVITY.test(agent.state.activity ?? "")) patch.activity = hasIdentity(agent) ? "resting" : "waiting for its job";
      await updateState(agentName, patch);
      // A watch or repeating wake already brings it back; otherwise make sure it never goes quiet.
      const sched = await store.schedule();
      const watching = (await store.monitors()).some((m) => m.status !== "removed") || sched.loops.length > 0;
      if (!ctx.wakeChosen && hasIdentity(agent) && !watching) {
        await store.setWake(clampWake(new Date(Date.now() + DEFAULT_WAKE_MS)), "default wake-up: you didn't choose one last turn (use wake)");
      }
      return true;
    } catch (e: any) {
      await store.returnInbox(runId);
      agent = await loadAgent(agentName);
      const idle: AgentState["status"] = hasIdentity(agent) ? "asleep" : "new";
      if (agent.state.status === "stopped") {
        this.log(`[${agentName}] main turn ended because the agent was stopped`);
        return true;
      }
      if (e instanceof UsageLimitError) {
        const until = e.resetsAt ?? new Date(Date.now() + 15 * 60_000);
        await updateState(agentName, { status: "paused", pausedUntil: until.toISOString(), activity: `paused: ${e.backend} usage limit` });
        this.log(`[${agentName}] paused until ${until.toISOString()}: usage limit`);
        return true;
      }
      if (e instanceof TurnIncompleteError && this.stopping) {
        await updateState(agentName, { status: idle });
        return true;
      }
      const failures = (agent.state.failures ?? 0) + 1;
      const msg = String(e?.message ?? e);
      // Some failures only the person can fix: say exactly what to do, once, and retry slowly meanwhile.
      const hint = needsPerson(msg, eff.backend, agentName);
      const wait = hint ? BACKOFF_MS[BACKOFF_MS.length - 1] : BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, failures - 1)];
      if (hint && agent.state.lastError !== msg.slice(0, 500)) {
        await store.addMessage({ from: "overtime", kind: "alert", title: "Needs you to fix something", text: `${hint}\n\nThe error was: ${msg}`, urgent: true, baseDir: agent.dir });
        this.notify(`${agentName} needs you`, hint);
        this.changed(agentName, "messages");
      }
      await updateState(agentName, { status: idle, failures, lastError: msg.slice(0, 500) });
      await store.setWake(new Date(Date.now() + wait), `retry after an error: ${msg.slice(0, 200)}`);
      this.log(`[${agentName}] main turn failed (${failures}): ${e?.stack ?? e}`);
      if (failures === 3 && !hint) {
        await store.addMessage({ from: "overtime", kind: "alert", title: "Something keeps failing", text: `${agentName}'s last ${failures} turns failed. Latest error:\n\n${msg}\n\nOvertime keeps retrying with longer gaps. Its log is in ${join(paths.meta(agentName), "runs")}.`, urgent: true, baseDir: agent.dir });
        this.notify(`${agentName} keeps failing`, msg);
        this.changed(agentName, "messages");
      }
      return false;
    } finally {
      this.tools.close(ctx.token);
      this.emit("turnEnd", { agent: agentName, kind: "main" });
      await this.refreshNextWake(agentName).catch(() => {});
      this.changed(agentName, "state");
    }
  }

  /** The backend wouldn't use the chosen model. Say so once per model, in the agent's list of threads. */
  private async modelIssue(agentName: string, text: string): Promise<void> {
    const a = await loadAgent(agentName);
    const key = `${a.settings.backend ?? ""}/${a.settings.model ?? ""}`;
    if (a.state.modelIssueFor === key) return;
    await updateState(agentName, { modelIssueFor: key });
    await this.store(agentName).addMessage({ from: "overtime", kind: "alert", title: "The chosen model isn't available", text: `${text}\n\nChange the model for ${agentName} in its settings in the app, or with \`overtime set ${agentName} model=…\`.`, baseDir: a.dir });
    this.changed(agentName, "messages");
  }

  /** What every main turn is told besides the time: spend so far today and helpers still running. */
  private async turnHeader(agentName: string): Promise<string> {
    const s = await this.spentToday(agentName);
    const spend = s.costReported ? `Spent today: $${s.usd.toFixed(2)} of $${s.budgetUsd.toFixed(2)} (as your backend reports it).` : s.tokens ? `Used today: ${s.tokens.toLocaleString()} tokens${s.budgetTokens != null ? ` of ${s.budgetTokens.toLocaleString()}` : ""}.` : `Nothing spent yet today (budget $${s.budgetUsd.toFixed(2)}).`;
    const running = (await this.store(agentName).helpers()).filter((h) => h.status === "running");
    const helpers = running.length ? `Helpers still running: ${running.map((h) => `${h.id} (${h.task.split("\n")[0].slice(0, 60)})`).join("; ")}.` : "";
    const { liveBackground } = await import("../runtime/leftovers.js");
    const bg = await liveBackground(agentName).catch(() => []);
    const kept = bg.length ? `Still running in the background (you started these; stop what you no longer need with kill <pid>): ${bg.map((b) => `pid ${b.pid} \`${b.command.slice(0, 100)}\` since ${b.started}`).join("; ")}.` : "";
    return [spend, helpers, kept].filter(Boolean).join("\n");
  }

  /** Keep state.nextWake in sync: the earliest of its wake-up and loops. */
  private async refreshNextWake(agent: string): Promise<void> {
    const s = await this.store(agent).schedule();
    const times = [s.wakeAt, ...s.loops.map((l) => l.nextAt)].filter(Boolean).map((t) => new Date(t as string).getTime());
    const stopped = (await loadAgent(agent)).state.status === "stopped";
    await updateState(agent, { nextWake: times.length && !stopped ? new Date(Math.min(...times)).toISOString() : null });
  }

  // ---------- people talking to agents ----------

  /** A message from the person, with any files they attached. Returns the message. */
  async send(agentName: string, text: string, files: string[] = []): Promise<Message> {
    const agent = await loadAgent(agentName);
    const store = this.store(agentName);
    if (!text.trim() && !files.length) throw new Error("Write a message or attach a file.");
    const attachments = files.length ? await receiveAttachments(files, agent.dir) : undefined;
    const m = await store.addMessage({ from: "you", kind: "message", text, attachments, baseDir: agent.dir });
    this.changed(agentName, "messages");
    if (agent.state.status === "new" || agent.state.status === "stopped") {
      // Before it has a job, and while stopped, every message goes straight to its main session.
      await store.pushInbox({ type: "message", text: withFiles(text, attachments), messageId: m.id, attachments });
      if (agent.state.status === "new") this.wakeMain(agentName, "the person sent you your first message");
    } else {
      this.queueChat(agentName, m);
    }
    return m;
  }

  /** The person answered a question: pick an option and/or write something. Defaults to the newest open question. */
  async answer(agentName: string, questionId?: string, choice?: number, text?: string): Promise<void> {
    const agent = await loadAgent(agentName);
    const store = this.store(agentName);
    const open = await store.openQuestions();
    const q = questionId ? await store.message(questionId) : open.at(-1);
    if (!q || q.kind !== "question") throw new Error(questionId ? `There's no question ${questionId}.` : `${agentName} hasn't asked you anything.`);
    if (q.answer) throw new Error("That question is already answered.");
    const picked = choice && q.options ? q.options[choice - 1] : undefined;
    if (choice && !picked) throw new Error(`There is no option ${choice}.`);
    // The option's own words, without a number the agent may already have put in front.
    const label = picked ? picked.replace(/^\s*(\d{1,2}|[a-zA-Z])\s*[—–\-.):]\s+/, "").trim() || picked : "";
    const answerText = [picked ? `${choice}. ${label}` : "", text ?? ""].filter(Boolean).join(" — ");
    if (!answerText) throw new Error("Pick an option or write an answer.");
    const m = await store.addMessage({ from: "you", kind: "message", text: answerText, replyTo: q.id, choice, baseDir: agent.dir });
    await store.recordDecision({ threadId: q.id, category: q.category ?? "uncategorised", question: q.text, answer: answerText });
    await store.pushInbox({ type: "answer", text: answerText + (await this.autonomyHint(agentName, q.category)), messageId: m.id, data: { question: q.text } });
    this.changed(agentName, "messages");
    if (agent.state.status !== "stopped") this.wakeMain(agentName, "the person answered one of your questions");
  }

  /** The person closed a question without answering it: the agent stops waiting on it. */
  async dismissQuestion(agentName: string, questionId: string): Promise<void> {
    const agent = await loadAgent(agentName);
    const store = this.store(agentName);
    const q = await store.message(questionId);
    if (!q || q.kind !== "question") throw new Error(`There's no question ${questionId}.`);
    if (q.answer) return;
    await store.addMessage({ from: "you", kind: "message", text: "Dismissed", replyTo: q.id, closes: "dismissed", baseDir: agent.dir });
    await store.pushInbox({ type: "answer", text: `The person dismissed your question without answering it: "${q.text.slice(0, 300)}". Don't wait on it: go with your own judgement, or ask again in a different way only if it really matters.`, data: { question: q.text } });
    this.changed(agentName, "messages");
  }

  /** The agent withdrew a question it no longer needs answered. */
  async withdrawQuestion(agentName: string, questionId: string): Promise<boolean> {
    const agent = await loadAgent(agentName);
    const store = this.store(agentName);
    const q = await store.message(questionId);
    if (!q || q.kind !== "question" || q.answer) return false;
    await store.addMessage({ from: "agent", kind: "message", text: "Withdrawn", replyTo: q.id, closes: "withdrawn", baseDir: agent.dir });
    this.changed(agentName, "messages");
    return true;
  }

  /**
   * Earned autonomy: when the person keeps giving the same answer to the same kind of question,
   * tell the agent so it can propose deciding those itself. Overtime counts; the agent asks.
   */
  private async autonomyHint(agentName: string, category: string | undefined): Promise<string> {
    if (!category) return "";
    const same = (await this.store(agentName).decisions()).filter((d) => d.category === category);
    const recent = same.slice(-5);
    if (recent.length < 3) return "";
    const norm = (s: string) => s.replace(/^\d+\.\s*/, "").split(" — ")[0].trim().toLowerCase();
    const first = norm(recent[0].answer);
    if (!recent.every((d) => norm(d.answer) === first)) return "";
    return `\n\n(Overtime: this is the ${same.length}th "${category}" question, and the last ${recent.length} answers were all "${recent[0].answer.replace(/^\d+\.\s*/, "").split(" — ")[0]}". If it fits, ask whether you can decide these yourself from now on; if they agree, add the rule to AGENT.md.)`;
  }

  /** One chat turn at a time per agent; messages sent meanwhile are answered in order. */
  private queueChat(agentName: string, m: Message): void {
    const key = `${agentName}/chat`;
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.runChat(agentName, m))
      .catch((e) => this.log(`[${agentName}] chat failed: ${e?.stack ?? e}`))
      .finally(() => {
        if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
      });
    this.chatQueues.set(key, next);
  }

  private async runChat(agentName: string, m: Message): Promise<void> {
    if (this.stopping) return;
    const store = this.store(agentName);
    await this.adoptEdits(agentName, `${agentName}/chat`);
    const agent = await loadAgent(agentName);
    const text = withFiles(m.text, m.attachments);
    if (agent.state.status === "stopped") {
      // Stopped while this was queued: it waits for the agent's main session instead.
      await store.pushInbox({ type: "message", text, messageId: m.id, attachments: m.attachments });
      return;
    }
    const b = await this.blocked(agentName);
    if (b) {
      await this.pauseFor(agentName, b);
      await store.addMessage({ from: "overtime", kind: "message", text: `${agentName} is ${this.blockedLine(b)}. Your message is kept and it will pick it up then.`, baseDir: agent.dir });
      await store.pushInbox({ type: "message", text, messageId: m.id, attachments: m.attachments });
      this.changed(agentName, "messages");
      return;
    }
    const conv = await store.conversation();
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "chat", depth: 0 });
    const all = await store.messages();
    try {
      const state = await this.stateSummary(agentName);
      const idx = all.findIndex((x) => x.id === m.id);
      const history = all
        .slice(Math.max(0, idx - 40), idx)
        .map((e) => `${e.from === "you" ? "Person" : e.from === "agent" ? "You" : "Overtime"} (${e.t})${e.kind === "question" ? " [question]" : e.kind === "report" ? " [report]" : ""}: ${withFiles(e.text, e.attachments)}${e.answer ? `\n  (answered: ${e.answer.text})` : ""}`)
        .join("\n\n");
      const resume = conv.chatSessionId && conv.chatPrompt === promptVersion("chat") && !full(await lastContext(agentName, conv.chatSessionId)) ? conv.chatSessionId : null;
      const editsText = resume ? await editedSince(agent, conv.chatFiles) : "";
      // What the chat session hasn't seen: everything since its last turn (main's replies, reports, answers).
      const filesAtStart = fileHashes(agent);
      const seenIdx = conv.chatSeen ? all.findIndex((x) => x.id === conv.chatSeen) : -1;
      const since = (seenIdx >= 0 ? all.slice(seenIdx + 1, idx) : [])
        .map((e) => `${e.from === "you" ? "Person" : e.from === "agent" ? "You" : "Overtime"} (${e.t})${e.kind === "question" ? " [question]" : e.kind === "report" ? " [report]" : ""}: ${withFiles(e.text, e.attachments)}${e.answer ? `\n  (answered: ${e.answer.text})` : ""}`)
        .join("\n\n");
      const catchUp = `${since ? `Since you last answered here (most recent last):\n${since}\n\n` : ""}What you are doing right now (from your main session):\n${state}\n\n`;
      const r = await runTurn({
        agent: agentName,
        kind: "chat",
        reason: "the person sent you a message",
        preamble: chatPreamble(agent),
        resumeSessionId: resume,
        // A fresh session (first message, or the old one couldn't be resumed) gets the recent conversation.
        text: (fresh) =>
          `${fresh ? `What you are doing right now (from your main session):\n${state}\n\n${history ? `The conversation so far (most recent last):\n${history}\n\n` : ""}` : `${editsText}${catchUp}`}The person just wrote:\n\n${text}\n\nAnswer them with send. If it changes your work or needs real work done, send it to: "main" and tell them you have.`,
        extraMcp: [mcp],
        timeoutMs: 20 * 60_000,
        signal: this.signalFor(agentName),
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "chat", update: u }),
        log: this.log,
      });
      // Fingerprints from when this turn began: a rewrite by main during the turn still counts as unseen next time.
      await store.patchConversation({ chatSessionId: r.sessionId, chatFiles: filesAtStart, chatSeen: m.id, chatPrompt: promptVersion("chat") });
      if (r.modelIssue) await this.modelIssue(agentName, r.modelIssue);
      // If it didn't use send, its final words are the reply, so the person always gets an answer.
      if (!ctx.sent) await store.addMessage({ from: "agent", kind: "message", text: r.reply || "(I read this, but didn't write a reply.)", baseDir: agent.dir });
    } catch (e: any) {
      const stoppedNow = (await loadAgent(agentName)).state.status === "stopped";
      if (this.stopping && e instanceof TurnIncompleteError) return; // answered after the restart
      const msg =
        e instanceof UsageLimitError
          ? `I'm paused by the ${e.backend} usage limit${e.resetsAt ? ` until ${e.resetsAt.toLocaleString()}` : ""}. I've kept your message and will pick it up then.`
          : stoppedNow
            ? "I was stopped before I could answer. I've kept your message for when I'm started again."
            : (needsPerson(String(e?.message ?? e), (await effectiveSettings(agent)).backend, agentName) ?? `I couldn't answer just now (${String(e?.message ?? e).slice(0, 200)}). I've passed your message to my main session.`);
      await store.addMessage({ from: "overtime", kind: "message", text: msg, baseDir: agent.dir });
      await store.pushInbox({ type: "message", text, messageId: m.id, attachments: m.attachments });
      // A session that failed may be broken: the next message starts a fresh one.
      if (!(e instanceof UsageLimitError)) await store.patchConversation({ chatSessionId: null });
      if (!(e instanceof UsageLimitError) && !stoppedNow) this.wakeMain(agentName, "a chat session failed, so the person's message came to you");
    } finally {
      this.tools.close(ctx.token);
      this.emit("turnEnd", { agent: agentName, kind: "chat" });
      this.changed(agentName, "messages");
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
      ...(await (async () => {
        const { liveBackground } = await import("../runtime/leftovers.js");
        const bg = await liveBackground(agentName).catch(() => []);
        return bg.length ? [`Running in the background: ${bg.map((b) => `pid ${b.pid} ${b.command.slice(0, 80)}`).join("; ")}`] : [];
      })()),
      reports.length ? `Recent reports:\n${reports.map((r) => `- ${r.t}: ${r.text.split("\n")[0].slice(0, 200)}`).join("\n")}` : "Recent reports: none",
    ];
    return lines.join("\n");
  }

  // ---------- helpers ----------

  async spawnHelper(ctx: ToolContext, req: { role?: string; instructions?: string; task: string; backend?: string; model?: string }): Promise<{ id: string; workdir: string }> {
    if (ctx.kind !== "main") throw new Error("Only your main session can start helpers.");
    if (this.stopping) throw new Error("Overtime is shutting down; start the helper next turn.");
    const store = this.store(ctx.agent);
    const agent = await loadAgent(ctx.agent);
    const eff = await effectiveSettings(agent);
    const b = await this.blocked(ctx.agent, req.backend);
    if (b) throw new Error(`Can't start a helper: ${this.blockedLine(b)}.`);
    // Checked and recorded under one lock, so two spawns at once can't both slip under the cap.
    const rec = await withLock(`spawn:${ctx.agent}`, async () => {
      const running = (await store.helpers()).filter((h) => h.status === "running").length;
      if (running >= MAX_HELPERS) throw new Error(`${MAX_HELPERS} helpers are already running. Wait for some to finish.`);
      const id = newId("helper");
      const r: HelperRecord = {
        id,
        task: req.task,
        role: req.role,
        backend: req.backend,
        model: req.model ?? null,
        workdir: join(paths.meta(ctx.agent), "helpers", id, "work"),
        parent: "main",
        depth: 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await store.saveHelper(r);
      return r;
    });
    let note = "";
    try {
      const prepared = await this.prepareWorkdir(ctx.agent, rec, eff.workspace);
      rec.branch = prepared.branch;
      note = prepared.note;
      await store.saveHelper(rec);
    } catch (e) {
      rec.status = "failed";
      rec.finishedAt = new Date().toISOString();
      rec.result = `Couldn't set up its folder: ${String((e as any)?.message ?? e)}`;
      await store.saveHelper(rec);
      throw e;
    }
    const ctl = new AbortController();
    const key = `${ctx.agent}/${rec.id}`;
    this.helperAborts.set(key, ctl);
    const run = this.runHelper(ctx.agent, rec, req.instructions ?? "", eff.workspace, note, ctl.signal)
      .catch((e) => this.log(`[${ctx.agent}] helper ${rec.id}: ${e?.stack ?? e}`))
      .finally(() => {
        this.helperRuns.delete(key);
        this.helperAborts.delete(key);
      });
    this.helperRuns.set(key, run);
    return { id: rec.id, workdir: rec.workdir };
  }

  /** A folder of its own for each helper: a git worktree of the workspace, or a copy of a small workspace. */
  private async prepareWorkdir(agentName: string, rec: HelperRecord, workspace: string): Promise<{ branch?: string; note: string }> {
    await mkdir(join(rec.workdir, ".."), { recursive: true });
    if (await isGitRepo(workspace)) {
      const branch = `overtime/${agentName}/${rec.id}`;
      try {
        await exec("git", ["-C", workspace, "worktree", "add", "-b", branch, rec.workdir], { timeout: 120_000 });
        return { branch, note: "" };
      } catch (e: any) {
        this.log(`[${agentName}] worktree failed, falling back to a copy: ${e?.message ?? e}`);
      }
    }
    if (existsSync(workspace)) {
      const exclude = [paths.meta(agentName)];
      const size = await measure(workspace, exclude, COPY_MAX_FILES, COPY_MAX_BYTES);
      if (size.ok) {
        // Entry by entry: the workspace may be the agent's own folder, which holds the helper's folder too.
        await mkdir(rec.workdir, { recursive: true });
        for (const name of await readdir(workspace)) {
          const src = join(workspace, name);
          if (exclude.some((x) => src === x || x.startsWith(src + sep))) continue;
          await cp(src, join(rec.workdir, name), { recursive: true, verbatimSymlinks: true });
        }
        return { note: `It is a copy of ${workspace}; copy back what should be kept.` };
      }
      await mkdir(rec.workdir, { recursive: true });
      return { note: `It starts empty: ${workspace} is too large to copy (${size.why}). Read from ${workspace} directly; write your output here.` };
    }
    await mkdir(rec.workdir, { recursive: true });
    return { note: "It starts empty." };
  }

  /** Stop a running helper (from the agent's cancel tool). */
  async cancelHelper(agent: string, id: string): Promise<boolean> {
    const ctl = this.helperAborts.get(`${agent}/${id}`);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  private async runHelper(agentName: string, rec: HelperRecord, instructions: string, workspace: string, note: string, cancel: AbortSignal): Promise<void> {
    const store = this.store(agentName);
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "helper", helperId: rec.id, depth: rec.depth });
    const preamble = helperPreamble(agentName, rec, instructions, workspace, note);
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
        signal: this.signalFor(agentName, cancel),
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "helper", helperId: rec.id, update: u }),
        log: this.log,
      });
      rec.status = "done";
      rec.result = ctx.result ?? (r.reply || "(It finished without describing its result. Check its folder.)");
    } catch (e: any) {
      if (cancel.aborted) {
        rec.status = "cancelled";
        rec.result = "Cancelled, as you asked.";
      } else if ((await loadAgent(agentName)).state.status === "stopped") {
        rec.status = "stopped";
        rec.result = "Cut off because the person stopped you.";
      } else if (this.stopping) {
        rec.status = "failed";
        rec.result = "Overtime was shut down while this helper was running, so it was cut off.";
      } else {
        rec.status = "failed";
        rec.result = `The helper failed: ${String(e?.message ?? e)}`;
      }
      if (ctx.result) rec.result += `\n\nBefore that, it reported:\n${ctx.result}`;
    } finally {
      this.tools.close(ctx.token);
      this.emit("turnEnd", { agent: agentName, kind: "helper", helperId: rec.id });
    }
    rec.finishedAt = new Date().toISOString();
    await store.saveHelper(rec);
    await store.pushInbox({ type: "helper", text: helperInboxText(rec), data: { helperId: rec.id } });
    this.changed(agentName, "helpers");
    if (!this.stopping && rec.status !== "stopped") this.wakeMain(agentName, `helper ${rec.id} ${rec.status === "done" ? "finished" : rec.status}`);
  }

  /** Transcripts and bookkeeping are kept for 30 days, then removed, so an agent's folder doesn't grow forever. */
  private async cleanupRuns(agentName: string): Promise<void> {
    const dir = join(paths.meta(agentName), "runs");
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {}
    const cutoff = Date.now() - RUN_KEEP_MS;
    for (const f of files) {
      const st = await lstat(join(dir, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await rm(join(dir, f), { force: true });
    }
    await this.store(agentName).trimLogs(cutoff);
    const { trimUsage } = await import("../runtime/usage.js");
    await trimUsage(agentName, cutoff);
  }

  /** Remove finished helpers' folders after a week. Git branches stay, so committed work is never lost. */
  private async cleanupHelpers(agentName: string): Promise<void> {
    const store = this.store(agentName);
    const ws = (await effectiveSettings(await loadAgent(agentName))).workspace;
    for (const h of await store.helpers()) {
      if (h.status === "running" || !h.finishedAt || h.cleanedAt) continue;
      if (Date.now() - new Date(h.finishedAt).getTime() < HELPER_KEEP_MS) continue;
      if (h.branch) await exec("git", ["-C", ws, "worktree", "remove", "--force", h.workdir], { timeout: 60_000 }).catch(() => {});
      await rm(join(h.workdir, ".."), { recursive: true, force: true });
      if (h.branch) await exec("git", ["-C", ws, "worktree", "prune"], { timeout: 60_000 }).catch(() => {});
      await store.saveHelper({ ...h, cleanedAt: new Date().toISOString() });
    }
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
    await this.store(name).addMessage({
      kind: "message",
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
    // Cancel whatever it's running now: main turn, chats and helpers.
    this.agentAborts.get(name)?.abort();
    this.agentAborts.delete(name);
    this.pendingWake.delete(name);
    // And what it kept running in the background: a stopped agent leaves nothing behind.
    const { stopBackground } = await import("../runtime/leftovers.js");
    const n = await stopBackground(name).catch(() => 0);
    if (n) this.log(`[${name}] stopped ${n} background process(es) it had kept running`);
    this.changed(name, "state");
  }

  async startAgent(name: string): Promise<void> {
    const a = await loadAgent(name);
    if (a.state.status !== "stopped" && a.state.status !== "paused") return;
    const hadJob = hasIdentity(a);
    await updateState(name, { status: hadJob ? "asleep" : "new", pausedUntil: null, failures: 0, activity: hadJob ? "resuming" : "waiting for its job" }, { allowStopped: true });
    await this.monitors.startAll(name);
    if (hadJob) this.wakeMain(name, "the person started you again");
    else if ((await this.store(name).inbox()).length) this.wakeMain(name, "the person sent you your first message");
    await this.refreshNextWake(name);
    this.changed(name, "state");
  }

  /** Backends Overtime can run: built in, plus any under customBackends. */
  async backends(): Promise<string[]> {
    const { BUILTIN_BACKENDS } = await import("../acp/backends.js");
    return [...new Set([...BUILTIN_BACKENDS, ...Object.keys((await loadSettings()).customBackends ?? {})])];
  }

  private modelCache = new Map<string, { at: number; models: { id: string; name: string }[] }>();

  /** The models a backend offers, as it reports them over ACP. Starts the backend briefly; nothing is spent. */
  async models(backend: string): Promise<{ id: string; name: string }[]> {
    const hit = this.modelCache.get(backend);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const cwd = await mkdtemp(join(tmpdir(), "overtime-models-"));
    let session: AcpSession | null = null;
    try {
      session = await AcpSession.open({ backend, cwd, mcpServers: [], onUpdate: () => {}, onPermission: () => ({ outcome: { outcome: "cancelled" } }) as any, onStderr: () => {} });
      await session.newSession();
      const models = session.availableModels();
      this.modelCache.set(backend, { at: Date.now(), models });
      return models;
    } finally {
      await session?.close();
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The person changed an agent's settings. Takes effect from its next turn. */
  async setAgentSettings(name: string, patch: { backend?: string; model?: string | null; dailyBudgetUsd?: number; dailyTokenBudget?: number | null; workspace?: string | null; protect?: string[] | null }): Promise<void> {
    if (patch.dailyTokenBudget !== undefined && patch.dailyTokenBudget !== null && !(Number.isFinite(patch.dailyTokenBudget) && patch.dailyTokenBudget > 0)) throw new Error("The token budget must be a positive number of tokens, or empty for none.");
    if (typeof patch.workspace === "string" && patch.workspace.trim()) {
      const { expandHome } = await import("../agent/agent.js");
      const { existsSync, statSync } = await import("node:fs");
      const p = expandHome(patch.workspace.trim());
      if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`There's no folder at ${p}.`);
      patch.workspace = p;
    }
    if (typeof patch.model === "string" && patch.model.trim() && patch.model !== "default") {
      // Check the name against what the backend offers, so a typo can't quietly run on its default model.
      const backend = patch.backend ?? (await effectiveSettings(await loadAgent(name))).backend;
      let offered: { id: string; name: string }[] | null = null;
      try {
        offered = await this.models(backend);
      } catch {} // can't ask the backend right now: accept, and the next turn reports a bad name
      const want = patch.model.trim().toLowerCase();
      if (offered?.length && !offered.some((m) => m.id.toLowerCase() === want || m.name.toLowerCase() === want)) {
        throw new Error(`${backend} doesn't offer a model called "${patch.model}". It offers: ${offered.map((m) => m.id).join(", ")}.`);
      }
      const hit = offered?.find((m) => m.id.toLowerCase() === want || m.name.toLowerCase() === want);
      if (hit) patch.model = hit.id;
    }
    if (Array.isArray(patch.protect)) {
      // Stored as clean absolute paths, so what you see is exactly what's protected.
      const { expandHome } = await import("../agent/agent.js");
      const { resolve } = await import("node:path");
      patch.protect = [...new Set(patch.protect.map((p) => resolve(expandHome(String(p).trim()))).filter((p) => p !== "/"))];
      if (!patch.protect.length) patch.protect = null;
    }
    if (patch.backend) {
      const known = await this.backends();
      if (!known.includes(patch.backend)) throw new Error(`Unknown backend "${patch.backend}". Choose one of: ${known.join(", ")}.`);
      // Refuse a backend that isn't installed now, rather than let the agent fail on its next turn.
      const { backendMissing } = await import("../acp/backends.js");
      const missing = await backendMissing(patch.backend);
      if (missing) throw new Error(missing);
    }
    if (patch.dailyBudgetUsd !== undefined && !(typeof patch.dailyBudgetUsd === "number" && patch.dailyBudgetUsd >= 0)) throw new Error("The daily budget must be a number of dollars, 0 or more.");
    const { setSettings } = await import("../agent/agent.js");
    // A new backend means the old model name may not exist there: clear it unless one was given.
    await setSettings(name, { ...patch, model: patch.backend && patch.model === undefined ? null : patch.model });
    this.log(`[${name}] settings changed: ${JSON.stringify(patch)}`);
    // Watches run under the protection they started with: restart them so a change applies to them too.
    if (patch.protect !== undefined || patch.workspace !== undefined) {
      this.monitors.stopAgent(name);
      if ((await loadAgent(name)).state.status !== "stopped") await this.monitors.startAll(name);
    }
    this.changed(name, "state");
  }

  /** Stop an agent and move its folder to the archive. Nothing is deleted. */
  async archive(name: string): Promise<string> {
    await loadAgent(name);
    await this.stopAgent(name);
    await Promise.race([this.mainRunning.get(name), new Promise((r) => setTimeout(r, 25_000))]);
    const { rename } = await import("node:fs/promises");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(paths.archiveDir(), `${name}-${stamp}`);
    await mkdir(paths.archiveDir(), { recursive: true });
    await rename(paths.agent(name), dest);
    this.stores.delete(name);
    this.changed(name, "agents");
    return dest;
  }

  /** The person pressed wake. A new agent has nothing to do until it's been told its job. */
  async wakeNow(name: string): Promise<void> {
    const a = await loadAgent(name);
    if (a.state.status === "stopped") throw new Error(`${name} is stopped. Start it first.`);
    if (a.state.status === "new" && !(await this.store(name).inbox()).length) throw new Error(`${name} doesn't have a job yet. Send it a message saying what it's for.`);
    if (a.state.status === "paused") await updateState(name, { status: hasIdentity(a) ? "asleep" : "new", pausedUntil: null, ...(OVERTIME_ACTIVITY.test(a.state.activity ?? "") ? { activity: hasIdentity(a) ? "resting" : "waiting for its job" } : {}) });
    await updateState(name, { failures: 0 });
    this.wakeMain(name, "the person asked you to wake up");
  }
}

// ---------- prompt text ----------

/** A message's text plus where its attached files are, for the agent. */
function withFiles(text: string, files?: Attachment[]): string {
  if (!files?.length) return text;
  const list = files.map((f) => `- ${f.path} (${f.kind}${f.kind !== "folder" ? `, ${f.bytes < 1024 ? `${f.bytes} B` : f.bytes < 1048576 ? `${Math.round(f.bytes / 1024)} KB` : `${(f.bytes / 1048576).toFixed(1)} MB`}` : ""})`).join("\n");
  return `${text}${text ? "\n\n" : ""}Attached (copied into your folder; open them with your own tools if you need to, images included):\n${list}`;
}

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
            ? (i.data as any)?.fromChat
              ? "Passed on from your conversation with the person. They have already been answered about this: don't reply to it or acknowledge it again. Do the work, and message them only with new results or questions"
              : "Message from the person"
            : i.type === "answer"
              ? `The person answered your question: "${String((i.data as any)?.question ?? "").slice(0, 200)}"`
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
      "This is your first conversation. You don't have an identity yet. From what the person tells you, rewrite AGENT.md in your folder: who you are, your role, your goals (what you're working toward over time, not only the first task) and what good looks like, and your rules (what you must check with them first). Create INDEX.md. Reply to them with a short summary of what you understood and what you'll do first. Then start.",
    );
  }
  if (contextReset) parts.push("Note: this is a fresh session. Your earlier conversation isn't carried over; your folder is. Check INDEX.md and your notes for where things stand.");
  parts.push(inboxBlock(items));
  parts.push("Reply with send to new messages from the person (not to ones passed on from your conversation: those were already answered, so never acknowledge them twice). Do the work, as part of your goals. Before this turn ends, bring your notes and INDEX.md up to date, decide the next useful step toward your goals, and choose when to wake.");
  return parts.join("\n\n");
}

/** What a chat session is told about itself (part of its instructions' version, see promptVersion). */
const CHAT_RULES = `# This session\n\nThis session answers the person in your conversation with them, separately from your main work session. Answer from what you know and what's in your folder. Keep replies short and plain. To the person you are one agent: never mention sessions, your main session or handing things over; just say what you'll do ("Got it, I'm holding"). Don't do real work here: if answering needs more than reading a few files or one quick command, or it changes your work, send it to your main session (send with to: "main") and tell the person you have.`;

function chatPreamble(agent: Agent): string {
  return `${sessionPreamble(agent, "chat")}\n\n---\n\n${CHAT_RULES}`;
}

/**
 * Which version of Overtime's instructions a session started with. Instructions are sent when a session
 * starts, so when they change (an update), the next turn starts a fresh session that gets the new ones.
 */
function promptVersion(kind: "main" | "chat"): string {
  return createHash("sha1").update(workingInstructions("_", kind) + (kind === "chat" ? CHAT_RULES : "")).digest("hex").slice(0, 12);
}

function helperInboxText(h: HelperRecord): string {
  const head = h.status === "done" ? "Finished" : h.status === "cancelled" ? "Cancelled" : h.status === "stopped" ? "Stopped" : "Failed";
  const where = h.branch
    ? `Its work is in ${h.workdir} (git branch ${h.branch}). Review it and merge it into the workspace; the folder is removed a week after it finished, the branch is kept.`
    : `Its work is in ${h.workdir}. Copy what should be kept; the folder is removed a week after it finished.`;
  return `${head} (${h.id}): ${h.task.split("\n")[0].slice(0, 120)}\n\n${h.result ?? ""}\n\n${where}`;
}

/** Whether a folder is small enough to copy, stopping early once it isn't. */
async function measure(root: string, exclude: string[], maxFiles: number, maxBytes: number): Promise<{ ok: boolean; why?: string }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<string | null> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (exclude.some((x) => p === x || p.startsWith(x + sep))) continue;
      if (ent.isDirectory()) {
        const r = await walk(p);
        if (r) return r;
      } else {
        files++;
        if (ent.isFile()) bytes += (await lstat(p)).size;
        if (files > maxFiles) return `more than ${maxFiles} files`;
        if (bytes > maxBytes) return `more than ${Math.round(maxBytes / 1048576)} MB`;
      }
    }
    return null;
  };
  const why = await walk(root);
  return why ? { ok: false, why } : { ok: true };
}

function helperPreamble(agentName: string, rec: HelperRecord, instructions: string, workspace: string, note: string): string {
  return `${workingInstructions(agentName, "helper")}

---

# This session

You are a helper started by ${agentName} for one task. You start clean: everything you need is in your task, your instructions, and the files you're pointed to. You don't talk to the person; ${agentName} reviews your work.

Work in: ${rec.workdir}${rec.branch ? ` (a git worktree of ${workspace}, on branch ${rec.branch}; commit your work there)` : ` (${note})`}
The main workspace is ${workspace}; don't change it directly.

When you're finished, call done with what you did, where the output is, what you checked, and anything left open. Then end your turn.
${instructions ? `\n# Your role\n\n${instructions}\n` : ""}${skillsBlock(paths.agent(agentName)) ? `\n${skillsBlock(paths.agent(agentName))}\n` : ""}`;
}

/** Whether a session's context is full enough that a fresh one (rebuilt from the agent's files) is better. */
function full(ctx: { used: number; size: number } | null): boolean {
  return !!ctx && ctx.size > 0 && ctx.used / ctx.size >= FRESH_SESSION_AT;
}

/** Fingerprints of AGENT.md and INDEX.md as a session last saw them. */
function fileHashes(agent: Agent): { agent: string; index: string } {
  const h = (t: string) => createHash("sha1").update(t).digest("hex");
  return { agent: h(agent.identity), index: h(agent.index) };
}

/**
 * A resumed session saw AGENT.md and INDEX.md only when it started. If they changed since (the person
 * edited them, or another of the agent's sessions did), the next turn starts with the current text.
 */
async function editedSince(agent: Agent, seen: { agent: string; index: string } | undefined): Promise<string> {
  if (!seen) return "";
  const now = fileHashes(agent);
  const parts: string[] = [];
  if (now.agent !== seen.agent) parts.push(`AGENT.md changed since your last turn. It now reads:\n\n${agent.identity.trim()}`);
  if (now.index !== seen.index) parts.push(`INDEX.md changed since your last turn. It now reads:\n\n${agent.index.trim()}`);
  return parts.length ? parts.join("\n\n---\n\n") + "\n\n---\n\n" : "";
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

export type { Message };
