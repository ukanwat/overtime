import { EventEmitter } from "node:events";
import { listSkills, skillsBlock } from "../skills.js";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { parseFrontMatter } from "../agent/frontmatter.js";
import { execFile } from "node:child_process";
import { isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { adoptSettingsEdit, createAgent, effectiveSettings, hasIdentity, listAgents, loadAgent, updateState, type Agent, type AgentState } from "../agent/agent.js";
import { newId } from "../fsutil.js";
import { paths } from "../paths.js";
import { loadSettings, saveSettings } from "../settings.js";
import { withLock } from "../store/mutex.js";
import { Store, clampWake } from "../store/store.js";
import type { Attachment, Decision, HelperRecord, InboxItem, Message, Monitor } from "../store/types.js";
import { receiveAttachments } from "../store/attachments.js";
import type { ToolContext, ToolHost } from "../tools/host.js";
import { ToolServer } from "../tools/server.js";
import { AcpSession } from "../acp/session.js";
import { runTurn, sessionPreamble, TurnIncompleteError, UsageLimitError, type TurnResult } from "../runtime/turn.js";
import { blockedUntil, limitInfo, LIMIT_RECHECK_MS, usageToday, type TurnUsage } from "../runtime/usage.js";
import { workingInstructions } from "../runtime/instructions.js";
import { MonitorRunner, reapStaleMonitors } from "./monitors.js";
import { isTransient, needsPerson } from "../runtime/errors.js";
import { ownToolStep } from "./steps.js";
import { probeOnline } from "../runtime/network.js";

const exec = promisify(execFile);

const TICK_MS = 5_000;
const DEFAULT_WAKE_MS = 60 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** How long a helper waits before retrying after a passing provider problem (tests shorten it). */
const HELPER_RETRY_MS = process.env.OVERTIME_FAST_RETRY ? [200, 400] : [60_000, 5 * 60_000];

/** Wait, unless the signal fires first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

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
type Blocked = { kind: "limit"; until: Date; resetsAt: Date | null; backend: string } | { kind: "budget"; until: Date; text: string };

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
  /** Agents the person asked to run (a message, wake) while a usage limit was recorded: tried anyway. */
  private tryDespiteLimit = new Set<string>();
  private helperRuns = new Map<string, Promise<void>>();
  /** Notes for running helpers, read at their next turn (by "agent/id"). */
  private helperNotes = new Map<string, string[]>();
  /** Each running helper's current turn, stopped when a note arrives. */
  private helperTurns = new Map<string, AbortController>();
  /** Helpers past the point where a note reaches the running session; a note then carries them on afterwards. */
  private helperClosing = new Set<string>();
  /** Cancels the running main turn of an agent, to answer the person (see deliver). */
  private mainAborts = new Map<string, AbortController>();
  /** Agents whose running main turn was interrupted by the person: not a failure, it carries on next turn. */
  private interrupted = new Set<string>();
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

  /** When this machine lost its internet connection; null while online (or not known to be offline). */
  offlineSince: string | null = null;
  /** How Overtime checks the connection (tests replace it). */
  probe: () => Promise<boolean> = probeOnline;
  /** The last time any backend sent anything: proof the connection works, whatever the probe says. */
  private lastProgress = Date.now();
  private lastProbe = 0;
  /** Helpers retrying after provider trouble, by helper id. */
  private helperTrouble = new Map<string, { agent: string; since: string; backend: string }>();

  constructor(private readonly log: (line: string) => void) {
    super();
    this.on("update", () => {
      this.lastProgress = Date.now();
    });
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
    // A last message from the person that never reached the agent (an older version answered messages
    // in a separate session): hand it over now, so it's answered.
    if (a.state.status === "stopped") return;
    const all = await store.messages();
    const last = all.at(-1);
    const queued = new Set((await store.inbox()).map((i) => i.messageId).filter(Boolean));
    if (last?.from === "you" && !last.replyTo && !last.closes && !queued.has(last.id)) await store.pushInbox({ type: "message", text: withFiles(last.text, last.attachments), messageId: last.id, attachments: last.attachments });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.monitors.stopAll();
    this.abort.abort();
    const all = [...this.mainRunning.values(), ...this.helperRuns.values()];
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

  toolStarted(ctx: ToolContext, tool: string): void {
    this.emit("step", { agent: ctx.agent, kind: ctx.kind, helperId: ctx.helperId, step: ownToolStep(tool) });
  }

  async setActivity(agent: string, text: string): Promise<void> {
    await updateState(agent, { activity: text.replace(/\s+/g, " ").trim().slice(0, 80), activityByAgent: true });
    this.changed(agent, "state");
  }

  notify(title: string, body: string): void {
    // Tests (and anything else that sets this) never pop real notifications on your desktop.
    if (process.env.OVERTIME_NO_NOTIFY) return;
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
      await this.checkNetwork(agents).catch((e) => this.log(`network check: ${e?.message ?? e}`));
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

  /**
   * The internet connection, checked while anything depends on it: sessions running, or agents and
   * helpers retrying after provider trouble. Offline means the check fails and no backend has sent
   * anything for 90 seconds. When it's back, everything that was waiting carries on at once.
   */
  private async checkNetwork(agents: Agent[], force = false): Promise<void> {
    const troubled = agents.some((a) => a.state.troubleSince) || this.helperTrouble.size > 0;
    const active = this.mainRunning.size > 0 || this.helperAborts.size > 0 || troubled || !!this.offlineSince;
    if (!active) return;
    const every = this.offlineSince ? 10_000 : 20_000;
    if (!force && Date.now() - this.lastProbe < every) return;
    this.lastProbe = Date.now();
    const online = (await this.probe()) || Date.now() - this.lastProgress < 30_000;
    if (!online && !this.offlineSince && (force || Date.now() - this.lastProgress > 90_000)) {
      this.offlineSince = new Date().toISOString();
      this.log("no internet connection: agents wait and carry on once it's back");
      this.notify("No internet connection", "Your agents are waiting, and carry on by themselves once it's back.");
      for (const a of agents) this.changed(a.name, "state");
    } else if (online && this.offlineSince) {
      const since = this.offlineSince;
      this.offlineSince = null;
      this.log(`internet connection back (lost since ${since})`);
      for (const a of agents) {
        // Agents that were waiting it out try again now, not at their next back-off time.
        if (a.state.troubleSince && a.state.status !== "stopped") await this.store(a.name).setWake(new Date(), "the internet connection is back");
        this.changed(a.name, "state");
      }
    }
  }

  /** Wait until the connection is back (or the signal fires). */
  private async untilOnline(signal: AbortSignal): Promise<void> {
    while (this.offlineSince && !signal.aborted && !this.stopping) await sleep(2_000, signal);
  }

  /** What the person should know about an agent's connection to its backend, if anything is wrong. */
  async trouble(agentName: string): Promise<{ since: string; backend: string } | null> {
    const a = await loadAgent(agentName);
    if (a.state.troubleSince) return { since: a.state.troubleSince, backend: (await effectiveSettings(a)).backend };
    for (const t of this.helperTrouble.values()) if (t.agent === agentName) return { since: t.since, backend: t.backend };
    return null;
  }

  /** Whether any session of this agent is running (its AGENT.md may be mid-rewrite), other than `self`. */
  private busy(agent: string, self?: "main" | string): boolean {
    if (self !== "main" && this.mainRunning.has(agent)) return true;
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
      // A limit pause lifts when a turn on the backend gets through (any agent's), or at its next try.
      const lifted = (a.state.pauseReason === "budget" || a.state.pauseReason === "limit") && !(await this.blocked(a.name));
      if (!lifted && a.state.pausedUntil && new Date(a.state.pausedUntil) > now) return;
      await updateState(a.name, { status: hasIdentity(a) ? "asleep" : "new", pausedUntil: null, pauseReason: null, ...(a.state.activityByAgent ? {} : { activity: hasIdentity(a) ? "resting" : "waiting for its job" }) });
      this.changed(a.name, "state");
      a = await loadAgent(a.name);
    }
    const sched = await store.schedule();
    // After a failed turn, wait out the back-off even if there's work waiting.
    if (((a.state.failures ?? 0) > 0 || (a.state.transientFailures ?? 0) > 0) && sched.wakeAt && new Date(sched.wakeAt) > now) return;
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
    const lim = await limitInfo(b);
    if (lim) return { kind: "limit", until: lim.retryAt, resetsAt: lim.resetsAt, backend: b };
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
    await updateState(agentName, { status: "paused", pausedUntil: b.until.toISOString(), activity: b.kind === "limit" ? `paused: ${b.backend} usage limit` : "paused: daily budget used", activityByAgent: false, pauseReason: b.kind === "limit" ? "limit" : "budget", limitResetsAt: b.kind === "limit" ? (b.resetsAt?.toISOString() ?? null) : null });
    if (b.kind === "budget" && !already) {
      await this.store(agentName).addMessage({ from: "overtime", kind: "alert", title: "Daily budget used", text: b.text, baseDir: agent.dir });
      this.notify(`${agentName} paused`, "Its daily budget is used. Raise it in its settings to keep it going today.");
      this.changed(agentName, "messages");
    }
    this.changed(agentName, "state");
  }

  private blockedLine(b: Blocked): string {
    return b.kind === "limit" ? `paused by the ${b.backend} usage limit${b.resetsAt ? ` (it resets ${b.resetsAt.toLocaleString()})` : ""}` : `paused: today's budget is used, back ${b.until.toLocaleString()}`;
  }

  // ---------- main sessions ----------

  /** One main turn. Returns whether it completed. */
  private async runMain(agentName: string, reason: string): Promise<boolean> {
    const store = this.store(agentName);
    await this.adoptEdits(agentName, "main");
    let agent = await loadAgent(agentName);
    if (agent.state.status === "stopped") return true;
    const eff = await effectiveSettings(agent);

    // The person asked (a message, or wake): try the backend itself, whatever limit was recorded; if
    // it's still over, the turn says so and the agent pauses again.
    const forced = this.tryDespiteLimit.delete(agentName);
    const b = await this.blocked(agentName);
    if (b && !(forced && b.kind === "limit")) {
      await this.pauseFor(agentName, b);
      return true;
    }

    const firstJob = !hasIdentity(agent);
    const runId = newId("main");
    const items = await store.takeInbox(runId);
    const turnCtl = new AbortController();
    this.mainAborts.set(agentName, turnCtl);
    this.interrupted.delete(agentName);
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "main", depth: 0 });
    let result: TurnResult | null = null;
    try {
      // The agent's own status line stays while it works; Overtime's placeholder becomes "working".
      await updateState(agentName, firstJob ? { status: "working", activity: "learning its job", activityByAgent: false } : agent.state.activityByAgent && agent.state.activity ? { status: "working" } : { status: "working", activity: "working", activityByAgent: false });
      this.changed(agentName, "state");

      // Continue the main session unless the backend or model changed, its context is getting full, or
      // resuming it keeps failing (a broken session would otherwise fail forever).
      // One continuous session: it's never cut on purpose, and the backend compacts it when it fills up.
      // Only a different backend (one CLI can't continue another's session) or a session that keeps
      // failing to continue starts a new one, rebuilt from the agent's folder and recent conversation.
      const sameModel = (agent.state.mainSessionModel ?? null) === (eff.model ?? null) || agent.state.mainSessionModel === undefined;
      const resume = agent.state.mainSessionId && agent.state.mainSessionBackend === eff.backend && (agent.state.failures ?? 0) < 2 ? agent.state.mainSessionId : null;
      // Overtime's instructions changed (an update): they go into the same session, not a new one.
      const newInstructions =
        resume && agent.state.mainSessionPrompt && agent.state.mainSessionPrompt !== promptVersion("main")
          ? `Overtime's working instructions for you have been updated. From now on, these replace the earlier ones:\n\n${workingInstructions(agentName, "main")}\n\n---\n\n`
          : "";
      const edits = resume ? await editedSince(agent, agent.state.mainSessionFiles) : "";
      const convo = await store.messages(); // for a session that turns out fresh
      const settings = await loadSettings();
      result = await runTurn({
        runId,
        agent: agentName,
        kind: "main",
        reason,
        // If resuming fails, the backend starts fresh, and the agent is told so.
        // A fresh session also gets the recent conversation with the person: it's the one voice they talk to.
        text: (fresh) => (fresh ? recentConversation(convo) : newInstructions + edits) + mainTurnText(items, firstJob, fresh && !!agent.state.mainSessionId),
        switchModel: !sameModel,
        header: await this.turnHeader(agentName),
        resumeSessionId: resume,
        extraMcp: [mcp],
        timeoutMs: settings.turnTimeoutMinutes * 60_000,
        signal: this.signalFor(agentName, turnCtl.signal),
        // Recorded as soon as the session exists, so a turn interrupted to answer you resumes this session.
        onSession: (id) => void updateState(agentName, { mainSessionId: id, mainSessionBackend: eff.backend, mainSessionModel: eff.model ?? null, mainSessionPrompt: promptVersion("main") }).catch(() => {}),
        onUpdate: (u) => this.emit("update", { agent: agentName, kind: "main", update: u }),
        log: this.log,
      });
      await store.ackInbox(runId);
      this.interrupted.delete(agentName); // an interrupt that came too late to stop this turn
      // The person wrote and the agent never answered with send or ask: its final words are the answer,
      // so a message is never left without a reply (whatever the backend made of the tools).
      if (!ctx.sent && result.reply.trim() && items.some((i) => (i.type === "message" && !(i.data as any)?.fromChat) || i.type === "answer")) {
        await store.addMessage({ from: "agent", kind: "message", text: result.reply.trim(), baseDir: agent.dir });
        this.changed(agentName, "messages");
      }
      agent = await loadAgent(agentName);
      if (result.modelIssue) await this.modelIssue(agentName, result.modelIssue);
      if (result.usage2 && result.usage2.turnCostUsd == null) await this.noCostNotice(agentName, result.backend);
      const patch: Partial<AgentState> = { status: hasIdentity(agent) ? "asleep" : "new", failures: 0, transientFailures: 0, troubleSince: null, lastError: null, mainSessionFiles: fileHashes(agent), mainSessionPrompt: promptVersion("main") };
      // Keep whatever status line the agent set itself; only replace Overtime's own placeholder.
      if (!agent.state.activityByAgent) patch.activity = hasIdentity(agent) ? "resting" : "waiting for its job";
      await updateState(agentName, patch);
      // A watch or repeating wake already brings it back; otherwise make sure it never goes quiet.
      const sched = await store.schedule();
      const watching = (await store.monitors()).some((m) => m.status !== "removed") || sched.loops.length > 0;
      if (!ctx.wakeChosen && hasIdentity(agent) && !watching) {
        await store.setWake(clampWake(new Date(Date.now() + DEFAULT_WAKE_MS)), "default wake-up: you didn't choose one last turn (use wake)");
      }
      return true;
    } catch (e: any) {
      agent = await loadAgent(agentName);
      const idle: AgentState["status"] = hasIdentity(agent) ? "asleep" : "new";
      if (this.interrupted.has(agentName) && e instanceof TurnIncompleteError && !this.stopping && agent.state.status !== "stopped") {
        // Interrupted to answer the person: what it was handed this turn was seen (the session goes on
        // from where it stopped), so it isn't handed over again, and it isn't a failure.
        this.interrupted.delete(agentName);
        // Only what the agent was actually shown counts as delivered; stopped before its prompt went out,
        // the items go back and come with the next turn.
        if (e.promptSent) await store.ackInbox(runId);
        else await store.returnInbox(runId);
        await updateState(agentName, { status: idle });
        this.log(`[${agentName}] paused its work to answer you`);
        return true;
      }
      await store.returnInbox(runId);
      if (agent.state.status === "stopped") {
        this.log(`[${agentName}] main turn ended because the agent was stopped`);
        return true;
      }
      if (e instanceof UsageLimitError) {
        // Tried again in a while (the limit can lift before its reset), or at the reset if that's sooner.
        const recheck = new Date(Date.now() + LIMIT_RECHECK_MS);
        const until = e.resetsAt && e.resetsAt < recheck ? e.resetsAt : recheck;
        await updateState(agentName, { status: "paused", pausedUntil: until.toISOString(), activity: `paused: ${eff.backend} usage limit`, activityByAgent: false, pauseReason: "limit", limitResetsAt: e.resetsAt?.toISOString() ?? null });
        this.log(`[${agentName}] paused by the ${eff.backend} usage limit; trying again ${until.toISOString()}`);
        if (forced) {
          await store.addMessage({ from: "overtime", kind: "message", text: `${eff.backend} is still at its usage limit${e.resetsAt ? ` (it says it resets ${e.resetsAt.toLocaleString()})` : ""}. ${agentName} keeps your message and tries again by itself every 15 minutes, and as soon as you message or wake it.`, baseDir: agent.dir });
          this.changed(agentName, "messages");
        }
        return true;
      }
      if (e instanceof TurnIncompleteError && this.stopping) {
        await updateState(agentName, { status: idle });
        return true;
      }
      const msg = String(e?.message ?? e);
      if (isTransient(e)) {
        // The provider is having trouble: wait it out and carry on, in the same session. Not a failure,
        // and you only hear about it if it lasts.
        const n = (agent.state.transientFailures ?? 0) + 1;
        const since = agent.state.troubleSince ?? new Date().toISOString();
        await updateState(agentName, { status: idle, transientFailures: n, troubleSince: since, activity: `waiting: ${eff.backend} is having trouble`, activityByAgent: false, lastError: null });
        // Find out now whether it's this machine's connection, so the app can say so.
        void this.checkNetwork(await listAgents(), true).catch(() => {});
        await store.setWake(new Date(Date.now() + BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, n - 1)]), `retry: ${eff.backend} was having trouble (${msg.slice(0, 120)})`);
        this.log(`[${agentName}] ${eff.backend} is having trouble (${n}), retrying: ${msg.slice(0, 200)}`);
        if (n === 6 && !this.offlineSince) {
          await store.addMessage({ from: "overtime", kind: "alert", title: `${eff.backend} is having trouble`, text: `${agentName} has been unable to reach ${eff.backend} since ${new Date(since).toLocaleString()} (latest: ${msg.slice(0, 200)}). Nothing is lost: it keeps retrying every hour and carries on by itself once ${eff.backend} is back.`, baseDir: agent.dir });
          this.notify(`${agentName} is waiting on ${eff.backend}`, "Its provider keeps failing; it will carry on by itself once it's back.");
          this.changed(agentName, "messages");
        }
        return false;
      }
      const failures = (agent.state.failures ?? 0) + 1;
      // Some failures only the person can fix: say exactly what to do, once, and retry slowly meanwhile.
      const hint = needsPerson(e, eff.backend, agentName);
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
      if (this.mainAborts.get(agentName) === turnCtl) this.mainAborts.delete(agentName);
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

  /**
   * The daily budget in dollars can only be kept on a backend that says what a turn cost. On one that
   * doesn't, the person is told once (per backend), so the agent never runs uncapped without them knowing.
   */
  private async noCostNotice(agentName: string, backend: string): Promise<void> {
    const a = await loadAgent(agentName);
    if (a.state.noCostNoticeFor === backend) return;
    await updateState(agentName, { noCostNoticeFor: backend });
    const eff = await effectiveSettings(a);
    const cap = eff.dailyTokenBudget != null ? `Its token budget (${eff.dailyTokenBudget.toLocaleString()} a day) is what limits it.` : `Nothing limits its spending yet: set a token budget in its settings in the app (→), or with \`overtime set ${agentName} tokens=2m\`.`;
    await this.store(agentName).addMessage({ from: "overtime", kind: "alert", title: `${backend} doesn't report cost`, text: `${agentName} runs on ${backend}, which doesn't say what its turns cost, so its $${eff.dailyBudgetUsd} daily budget can't be kept. ${cap}`, urgent: eff.dailyTokenBudget == null, baseDir: a.dir });
    if (eff.dailyTokenBudget == null) this.notify(`${agentName}'s spending isn't capped`, `${backend} doesn't report cost. Set a token budget in its settings.`);
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
    // You always talk to the agent itself: its one main session, never a stand-in.
    // Starting with /name of one of its skills: the person wants that skill used (as in Claude Code).
    const first = text.trimStart().split(/\s/, 1)[0] ?? "";
    const skill = first.startsWith("/") ? listSkills(agent.dir).find((s) => s.name === first.slice(1)) : undefined;
    const note = skill ? `\n\n(The person started this with /${skill.name}: load your "${skill.name}" skill with the skill tool and follow it for this.)` : "";
    await store.pushInbox({ type: "message", text: withFiles(text, attachments) + note, messageId: m.id, attachments });
    await this.deliver(agentName, agent.state.status === "new" ? "the person sent you your first message" : "the person sent you a message");
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
    const note = text?.trim() || undefined;
    const m = await store.addMessage({ from: "you", kind: "message", text: answerText, replyTo: q.id, choice, note, baseDir: agent.dir });
    await store.recordDecision({ threadId: q.id, category: q.category ?? "uncategorised", question: q.text, answer: answerText, ...(picked ? { choice: label } : {}) });
    await store.pushInbox({ type: "answer", text: answerText + (await this.autonomyHint(agentName, q.category)), messageId: m.id, data: { question: q.text } });
    this.changed(agentName, "messages");
    await this.deliver(agentName, "the person answered one of your questions");
  }

  /**
   * Get something from the person to the agent now. Asleep: it wakes. Busy: its turn is interrupted at
   * the next step and it answers with everything it knows, then carries on with its work. Stopped: it
   * waits. Paused (budget or usage limit): it waits, and the person is told why.
   */
  private async deliver(agentName: string, reason: string): Promise<void> {
    const agent = await loadAgent(agentName);
    if (agent.state.status === "stopped") return;
    const b = await this.blocked(agentName);
    if (b?.kind === "limit") {
      // The limit may have lifted already: the person writing is the moment to find out.
      this.tryDespiteLimit.add(agentName);
    } else if (b) {
      await this.pauseFor(agentName, b);
      await this.store(agentName).addMessage({ from: "overtime", kind: "message", text: `${agentName} is ${this.blockedLine(b)}. Your message is kept and it will pick it up then.`, baseDir: agent.dir });
      this.changed(agentName, "messages");
      return;
    }
    const running = this.mainAborts.get(agentName);
    if (running && !running.signal.aborted) {
      this.interrupted.add(agentName);
      running.abort();
      this.wakeMain(agentName, `${reason} (you paused your work to answer: reply first, then carry on where you left off)`);
      return;
    }
    this.wakeMain(agentName, reason);
  }

  // ---------- MCP servers: the person sees their status and controls them ----------

  /** Every MCP server an agent has, where it came from, and whether the person has it on. Secrets hidden. */
  async mcpList(name: string): Promise<{ name: string; source: "shared" | "person" | "agent"; enabled: boolean; describe: string; signedIn?: boolean }[]> {
    const { describeServer } = await import("./mcp-admin.js");
    const { allMcpServers } = await import("../agent/agent.js");
    const { signedIn } = await import("../runtime/mcp-auth.js");
    const a = await loadAgent(name);
    const off = new Set(a.settings.disableMcp ?? []);
    return Promise.all(
      (await allMcpServers(a)).map(async ({ server, source }) => ({
        name: server.name,
        source,
        enabled: !off.has(server.name),
        describe: describeServer(server),
        ...(server.url ? { signedIn: await signedIn(server.url) } : {}),
      })),
    );
  }

  private async mcpUrl(name: string, serverName: string): Promise<string> {
    const { allMcpServers } = await import("../agent/agent.js");
    const entry = (await allMcpServers(await loadAgent(name))).find((x) => x.server.name === serverName);
    if (!entry) throw new Error(`There's no MCP server called ${serverName}.`);
    if (!entry.server.url) throw new Error(`${serverName} runs on this machine; there's nothing to sign in to.`);
    return entry.server.url;
  }

  private signIns = new Map<string, Promise<void>>();

  /**
   * Sign in to a server that needs it (the MCP standard OAuth flow): opens the person's browser at its
   * sign-in page. Returns that page's address (null if no sign-in was needed after all).
   */
  async mcpSignIn(name: string, serverName: string): Promise<{ authorizationUrl: string | null }> {
    const { beginSignIn } = await import("../runtime/mcp-auth.js");
    const url = await this.mcpUrl(name, serverName);
    const { authorizationUrl, done } = await beginSignIn(url);
    const settled = done.then(
      () => {
        this.log(`[${name}] signed in to MCP server ${serverName}`);
        for (const k of this.mcpStatusCache.keys()) if (k.includes(JSON.stringify(url))) this.mcpStatusCache.delete(k);
        this.changed(name, "state");
      },
      (e) => {
        this.log(`[${name}] sign-in to MCP server ${serverName} failed: ${e?.message ?? e}`);
        throw e;
      },
    );
    settled.catch(() => {});
    this.signIns.set(url, settled);
    return { authorizationUrl };
  }

  /** Wait for a sign-in started with mcpSignIn to finish (throws if it failed). */
  async mcpSignInWait(name: string, serverName: string): Promise<void> {
    await this.signIns.get(await this.mcpUrl(name, serverName));
  }

  /** Forget the sign-in to a server (for every agent that has it). */
  async mcpSignOut(name: string, serverName: string): Promise<void> {
    const { signOut } = await import("../runtime/mcp-auth.js");
    const url = await this.mcpUrl(name, serverName);
    await signOut(url);
    for (const k of this.mcpStatusCache.keys()) if (k.includes(JSON.stringify(url))) this.mcpStatusCache.delete(k);
    this.log(`[${name}] signed out of MCP server ${serverName}`);
    this.changed(name, "state");
  }

  private mcpStatusCache = new Map<string, { at: number; r: { ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean } }>();

  /** Whether each of an agent's servers that's on connects, and its tools (checked live, cached a minute). */
  async mcpStatus(name: string, fresh = false): Promise<Record<string, { ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean }>> {
    const { checkServer } = await import("./mcp-admin.js");
    const { allMcpServers } = await import("../agent/agent.js");
    const a = await loadAgent(name);
    const off = new Set(a.settings.disableMcp ?? []);
    const out: Record<string, { ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean }> = {};
    await Promise.all(
      (await allMcpServers(a))
        .filter(({ server }) => !off.has(server.name))
        .map(async ({ server }) => {
          const key = JSON.stringify(server);
          const hit = this.mcpStatusCache.get(key);
          if (!fresh && hit && Date.now() - hit.at < 60_000) return void (out[server.name] = hit.r);
          // Checked the way the agent's connection makes it (protocol, transport, Overtime's sign-in).
          const r = await checkServer(server, 20_000);
          this.mcpStatusCache.set(key, { at: Date.now(), r });
          out[server.name] = r;
        }),
    );
    return out;
  }

  /** Connect or disconnect a server for one agent (from its next turn). */
  async mcpSetEnabled(name: string, serverName: string, enabled: boolean): Promise<void> {
    const a = await loadAgent(name);
    const off = new Set(a.settings.disableMcp ?? []);
    if (enabled) off.delete(serverName);
    else off.add(serverName);
    const { setSettings } = await import("../agent/agent.js");
    await setSettings(name, { disableMcp: off.size ? [...off] : null });
    this.log(`[${name}] MCP server ${serverName} ${enabled ? "connected" : "disconnected"}`);
    this.changed(name, "state");
  }

  /** Remove a server from where it came from: the agent's mcp.json, the person's settings for it, or the shared list. */
  async mcpRemove(name: string, serverName: string): Promise<void> {
    const { allMcpServers, setSettings } = await import("../agent/agent.js");
    const a = await loadAgent(name);
    const entry = (await allMcpServers(a)).find((x) => x.server.name === serverName);
    if (!entry) throw new Error(`There's no MCP server called ${serverName}.`);
    if (entry.source === "agent") {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const file = join(a.dir, "mcp.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const keep = (list: any[]) => list.filter((x) => x?.name !== serverName);
      writeFileSync(file, JSON.stringify(Array.isArray(raw) ? keep(raw) : { ...raw, ...(raw.servers ? { servers: keep(raw.servers) } : { mcpServers: keep(raw.mcpServers ?? []) }) }, null, 2) + "\n");
    } else if (entry.source === "person") {
      await setSettings(name, { mcpServers: (a.settings.mcpServers ?? []).filter((x) => x.name !== serverName) });
    } else {
      const g = await loadSettings();
      await saveSettings({ ...g, mcpServers: g.mcpServers.filter((x) => x.name !== serverName) });
    }
    this.log(`[${name}] MCP server ${serverName} removed`);
    this.changed(name, "state");
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
    // The option picked, compared as chosen; an answer without an option, by its whole text.
    const said = (d: Decision) => (d.choice ?? d.answer).trim();
    const first = said(recent[0]);
    if (!recent.every((d) => said(d).toLowerCase() === first.toLowerCase())) return "";
    return `\n\n(Overtime: this is the ${same.length}th "${category}" question, and the last ${recent.length} answers were all "${first}". If it fits, ask whether you can decide these yourself from now on; if they agree, add the rule to AGENT.md.)`;
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

  async spawnHelper(ctx: ToolContext, req: { role?: string; instructions?: string; task: string; backend?: string; model?: string }): Promise<{ id: string; workdir: string; note?: string }> {
    if (ctx.kind !== "main") throw new Error("Only your main session can start helpers.");
    if (this.stopping) throw new Error("Overtime is shutting down; start the helper next turn.");
    const store = this.store(ctx.agent);
    const agent = await loadAgent(ctx.agent);
    const eff = await effectiveSettings(agent);
    // A helper's backend and model are checked before it starts. One that can't run as asked runs on
    // what can, and the agent is told why, so it can fix the role: a helper never fails over this.
    const notes: string[] = [];
    const { backendMissing } = await import("../acp/backends.js");
    if (req.backend && req.backend !== eff.backend) {
      const missing = await backendMissing(req.backend).catch(() => null);
      if (missing) {
        const asked = req.backend;
        notes.push(`It asked for backend "${asked}", which can't run here (${missing}), so it runs on your backend, ${eff.backend}.`);
        req.backend = undefined;
        if (req.model) {
          notes.push(`Its model "${req.model}" was for ${asked}, so it runs on ${eff.backend}'s default model.`);
          req.model = undefined;
        }
      }
    }
    if (req.model && req.model !== "default") {
      const backend = req.backend ?? eff.backend;
      let offered: { id: string; name: string }[] = [];
      try {
        offered = await this.models(backend);
      } catch {}
      const want = req.model.toLowerCase();
      if (offered.length && !offered.some((m) => m.id.toLowerCase() === want || m.name.toLowerCase() === want)) {
        notes.push(`${backend} doesn't offer the model "${req.model}", so this helper runs on ${backend}'s default. It offers: ${offered.map((m) => m.id).join(", ")}. Fix the role file if you'll start this kind of helper again.`);
        req.model = undefined;
      }
    }
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
    return { id: rec.id, workdir: rec.workdir, note: notes.join(" ") || undefined };
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

  /**
   * Send one of the agent's helpers a note. A running helper pauses, reads it, and carries on in the
   * same session. One that finished, failed, was cancelled or was cut off carries on from where it was:
   * same session (everything it knew), same folder, the note as its next instruction.
   */
  async tellHelper(agentName: string, id: string, text: string): Promise<string> {
    const key = `${agentName}/${id}`;
    const store = this.store(agentName);
    const rec = (await store.helpers()).find((h) => h.id === id);
    if (!rec) throw new Error(`There's no helper ${id}.`);
    if (!text.trim()) throw new Error("Write what to tell it.");
    if (this.helperRuns.has(key) && !this.helperClosing.has(key)) {
      const notes = this.helperNotes.get(key) ?? [];
      notes.push(text);
      this.helperNotes.set(key, notes);
      // Its current turn stops at once; the next one starts with the note, in the same session.
      this.helperTurns.get(key)?.abort();
      return `Told ${id}. It reads this now and carries on.`;
    }
    // Finishing just now: wait for it, then carry on from there.
    await this.helperRuns.get(key)?.catch(() => {});
    const now = (await store.helpers()).find((h) => h.id === id)!;
    if (now.cleanedAt || !existsSync(now.workdir)) throw new Error(`${id}'s folder was removed (a week after it finished), so it can't carry on. Start a new helper.`);
    if (this.stopping) throw new Error("Overtime is shutting down; tell it next turn.");
    const agent = await loadAgent(agentName);
    const eff = await effectiveSettings(agent);
    const b = await this.blocked(agentName, now.backend);
    if (b) throw new Error(`Can't continue ${id}: ${this.blockedLine(b)}.`);
    await withLock(`spawn:${agentName}`, async () => {
      const running = (await store.helpers()).filter((h) => h.status === "running").length;
      if (running >= MAX_HELPERS) throw new Error(`${MAX_HELPERS} helpers are already running. Wait for some to finish.`);
      now.status = "running";
      delete now.finishedAt;
      delete now.result;
      await store.saveHelper(now);
    });
    const ctl = new AbortController();
    this.helperAborts.set(key, ctl);
    // Its role, as it was given (the file may have changed since: it's read again).
    const instructions = now.role ? await readFile(isAbsolute(now.role) ? now.role : join(agent.dir, now.role), "utf8").then((t: string) => parseFrontMatter(t).body).catch(() => "") : "";
    const run = this.runHelper(agentName, now, instructions, eff.workspace, "", ctl.signal, text)
      .catch((e) => this.log(`[${agentName}] helper ${now.id}: ${e?.stack ?? e}`))
      .finally(() => {
        this.helperRuns.delete(key);
        this.helperAborts.delete(key);
      });
    this.helperRuns.set(key, run);
    this.changed(agentName, "helpers");
    return `${id} carries on from where it was, with this as its next instruction. Its result comes to you as before.`;
  }

  private async runHelper(agentName: string, rec: HelperRecord, instructions: string, workspace: string, note: string, cancel: AbortSignal, continueWith?: string): Promise<void> {
    const store = this.store(agentName);
    const key = `${agentName}/${rec.id}`;
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "helper", helperId: rec.id, depth: rec.depth });
    const preamble = helperPreamble(agentName, rec, instructions, workspace, note);
    const task = `Your task:\n\n${rec.task}`;
    /** A turn's text: what it's told now, and, in a session started afresh, its task too. */
    const noteText = (notes: string[], resumed: boolean) => (fresh: boolean) =>
      `${resumed ? `${agentName} wants you to carry on (you had stopped). ` : ""}A note from ${agentName}, who started you:\n\n${notes.join("\n\n")}\n\n` +
      (fresh ? `(This is a new session. ${task}\n\nWhat you already did is in your folder: check it, and carry on from there.)` : "Take it into account and carry on from where you were.") +
      (resumed ? " When you're finished, call done again with the whole result." : "");
    let next: (fresh: boolean) => string = continueWith ? noteText([continueWith], true) : () => task;
    let lastReply = "";
    this.helperClosing.delete(key);
    try {
      // A passing provider problem (a 502, overloaded) doesn't fail the helper: it waits and tries again,
      // up to 3 attempts, carrying on from where it was. A usage limit doesn't fail it either: it waits
      // for the limit to lift (up to a day), then carries on the same way.
      let attempt = 0;
      const limitedSince = { t: 0 };
      const cutOff = "(An earlier attempt was cut off by a problem at the provider. Check what's already in your folder, and carry on from there.)";
      const run = async (text: (fresh: boolean) => string, signal: AbortSignal): Promise<TurnResult> => {
        try {
          return await runTurn({
            agent: agentName,
            kind: "helper",
            reason: `${agentName} gave you a task`,
            text: (fresh) => (attempt ? `${text(fresh)}\n\n${cutOff}` : text(fresh)),
            preamble,
            cwd: rec.workdir,
            backend: rec.backend,
            model: rec.model ?? undefined,
            extraMcp: [mcp],
            // The same session throughout: notes and carrying on keep what it knew.
            resumeSessionId: rec.sessionId ?? null,
            onSession: (id) => {
              if (rec.sessionId !== id) {
                rec.sessionId = id;
                void store.saveHelper(rec).catch(() => {});
              }
            },
            timeoutMs: (await loadSettings()).turnTimeoutMinutes * 60_000,
            signal: this.signalFor(agentName, signal),
            onUpdate: (u) => this.emit("update", { agent: agentName, kind: "helper", helperId: rec.id, update: u }),
            log: this.log,
          });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (signal.aborted && !cancel.aborted) throw e; // a note arrived: handled by the caller
          if (e instanceof UsageLimitError && !cancel.aborted && !this.stopping) {
            limitedSince.t ||= Date.now();
            if (Date.now() - limitedSince.t < 24 * 3600_000) {
              const until = e.resetsAt ?? (await blockedUntil(e.backend)) ?? new Date(Date.now() + 15 * 60_000);
              this.log(`[${agentName}] helper ${rec.id}: ${e.backend} usage limit, waiting until ${until.toISOString()}`);
              await sleep(Math.max(60_000, until.getTime() - Date.now()), cancel);
              if (cancel.aborted || this.stopping) throw e;
              attempt = Math.max(attempt, 1);
              return run(text, signal);
            }
          }
          if (cancel.aborted || this.stopping || !isTransient(e)) throw e;
          if (!this.helperTrouble.has(rec.id)) this.helperTrouble.set(rec.id, { agent: agentName, since: new Date().toISOString(), backend: rec.backend ?? (await effectiveSettings(await loadAgent(agentName))).backend });
          this.changed(agentName, "helpers");
          await this.checkNetwork(await listAgents(), true);
          if (this.offlineSince) {
            // This machine is offline: no attempt is used up; it carries on once the connection is back.
            this.log(`[${agentName}] helper ${rec.id}: no internet, waiting for it to come back`);
            await this.untilOnline(cancel);
            attempt = Math.max(attempt, 1);
          } else {
            if (attempt >= HELPER_RETRY_MS.length) throw e;
            this.log(`[${agentName}] helper ${rec.id}: provider trouble, retrying (${msg.slice(0, 120)})`);
            await sleep(HELPER_RETRY_MS[attempt++], cancel);
          }
          if (cancel.aborted || this.stopping) throw e;
          return run(text, signal);
        }
      };
      try {
        for (;;) {
          const turn = new AbortController();
          this.helperTurns.set(key, turn);
          try {
            const r = await run(next, anySignal([cancel, turn.signal]));
            lastReply = r.reply || lastReply;
          } catch (e) {
            // Stopped to read a note: carry on below. Anything else ends the helper.
            if (!(turn.signal.aborted && !cancel.aborted && !this.stopping && this.helperNotes.get(key)?.length)) throw e;
          } finally {
            if (this.helperTurns.get(key) === turn) this.helperTurns.delete(key);
          }
          attempt = 0;
          const notes = this.helperNotes.get(key);
          this.helperNotes.delete(key);
          if (!notes?.length) {
            // From here a note can't reach this run: it carries the helper on afterwards instead.
            this.helperClosing.add(key);
            break;
          }
          next = noteText(notes, false);
        }
      } finally {
        if (this.helperTrouble.delete(rec.id)) this.changed(agentName, "helpers");
      }
      rec.status = "done";
      rec.result = ctx.result ?? (lastReply || "(It finished without describing its result. Check its folder.)");
    } catch (e: any) {
      this.helperClosing.add(key);
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
      this.helperNotes.delete(key);
      this.tools.close(ctx.token);
      this.emit("turnEnd", { agent: agentName, kind: "helper", helperId: rec.id });
    }
    rec.finishedAt = new Date().toISOString();
    await store.saveHelper(rec);
    this.helperClosing.delete(key);
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
    await updateState(name, { status: "stopped", nextWake: null, activity: "stopped", activityByAgent: false });
    this.monitors.stopAgent(name);
    // Cancel whatever it's running now: its main turn and helpers.
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
    await updateState(name, { status: hadJob ? "asleep" : "new", pausedUntil: null, pauseReason: null, failures: 0, activity: hadJob ? "resuming" : "waiting for its job", activityByAgent: false }, { allowStopped: true });
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
    if (a.state.status === "paused") await updateState(name, { status: hasIdentity(a) ? "asleep" : "new", pausedUntil: null, pauseReason: null, ...(a.state.activityByAgent ? {} : { activity: hasIdentity(a) ? "resting" : "waiting for its job" }) });
    await updateState(name, { failures: 0 });
    // Waking it means trying, whatever limit was recorded (a budget pause is the person's own setting).
    this.tryDespiteLimit.add(name);
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

/**
 * The recent conversation with the person, for a session that starts fresh (context full, an update, a
 * new model): the last 40 messages, newest last, at most about 16,000 characters.
 */
function recentConversation(all: Message[]): string {
  const shown = all.filter((m) => !m.closes).slice(-40);
  if (!shown.length) return "";
  const who = (m: Message) => (m.from === "you" ? "Person" : m.from === "agent" ? "You" : "Overtime");
  const lines = shown.map((m) => {
    const kind = m.kind === "question" ? " [your question]" : m.kind === "report" ? " [report]" : m.kind === "alert" ? " [alert]" : "";
    const answer = m.kind === "question" && m.answer ? `\n  (${m.answer.closed ? `${m.answer.closed}` : `answered: ${m.answer.text}`})` : m.kind === "question" ? "\n  (not answered yet)" : "";
    return `${who(m)} (${m.t})${kind}: ${withFiles(m.text, m.attachments)}${answer}`;
  });
  let text = lines.join("\n\n");
  if (text.length > 16_000) text = "…\n" + text.slice(-16_000);
  return `Your recent conversation with the person (most recent last):\n\n${text}\n\n---\n\n`;
}

function mainTurnText(items: InboxItem[], firstJob: boolean, contextReset: boolean): string {
  const parts: string[] = [];
  if (firstJob) {
    parts.push(
      "This is your first conversation. You don't have an identity yet. From what the person tells you, rewrite AGENT.md in your folder: who you are, your role, your goals (what you're working toward over time, not only the first task) and what good looks like, and your rules (what you must check with them first). Create INDEX.md. Reply to them with a short summary of what you understood and what you'll do first. Then start.",
    );
  }
  if (contextReset) parts.push("Note: this is a fresh session. Your earlier work session isn't carried over (your recent conversation with the person is above); your folder is. Check INDEX.md and your notes for where things stand.");
  parts.push(inboxBlock(items));
  parts.push("Reply with send to new messages from the person (not to ones passed on from your conversation: those were already answered, so never acknowledge them twice). Do the work, as part of your goals. Before this turn ends, bring your notes and INDEX.md up to date, decide the next useful step toward your goals, and choose when to wake.");
  return parts.join("\n\n");
}

/**
 * Which version of Overtime's instructions a session started with. Instructions are sent when a session
 * starts, so when they change (an update), the next turn starts a fresh session that gets the new ones.
 */
function promptVersion(kind: "main"): string {
  return createHash("sha1").update(workingInstructions("_", kind)).digest("hex").slice(0, 12);
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

${agentName} may send you a note while you work, or after you're done (to correct something or ask for more): it arrives as your next message. Take it into account, carry on from where you were, and call done again with the whole result.
${instructions ? `\n# Your role\n\n${instructions}\n` : ""}${skillsBlock(paths.agent(agentName)) ? `\n${skillsBlock(paths.agent(agentName))}\n` : ""}`;
}

/** Whether a session's context is full enough that a fresh one (rebuilt from the agent's files) is better. */

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
