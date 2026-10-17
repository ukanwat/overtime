// The README's hero: a whole team of agents shipping two features in an afternoon, drawn by the real app.
// It's scripted: the agents, their messages and the timeline below are made up (a fictional product,
// Lumen), fed to the app through the same fake daemon the tests use, so it runs no model and costs nothing.
// team.tape drives it like a person would: one message to pm, a look at a few agents, one answer.
//
//   npx tsx docs/demos/team/team.ts          Ctrl+C to quit
//
// It waits for you at two points: until you message pm (anything), and until you answer release's question.
import { runApp } from "../../../src/tui/app.js";
import { FakeClient, fakeData } from "../../../test/tui-fake.js";

const home = "/Users/you/overtime/agents";
const NAMES = ["pm", "backend", "frontend", "qa", "reviewer", "on-call", "release"] as const;
type Name = (typeof NAMES)[number];

// Story time runs faster than the clock, so the afternoon's messages aren't all stamped the same minute.
const SPEED = 20;
let kickoff = 0;
const storyNow = () => new Date(kickoff ? kickoff + (Date.now() - kickoff) * SPEED : Date.now()).toISOString();
const tomorrowAt = (h: number) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};
const yesterdayAt = (h: number, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const base = fakeData();
const summary = (name: Name, o: any) => ({ ...base.agents[0], name, status: "asleep", activity: "", ownStatus: "", waiting: 0, unread: 0, helpersRunning: 0, spentUsd: 0, budgetUsd: 20, model: null, lastError: null, nextWake: null, dir: `${home}/${name}`, ...o });
const d: any = {
  agents: [
    summary("pm", { ownStatus: "next: dark mode + export", nextWake: tomorrowAt(9), spentUsd: 0.84 }),
    summary("backend", { ownStatus: "api green; nothing open", nextWake: tomorrowAt(9), spentUsd: 1.12 }),
    summary("frontend", { ownStatus: "web green; nothing open", nextWake: tomorrowAt(9), spentUsd: 0.97 }),
    summary("qa", { ownStatus: "1,206 tests green on main", nextWake: tomorrowAt(7), spentUsd: 0.41 }),
    summary("reviewer", { ownStatus: "no PRs waiting", nextWake: tomorrowAt(9), spentUsd: 0.33 }),
    summary("on-call", { ownStatus: "prod quiet: 5xx 0.02%", nextWake: tomorrowAt(6), spentUsd: 0.12 }),
    summary("release", { ownStatus: "4.1.3 live; 4.2 not cut", nextWake: tomorrowAt(10), spentUsd: 0.2 }),
  ],
  messages: Object.fromEntries(NAMES.map((n) => [n, [] as any[]])),
  settings: {} as Record<string, any>,
  mcp: base.mcp,
};
for (const a of d.agents) d.settings[a.name] = { ...base.settings["repo-keeper"], dailyBudgetUsd: a.budgetUsd, workspace: `${home}/${a.name}`, spentUsd: a.spentUsd };

// Yesterday's wrap-up, so pm's conversation opens mid-project rather than empty.
d.messages.pm.push({
  id: "y1",
  t: yesterdayAt(18, 40),
  from: "agent",
  kind: "report",
  title: "Lumen 4.1.3 is out",
  text: "Lumen 4.1.3 is out\n3 PRs merged, CI green, no incidents. Next up on the roadmap: **dark mode** and the **billing export** customers keep asking for.",
});
d.messages["on-call"].push({ id: "y2", t: yesterdayAt(22, 5), from: "agent", kind: "message", text: "Quiet night so far. I'm watching `api` 5xx and p95 on prod; I wake only if one of them moves." });

const agent = (name: Name) => d.agents.find((a: any) => a.name === name)!;
let seq = 0;
const push = (name: Name, m: any) => d.messages[name].push({ id: `s${++seq}`, t: storyNow(), from: "agent", kind: "message", ...m });

class TeamClient extends FakeClient {
  async call(method: string, params: any = {}): Promise<any> {
    // Reading a conversation reads its new messages, as with the real daemon.
    if (method === "messages" && params.markRead) {
      const a = d.agents.find((x: any) => x.name === params.name);
      if (a?.unread) {
        a.unread = 0;
        // The list was read before this; draw it again without the count.
        setTimeout(() => this.emit({ event: "agents" }), 50);
      }
    }
    if (method === "skills") return [];
    if (method === "agent") return { schedule: { wakeAt: agent(params.name as Name)?.nextWake, wakeReason: "", loops: [] }, monitors: [], helpers: [] };
    const r = await super.call(method, params);
    // Your answer shows in the conversation under the question, as the daemon writes it.
    if (method === "answer" && params.choice) {
      const q = d.messages[params.name].find((m: any) => m.id === params.questionId);
      d.messages[params.name].push({ id: `a${++seq}`, t: storyNow(), from: "you", kind: "message", text: q.options[params.choice - 1], replyTo: q.id });
    }
    return r;
  }
}

process.env.OVERTIME_NO_NOTIFY = "1";
const client = new TeamClient(d);
await runApp({ client: client as any, onQuit: () => process.exit(0) });

const changed = () => client.emit({ event: "agents" });
const started: Record<string, string> = {};
const step = (name: Name, text: string | null) => {
  if (text === null) {
    if (started[name]) client.emit({ event: "live", agent: name, kind: "main", text: "", step: null, startedAt: started[name], done: true });
    delete started[name];
    return;
  }
  started[name] ??= new Date().toISOString();
  client.emit({ event: "live", agent: name, kind: "main", text: "", step: text, startedAt: started[name] });
};

/** An agent starts a turn: working, with what it says it's on and how many helpers it has out. */
const work = (name: Name, ownStatus: string, s: string, helpers = 0) => {
  Object.assign(agent(name), { status: "working", ownStatus, helpersRunning: helpers });
  step(name, s);
};
/** Its own session hands the work to helpers and waits: the agent shows as working, with how many. */
const delegate = (name: Name, ownStatus: string, helpers: number) => {
  Object.assign(agent(name), { status: "asleep", ownStatus, helpersRunning: helpers });
  step(name, null);
};
/** It finishes and goes back to sleep until its next wake. */
const rest = (name: Name, ownStatus: string, nextWake = tomorrowAt(9)) => {
  Object.assign(agent(name), { status: "asleep", ownStatus, helpersRunning: 0, nextWake });
  step(name, null);
};
/** One agent messages another: it shows in both their conversations. */
const tell = (from: Name, to: Name, text: string) => {
  const m = { id: `s${++seq}`, t: storyNow(), from: "agent", kind: "agent-message", fromAgent: from, toAgent: to, text };
  d.messages[from].push(m);
  d.messages[to].push({ ...m, id: `s${++seq}` });
};
const report = (name: Name, title: string, body: string) => {
  push(name, { kind: "report", title, text: `${title}\n${body}` });
  agent(name).unread += 1;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean) => {
  while (!ok()) await sleep(200);
};
let t0 = 0;
/** Wait until `s` seconds after the scene's start. */
const at = (s: number) => sleep(Math.max(0, t0 + s * 1000 - Date.now()));

// ---------- the person says one thing to pm ----------
await until(() => d.messages.pm.some((m: any) => m.from === "you"));
kickoff = t0 = Date.now();

// ---------- planning ----------
work("pm", "planning 4.2 for the team", "reading the roadmap and open issues");
changed();
await at(1.6);
step("pm", "splitting it into tasks");
await at(3.2);
push("pm", {
  text: "On it: both ship tonight. The plan:\n- **backend**: billing export, `POST /v2/billing/export`, CSV + Parquet\n- **frontend**: dark mode: theme tokens, 214 components, a Settings toggle\n- **qa** tests both; **reviewer** reviews every PR\n- **release** canaries it tonight; **on-call** watches prod meanwhile",
});
step("pm", "briefing the team");
changed();
await at(4.4);
tell("pm", "backend", "Billing export: streamed CSV + Parquet, scoped to `billing:read`. Tonight.");
work("backend", "billing export API", "reading src/billing/");
changed();
await at(5.2);
tell("pm", "frontend", "Dark mode: tokens in `theme/`, every component, a toggle that persists.");
work("frontend", "dark mode, 214 components", "mapping 1,180 hard-coded colours");
changed();
await at(6);
tell("pm", "qa", "Cover both: big exports in both formats; dark mode visual diffs.");
work("qa", "testing export + dark mode", "reading the export spec");
delegate("backend", "billing export API", 3);
changed();
await at(6.8);
delegate("frontend", "dark mode, 214 components", 3);
step("pm", "waiting on the team");
changed();
await at(7.6);
delegate("qa", "testing export + dark mode", 2);
changed();
await at(8.5);
rest("pm", "4.2 in flight: 6 on it", new Date(Date.now() + 40 * 60000).toISOString());
changed();

// ---------- work (the tape looks at qa about now) ----------
await at(12.5);
tell("backend", "reviewer", "PR #478 ready: billing export endpoint + streaming worker (+612 −40, 14 tests).");
work("reviewer", "reviewing #478", "reading #478: 11 files");
work("backend", "PR #478 open", "writing the Parquet writer", 1);
changed();
await at(14);
tell("frontend", "reviewer", "PR #479 ready: dark mode tokens + 214 components (+2,340 −1,902).");
work("frontend", "PR #479 open", "building the Settings toggle", 1);
changed();
await at(15.5);
tell("reviewer", "backend", "#478: 2 findings. 1) `exportRows` runs one query per invoice (N+1 on big accounts). 2) the route checks `billing:write`; it should be `billing:read`.");
Object.assign(agent("reviewer"), { ownStatus: "#478: 2 findings" });
step("reviewer", "reading #479: 214 files");
changed();
await at(17);
work("qa", "1 failing on #479", "theme-toggle.spec.ts › persists after reload", 0);
tell("qa", "frontend", "`settings/theme-toggle.spec.ts` fails on #479: dark mode resets on reload. ThemeProvider reads `theme`, the toggle saves `lumen-theme`.");
changed();
await at(18.5);
step("qa", "waiting on frontend's fix");
step("frontend", "fixing ThemeProvider: one storage key");
work("backend", "fixing #478 review notes", "batching exportRows; billing:read scope", 0);
changed();
await at(20.5);
tell("frontend", "qa", "Fixed in #482: ThemeProvider reads `lumen-theme` and migrates the old key. Rerun?");
Object.assign(agent("frontend"), { ownStatus: "PR #482: theme fix" });
step("frontend", "PR #482 open");
work("qa", "rerunning e2e on #482", "rerunning e2e (412 tests)", 4);
changed();
await at(22.5);
tell("qa", "frontend", "412/412 green. 0 visual regressions on 38 screens.");
tell("reviewer", "backend", "#478 and #480 approved. Nice batching.");
Object.assign(agent("reviewer"), { ownStatus: "approved #478 #480" });
step("qa", "writing the report");
changed();
await at(23.5);
report("qa", "Dark mode passes", "**412/412** e2e green and **0** visual regressions across 38 screens. One bug caught on the way: the theme reset on reload; frontend fixed it in #482. Added 9 tests; export load tests next.");
work("qa", "load-testing export", "export: 10k and 1M-row accounts", 2);
changed();
await at(24.5);
tell("backend", "release", "#478 #480 merged: billing export ready for the 4.2 canary.");
work("release", "4.2-rc.1 canary at 10%", "deploying api 4.2.0-rc.1 to 10%");
rest("reviewer", "approved 6 PRs", new Date(Date.now() + 20 * 60000).toISOString());
work("backend", "export merged; watching", "watching the canary");
changed();

// ---------- incident (the tape looks at on-call about now) ----------
await at(27);
work("on-call", "INCIDENT: export 5xx 4.2%", "5xx at 4.2% on canary; reading logs");
changed();
await at(28.5);
step("on-call", "DB pool exhausted by /v2/billing/export");
push("on-call", { kind: "message", text: "Woke on my watch: 5xx on the canary jumped from **0.02% to 4.2%** two minutes after `api 4.2.0-rc.1`. Looking." });
changed();
await at(30);
tell("on-call", "release", "Rolling back the canary now: rc.1 exhausts the DB pool on large exports.");
step("on-call", "rolling back canary to 4.1.3");
work("release", "rolled back by on-call", "rolling back 10% to 4.1.3");
changed();
await at(31.5);
tell("on-call", "backend", "`/v2/billing/export` holds a pool connection per batch; 3 big accounts drained the pool. Rolled back. Hotfix?");
step("on-call", "error rate falling: 0.9%");
work("backend", "hotfix: export pool leak", "streaming on one connection", 2);
changed();
await at(33.5);
step("on-call", "5xx back to 0.02%; checking requests");
tell("backend", "on-call", "Hotfix #485: export streams through one connection with a cursor. Load-tested 50 accounts × 1M rows: pool peak 12/100.");
step("backend", "PR #485 open: hotfix");
step("release", "waiting for #485");
changed();
await at(35.5);
report(
  "on-call",
  "Incident handled: billing export canary",
  "- **What:** 5xx on `/v2/billing/export` hit 4.2% on the 10% canary\n- **Why:** the export held a DB connection per batch; 3 large accounts drained the pool\n- **Done:** rolled back in 3 min; backend's hotfix #485 streams on one connection\n- **Impact:** 37 failed requests, all retried by clients; no data lost\n\nPostmortem is in `incidents/billing-export.md`.",
);
rest("on-call", "prod quiet: 5xx 0.02%", tomorrowAt(6));
changed();
await at(37);
tell("reviewer", "backend", "#485 approved. Cursor + backpressure looks right.");
rest("reviewer", "approved 7 PRs", tomorrowAt(9));
step("backend", "#485 merged");
step("release", "PR #486: changelog + export guide");
changed();
await at(38.5);
rest("backend", "export merged: 3 PRs");
rest("frontend", "dark mode merged: 3 PRs");
rest("qa", "1,247 green; 41 new tests", tomorrowAt(7));
step("release", "cutting 4.2.0-rc.2: 7 PRs");
changed();

// ---------- the one thing that's the person's to decide ----------
await at(40.5);
step("release", null);
push("release", {
  kind: "question",
  title: "Ship 4.2 to 100%, or a 10% canary first?",
  text: "Ship 4.2 to 100%, or a 10% canary first?\nDark mode and billing export are merged: 7 PRs, 1,247 tests green, 0 visual regressions. rc.1 caused today's incident on the canary (rolled back, fixed in #485).",
  why: "It reaches every Lumen workspace, so it's yours to call.",
  recommendation: "10% canary for 30 min, then 100%",
  options: ["Ship to 100% now", "10% canary for 30 min, then 100%", "Hold until tomorrow"],
});
Object.assign(agent("release"), { status: "asleep", waiting: 1, ownStatus: "asked you how to ship", nextWake: new Date(Date.now() + 45 * 60000).toISOString() });
changed();
await until(() => d.messages.release.some((m: any) => m.kind === "question" && m.answer));
t0 = Date.now();

// ---------- ship ----------
work("release", "shipping 4.2: canary first", "deploying 4.2.0 to 10%");
changed();
await at(2);
step("release", "canary: 5xx 0.01%, p95 176ms");
work("on-call", "watching the 4.2 canary", "watching canary: 5xx 0.01%");
changed();
await at(4);
push("release", { text: "Canary's clean: 5xx **0.01%**, p95 **176ms**, a 1M-row export in 41s. Promoting to 100%." });
step("release", "promoting 4.2.0 to 100%");
changed();
await at(6);
push("release", { text: "**Lumen 4.2.0 is live** for every workspace. Tagged `v4.2.0`; release notes are up." });
rest("release", "4.2.0 live at 100%", tomorrowAt(10));
rest("on-call", "prod quiet: 5xx 0.01%", tomorrowAt(6));
tell("release", "pm", "4.2.0 is live at 100%. Canary clean.");
work("pm", "writing tonight's report", "collecting PRs, tests and the incident");
changed();

// ---------- pm closes the day (the tape is back on pm) ----------
await at(9);
report(
  "pm",
  "Shipped: dark mode + billing export",
  "**7 PRs merged, 1 incident handled, 41 tests added.**\n- **Dark mode:** 214 components, a Settings toggle (#479 #481 #482)\n- **Billing export:** CSV + Parquet, 1M rows in 41s (#478 #480 #485)\n- **Incident:** canary 5xx caught by on-call, rolled back in 3 min\n- **Docs:** export guide + 4.2 changelog (#486)\n\nEveryone's off until morning. I'll check adoption at 9.",
);
rest("pm", "4.2 shipped; check at 9", tomorrowAt(9));
changed();

process.on("SIGINT", () => process.exit(0));
