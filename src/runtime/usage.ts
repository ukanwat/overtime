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

/** The latest subscription limit status a backend reported (e.g. Claude's 5-hour and 7-day limits). */
export interface LimitStatus {
  backend: string;
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType?: string;
  utilization?: number;
  /** Epoch seconds when the limit resets. */
  resetsAt?: number;
  updatedAt: string;
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

export async function readLimits(): Promise<Record<string, LimitStatus>> {
  return readJson<Record<string, LimitStatus>>(limitsPath(), {});
}

export async function writeLimit(l: LimitStatus): Promise<void> {
  await withLock("limits", async () => {
    const all = await readLimits();
    all[l.backend] = l;
    await writeJson(limitsPath(), all);
  });
}

/** How long a recorded limit is trusted before the backend is simply tried again. */
export const LIMIT_RECHECK_MS = 15 * 60_000;

/**
 * If this backend was last seen over a usage limit: when it said the limit resets (if it said), and
 * when to try it again. A recorded limit is only what the backend said last time; it can lift early
 * (the person upgrades, buys more, or the reset time was wrong), so it's tried again every 15 minutes
 * even before the reset, and the next turn that gets through clears it.
 */
export async function limitInfo(backend: string, now = Date.now()): Promise<{ resetsAt: Date | null; retryAt: Date } | null> {
  const l = (await readLimits())[backend];
  if (!l || l.status !== "rejected") return null;
  const resetsAt = l.resetsAt ? new Date(l.resetsAt * 1000) : null;
  const recheck = new Date(l.updatedAt).getTime() + LIMIT_RECHECK_MS;
  const retryAt = new Date(Math.min(recheck, resetsAt?.getTime() ?? Infinity));
  return retryAt.getTime() > now ? { resetsAt, retryAt } : null;
}

/** If this backend should be left alone for now (see limitInfo): until when. */
export async function blockedUntil(backend: string, now = Date.now()): Promise<Date | null> {
  return (await limitInfo(backend, now))?.retryAt ?? null;
}

/** A turn on this backend got through: whatever limit was recorded for it is over. */
export async function clearLimit(backend: string): Promise<void> {
  const l = (await readLimits())[backend];
  if (l?.status === "rejected") await writeLimit({ backend, status: "allowed", updatedAt: new Date().toISOString() });
}

/** Usage rows older than `cutoff` go (budgets only count today; resumed sessions are recent). */
export async function trimUsage(agent: string, cutoff: number): Promise<void> {
  await withLock(`usage:${agent}`, () => trimJsonl<TurnUsage>(usagePath(agent), (r) => new Date(r.t).getTime() >= cutoff));
}
