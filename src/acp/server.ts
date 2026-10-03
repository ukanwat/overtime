import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ensureDaemon, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import type { ThreadEntry } from "../store/types.js";

/**
 * Overtime as an ACP agent, so editors (Zed, JetBrains, VS Code ACP extensions, Neovim...) can talk to
 * your persistent agents. Each editor session is one thread with one agent; the agent is picked as the
 * session's mode. The agent keeps working on its own between messages; the editor is just a window.
 */
interface Sess {
  agent: string;
  threadId: string | null;
  seen: number;
  cancel?: () => void;
}

const REPLY_TIMEOUT_MS = 15 * 60_000;

export async function runAcpServer(): Promise<void> {
  const c: DaemonClient = await ensureDaemon();
  const sessions = new Map<string, Sess>();
  const waiters = new Set<() => void>();
  await c.subscribe(() => {
    for (const w of [...waiters]) w();
  });

  const agents = async (): Promise<AgentSummary[]> => c.call("agents");
  const modes = async (current: string) => {
    const list = await agents();
    return {
      availableModes: list.map((a) => ({ id: a.name, name: a.name, description: a.activity || a.status })),
      currentModeId: current,
    };
  };
  const sid = (agent: string, threadId: string | null) => `${agent}:${threadId ?? "new"}:${Math.random().toString(36).slice(2, 8)}`;

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

  const text = (t: string): acp.ContentBlock => ({ type: "text", text: t });

  acp
    .agent({ name: "overtime" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: true } },
      agentInfo: { name: "overtime", title: "Overtime", version: "0.2.0" },
    }) as any)
    .onRequest("session/new", async () => {
      const list = await agents();
      if (!list.length) throw acp.RequestError.invalidParams?.({ message: "No Overtime agents yet. Create one with `overtime new <name>`." }) ?? new Error("No Overtime agents yet.");
      const first = list.find((a) => a.status !== "stopped") ?? list[0];
      const id = sid(first.name, null);
      sessions.set(id, { agent: first.name, threadId: null, seen: 0 });
      return { sessionId: id, modes: await modes(first.name) } as any;
    })
    .onRequest("session/load", async (ctx: any) => {
      const [agent, threadId] = String(ctx.params.sessionId).split(":");
      const th = await c.call("thread", { name: agent, id: threadId, markRead: true });
      sessions.set(ctx.params.sessionId, { agent, threadId, seen: th.entries.length });
      for (const e of th.entries as ThreadEntry[]) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: e.from === "you" ? "user_message_chunk" : "agent_message_chunk", content: text(render(e)) },
        });
      }
      return { modes: await modes(agent) } as any;
    })
    .onRequest("session/set_mode", async (ctx: any) => {
      const s = sessions.get(ctx.params.sessionId);
      if (s && s.agent !== ctx.params.modeId) {
        // Switching agent starts a new thread with the new agent.
        s.agent = ctx.params.modeId;
        s.threadId = null;
        s.seen = 0;
      }
      return {} as any;
    })
    .onRequest("session/prompt", async (ctx: any) => {
      const s = sessions.get(ctx.params.sessionId);
      if (!s) throw new Error("Unknown session.");
      const msg = (ctx.params.prompt as any[])
        .map((p) => (p.type === "text" ? p.text : p.type === "resource" ? p.resource?.text ?? "" : p.type === "resource_link" ? p.uri : ""))
        .filter(Boolean)
        .join("\n\n");
      if (s.threadId) {
        const th = await c.call("thread", { name: s.agent, id: s.threadId });
        s.seen = th.entries.length;
        if (th.meta.status === "waiting_on_you") await c.call("answer", { name: s.agent, threadId: s.threadId, text: msg });
        else await c.call("send", { name: s.agent, threadId: s.threadId, text: msg });
      } else {
        const r = await c.call("send", { name: s.agent, text: msg });
        s.threadId = r.threadId;
        s.seen = 0;
      }
      s.seen += 1; // our own message
      // Wait for the agent's reply in this thread; the agent keeps working afterwards on its own.
      const reply = await new Promise<ThreadEntry[] | "cancelled" | "timeout">((resolve) => {
        let done = false;
        const finish = (v: ThreadEntry[] | "cancelled" | "timeout") => {
          if (done) return;
          done = true;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(v);
        };
        const check = () => {
          void c.call("thread", { name: s.agent, id: s.threadId, markRead: true }).then((th) => {
            const fresh = (th.entries as ThreadEntry[]).slice(s.seen).filter((e) => e.from !== "you");
            if (fresh.length) {
              s.seen = th.entries.length;
              finish(fresh);
            }
          }).catch(() => {});
        };
        const timer = setTimeout(() => finish("timeout"), REPLY_TIMEOUT_MS);
        s.cancel = () => finish("cancelled");
        waiters.add(check);
        check();
      });
      s.cancel = undefined;
      if (reply === "cancelled") return { stopReason: "cancelled" };
      const out = reply === "timeout" ? `${s.agent} hasn't replied yet. It's still working; its answer will be in this thread (overtime, or reopen this session).` : reply.map(render).join("\n\n");
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: text(out) } });
      return { stopReason: "end_turn" };
    })
    .onNotification("session/cancel", (ctx: any) => sessions.get(ctx.params.sessionId)?.cancel?.())
    .connect(stream);
}

function render(e: ThreadEntry): string {
  const parts = [e.text];
  if (e.why) parts.push(`Why it matters: ${e.why}`);
  if (e.recommendation) parts.push(`I'd recommend: ${e.recommendation}`);
  if (e.options?.length) parts.push(e.options.map((o, i) => `${i + 1}. ${o}`).join("\n") + "\n(Reply with your choice.)");
  return parts.join("\n\n");
}
