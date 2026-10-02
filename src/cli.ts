import { homedir } from "node:os";
import { DaemonClient, ensureDaemon } from "./daemon/client.js";
import type { AgentSummary } from "./daemon/control.js";
import { validateName } from "./agent/agent.js";
import { accent, ago, bold, clean, cleanDeep, fit, friendly, gray, green, money, red, stamp, statusParts, yellow } from "./tui/style.js";
import { headed, humanBytes, openQuestion, type AgentSettingsView, type Message } from "./tui/types.js";

const [, , cmd, ...rest] = process.argv;

// ---------- output ----------

/** Styling only when a person is looking at a terminal; plain text for pipes and files. */
const tty = !!process.stdout.isTTY;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");
const print = (s = "") => console.log(tty ? s : strip(s));
const ok = (s: string) => print(`${green("✓")} ${s}`);
const cmdText = (s: string) => accent(s);

function fail(msg: string, hint?: string): never {
  const err = (s: string) => (process.stderr.isTTY ? s : strip(s));
  console.error(err(`${red("✗")} ${msg}`));
  if (hint) console.error(err(`  ${gray(hint)}`));
  process.exit(1);
}

/** A table whose columns size to their contents; the last column takes what's left of the width. */
function table(rows: string[][], head?: string[]): void {
  const all = head ? [head, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? "").length)));
  const total = process.stdout.columns || 120;
  const line = (r: string[]) =>
    r
      .map((c, i) => {
        if (i === r.length - 1) {
          const used = widths.slice(0, i).reduce((a, b) => a + b + 2, 0);
          return tty ? fit(c, Math.max(10, total - used - 1)).trimEnd() : c;
        }
        return c + " ".repeat(Math.max(0, widths[i] - strip(c).length));
      })
      .join("  ");
  if (head) print(gray(line(head.map((h) => h.toUpperCase()))));
  for (const r of rows) print(line(r));
}

function HELP(): string {
  const sections: [string, [string, string][]][] = [
    ["Start here", [["overtime", "open the live app"]]],
    [
      "Agents",
      [
        ["overtime new <name>", "create an agent; it starts with no job"],
        ["overtime ls", "list your agents"],
        ['overtime send <name> "<message>"', "message an agent  (--attach <file>, repeatable)"],
        ["overtime messages <name>", "read your messages with an agent"],
        ["overtime answer <name> <n> [note]", "answer its open question with option n"],
        ["overtime stop|start|wake <name>", "stop it, start it again, or wake it now"],
        ["overtime settings <name>", "show its backend, model, budgets and workspace"],
        ["overtime set <name> key=value…", "backend=  model=  budget=  tokens=  workspace="],
        ["overtime models [backend]", "the models a backend offers"],
        ["overtime archive <name>", "stop an agent for good and move its folder away"],
      ],
    ],
    [
      "Background process",
      [
        ["overtime daemon", "run it in the foreground"],
        ["overtime daemon stop", "stop it (agents carry on when it starts again)"],
        ["overtime daemon install", "start it when you log in"],
        ["overtime daemon uninstall", "stop starting it at login"],
      ],
    ],
    ["Editors", [["overtime acp", "speak ACP on stdio, for Zed, JetBrains, VS Code"]]],
  ];
  const width = Math.max(...sections.flatMap(([, rows]) => rows.map(([c]) => c.length))) + 3;
  const styleCmd = (c: string) => {
    const m = /^(overtime(?: [a-z|]+)?)(.*)$/.exec(c)!;
    return accent(m[1]) + m[2].replace(/(<[^>]+>|\[[^\]]+\]|key=value…)/g, (x) => gray(x));
  };
  const out = [`${accent("◆")} ${bold("overtime")} ${gray("· agents that exist, not sessions")}`];
  for (const [title, rows] of sections) {
    out.push("", gray(title));
    for (const [c, d] of rows) out.push(`  ${styleCmd(c)}${" ".repeat(width - c.length)}${d}`);
  }
  return out.join("\n");
}

