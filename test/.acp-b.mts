import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
const [phase, sid] = process.argv.slice(2);
const p = spawn("node", ["dist/cli.js", "acp"], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const updates: string[] = [];
const conn = acp
  .client({ name: "tester" })
  .onNotification(acp.methods.client.session.update, (ctx: any) => {
    const u = ctx.params.update;
    updates.push(`${u.sessionUpdate}: ${(u.content?.text ?? "").replace(/\n/g, " ").slice(0, 220)}`);
  })
  .connect(acp.ndJsonStream(Writable.toWeb(p.stdin!) as any, Readable.toWeb(p.stdout!) as any));
const req = (m: string, params: any) => conn.agent.request(m as any, params);
const t0 = Date.now();
const init: any = await req("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
console.log("init", JSON.stringify(init.agentCapabilities));
if (phase === "new") {
  const s: any = await req("session/new", { cwd: process.cwd(), mcpServers: [] });
  console.log("session", s.sessionId, "mode", s.modes?.currentModeId, "modes", s.modes?.availableModes?.map((m: any) => m.id).join(","));
  await req("session/set_mode", { sessionId: s.sessionId, modeId: "editor" });
  const r = await Promise.race([req("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: process.argv[4] ?? "Your job: answer quick questions from my editor. For this first message, reply with exactly the word pong." }] }), new Promise((res) => setTimeout(() => res("CLIENT-TIMEOUT"), 300_000))]);
  console.log("prompt result", JSON.stringify(r), "after", Math.round((Date.now() - t0) / 1000), "s");
} else {
  const r = await req("session/load", { sessionId: sid, cwd: process.cwd(), mcpServers: [] });
  console.log("load", JSON.stringify(r).slice(0, 200));
}
await new Promise((r) => setTimeout(r, 500));
console.log(updates.join("\n"));
p.kill();
process.exit(0);
