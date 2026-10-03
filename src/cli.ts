#!/usr/bin/env node
import { createAgent, listAgents, loadAgent } from "./agent/agent.js";
import { runTurn } from "./runtime/turn.js";

const [, , cmd, ...rest] = process.argv;

function rel(iso: string | null): string {
  if (!iso) return "-";
  const d = (new Date(iso).getTime() - Date.now()) / 60000;
  const a = Math.abs(d);
  const s = a < 60 ? `${Math.round(a)}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  return d >= 0 ? `in ${s}` : `${s} ago`;
}

async function main() {
  switch (cmd) {
    case "new": {
      const name = rest[0];
      if (!name) throw new Error("Usage: overtime new <name>");
      const a = await createAgent(name);
      console.log(`Created ${a.name} at ${a.dir}. It has no identity yet; tell it what it's for in its first message.`);
      break;
    }
    case "ls": {
      const agents = await listAgents();
      if (!agents.length) return console.log("No agents yet. Create one with: overtime new <name>");
      for (const a of agents) {
        const dot = a.state.status === "working" ? "●" : "○";
        console.log(`${dot} ${a.name.padEnd(20)} ${a.state.status.padEnd(8)} ${(a.state.activity || "").padEnd(32)} next wake ${rel(a.state.nextWake)}`);
      }
      break;
    }
    case "run": {
      // Developer command for milestone 2: one main-session turn, printed live.
      const [name, ...words] = rest;
      if (!name || !words.length) throw new Error('Usage: overtime run <name> "message"');
      const agent = await loadAgent(name);
      const r = await runTurn({
        agent: name,
        kind: "main",
        reason: "the person sent you a message from the command line",
        text: `Message from the person:\n\n${words.join(" ")}`,
        resumeSessionId: agent.state.mainSessionBackend ? agent.state.mainSessionId : null,
        onUpdate: (u) => {
          if (u.sessionUpdate === "tool_call") process.stderr.write(`  · ${u.title}\n`);
        },
        log: () => {},
      });
      console.log(`\n${r.reply}\n`);
      console.log(`(${r.fresh ? "new" : "continued"} session ${r.sessionId.slice(0, 8)} · ${r.backend} · stop: ${r.stopReason} · tokens: ${r.usage?.totalTokens ?? "?"})`);
      break;
    }
    default:
      console.log("overtime new <name> | ls | run <name> \"message\"");
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