async function confirm(q: string, dflt: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return dflt;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} ${gray(dflt ? "(Y/n)" : "(y/N)")} `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith("y") : dflt;
}

/** Asked once, the first time the app is opened in a terminal: keep agents running across restarts? */
async function maybeAskAutostart(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const { loadSettings, saveSettings } = await import("./settings.js");
  const s = await loadSettings();
  if (s.autostartAsked) return;
  const { autostartSupported, autostartInstalled, installAutostart } = await import("./daemon/install.js");
  if (!autostartSupported() || autostartInstalled()) return;
  print();
  print(`  ${accent("◆")} ${bold("Welcome to Overtime")}`);
  print();
  print("  Your agents live in a small background process, so they keep");
  print("  working after you close this window.");
  print();
  const yes = await confirm(`  ${bold("Start it automatically when you log in?")}`, true);
  await saveSettings({ ...s, autostartAsked: true });
  if (yes) {
    try {
      await installAutostart();
      print(`  ${green("✓")} Done. Turn it off any time with ${cmdText("overtime daemon uninstall")}${gray(".")}`);
    } catch (e) {
      print(`  ${yellow("!")} Couldn't set that up (${friendly(e)}). Overtime still runs until you log out.`);
    }
  } else {
    print(`  ${gray("Okay. It runs until you log out. Turn it on later with")} ${cmdText("overtime daemon install")}${gray(".")}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

// ---------- formatting ----------

function agentRow(a: AgentSummary): string[] {
  const p = statusParts(a);
  const unread = a.unread && !a.waiting ? " " + accent(`${a.unread} new`) : "";
  const name = bold(a.name) + (a.waiting ? " " + yellow(`${a.waiting} need${a.waiting === 1 ? "s" : ""} you`) : unread);
  const state = p.color(`${p.dot} ${p.word}`) + (p.detail ? gray(` · ${p.detail}`) : "");
  const doing = a.activity && !/^(paused|stopped|waiting for its job|resting|resuming)/.test(a.activity) ? a.activity : "";
  return [name, state, gray(money(a)), doing || gray("—")];
}

/** One message as plain lines, in the same voice as the app: yours marked with a bar, questions as cards. */
function printMessage(name: string, m: Message, open: boolean): void {
  const time = gray(stamp(m.t));
  if (m.from === "you") {
    print(`${accent("┃")} ${bold("You")}  ${time}${m.replyTo ? gray("  answered") : ""}`);
    for (const l of (m.text || "").split("\n")) if (m.text) print(`${accent("┃")} ${l}`);
    for (const a of m.attachments ?? []) print(`${accent("┃")} ${attachmentLine(a)}`);
    print();
    return;
  }
  if (m.kind === "question") {
    const bar = open ? yellow("┃") : gray("┃");
    const h = headed(m, "A question");
    print(`${bar} ${open ? yellow(bold("?")) : gray("?")} ${bold(h.title)}  ${time}`);
    if (h.body) for (const l of h.body.split("\n")) print(`${bar} ${l}`);
    if (m.why) print(`${bar} ${gray(`Why it matters: ${m.why}`)}`);
    if (m.recommendation) print(`${bar} ${bold("Recommended:")} ${m.recommendation}`);
    m.options?.forEach((o, i) => print(`${bar}  ${open ? accent(bold(String(i + 1))) : m.answer?.choice === i + 1 ? accent("✓") : gray(String(i + 1))}  ${m.answer && m.answer.choice !== i + 1 ? gray(o) : o}`));
    if (m.answer && !m.answer.choice) print(`${bar} ${gray(`You: ${m.answer.text}`)}`);
    for (const l of m.links ?? []) print(`${bar} ${accent("↗")} ${l.target}`);
    print();
    return;
  }
  if (m.kind === "alert") {
    const h = headed(m, "Something went wrong");
    print(`${red("┃")} ${red(bold(h.title))}  ${time}`);
    if (h.body) for (const l of h.body.split("\n")) print(`${red("┃")} ${l}`);
    print();
    return;
  }
  print(`${m.from === "agent" ? accent(bold(name)) : gray(bold("Overtime"))}  ${time}`);
  if (m.kind === "report" && m.title) print(`  ${accent("▣")} ${bold(m.title)}`);
  const text = m.kind === "report" && m.title && m.text.startsWith(m.title) ? m.text.slice(m.title.length).trim() : m.text;
  for (const l of text.split("\n")) if (text) print(`  ${m.from === "overtime" ? gray(l) : l}`);
  for (const l of m.links ?? []) print(`  ${accent("↗")} ${l.target}`);
  for (const a of m.attachments ?? []) print(`  ${attachmentLine(a)}`);
  print();
}

function attachmentLine(a: NonNullable<Message["attachments"]>[number]): string {
  const icon = a.kind === "image" ? "🖼" : a.kind === "folder" ? "🗀" : "📎";
  return `${icon} ${a.name}${a.bytes != null ? gray(`  ${humanBytes(a.bytes)}`) : ""}  ${gray(a.path)}`;
}

/** key=value arguments, with friendly names for the settings people change most. */
function parseSettings(args: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) {
    const m = /^([a-zA-Z]+)=(.*)$/.exec(a);
    if (!m) fail(`Couldn't read "${a}".`, "Use key=value, e.g. overtime set scout model=opus budget=20");
    const [, k, v] = m;
    if (k === "backend") out.backend = v;
    else if (k === "model") out.model = v === "" || v === "default" ? null : v;
    else if (k === "budget" || k === "dailyBudgetUsd") {
      const n = Number(v.replace(/^\$/, ""));
      if (!Number.isFinite(n) || n < 0) fail(`"${v}" isn't a budget.`, "Give dollars per day, e.g. budget=20");
      out.dailyBudgetUsd = n;
    } else if (k === "tokens" || k === "dailyTokenBudget") {
      if (v === "" || /^(none|off)$/i.test(v)) out.dailyTokenBudget = null;
      else {
        const m = /^([\d.]+)([km])?$/i.exec(v.replace(/[,_]/g, ""));
        const n = m ? Number(m[1]) * (m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1) : NaN;
        if (!Number.isFinite(n) || n <= 0) fail(`"${v}" isn't a token budget.`, "e.g. tokens=500k, or tokens=none");
        out.dailyTokenBudget = Math.round(n);
      }
    } else if (k === "workspace") {
      if (v === "" || v === "default") out.workspace = null;
      else {
        const p = v === "~" || v.startsWith("~/") ? homedir() + v.slice(1) : v;
        if (!p.startsWith("/")) fail(`"${v}" isn't a full path.`, "e.g. workspace=~/code/my-repo");
        out.workspace = p;
      }
    } else fail(`There's no setting "${k}".`, "You can set backend, model, budget, tokens and workspace.");
  }
  if (!Object.keys(out).length) fail("Nothing to change.", "e.g. overtime set scout backend=codex model=default budget=20");
  return out;
}

