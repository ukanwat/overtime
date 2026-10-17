import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fakeHome, here, until } from "./helpers.js";

fakeHome();
const { Runtime, AGENT_MESSAGES_PER_DAY } = await import("../src/daemon/runtime.js");
const { loadAgent, setSettings, publicAgents } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");
const { ControlServer } = await import("../src/daemon/control.js");

const rt = new Runtime(() => {});
let control: InstanceType<typeof ControlServer>;

/** The overtime command, as the person runs it. */
function cli(args: string[]): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  delete env.OVERTIME_AGENT;
  return new Promise((resolve) =>
    execFile(join(here, "..", "node_modules", ".bin", "tsx"), [join(here, "..", "src", "cli.ts"), ...args], { env, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as any).code ?? 1) : 0, out: stdout + stderr })),
  );
}
const file = (agent: string, name: string) => join(paths.agent(agent), name);
const read = (agent: string, name: string) => (existsSync(file(agent, name)) ? readFileSync(file(agent, name), "utf8") : "");

/** Have the person tell an agent something, and wait until it's back asleep with the inbox empty. */
async function tell(agent: string, text: string, what = `${agent}'s turn`) {
  await rt.send(agent, text);
  await until(async () => (await loadAgent(agent)).state.status === "asleep" && !(await rt.store(agent).inbox()).length && !(rt as any).mainRunning.has(agent), 30_000, what);
}

beforeAll(async () => {
  await rt.start();
  control = new ControlServer(rt, () => {}, () => {});
  await control.start();
  control.open();
  for (const n of ["ann", "bob", "cat"]) {
    await rt.create(n);
    await tell(n, "Your job is testing.");
  }
  await setSettings("cat", { visibility: "private" });
});
afterAll(async () => {
  await control.stop();
  await rt.stop();
});

