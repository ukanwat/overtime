import { EventEmitter } from "node:events";
import { listSkills, skillsBlock } from "../skills.js";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { parseFrontMatter } from "../agent/frontmatter.js";
import { execFile } from "node:child_process";
import { isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createAgent, effectiveSettings, hasIdentity, isPublic, listAgents, loadAgent, publicAgents, publicButNew, restoreSettings, updateState, type Agent, type AgentState } from "../agent/agent.js";
import { newId, readJson, writeJson } from "../fsutil.js";
import { paths } from "../paths.js";
import { loadSettings, saveSettings } from "../settings.js";
import { withLock } from "../store/mutex.js";
import { Store, clampWake } from "../store/store.js";
import type { Attachment, Decision, HelperRecord, InboxItem, Message, Monitor } from "../store/types.js";
import { receiveAttachments } from "../store/attachments.js";
import type { ToolContext, ToolHost } from "../tools/host.js";
import { ToolServer } from "../tools/server.js";
import { AcpSession } from "../acp/session.js";
import { promptWasSent, runTurn, sessionPreamble, TurnIncompleteError, UsageLimitError, type TurnResult } from "../runtime/turn.js";
import { blockedUntil, gotThroughAt, limitInfo, LIMIT_RECHECK_MS, rejectedLimits, usageToday, type TurnUsage } from "../runtime/usage.js";
import { reflectInstructions, workingInstructions } from "../runtime/instructions.js";
import { boundInferred, importClaudeMemory, importHelperClaudeMemory, markStale, memoryFingerprint, memoryOverCap, memoryText } from "../agent/memory.js";
import { recentTurns, runIds, runTime, unreadChunk, unreadVolume } from "../agent/runlog.js";
import { StepBoundary } from "../runtime/boundary.js";
import { MonitorRunner, reapStaleMonitors } from "./monitors.js";
import { classify, isTransient, needsPerson } from "../runtime/errors.js";
import { describeStep, ownToolStep } from "./steps.js";
import { probeOnline } from "../runtime/network.js";

const exec = promisify(execFile);

const TICK_MS = 5_000;
const DEFAULT_WAKE_MS = 60 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/**
 * A backstop against running into a usage limit over and over, whatever lifted the pause: when this many
 * of an agent's turns since the last one that got through ended on a usage limit, all within one recheck
 * interval, its next turn waits until a full interval after the last of them (the person messaging or
 * waking it still tries at once).
 */
const LIMIT_HOT_TURNS = 3;

/** Until when an agent is held back because its last turns kept ending on a usage limit (see LIMIT_HOT_TURNS). */
export function limitHold(hits: string[] | undefined, now = Date.now()): Date | null {
  if (!hits || hits.length < LIMIT_HOT_TURNS) return null;
  const last = hits.slice(-LIMIT_HOT_TURNS).map((t) => new Date(t).getTime());
  if (last[last.length - 1] - last[0] >= LIMIT_RECHECK_MS) return null;
  const until = last[last.length - 1] + LIMIT_RECHECK_MS;
  return until > now ? new Date(until) : null;
}
/** How long a helper waits before retrying after a passing provider problem (tests shorten it). */
/** A backend that isn't signed in is checked again this often: it usually comes back once the person signs in. */
const SIGNIN_RETRY_MS = 5 * 60_000;
const HELPER_RETRY_MS = process.env.OVERTIME_FAST_RETRY ? [200, 400] : [60_000, 5 * 60_000];

/** Wait, unless the signal fires first. Leaves nothing on the signal, which may live as long as the daemon. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The reflect pass: a short session that keeps an agent's memory/ current from what it did. It reads
 * the agent's turns and chats once each, oldest first, from a cursor (the last run it read), a chunk at
 * a time, over as many passes as it takes. One is due while the agent is idle and a chunk's worth is
 * unread, its session was compacted, or it has been idle a while with anything unread; at most
 * REFLECT_PASSES_PER_DAY a day and REFLECT_BUDGET_SHARE of its daily budget.
 */
export const REFLECT_CHUNK_CHARS = 80_000;
export const REFLECT_IDLE_MS = 3600_000;
export const REFLECT_PASSES_PER_DAY = 10;
export const REFLECT_BUDGET_SHARE = 0.1;
/** Where an agent's first pass starts: this far back (older turns were seen by no pass, but they're old). */
export const REFLECT_BACKLOG_DAYS = 7;
/** After a pass is stopped (the person wrote) or fails: this much idle time first, doubling for each in a row. */
export const REFLECT_BACKOFF_MS = 30 * 60_000;
const REFLECT_BACKOFF_MAX_MS = 4 * 3600_000;
/** A part of its history that failed this many passes in a row is passed over, so it can't fail forever. */
const REFLECT_FAILS_BEFORE_SKIP = 3;
const REFLECT_TIMEOUT_MS = 15 * 60_000;
/** Claude Code tools a reflect pass doesn't get: it works with file tools only. */
const REFLECT_TOOLS_OFF = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch", "NotebookEdit", "Monitor"];

/**
 * Whether reflect passes run for an agent: its own `reflect` setting, else settings.json's (both kept
 * across restarts), on by default. OVERTIME_REFLECT=0 in the daemon's environment turns them off for all.
 */
