// One person's own agents: Alex has agents for a trip, a house hunt, money, learning a language, a side
// project and a morning brief. One evening Alex checks in, approves a flight booking and goes to bed; the
// agents work through the night, and Alex wakes to a morning brief.
// It's scripted: Alex, the agents and everything they say are made up, fed to the real app through the
// fake daemon the tests use (see ../scripted.ts), so it runs no model and costs nothing.
//
//   npx tsx docs/demos/life/life.ts          Ctrl+C to quit
//
// It waits for you where Alex acts: a message to trip-planner, the answer to its question, a good night.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { at, clockSpeed, scene, setClock, sleep, until } from "../scripted.js";

const here = dirname(fileURLToPath(import.meta.url));
setClock(21, 38);
const s = await scene(
  [
    { name: "trip-planner", ownStatus: "Lisbon fares: best $612", nextWake: at(0, 0, 1), spentUsd: 0.41, budgetUsd: 3 },
    { name: "house-hunt", ownStatus: "watching 4 sites: 2-beds", nextWake: at(1, 0, 1), spentUsd: 0.22, budgetUsd: 3 },
    { name: "money", ownStatus: "October: on budget", nextWake: at(5, 0, 1), spentUsd: 0.04, budgetUsd: 2 },
    { name: "learning", ownStatus: "Portuguese: day 23", nextWake: at(6, 30, 1), spentUsd: 0.03, budgetUsd: 1 },
    { name: "side-project", ownStatus: "Tidepool 1.4.1: 4.7★", nextWake: at(7, 30, 1), spentUsd: 0.22, budgetUsd: 5 },
    { name: "daily-brief", ownStatus: "next brief at 7", nextWake: at(7, 0, 1), spentUsd: 0.06, budgetUsd: 1 },
  ],
  { home: "/Users/alex/overtime/agents", files: join(here, "files") },
);
const { work, rest, tell, say, report, ask, step, changed, agent } = s;

