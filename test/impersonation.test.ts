import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fakeHome, here, until } from "./helpers.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");
const { loadAgent } = await import("../src/agent/agent.js");

const rt = new Runtime(() => {});
let control: InstanceType<typeof ControlServer>;

/** The overtime command, as an agent's shell (OVERTIME_AGENT set) or the person's terminal runs it. */
function cli(args: string[], agent?: string): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  if (agent) env.OVERTIME_AGENT = agent;
  else delete env.OVERTIME_AGENT;
  return new Promise((resolve) =>
    execFile(join(here, "..", "node_modules", ".bin", "tsx"), [join(here, "..", "src", "cli.ts"), ...args], { env, timeout: 60_000 }, (e, stdout, stderr) =>
      resolve({ code: e ? ((e as any).code ?? 1) : 0, out: stdout + stderr }),
    ),
  );
}

beforeAll(async () => {
  await rt.start();
  control = new ControlServer(rt, () => {}, () => {});
  await control.start();
  control.open();
  for (const n of ["a", "b"]) {
    await rt.create(n);
    await rt.send(n, `Your job is being ${n}.`);
  }
  await until(async () => (await loadAgent("a")).state.status === "asleep" && (await loadAgent("b")).state.status === "asleep", 30_000, "jobs learned");
});
afterAll(async () => {
  await control.stop();
  await rt.stop();
});

const fromYou = async (name: string, text: string) => (await rt.store(name).messages()).filter((m) => m.from === "you" && m.text === text);

describe("an agent can't act as the person", () => {
  it("refuses send to another agent, and nothing reaches it", async () => {
    const r = await cli(["send", "b", "hi from a"], "a");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("can only be done by the person");
    expect(await fromYou("b", "hi from a")).toEqual([]);
    expect((await rt.store("b").inbox()).filter((i: any) => JSON.stringify(i).includes("hi from a"))).toEqual([]);
  }, 60_000);

  it("says the person does it, and points to the message tool, without naming the caller as if it were the target", async () => {
    for (const args of [["send", "b", "hi"], ["daemon", "stop"]]) {
      const r = await cli(args, "a");
      expect(r.out).toContain("can only be done by the person. To reach another agent, use your message tool.");
      expect(r.out).not.toContain("not supported");
      expect(r.out).not.toContain("(here, a)");
    }
  }, 60_000);

  it("refuses sending to itself, answering and control commands", async () => {
    expect((await cli(["send", "a", "hi me"], "a")).out).toContain("its own send tool");
    expect(await fromYou("a", "hi me")).toEqual([]);
    for (const args of [["answer", "b", "1"], ["stop", "b"], ["set", "b", "budget=99"], ["archive", "b"], ["new", "c"], ["daemon", "stop"]]) {
      const r = await cli(args, "a");
      expect(r.code, args.join(" ")).not.toBe(0);
      expect(r.out).toContain("can only be done by the person");
    }
    expect((await loadAgent("b")).state.status).not.toBe("stopped");
  }, 120_000);

  it("refuses at the daemon too, whatever client asks", async () => {
    const { DaemonClient } = await import("../src/daemon/client.js");
    const c = await DaemonClient.connect();
    try {
      await expect(c.call("send", { name: "b", text: "sneaky", caller: "a" })).rejects.toThrow(/can only be done by the person/);
      await expect(c.call("wake", { name: "b", caller: "a" })).rejects.toThrow(/can only be done by the person/);
      expect((await c.call("agents", { caller: "a" })).length).toBe(2);
    } finally {
      c.close();
    }
    expect(await fromYou("b", "sneaky")).toEqual([]);
  });

  it("still lets it read: ls and messages, without marking the person's messages read", async () => {
    const unreadBefore = await rt.store("b").unread();
    expect(unreadBefore).toBeGreaterThan(0);
    const ls = await cli(["ls"], "a");
    expect(ls.code).toBe(0);
    expect(ls.out).toContain("b");
    const ms = await cli(["messages", "b"], "a");
    expect(ms.code).toBe(0);
    expect(ms.out).toContain("Your job is being b.");
    expect(await rt.store("b").unread()).toBe(unreadBefore);
  }, 60_000);

  it("refuses an answer that looks like an option number but can't be one, instead of sending it as text", async () => {
    for (const n of ["0", "-1", "1.5"]) {
      const r = await cli(["answer", "b", n]);
      expect(r.code, n).not.toBe(0);
      expect(r.out).toContain(`There is no option ${n}.`);
    }
    expect((await rt.store("b").messages()).filter((m) => m.from === "you" && ["0", "-1", "1.5"].includes(m.text))).toEqual([]);
  }, 60_000);

  it("the person's own terminal sends as before", async () => {
    const r = await cli(["send", "b", "hi from you"]);
    expect(r.code).toBe(0);
    expect((await fromYou("b", "hi from you")).length).toBe(1);
  }, 60_000);
});