describe("agents messaging each other", () => {
  it("delivers to the other agent's inbox labelled from the sender, wakes it, and shows in both conversations", async () => {
    await tell("ann", "MSG_TO bob: please review the draft", "ann sends");
    expect(read("ann", ".message-result")).toBe("Sent to bob.");
    // Bob wakes for it and is told it's from another agent, never from the person.
    await until(async () => read("bob", ".agent-inbox"), 30_000, "bob's turn");
    const told = read("bob", ".agent-inbox");
    expect(told).toContain("Message from ann (another agent, not the person)");
    expect(told).toContain("please review the draft");
    expect(told).not.toMatch(/Message from the person[^\n]*\n[^\n]*please review/);
    for (const n of ["ann", "bob"]) {
      const m = (await rt.store(n).messages()).find((x) => x.kind === "agent-message");
      expect(m).toMatchObject({ fromAgent: "ann", toAgent: "bob", text: "please review the draft" });
    }
    // Quiet: it doesn't count as unread for the person.
    await rt.store("bob").markRead();
    const before = await rt.store("ann").unread();
    await rt.messageAgent("bob", "ann", "noted");
    expect(await rt.store("ann").unread()).toBe(before);
  });

  it("lists public agents with their job, and gives the tool only to a public agent with someone to message", async () => {
    await tell("ann", "MSG_TO bob: one more", "ann sends again");
    const [tools, ...desc] = read("ann", ".message-desc").split("\n");
    expect(tools.split(",")).toContain("message");
    expect(desc.join("\n")).toContain(`- bob: Test job. (${paths.agent("bob")})`);
    expect(desc.join("\n")).not.toContain("cat");
    expect(desc.join("\n")).not.toContain("- ann");
    // The private agent has no message tool at all.
    rmSync(file("cat", ".message-desc"), { force: true });
    await tell("cat", "MSG_TO ann: hello", "cat's turn");
    expect(read("cat", ".message-desc").split("\n")[0].split(",")).not.toContain("message");
  });

  it("refuses messaging itself, an unknown agent and a private one (as unknown)", async () => {
    await expect(rt.messageAgent("ann", "ann", "hi")).rejects.toThrow(/That's you/);
    await expect(rt.messageAgent("ann", "nobody", "hi")).rejects.toThrow(/no agent called "nobody"/);
    await expect(rt.messageAgent("ann", "cat", "hi")).rejects.toThrow(/no agent called "cat"/);
    await expect(rt.messageAgent("cat", "ann", "hi")).rejects.toThrow(/Only public agents/);
    // Through the tool too, as the agent sees it.
    await tell("ann", "MSG_TO cat: hi", "ann messages cat");
    expect(read("ann", ".message-result")).toMatch(/^ERROR .*no agent called "cat"/);
  });

  it("says an agent exists but hasn't been set up yet, rather than that there's no such agent; a private one stays unknown", async () => {
    await rt.create("dan");
    await expect(rt.messageAgent("ann", "dan", "hi")).rejects.toThrow(`dan exists but hasn't been set up yet: the person hasn't given it its job, so it can't take messages. Agents you can message: bob.`);
    await setSettings("dan", { visibility: "private" });
    await expect(rt.messageAgent("ann", "dan", "hi")).rejects.toThrow(`There's no agent called "dan". Agents you can message: bob.`);
  });

  it("gives a new public agent the tool in its first session, before it has its job; a new private one gets none", async () => {
    // Its first session starts with no job in AGENT.md, writes it, and carries on with the same tools.
    await rt.create("eve");
    await tell("eve", "MSG_TO bob: hello from the new one", "eve's first turn");
    const [tools, ...desc] = read("eve", ".message-desc").split("\n");
    expect(tools.split(",")).toContain("message");
    expect(desc.join("\n")).toContain(`- bob: Test job. (${paths.agent("bob")})`);
    expect(desc.join("\n")).not.toContain("cat");
    expect(read("eve", ".message-result")).toBe("Sent to bob.");
    await rt.create("fay");
    await setSettings("fay", { visibility: "private" });
    await tell("fay", "MSG_TO bob: hello", "fay's first turn");
    expect(read("fay", ".message-desc").split("\n")[0].split(",")).not.toContain("message");
  });

  it("keeps a message for a stopped agent until it's started", async () => {
    await rt.stopAgent("bob");
    rmSync(file("bob", ".agent-inbox"), { force: true });
    await rt.messageAgent("ann", "bob", "while you were out");
    await new Promise((r) => setTimeout(r, 1500));
    expect((await loadAgent("bob")).state.status).toBe("stopped");
    expect((await rt.store("bob").inbox()).some((i) => i.text === "while you were out")).toBe(true);
    await rt.startAgent("bob");
    await until(async () => read("bob", ".agent-inbox").includes("while you were out"), 30_000, "bob picks it up");
  });

  it("caps a pair's messages a day, with one alert to the person", async () => {
    await rt.stopAgent("bob"); // no turns needed for this
    const alerts = async () => (await rt.store("ann").messages()).filter((m) => m.kind === "alert" && /message limit/.test(m.title ?? "")).length;
    let refused = 0;
    for (let i = 0; i < AGENT_MESSAGES_PER_DAY + 3; i++) {
      try {
        await rt.messageAgent(i % 2 ? "bob" : "ann", i % 2 ? "ann" : "bob", `ping ${i}`);
      } catch (e: any) {
        expect(e.message).toMatch(/Not sent: .*20 messages today/);
        refused++;
      }
    }
    // Earlier tests already exchanged a few; whatever was left of the 20 went through, the rest didn't.
    expect(refused).toBeGreaterThan(0);
    expect(await alerts()).toBe(1);
    await expect(rt.messageAgent("ann", "bob", "again")).rejects.toThrow(/Not sent/);
    expect(await alerts()).toBe(1);
    await rt.startAgent("bob");
  });

  it("is set public or private with overtime set, shown in settings and AGENT.md's block", async () => {
    expect((await cli(["set", "ann", "visibility=private"])).code).toBe(0);
    expect((await loadAgent("ann")).settings.visibility).toBe("private");
    expect(readFileSync(file("ann", "AGENT.md"), "utf8")).toMatch(/^visibility: private$/m);
    expect((await cli(["settings", "ann"])).out).toMatch(/visibility\s+private/);
    await expect(rt.messageAgent("bob", "ann", "hi")).rejects.toThrow(/no agent called "ann"/);
    expect((await cli(["set", "ann", "visibility=public"])).code).toBe(0);
    expect((await loadAgent("ann")).settings.visibility).toBeUndefined();
    expect((await cli(["settings", "ann"])).out).toMatch(/visibility\s+public/);
    // With the settings block gone, the file starts with its title again, not a blank line.
    expect(readFileSync(file("ann", "AGENT.md"), "utf8")).toMatch(/^# /);
    const bad = await cli(["set", "ann", "visibility=secret"]);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("isn't a visibility");
  }, 90_000);

  it("lists the settings you can change, all of them, after a key that isn't one", async () => {
    const r = await cli(["set", "ann", "colour=red"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('There\'s no setting "colour"');
    for (const k of ["backend", "model", "budget", "tokens", "workspace", "visibility", "protect"]) expect(r.out).toContain(k);
  }, 60_000);

  it("says there's no such agent when asked for the messages of one that doesn't exist", async () => {
    const r = await cli(["messages", "zz"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('No agent called "zz"');
    expect(r.out).not.toContain("No messages with zz");
  }, 60_000);

  it("shows each agent's job in the list as plain text, without markdown", async () => {
    const md = file("bob", "AGENT.md");
    const before = readFileSync(md, "utf8");
    try {
      writeFileSync(md, "# bob\n\n**Role:** Keeps the [docs](https://example.com) in `docs/` tidy.\n**Goal:** none\n");
      expect(publicAgents().find((a) => a.name === "bob")?.job).toBe("Role: Keeps the docs in docs/ tidy.");
    } finally {
      writeFileSync(md, before);
    }
  });

  it("keeps a private agent's folder unreadable to other agents (macOS), never to itself", async () => {
    await tell("ann", `READ_FILE ${file("cat", "AGENT.md")}`, "ann reads cat");
    expect(read("ann", ".read-result")).toBe(process.platform === "darwin" ? "denied" : "read");
    await tell("ann", `READ_FILE ${file("bob", "AGENT.md")}`, "ann reads bob");
    expect(read("ann", ".read-result")).toBe("read");
    await tell("cat", `READ_FILE ${file("cat", "AGENT.md")}`, "cat reads itself");
    expect(read("cat", ".read-result")).toBe("read");
  }, 90_000);
});
