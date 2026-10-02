import { existsSync, statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { paths } from "../paths.js";
import { appendJsonl, newId, readJson, readJsonl, writeJson } from "../fsutil.js";
import { withLock } from "./mutex.js";
import type { Decision, HelperRecord, InboxItem, Loop, Monitor, Schedule, ThreadEntry, ThreadKind, ThreadMeta } from "./types.js";

export const MIN_SLEEP_MS = 60_000;
export const MAX_SLEEP_MS = 3 * 24 * 3600_000;

export function clampWake(at: Date, now = new Date()): Date {
  const ms = at.getTime() - now.getTime();
  if (!Number.isFinite(ms)) return new Date(now.getTime() + 3600_000);
  return new Date(now.getTime() + Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, ms)));
}

/** Parse "90s", "20m", "6h", "2d", or plain milliseconds. */
export function parseDuration(s: string | number): number {
  if (typeof s === "number") return s;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d|day|days)?\s*$/i.exec(s);
  if (!m) throw new Error(`Couldn't read "${s}" as a duration. Use e.g. 90s, 20m, 6h or 2d.`);
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "ms" ? 1 : unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3600_000 : 86400_000;
  return Math.round(n * mult);
}

const PATH_RE = /(?:^|[\s(`"'])((?:~|\/)[^\s`"')]+)/g;
const URL_RE = /\bhttps?:\/\/[^\s`"')<>]+/g;

/** Turn paths and URLs in a message into links. Paths are only linked if they exist. */
export function extractLinks(text: string, baseDir: string): ThreadEntry["links"] {
  const links: NonNullable<ThreadEntry["links"]> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ label: url, target: url, kind: "url" });
    }
  }
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[1].replace(/[.,;:!?]+$/, "");
    const abs = raw.startsWith("~") ? join(process.env.HOME ?? "", raw.slice(1)) : isAbsolute(raw) ? raw : resolve(baseDir, raw);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    links.push({ label: raw, target: abs, kind: statSync(abs).isDirectory() ? "folder" : "file" });
  }
  return links.length ? links : undefined;
}

/** All of Overtime's bookkeeping for one agent. Every write is serialised per agent and atomic. */
export class Store {
  constructor(readonly agent: string) {}

  private p(...parts: string[]) {
    return join(paths.meta(this.agent), ...parts);
  }
  private lock<T>(fn: () => Promise<T>) {
    return withLock(`store:${this.agent}`, fn);
  }

  // ---------- threads ----------

  async threads(): Promise<ThreadMeta[]> {
    return readJson<ThreadMeta[]>(this.p("threads.json"), []);
  }

  async thread(id: string): Promise<{ meta: ThreadMeta; entries: ThreadEntry[] } | null> {
    const meta = (await this.threads()).find((t) => t.id === id);
    if (!meta) return null;
    return { meta, entries: await readJsonl<ThreadEntry>(this.p("threads", `${id}.jsonl`)) };
  }

  /** Start a thread. Returns its id. */
  async startThread(o: { kind: ThreadKind; title: string; from: ThreadEntry["from"]; text: string; why?: string; recommendation?: string; options?: string[]; urgent?: boolean; category?: string; baseDir: string }): Promise<string> {
    return this.lock(async () => {
      const id = newId("th");
      const now = new Date().toISOString();
      const meta: ThreadMeta = {
        id,
        kind: o.kind,
        title: o.title.slice(0, 120),
        status: o.kind === "question" ? "waiting_on_you" : "open",
        createdAt: now,
        updatedAt: now,
        unread: o.from === "agent" ? 1 : 0,
        urgent: o.urgent,
        category: o.category,
        chatSessionId: null,
      };
      const entry: ThreadEntry = { id: newId("m"), t: now, from: o.from, text: o.text, why: o.why, recommendation: o.recommendation, options: o.options, links: extractLinks(o.text, o.baseDir) };
      await appendJsonl(this.p("threads", `${id}.jsonl`), entry);
      const all = await this.threads();
      all.push(meta);
      await writeJson(this.p("threads.json"), all);
      return id;
    });
  }

  async addToThread(threadId: string, e: Omit<ThreadEntry, "id" | "t" | "links"> & { baseDir: string }): Promise<ThreadEntry> {
    return this.lock(async () => {
      const all = await this.threads();
      const meta = all.find((t) => t.id === threadId);
      if (!meta) throw new Error(`No thread ${threadId}.`);
      const entry: ThreadEntry = { id: newId("m"), t: new Date().toISOString(), from: e.from, text: e.text, why: e.why, recommendation: e.recommendation, options: e.options, choice: e.choice, links: extractLinks(e.text, e.baseDir) };
      await appendJsonl(this.p("threads", `${threadId}.jsonl`), entry);
      meta.updatedAt = entry.t;
      if (e.from === "agent") meta.unread += 1;
      if (e.from === "you" && meta.status === "waiting_on_you") meta.status = "answered";
      if (e.from === "agent" && e.options?.length) meta.status = "waiting_on_you";
      await writeJson(this.p("threads.json"), all);
      return entry;
    });
  }

  async patchThread(threadId: string, patch: Partial<ThreadMeta>): Promise<void> {
    await this.lock(async () => {
      const all = await this.threads();
      const meta = all.find((t) => t.id === threadId);
      if (!meta) return;
      Object.assign(meta, patch);
      await writeJson(this.p("threads.json"), all);
    });
  }

  async markRead(threadId: string): Promise<void> {
    await this.patchThread(threadId, { unread: 0 });
  }

  async waitingOnYou(): Promise<number> {
    return (await this.threads()).filter((t) => t.status === "waiting_on_you" || t.unread > 0).length;
  }

  // ---------- inbox ----------

  async inbox(): Promise<InboxItem[]> {
    return readJson<InboxItem[]>(this.p("inbox.json"), []);
  }

  async pushInbox(item: Omit<InboxItem, "id" | "t">): Promise<InboxItem> {
    return this.lock(async () => {
      const full: InboxItem = { id: newId("in"), t: new Date().toISOString(), ...item };
      const all = await this.inbox();
      all.push(full);
      await writeJson(this.p("inbox.json"), all);
      return full;
    });
  }

  /**
   * Hand the inbox to a turn. Items move to an in-flight file first, so they survive a crash:
   * a turn that finishes acknowledges them, one that doesn't gives them back.
   */
  async takeInbox(runId: string): Promise<InboxItem[]> {
    return this.lock(async () => {
      const all = await this.inbox();
      if (!all.length) return [];
      await writeJson(this.p("inflight", `${runId}.json`), all);
      await writeJson(this.p("inbox.json"), []);
      return all;
    });
  }

  /** The turn finished: the items were delivered. */
  async ackInbox(runId: string): Promise<void> {
    await this.lock(async () => {
      const items = await readJson<InboxItem[]>(this.p("inflight", `${runId}.json`), []);
      for (const i of items) await appendJsonl(this.p("inbox-delivered.jsonl"), { ...i, runId });
      await rm(this.p("inflight", `${runId}.json`), { force: true });
    });
  }

  /** The turn didn't finish: put its items back at the front of the inbox. */
  async returnInbox(runId: string): Promise<void> {
    await this.lock(async () => {
      const items = await readJson<InboxItem[]>(this.p("inflight", `${runId}.json`), []);
      if (items.length) await writeJson(this.p("inbox.json"), [...items, ...(await this.inbox())]);
      await rm(this.p("inflight", `${runId}.json`), { force: true });
    });
  }

  /** After a crash: anything still in flight goes back to the inbox. Returns how many items. */
  async recoverInflight(): Promise<number> {
    let files: string[] = [];
    try {
      files = (await readdir(this.p("inflight"))).filter((f) => f.endsWith(".json"));
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of files) {
      const runId = f.replace(/\.json$/, "");
      n += (await readJson<InboxItem[]>(this.p("inflight", f), [])).length;
      await this.returnInbox(runId);
    }
    return n;
  }

  // ---------- schedule ----------

  async schedule(): Promise<Schedule> {
    return readJson<Schedule>(this.p("schedule.json"), { wakeAt: null, wakeReason: null, loops: [] });
  }

  async setWake(at: Date | null, reason: string | null, chosenInTurn = false): Promise<Schedule> {
    return this.lock(async () => {
      const s = await this.schedule();
      s.wakeAt = at ? at.toISOString() : null;
      s.wakeReason = reason;
      s.chosenInTurn = chosenInTurn;
      await writeJson(this.p("schedule.json"), s);
      return s;
    });
  }

  async addLoop(everyMs: number, task: string): Promise<Loop> {
    return this.lock(async () => {
      const s = await this.schedule();
      const now = Date.now();
      const loop: Loop = { id: newId("loop"), everyMs: Math.max(MIN_SLEEP_MS, everyMs), task, nextAt: new Date(now + Math.max(MIN_SLEEP_MS, everyMs)).toISOString(), createdAt: new Date(now).toISOString() };
      s.loops.push(loop);
      await writeJson(this.p("schedule.json"), s);
      return loop;
    });
  }

  async removeLoop(id: string): Promise<boolean> {
    return this.lock(async () => {
      const s = await this.schedule();
      const before = s.loops.length;
      s.loops = s.loops.filter((l) => l.id !== id);
      await writeJson(this.p("schedule.json"), s);
      return s.loops.length < before;
    });
  }

  /** Advance loops that are due; returns the ones that fired. Missed slots fire once, not once per slot. */
  async takeDueLoops(now = new Date()): Promise<Loop[]> {
    return this.lock(async () => {
      const s = await this.schedule();
      const due: Loop[] = [];
      for (const l of s.loops) {
        if (new Date(l.nextAt).getTime() <= now.getTime()) {
          due.push({ ...l });
          let next = new Date(l.nextAt).getTime();
          while (next <= now.getTime()) next += l.everyMs;
          l.nextAt = new Date(next).toISOString();
        }
      }
      if (due.length) await writeJson(this.p("schedule.json"), s);
      return due;
    });
  }

  // ---------- monitors ----------

  async monitors(): Promise<Monitor[]> {
    return readJson<Monitor[]>(this.p("monitors.json"), []);
  }

  async addMonitor(m: Omit<Monitor, "id" | "createdAt" | "lastFiredAt" | "lastOutput" | "failures" | "status">): Promise<Monitor> {
    return this.lock(async () => {
      const all = await this.monitors();
      const full: Monitor = { ...m, id: newId("mon"), createdAt: new Date().toISOString(), lastFiredAt: null, lastOutput: null, failures: 0, status: "active" };
      all.push(full);
      await writeJson(this.p("monitors.json"), all);
      return full;
    });
  }

  async patchMonitor(id: string, patch: Partial<Monitor>): Promise<Monitor | null> {
    return this.lock(async () => {
      const all = await this.monitors();
      const m = all.find((x) => x.id === id);
      if (!m) return null;
      Object.assign(m, patch);
      await writeJson(this.p("monitors.json"), all);
      return m;
    });
  }

  async removeMonitor(id: string): Promise<boolean> {
    return this.lock(async () => {
      const all = await this.monitors();
      const next = all.filter((m) => m.id !== id);
      await writeJson(this.p("monitors.json"), next);
      return next.length < all.length;
    });
  }

  // ---------- helpers ----------

  async helpers(): Promise<HelperRecord[]> {
    return readJson<HelperRecord[]>(this.p("helpers.json"), []);
  }

  async saveHelper(h: HelperRecord): Promise<void> {
    await this.lock(async () => {
      const all = (await this.helpers()).filter((x) => x.id !== h.id);
      all.push(h);
      await writeJson(this.p("helpers.json"), all);
    });
  }

  // ---------- decisions (earned autonomy) ----------

  async recordDecision(d: Omit<Decision, "t">): Promise<void> {
    await appendJsonl(this.p("decisions.jsonl"), { t: new Date().toISOString(), ...d });
  }

  async decisions(): Promise<Decision[]> {
    return readJsonl<Decision>(this.p("decisions.jsonl"));
  }

  // ---------- reports ----------

  async addReport(text: string): Promise<void> {
    await appendJsonl(this.p("reports.jsonl"), { t: new Date().toISOString(), text });
  }

  async reports(limit = 20): Promise<{ t: string; text: string }[]> {
    return (await readJsonl<{ t: string; text: string }>(this.p("reports.jsonl"))).slice(-limit);
  }

}
