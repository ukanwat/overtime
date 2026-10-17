// The README's hero: a whole team of agents shipping two features in an afternoon, drawn by the real app.
// It's scripted: the agents, their messages and the timeline below are made up (a fictional product,
// Lumen), fed to the app through the same fake daemon the tests use (see ../scripted.ts), so it runs no
// model and costs nothing. team.tape drives it like a person would: one brief to pm, a question to qa, a
// look at on-call's incident files, one answer to release.
//
//   npx tsx docs/demos/team/team.ts          Ctrl+C to quit
//
// It waits for you where the person acts: your message to pm, your message to qa, your answer to release.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { at, clockSpeed, scene, setClock, sleep } from "../scripted.js";

const here = dirname(fileURLToPath(import.meta.url));
setClock(13, 56);
const s = await scene(
  [
    { name: "pm", ownStatus: "next: dark mode + export", nextWake: at(9, 0, 1), spentUsd: 0.84 },
    { name: "backend", ownStatus: "api green; nothing open", nextWake: at(9, 0, 1), spentUsd: 1.12 },
    { name: "frontend", ownStatus: "web green; nothing open", nextWake: at(9, 0, 1), spentUsd: 0.97 },
    { name: "qa", ownStatus: "1,206 tests green on main", nextWake: at(7, 0, 1), spentUsd: 0.41 },
    { name: "reviewer", ownStatus: "no PRs waiting", nextWake: at(9, 0, 1), spentUsd: 0.33 },
    { name: "on-call", ownStatus: "prod quiet: 5xx 0.02%", nextWake: at(6, 0, 1), spentUsd: 0.12 },
    { name: "release", ownStatus: "4.1.3 live; 4.2 not cut", nextWake: at(10, 0, 1), spentUsd: 0.2 },
  ],
  { home: "/Users/you/overtime/agents", files: join(here, "files") },
);
const { work, delegate, rest, tell, say, report, ask, step, changed, agent } = s;
const later = (min: number) => new Date(Date.now() + min * 60000).toISOString();

// Yesterday's wrap-up, so pm's conversation opens mid-project rather than empty.
s.seed("pm", { t: at(18, 40, -1), kind: "report", title: "Lumen 4.1.3 is out", text: "Lumen 4.1.3 is out\n3 PRs merged, CI green, no incidents. Next up on the roadmap: **dark mode** and the **billing export** customers keep asking for." });
s.seed("on-call", { t: at(22, 5, -1), text: "Quiet night so far. I'm watching `api` 5xx and p95 on prod; I wake only if one of them moves." });

// The timeline runs on real time (performance.now), not the scene's fast clock.
let t0 = 0;
/** Wait until `sec` seconds after the scene's start. */
const when = (sec: number) => sleep(Math.max(0, t0 + sec * 1000 - performance.now()));

// ---------- the person says one thing to pm ----------
await s.heard("pm");
t0 = performance.now();
clockSpeed(40);

// ---------- planning ----------
work("pm", "planning 4.2 for the team", "reading the roadmap and open issues");
changed();
await when(1.6);
step("pm", "splitting it into tasks");
await when(3.2);
say("pm", "On it: both ship tonight. The plan:\n- **backend**: billing export, `POST /v2/billing/export`, CSV + Parquet\n- **frontend**: dark mode: theme tokens, 214 components, a Settings toggle\n- **qa** tests both; **reviewer** reviews every PR\n- **release** canaries it tonight; **on-call** watches prod meanwhile");
step("pm", "briefing the team");
changed();
await when(4.4);
tell("pm", "backend", "Billing export: streamed CSV + Parquet, scoped to `billing:read`. Tonight.");
work("backend", "billing export API", "reading src/billing/");
changed();
await when(5.2);
tell("pm", "frontend", "Dark mode: tokens in `theme/`, every component, a toggle that persists.");
work("frontend", "dark mode, 214 components", "mapping 1,180 hard-coded colours");
changed();
await when(6);
tell("pm", "qa", "Cover both: big exports in both formats; dark mode visual diffs.");
work("qa", "testing export + dark mode", "reading the export spec");
delegate("backend", "billing export API", 3);
changed();
await when(6.8);
delegate("frontend", "dark mode, 214 components", 3);
step("pm", "waiting on the team");
changed();
await when(7.6);
delegate("qa", "testing export + dark mode", 2);
changed();
await when(8.5);
rest("pm", "4.2 in flight: 6 on it", later(40));
changed();

