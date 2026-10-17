import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const notes = process.env.OVERTIME_FAKE_NOTES!;
// The scripted backend under Gemini's name too, to see what Overtime sets up for a Gemini session.
const settingsFile = join(home, "settings.json");
const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
settings.customBackends.gemini = settings.customBackends.fake;
writeFileSync(settingsFile, JSON.stringify(settings));
// Claude's own memories live under its config folder: a scratch one here, never the person's.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "overtime-claude-"));
const { Runtime, reflectDue, reflectEnabled, REFLECT_CHUNK_CHARS, REFLECT_IDLE_MS, REFLECT_PASSES_PER_DAY, REFLECT_BACKOFF_MS } = await import("../src/daemon/runtime.js");
const { loadAgent, setSettings, updateState } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");
const { isolationMeta, CLAUDE_BUILTINS_OFF } = await import("../src/acp/session.js");
const { isolationEnv, codexMemoriesOff, geminiMemoryOff } = await import("../src/acp/backends.js");
const mem = await import("../src/agent/memory.js");
const { sandboxAvailable } = await import("../src/runtime/sandbox.js");

const scratch = () => mkdtempSync(join(tmpdir(), "overtime-mem-"));

/** What a run told the agent: its prompt, from Overtime's own record of the run. */
function prompts(agent: string, prefix = "main_"): string[] {
  const dir = join(paths.meta(agent), "runs");
  // In the order they ran (run ids only go to the second).
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .sort((a, b) => a[0].t.localeCompare(b[0].t))
    .map((events) => events.find((e) => e.event === "prompt")?.data?.text ?? "");
}

describe("provider memory is off", () => {
  it("Claude sessions get auto-memory off, in their options and their environment", async () => {
    const opts = (isolationMeta("claude") as any).claudeCode.options;
    expect(opts.settings).toEqual({ autoMemoryEnabled: false, autoDreamEnabled: false });
    expect(opts.settingSources).toEqual([]);
    expect(opts.disallowedTools).toEqual(CLAUDE_BUILTINS_OFF);
    expect((isolationMeta("claude", ["Bash"]) as any).claudeCode.options.disallowedTools).toEqual([...CLAUDE_BUILTINS_OFF, "Bash"]);
    expect(await isolationEnv("claude", scratch())).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });

  it("Codex gets memories off in the agent's own config, keeping what the file already says", async () => {
    const meta = scratch();
    const env = await isolationEnv("codex", meta);
    const toml = readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8");
    expect(toml).toContain("[memories]\ngenerate_memories = false\nuse_memories = false");
    expect(toml).toContain("[features]\nmemories = false");
    // An existing config: its settings stay, and memories are added into its [features] table.
    const f = join(scratch(), "config.toml");
    writeFileSync(f, 'model = "o3"\n\n[features]\nweb_search = true\n');
    await codexMemoriesOff(f);
    await codexMemoriesOff(f);
    const out = readFileSync(f, "utf8");
    expect(out).toContain('model = "o3"');
    expect(out).toContain("[features]\nmemories = false\nweb_search = true");
    expect(out.match(/\[memories\]/g)).toHaveLength(1);
    // What the person set about memories is left alone.
    writeFileSync(f, "[memories]\nuse_memories = true\n\n[features]\nmemories = true\n");
    await codexMemoriesOff(f);
    expect(readFileSync(f, "utf8")).toBe("[memories]\nuse_memories = true\n\n[features]\nmemories = true\n");
  });

  it("Gemini gets save_memory excluded and Auto Memory off in project settings, keeping the rest", async () => {
    const cwd = scratch();
    await geminiMemoryOff(cwd);
    expect(JSON.parse(readFileSync(join(cwd, ".gemini", "settings.json"), "utf8"))).toEqual({ tools: { exclude: ["save_memory"] }, experimental: { autoMemory: false } });
    writeFileSync(join(cwd, ".gemini", "settings.json"), JSON.stringify({ model: { name: "x" }, tools: { exclude: ["web_fetch"] } }));
    await geminiMemoryOff(cwd);
    expect(JSON.parse(readFileSync(join(cwd, ".gemini", "settings.json"), "utf8"))).toEqual({ model: { name: "x" }, tools: { exclude: ["web_fetch", "save_memory"] }, experimental: { autoMemory: false } });
  });
});

