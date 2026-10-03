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

describe("an agent's own servers, controlled by the person", () => {
  const rt = new Runtime(() => {});
  beforeAll(async () => rt.start());
  afterAll(async () => rt.stop());

  it("an agent adds one in its mcp.json; you see its status, disconnect, reconnect and remove it", async () => {
    await rt.create("tooled");
    await rt.send("tooled", "Your job is testing.");
    await until(async () => (await loadAgent("tooled")).state.status === "asleep", 30_000, "first turn");
    // The agent adds a server for itself, as the overtime-docs skill describes.
    writeFileSync(join(home, "agents", "tooled", "mcp.json"), JSON.stringify({ servers: [parseServerInput(tiny, "tiny")] }));
    await rt.send("tooled", "next turn please");
    const seen = join(home, "agents", "tooled", ".mcp-seen");
    await until(async () => readFileSync(seen, "utf8").includes("tiny"), 30_000, "server given to the agent");
    expect(await rt.mcpList("tooled")).toEqual([{ name: "tiny", source: "agent", enabled: true, describe: expect.stringContaining("tiny-mcp.ts") }]);
    expect((await rt.mcpStatus("tooled")).tiny).toMatchObject({ ok: true, tools: ["ping"] });
    await rt.mcpSetEnabled("tooled", "tiny", false); // you disconnect it
    expect((await rt.mcpList("tooled"))[0].enabled).toBe(false);
    expect(await rt.mcpStatus("tooled")).toEqual({}); // off: not started
    await rt.send("tooled", "another turn");
    await until(async () => !readFileSync(seen, "utf8").includes("tiny"), 30_000, "server no longer given");
    await rt.mcpSetEnabled("tooled", "tiny", true); // and back
    await rt.mcpRemove("tooled", "tiny"); // removed from the agent's own mcp.json
    expect(await rt.mcpList("tooled")).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, "agents", "tooled", "mcp.json"), "utf8")).servers).toEqual([]);
  }, 120_000);
});