// ---------- the person checks in with qa (the tape is on qa now) ----------
const checkIn = s.heard("qa").then(async () => {
  work("qa", "testing export + dark mode", "reading the diff results", 2);
  changed();
  await sleep(2200);
  say("qa", "Looking good so far: **38 screens** diffed light vs dark, **0 regressions**. e2e on #479 is running now (412 tests); I'll tell frontend straight away if anything fails.");
  delegate("qa", "testing export + dark mode", 2);
  changed();
});

await when(12.5);
tell("backend", "reviewer", "PR #478 ready: billing export endpoint + streaming worker (+612 −40, 14 tests).");
work("reviewer", "reviewing #478", "reading #478: 11 files");
work("backend", "PR #478 open", "writing the Parquet writer", 1);
changed();
await when(14);
tell("frontend", "reviewer", "PR #479 ready: dark mode tokens + 214 components (+2,340 −1,902).");
work("frontend", "PR #479 open", "building the Settings toggle", 1);
changed();
await when(15.5);
tell("reviewer", "backend", "#478: 2 findings. 1) `exportRows` runs one query per invoice (N+1 on big accounts). 2) the route checks `billing:write`; it should be `billing:read`.");
Object.assign(agent("reviewer"), { ownStatus: "#478: 2 findings" });
step("reviewer", "reading #479: 214 files");
changed();
await checkIn;
await when(18.5);
work("qa", "1 failing on #479", "theme-toggle.spec.ts › persists after reload", 0);
tell("qa", "frontend", "`settings/theme-toggle.spec.ts` fails on #479: dark mode resets on reload. ThemeProvider reads `theme`, the toggle saves `lumen-theme`.");
changed();
await when(20);
step("qa", "waiting on frontend's fix");
step("frontend", "fixing ThemeProvider: one storage key");
work("backend", "fixing #478 review notes", "batching exportRows; billing:read scope", 0);
changed();
await when(22);
tell("frontend", "qa", "Fixed in #482: ThemeProvider reads `lumen-theme` and migrates the old key. Rerun?");
Object.assign(agent("frontend"), { ownStatus: "PR #482: theme fix" });
step("frontend", "PR #482 open");
work("qa", "rerunning e2e on #482", "rerunning e2e (412 tests)", 4);
changed();
await when(24);
tell("qa", "frontend", "412/412 green. 0 visual regressions on 38 screens.");
tell("reviewer", "backend", "#478 and #480 approved. Nice batching.");
Object.assign(agent("reviewer"), { ownStatus: "approved #478 #480" });
step("qa", "writing the report");
changed();
await when(25);
report("qa", "Dark mode passes", "**412/412** e2e green, **0** visual regressions across 38 screens. One bug caught on the way: the theme reset on reload; frontend fixed it in #482. Added 9 tests.", {
  links: [{ kind: "url", target: "https://ci.lumen.dev/runs/8812", label: "ci.lumen.dev/runs/8812" }],
});
work("qa", "load-testing export", "export: 10k and 1M-row accounts", 2);
changed();
await when(26);
tell("backend", "release", "#478 #480 merged: billing export ready for the 4.2 canary.");
work("release", "4.2-rc.1 canary at 10%", "deploying api 4.2.0-rc.1 to 10%");
rest("reviewer", "approved 6 PRs", later(20));
work("backend", "export merged; watching", "watching the canary");
changed();

