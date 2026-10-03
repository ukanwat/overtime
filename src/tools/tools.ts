import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolHost } from "./host.js";
import { clampWake, MAX_SLEEP_MS, MIN_SLEEP_MS, parseDuration } from "../store/store.js";
import { parseFrontMatter } from "../agent/frontmatter.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** A bug in a tool must never crash the session: errors come back as a readable tool error. */
function safe<A>(fn: (a: A) => Promise<Result>): (a: A) => Promise<Result> {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e: any) {
      return fail(String(e?.message ?? e));
    }
  };
}

const when = (d: Date) => `${d.toISOString()} (${d.toString()})`;

/**
 * Overtime's tools: deliberately few. Main sessions get wake, cancel, ask, send, spawn.
 * Chat sessions get ask and send. Helpers get done; they hand results back and don't start their own.
 */
export function registerTools(mcp: McpServer, ctx: ToolContext, host: ToolHost): void {
  const store = host.store(ctx.agent);
  const dir = host.agentDir(ctx.agent);
  const main = ctx.kind === "main";
  const chat = ctx.kind === "chat";
  const helper = ctx.kind === "helper";

  if (main) {
    mcp.registerTool(
      "wake",
      {
        description: `Decide when you wake up next. One of:
- at / in: once, at a time ("2026-10-04T09:00:00Z") or after a delay ("20m", "6h", "2d"). Between ${MIN_SLEEP_MS / 60000} minute and ${MAX_SLEEP_MS / 86400000} days. Set this before ending a turn.
- every: repeatedly, e.g. "1d". Minimum 1 minute.
- watch: a shell command Overtime runs for you, without the model, that wakes you when something happens. Alone, it keeps running and every line it prints wakes you (e.g. "tail -F app.log | grep --line-buffered ERROR"). With every, it runs on that schedule and wakes you when its output changes.
Messages, answers and finished helpers always wake you early.`,
        inputSchema: {
          reason: z.string().describe("Why: a note to your future self, shown when it fires."),
          at: z.string().optional(),
          in: z.string().optional(),
          every: z.string().optional(),
          watch: z.string().optional(),
          cooldown: z.string().optional().describe('For watch: least time between wake-ups (default "10m").'),
        },
      },
      safe(async ({ reason, at, in: delay, every, watch, cooldown }) => {
        if (watch) {
          const everyMs = every ? Math.max(10_000, parseDuration(every)) : null;
          const m = await store.addMonitor({ run: watch, everyMs, why: reason, cooldownMs: cooldown ? parseDuration(cooldown) : 10 * 60_000 });
          host.startMonitor(ctx.agent, m.id);
          host.changed(ctx.agent, "monitors");
          return ok(`Watching (${m.id}), ${everyMs ? `every ${every}, waking you when the output changes` : "continuously, waking you on each line"}.`);
        }
        if (every) {
          const loop = await store.addLoop(parseDuration(every), reason);
          host.changed(ctx.agent, "schedule");
          return ok(`Repeating (${loop.id}) every ${every}; first at ${when(new Date(loop.nextAt))}.`);
        }
        let target: Date;
        if (at) target = new Date(at);
        else if (delay) target = new Date(Date.now() + parseDuration(delay));
        else return fail("Give one of: at, in, every, watch.");
        if (Number.isNaN(target.getTime())) return fail(`Couldn't read "${at}" as a time.`);
        const clamped = clampWake(target);
        await store.setWake(clamped, reason, true);
        ctx.wakeChosen = true;
        host.changed(ctx.agent, "schedule");
        const note = clamped.getTime() !== target.getTime() ? " (moved to stay within 1 minute to 3 days)" : "";
        return ok(`You'll wake at ${when(clamped)}${note}.`);
      }),
    );

    mcp.registerTool(
      "cancel",
      { description: "Stop a repeating wake-up, a watch or a running helper, by its id.", inputSchema: { id: z.string() } },
      safe(async ({ id }) => {
        if (id.startsWith("helper_")) {
          return (await host.cancelHelper(ctx.agent, id)) ? ok(`Cancelling ${id}. Its result (what it got done) will come to you.`) : fail(`No running helper ${id}.`);
        }
        if (id.startsWith("mon_")) {
          host.stopMonitor(ctx.agent, id);
          const removed = await store.removeMonitor(id);
          host.changed(ctx.agent, "monitors");
          return removed ? ok(`Stopped ${id}.`) : fail(`No watch ${id}.`);
        }
        const removed = await store.removeLoop(id);
        host.changed(ctx.agent, "schedule");
        return removed ? ok(`Stopped ${id}.`) : fail(`No repeating wake-up ${id}.`);
      }),
    );
  }

  if (main || chat) {
    mcp.registerTool(
      "ask",
      {
        description:
          "Ask the person something without stopping. It becomes a question they answer when they can; the answer reaches you later. Only for what is genuinely theirs to decide or genuinely unsafe. Give your recommendation and short options so they can answer with one key.",
        inputSchema: {
          question: z.string(),
          why: z.string().optional(),
          recommendation: z.string().optional(),
          options: z.array(z.string()).max(9).optional(),
          category: z.string().optional().describe('Short label for this kind of decision, e.g. "dependency-update".'),
          urgent: z.boolean().optional().describe("Only if it needs them soon: sends a notification."),
        },
      },
      safe(async ({ question, why, recommendation, options, category, urgent }) => {
        const id = await store.startThread({ kind: "question", title: question, from: "agent", text: question, why, recommendation, options, urgent, category, baseDir: dir });
        if (urgent) host.notify(`${ctx.agent} has a question`, question);
        host.changed(ctx.agent, "threads");
        return ok(`Asked (${id}). Carry on with anything that doesn't depend on the answer.`);
      }),
    );

    mcp.registerTool(
      "send",
      {
        description: chat
          ? 'Reply to the person in this conversation (text). To hand something to your main work session, a change of plan or real work to do, use to: "main" and then tell the person you have.'
          : "Talk to the person. to: a thread id replies in that thread; without it, starts a new thread (give a title). status: one short line shown next to your name, for what you're doing now. Use a new thread only for what deserves their attention (finished work, a problem, a decision); keep routine progress in your own notes. Mention files and links by full path or URL so they can open them.",
        inputSchema: {
          text: z.string().optional(),
          to: z.string().optional(),
          title: z.string().optional(),
          status: z.string().max(80).optional(),
          urgent: z.boolean().optional(),
        },
      },
      safe(async ({ text, to, title, status, urgent }) => {
        if (status) {
          await host.setActivity(ctx.agent, status);
          await store.addReport(status);
        }
        if (!text) return status ? ok("Status updated.") : fail("Nothing to send: give text or status.");
        if (chat && to === "main") {
          await store.pushInbox({ type: "message", text, threadId: ctx.threadId });
          host.wakeMain(ctx.agent, "your chat session passed you something from a conversation");
          return ok("Passed to your main session.");
        }
        const threadId = to ?? (chat ? ctx.threadId : undefined);
        if (threadId) {
          await store.addToThread(threadId, { from: "agent", text, baseDir: dir });
        } else {
          await store.startThread({ kind: "report", title: title ?? text.split("\n")[0], from: "agent", text, urgent, baseDir: dir });
          if (urgent) host.notify(ctx.agent, title ?? text.split("\n")[0]);
        }
        await store.addReport(text);
        host.changed(ctx.agent, "threads");
        return ok("Sent.");
      }),
    );
  }

  if (main) {
    mcp.registerTool(
      "spawn",
      {
        description:
          "Start a helper: a separate session that does one task in parallel and hands the result back to you. It starts clean, so put everything it needs in task. For a helper you'll want again, write its role (what it does, what done means) to a file in your folder and pass role_file; optional settings at the top of that file (backend, model) choose what it runs on. Parallel helpers each get their own copy of the workspace (a git worktree for repos); you review and merge their work.",
        inputSchema: {
          task: z.string(),
          role_file: z.string().optional().describe("Path of a role you wrote, inside your folder (relative to it, or absolute)."),
          backend: z.string().optional(),
          model: z.string().optional(),
        },
      },
      safe(async ({ task, role_file, backend, model }) => {
        let instructions = "";
        let roleBackend: string | undefined;
        let roleModel: string | undefined;
        if (role_file) {
          const p = await insideFolder(dir, role_file);
          const { data, body } = parseFrontMatter(await readFile(p, "utf8"));
          instructions = body;
          roleBackend = typeof data.backend === "string" ? data.backend : undefined;
          roleModel = typeof data.model === "string" ? data.model : undefined;
        }
        const h = await host.spawnHelper(ctx, { task, instructions, role: role_file, backend: backend ?? roleBackend, model: model ?? roleModel });
        host.changed(ctx.agent, "helpers");
        return ok(`Helper ${h.id} started in ${h.workdir}. Its result will come to you.`);
      }),
    );
  }

  if (helper) {
    mcp.registerTool(
      "done",
      {
        description: "Hand your result back: what you did, where the output is, what you checked, anything left open. Then end your turn.",
        inputSchema: { result: z.string() },
      },
      safe(async ({ result }) => {
        ctx.result = result;
        return ok("Thanks. End your turn now.");
      }),
    );
  }
}

/** Resolve a path the agent gave, and refuse it unless it is inside the agent's folder. */
async function insideFolder(dir: string, p: string): Promise<string> {
  const full = await realpath(isAbsolute(p) ? p : resolve(dir, p)).catch(() => {
    throw new Error(`There is no file at ${p}.`);
  });
  const root = await realpath(dir);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Role files must be inside your folder (${dir}).`);
  return full;
}
