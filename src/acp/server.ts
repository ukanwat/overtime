import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ensureDaemon, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import type { Message } from "../store/types.js";
import { join } from "node:path";
import { home } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";
import { withLock } from "../store/mutex.js";


/**
 * Overtime as an ACP agent, so editors (Zed, JetBrains, VS Code ACP extensions, Neovim...) can talk to
 * your persistent agents. An editor session is a window onto one agent's conversation; the agent is
 * picked as the session's mode. The agent keeps working on its own between messages.
 */
interface Sess {
  agent: string;
  cancel?: () => void;
}

const REPLY_TIMEOUT_MS = 15 * 60_000;

/** Editor session ids and the agent each one talks to, kept so an editor can reopen a session later. */
const sessionsFile = () => join(home(), "acp-sessions.json");
type Saved = Record<string, { agent: string }>;
async function remember(id: string, agent: string): Promise<void> {
  await withLock("acp-sessions", async () => {
    const all = await readJson<Saved>(sessionsFile(), {});
    all[id] = { agent };
    await writeJson(sessionsFile(), all);
  });
}
async function recall(id: string): Promise<{ agent: string } | null> {
  return (await readJson<Saved>(sessionsFile(), {}))[id] ?? null;
}

export async function runAcpServer(): Promise<void> {
  const sessions = new Map<string, Sess>();
  const waiters = new Set<() => void>();
  const wakeWaiters = () => {
    for (const w of [...waiters]) w();
  };
  // The daemon can restart under a long editor session: reconnect on the next call.
  let client: DaemonClient = await ensureDaemon();
  await client.subscribe(wakeWaiters);
  let connecting: Promise<DaemonClient> | null = null;
  const live = async (): Promise<DaemonClient> => {
    if (!client.isClosed) return client;
    connecting ??= (async () => {
      const next = await ensureDaemon();
      await next.subscribe(wakeWaiters);
      client = next;
      return next;
    })().finally(() => (connecting = null));
    return connecting;
  };
  const c = { call: async <T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> => (await live()).call<T>(method, params) };

  const agents = async (): Promise<AgentSummary[]> => c.call("agents");
  const modes = async (current: string) => {
    const list = await agents();
    return {
      availableModes: list.map((a) => ({ id: a.name, name: a.name, description: a.activity || a.status })),
      currentModeId: current,
    };
  };
  const sid = () => `ot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const text = (t: string): acp.ContentBlock => ({ type: "text", text: t });
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

  acp
    .agent({ name: "overtime" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: true } },
      agentInfo: { name: "overtime", title: "Overtime", version: "0.2.1" },
    }) as any)
    .onRequest("session/new", async () => {
      const list = await agents();
      if (!list.length) throw new Error("No Overtime agents yet. Create one with `overtime new <name>`.");
      const first = list.find((a) => a.status !== "stopped") ?? list[0];
      const id = sid();
      sessions.set(id, { agent: first.name });
      await remember(id, first.name);
      return { sessionId: id, modes: await modes(first.name) } as any;
    })
    .onRequest("session/load", async (ctx: any) => {
      const saved = await recall(String(ctx.params.sessionId));
      if (!saved) throw new Error("Overtime doesn't know that session. Start a new one.");
      sessions.set(ctx.params.sessionId, { agent: saved.agent });
      const { messages } = await c.call("messages", { name: saved.agent, limit: 50, markRead: true });
      for (const m of messages as Message[]) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: m.from === "you" ? "user_message_chunk" : "agent_message_chunk", content: text(render(m)) },
        });
      }
      return { modes: await modes(saved.agent) } as any;
    })
    .onRequest("session/set_mode", async (ctx: any) => {
      const s = sessions.get(ctx.params.sessionId);
      if (s && s.agent !== ctx.params.modeId) {
        s.agent = ctx.params.modeId;
        await remember(ctx.params.sessionId, s.agent);
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
      const { id: mine } = await c.call("send", { name: s.agent, text: msg });
      // Wait for the agent's reply; it keeps working afterwards on its own.
      const reply = await new Promise<Message[] | "cancelled" | "timeout">((resolve) => {
        let done = false;
        const finish = (v: Message[] | "cancelled" | "timeout") => {
          if (done) return;
          done = true;
          waiters.delete(check);
          clearTimeout(timer);
          clearInterval(poll);
          resolve(v);
        };
        const check = () => {
          void c
            .call("messages", { name: s.agent, limit: 100, markRead: true })
            .then(({ messages }: { messages: Message[] }) => {
              const i = messages.findIndex((m) => m.id === mine);
              const fresh = (i >= 0 ? messages.slice(i + 1) : []).filter((m) => m.from !== "you");
              if (fresh.length) finish(fresh);
            })
            .catch(() => {});
        };
        const timer = setTimeout(() => finish("timeout"), REPLY_TIMEOUT_MS);
        // Events are the fast path; this catches a reply that landed while the daemon was reconnecting.
        const poll = setInterval(check, 10_000);
        s.cancel = () => finish("cancelled");
        waiters.add(check);
        check();
      });
      s.cancel = undefined;
      if (reply === "cancelled") return { stopReason: "cancelled" };
      const out = reply === "timeout" ? `${s.agent} hasn't replied yet. It's still working; its answer will be in its conversation (open overtime, or reopen this session).` : reply.map(render).join("\n\n");
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: text(out) } });
      return { stopReason: "end_turn" };
    })
    .onNotification("session/cancel", (ctx: any) => sessions.get(ctx.params.sessionId)?.cancel?.())
    .connect(stream);
}

function render(m: Message): string {
  const parts = [m.title && m.title !== m.text.split("\n")[0] ? `${m.title}\n\n${m.text}` : m.text];
  if (m.why) parts.push(`Why it matters: ${m.why}`);
  if (m.recommendation) parts.push(`I'd recommend: ${m.recommendation}`);
  if (m.options?.length) parts.push(m.options.map((o, i) => `${i + 1}. ${o}`).join("\n") + (m.answer ? `\n(Answered: ${m.answer.text})` : "\n(Reply with your choice.)"));
  if (m.attachments?.length) parts.push(m.attachments.map((a) => `📎 ${a.path}`).join("\n"));
  return parts.join("\n\n");
}
