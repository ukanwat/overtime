import { existsSync, statSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { paths } from "../paths.js";
import { appendJsonl, newId, readJson, readJsonl, trimJsonl, writeJson } from "../fsutil.js";
import { withLock } from "./mutex.js";
import type { Conversation, Decision, HelperRecord, InboxItem, Link, Loop, Message, MessageKind, Monitor, Schedule } from "./types.js";

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
export function extractLinks(text: string, baseDir: string): Link[] | undefined {
  const links: Link[] = [];
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
  /** Old bookkeeping goes: delivered-inbox records older than `cutoff`, and all but the last 500 reports. */
  async trimLogs(cutoff: number): Promise<void> {
    await this.lock(async () => {
      await trimJsonl<{ t?: string }>(this.p("inbox-delivered.jsonl"), (r) => !r.t || new Date(r.t).getTime() >= cutoff);
      await trimJsonl(this.p("reports.jsonl"), (_r, i, all) => i >= all.length - 500);
    });
  }

  private lock<T>(fn: () => Promise<T>) {
    return withLock(`store:${this.agent}`, fn);
  }

  // ---------- the conversation ----------

  private migrated = false;

  /**
   * Agents made before conversations were a single list kept threads. The first time one is read,
   * every thread's messages are merged into one list in time order. The old files are kept.
   */
  private async migrateThreads(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;
    const old = this.p("threads.json");
    if (!existsSync(old) || existsSync(this.p("messages.jsonl"))) return;
    const metas = await readJson<any[]>(old, []);
    const all: Message[] = [];
    for (const m of metas) {
      const entries = await readJsonl<any>(this.p("threads", `${m.id}.jsonl`));
      let questionId: string | undefined;
      entries.forEach((e, i) => {
        const first = i === 0;
        const kind: MessageKind = first && m.kind === "question" ? "question" : first && (m.kind === "report" || m.kind === "alert") ? m.kind : e.options?.length ? "question" : "message";
        const msg: Message = { id: e.id, t: e.t, from: e.from, kind, text: e.text, why: e.why, recommendation: e.recommendation, options: e.options, links: e.links };
        if (kind === "question") {
          questionId = e.id;
          msg.category = m.category;
          msg.urgent = m.urgent;
        }
        if (kind === "report" || kind === "alert") msg.title = m.title;
        if (e.from === "you" && questionId) {
          msg.replyTo = questionId;
          msg.choice = e.choice;
          questionId = undefined;
        }
        all.push(msg);
      });
    }
    all.sort((x, y) => x.t.localeCompare(y.t));
    for (const m of all) await appendJsonl(this.p("messages.jsonl"), m);
    const unreadAny = metas.some((m) => m.unread > 0);
    const lastRead = unreadAny ? [...all].reverse().find((m) => m.from === "you")?.id ?? null : all.at(-1)?.id ?? null;
    await writeJson(this.p("conversation.json"), { lastReadId: lastRead, chatSessionId: null } satisfies Conversation);
    await rename(old, `${old}.before-single-conversation`).catch(() => {});
  }

  async conversation(): Promise<Conversation> {
    await this.migrateThreads();
    return readJson<Conversation>(this.p("conversation.json"), { lastReadId: null, chatSessionId: null });
  }

  async patchConversation(patch: Partial<Conversation>): Promise<void> {
    await this.lock(async () => {
      const c = await this.conversation();
      await writeJson(this.p("conversation.json"), { ...c, ...patch });
    });
  }

  /** Every message, oldest first, with each question's answer filled in. */
  async messages(): Promise<Message[]> {
    await this.migrateThreads();
    const all = await readJsonl<Message>(this.p("messages.jsonl"));
    const byId = new Map(all.map((m) => [m.id, m]));
    for (const m of all) {
      if (m.replyTo) {
        const q = byId.get(m.replyTo);
        if (q && !q.answer) q.answer = { choice: m.choice, note: m.note, text: m.text, t: m.t, ...(m.closes ? { closed: m.closes } : {}) };
      }
    }
    return all;
  }

  async message(id: string): Promise<Message | null> {
    return (await this.messages()).find((m) => m.id === id) ?? null;
  }

  /** Questions the person hasn't answered yet, newest last. */
  async openQuestions(): Promise<Message[]> {
    return (await this.messages()).filter((m) => m.kind === "question" && !m.answer);
  }

  /** Add a message to the conversation. */
  async addMessage(o: Omit<Message, "id" | "t" | "links" | "answer"> & { baseDir: string }): Promise<Message> {
    return this.lock(async () => {
      await this.migrateThreads();
      const { baseDir, ...rest } = o;
      const msg: Message = { id: newId("m"), t: new Date().toISOString(), ...rest, title: rest.title?.slice(0, 120), links: extractLinks(o.text, baseDir) };
      for (const k of Object.keys(msg) as (keyof Message)[]) if (msg[k] === undefined) delete msg[k];
      await appendJsonl(this.p("messages.jsonl"), msg);
      // Your own messages count as read: everything up to them has been seen.
      if (o.from === "you") {
        const c = await readJson<Conversation>(this.p("conversation.json"), { lastReadId: null });
        await writeJson(this.p("conversation.json"), { ...c, lastReadId: msg.id });
      }
      return msg;
    });
  }

  /** How many messages from the agent (or Overtime) the person hasn't seen. */
  async unread(): Promise<number> {
    const all = await this.messages();
    const { lastReadId } = await this.conversation();
    const from = lastReadId ? all.findIndex((m) => m.id === lastReadId) + 1 : 0;
    return all.slice(from).filter((m) => m.from !== "you").length;
  }

  /** Mark everything up to `upTo` (default: the newest message) as seen. Never moves backwards. */
  async markRead(upTo?: string): Promise<void> {
    await this.lock(async () => {
      const all = await this.messages();
      const c = await this.conversation();
      const target = upTo ? all.findIndex((m) => m.id === upTo) : all.length - 1;
      const cur = c.lastReadId ? all.findIndex((m) => m.id === c.lastReadId) : -1;
      if (target < 0 || target <= cur) return;
      await writeJson(this.p("conversation.json"), { ...c, lastReadId: all[target].id });
    });
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

  /** A repeating wake-up. `firstAt` sets when it first fires ("every day at 9"); otherwise one interval from now. */
  async addLoop(everyMs: number, task: string, firstAt?: Date): Promise<Loop> {
    return this.lock(async () => {
      const s = await this.schedule();
      const now = Date.now();
      const every = Math.max(MIN_SLEEP_MS, everyMs);
      let first = firstAt && !Number.isNaN(firstAt.getTime()) ? firstAt.getTime() : now + every;
      // A first time already past moves forward by whole intervals, so "every 1d at 09:00" set at 10:00 starts tomorrow.
      while (first < now + MIN_SLEEP_MS) first += every;
      const loop: Loop = { id: newId("loop"), everyMs: every, task, nextAt: new Date(first).toISOString(), createdAt: new Date(now).toISOString() };
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
    await this.lock(() => appendJsonl(this.p("decisions.jsonl"), { t: new Date().toISOString(), ...d }));
  }

  async decisions(): Promise<Decision[]> {
    return readJsonl<Decision>(this.p("decisions.jsonl"));
  }

  // ---------- reports ----------

  // Under the lock, like trimLogs, so a report written while the file is trimmed isn't lost.
  async addReport(text: string): Promise<void> {
    await this.lock(() => appendJsonl(this.p("reports.jsonl"), { t: new Date().toISOString(), text }));
  }

  async reports(limit = 20): Promise<{ t: string; text: string }[]> {
    return (await readJsonl<{ t: string; text: string }>(this.p("reports.jsonl"))).slice(-limit);
  }

}
