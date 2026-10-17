// One person's own crew: Sam, an engineer, has agents for the job hunt, interviews, a visa, grad school,
// money, a side project and learning. One evening they check in, approve an application and go to bed;
// the agents work through the night, and Sam wakes to a morning report.
// It's scripted: Sam, the agents and everything they say are made up, fed to the real app through the
// fake daemon the tests use (see ../scripted.ts), so it runs no model and costs nothing.
//
//   npx tsx docs/demos/life/life.ts          Ctrl+C to quit
//
// It waits for you where Sam acts: a message to job-scout, the answer to its question, a good night.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { at, clockSpeed, scene, setClock, sleep, until } from "../scripted.js";

const here = dirname(fileURLToPath(import.meta.url));
setClock(21, 38);
const s = await scene(
  [
    { name: "job-scout", ownStatus: "6 applications in flight", nextWake: at(23, 0), spentUsd: 0.62, budgetUsd: 5 },
    { name: "interview-coach", ownStatus: "no interviews booked", nextWake: at(8, 0, 1), spentUsd: 0.1, budgetUsd: 5 },
    { name: "visa-planner", ownStatus: "H-1B transfer: 9 of 12 docs", nextWake: at(6, 0, 1), spentUsd: 0.05, budgetUsd: 2 },
    { name: "grad-school", ownStatus: "CMU MSML: SOP draft 2", nextWake: at(1, 0, 1), spentUsd: 0.31, budgetUsd: 3 },
    { name: "money", ownStatus: "October: on budget", nextWake: at(5, 0, 1), spentUsd: 0.04, budgetUsd: 2 },
    { name: "side-project", ownStatus: "Tidepool 1.4.1: 4.7★", nextWake: at(7, 30, 1), spentUsd: 0.22, budgetUsd: 5 },
    { name: "learning", ownStatus: "23-day streak: systems", nextWake: at(6, 45, 1), spentUsd: 0.03, budgetUsd: 1 },
  ],
  { home: "/Users/sam/overtime/agents", files: join(here, "files") },
);
const { work, delegate, rest, tell, say, report, ask, step, changed, agent } = s;

// Earlier today: what job-scout found at six.
s.seed("job-scout", {
  t: at(18, 10),
  kind: "report",
  title: "3 new roles match your filters",
  text: "3 new roles match your filters\n- **Northwind**, Senior Backend: onsite invite pending\n- **Fathom**, Platform Engineer: applied, CV v4\n- **Brightline**, Staff Payments: closes Fri; you said maybe",
});

s.seed("money", {
  t: at(7, 5, -16),
  kind: "report",
  title: "September: $230 under budget",
  text: "September: $230 under budget\nSaved $1,730. Groceries ran $38 over; everything else under. Nothing new to cancel.",
});

// The timeline runs on real time (performance.now), not the scene's clock.
let t0 = 0;
const when = (sec: number) => sleep(Math.max(0, t0 + sec * 1000 - performance.now()));

// ---------- evening: Sam checks in ----------
await s.heard("job-scout");
t0 = performance.now();
clockSpeed(12);
work("job-scout", "reading tonight's postings", "reading 14 new postings since 6pm");
changed();
await when(1.8);
step("job-scout", "checking the Stripe role with visa-planner");
tell("job-scout", "visa-planner", "Stripe, Staff Engineer, remote US. Anything that limits Sam's start date?");
work("visa-planner", "checking start dates", "reading the H-1B transfer timeline");
changed();
await when(3.4);
tell("visa-planner", "job-scout", "Yes: the H-1B transfer needs about 3 weeks after an offer. Don't agree to a start before Dec 8; premium processing ($2,805) could make it Nov 24.");
rest("visa-planner", "H-1B transfer: 9 of 12 docs", at(6, 0, 1));
step("job-scout", "tailoring your CV for Stripe");
changed();
await when(5);
say("job-scout", "One, and it's a strong fit: **Stripe, Staff Engineer, Payments Ledger** (remote, $285–330k). They want ledgers and idempotency at scale, which is your Tally migration, so I rewrote your CV to lead with it.", {
  attachments: [s.file("sam-cv-stripe.pdf")],
});
changed();
await when(6.2);
ask("job-scout", {
  title: "Apply to Stripe's Staff role with the tailored CV?",
  body: "It closes Sunday. The cover note asks for a start after Dec 8, per visa-planner.",
  recommendation: "Apply tonight",
  options: ["Apply tonight", "Let me edit the CV first", "Skip this one"],
});
Object.assign(agent("job-scout"), { ownStatus: "asked you about Stripe" });
changed();
await until(() => s.answered("job-scout"));
t0 = performance.now();

