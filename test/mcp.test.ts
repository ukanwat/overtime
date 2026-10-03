import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome({
  mcpServers: [
    { name: "shared-a", command: "node", args: ["-e", "0"] },
    { name: "shared-b", url: "http://127.0.0.1:9/mcp" },
  ],
});
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const rt = new Runtime(() => {});

beforeAll(async () => rt.start());
afterAll(async () => rt.stop());

describe("MCP servers", () => {
  it("gives agents the shared servers, their own extras, minus ones they switched off, plus Overtime's tools", async () => {
    await rt.create("mcpbot");
    const md = join(home, "agents", "mcpbot", "AGENT.md");
    writeFileSync(md, `---\nmcpServers:\n  - name: own-c\n    command: node\n    args: ["-e", "0"]\ndisableMcp:\n  - shared-b\n---\n\n` + readFileSync(md, "utf8"));
    await rt.send("mcpbot", "go");
    await until(async () => (await loadAgent("mcpbot")).state.status === "asleep", 30_000, "turn");
    const seen = readFileSync(join(home, "agents", "mcpbot", ".mcp-seen"), "utf8").trim().split(",");
    expect(seen).toContain("shared-a");
    expect(seen).toContain("own-c");
    expect(seen).toContain("overtime");
    expect(seen).not.toContain("shared-b");
    // Its own rewrite of AGENT.md must not lose the person's MCP settings.
    expect((await loadAgent("mcpbot")).settings.disableMcp).toEqual(["shared-b"]);
  });
});

describe("a backend that only runs MCP servers as local commands", () => {
  it("still gets Overtime's tools, through the bridge, and replies", async () => {
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    settings.customBackends.stdiofake = { command: settings.customBackends.fake.command, args: [...settings.customBackends.fake.args, "--stdio-mcp"] };
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
    await rt.create("bridged", { backend: "stdiofake" });
    const [g] = await rt.store("bridged").messages();
    await rt.send("bridged", "Your job is testing.", []);
    await until(async () => (await loadAgent("bridged")).state.status === "asleep", 40_000, "turn through the bridge");
    const msgs = await rt.store("bridged").messages();
    expect(msgs.some((m) => m.from === "agent" && m.id !== g.id)).toBe(true);
    // Set with Overtime's own wake tool, so the tools really reached this backend.
    expect((await rt.store("bridged").schedule()).wakeReason).toBe("fake rest");
  });
});

describe("skills in a real session", () => {
  it("an agent loads one with the skill tool", async () => {
    await rt.create("skilled");
    await rt.send("skilled", "Your job is testing.", []);
    await until(async () => (await loadAgent("skilled")).state.status === "asleep", 40_000, "first turn");
    await rt.send("skilled", "PASS SKILLCHECK", []);
    const f = join(home, "agents", "skilled", "skill-result.txt");
    const { existsSync } = await import("node:fs");
    await until(async () => existsSync(f), 40_000, "skill loaded");
    expect(readFileSync(f, "utf8")).toContain("# How Overtime works");
  });
});
