import { join } from "node:path";
import { paths } from "../paths.js";
import { appendJsonl, readJson, readJsonl, trimJsonl, writeJson } from "../fsutil.js";
import { withLock } from "../store/mutex.js";

/** Exactly what the backend reported for one turn. Nothing here is estimated by Overtime. */
export interface TurnUsage {
  t: string;
  runId: string;
  kind: string;
  backend: string;
  sessionId: string;
  /** Tokens for this turn, from the prompt response. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
  /** The session's cumulative cost as the backend reported it at the end of the turn (null if it reports none). */
  sessionCostUsd: number | null;
  /** This turn's cost: the change in the session's cumulative cost. */
  turnCostUsd: number | null;
  /** Context window after the turn. */
  context: { used: number; size: number } | null;
  /** Set when the turn didn't finish (failed, cancelled, timed out): what it spent still counts. */
  incomplete?: boolean;
}

/** The latest status a backend reported for one subscription limit (e.g. Claude's 5-hour or 7-day limit). */
export interface LimitStatus {
  backend: string;
  /** The model the turn ran on (null: the backend's default). */
  model?: string | null;
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType?: string;
  utilization?: number;
  /** Epoch seconds when the limit resets. */
  resetsAt?: number;
  updatedAt: string;
}

/** What is known about one backend and model's limits: each limit (window) as last reported, and the last turn that got through. */
export interface ModelLimits {
  windows: Record<string, LimitStatus>;
  gotThroughAt?: string;
}

const usagePath = (agent: string) => join(paths.meta(agent), "usage.jsonl");

export async function lastSessionCost(agent: string, sessionId: string): Promise<number | null> {
  const rows = await readJsonl<TurnUsage>(usagePath(agent));
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].sessionId === sessionId && rows[i].sessionCostUsd != null) return rows[i].sessionCostUsd;
  return null;
}

/**
 * One turn's cost from the totals the backend reported during it. Backends report a running total; on
 * a resumed session some carry the earlier total over and some start again from zero. The first total
 * of the turn tells which: below the session's last recorded total means it started again.
 */
export function turnCost(prev: number | null, first: number | null, last: number): number {
  if (prev == null) return last;
  if (first != null && first < prev) return last;
  return Math.max(0, last - prev);
}

export async function recordTurnUsage(agent: string, u: Omit<TurnUsage, "t" | "turnCostUsd"> & { firstCostUsd?: number | null }): Promise<TurnUsage> {
  return withLock(`usage:${agent}`, async () => {
    const { firstCostUsd, ...rest } = u;
    let turnCostUsd: number | null = null;
    if (rest.sessionCostUsd != null) turnCostUsd = turnCost(await lastSessionCost(agent, rest.sessionId), firstCostUsd ?? null, rest.sessionCostUsd);
    const row: TurnUsage = { t: new Date().toISOString(), turnCostUsd, ...rest };
    await appendJsonl(usagePath(agent), row);
    return row;
  });
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Today's totals for one agent (local day), from what backends reported. */
export async function usageToday(agent: string, now = new Date()): Promise<{ usd: number; costReported: boolean; tokens: number; turns: number }> {
  const rows = (await readJsonl<TurnUsage>(usagePath(agent))).filter((r) => sameLocalDay(new Date(r.t), now));
  let usd = 0;
  let costReported = false;
  let tokens = 0;
  for (const r of rows) {
    if (r.turnCostUsd != null) {
      usd += r.turnCostUsd;
      costReported = true;
    }
    tokens += r.tokens?.total ?? 0;
  }
  return { usd, costReported, tokens, turns: rows.length };
}

const limitsPath = () => join(paths.agentsDir(), "..", "limits.json");

/**
 * Limits are kept per backend and model: Claude's are per model (opus can be over its weekly limit while
 * sonnet isn't), so one agent's turns say nothing about another's on a different model. The default
 * model has its own key.
 */
export const limitKey = (backend: string, model?: string | null) => `${backend}/${model && model !== "default" ? model : "default"}`;
/** A limit recorded before limits were kept per model: which model it was for isn't known, so it holds for all of the backend's. */
const anyModel = (backend: string) => `${backend}/*`;
/** Each limit is kept on its own, so an allowed 5-hour limit doesn't hide a used-up 7-day one. */
const windowOf = (l: LimitStatus) => l.rateLimitType ?? "limit";

export async function readLimits(): Promise<Record<string, ModelLimits>> {
  const raw = await readJson<Record<string, any>>(limitsPath(), {});
  const all: Record<string, ModelLimits> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && v.windows) all[k] = v;
    // The old format (one record per backend): only a limit still in force is worth keeping.
    else if (v && typeof v.status === "string" && v.status === "rejected") all[anyModel(k)] = { windows: { [windowOf(v)]: { ...v, backend: k } } };
  }
  return all;
}