work("job-scout", "applying to Stripe", "submitting the application");
changed();
await when(1.6);
say("job-scout", "Applied: confirmation **STR-88213**. Also, Northwind confirmed your onsite for **Tue 28th** (4 rounds); I've told interview-coach.");
tell("job-scout", "interview-coach", "Northwind onsite confirmed: Tue 28th, 4 rounds (system design, 2× coding, behavioral). Sam has evenings free Thu–Sun.");
work("interview-coach", "Northwind onsite prep", "reading 41 Northwind interview reports", 0);
rest("job-scout", "7 applications in flight", at(7, 0, 1));
changed();

// ---------- Sam says good night ----------
await s.heard("job-scout", 1);
t0 = performance.now();
work("job-scout", "7 applications in flight", "replying");
changed();
await when(1.2);
say("job-scout", "Good night, Sam. Your morning summary will be here at 7.");
rest("job-scout", "7 applications in flight", at(7, 0, 1));
delegate("interview-coach", "Northwind onsite prep", 2);
changed();

// ---------- the night (the tape watches interview-coach) ----------
await when(3);
// About nine hours of night in twenty seconds.
clockSpeed(1700);
await when(5);
work("interview-coach", "Northwind onsite prep", "writing 4 mock questions", 0);
changed();
await when(7.5);
report("interview-coach", "Onsite prep plan ready", "A plan for the 4 rounds, built from 41 recent Northwind reports: your two best stories, 4 mock questions, and one 35-minute drill a night, Thu–Sat. First drill tomorrow at 8pm.", {
  attachments: [s.file("onsite-prep.md")],
});
rest("interview-coach", "onsite Tue 28th: plan ready", at(20, 0, 1));
work("grad-school", "CMU MSML: SOP draft 3", "tightening the research paragraph");
changed();
await when(10);
rest("grad-school", "SOP draft 3: 812 words", at(1, 0, 2));
work("side-project", "Tidepool: 2 new 1★ reviews", "reading 2 new App Store reviews", 0);
changed();
await when(12);
step("side-project", "widget crash on iOS 18.1: reproducing");
changed();
await when(14);
step("side-project", "fixed; uploading 1.4.2 to TestFlight");
changed();
await when(16);
report("side-project", "Tidepool 1.4.2 is in review", "Two 1★ reviews tonight, same crash: the tide widget on iOS 18.1. Fixed the date parsing, added a test, and 1.4.2 is with App Review. I replied to both reviewers.", {
  links: [{ kind: "url", target: "https://testflight.apple.com/join/tidepool", label: "testflight.apple.com/join/tidepool" }],
});
rest("side-project", "1.4.2 in App Review", at(9, 0));
work("money", "October close", "reading 3 accounts' statements");
changed();
await when(19);
step("money", "found 3 subscriptions you don't use");
changed();
await when(20.5);
work("visa-planner", "H-1B transfer documents", "renaming and checking 11 documents");
changed();
await when(22);
// ---------- morning ----------
setClock(6, 58, 1);
clockSpeed(30);
report("money", "October: $412 under budget", "You saved **$1,912** (plan: $1,500). Eating out ran $42 over. **3 subscriptions you haven't used in 60 days**: Peloton app, StreamPlus, a cloud storage tier: $47 a month. Cancel them?", {
  attachments: [s.file("budget-october.png")],
});
rest("money", "Oct: $412 under; 3 to cancel", at(5, 0, 1));
rest("visa-planner", "H-1B transfer: 11 of 12 docs", at(6, 0, 1));
work("learning", "today: consistent hashing", "picking today's 20 minutes");
changed();
await when(24);
rest("learning", "24-day streak: systems", at(6, 45, 1));
work("job-scout", "your morning summary", "collecting the night's work");
changed();
await when(26);
report(
  "job-scout",
  "Good morning, Sam: your night",
  "- **Stripe:** applied (STR-88213); I'll watch for a reply\n- **Northwind onsite:** prep plan ready; first drill tonight at 8 (interview-coach)\n- **Tidepool:** a widget crash fixed; 1.4.2 is in App Review (side-project)\n- **Money:** $412 under budget; 3 unused subscriptions, $47/mo (money)\n- **CMU:** statement of purpose draft 3, 812 words (grad-school)\n- **Visa:** 11 of 12 documents ready; your I-94 is the last (visa-planner)",
);
rest("job-scout", "7 applications in flight", at(23, 0));
clockSpeed(1);
changed();