// ---------- incident (the tape looks at on-call about now) ----------
await when(28.5);
work("on-call", "INCIDENT: export 5xx 4.2%", "5xx at 4.2% on canary; reading logs");
changed();
await when(30);
step("on-call", "DB pool exhausted by /v2/billing/export");
say("on-call", "Woke on my watch: 5xx on the canary jumped from **0.02% to 4.2%** two minutes after `api 4.2.0-rc.1`. Looking.");
changed();
await when(31.5);
tell("on-call", "release", "Rolling back the canary now: rc.1 exhausts the DB pool on large exports.");
step("on-call", "rolling back canary to 4.1.3");
work("release", "rolled back by on-call", "rolling back 10% to 4.1.3");
changed();
await when(33);
tell("on-call", "backend", "`/v2/billing/export` holds a pool connection per batch; 3 big accounts drained the pool. Rolled back. Hotfix?");
step("on-call", "error rate falling: 0.9%");
work("backend", "hotfix: export pool leak", "streaming on one connection", 2);
changed();
await when(35);
step("on-call", "5xx back to 0.02%; writing it up");
tell("backend", "on-call", "Hotfix #485: export streams through one connection with a cursor. Load-tested 50 accounts × 1M rows: pool peak 12/100.");
step("backend", "PR #485 open: hotfix");
step("release", "waiting for #485");
changed();
await when(37);
report("on-call", "Incident handled: billing export canary", "5xx hit **4.2%** on the 10% canary; I rolled it back in 2 min and it's at 0.02% again. Cause: the export held a DB connection per batch. backend's #485 fixes it. 37 requests failed, all retried; no data lost.", {
  attachments: [s.file("canary-5xx.png"), s.file("billing-export-postmortem.md")],
});
rest("on-call", "prod quiet: 5xx 0.02%", at(6, 0, 1));
changed();
await when(38.5);
tell("reviewer", "backend", "#485 approved. Cursor + backpressure looks right.");
rest("reviewer", "approved 7 PRs", at(9, 0, 1));
step("backend", "#485 merged");
step("release", "PR #486: changelog + export guide");
changed();
await when(40);
rest("backend", "export merged: 3 PRs", at(9, 0, 1));
rest("frontend", "dark mode merged: 3 PRs", at(9, 0, 1));
rest("qa", "1,247 green; 41 new tests", at(7, 0, 1));
step("release", "cutting 4.2.0-rc.2: 7 PRs");
changed();

// ---------- the one thing that's the person's to decide ----------
await when(42);
ask("release", {
  title: "Ship 4.2 to 100%, or a 10% canary first?",
  body: "Dark mode and billing export are merged: 7 PRs, 1,247 tests green, 0 visual regressions. rc.1 caused today's incident on the canary (rolled back, fixed in #485).",
  why: "It reaches every Lumen workspace, so it's yours to call.",
  recommendation: "10% canary for 30 min, then 100%",
  options: ["Ship to 100% now", "10% canary for 30 min, then 100%", "Hold until tomorrow"],
});
Object.assign(agent("release"), { ownStatus: "asked you how to ship", nextWake: later(45) });
changed();
await (async () => {
  while (!s.answered("release")) await sleep(150);
})();
t0 = performance.now();

// ---------- ship ----------
work("release", "shipping 4.2: canary first", "deploying 4.2.0 to 10%");
changed();
await when(2);
step("release", "canary: 5xx 0.01%, p95 176ms");
work("on-call", "watching the 4.2 canary", "watching canary: 5xx 0.01%");
changed();
await when(4);
say("release", "Canary's clean: 5xx **0.01%**, p95 **176ms**, a 1M-row export in 41s. Promoting to 100%.");
step("release", "promoting 4.2.0 to 100%");
changed();
await when(6);
say("release", "**Lumen 4.2.0 is live** for every workspace. Tagged `v4.2.0`; release notes are up.");
rest("release", "4.2.0 live at 100%", at(10, 0, 1));
rest("on-call", "prod quiet: 5xx 0.01%", at(6, 0, 1));
tell("release", "pm", "4.2.0 is live at 100%. Canary clean.");
work("pm", "writing tonight's report", "collecting PRs, tests and the incident");
changed();

// ---------- pm closes the day (the tape is back on pm) ----------
await when(9);
report(
  "pm",
  "Shipped: dark mode + billing export",
  "**7 PRs merged, 1 incident handled, 41 tests added.**\n- **Dark mode:** 214 components, a Settings toggle (#479 #481 #482)\n- **Billing export:** CSV + Parquet, 1M rows in 41s (#478 #480 #485)\n- **Incident:** canary 5xx caught by on-call, rolled back in 2 min\n- **Docs:** export guide + 4.2 changelog (#486)\n\nEveryone's off until morning. I'll check adoption at 9.",
);
rest("pm", "4.2 shipped; check at 9", at(9, 0, 1));
clockSpeed(1);
changed();