// ---------- commands ----------

const KNOWN = ["new", "ls", "list", "send", "messages", "answer", "settings", "stop", "start", "wake", "set", "models", "archive"];

async function main() {
  if (!cmd) {
    await maybeAskAutostart();
    const { runApp } = await import("./tui/app.js");
    await runApp();
    return;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return void print(HELP());
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const { readFileSync } = await import("node:fs");
    return void print(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  }
  if (cmd === "acp") {
    // For editors: speak ACP on stdio. Nothing else may be printed to stdout here.
    const { runAcpServer } = await import("./acp/server.js");
    await runAcpServer();
    return;
  }
  if (cmd === "daemon") {
    if (rest[0] === "install") {
      const { installAutostart, autostartDescription } = await import("./daemon/install.js");
      print(autostartDescription());
      if (!(await confirm(bold("Install it?"), false))) return void print(gray("Nothing installed."));
      await installAutostart();
      return void ok("Installed. Overtime will start when you log in.");
    }
    if (rest[0] === "uninstall") {
      const { uninstallAutostart } = await import("./daemon/install.js");
      await uninstallAutostart();
      return void ok("Removed. Overtime no longer starts at login; your agents keep their folders.");
    }
    if (rest[0] === "stop") {
      try {
        const c = await DaemonClient.connect();
        await c.call("shutdown");
        c.close();
        ok("Stopped the background process. Agents carry on when it starts again.");
      } catch {
        print(gray("The background process isn't running."));
      }
      return;
    }
    if (rest[0]) fail(`There's no daemon command "${rest[0]}".`, "Use: overtime daemon [stop|install|uninstall]");
    await import("./daemon/main.js");
    return;
  }
  if (!KNOWN.includes(cmd)) fail(`There's no command "${cmd}".`, "See all commands with: overtime help");

  const c = await ensureDaemon();
  const call = async <T = any>(m: string, p: Record<string, unknown> = {}, timeout?: number): Promise<T> => cleanDeep(await c.call<T>(m, p, timeout));
  const need = (v: string | undefined, usage: string): string => v || fail("Missing an argument.", `Usage: ${usage}`);
  try {
    switch (cmd) {
      case "new": {
        const name = need(rest[0], "overtime new <name>");
        const err = validateName(name);
        if (err) fail(err);
        const r = await call("new", { name });
        ok(`Created ${bold(r.name)}. It has no job yet; tell it what it's for:`);
        print(`  ${cmdText(`overtime send ${r.name} "…"`)}  ${gray("or open the app:")} ${cmdText("overtime")}`);
        break;
      }
      case "ls":
      case "list": {
        const agents: AgentSummary[] = await call("agents");
        if (!agents.length) {
          print(gray("No agents yet. Create one with ") + cmdText("overtime new <name>"));
          break;
        }
        table(agents.map(agentRow), ["agent", "status", "today", "doing"]);
        break;
      }
      case "send": {
        const [name, ...args] = rest;
        const attach: string[] = [];
        const words: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--attach" || args[i] === "-a") {
            const f = args[++i];
            if (!f) fail("--attach needs a file.", 'Usage: overtime send <name> "message" --attach <file>');
            attach.push(f);
          } else words.push(args[i]);
        }
        if (!name || (!words.length && !attach.length)) fail("Missing an argument.", 'Usage: overtime send <name> "message" [--attach <file>]…');
        const { resolve } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const files = attach.map((f) => resolve(f.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
        for (const f of files) if (!existsSync(f)) fail(`There's no file at ${f}.`);
        await call("send", files.length ? { name, text: words.join(" "), attachments: files } : { name, text: words.join(" ") });
        ok(`Sent to ${bold(name)}${files.length ? ` with ${files.length} file${files.length === 1 ? "" : "s"}` : ""}. ${gray(`Read the reply with: overtime messages ${name}`)}`);
        break;
      }
      case "messages": {
        const name = need(rest[0], "overtime messages <name>");
        const r = await call<{ messages: Message[]; hasMore: boolean }>("messages", { name, markRead: true, limit: Number(rest[1]) || 50 });
        const ms = r?.messages ?? [];
        if (!ms.length) {
          print(gray(`No messages with ${name} yet. Send one with: `) + cmdText(`overtime send ${name} "…"`));
          break;
        }
        if (r.hasMore) print(gray(`(showing the latest ${ms.length}; add a number for more: overtime messages ${name} 200)\n`));
        const q = openQuestion(ms);
        for (const m of ms) printMessage(name, m, m === q);
        if (q?.options?.length) print(gray(`Answer with: overtime answer ${name} <1-${q.options.length}> ["note"]`));
        break;
      }
      case "answer": {
        const [name, choice, ...words] = rest;
        if (!name || (!choice && !words.length)) fail("Missing an argument.", 'Usage: overtime answer <name> <option-number> ["note"]');
        const n = Number(choice);
        const params = Number.isInteger(n) && n > 0 ? { name, choice: n, text: words.join(" ") || undefined } : { name, text: [choice, ...words].join(" ") };
        await call("answer", params);
        ok("Answered.");
        break;
      }
      case "settings": {
        const name = need(rest[0], "overtime settings <name>");
        const s = await call<AgentSettingsView>("settings", { name });
        const row = (k: string, v: string, note = "") => print(`  ${gray(k.padEnd(14))}${v}${note ? gray(`   ${note}`) : ""}`);
        print(bold(name));
        row("backend", s.backend);
        row("model", s.model ?? "default", s.model ? "" : "the backend's own choice");
        row("budget", `$${s.dailyBudgetUsd} a day`, s.costReported ? `$${s.spentUsd.toFixed(2)} spent today` : "");
        row("tokens", s.dailyTokenBudget ? `${s.dailyTokenBudget.toLocaleString()} a day` : "no limit", `${s.tokensToday.toLocaleString()} used today`);
        row("workspace", s.workspace, s.workspaceIsDefault ? "its own folder" : "");
        print();
        print(gray("Change with: ") + cmdText(`overtime set ${name} budget=20 model=… workspace=~/code/…`));
        break;
      }
      case "stop":
      case "start":
      case "wake": {
        const name = need(rest[0], `overtime ${cmd} <name>`);
        await call(cmd, { name });
        ok(cmd === "stop" ? `Stopped ${bold(name)}. Start it again with ${cmdText(`overtime start ${name}`)}.` : cmd === "start" ? `Started ${bold(name)}.` : `Waking ${bold(name)} now.`);
        break;
      }
      case "set": {
        const name = need(rest[0], "overtime set <name> [backend=…] [model=…] [budget=…]");
        const changes = parseSettings(rest.slice(1));
        await call("set", { name, ...changes });
        const label: Record<string, string> = { dailyBudgetUsd: "budget", dailyTokenBudget: "tokens" };
        const said = Object.entries(changes).map(([k, v]) => `${label[k] ?? k} ${bold(v === null ? (k === "dailyTokenBudget" ? "no limit" : "default") : k === "dailyBudgetUsd" ? `$${v}/day` : k === "dailyTokenBudget" ? `${Number(v).toLocaleString()} a day` : String(v))}`);
        ok(`${bold(name)}: ${said.join(", ")}. ${gray("Applies from its next session.")}`);
        break;
      }
      case "models": {
        const backends: string[] = rest[0] ? [rest[0]] : await call("backends");
        for (const b of backends) {
          let models: { id: string; name: string }[] | null = null;
          try {
            models = await call("models", { backend: b }, 90_000);
          } catch (e) {
            print(`${bold(b)}  ${red(friendly(e))}`);
            print();
            continue;
          }
          print(bold(b));
          if (!models?.length) print(gray("  doesn't list its models; its default is used"));
          for (const m of models ?? []) print(`  ${fit(m.id, 26)}${m.name && m.name !== m.id ? gray(m.name) : ""}`);
          print();
        }
        print(gray("Choose one with: overtime set <name> backend=<backend> model=<id>"));
        break;
      }
      case "archive": {
        const name = need(rest[0], "overtime archive <name>");
        if (process.stdin.isTTY && !(await confirm(`Archive ${bold(name)}? It stops for good and its folder moves to the archive.`, false))) {
          print(gray("Nothing changed."));
          break;
        }
        const r = await call("archive", { name });
        ok(`Archived ${bold(name)}.${r?.dir ? ` Its folder is now ${clean(r.dir)}` : ""}`);
        break;
      }
    }
  } finally {
    c.close();
  }
}

main().catch((e) => fail(friendly(e)));