export function reflectEnabled(eff: { reflect: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OVERTIME_REFLECT !== "0" && eff.reflect;
}
/** How long an agent must have been idle before even a full chunk or a compaction starts a pass: the person may still be talking to it. */
export const REFLECT_SETTLE_MS = process.env.OVERTIME_FAST_RETRY ? 0 : 5 * 60_000;

/** What a pass would read: unread turns, how long their digest is, and when the newest began. */
export type ReflectBacklog = { turns: number; chars: number; newest: Date | null };
/** Today's reflecting so far, against the caps. */
export type ReflectToday = { passes: number; usd: number; budgetUsd: number };

/** A day as the person's clock has it (YYYY-MM-DD). */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Why a reflect pass is due for this agent now (it is idle), or null. */
export function reflectDue(s: AgentState, backlog: ReflectBacklog, today: ReflectToday, now = Date.now(), settleMs = REFLECT_SETTLE_MS): string | null {
  if (!backlog.turns) return null;
  if (today.passes >= REFLECT_PASSES_PER_DAY) return null;
  if (today.budgetUsd > 0 && today.usd >= today.budgetUsd * REFLECT_BUDGET_SHARE) return null;
  const lastWork = Math.max(backlog.newest?.getTime() ?? 0, s.lastRunAt ? Date.parse(s.lastRunAt) : 0);
  // Stopped or failed last time: not again until it has been idle a while, longer for each in a row, so
  // a chatty day doesn't pay for one partial pass after another.
  if (s.reflectStops) {
    const wait = Math.min(REFLECT_BACKOFF_MS * 2 ** (s.reflectStops - 1), REFLECT_BACKOFF_MAX_MS);
    if (now - Math.max(lastWork, s.reflectStoppedAt ? Date.parse(s.reflectStoppedAt) : 0) < wait) return null;
  }
  const what = `${backlog.turns} turn${backlog.turns === 1 ? "" : "s"} not reflected yet`;
  if (now - lastWork < settleMs) return null;
  if (s.compactedSinceReflect) return `its session was compacted; ${what}`;
  if (backlog.chars >= REFLECT_CHUNK_CHARS) return what;
  if (now - lastWork >= REFLECT_IDLE_MS) return `idle, ${what}`;
  return null;
}

const MAX_HELPERS = 6;
/** Messages a pair of agents may exchange in a day (both directions together), so two can't loop forever. */
export const AGENT_MESSAGES_PER_DAY = 20;
/** Finished helpers' worktrees and copies are removed after this long (git branches are kept). */
const HELPER_KEEP_MS = 7 * 24 * 3600_000;
/** A non-git workspace is copied for a helper only below these sizes; above, the helper gets an empty folder. */
/** Run transcripts older than this are removed. */
const RUN_KEEP_MS = 30 * 24 * 3600_000;
const COPY_MAX_FILES = 5_000;
const COPY_MAX_BYTES = 200 * 1024 * 1024;

export type ChangeEvent = { agent: string; what: "messages" | "state" | "schedule" | "monitors" | "helpers" | "agents" };

/** A change to an agent's settings, as the person makes it from the app or the CLI. */
export type SettingsPatch = { backend?: string; model?: string | null; dailyBudgetUsd?: number; dailyTokenBudget?: number | null; workspace?: string | null; protect?: string[] | null; visibility?: string; reflect?: boolean | null; reflectModel?: string | null };

/** Why an agent can't spend right now (usage limit or daily budget), or null if it can. */
type Blocked = { kind: "limit"; until: Date; resetsAt: Date | null; backend: string } | { kind: "budget"; until: Date; text: string };

/**
 * An abort signal that fires when any of the given ones does. Node's own, which doesn't leave a listener
 * on each of them: the daemon's and an agent's signals outlive every turn.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

/** A fired controller: what a stopped agent's runs get, so they end at once. */
function stoppedSignal(): AbortController {
  const c = new AbortController();
  c.abort();
  return c;
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
  /** When each agent's latest main turn began taking its inbox (for the back-off: see checkAgent). */
  private lastAttempt = new Map<string, number>();
  /** Agents the person asked to run (a message, wake) while a usage limit was recorded: tried anyway. */
  private tryDespiteLimit = new Set<string>();
  private helperRuns = new Map<string, Promise<void>>();
  /** Notes for running helpers, read at their next turn (by "agent/id"). */
  private helperNotes = new Map<string, string[]>();
  /** Each running helper's current turn, stopped when a note arrives. */
  private helperTurns = new Map<string, AbortController>();
  /** Finished helpers a note is starting again right now (by "agent/id"); settles once started, or with why not. */
  private helperStarting = new Map<string, Promise<string>>();
  /** Helpers past the point where a note reaches the running session; a note then carries them on afterwards. */
  private helperClosing = new Set<string>();
  /** Running helpers' records (the one their run saves), and the step each is on. */
  private liveHelpers = new Map<string, HelperRecord>();
  private helperSteps = new Map<string, string>();
  /** Cancels the running main turn of an agent, to answer the person (see deliver). */
  private mainAborts = new Map<string, AbortController>();
  /** Where each running turn is between steps (main by agent name, helpers by agent/id), so it's stopped only between them. */
  private boundaries = new Map<string, StepBoundary>();
  /** Agents whose running main turn was interrupted by the person: not a failure, it carries on next turn. */
  private interrupted = new Set<string>();
  /** Each agent's running reflect pass: cancelled when its main session has work to do, and done once its session has stopped. */
  private reflecting = new Map<string, { ctl: AbortController; done: Promise<void> }>();
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
      async (a) => {
        const eff = await effectiveSettings(await loadAgent(a));
        return { protect: eff.protect, hide: eff.hidden };
      },
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
    else this.agentAborts.set(a.name, stoppedSignal());
    // A last message from the person that never reached the agent (an older version answered messages
    // in a separate session): hand it over now, so it's answered.
    if (a.state.status === "stopped") return;
    const all = await store.messages();
    const last = all.at(-1);
    // Already handed to the agent (it may have answered by doing the work, not in words), or waiting to be
    // (items in flight went back to the inbox above): not again.
    const queued = new Set((await store.inbox()).map((i) => i.messageId).filter(Boolean));
    const delivered = await store.deliveredMessageIds();
    if (last?.from === "you" && !last.replyTo && !last.closes && !queued.has(last.id) && !delivered.has(last.id)) await store.pushInbox({ type: "message", text: withFiles(last.text, last.attachments), messageId: last.id, attachments: last.attachments });
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

  /**
   * The signal for anything an agent runs: fires on shutdown or when the agent is stopped. A stopped
   * agent's stays fired until the person starts it again, so nothing it had waiting (a retry, a turn
   * about to start) runs after the stop.
   */
  private signalFor(agent: string, extra?: AbortSignal): AbortSignal {
    let c = this.agentAborts.get(agent);
    if (!c) this.agentAborts.set(agent, (c = new AbortController()));
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
    if (ctx.kind === "helper" && ctx.helperId) this.helperSteps.set(`${ctx.agent}/${ctx.helperId}`, ownToolStep(tool));
    this.emit("step", { agent: ctx.agent, kind: ctx.kind, helperId: ctx.helperId, step: ownToolStep(tool) });
  }

  async setActivity(agent: string, text: string): Promise<void> {
    await updateState(agent, { ownStatus: text.replace(/\s+/g, " ").trim().slice(0, 80) });
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
    // Real work comes first: a reflect pass running now stops, and runs again another time.
    const reflecting = this.reflecting.get(agent);
    reflecting?.ctl.abort();
    if (this.mainRunning.has(agent)) {
      const q = this.pendingWake.get(agent) ?? [];
      q.push(reason);
      this.pendingWake.set(agent, q);
      return;
    }
    // The main turn starts once the pass has actually stopped (a few seconds at most): until then its
    // session can still write memory/.
    const run = (reflecting?.done ?? Promise.resolve())
      .then(() => this.runMain(agent, reason))
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

  /**
   * AGENT.md's settings block only shows the settings, which change only from the app or overtime set:
   * anything else that changed it (the agent, a helper, a script, git, a hand edit) is undone. Checked on
   * every tick while its main session isn't running (it may be mid-rewrite), and right before each turn.
   */
  private async restoreSettingsBlock(agent: string): Promise<void> {
    if (await restoreSettings(agent)) this.log(`[${agent}] put back its settings in AGENT.md (they change only from the app or overtime set)`);
  }

  private async checkAgent(a: Agent, now: Date): Promise<void> {
    if (this.mainRunning.has(a.name)) return;
    await this.restoreSettingsBlock(a.name);
    a = await loadAgent(a.name);
    if (a.state.status === "stopped" || this.mainRunning.has(a.name)) return;
    const store = this.store(a.name);
    if (a.state.status === "paused") {
      // A budget pause lifts as soon as the budget is raised. A limit pause lifts at its next try, or
      // sooner only when a turn on the same backend and model (any agent's) got through since it began:
      // what other models report says nothing about this one's limits.
      const lifted = a.state.pauseReason === "budget" ? !(await this.blocked(a.name)) : a.state.pauseReason === "limit" ? await this.limitLifted(a) : false;
      if (!lifted && a.state.pausedUntil && new Date(a.state.pausedUntil) > now) return;
      await updateState(a.name, { status: hasIdentity(a) ? "asleep" : "new", pausedUntil: null, pausedAt: null, pauseReason: null, activity: hasIdentity(a) ? "resting" : "waiting for its job" });
      this.changed(a.name, "state");
      a = await loadAgent(a.name);
    }
    const sched = await store.schedule();
    // After a failed turn, wait out the back-off even if there's work waiting. Not with something new from
    // the person (it came after the last try): that's tried at once, once. If it fails too, the back-off goes on.
    if (((a.state.failures ?? 0) > 0 || (a.state.transientFailures ?? 0) > 0) && sched.wakeAt && new Date(sched.wakeAt) > now) {
      const since = this.lastAttempt.get(a.name) ?? 0;
      const fromPerson = (await store.inbox()).some((i) => (i.type === "answer" || (i.type === "message" && !(i.data as any)?.fromChat)) && new Date(i.t).getTime() > since);
      if (!fromPerson) return;
    }
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
    // Idle (asleep, no main turn, no helpers): time to reflect, if one is due.
    const trigger = a.state.status === "asleep" && hasIdentity(a) && !this.reflecting.has(a.name) && !(await store.helpers()).some((h) => h.status === "running") ? await this.reflectTrigger(a, now) : null;
    if (trigger) {
      const ctl = new AbortController();
      const done = this.reflect(a.name, trigger, ctl)
        .catch((e) => this.log(`[${a.name}] reflect: ${e?.stack ?? e}`))
        .finally(() => {
          if (this.reflecting.get(a.name)?.ctl === ctl) this.reflecting.delete(a.name);
        });
      this.reflecting.set(a.name, { ctl, done });
    }
  }

  /** Whether a limit pause can end before its next try: a turn on its backend and model got through since it began. */
  private async limitLifted(a: Agent): Promise<boolean> {
    if (limitHold(a.state.limitHits)) return false;
    const eff = await effectiveSettings(a);
    // Paused before pauses were dated: that no limit is still recorded for its model is enough.
    if (!a.state.pausedAt) return !(await rejectedLimits(eff.backend, eff.model)).length;
    const through = await gotThroughAt(eff.backend, eff.model);
    return !!through && through > new Date(a.state.pausedAt);
  }

  /**
   * Usage limit or daily budget: whether this agent may spend right now, on its own backend and model or
   * (a helper) the ones given. A model of null or undefined with a backend given means the agent's model.
   */
  private async blocked(agentName: string, backend?: string, model?: string | null): Promise<Blocked | null> {
    const agent = await loadAgent(agentName);
    const eff = await effectiveSettings(agent);
    const b = backend ?? eff.backend;
    const lim = await limitInfo(b, model ?? eff.model);
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
    await updateState(agentName, { status: "paused", pausedUntil: b.until.toISOString(), pausedAt: new Date().toISOString(), activity: b.kind === "limit" ? `paused: ${b.backend} usage limit` : "paused: daily budget used", pauseReason: b.kind === "limit" ? "limit" : "budget", limitResetsAt: b.kind === "limit" ? (b.resetsAt?.toISOString() ?? null) : null });
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
    await this.restoreSettingsBlock(agentName);
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
    // Its last turns kept ending on a usage limit: not again before a full recheck interval has passed.
    const hold = forced ? null : limitHold(agent.state.limitHits);
    if (hold) {
      await this.pauseFor(agentName, { kind: "limit", until: hold, resetsAt: agent.state.limitResetsAt ? new Date(agent.state.limitResetsAt) : null, backend: eff.backend });
      return true;
    }

    // Once: what Claude's own memory kept for this agent's folders comes over into memory/ (originals stay).
    if (!agent.state.memoryImportedAt) {
      const r = await importClaudeMemory(agent.dir, [agent.dir, eff.workspace]).catch((e) => (this.log(`[${agentName}] importing Claude's memories: ${e?.message ?? e}`), null));
      if (r) {
        await updateState(agentName, { memoryImportedAt: new Date().toISOString() });
        if (r.files) this.log(`[${agentName}] copied ${r.files} of Claude's memories into memory/ (from ${r.from.join(", ")}; the originals are kept)`);
        agent = await loadAgent(agentName);
      }
    }
    // Facts that can change and haven't been checked for long are marked in the index (and unmarked once
    // checked), so this turn sees which to check before relying on them.
    if ((await markStale(agent.dir).catch(() => 0)) > 0) agent = await loadAgent(agentName);
    // And once, what Claude kept in its helpers' folders (an agent imported before this came in gets it too).
    if (!agent.state.helperMemoryImportedAt) {
      const r = await importHelperClaudeMemory(agent.dir).catch((e) => (this.log(`[${agentName}] importing its helpers' Claude memories: ${e?.message ?? e}`), null));
      if (r) {
        await updateState(agentName, { helperMemoryImportedAt: new Date().toISOString() });
        if (r.files) this.log(`[${agentName}] copied ${r.files} of Claude's memories from its helpers' folders into memory/ (from ${r.from.length} helper${r.from.length === 1 ? "" : "s"}; the originals are kept)`);
        agent = await loadAgent(agentName);
      }
    }

    const firstJob = !hasIdentity(agent);
    const runId = newId("main");
    this.lastAttempt.set(agentName, Date.now());
    const items = await store.takeInbox(runId);
    const turnCtl = new AbortController();
    this.mainAborts.set(agentName, turnCtl);
    const boundary = new StepBoundary();
    this.boundaries.set(agentName, boundary);
    this.interrupted.delete(agentName);
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "main", depth: 0 });
    let result: TurnResult | null = null;
    /** The session this turn ran in, once known. */
    let sessionId: string | undefined;
    try {
      // Overtime's line says what this turn is about, the same all turn (live steps there were too much
      // churn to read); it shows when the agent has no status line of its own.
      await updateState(agentName, { status: "working", activity: firstJob ? "learning its job" : await turnAbout(store, items) });
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
        // Items an unfinished turn already showed this same session are marked as such; a fresh one gets them as new.
        text: (fresh) => (fresh ? recentConversation(convo) : newInstructions + edits) + mainTurnText(items, firstJob, fresh && !!agent.state.mainSessionId, fresh ? null : resume, memoryOverCap(agent.memory)),
        switchModel: !sameModel,
        header: await this.turnHeader(agentName),
        resumeSessionId: resume,
        extraMcp: [mcp],
        timeoutMs: settings.turnTimeoutMinutes * 60_000,
        signal: this.signalFor(agentName, turnCtl.signal),
        // Recorded as soon as the session exists, so a turn interrupted to answer you resumes this session.
        onSession: (id) => {
          sessionId = id;
          void updateState(agentName, { mainSessionId: id, mainSessionBackend: eff.backend, mainSessionModel: eff.model ?? null, mainSessionPrompt: promptVersion("main") }).catch(() => {});
        },
        onUpdate: (u) => {
          boundary.update(u);
          this.emit("update", { agent: agentName, kind: "main", update: u });
        },
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
      const patch: Partial<AgentState> = { status: hasIdentity(agent) ? "asleep" : "new", failures: 0, transientFailures: 0, troubleSince: null, lastError: null, limitHits: [], mainSessionFiles: fileHashes(agent), mainSessionPrompt: promptVersion("main"), turnsSinceReflect: (agent.state.turnsSinceReflect ?? 0) + 1, activity: hasIdentity(agent) ? "resting" : "waiting for its job", ...(result.compacted ? { compactedSinceReflect: true } : {}) };
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
      // Kept until a turn finishes. If the agent was already shown them, they're marked: the same session,
      // continued, is reminded of them rather than handed them as new (and answering them twice).
      await store.returnInbox(runId, promptWasSent(e) ? sessionId : undefined);
      if (agent.state.status === "stopped") {
        this.log(`[${agentName}] main turn ended because the agent was stopped`);
        return true;
      }
      if (e instanceof UsageLimitError) {
        // Tried again in a while (the limit can lift before its reset), or at the reset if that's sooner.
        const recheck = new Date(Date.now() + LIMIT_RECHECK_MS);
        const until = e.resetsAt && e.resetsAt < recheck ? e.resetsAt : recheck;
        const limitHits = [...(agent.state.limitHits ?? []), new Date().toISOString()].slice(-LIMIT_HOT_TURNS);
        await updateState(agentName, { status: "paused", pausedUntil: until.toISOString(), pausedAt: new Date().toISOString(), limitHits, activity: `paused: ${eff.backend} usage limit`, pauseReason: "limit", limitResetsAt: e.resetsAt?.toISOString() ?? null });
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
        await updateState(agentName, { status: idle, transientFailures: n, troubleSince: since, activity: `waiting: ${eff.backend} is having trouble`, lastError: null });
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
      const wait = hint ? (classify(e) === "signin" ? SIGNIN_RETRY_MS : BACKOFF_MS[BACKOFF_MS.length - 1]) : BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, failures - 1)];
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
      if (this.boundaries.get(agentName) === boundary) this.boundaries.delete(agentName);
      this.tools.close(ctx.token);
      this.emit("turnEnd", { agent: agentName, kind: "main" });
      await this.refreshNextWake(agentName).catch(() => {});
      this.changed(agentName, "state");
    }
  }

  /** Where this agent's reflecting reads on from: its cursor, or for its first pass, the start of its last few days. */
  private async reflectCursor(a: Agent, now = Date.now()): Promise<string | null> {
    if (a.state.reflectCursor !== undefined) return a.state.reflectCursor;
    const from = now - REFLECT_BACKLOG_DAYS * 86400_000;
    const cursor = (await runIds(a.name)).filter((id) => runTime(id) < from).at(-1) ?? null;
    await updateState(a.name, { reflectCursor: cursor });
    a.state.reflectCursor = cursor;
    return cursor;
  }

  /** Why a reflect pass is due for an idle agent now (see reflectDue), or null. */
  private async reflectTrigger(a: Agent, now: Date): Promise<string | null> {
    // Offline, a pass could only fail; turned off, it never starts (and no cursor is set meanwhile, so
    // turning it on later starts from the last few days, not from whenever it was turned off).
    if (this.offlineSince) return null;
    const eff = await effectiveSettings(a);
    if (!reflectEnabled(eff)) return null;
    const backlog = await unreadVolume(a.name, await this.reflectCursor(a, now.getTime()), now.getTime());
    if (!backlog.turns) return null;
    const day = localDate(now);
    const passes = a.state.reflectDay?.day === day ? a.state.reflectDay.passes : 0;
    const usd = (await usageToday(a.name, now, "reflect")).usd;
    return reflectDue(a.state, backlog, { passes, usd, budgetUsd: eff.dailyBudgetUsd }, now.getTime());
  }

  /**
   * A reflect pass: a short session, in the agent's folder, that reads the next part of what it did
   * (from its cursor, oldest first, a chunk at a time) and makes small edits to memory/, each citing the
   * runs it comes from. It may change nothing else (see runtime/write-scope.ts): it sees AGENT.md,
   * INDEX.md and the skills only to compare against, and what it thinks they lack becomes a memory.
   * It runs on the agent's backend, on its reflectModel (default: its model). It counts toward the
   * agent's budget, waits while it's paused or over a limit, and posts nothing to the person: one quiet
   * line in its activity, and a commit in its folder's history. A usage limit it runs into is never
   * recorded against the agent's real work: the pass just ends and is tried again later.
   */
  private async reflect(agentName: string, trigger: string, ctl: AbortController): Promise<void> {
    const agent = await loadAgent(agentName);
    if (agent.state.status !== "asleep" || (await this.blocked(agentName)) || limitHold(agent.state.limitHits)) return;
    const eff = await effectiveSettings(agent);
    if (!reflectEnabled(eff)) return;
    const cursor = await this.reflectCursor(agent);
    const chunk = await unreadChunk(agentName, cursor, REFLECT_CHUNK_CHARS);
    if (!chunk.turns.length) {
      // Nothing to read but empty logs: the cursor moves past them.
      if (chunk.last && chunk.last !== cursor) await updateState(agentName, { reflectCursor: chunk.last });
      return;
    }
    const day = localDate(new Date());
    await updateState(agentName, { reflectDay: { day, passes: (agent.state.reflectDay?.day === day ? agent.state.reflectDay.passes : 0) + 1 } });
    const memDir = join(agent.dir, "memory");
    await mkdir(memDir, { recursive: true });
    const files = (await readdir(memDir).catch(() => [] as string[])).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    const first = chunk.turns[0].at.toISOString().slice(0, 16).replace("T", " ");
    const last = chunk.turns.at(-1)!.at.toISOString().slice(0, 16).replace("T", " ");
    const text = [
      `# AGENT.md (read-only: never edit it)\n\n${agent.identity.trim() || "(empty)"}`,
      `# INDEX.md (read-only)\n\n${agent.index.trim() || "(none yet)"}`,
      `# Skills (read-only: never edit them)\n\n${listSkills(agent.dir).map((k) => `- ${k.name} (${k.source}${k.source === "built-in" ? "" : `, ${k.file}`}): ${k.description}`).join("\n") || "(none)"}`,
      `# memory/MEMORY.md now\n\n${agent.memory.trim() ? memoryText(agent.memory) : "(empty)"}${memoryOverCap(agent.memory)}`,
      `# Files in memory/\n\n${files.join("\n") || "(none)"}`,
      `# Lines its helpers marked "learned:"\n\n${chunk.learned.join("\n") || "(none in these turns)"}`,
      `# What ${agentName} did, ${first} to ${last} UTC (${chunk.turns.length} turns${chunk.left ? `; ${chunk.left} later ones come in the next pass` : ""})\n\n${chunk.text}`,
    ].join("\n\n---\n\n");
    const { ctx, mcp } = this.tools.open({ agent: agentName, kind: "reflect", depth: 0 });
    const runId = newId("reflect");
    const before = await memoryFingerprint(agent.dir);
    const filesBefore = new Set(await readdir(memDir).catch(() => [] as string[]));
    let reply = "";
    let ok = false;
    let transient = false;
    try {
      const r = await runTurn({
        runId,
        agent: agentName,
        kind: "reflect",
        model: eff.reflectModel,
        // Housekeeping: a limit it hits says nothing Overtime should act on for the agent's own turns.
        recordLimits: false,
        reason: `a reflect pass (${trigger})`,
        text,
        preamble: reflectInstructions(agentName, agent.dir),
        cwd: agent.dir,
        // Only Overtime's own tools (skills, to compare against): none of the agent's MCP servers.
        extraMcp: [mcp],
        agentServers: false,
        writable: [memDir],
        disallowedTools: REFLECT_TOOLS_OFF,
        timeoutMs: REFLECT_TIMEOUT_MS,
        signal: this.signalFor(agentName, ctl.signal),
        // Quiet: not shown live in the app, only counted as proof the connection works.
        onUpdate: () => {
          this.lastProgress = Date.now();
        },
        log: this.log,
      });
      reply = r.reply;
      ok = true;
    } catch (e: any) {
      // Offline, a passing provider problem or a usage limit: nothing wrong with these turns, so it
      // only waits, and never counts toward passing them over.
      transient = e instanceof UsageLimitError || isTransient(e) || !!this.offlineSince;
      if (!(ctl.signal.aborted && !this.stopping)) this.log(`[${agentName}] reflect pass ${transient ? "couldn't run now (tried again later)" : "failed"}: ${String(e?.message ?? e).split("\n")[0]}`);
    } finally {
      this.tools.close(ctx.token);
    }
    if (this.stopping) return;
    // Patterns it inferred are held to their bounds, whether the pass finished or not.
    for (const r of await boundInferred(agent.dir, filesBefore).catch(() => [])) this.log(`[${agentName}] reflect pass inferred a pattern in ${r.file} with ${r.why}; removed it`);
    await markStale(agent.dir).catch(() => 0);
    const now = new Date().toISOString();
    const st = (await loadAgent(agentName)).state;
    if (!ok) {
      // Stopped for real work, or failed: the same turns are read again, once it has been idle a while.
      // A part of its history that keeps failing is passed over rather than paid for again and again.
      const stopped = ctl.signal.aborted;
      const failures = stopped || transient ? st.reflectFailures ?? 0 : (st.reflectFailures ?? 0) + 1;
      const skip = failures >= REFLECT_FAILS_BEFORE_SKIP;
      await updateState(agentName, { reflectStops: (st.reflectStops ?? 0) + 1, reflectStoppedAt: now, reflectFailures: skip ? 0 : failures, ...(skip ? { reflectCursor: chunk.last } : {}) });
      if (stopped) this.log(`[${agentName}] reflect pass stopped: its main session has work`);
      if (skip) this.log(`[${agentName}] reflect pass failed ${failures} times on its turns ${first} to ${last} UTC; passed over them`);
      return;
    }
    await updateState(agentName, { reflectCursor: chunk.last, lastReflectAt: now, turnsSinceReflect: 0, compactedSinceReflect: false, reflectStops: 0, reflectStoppedAt: null, reflectFailures: 0 });
    const said = reply.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const changed = (await memoryFingerprint(agent.dir)) !== before;
    this.log(`[${agentName}] reflect pass over its turns ${first} to ${last} UTC (${trigger}): ${changed ? said.slice(0, 300) || "changed its memory" : "nothing to change"}`);
    await this.store(agentName).addReport(`Reflect pass: ${changed ? `updated its memory${said ? `: ${said.slice(0, 300)}` : ""}` : "nothing to change"}.`);
    this.changed(agentName, "state");
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
    if (b?.kind === "limit" || (!b && limitHold(agent.state.limitHits))) {
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
      // At the next step: a tool that's running finishes first.
      const boundary = this.boundaries.get(agentName);
      if (boundary) boundary.stop(() => running.abort());
      else running.abort();
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

  async spawnHelper(ctx: ToolContext, req: { role?: string; instructions?: string; task: string; backend?: string; model?: string; withContext?: boolean }): Promise<{ id: string; workdir: string; note?: string }> {
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
    // On the helper's own backend and model: another model may be over its limit while this one isn't.
    const b = await this.blocked(ctx.agent, req.backend, req.model);
    if (b) throw new Error(`Can't start a helper: ${this.blockedLine(b)}.`);
    // With the agent's context: what it has been told, done and said lately, from Overtime's own records
    // of its sessions, so it works the same on every backend (and the helper keeps its own folder).
    const contextText = req.withContext ? (await recentTurns(ctx.agent, 40_000)) || recentConversation(await store.messages()) || undefined : undefined;
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
        ...(contextText ? { contextText } : {}),
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
        // Only now: until the run is gone, a note waits for it to finish and then carries it on.
        this.helperClosing.delete(key);
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

  /** A helper reports how it's going: kept on its record, and in the agent's inbox (urgent: it wakes the agent). */
  async helperUpdate(ctx: ToolContext, text: string, urgent: boolean): Promise<void> {
    if (ctx.kind !== "helper" || !ctx.helperId) throw new Error("Only helpers send updates; use send to write to the person.");
    const key = `${ctx.agent}/${ctx.helperId}`;
    const store = this.store(ctx.agent);
    const rec = this.liveHelpers.get(key) ?? (await store.helpers()).find((h) => h.id === ctx.helperId);
    if (!rec) throw new Error("This helper isn't known any more.");
    rec.updates = [...(rec.updates ?? []), { t: new Date().toISOString(), text }].slice(-20);
    await store.saveHelper(rec);
    await store.pushInbox({ type: "helper-update", text: `${rec.id} (${rec.task.split("\n")[0].slice(0, 80)}): ${text}`, data: { helperId: rec.id } });
    this.changed(ctx.agent, "helpers");
    if (urgent) this.wakeMain(ctx.agent, `helper ${rec.id} sent an urgent update`);
  }

  /**
   * One agent messages another. It lands in the receiver's inbox, labelled with who sent it, and shows in
   * both conversations with the person. It wakes the receiver like anything else in its inbox: a running
   * turn picks it up next, and a stopped or paused agent finds it when it's back. Only between public
   * agents, and at most AGENT_MESSAGES_PER_DAY a day for each pair. Throws, with the reason, when refused.
   */
  async messageAgent(from: string, to: string, text: string): Promise<void> {
    if (to === from) throw new Error("That's you: message another agent.");
    const listed = publicAgents().map((a) => a.name);
    // The sender is judged by its settings, not its job: a new agent can send from its first session.
    if (!isPublic(from)) throw new Error("Only public agents can message other agents.");
    const others = listed.filter((n) => n !== from).join(", ") || "none";
    if (!listed.includes(to) && publicButNew(to)) throw new Error(`${to} exists but hasn't been set up yet: the person hasn't given it its job, so it can't take messages. Agents you can message: ${others}.`);
    // A private agent is answered exactly like one that doesn't exist.
    if (!listed.includes(to)) throw new Error(`There's no agent called "${to}". Agents you can message: ${others}.`);
    const pair = [from, to].sort().join(" and ");
    const over = await withLock("agent-messages", async () => {
      const file = join(paths.agentsDir(), "..", "agent-messages.json");
      const d = new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const rec = await readJson<{ day: string; pairs: Record<string, { count: number; alerted?: boolean }> }>(file, { day, pairs: {} });
      // A record from an earlier day starts over.
      const today = rec.day === day ? rec : { day, pairs: {} };
      const p = (today.pairs[pair] ??= { count: 0 });
      const result = p.count >= AGENT_MESSAGES_PER_DAY ? (p.alerted ? "again" : "first") : null;
      if (result) p.alerted = true;
      else p.count++;
      await writeJson(file, today);
      return result;
    });
    if (over) {
      if (over === "first") {
        // Once a day per pair, the person hears of it: the two may be going round in circles.
        await this.store(from).addMessage({ from: "overtime", kind: "alert", title: `${pair} hit their daily message limit`, text: `${from} and ${to} have sent each other ${AGENT_MESSAGES_PER_DAY} messages today, the most a pair can in a day. More are refused until tomorrow. If they're going round in circles, look at both conversations.`, baseDir: paths.agent(from) });
        this.notify(`${from} and ${to} hit their message limit`, `${AGENT_MESSAGES_PER_DAY} messages between them today; more are refused until tomorrow.`);
        this.changed(from, "messages");
      }
      throw new Error(`Not sent: you and ${to} have exchanged ${AGENT_MESSAGES_PER_DAY} messages today, the most a pair can in a day. Try again tomorrow, or tell the person if it can't wait.`);
    }
    await this.store(to).pushInbox({ type: "agent", text, data: { from } });
    for (const name of [from, to]) {
      await this.store(name).addMessage({ from: "agent", kind: "agent-message", fromAgent: from, toAgent: to, text, baseDir: paths.agent(name) });
      this.changed(name, "messages");
    }
    const status = (await loadAgent(to)).state.status;
    if (status !== "stopped" && status !== "paused") this.wakeMain(to, `a message from ${from}`);
  }

  /** The agent's helpers right now: running ones (what each is doing and said last), then recent ones. */
  async helpersReport(agentName: string): Promise<string> {
    const all = await this.store(agentName).helpers();
    const ago = (iso?: string) => {
      if (!iso) return "";
      const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
      return m < 1 ? "just now" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
    };
    const running = all.filter((h) => h.status === "running");
    const recent = all
      .filter((h) => h.status !== "running" && h.finishedAt && Date.now() - new Date(h.finishedAt).getTime() < 3 * 86400_000)
      .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
      .slice(0, 10);
    if (!running.length && !recent.length) return "No helpers running, and none finished in the last 3 days.";
    const line = (h: HelperRecord) => {
      const live = this.liveHelpers.get(`${agentName}/${h.id}`) ?? h;
      const out = [`${h.id} · ${h.status}${h.status === "running" ? ` for ${ago(h.startedAt)}` : ` ${ago(h.finishedAt)} ago`} · ${h.task.split("\n")[0].slice(0, 100)}`];
      const step = this.helperSteps.get(`${agentName}/${h.id}`);
      if (h.status === "running" && step) out.push(`  now: ${step}`);
      const last = live.updates?.at(-1);
      if (last) out.push(`  last update (${ago(last.t)} ago): ${last.text.slice(0, 300)}`);
      if (h.status !== "running" && h.result) out.push(`  result: ${h.result.split("\n")[0].slice(0, 200)}`);
      out.push(`  folder: ${h.workdir}${h.cleanedAt ? " (removed)" : ""}`);
      return out.join("\n");
    };
    return [
      ...(running.length ? [`Running (${running.length}):`, ...running.map(line)] : []),
      ...(recent.length ? [`${running.length ? "\n" : ""}Finished recently:`, ...recent.map(line)] : []),
      `\nEach helper session's full log is in ${join(paths.meta(agentName), "runs")} (helper_*.jsonl).`,
    ].join("\n");
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
    // Being carried on by an earlier note right now: once it has started, this is a note to it (and if
    // it couldn't start, this one can't either, for the same reason).
    const starting = this.helperStarting.get(key);
    if (starting) await starting;
    if (this.helperRuns.has(key) && !this.helperClosing.has(key)) {
      const notes = this.helperNotes.get(key) ?? [];
      notes.push(text);
      this.helperNotes.set(key, notes);
      // Its current turn stops at the next step (a tool that's running finishes first); the next turn
      // starts with the note, in the same session.
      const turn = this.helperTurns.get(key);
      const boundary = this.boundaries.get(key);
      if (turn && boundary) boundary.stop(() => turn.abort());
      else turn?.abort();
      return `Told ${id}. It reads this as soon as its current step finishes, and carries on.`;
    }
    // Finishing just now: wait for it, then carry on from there.
    await this.helperRuns.get(key)?.catch(() => {});
    // Another note may have got in first while this one waited: then it's a note to that run.
    if (this.helperStarting.has(key) || this.helperRuns.has(key)) return this.tellHelper(agentName, id, text);
    // Claimed at once (nothing awaited since the check above), so two notes at once can't both start it.
    const started = this.carryOnHelper(agentName, id, text);
    this.helperStarting.set(key, started);
    try {
      return await started;
    } finally {
      if (this.helperStarting.get(key) === started) this.helperStarting.delete(key);
    }
  }

  /** Start a finished helper again from where it was, with a note as its next instruction. */
  private async carryOnHelper(agentName: string, id: string, text: string): Promise<string> {
    const key = `${agentName}/${id}`;
    const store = this.store(agentName);
    const now = (await store.helpers()).find((h) => h.id === id)!;
    if (now.cleanedAt || !existsSync(now.workdir)) throw new Error(`${id}'s folder was removed (a week after it finished), so it can't carry on. Start a new helper.`);
    if (this.stopping) throw new Error("Overtime is shutting down; tell it next turn.");
    const agent = await loadAgent(agentName);
    const eff = await effectiveSettings(agent);
    const b = await this.blocked(agentName, now.backend, now.model);
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
    const run: Promise<void> = this.runHelper(agentName, now, instructions, eff.workspace, "", ctl.signal, text)
      .catch((e) => this.log(`[${agentName}] helper ${now.id}: ${e?.stack ?? e}`))
      .finally(() => {
        // Only its own: a later run of the same helper may already be registered.
        if (this.helperRuns.get(key) !== run) return;
        this.helperRuns.delete(key);
        this.helperClosing.delete(key);
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
    /** The first turn: its task, and, when started with the agent's context, what the agent has been doing. */
    const firstText = () => `${task}${rec.contextText ? `\n\n# What ${agentName} has been doing lately (for context: you know what it knows)\n\n${rec.contextText}` : ""}`;
    /** A turn's text: what it's told now, and, in a session started afresh, its task too. */
    const noteText = (notes: string[], resumed: boolean) => (fresh: boolean) =>
      `${resumed ? `${agentName} wants you to carry on (you had stopped). ` : ""}A note from ${agentName}, who started you:\n\n${notes.join("\n\n")}\n\n` +
      (fresh ? `(This is a new session. ${task}\n\nWhat you already did is in your folder: check it, and carry on from there.)` : "Take it into account and carry on from where you were.") +
      (resumed ? " When you're finished, call done again with the whole result." : "");
    let next: (fresh: boolean) => string = continueWith ? noteText([continueWith], true) : firstText;
    /** The notes the next turn's text is made of (none for its first task), and whether they carry it on. */
    let told: string[] = continueWith ? [continueWith] : [];
    let resumed = !!continueWith;
    this.liveHelpers.set(key, rec);
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
        // Each attempt starts with nothing in flight; a stop still waiting carries over.
        this.boundaries.set(key, new StepBoundary(this.boundaries.get(key)));
        try {
          const r = await runTurn({
            agent: agentName,
            kind: "helper",
            reason: `${agentName} gave you a task`,
            text: (fresh) => (attempt ? `${text(fresh)}\n\n${cutOff}` : text(fresh)),
            preamble,
            cwd: rec.workdir,
            backend: rec.backend,
            model: rec.model ?? undefined,
            extraMcp: [mcp],
            // The agent's memory is its own: a helper reads it, and reports what it learned in done.
            protect: [join(paths.agent(agentName), "memory")],
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
            onUpdate: (u) => {
              this.boundaries.get(key)?.update(u);
              const step = describeStep(u);
              if (step) this.helperSteps.set(key, step);
              this.emit("update", { agent: agentName, kind: "helper", helperId: rec.id, update: u });
            },
            log: this.log,
          });
          // It got through: a later limit gets its own day of waiting.
          limitedSince.t = 0;
          return r;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (signal.aborted && !cancel.aborted) throw e; // a note arrived: handled by the caller
          // Nothing of the failed attempt is running any more: a note arriving while it waits stops the
          // wait at once (a stop still pending from the attempt fires now).
          this.boundaries.set(key, new StepBoundary(this.boundaries.get(key)));
          /** Whether to give up waiting: cancelled, stopped, shutting down, or a note arrived (the caller reads it). */
          const over = () => signal.aborted || this.stopping;
          const waiting = this.signalFor(agentName, signal);
          if (e instanceof UsageLimitError && !over()) {
            limitedSince.t ||= Date.now();
            if (Date.now() - limitedSince.t < 24 * 3600_000) {
              const until = e.resetsAt ?? (await blockedUntil(e.backend, e.model)) ?? new Date(Date.now() + 15 * 60_000);
              this.log(`[${agentName}] helper ${rec.id}: ${e.backend} usage limit, waiting until ${until.toISOString()}`);
              // Checked every minute: a turn of any agent on the same model getting through clears the limit
              // (it often lifts before the reset it gave), and then this helper carries on too.
              const end = Math.max(Date.now() + 60_000, until.getTime());
              while (Date.now() < end && !over() && !waiting.aborted) {
                await sleep(Math.min(60_000, end - Date.now()), waiting);
                if (!(await rejectedLimits(e.backend, e.model)).length) break;
              }
              if (over() || waiting.aborted) throw e;
              attempt = Math.max(attempt, 1);
              return run(text, signal);
            }
          }
          if (over() || !isTransient(e)) throw e;
          if (!this.helperTrouble.has(rec.id)) this.helperTrouble.set(rec.id, { agent: agentName, since: new Date().toISOString(), backend: rec.backend ?? (await effectiveSettings(await loadAgent(agentName))).backend });
          this.changed(agentName, "helpers");
          await this.checkNetwork(await listAgents(), true);
          if (this.offlineSince) {
            // This machine is offline: no attempt is used up; it carries on once the connection is back.
            this.log(`[${agentName}] helper ${rec.id}: no internet, waiting for it to come back`);
            await this.untilOnline(waiting);
            attempt = Math.max(attempt, 1);
          } else {
            if (attempt >= HELPER_RETRY_MS.length) throw e;
            this.log(`[${agentName}] helper ${rec.id}: provider trouble, retrying (${msg.slice(0, 120)})`);
            await sleep(HELPER_RETRY_MS[attempt++], waiting);
          }
          if (over() || waiting.aborted) throw e;
          return run(text, signal);
        }
      };
      try {
        for (;;) {
          const turn = new AbortController();
          this.helperTurns.set(key, turn);
          /** Stopped for a note before this turn's text went out: it still has to be told. */
          let unsent = false;
          try {
            const r = await run(next, anySignal([cancel, turn.signal]));
            lastReply = r.reply || lastReply;
          } catch (e) {
            // Stopped to read a note: carry on below. Anything else ends the helper.
            if (!(turn.signal.aborted && !cancel.aborted && !this.stopping && this.helperNotes.get(key)?.length)) throw e;
            unsent = !promptWasSent(e);
          } finally {
            if (this.helperTurns.get(key) === turn) {
              this.helperTurns.delete(key);
              this.boundaries.delete(key);
            }
          }
          attempt = 0;
          const notes = this.helperNotes.get(key);
          this.helperNotes.delete(key);
          if (!notes?.length) {
            // From here a note can't reach this run: it carries the helper on afterwards instead.
            this.helperClosing.add(key);
            break;
          }
          if (unsent && told.length) {
            told = [...told, ...notes];
            next = noteText(told, resumed);
          } else if (unsent) {
            const first = next;
            next = (fresh) => `${first(fresh)}\n\n${noteText(notes, false)(false)}`;
          } else {
            told = notes;
            resumed = false;
            next = noteText(notes, false);
          }
        }
      } finally {
        if (this.helperTrouble.delete(rec.id)) this.changed(agentName, "helpers");
      }
      rec.status = "done";
      rec.result = ctx.result ?? (lastReply || "(It finished without describing its result. Check its folder.)");
    } catch (e: any) {
      this.helperClosing.add(key);
      // Stopping the agent cancels its helpers too: that's the person's stop, not the agent's cancel.
      if ((await loadAgent(agentName)).state.status === "stopped") {
        rec.status = "stopped";
        rec.result = "Cut off because the person stopped you.";
      } else if (cancel.aborted) {
        rec.status = "cancelled";
        rec.result = "Cancelled, as you asked.";
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
      this.helperSteps.delete(key);
      this.liveHelpers.delete(key);
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
    this.agentAborts.delete(name); // an archived agent of the same name was stopped; this one isn't
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
    // Cancel whatever it's running now: its main turn and helpers, including helpers waiting to retry.
    // Its signal stays fired until it's started again (see signalFor).
    const c = this.agentAborts.get(name);
    if (c) c.abort();
    else this.agentAborts.set(name, stoppedSignal());
    for (const [key, ctl] of this.helperAborts) if (key.startsWith(`${name}/`)) ctl.abort();
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
    await updateState(name, { status: hadJob ? "asleep" : "new", pausedUntil: null, pausedAt: null, pauseReason: null, failures: 0, activity: hadJob ? "resuming" : "waiting for its job" }, { allowStopped: true });
    this.agentAborts.delete(name);
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

  /**
   * The person created an agent with its settings chosen up front (the app's settings step, or
   * `overtime new <name> key=value…`). Everything is checked as `set` checks it before anything is made,
   * so a missing backend or a bad folder never leaves a half-made agent behind.
   */
  async newAgent(name: string, patch: SettingsPatch = {}): Promise<Agent> {
    const { validateName } = await import("../agent/agent.js");
    const bad = validateName(name);
    if (bad) throw new Error(bad);
    if (existsSync(paths.agent(name))) throw new Error(`An agent called "${name}" already exists.`);
    const backend = patch.backend || (await loadSettings()).backend;
    await this.checkSettings(patch, async () => backend);
    // The default backend too: an agent that can't start is no use to the person who made it.
    if (!patch.backend) {
      const { backendMissing } = await import("../acp/backends.js");
      const missing = await backendMissing(backend);
      if (missing) throw new Error(missing);
    }
    const { backend: b, model, ...rest } = patch;
    const a = await this.create(name, { backend: b || undefined, model: model === "default" ? null : model });
    if (Object.values(rest).some((v) => v !== undefined)) await this.setAgentSettings(name, rest);
    return loadAgent(a.name);
  }

  /** The person changed an agent's settings. Takes effect from its next turn. */
  async setAgentSettings(name: string, patch: SettingsPatch): Promise<void> {
    await this.checkSettings(patch, async () => patch.backend ?? (await effectiveSettings(await loadAgent(name))).backend);
    const { setSettings } = await import("../agent/agent.js");
    // A new backend means the old model name may not exist there: clear it unless one was given.
    // Public is the default, so only private is written down.
    const visibility = patch.visibility === undefined ? undefined : patch.visibility === "private" ? "private" : null;
    // Reflecting is on unless turned off, so only off is written down (null: back to the global setting).
    const reflect = patch.reflect === undefined ? undefined : patch.reflect === false ? false : null;
    // A model belongs to its backend: a new backend clears the reflect model too, unless one was given.
    const reflectModel = patch.backend && patch.reflectModel === undefined ? null : patch.reflectModel === "default" ? null : patch.reflectModel;
    await setSettings(name, { ...patch, visibility, reflect, reflectModel, model: patch.backend && patch.model === undefined ? null : patch.model });
    this.log(`[${name}] settings changed: ${JSON.stringify(patch)}`);
    // Watches run under the protection they started with: restart them so a change applies to them too.
    if (patch.protect !== undefined || patch.workspace !== undefined) {
      this.monitors.stopAgent(name);
      if ((await loadAgent(name)).state.status !== "stopped") await this.monitors.startAll(name);
    }
    // Whether its folder is hidden from the others is part of their watches' rules.
    if (patch.visibility !== undefined) {
      for (const a of await listAgents()) {
        if (a.name === name || a.state.status === "stopped") continue;
        this.monitors.stopAgent(a.name);
        await this.monitors.startAll(a.name);
      }
    }
    this.changed(name, "state");
  }

  /** Checks a settings change and puts it in the form it's stored in (full paths, the model's own id); throws on anything wrong. */
  private async checkSettings(patch: SettingsPatch, backendFor: () => Promise<string>): Promise<void> {
    if (patch.visibility !== undefined && patch.visibility !== "public" && patch.visibility !== "private") throw new Error('Visibility is "public" or "private".');
    if (patch.dailyTokenBudget !== undefined && patch.dailyTokenBudget !== null && !(Number.isFinite(patch.dailyTokenBudget) && patch.dailyTokenBudget > 0)) throw new Error("The token budget must be a positive number of tokens, or empty for none.");
    if (typeof patch.workspace === "string" && patch.workspace.trim()) {
      const { expandHome } = await import("../agent/agent.js");
      const { existsSync, statSync } = await import("node:fs");
      const p = expandHome(patch.workspace.trim());
      if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`There's no folder at ${p}.`);
      patch.workspace = p;
    }
    for (const key of ["model", "reflectModel"] as const) {
      const name = patch[key];
      if (typeof name !== "string" || !name.trim() || name === "default") continue;
      // Check the name against what the backend offers, so a typo can't quietly run on its default model.
      const backend = await backendFor();
      let offered: { id: string; name: string }[] | null = null;
      try {
        offered = await this.models(backend);
      } catch {} // can't ask the backend right now: accept, and the next turn reports a bad name
      const want = name.trim().toLowerCase();
      if (offered?.length && !offered.some((m) => m.id.toLowerCase() === want || m.name.toLowerCase() === want)) {
        throw new Error(`${backend} doesn't offer a model called "${name}". It offers: ${offered.map((m) => m.id).join(", ")}.`);
      }
      const hit = offered?.find((m) => m.id.toLowerCase() === want || m.name.toLowerCase() === want);
      if (hit) patch[key] = hit.id;
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
    if (a.state.status === "paused") await updateState(name, { status: hasIdentity(a) ? "asleep" : "new", pausedUntil: null, pausedAt: null, pauseReason: null, activity: hasIdentity(a) ? "resting" : "waiting for its job" });
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

/**
 * What a turn is about, in a few words, for an agent working without a status line of its own: the
 * person's message, another agent's, a monitor's or a wake's reason. Taken from the turn's inbox items
 * (newest of the most important kind), else the wake that came due; "working" when there's nothing to say.
 */
export async function turnAbout(store: Store, items: InboxItem[]): Promise<string> {
  const short = (t: string) => {
    const one = t.replace(/\s+/g, " ").trim();
    if (one.length <= 60) return one;
    const cut = one.slice(0, 60);
    return (cut.lastIndexOf(" ") > 30 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:.-]+$/, "") + "…";
  };
  const last = (f: (i: InboxItem) => boolean) => [...items].reverse().find(f);
  // The person's own words (from their message, not the inbox text, which can carry Overtime's notes).
  const yours = last((i) => (i.type === "message" && !(i.data as any)?.fromChat) || (i.type === "answer" && !!i.messageId));
  if (yours) {
    const m = (await store.messages()).find((x) => x.id === yours.messageId);
    const words = m ? m.text || (m.attachments ?? []).map((a) => a.name).join(", ") : yours.text;
    if (words.trim()) return `on: ${short(words)}`;
  }
  const fromAgent = last((i) => i.type === "agent" && typeof (i.data as any)?.from === "string");
  if (fromAgent) return `on: message from ${(fromAgent.data as any).from}`;
  const monitorId = last((i) => (i.type === "monitor" || i.type === "system") && typeof (i.data as any)?.monitorId === "string")?.data as { monitorId: string } | undefined;
  const monitor = monitorId && (await store.monitors()).find((m) => m.id === monitorId.monitorId);
  if (monitor && monitor.why.trim()) return short(monitor.why);
  const loop = last((i) => i.type === "loop");
  if (loop && loop.text.trim()) return short(loop.text);
  if (!items.length) {
    // A wake it chose says why; Overtime's own (a check-in, a retry) is just a check-in.
    const sched = await store.schedule();
    if (sched.wakeAt && new Date(sched.wakeAt) <= new Date()) return sched.chosenInTurn && sched.wakeReason?.trim() ? short(sched.wakeReason) : "routine check-in";
  }
  return "working";
}

function describeInbox(items: InboxItem[]): string {
  const kinds = new Set(items.map((i) => i.type));
  const words: Record<string, string> = { message: "a message from the person", answer: "an answer to your question", monitor: "a monitor fired", helper: "a helper finished", "helper-update": "an update from a helper", loop: "a recurring task came due", system: "a note from Overtime", agent: "a message from another agent" };
  return [...kinds].map((k) => words[k] ?? k).join(", ");
}

/** The inbox for a turn. Items already shown to `session` (a turn there didn't finish) are set apart. */
function inboxBlock(all: InboxItem[], session: string | null = null): string {
  if (!all.length) return "Your inbox is empty.";
  const shown = session ? all.filter((i) => i.shownIn === session) : [];
  const items = all.filter((i) => !shown.includes(i));
  const again = shown.length
    ? `Already handed to you earlier in this session, in a turn that was cut off (an error or a usage limit). If you already dealt with one (answered it, did it), don't do it again; otherwise deal with it now:\n\n${shown.map((i) => `- ${i.type} — ${i.t}\n${i.text}`).join("\n\n")}`
    : "";
  if (!items.length) return again;
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
                  : i.type === "helper-update"
                    ? "Update from a helper (it's still working)"
                  : i.type === "loop"
                    ? "Recurring task"
                    : i.type === "agent"
                      ? `Message from ${String((i.data as any)?.from ?? "another agent")} (another agent, not the person). Reply with message if it needs an answer`
                      : "From Overtime";
        return `${n + 1}. ${head} — ${i.t}\n${i.text}`;
      })
      .join("\n\n") +
    (again ? `\n\n${again}` : "")
  );
}

/**
 * The recent conversation with the person, for a session that starts fresh (context full, an update, a
 * new model): the last 40 messages, newest last, at most about 16,000 characters.
 */
function recentConversation(all: Message[]): string {
  const shown = all.filter((m) => !m.closes).slice(-40);
  if (!shown.length) return "";
  const who = (m: Message) => (m.kind === "agent-message" ? `Between agents, ${m.fromAgent} → ${m.toAgent}` : m.from === "you" ? "Person" : m.from === "agent" ? "You" : "Overtime");
  const lines = shown.map((m) => {
    const kind = m.kind === "question" ? " [your question]" : m.kind === "report" ? " [report]" : m.kind === "alert" ? " [alert]" : "";
    const answer = m.kind === "question" && m.answer ? `\n  (${m.answer.closed ? `${m.answer.closed}` : `answered: ${m.answer.text}`})` : m.kind === "question" ? "\n  (not answered yet)" : "";
    return `${who(m)} (${m.t})${kind}: ${withFiles(m.text, m.attachments)}${answer}`;
  });
  let text = lines.join("\n\n");
  if (text.length > 16_000) text = "…\n" + text.slice(-16_000);
  return `Your recent conversation with the person (most recent last):\n\n${text}\n\n---\n\n`;
}

function mainTurnText(items: InboxItem[], firstJob: boolean, contextReset: boolean, session: string | null = null, memoryNote = ""): string {
  const parts: string[] = [];
  if (firstJob) {
    parts.push(
      "This is your first conversation. You don't have an identity yet. From what the person tells you, rewrite AGENT.md in your folder: who you are, your role, your goals (what you're working toward over time, not only the first task) and what good looks like, and your rules (what you must check with them first). Create INDEX.md. Reply to them with a short summary of what you understood and what you'll do first. Then start.",
    );
  }
  if (contextReset) parts.push("Note: this is a fresh session. Your earlier work session isn't carried over (your recent conversation with the person is above); your folder is. Check INDEX.md and your notes for where things stand.");
  parts.push(inboxBlock(items, session));
  parts.push("Reply with send to new messages from the person (not to ones passed on from your conversation: those were already answered, so never acknowledge them twice). Do the work, as part of your goals. Before this turn ends, bring your notes and INDEX.md up to date; if you were corrected or worked out how to do something, save it: a how-to as a skill, anything else as a memory (memory/), with the person's words as its quote; not a snapshot of what's on disk or where things are now. Decide the next useful step toward your goals, and choose when to wake.");
  // After the request, never ahead of it: the index has grown past its cap.
  if (memoryNote) parts.push(memoryNote.trim());
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

${agentName}'s memory is in ${join(paths.agent(agentName), "memory")}/ (MEMORY.md is its index): read it when it helps, but don't change it; what ${agentName} should remember goes in your learned lines.

When you're finished, call done with what you did, where the output is, what you checked, and anything left open, ending with your learned lines: one for each thing ${agentName} should remember next time (a fact about the person or their setup, a correction, a command that finally worked, where something lives), each starting "learned: ", or the one line "learned: nothing new". Then end your turn. On long work, tell ${agentName} how it's going with update (urgent only when you're blocked).

${agentName} may send you a note while you work, or after you're done (to correct something or ask for more): it arrives as your next message. Take it into account, carry on from where you were, and call done again with the whole result.
${instructions ? `\n# Your role\n\n${instructions}\n` : ""}${skillsBlock(paths.agent(agentName)) ? `\n${skillsBlock(paths.agent(agentName))}\n` : ""}`;
}

/** Whether a session's context is full enough that a fresh one (rebuilt from the agent's files) is better. */

/** Fingerprints of AGENT.md, INDEX.md and memory/MEMORY.md as a session last saw them. */
function fileHashes(agent: Agent): { agent: string; index: string; memory: string } {
  const h = (t: string) => createHash("sha1").update(t).digest("hex");
  return { agent: h(agent.identity), index: h(agent.index), memory: h(agent.memory) };
}

/**
 * A resumed session saw AGENT.md and INDEX.md only when it started. If they changed since (the person
 * edited them, or another of the agent's sessions did), the next turn starts with the current text.
 */
async function editedSince(agent: Agent, seen: { agent: string; index: string; memory?: string } | undefined): Promise<string> {
  if (!seen) return "";
  const now = fileHashes(agent);
  const parts: string[] = [];
  if (now.agent !== seen.agent) parts.push(`AGENT.md changed since your last turn. It now reads:\n\n${agent.identity.trim()}`);
  if (now.index !== seen.index) parts.push(`INDEX.md changed since your last turn. It now reads:\n\n${agent.index.trim()}`);
  // A session from before memory/ existed never saw MEMORY.md: it gets it now, once there is one.
  if (seen.memory === undefined ? !!agent.memory.trim() : now.memory !== seen.memory) {
    parts.push(agent.memory.trim() ? `memory/MEMORY.md (your memory index; the files are in ${join(agent.dir, "memory")}/) changed since your last turn. It now reads:\n\n${memoryText(agent.memory)}` : "memory/MEMORY.md was emptied since your last turn.");
  }
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
