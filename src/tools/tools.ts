import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolHost } from "./host.js";
import { clampWake, MAX_SLEEP_MS, MIN_SLEEP_MS, parseDuration } from "../store/store.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Wrap a handler so a bug never crashes the session: errors come back as a readable tool error. */
function safe<A>(fn: (a: A) => Promise<Result>): (a: A) => Promise<Result> {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e: any) {
      return fail(String(e?.message ?? e));
    }
  };
}

function fmtWhen(d: Date): string {
  return `${d.toISOString()} (${d.toString()})`;
}

/**
 * Register Overtime's tools for one session. Which tools a session gets depends on its kind:
 * the main session gets everything; chat sessions answer and pass things on; helpers report and finish.
 */
export function registerTools(mcp: McpServer, ctx: ToolContext, host: ToolHost): void {
  const store = host.store(ctx.agent);
  const dir = host.agentDir(ctx.agent);
  const main = ctx.kind === "main";
  const chat = ctx.kind === "chat";
  const helper = ctx.kind === "helper";

  mcp.registerTool(
    "now",
    { description: "Current date and time, your timezone, and how much of today's budget you have used." },
    safe(async () => {
      const d = new Date();
      const s = await host.spentToday(ctx.agent);
      const spend = s.costReported ? `Spent today: $${s.usd.toFixed(2)} of your $${s.budgetUsd.toFixed(2)} daily budget (as reported by your backend).` : `Used today: ${s.tokens.toLocaleString()} tokens${s.budgetTokens != null ? ` of your ${s.budgetTokens.toLocaleString()} daily budget` : ""}.`;
      return ok(`Now: ${fmtWhen(d)}\nTimezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n${spend}`);
    }),
  );

  if (main) {
    mcp.registerTool(
      "sleep_until",
      {
        description: `Choose when you next wake up, once this stretch of work is done. Give either an absolute time ('at', ISO 8601) or a delay ('in', e.g. "20m", "6h", "2d"). Limits: at least ${MIN_SLEEP_MS / 60000} minute, at most ${MAX_SLEEP_MS / 86400000} days ahead. Messages, monitors and finished helpers still wake you early. Call it before ending your turn.`,
        inputSchema: { at: z.string().optional(), in: z.string().optional(), reason: z.string().describe("Why you will wake then: a note to your future self.") },
      },
      safe(async ({ at, in: delay, reason }) => {
        let target: Date;
        if (at) target = new Date(at);
        else if (delay) target = new Date(Date.now() + parseDuration(delay));
        else return fail("Give 'at' or 'in'.");
        if (Number.isNaN(target.getTime())) return fail(`Couldn't read "${at}" as a time.`);
        const clamped = clampWake(target);
        await store.setWake(clamped, reason, true);
        ctx.wakeChosen = true;
        host.changed(ctx.agent, "schedule");
        const note = clamped.getTime() !== target.getTime() ? " (adjusted to stay within 1 minute to 3 days)" : "";
        return ok(`You will wake at ${fmtWhen(clamped)}${note}. End your turn when you're ready.`);
      }),
    );

    mcp.registerTool(
      "every",
      {
        description: "Set a recurring wake-up for yourself, e.g. check CI every 20 minutes. Minimum interval 1 minute. Returns a loop id you can cancel.",
        inputSchema: { interval: z.string().describe('e.g. "20m", "6h", "1d"'), task: z.string().describe("What to do each time.") },
      },
      safe(async ({ interval, task }) => {
        const loop = await store.addLoop(parseDuration(interval), task);
        host.changed(ctx.agent, "schedule");
        return ok(`Loop ${loop.id} set: every ${interval}, first at ${fmtWhen(new Date(loop.nextAt))}.`);
      }),
    );

    mcp.registerTool(
      "cancel",
      { description: "Cancel one of your recurring wake-ups.", inputSchema: { loop_id: z.string() } },
      safe(async ({ loop_id }) => {
        const removed = await store.removeLoop(loop_id);
        host.changed(ctx.agent, "schedule");
        return removed ? ok(`Cancelled ${loop_id}.`) : fail(`No loop ${loop_id}.`);
      }),
    );

    mcp.registerTool(
      "schedule",
      { description: "See your next wake-up, your loops and your monitors." },
      safe(async () => {
        const s = await store.schedule();
        const mons = (await store.monitors()).filter((m) => m.status !== "removed");
        const lines = [`Next wake: ${s.wakeAt ? `${fmtWhen(new Date(s.wakeAt))} — ${s.wakeReason ?? ""}` : "not set"}`];
        lines.push(s.loops.length ? "Loops:\n" + s.loops.map((l) => `- ${l.id}: every ${Math.round(l.everyMs / 60000)}m, next ${l.nextAt}: ${l.task}`).join("\n") : "Loops: none");
        lines.push(mons.length ? "Monitors:\n" + mons.map((m) => `- ${m.id} [${m.status}] ${m.everyMs ? `every ${Math.round(m.everyMs / 1000)}s` : "long-running"}: ${m.why}\n  run: ${m.run}`).join("\n") : "Monitors: none");
        return ok(lines.join("\n"));
      }),
    );

    mcp.registerTool(
      "watch",
      {
        description:
          "Set a monitor: a shell command or script that Overtime runs for you, without using the model, and that wakes you when it fires. Long-running (omit 'every'): every line it prints is an event, delivered within moments (e.g. `tail -F app.log | grep --line-buffered ERROR`, `fswatch ./inbox`). Repeating (give 'every', e.g. \"10m\"): runs on that schedule and fires only when its output changes. Runs in your folder. Keep scripts in your folder if they're longer than one line.",
        inputSchema: {
          run: z.string().describe("Shell command to run."),
          every: z.string().optional().describe('For repeating monitors, e.g. "5m". Omit for long-running.'),
          why: z.string().describe("Why you set it: a note to your future self, shown when it fires."),
          cooldown: z.string().optional().describe('Minimum time between wake-ups from this monitor (default "10m").'),
        },
      },
      safe(async ({ run, every, why, cooldown }) => {
        const everyMs = every ? Math.max(10_000, parseDuration(every)) : null;
        const m = await store.addMonitor({ run, everyMs, why, cooldownMs: cooldown ? parseDuration(cooldown) : 10 * 60_000 });
        host.startMonitor(ctx.agent, m.id);
        host.changed(ctx.agent, "monitors");
        return ok(`Monitor ${m.id} is ${everyMs ? `running every ${every}` : "running continuously"}.`);
      }),
    );

    mcp.registerTool(
      "unwatch",
      { description: "Remove a monitor you no longer need.", inputSchema: { id: z.string() } },
      safe(async ({ id }) => {
        host.stopMonitor(ctx.agent, id);
        const removed = await store.removeMonitor(id);
        host.changed(ctx.agent, "monitors");
        return removed ? ok(`Removed ${id}.`) : fail(`No monitor ${id}.`);
      }),
    );
  }

  if (main || chat) {
    mcp.registerTool(
      "ask",
      {
        description:
          "Ask the person something, without stopping. It appears as a question thread they answer when they can; the answer arrives in a later turn. Keep working on anything that doesn't depend on it. Only ask about what is genuinely theirs to decide or genuinely unsafe. Write for a busy person: the question, why it matters, your recommendation, and short options.",
        inputSchema: {
          question: z.string(),
          why: z.string().optional().describe("Why it matters, in a sentence or two."),
          recommendation: z.string().optional().describe("What you would do and why."),
          options: z.array(z.string()).max(9).optional().describe("Short choices; they can answer with one key."),
          urgent: z.boolean().optional().describe("True only if it needs them soon; sends a notification."),
          category: z.string().optional().describe('A short label for this kind of decision, e.g. "dependency-update". Used to learn which decisions you can take yourself.'),
          meanwhile: z.string().optional().describe("What you will do while waiting."),
        },
      },
      safe(async ({ question, why, recommendation, options, urgent, category, meanwhile }) => {
        const text = meanwhile ? `${question}\n\nMeanwhile: ${meanwhile}` : question;
        const id = await store.startThread({ kind: "question", title: question, from: "agent", text, why, recommendation, options, urgent, category, baseDir: dir });
        if (urgent) host.notify(`${ctx.agent} has a question`, question);
        host.changed(ctx.agent, "threads");
        return ok(`Asked (thread ${id}). Carry on with other work; the answer will reach you in a later turn.`);
      }),
    );

    mcp.registerTool(
      "reply",
      {
        description: chat
          ? "Reply in this thread. Plain words, like a message to a colleague. Mention files and links by full path or URL so they become clickable."
          : "Reply in a thread with the person (use the thread id from the message you're answering). Plain words. Mention files and links by full path or URL so they become clickable.",
        inputSchema: chat ? { text: z.string(), thread_id: z.string().optional() } : { thread_id: z.string(), text: z.string() },
      },
      safe(async (a: { thread_id?: string; text: string }) => {
        const threadId = a.thread_id ?? ctx.threadId;
        if (!threadId) return fail("Which thread? Pass thread_id.");
        await store.addToThread(threadId, { from: "agent", text: a.text, baseDir: dir });
        host.changed(ctx.agent, "threads");
        return ok("Sent.");
      }),
    );
  }

  if (main) {
    mcp.registerTool(
      "message",
      {
        description: "Start a new conversation thread with the person, when something deserves their attention but isn't a question or a routine report.",
        inputSchema: { title: z.string(), text: z.string(), urgent: z.boolean().optional() },
      },
      safe(async ({ title, text, urgent }) => {
        const id = await store.startThread({ kind: "conversation", title, from: "agent", text, urgent, baseDir: dir });
        if (urgent) host.notify(`${ctx.agent}`, title);
        host.changed(ctx.agent, "threads");
        return ok(`Started thread ${id}.`);
      }),
    );
  }

  if (main || helper) {
    mcp.registerTool(
      "report",
      {
        description: main
          ? "Report progress. 'status' is one short line shown next to your name (what you're doing now). Add 'text' and set notify for an update worth the person's attention (work finished, a problem, a decision made); it appears as a report thread. Don't report routine steps."
          : "Report progress to the agent that started you. Optional; use done() when finished.",
        inputSchema: main
          ? { status: z.string().max(80), text: z.string().optional(), notify: z.boolean().optional(), title: z.string().optional() }
          : { text: z.string() },
      },
      safe(async (a: { status?: string; text?: string; notify?: boolean; title?: string }) => {
        if (helper) {
          await store.addReport(`[helper ${ctx.helperId}] ${a.text}`);
          return ok("Noted.");
        }
        if (a.status) await host.setActivity(ctx.agent, a.status);
        if (a.text) await store.addReport(a.text);
        if (a.notify && a.text) {
          await store.startThread({ kind: "report", title: a.title ?? a.status ?? a.text.split("\n")[0], from: "agent", text: a.text, baseDir: dir });
          host.changed(ctx.agent, "threads");
        }
        host.changed(ctx.agent, "state");
        return ok("Reported.");
      }),
    );

    if (ctx.depth < 2) {
      mcp.registerTool(
        "spawn",
        {
          description:
            "Start a helper: a separate agent session that works on one task in parallel and reports back to your inbox when done. Use a saved role, or give one-off instructions. A helper starts clean: give it everything it needs in the task. Parallel helpers each get their own copy of the workspace (a git worktree for repos), so they don't clash; you review and merge their work.",
          inputSchema: {
            task: z.string().describe("What to do, what 'done' means, and where things are."),
            role: z.string().optional().describe("Name of a saved role."),
            instructions: z.string().optional().describe("One-off instructions if there is no saved role."),
            backend: z.string().optional().describe("Override the backend, e.g. a cheaper one for research."),
            model: z.string().optional(),
          },
        },
        safe(async (a) => {
          const h = await host.spawnHelper(ctx, a);
          host.changed(ctx.agent, "helpers");
          return ok(`Helper ${h.id} started in ${h.workdir}. Its result will arrive in your inbox.`);
        }),
      );

      mcp.registerTool(
        "helpers",
        { description: "List your helpers and their status." },
        safe(async () => {
          const hs = await host.helpers(ctx.agent);
          return ok(hs.length ? hs.map((h) => `- ${h.id} [${h.status}] ${h.task.split("\n")[0].slice(0, 100)} (workdir ${h.workdir})`).join("\n") : "No helpers.");
        }),
      );
    }
  }

  if (main) {
    mcp.registerTool(
      "define_role",
      {
        description: "Save or update a reusable helper role: what the helper does, what it gets to see, what 'done' means for it, and optionally which backend and model it uses. Improve a role when a helper keeps making the same mistake.",
        inputSchema: { name: z.string(), instructions: z.string(), backend: z.string().optional(), model: z.string().optional() },
      },
      safe(async ({ name, instructions, backend, model }) => {
        await store.saveRole({ name, instructions, backend, model });
        return ok(`Role "${name}" saved.`);
      }),
    );

    mcp.registerTool(
      "decisions",
      {
        description: "The person's past answers to your questions, by category. Use it to spot decisions they always approve, then propose (with ask) that you take those yourself from now on, and if they agree, add the rule to AGENT.md.",
        inputSchema: { category: z.string().optional() },
      },
      safe(async ({ category }) => {
        const ds = (await store.decisions()).filter((d) => !category || d.category === category);
        if (!ds.length) return ok("No recorded decisions yet.");
        return ok(ds.slice(-40).map((d) => `- [${d.category}] ${d.t.slice(0, 10)}: ${d.question} → ${d.answer}`).join("\n"));
      }),
    );
  }

  if (chat) {
    mcp.registerTool(
      "pass_to_main",
      {
        description: "Pass something from this conversation to your main work session: a change of plan, a new task, or anything that needs real work. It wakes your main session at once. Then tell the person you've passed it on.",
        inputSchema: { text: z.string() },
      },
      safe(async ({ text }) => {
        await store.pushInbox({ type: "message", text, threadId: ctx.threadId });
        host.wakeMain(ctx.agent, "your chat session passed you something from a conversation");
        return ok("Passed to your main session.");
      }),
    );
  }

  if (helper) {
    mcp.registerTool(
      "done",
      {
        description: "Finish: hand your result to the agent that started you. Say what you did, where the output is, what you checked, and anything left open.",
        inputSchema: { result: z.string() },
      },
      safe(async ({ result }) => {
        ctx.result = result;
        return ok("Thanks. End your turn now.");
      }),
    );
  }
}