async function updateLimits(key: string, change: (m: ModelLimits) => void): Promise<void> {
  await withLock("limits", async () => {
    const all = await readLimits();
    const m = (all[key] ??= { windows: {} });
    change(m);
    await writeJson(limitsPath(), all);
  });
}

export async function writeLimit(l: LimitStatus): Promise<void> {
  await updateLimits(limitKey(l.backend, l.model), (m) => {
    m.windows[windowOf(l)] = l;
  });
}

/** How long a recorded limit is trusted before the backend is simply tried again. */
export const LIMIT_RECHECK_MS = 15 * 60_000;

/** The limits recorded as used up for this backend and model (whatever their time), with a reset not yet passed. */
export async function rejectedLimits(backend: string, model?: string | null, now = Date.now()): Promise<LimitStatus[]> {
  const all = await readLimits();
  const ls = [...Object.values(all[limitKey(backend, model)]?.windows ?? {}), ...Object.values(all[anyModel(backend)]?.windows ?? {})];
  return ls.filter((l) => l.status === "rejected" && !(l.resetsAt && l.resetsAt * 1000 <= now));
}

/**
 * If this backend and model were last seen over a usage limit: when it said the limit resets (if it said),
 * and when to try again. A recorded limit is only what the backend said last time; it can lift early
 * (the person upgrades, buys more, or the reset time was wrong), so it's tried again every 15 minutes
 * even before the reset, and the next turn that gets through on the same model clears it.
 */
export async function limitInfo(backend: string, model?: string | null, now = Date.now()): Promise<{ resetsAt: Date | null; retryAt: Date } | null> {
  let found: { resetsAt: Date | null; retryAt: Date } | null = null;
  for (const l of await rejectedLimits(backend, model, now)) {
    const resetsAt = l.resetsAt ? new Date(l.resetsAt * 1000) : null;
    const recheck = new Date(l.updatedAt).getTime() + LIMIT_RECHECK_MS;
    const retryAt = new Date(Math.min(recheck, resetsAt?.getTime() ?? Infinity));
    if (retryAt.getTime() <= now) continue;
    // Over several limits at once: it waits for the last of them.
    if (!found || retryAt > found.retryAt) found = { resetsAt, retryAt };
    if (resetsAt && (!found.resetsAt || resetsAt > found.resetsAt)) found.resetsAt = resetsAt;
  }
  return found;
}

/** If this backend and model should be left alone for now (see limitInfo): until when. */
export async function blockedUntil(backend: string, model?: string | null, now = Date.now()): Promise<Date | null> {
  return (await limitInfo(backend, model, now))?.retryAt ?? null;
}

/** A turn just ended on a limit already recorded: it still holds, so it's trusted for another 15 minutes from now. */
export async function confirmLimit(backend: string, model?: string | null): Promise<void> {
  const t = new Date().toISOString();
  await updateLimits(limitKey(backend, model), (m) => {
    for (const l of Object.values(m.windows)) if (l.status === "rejected") l.updatedAt = t;
  });
}

/** When a turn on this backend and model last got through after a limit (none recorded: null). */
export async function gotThroughAt(backend: string, model?: string | null): Promise<Date | null> {
  const t = (await readLimits())[limitKey(backend, model)]?.gotThroughAt;
  return t ? new Date(t) : null;
}

/** A turn on this backend and model got through: the limits recorded for it are over, for every agent on that model (not on others). */
export async function clearLimit(backend: string, model?: string | null): Promise<void> {
  if (!(await rejectedLimits(backend, model, 0)).length) return;
  const t = new Date().toISOString();
  await updateLimits(limitKey(backend, model), (m) => {
    for (const [w, l] of Object.entries(m.windows)) if (l.status === "rejected") m.windows[w] = { backend, model: l.model, status: "allowed", rateLimitType: l.rateLimitType, updatedAt: t };
    m.gotThroughAt = t;
  });
  // An old record whose model isn't known: this turn shows it no longer holds for the backend.
  await withLock("limits", async () => {
    const all = await readLimits();
    if (!all[anyModel(backend)]) return;
    delete all[anyModel(backend)];
    await writeJson(limitsPath(), all);
  });
}

/**
 * Usage rows older than `cutoff` go (budgets only count today), except each session's latest cost: a
 * session can be resumed after any break, and without its last total its whole lifetime cost would be
 * counted again as one turn's.
 */
export async function trimUsage(agent: string, cutoff: number): Promise<void> {
  await withLock(`usage:${agent}`, () =>
    trimJsonl<TurnUsage>(usagePath(agent), (r, i, all) => {
      if (new Date(r.t).getTime() >= cutoff) return true;
      if (r.sessionCostUsd == null) return false;
      return !all.slice(i + 1).some((x) => x.sessionId === r.sessionId && x.sessionCostUsd != null);
    }),
  );
}
