import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, here, until } from "./helpers.js";

const home = fakeHome();
const { parseServerInput, guessName, checkName, describeServer, checkServer } = await import("../src/daemon/mcp-admin.js");
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const tsx = join(here, "..", "node_modules", ".bin", "tsx");
const tiny = `${tsx} ${join(here, "fixtures", "tiny-mcp.ts")}`;

describe("adding MCP servers from the app", () => {
  it("reads a command (with env vars) or a URL (with headers), and names it", () => {
    const a = parseServerInput("GITHUB_TOKEN=abc npx -y @modelcontextprotocol/server-github");
    expect(a).toMatchObject({ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "abc" } });
    const b = parseServerInput("https://mcp.linear.app/sse   Authorization: Bearer xyz");
    expect(b).toMatchObject({ name: "linear", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer xyz" } });
    expect(guessName({ name: "", command: "uvx", args: ["mcp-server-fetch"] })).toBe("fetch");
    expect(() => parseServerInput("")).toThrow(/command|URL/);
  });

  it("checks names and hides secrets when showing a server", () => {
    expect(checkName("Git Hub", [])).toMatch(/lowercase/);
    expect(checkName("overtime", [])).toMatch(/Overtime's own/);
    expect(checkName("github", ["github"])).toMatch(/already/);
    expect(checkName("github", [])).toBeNull();
    expect(describeServer({ name: "g", command: "npx", args: ["x"], env: { TOKEN: "secret" } })).toBe("npx x (TOKEN set)");
    expect(describeServer({ name: "g", url: "https://a/mcp", headers: { Authorization: "Bearer s" } })).not.toContain("Bearer s");
  });

  it("checks a server really connects, and says why one doesn't", async () => {
    const ok = await checkServer(parseServerInput(tiny, "tiny"));
    expect(ok).toMatchObject({ ok: true, tools: ["ping"] });
    const bad = await checkServer(parseServerInput("definitely-not-a-command-xyz", "bad"), 10_000);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  }, 60_000);
});

describe("an added server reaches the agent", () => {
  const rt = new Runtime(() => {});
  beforeAll(async () => rt.start());
  afterAll(async () => rt.stop());

  it("for one agent, from its next turn; shared ones can be switched off per agent and removed", async () => {
    await rt.create("tooled");
    await rt.send("tooled", "Your job is testing.");
    await until(async () => (await loadAgent("tooled")).state.status === "asleep", 30_000, "first turn");
    const added = await rt.mcpAdd("tooled", "agent", tiny, "tiny");
    expect(added.check).toMatchObject({ ok: true, tools: ["ping"] });
    expect(readFileSync(join(home, "agents", "tooled", "AGENT.md"), "utf8")).toContain("name: tiny"); // shown in its settings block
    await rt.send("tooled", "next turn please");
    const seen = join(home, "agents", "tooled", ".mcp-seen");
    await until(async () => readFileSync(seen, "utf8").includes("tiny"), 30_000, "server given to the agent");
    await rt.mcpAdd("tooled", "all", "https://example.invalid/mcp", "shared-one");
    expect((await rt.mcpList("tooled")).map((m) => `${m.name}:${m.scope}:${m.enabled}`)).toEqual(["shared-one:all:true", "tiny:agent:true"]);
    await rt.mcpSetEnabled("tooled", "shared-one", false);
    expect((await rt.mcpList("tooled")).find((m) => m.name === "shared-one")!.enabled).toBe(false);
    await rt.mcpRemove("tooled", "tiny");
    await rt.mcpRemove("tooled", "shared-one");
    expect(await rt.mcpList("tooled")).toEqual([]);
    await expect(rt.mcpAdd("tooled", "agent", "x", "overtime")).rejects.toThrow(/Overtime's own/);
  }, 120_000);
});