describe("importing Claude's memories", () => {
  it("copies them in with Overtime's header, merges the index without overwriting, and keeps the originals", async () => {
    const agentDir = scratch();
    const src = mem.claudeMemoryDir(agentDir);
    expect(src).toBe(join(process.env.CLAUDE_CONFIG_DIR!, "projects", agentDir.replace(/[^a-zA-Z0-9]/g, "-"), "memory"));
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "MEMORY.md"), "- [Colour](colour.md) — purple is wanted\n- [Budget](budget.md) — keep under $20\n");
    writeFileSync(join(src, "colour.md"), "---\nname: colour\ndescription: purple is wanted\nmetadata:\n  type: feedback\n  modified: 2026-10-09T10:49:18.515Z\n---\n\nPurple is wanted.\n");
    writeFileSync(join(src, "budget.md"), "---\nname: budget\nmetadata:\n  type: user\n---\n\nKeep under $20.\n");
    writeFileSync(join(src, "unlisted.md"), "---\nname: Unlisted\ndescription: not in Claude's index\n---\n\nStill kept.\n");
    // Already here: a different budget.md and an index line of the agent's own.
    mkdirSync(join(agentDir, "memory"));
    writeFileSync(join(agentDir, "memory", "budget.md"), "mine\n");
    writeFileSync(join(agentDir, "memory", "MEMORY.md"), "- [Mine](budget.md) — my own budget note\n");

    const r = await mem.importClaudeMemory(agentDir, [agentDir, agentDir]);
    expect(r.files).toBe(3);
    const colour = readFileSync(join(agentDir, "memory", "colour.md"), "utf8");
    // What the person said (Claude's feedback and user memories) is from the person; the rest was observed.
    expect(colour).toMatch(/type: feedback\nsource: person\ndate: 2026-10-09\nlast-verified: 2026-10-09/);
    expect(colour).toContain("Purple is wanted.");
    expect(readFileSync(join(agentDir, "memory", "budget.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(agentDir, "memory", "budget.claude.md"), "utf8")).toContain("type: person\nsource: person");
    expect(readFileSync(join(agentDir, "memory", "unlisted.md"), "utf8")).toContain("type: project\nsource: observed");
    expect(readFileSync(join(agentDir, "memory", "MEMORY.md"), "utf8")).toBe(
      "- [Mine](budget.md) — my own budget note\n- [Colour](colour.md) — purple is wanted\n- [Budget](budget.claude.md) — keep under $20\n- [Unlisted](unlisted.md) — not in Claude's index\n",
    );
    // The originals are untouched, and a second run adds nothing.
    expect(readFileSync(join(src, "budget.md"), "utf8")).toBe("---\nname: budget\nmetadata:\n  type: user\n---\n\nKeep under $20.\n");
    const again = await mem.importClaudeMemory(agentDir, [agentDir]);
    expect(again.files).toBe(0);
    expect(readFileSync(join(agentDir, "memory", "MEMORY.md"), "utf8").split("\n").filter(Boolean)).toHaveLength(4);
  });
});

describe("the index and its cap", () => {
  it("shows the whole index, and past the cap has a note to consolidate rather than cutting it", () => {
    const long = Array.from({ length: mem.MEMORY_CAP_LINES + 5 }, (_, i) => `- [M${i}](m${i}.md) — rule ${i}`).join("\n");
    expect(mem.memoryText(long)).toContain(`rule ${mem.MEMORY_CAP_LINES + 4}`);
    expect(mem.memoryOverCap(long)).toContain(`over the ${mem.MEMORY_CAP_LINES}-line cap. Before this turn ends, merge overlapping memories`);
    expect(mem.memoryText("- [A](a.md) — b")).toBe("- [A](a.md) — b");
    expect(mem.memoryOverCap("- [A](a.md) — b")).toBe("");
  });
});

describe("when a reflect pass is due", () => {
  const base = { formatVersion: 1, status: "asleep", activity: "", nextWake: null, mainSessionId: null, mainSessionBackend: null, createdAt: "", lastRunAt: null, lastError: null } as any;
  const now = Date.parse("2026-10-17T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms);
  const today = { passes: 0, usd: 0, budgetUsd: 100 };
  const some = { turns: 3, chars: 5_000, newest: ago(10 * 60_000) };
  it("by how much is unread, a compaction, or idle time; never with nothing unread", () => {
    expect(reflectDue(base, { turns: 0, chars: 0, newest: null }, today, now)).toBeNull();
    // A little, just now: it waits.
    expect(reflectDue(base, some, today, now)).toBeNull();
    // A chunk's worth: now, however recent.
    expect(reflectDue(base, { turns: 40, chars: REFLECT_CHUNK_CHARS, newest: ago(60_000) }, today, now)).toBe("40 turns not reflected yet");
    // Compacted: now.
    expect(reflectDue({ ...base, compactedSinceReflect: true }, some, today, now)).toBe("its session was compacted; 3 turns not reflected yet");
    // A little, but idle a while: now.
    expect(reflectDue(base, { ...some, newest: ago(REFLECT_IDLE_MS) }, today, now)).toBe("idle, 3 turns not reflected yet");
    expect(reflectDue({ ...base, lastRunAt: ago(60_000).toISOString() }, { ...some, newest: ago(REFLECT_IDLE_MS) }, today, now)).toBeNull();
  });

  it("at most so many passes, and so much of the budget, a day", () => {
    const big = { turns: 40, chars: REFLECT_CHUNK_CHARS * 3, newest: ago(60_000) };
    expect(reflectDue(base, big, { ...today, passes: REFLECT_PASSES_PER_DAY - 1 }, now)).toBeTruthy();
    expect(reflectDue(base, big, { ...today, passes: REFLECT_PASSES_PER_DAY }, now)).toBeNull();
    expect(reflectDue(base, big, { ...today, usd: 9.99 }, now)).toBeTruthy();
    expect(reflectDue(base, big, { ...today, usd: 10 }, now)).toBeNull();
  });

  it("after a pass was stopped or failed, only once it has been idle a while, longer each time in a row", () => {
    const big = { turns: 40, chars: REFLECT_CHUNK_CHARS * 3, newest: ago(6 * 3600_000) };
    const stopped = (n: number, at: number) => ({ ...base, reflectStops: n, reflectStoppedAt: ago(at).toISOString() });
    expect(reflectDue(stopped(1, REFLECT_BACKOFF_MS - 60_000), big, today, now)).toBeNull();
    expect(reflectDue(stopped(1, REFLECT_BACKOFF_MS), big, today, now)).toBeTruthy();
    // The person kept writing: idle counts from their last turn, not from the stop.
    expect(reflectDue({ ...stopped(1, 3600_000), lastRunAt: ago(5 * 60_000).toISOString() }, big, today, now)).toBeNull();
    expect(reflectDue(stopped(2, REFLECT_BACKOFF_MS), big, today, now)).toBeNull();
    expect(reflectDue(stopped(2, 2 * REFLECT_BACKOFF_MS), big, today, now)).toBeTruthy();
    // Never more than 4 hours.
    expect(reflectDue(stopped(9, 4 * 3600_000), big, today, now)).toBeTruthy();
  });

  it("not while the person may still be talking to it: even a full chunk or a compaction waits for a few minutes of idle", () => {
    const fresh = { turns: 40, chars: REFLECT_CHUNK_CHARS * 3, newest: ago(60_000) };
    expect(reflectDue(base, fresh, today, now, 5 * 60_000)).toBeNull();
    expect(reflectDue({ ...base, compactedSinceReflect: true }, fresh, today, now, 5 * 60_000)).toBeNull();
    expect(reflectDue(base, { ...fresh, newest: ago(5 * 60_000) }, today, now, 5 * 60_000)).toBe("40 turns not reflected yet");
  });

  it("on by default; off by the agent's setting or the global one (kept across restarts), or OVERTIME_REFLECT=0", () => {
    expect(reflectEnabled({ reflect: true }, {})).toBe(true);
    expect(reflectEnabled({ reflect: false }, {})).toBe(false);
    expect(reflectEnabled({ reflect: true }, { OVERTIME_REFLECT: "0" })).toBe(false);
    expect(reflectEnabled({ reflect: true }, { OVERTIME_REFLECT: "1" })).toBe(true);
  });
});

describe("memory in a running agent", () => {
  const lines: string[] = [];
  const rt = new Runtime((l) => lines.push(l));
  const turns = (a: string) => readdirSync(join(paths.meta(a), "runs")).filter((f) => f.startsWith("main_")).length;
  async function tell(agent: string, text: string) {
    const n = existsSync(join(paths.meta(agent), "runs")) ? turns(agent) : 0;
    await rt.send(agent, text);
    await until(async () => (await loadAgent(agent)).state.status === "asleep" && turns(agent) > n && !(rt as any).mainRunning.has(agent), 30_000, `${agent}'s turn`);
  }

  beforeAll(async () => {
    await rt.start();
  });
  afterAll(async () => {
    await rt.stop();
  });

  it("imports Claude's memories on the first turn, shows MEMORY.md in the opening, and again only when it changes", async () => {
    await rt.create("rem");
    const src = mem.claudeMemoryDir(paths.agent("rem"));
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "MEMORY.md"), "- [Phone first](phone.md) — every frame must read at phone size\n");
    writeFileSync(join(src, "phone.md"), "---\nname: phone\nmetadata:\n  type: feedback\n---\n\nRead at phone size.\n");
    await tell("rem", "Your job is testing.");
    const a = await loadAgent("rem");
    expect(a.state.memoryImportedAt).toBeTruthy();
    expect(readFileSync(join(a.dir, "memory", "phone.md"), "utf8")).toContain("type: feedback");
    const first = prompts("rem")[0];
    expect(first).toContain(`# memory/MEMORY.md (what you've learned; the files are in ${join(a.dir, "memory")}/)\n\n- [Phone first](phone.md) — every frame must read at phone size`);
    expect(first).toContain("Keep what you learn in memory/");

    // Unchanged: a continued session isn't sent it again.
    await tell("rem", "Carry on.");
    expect(prompts("rem")[1]).not.toContain("MEMORY.md");
    // Changed (by the person, a reflect pass or another session): the next turn gets the new text.
    writeFileSync(join(a.dir, "memory", "MEMORY.md"), "- [Phone first](phone.md) — every frame must read at phone size\n- [Short](short.md) — keep replies short\n");
    await tell("rem", "And again.");
    const third = prompts("rem")[2];
    expect(third).toContain("memory/MEMORY.md (your memory index");
    expect(third).toContain("changed since your last turn. It now reads:\n\n- [Phone first](phone.md) — every frame must read at phone size\n- [Short](short.md) — keep replies short");
    expect(third).toContain("if you were corrected or worked out how to do something, save it: a how-to as a skill, anything else as a memory (memory/).");
  });

  it("keeps no history of its own in the agent's folder: no git repository, no .gitignore", async () => {
    const dir = paths.agent("rem");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("runs a reflect pass only when due and idle: it may change memory/ alone, sees its rules and skills, reads on from a cursor, quietly", async () => {
    await rt.create("refl");
    await tell("refl", "Your job is testing.");
    await tell("refl", "REFLECT_TAMPER you forgot to check the render");
    const dir = paths.agent("refl");
    const reflectRuns = () => readdirSync(join(paths.meta("refl"), "runs")).filter((f) => f.startsWith("reflect_"));
    const messages = (await rt.store("refl").messages()).length;
    mkdirSync(join(dir, "skills", "render"), { recursive: true });
    writeFileSync(join(dir, "skills", "render", "SKILL.md"), "---\nname: render\ndescription: how to render a shot\n---\n\n1. Render.\n");
    // An MCP server of the agent's own: a reflect pass doesn't get it.
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { mailer: { command: "true" } } }));

    // Not due yet (two short turns, just now), and not while over its budget: nothing runs.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(reflectRuns()).toHaveLength(0);
    await setSettings("refl", { dailyBudgetUsd: 0 });
    await updateState("refl", { compactedSinceReflect: true });
    await new Promise((r) => setTimeout(r, 6_000));
    expect(reflectRuns()).toHaveLength(0);

    // Due and idle: it runs.
    await setSettings("refl", { dailyBudgetUsd: null });
    const agentMd = readFileSync(join(dir, "AGENT.md"), "utf8");
    await updateState("refl", { status: "asleep", pausedUntil: null, pauseReason: null });
    await until(async () => (await rt.store("refl").reports()).some((r) => r.text.startsWith("Reflect pass")), 40_000, "a reflect pass");
    expect(reflectRuns()).toHaveLength(1);
    const seen = readFileSync(join(notes, "reflect-seen-refl.txt"), "utf8");
    // Only Overtime's own tools server, with the skill tool; none of the agent's servers.
    expect(seen.split("\n")[0]).toBe("skill");
    expect(seen.split("\n")[1]).toBe("servers: overtime");
    // What it did, oldest first with run ids; its rules and skills to compare against, read-only.
    expect(seen).toMatch(/## Turn at .* UTC \(run main_\S+\)/);
    expect(seen.indexOf("Your job is testing.")).toBeLessThan(seen.indexOf("you forgot to check the render"));
    expect(seen).toContain("# AGENT.md (read-only: never edit it)\n\n# fake");
    expect(seen).toContain("# INDEX.md (read-only)\n\n# Index");
    expect(seen).toContain(`- render (its own, ${join(dir, "skills", "render", "SKILL.md")}): how to render a shot`);
    expect(seen).toContain(`You can change only ${dir}/memory/`);
    // No boilerplate from the turns: not the reply reminder, not the time line.
    const digest = seen.slice(seen.indexOf("# What refl did"));
    expect(digest).not.toContain("Reply with send to new messages");
    expect(digest).not.toMatch(/^Time now: /m);
    expect(digest).toMatch(/It was told:\nWhy you are awake: the person sent you a message\n\nYour inbox/);
    // Its edit is in memory/. Its tries at AGENT.md and a file beside it didn't stay, and the commit has only memory/.
    expect(readFileSync(join(dir, "memory", "reflected.md"), "utf8")).toMatch(/runs: \[main_\S+\]/);
    expect(readFileSync(join(dir, "AGENT.md"), "utf8")).toBe(agentMd);
    if (sandboxAvailable().ok) {
      expect(readFileSync(join(notes, "reflect-tamper-refl.txt"), "utf8")).toBe("denied");
      expect(existsSync(join(dir, "notes-outside-memory.txt"))).toBe(false);
    } else expect(lines.some((l) => l.includes("[refl/reflect] changed") && l.includes("AGENT.md") && l.includes("put it back"))).toBe(true);
    expect(readFileSync(join(dir, "skills", "render", "SKILL.md"), "utf8")).toContain("1. Render.");
    expect(readdirSync(join(dir, "memory")).sort()).toEqual(["MEMORY.md", "reflected.md"]);
    expect(lines.some((l) => /\[refl\] reflect pass over its turns .* UTC \(its session was compacted; 2 turns not reflected yet\): reflected: added reflected\.md/.test(l))).toBe(true);
    // Nothing to the person: no message, one quiet activity line.
    expect((await rt.store("refl").messages()).length).toBe(messages);
    expect((await rt.store("refl").reports()).at(-1)!.text).toBe("Reflect pass: updated its memory: reflected: added reflected.md.");
    // It counts toward the budget, and toward the day's passes.
    const usage = readFileSync(join(paths.meta("refl"), "usage.jsonl"), "utf8");
    expect(usage).toContain('"kind":"reflect"');
    const st = (await loadAgent("refl")).state;
    expect(st.reflectDay?.passes).toBe(1);
    expect(st.compactedSinceReflect).toBe(false);
    // The cursor is at the last turn it read; the next pass reads on from there, not again.
    const mains = readdirSync(join(paths.meta("refl"), "runs")).filter((f) => f.startsWith("main_")).sort();
    expect(st.reflectCursor).toBe(mains.at(-1)!.replace(/\.jsonl$/, ""));
    // The next turn is told its memory changed.
    await tell("refl", "Next.");
    expect(prompts("refl").at(-1)).toContain("- [Check renders](reflected.md) — watch the whole render before sending it");
    await updateState("refl", { compactedSinceReflect: true });
    await until(async () => reflectRuns().length === 2 && !(rt as any).reflecting.has("refl"), 40_000, "a second pass");
    const second = readFileSync(join(notes, "reflect-seen-refl.txt"), "utf8");
    expect(second).toContain("Next.");
    expect(second).not.toContain("you forgot to check the render");
  });

  it("stops a reflect pass for real work: the main turn waits for it to stop, it records one row only if a cost was reported, and it backs off", async () => {
    await rt.create("rcan");
    await tell("rcan", "Your job is testing.");
    const runs = (prefix: string) => readdirSync(join(paths.meta("rcan"), "runs")).filter((f) => f.startsWith(prefix));
    const events = (f: string) => readFileSync(join(paths.meta("rcan"), "runs", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const usage = (runId: string) =>
      readFileSync(join(paths.meta("rcan"), "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.runId === runId);
    for (const [mark, rows] of [["", 0], ["cost", 1]] as const) {
      await until(async () => !(rt as any).reflecting.has("rcan"), 40_000, "no reflect pass running");
      writeFileSync(join(notes, "reflect-slow"), mark);
      const before = new Set(runs("reflect_"));
      await updateState("rcan", { compactedSinceReflect: true, reflectStops: 0, reflectStoppedAt: null });
      const f = await until(async () => !existsSync(join(notes, "reflect-slow")) && runs("reflect_").find((x) => !before.has(x) && events(x).some((e) => e.event === "prompt")), 40_000, "a reflect pass under way");
      rmSync(join(notes, "reflect-stopped-at"), { force: true });
      const cursor = (await loadAgent("rcan")).state.reflectCursor;
      await tell("rcan", "Real work.");
      // The pass had stopped before the main turn began.
      const stoppedAt = Number(readFileSync(join(notes, "reflect-stopped-at"), "utf8"));
      const main = runs("main_").map(events).sort((a, b) => a[0].t.localeCompare(b[0].t)).at(-1)!;
      expect(new Date(main[0].t).getTime()).toBeGreaterThanOrEqual(stoppedAt);
      expect(lines.some((l) => l.includes("[rcan] reflect pass stopped: its main session has work"))).toBe(true);
      // No row when nothing was reported; one, with the cost, when it was.
      const got = usage(f.replace(/\.jsonl$/, ""));
      expect(got).toHaveLength(rows);
      if (rows) expect(got[0].turnCostUsd).toBeCloseTo(0.02);
      // What it was reading is read again later (the cursor stayed), after a wait: not straight away.
      const st = (await loadAgent("rcan")).state;
      expect(st.reflectCursor).toBe(cursor);
      expect(st.reflectStops).toBe(1);
      const n = runs("reflect_").length;
      await new Promise((r) => setTimeout(r, 6_000));
      expect(runs("reflect_").length).toBe(n);
    }
  });

  it("notes a compaction the backend reports, and reflects after it", async () => {
    await rt.create("comp");
    await tell("comp", "Your job is testing.");
    await tell("comp", "COMPACT please");
    await until(async () => lines.some((l) => l.includes("[comp] reflect pass over its turns") && l.includes("its session was compacted")), 40_000, "a reflect pass after compaction");
    expect((await loadAgent("comp")).state.compactedSinceReflect).toBe(false);
  });

  it("turns Gemini's memory off in the agent's folder before a Gemini session", async () => {
    await rt.create("gem", { backend: "gemini" });
    await tell("gem", "Your job is testing.");
    expect(JSON.parse(readFileSync(join(paths.agent("gem"), ".gemini", "settings.json"), "utf8"))).toEqual({ tools: { exclude: ["save_memory"] }, experimental: { autoMemory: false } });
    expect(existsSync(join(paths.agent("rem"), ".gemini"))).toBe(false);
  });

  it("a pass that fails for a passing reason or a usage limit only waits: nothing passed over, no limit recorded, the agent not paused", async () => {
    await rt.create("rfail");
    await tell("rfail", "Your job is testing.");
    const st = async () => (await loadAgent("rfail")).state;
    const cursor = (await st()).reflectCursor;
    const limits = () => (existsSync(join(home, "limits.json")) ? readFileSync(join(home, "limits.json"), "utf8") : "");
    for (const how of ["overloaded", "limit", "overloaded", "limit"]) {
      writeFileSync(join(notes, "reflect-fail"), how);
      await (rt as any).reflect("rfail", "test", new AbortController());
      expect(existsSync(join(notes, "reflect-fail"))).toBe(false);
      expect((await st()).reflectFailures ?? 0).toBe(0);
      expect((await st()).status).toBe("asleep");
    }
    const s1 = await st();
    expect(s1.reflectStops).toBe(4);
    expect(s1.reflectCursor ?? null).toBe(cursor ?? null);
    expect(limits()).not.toContain("rejected");
    expect(await (rt as any).blocked("rfail")).toBeFalsy();
    expect(lines.some((l) => l.includes("[rfail] reflect pass couldn't run now (tried again later)"))).toBe(true);
    // A real failure counts; three in a row pass that part over.
    for (let n = 1; n <= 3; n++) {
      writeFileSync(join(notes, "reflect-fail"), "fatal");
      await (rt as any).reflect("rfail", "test", new AbortController());
    }
    expect((await st()).reflectCursor).not.toBe(s1.reflectCursor);
    expect(lines.some((l) => l.includes("[rfail] reflect pass failed 3 times"))).toBe(true);
  });

  it("isn't due while offline or turned off, and sets no cursor while off; runs on the agent's reflectModel when it has one", async () => {
    await rt.create("roff");
    await tell("roff", "Your job is testing.");
    await updateState("roff", { compactedSinceReflect: true, reflectCursor: undefined as any });
    const trigger = async () => (rt as any).reflectTrigger(await loadAgent("roff"), new Date());
    await rt.setAgentSettings("roff", { reflect: false });
    expect((await loadAgent("roff")).settings.reflect).toBe(false);
    expect(await trigger()).toBeNull();
    expect((await loadAgent("roff")).state.reflectCursor).toBeUndefined();
    await rt.setAgentSettings("roff", { reflect: true });
    expect((await loadAgent("roff")).settings.reflect).toBeUndefined();
    (rt as any).offlineSince = new Date().toISOString();
    try {
      expect(await trigger()).toBeNull();
    } finally {
      (rt as any).offlineSince = null;
    }
    expect(await trigger()).toMatch(/its session was compacted/);
    // Its own model for reflect passes, kept in its settings like the others.
    await rt.setAgentSettings("roff", { reflectModel: "small-model" });
    expect(readFileSync(join(paths.agent("roff"), "AGENT.md"), "utf8")).toContain("reflectModel: small-model");
    await (rt as any).reflect("roff", "test", new AbortController());
    expect(readFileSync(join(notes, "reflect-seen-roff.txt"), "utf8").split("\n")[2]).toBe("model: small-model");
  });

  it("keeps a helper's first result when it was sent back for learned lines and never called done again", async () => {
    await tell("rem", "SPAWN_DONE_ONCE");
    const h = await until(async () => (await rt.store("rem").helpers()).find((x) => x.task.startsWith("DONE_ONCE") && x.status !== "running"), 60_000, "helper done");
    expect(h.result).toBe(`wrote ${join(h.workdir, "result.txt")}`);
  });

  it("holds a pass's inferred patterns to their bounds, and marks facts that can change and haven't been checked as possibly stale", async () => {
    await rt.create("rpat");
    await tell("rpat", "Your job is testing.");
    await tell("rpat", "REFLECT_INFER the person rejected another tall layout");
    await (rt as any).reflect("rpat", "test", new AbortController());
    const dir = join(paths.agent("rpat"), "memory");
    expect(existsSync(join(dir, "pattern-good.md"))).toBe(true);
    expect(readFileSync(join(dir, "pattern-good.md"), "utf8")).toContain("unconfirmed: true");
    expect(existsSync(join(dir, "pattern-thin.md"))).toBe(false);
    expect(lines.some((l) => l.includes("[rpat] reflect pass inferred a pattern in pattern-thin.md with only 1 supporting memories and runs; removed it"))).toBe(true);
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(index).toContain("- [Tall layouts](pattern-good.md) — avoid designs that use vertical space (unconfirmed)");
    expect(index).not.toContain("pattern-thin.md");
    // A fact that can change, last checked long ago: the next turn sees it marked.
    writeFileSync(join(dir, "release.md"), "---\ntype: project\nsource: observed\ncan-change: true\ndate: 2026-01-01\nlast-verified: 2026-01-01\n---\n\n0.5 is the current release.\n");
    writeFileSync(join(dir, "MEMORY.md"), `${readFileSync(join(dir, "MEMORY.md"), "utf8")}- [Release](release.md) — 0.5 is the current release\n`);
    await tell("rpat", "What's the release?");
    expect(prompts("rpat").at(-1)).toContain("- [Release](release.md) — 0.5 is the current release (possibly stale: last verified 2026-01-01)");
  });

  it("lets a helper read the agent's memory but not write it, and asks it to report what it learned", async () => {
    await tell("rem", "SPAWN_MEMWRITE");
    const h = await until(async () => (await rt.store("rem").helpers()).find((x) => x.task.startsWith("WRITE_PARENT_MEMORY") && x.status !== "running"), 60_000, "helper done");
    const got = readFileSync(join(h.workdir, ".parent-memory"), "utf8");
    expect(got).toContain("read:- [Phone first](phone.md)");
    if (sandboxAvailable().ok) {
      expect(got).toContain("denied");
      expect(existsSync(join(paths.agent("rem"), "memory", "from-helper.md"))).toBe(false);
    }
    // A helper of an agent whose workspace is its folder (not a git repository) gets a copy.
    expect(h.branch).toBeUndefined();
    expect(existsSync(join(h.workdir, "notes"))).toBe(true);
    const run = readdirSync(join(paths.meta("rem"), "runs")).find((f) => f.startsWith("helper_"))!;
    // It's told to end with learned lines, and a result without them is sent back once for them.
    expect(readFileSync(join(paths.meta("rem"), "runs", run), "utf8")).toContain('ending with your learned lines');
    expect(h.result).toMatch(/\n\nlearned: nothing new$/);
    expect(readdirSync(notes).some((f) => f.startsWith("learned-asked-"))).toBe(true);
  });
});
