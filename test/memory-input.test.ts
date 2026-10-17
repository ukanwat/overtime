import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome } from "./helpers.js";

fakeHome();
const log = await import("../src/agent/runlog.js");
const { inScope, OwnWrites, writeLayers } = await import("../src/runtime/write-scope.js");
const { seatbeltProfile, sandboxAvailable } = await import("../src/runtime/sandbox.js");
const { paths } = await import("../src/paths.js");
const mem = await import("../src/agent/memory.js");

/** A run log as Overtime writes one: a record per event, each with its time. */
function writeRun(agent: string, id: string, at: string, events: [string, unknown][]) {
  const dir = join(paths.meta(agent), "runs");
  mkdirSync(dir, { recursive: true });
  const t0 = Date.parse(at);
  writeFileSync(join(dir, `${id}.jsonl`), events.map(([event, data], i) => JSON.stringify({ t: new Date(t0 + i).toISOString(), event, data })).join("\n") + "\n");
}
const update = (u: unknown): [string, unknown] => ["update", u];
const prompt = (text: string): [string, unknown] => ["prompt", { text }];
const end: [string, unknown] = ["end", { stopReason: "end_turn" }];

describe("what a reflect pass reads of a turn", () => {
  it("has each step's command, file or message, failures with their error, and no boilerplate", () => {
    const text = [
      "You are x, a long-lived agent… (the session's opening)\n\n---\n\n# AGENT.md\n\n…",
      "Time now: 2026-10-16T21:30:00.000Z (Sat).\nWhy you are awake: the person sent you a message\nSpent today: $22.92 of $100.00 (as your backend reports it).\nYour skills (load with skill): install-local",
      "AGENT.md changed since your last turn. It now reads:\n\n# x\n\nLots of text.\n\n---\n\nYour inbox (1):\n\n1. Message from the person — 2026-10-16T21:29:00Z\nPublish 0.7.0 to npm.\n\nReply with send to new messages from the person (not to ones passed on…). Do the work.",
    ].join("\n\n");
    const run = [
      prompt(text),
      update({ sessionUpdate: "tool_call", toolCallId: "a", title: "Terminal", kind: "execute", status: "pending", rawInput: {}, _meta: { claudeCode: { toolName: "Bash" } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "a", rawInput: { command: "npm login --auth-type=web" }, _meta: { claudeCode: { toolName: "Bash" } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "a", rawInput: { command: "npm login --auth-type=web", description: "Sign in" }, _meta: { claudeCode: { toolName: "Bash" } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed", content: [{ type: "content", content: { type: "text", text: "npm error code E401\nnpm error Unable to authenticate" } }], _meta: { claudeCode: { toolName: "Bash" } } }),
      update({ sessionUpdate: "tool_call", toolCallId: "b", title: "Edit", kind: "edit", rawInput: { file_path: "/a/skills/install-local/SKILL.md", old_string: "x", new_string: "script -q /dev/null npm publish" }, _meta: { claudeCode: { toolName: "Edit" } } }),
      update({ sessionUpdate: "tool_call", toolCallId: "c", title: "mcp__overtime__send", kind: "other", rawInput: {}, _meta: { claudeCode: { toolName: "mcp__overtime__send" } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c", rawInput: { text: "Approve the sign-in in Chrome, then press a key." }, _meta: { claudeCode: { toolName: "mcp__overtime__send" } } }),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Asked them " } }),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "to approve it." } }),
      end,
    ];
    const t = log.parseRun("main_20261016213000_abcdef", run.map(([event, data], i) => JSON.stringify({ t: new Date(1e12 + i).toISOString(), event, data })).join("\n"))!;
    expect(t.told).toBe("Why you are awake: the person sent you a message\n\n(AGENT.md had changed since its last turn.)\n\nYour inbox (1):\n\n1. Message from the person — 2026-10-16T21:29:00Z\nPublish 0.7.0 to npm.");
    expect(t.steps).toEqual([
      "Bash: npm login --auth-type=web (failed: npm error code E401 npm error Unable to authenticate)",
      "Edit /a/skills/install-local/SKILL.md: script -q /dev/null npm publish",
      "send: Approve the sign-in in Chrome, then press a key.",
    ]);
    expect(t.said).toBe("Asked them to approve it.");
    expect(t.ended).toBe(true);
    expect(log.renderTurn(t, { ids: true })).toMatch(/^## Turn at 2026-10-16 21:30 UTC \(run main_20261016213000_abcdef\)\n\nIt was told:\n/);
  });

  it("puts a log written out of order back in order", () => {
    const lines = [
      { t: "2026-10-16T21:30:00.003Z", event: "update", data: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } } },
      { t: "2026-10-16T21:30:00.001Z", event: "update", data: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
    ];
    expect(log.parseRun("main_20261016213000_aaaaaa", lines.map((l) => JSON.stringify(l)).join("\n"))!.said).toBe("hello world");
  });

  it("takes helpers' learned lines, with the helper they came from, and never cuts them", () => {
    const result = `1. Helper result — 2026-10-16T22:00:00Z\nFinished (helper_20261016215000_9f8e7d): publish\n\n${"Long report. ".repeat(800)}\n\nlearned: npm needs \`npm login --auth-type=web\` and the person's Chrome key\nlearned: nothing new\n\n2. Helper result — 2026-10-16T22:01:00Z\nFinished (helper_20261016215500_123abc): check\n\nlearned:\n- python is missing; use /usr/bin/python3\n- the tests take 3 minutes`;
    expect(log.learnedLines(result)).toEqual([
      "npm needs `npm login --auth-type=web` and the person's Chrome key (from helper_20261016215000_9f8e7d)",
      "python is missing; use /usr/bin/python3 (from helper_20261016215500_123abc)",
      "the tests take 3 minutes (from helper_20261016215500_123abc)",
    ]);
  });
});

describe("reading history from a cursor", () => {
  it("reads every turn once, oldest first, in chunks, across passes, and waits for one still going", async () => {
    const a = "hist";
    const big = "x".repeat(3000);
    // Ids only go to the second: two turns in the same second, with the later one's id sorting first.
    writeRun(a, "main_20261016100000_ffffff", "2026-10-16T10:00:00.100Z", [prompt(`Time now: x\nWhy you are awake: one\n\n${big}`), end]);
    writeRun(a, "main_20261016100000_000000", "2026-10-16T10:00:00.900Z", [prompt(`Time now: x\nWhy you are awake: two\n\n${big}`), end]);
    writeRun(a, "chat_20261016100500_aaaaaa", "2026-10-16T10:05:00.000Z", [prompt(`Time now: x\nWhy you are awake: a chat\n\n${big}`), end]);
    writeRun(a, "helper_20261016100600_aaaaaa", "2026-10-16T10:06:00.000Z", [prompt("a helper's own run: not read"), end]);
    writeRun(a, "main_20261016101000_bbbbbb", "2026-10-16T10:10:00.000Z", [prompt(`Time now: x\nWhy you are awake: three\n\n${big}`), end]);
    expect(await log.runIds(a)).toEqual(["main_20261016100000_ffffff", "main_20261016100000_000000", "chat_20261016100500_aaaaaa", "main_20261016101000_bbbbbb"]);
    const v = await log.unreadVolume(a, null);
    expect(v.turns).toBe(4);
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let pass = 0; pass < 10; pass++) {
      const c = await log.unreadChunk(a, cursor, 7000);
      if (!c.turns.length) break;
      expect(c.turns.length).toBeLessThanOrEqual(2);
      seen.push(...c.turns.map((t) => /awake: (\w+(?: \w+)?)/.exec(t.told)![1]));
      cursor = c.last;
    }
    expect(seen).toEqual(["one", "two", "a chat", "three"]);
    expect((await log.unreadVolume(a, cursor)).turns).toBe(0);
    // A run still being written isn't read, nor anything after it, until it ends.
    writeRun(a, "main_20261016102000_cccccc", new Date().toISOString(), [prompt("Time now: x\nWhy you are awake: four")]);
    writeRun(a, "main_20261016103000_dddddd", new Date(Date.now() + 1000).toISOString(), [prompt("Time now: x\nWhy you are awake: five"), end]);
    expect((await log.unreadChunk(a, cursor, 7000)).turns).toHaveLength(0);
    writeRun(a, "main_20261016102000_cccccc", new Date().toISOString(), [prompt("Time now: x\nWhy you are awake: four"), end]);
    expect((await log.unreadChunk(a, cursor, 7000)).turns.map((t) => t.id)).toEqual(["main_20261016102000_cccccc", "main_20261016103000_dddddd"]);
  });
});

describe("a session that may change only memory/", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "overtime-scope-")));
  const agentDir = join(root, "agent");
  const memory = join(agentDir, "memory");
  mkdirSync(memory, { recursive: true });
  const req = (toolCall: any) => ({ sessionId: "s", toolCall, options: [] }) as any;

  it("is refused edits outside it, and every command, when the backend asks", () => {
    expect(inScope(req({ kind: "edit", locations: [{ path: join(memory, "a.md") }], rawInput: { file_path: join(memory, "a.md") } }), [memory], agentDir).allowed).toBe(true);
    expect(inScope(req({ kind: "edit", rawInput: { file_path: "memory/b.md" } }), [memory], agentDir).allowed).toBe(true);
    expect(inScope(req({ kind: "edit", locations: [{ path: join(agentDir, "AGENT.md") }] }), [memory], agentDir).allowed).toBe(false);
    expect(inScope(req({ kind: "edit", rawInput: { file_path: join(agentDir, "skills", "x", "SKILL.md") } }), [memory], agentDir).allowed).toBe(false);
    expect(inScope(req({ kind: "edit", rawInput: { file_path: join(memory, "..", "INDEX.md") } }), [memory], agentDir).allowed).toBe(false);
    expect(inScope(req({ kind: "delete", locations: [{ path: join(root, "elsewhere") }] }), [memory], agentDir).allowed).toBe(false);
    expect(inScope(req({ kind: "execute", rawInput: { command: "echo > memory/x" } }), [memory], agentDir).allowed).toBe(false);
    expect(inScope(req({ kind: "fetch", rawInput: { url: "https://example.com" } }), [memory], agentDir).allowed).toBe(false);
    expect(inScope(req({ kind: "read", locations: [{ path: join(agentDir, "AGENT.md") }] }), [memory], agentDir).allowed).toBe(true);
    // A file-writing tool by name, whatever kind it says it is.
    expect(inScope(req({ title: "Write", kind: "other", rawInput: { file_path: join(agentDir, "AGENT.md") }, _meta: { claudeCode: { toolName: "Write" } } }), [memory], agentDir).allowed).toBe(false);
  });

  it("has what its own tools changed outside it put back, but never someone else's edit", async () => {
    const mine = join(agentDir, "INDEX.md");
    const theirs = join(agentDir, "AGENT.md");
    const created = join(agentDir, "new.txt");
    writeFileSync(mine, "index\n");
    writeFileSync(theirs, "agent\n");
    const own = new OwnWrites([memory], agentDir);
    const call = (id: string, path: string, status?: string) => own.see({ sessionUpdate: status ? "tool_call_update" : "tool_call", toolCallId: id, kind: "edit", status, locations: [{ path }] });
    call("1", mine);
    writeFileSync(mine, "index, rewritten by the pass\n");
    call("1", mine, "completed");
    call("2", theirs);
    writeFileSync(theirs, "agent, edited by the pass\n");
    call("2", theirs, "completed");
    // The person edits AGENT.md after the pass's own write: theirs now, kept.
    writeFileSync(theirs, "agent, the person's edit\n");
    call("3", created);
    writeFileSync(created, "x");
    call("3", created, "completed");
    // A memory edit is the pass's job: left alone.
    call("4", join(memory, "m.md"));
    writeFileSync(join(memory, "m.md"), "m");
    call("4", join(memory, "m.md"), "completed");
    // A file it never touched that changed meanwhile (the person's): not its business.
    writeFileSync(join(agentDir, "notes.md"), "the person's\n");
    const r = await own.undo();
    expect(r.restored.sort()).toEqual([mine, created].sort());
    expect(r.kept).toEqual([theirs]);
    expect(readFileSync(mine, "utf8")).toBe("index\n");
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(theirs, "utf8")).toBe("agent, the person's edit\n");
    expect(readFileSync(join(memory, "m.md"), "utf8")).toBe("m");
    expect(readFileSync(join(agentDir, "notes.md"), "utf8")).toBe("the person's\n");
  });

  it.runIf(process.platform === "darwin" && sandboxAvailable().ok)("can write only in memory/ (and the backend's own folders) under the sandbox", () => {
    const ws = join(root, "workspace");
    mkdirSync(ws, { recursive: true });
    const profile = seatbeltProfile([], [], writeLayers([memory], { overtimeHome: root, agentDir, workspace: ws }));
    const tryWrite = (p: string) => {
      try {
        execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", `echo x > "${p}"`], { stdio: "pipe" });
        return "written";
      } catch {
        return "denied";
      }
    };
    expect(tryWrite(join(memory, "ok.md"))).toBe("written");
    expect(tryWrite(join(agentDir, "AGENT.md"))).toBe("denied");
    expect(tryWrite(join(ws, "file"))).toBe("denied");
    expect(tryWrite(join(root, "settings.json"))).toBe("denied");
    expect(tryWrite(join(tmpdir(), `overtime-scope-tmp-${process.pid}`))).toBe("written");
  });
});

