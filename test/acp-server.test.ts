import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, here, until } from "./helpers.js";

const home = fakeHome();
// Register Overtime itself as an ACP backend, the way an editor would launch it.
const settingsPath = join(home, "settings.json");
const s = JSON.parse(readFileSync(settingsPath, "utf8"));
s.customBackends.overtime = { command: join(here, "..", "node_modules", ".bin", "tsx"), args: [join(here, "..", "src", "cli.ts"), "acp"] };
writeFileSync(settingsPath, JSON.stringify(s));

const { Runtime } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");
const { AcpSession } = await import("../src/acp/session.js");
const { loadAgent } = await import("../src/agent/agent.js");

const rt = new Runtime(() => {});
let control: InstanceType<typeof ControlServer>;

beforeAll(async () => {
  await rt.start();
  control = new ControlServer(rt, () => {}, () => {});
  await control.start();
  await rt.create("editorbot");
  await rt.send("editorbot", "Your job is answering from the editor.");
  await until(async () => (await loadAgent("editorbot")).state.status === "asleep", 30_000, "job learned");
});
afterAll(async () => {
  await control.stop();
  await rt.stop();
});

describe("Overtime as an ACP agent for editors", () => {
  it("offers agents as modes and answers a message through the agent's chat", async () => {
    let text = "";
    const sess = await AcpSession.open({
      backend: "overtime",
      cwd: home,
      mcpServers: [],
      onUpdate: (u: any) => {
        if (u.sessionUpdate === "agent_message_chunk") text += u.content.text;
      },
      onPermission: () => ({ outcome: { outcome: "cancelled" } }),
    });
    try {
      await sess.newSession();
      const modes: any = (sess.newSessionInfo as any).modes;
      expect(modes.availableModes.map((m: any) => m.id)).toContain("editorbot");
      const r = await sess.prompt("hello from the editor");
      expect(r.stopReason).toBe("end_turn");
      expect(text).toContain("main reply to: hello from the editor");
      expect((await rt.store("editorbot").messages()).some((m) => m.from === "you" && m.text === "hello from the editor")).toBe(true);
    } finally {
      await sess.close();
    }
  });
});