// What they'd already said today, so their conversations open mid-way rather than empty.
s.seed("trip-planner", {
  t: at(18, 10),
  kind: "report",
  title: "Watching fares to Lisbon",
  text: "Watching fares to Lisbon\nFor May 14–21, best so far **$612** return. I check every 3 hours and tell you as soon as it's under $520.",
});
s.seed("house-hunt", { t: at(8, 5), text: "Watching 4 sites for 2-beds under **$2,300**, within 25 minutes of work, cats ok. I'll book viewings for anything that fits and tell you." });
s.seed("daily-brief", {
  t: at(7, 0),
  kind: "report",
  title: "Good morning, Alex",
  text: "Good morning, Alex\n- **Inbox:** 23 overnight; 1 needs you, the plumber's quote\n- **Portuguese:** today's drill is ready, 7 min (learning)\n- Nothing else changed overnight.",
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

// ---------- evening: Alex checks in ----------
await s.heard("trip-planner");
t0 = performance.now();
clockSpeed(12);
work("trip-planner", "Lisbon: checking fares", "checking fares on 9 airlines");
changed();
await when(1.8);
step("trip-planner", "checking the budget with money");
tell("trip-planner", "money", "Lisbon return for May 14–21 dropped to $486 (was $612). Does it fit Alex's trip budget?");
work("money", "checking the trip budget", "reading the trip budget");
changed();
await when(3.4);
tell("money", "trip-planner", "Yes. The trip budget is $1,800; with the flat ($742) it comes to $1,228, which leaves $572 for the week.");
rest("money", "October: on budget", at(5, 0, 1));
step("trip-planner", "drafting the week around it");
changed();
await when(5);
say("trip-planner", "Yes: fares dropped to **$486** return on TAP (was $612), and money says it fits your $1,800 budget. I drafted the week around it.", {
  attachments: [s.file("lisbon-itinerary.md")],
});
changed();
await when(6.2);
ask("trip-planner", {
  title: "Book the Lisbon flights for $486?",
  body: "May 14–21 on TAP, nonstop, one checked bag. The last 3 times this route dipped, it was back up within a day.",
  recommendation: "Book them now",
  options: ["Book them now", "Wait for a lower fare", "Change the dates"],
});
Object.assign(agent("trip-planner"), { ownStatus: "asked you about flights" });
changed();
await until(() => s.answered("trip-planner"));
t0 = performance.now();

work("trip-planner", "Lisbon: booking flights", "booking TAP 1406 and 1407");
changed();
await when(1.6);
say("trip-planner", "Booked: TAP confirmation **K7M2QX**, seats 14A and 14C. It's in your calendar, and I'll check you in on May 13.");
tell("trip-planner", "learning", "Alex flies to Lisbon on May 14. Can the Portuguese drills cover travel phrases before then?");
work("learning", "Portuguese: day 23", "rebuilding the next 26 days of drills", 0);
rest("trip-planner", "Lisbon: flights booked", at(9, 0, 1));
changed();

// ---------- Alex says good night ----------
await s.heard("trip-planner", 1);
t0 = performance.now();
work("trip-planner", "Lisbon: flights booked", "replying");
changed();
await when(1.2);
say("trip-planner", "Good night, Alex. daily-brief will have your morning ready at 7.");
rest("trip-planner", "Lisbon: flights booked", at(9, 0, 1));
rest("learning", "Portuguese: travel phrases", at(6, 30, 1));
changed();

// ---------- the night (the tape watches house-hunt) ----------
await when(3);
// About nine hours of night in twenty seconds.
clockSpeed(1700);
await when(4.5);
work("house-hunt", "3 new listings fit", "comparing 3 new listings", 3);
changed();
await when(6.5);
tell("house-hunt", "trip-planner", "Viewing slots at 14 Alder St: Sat 10:00 or Sun 15:00. Is Alex around this weekend?");
step("house-hunt", "asking trip-planner about the weekend");
Object.assign(agent("house-hunt"), { helpersRunning: 0 });
changed();
await when(7.5);
tell("trip-planner", "house-hunt", "Yes, both are free; Lisbon isn't until May 14.");
step("house-hunt", "booking the Sat 10:00 viewing");
changed();
await when(8.5);
report("house-hunt", "3 new places fit; viewing booked", "Three new listings match everything you asked for. **14 Alder St** is the best: $2,150, south light, in-unit laundry, 22 minutes by bike. I booked a viewing for Saturday at 10.", {
  attachments: [s.file("apartments-compared.md")],
});
rest("house-hunt", "viewing Sat 10:00: Alder St", at(1, 0, 1));
work("side-project", "Tidepool: 2 new 1★ reviews", "reading 2 new App Store reviews");
changed();
await when(11);
step("side-project", "widget crash on iOS 18.1: reproducing");
changed();
await when(13);
step("side-project", "fixed; uploading 1.4.2 to TestFlight");
changed();
await when(15);
report("side-project", "Tidepool 1.4.2 is in review", "Two 1★ reviews tonight, same crash: the tide widget on iOS 18.1. Fixed the date parsing, added a test, and 1.4.2 is with App Review. I replied to both reviewers.", {
  links: [{ kind: "url", target: "https://testflight.apple.com/join/tidepool", label: "testflight.apple.com/join/tidepool" }],
});
rest("side-project", "1.4.2 in App Review", at(9, 0));
work("money", "October close", "reading 3 accounts' statements");
changed();
await when(18);
step("money", "found 3 subscriptions you don't use");
changed();
await when(20);
work("learning", "Portuguese: day 24", "picking today's 12 phrases");
changed();

// ---------- morning ----------
await when(22);
setClock(6, 58, 1);
clockSpeed(30);
report("money", "October: $412 under budget", "You saved **$1,912** (plan: $1,500). Eating out ran $42 over. **3 subscriptions you haven't used in 60 days**: a fitness app, a streaming service and a cloud storage tier, $47 a month. Cancel them?", {
  attachments: [s.file("budget-october.png")],
});
rest("money", "Oct: $412 under; 3 to cancel", at(5, 0, 1));
rest("learning", "Portuguese: day 24 ready", at(6, 30, 1));
work("daily-brief", "your morning brief", "reading 41 emails and 6 newsletters");
changed();
await when(26);
report(
  "daily-brief",
  "Good morning, Alex",
  "- **Lisbon:** flights booked, $486 (trip-planner)\n- **Apartment:** viewing Sat 10:00 at 14 Alder St (house-hunt)\n- **Money:** $412 under budget; 3 unused subscriptions, $47/mo (money)\n- **Tidepool:** a widget crash fixed; 1.4.2 is in App Review (side-project)\n- **Portuguese:** today's drill is 12 travel phrases, 8 min (learning)\n- **Inbox:** 41 overnight; 2 need you, from your landlord and your dentist",
);
rest("daily-brief", "next brief at 7", at(7, 0, 1));
clockSpeed(1);
changed();