describe("helpers' Claude memories", () => {
  it("come in under the helper's id, once, leaving out what the agent already has", async () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "overtime-claude-"));
    const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "overtime-hmem-")));
    mkdirSync(join(agentDir, "memory"));
    writeFileSync(join(agentDir, "memory", "MEMORY.md"), "- [Mine](mine.md) — mine\n");
    writeFileSync(join(agentDir, "memory", "mine.md"), "---\ntype: feedback\n---\n\nAlready known.\n");
    const helperDir = join(agentDir, ".overtime", "helpers", "helper_20261006192445_82e407", "work");
    const src = mem.claudeMemoryDir(helperDir);
    expect(src).toContain(`--overtime-helpers-helper-20261006192445-82e407-work`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "MEMORY.md"), "- [Python](python.md) — use /usr/bin/python3\n- [Dup](dup.md) — already known\n");
    writeFileSync(join(src, "python.md"), "---\nname: python\nmetadata:\n  type: reference\n---\n\nUse /usr/bin/python3.\n");
    writeFileSync(join(src, "dup.md"), "---\nname: dup\n---\n\nAlready known.\n");
    const r = await mem.importHelperClaudeMemory(agentDir);
    expect(r.files).toBe(1);
    expect(readFileSync(join(agentDir, "memory", "helper-82e407-python.md"), "utf8")).toMatch(/type: reference\nsource: observed/);
    expect(existsSync(join(agentDir, "memory", "helper-82e407-dup.md"))).toBe(false);
    expect(readFileSync(join(agentDir, "memory", "MEMORY.md"), "utf8")).toBe("- [Mine](mine.md) — mine\n- [Python](helper-82e407-python.md) — use /usr/bin/python3\n");
    expect((await mem.importHelperClaudeMemory(agentDir)).files).toBe(0);
  });
});
