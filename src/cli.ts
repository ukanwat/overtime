#!/usr/bin/env node
import { DaemonClient, ensureDaemon } from "./daemon/client.js";
import type { AgentSummary } from "./daemon/control.js";
import { validateName } from "./agent/agent.js";

const [, , cmd, ...rest] = process.argv;

function rel(iso: string | null): string {
  if (!iso) return "-";
  const d = (new Date(iso).getTime() - Date.now()) / 60000;
  const a = Math.abs(d);
  const s = a < 1 ? "now" : a < 60 ? `${Math.round(a)}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  return s === "now" ? "now" : d >= 0 ? `in ${s}` : `${s} ago`;
}

function line(a: AgentSummary): string {
  const dot = a.status === "working" ? "●" : a.status === "paused" || a.status === "error" ? "◌" : "○";
  const when = a.status === "paused" ? `resumes ${rel(a.pausedUntil)}` : a.status === "stopped" ? "stopped" : a.status === "new" ? "waiting for its job" : `wakes ${rel(a.nextWake)}`;
  const spend = a.costReported ? `$${a.spentUsd.toFixed(2)}/$${a.budgetUsd}` : `${Math.round(a.tokensToday / 1000)}k tok`;
  const badge = a.waiting || a.unread ? ` [${a.waiting + a.unread}]` : "";
  return `${dot} ${(a.name + badge).padEnd(24)} ${(a.activity || a.status).slice(0, 40).padEnd(40)} ${when.padEnd(18)} ${spend}`;
}

const HELP = `overtime: agents that exist, not sessions

  overtime                         open the live terminal app
  overtime new <name>              create an agent (it starts with no identity)
  overtime ls                      list agents
  overtime send <name> "message"   message an agent (starts a new thread)
  overtime threads <name>          list an agent's threads
  overtime thread <name> <id>      show a thread
  overtime reply <name> <id> "…"   reply in a thread
  overtime answer <name> <id> <n>  answer a question with option n
  overtime stop|start|wake <name>
  overtime daemon                  run the daemon in the foreground
  overtime daemon stop             stop the background daemon
`;

async function main() {
  if (!cmd) {
    const { runApp } = await import("./tui/app.js");
    await runApp();
    return;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return void console.log(HELP);
  if (cmd === "daemon") {
    if (rest[0] === "stop") {
      try {
        const c = await DaemonClient.connect();
        await c.call("shutdown");
        c.close();
        console.log("Overtime daemon stopped. Agents will continue when it starts again.");
      } catch {
        console.log("The daemon isn't running.");
      }
      return;
    }
    await import("./daemon/main.js");
    return;
  }

  const c = await ensureDaemon();
  try {
    switch (cmd) {
      case "new": {
        const name = rest[0];
        if (!name) throw new Error("Usage: overtime new <name>");
        const err = validateName(name);
        if (err) throw new Error(err);
        const r = await c.call("new", { name });
        console.log(`Created ${r.name}. It has no identity yet; tell it what it's for:\n  overtime send ${r.name} "…"`);
        break;
      }
      case "ls": {
        const agents: AgentSummary[] = await c.call("agents");
        if (!agents.length) console.log("No agents yet. Create one with: overtime new <name>");
        for (const a of agents) console.log(line(a));
        break;
      }
      case "send": {
        const [name, ...words] = rest;
        if (!name || !words.length) throw new Error('Usage: overtime send <name> "message"');
        const r = await c.call("send", { name, text: words.join(" ") });
        console.log(`Sent (thread ${r.threadId}).`);
        break;
      }
      case "reply": {
        const [name, id, ...words] = rest;
        if (!name || !id || !words.length) throw new Error('Usage: overtime reply <name> <thread-id> "message"');
        await c.call("send", { name, threadId: id, text: words.join(" ") });
        console.log("Sent.");
        break;
      }
      case "answer": {
        const [name, id, choice, ...words] = rest;
        if (!name || !id || !choice) throw new Error('Usage: overtime answer <name> <thread-id> <option-number> ["note"]');
        await c.call("answer", { name, threadId: id, choice: Number(choice), text: words.join(" ") || undefined });
        console.log("Answered.");
        break;
      }
      case "threads": {
        const name = rest[0];
        if (!name) throw new Error("Usage: overtime threads <name>");
        const ths: any[] = await c.call("threads", { name });
        for (const t of ths) console.log(`${t.status === "waiting_on_you" ? "?" : t.kind === "report" ? "▪" : t.kind === "alert" ? "!" : "›"} ${t.id}  ${t.title.slice(0, 70)}${t.unread ? `  (${t.unread} new)` : ""}  ${rel(t.updatedAt)}`);
        break;
      }
      case "thread": {
        const [name, id] = rest;
        if (!name || !id) throw new Error("Usage: overtime thread <name> <thread-id>");
        const th = await c.call("thread", { name, id, markRead: true });
        for (const e of th.entries) {
          console.log(`\n${e.from === "you" ? "You" : e.from === "agent" ? name : "Overtime"} · ${new Date(e.t).toLocaleString()}`);
          console.log(e.text);
          if (e.recommendation) console.log(`Recommendation: ${e.recommendation}`);
          if (e.options) e.options.forEach((o: string, i: number) => console.log(`  ${i + 1}  ${o}`));
          if (e.links) e.links.forEach((l: any, i: number) => console.log(`  [${i + 1}] ${l.target}`));
        }
        break;
      }
      case "stop":
      case "start":
      case "wake":
        if (!rest[0]) throw new Error(`Usage: overtime ${cmd} <name>`);
        await c.call(cmd, { name: rest[0] });
        console.log("Done.");
        break;
      default:
        console.log(HELP);
    }
  } finally {
    c.close();
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
