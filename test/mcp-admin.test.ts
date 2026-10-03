import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, here, until } from "./helpers.js";

const home = fakeHome();
const { describeServer, checkServer } = await import("../src/daemon/mcp-admin.js");
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const tsx = join(here, "..", "node_modules", ".bin", "tsx");
const tiny = { name: "tiny", command: tsx, args: [join(here, "fixtures", "tiny-mcp.ts")] };

describe("MCP servers in the app", () => {
  it("hides secrets when showing a server", () => {
    expect(describeServer({ name: "g", command: "npx", args: ["x"], env: { TOKEN: "secret" } })).toBe("npx x (TOKEN set)");
    expect(describeServer({ name: "g", url: "https://a/mcp", headers: { Authorization: "Bearer s" } })).not.toContain("Bearer s");
  });

  it("checks a server really connects, and says why one doesn't", async () => {
    const ok = await checkServer(tiny);
    expect(ok).toMatchObject({ ok: true, tools: ["ping"] });
    const bad = await checkServer({ name: "bad", command: "definitely-not-a-command-xyz" }, 10_000);
    expect(bad).toMatchObject({ ok: false, error: "definitely-not-a-command-xyz isn't installed or isn't on your PATH" });
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
    writeFileSync(join(home, "agents", "tooled", "mcp.json"), JSON.stringify({ servers: [tiny] }));
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
