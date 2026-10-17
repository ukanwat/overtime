import { describe, it, expect, afterEach } from "vitest";
process.env.OVERTIME_STILL = "1";
import { fakeHome, until } from "./helpers.js";
import { FakeClient, TestTerminal } from "./tui-fake.js";

fakeHome();
const { runApp } = await import("../src/tui/app.js");
const style = await import("../src/tui/style.js");

/** The bytes macOS Terminal sends (with its default keyboard settings unless said), and the forms other terminals use. */
const K = {
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  shiftLeft: "\x1b[1;2D",
  shiftRight: "\x1b[1;2C",
  shiftUp: "\x1b[1;2A",
  shiftDown: "\x1b[1;2B",
  optLeft: "\x1bb", // Terminal's default for Option+←
  optRight: "\x1bf",
  shiftOptLeft: "\x1b[1;4D", // xterm's Shift+Option+←
  metaShiftLeft: "\x1b\x1b[1;2D", // ESC + Shift+←, with "Use Option as Meta key"
  shiftCtrlRight: "\x1b[1;6C",
  shiftHome: "\x1b[1;2H",
  shiftEnd: "\x1b[1;2F",
  cmdShiftLeft: "\x1b[1;10D", // kitty-style Cmd+Shift+←
  bs: "\x7f",
  del: "\x1b[3~",
  optBs: "\x1b\x7f", // Option+Backspace with "Use Option as Meta key"
  cmdBs: "\x1b[127;9u", // kitty-style Cmd+Backspace
  esc: "\x1b",
  enter: "\r",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlK: "\x0b",
  ctrlU: "\x15",
  ctrlW: "\x17",
  ctrlX: "\x18",
  ctrlZ: "\x1a",
  ctrlMinus: "\x1f",
};
const paste = (s: string) => `\x1b[200~${s}\x1b[201~`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;

describe("the message box edits like a text box", () => {
  let stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops) s();
    stops = [];
    style.resetPalette();
  });

  async function open(cols = 120, rows = 36) {
    const t = new TestTerminal(cols, rows);
    const copied: string[] = [];
    let quits = 0;
    const c = new FakeClient();
    const r = await runApp({ terminal: t as any, client: c as any, onQuit: () => void quits++, opener: () => {}, clipboard: (text) => (copied.push(text), true) });
    stops.push(r.stop);
    await until(async () => (await t.screen()).includes("Merge the dependency fix?"), 30_000, "the app on screen");
    const value = () => r.app.input.getValue();
    const selected = () => r.app.input.selectedText();
    /** Type into the box and let the frame catch up. */
    const keys = async (...ks: string[]) => {
      for (const k of ks) t.press(k);
      await sleep(30);
    };
    /** Where the message box's text starts on screen: the row and column of its first character. */
    const textAt = async () => {
      const lines = (await t.screen()).split("\n");
      const y = lines.findIndex((l) => /[│ ] › /.test(l));
      return { y, x: lines[y].indexOf("› ") + 2, lines };
    };
    return { t, c, app: r.app, tui: r.tui, copied, quits: () => quits, value, selected, keys, textAt };
  }

  it("selects with Shift+← →, and typing or Backspace replaces what's selected", async () => {
    const { t, value, selected, keys } = await open();
    t.type("hello world");
    await keys(K.shiftLeft, K.shiftLeft, K.shiftLeft, K.shiftLeft, K.shiftLeft);
    expect(selected()).toBe("world");
    await keys("X");
    expect(value()).toBe("hello X");
    await keys(K.shiftLeft, K.shiftLeft, K.bs);
    expect(value()).toBe("hello");
    await keys(K.left, K.left, K.shiftRight, K.del);
    expect(value()).toBe("helo");
    // Shift+→ back over what Shift+← took leaves nothing selected.
    await keys(K.shiftLeft, K.shiftRight);
    expect(selected()).toBe("");
  });

  it("selects by word with Shift+Option+← → in each form terminals send, and Option+← → jump words", async () => {
    const { t, value, selected, keys } = await open();
    t.type("one two three");
    await keys(K.shiftOptLeft);
    expect(selected()).toBe("three");
    await keys(K.metaShiftLeft);
    expect(selected()).toBe("two three");
    // Escape waits a moment for a sequence it may start (see input.ts), so wait for it to land.
    await keys(K.esc);
    await until(async () => selected() === "", 5_000, "Esc letting go of the selection");
    expect(value()).toBe("one two three");
    await keys(K.optLeft, K.optLeft, K.optLeft, K.shiftCtrlRight);
    expect(selected()).toBe("one");
    await keys(K.optRight, "!");
    expect(value()).toBe("one two! three");
  });

  it("selects by word with Option+Shift+← as macOS Terminal sends it with Option as Meta, split in two by the terminal library", async () => {
    const { t, value, selected } = await open();
    t.type("one two three");
    // The library hands "ESC ESC [1;2D" over as Escape, then Shift+←, at once.
    t.press("\x1b");
    t.press(K.shiftLeft);
    await until(async () => selected() === "three", 5_000, "the word selected");
    t.press("\x1b");
    t.press(K.shiftLeft);
    await until(async () => selected() === "two three", 5_000, "the next word selected");
    // Not Escape: the message is still there, and stays.
    await sleep(100);
    expect(selected()).toBe("two three");
    expect(value()).toBe("one two three");
  });

  it("selects to the line's start and end with Shift+Home / Shift+End (and Cmd+Shift+← where it arrives)", async () => {
    const { t, selected, keys } = await open();
    t.type("abc def");
    await keys(K.left, K.left, K.left, K.shiftHome);
    expect(selected()).toBe("abc ");
    await keys(K.right, K.shiftEnd);
    expect(selected()).toBe("def");
    await keys(K.cmdShiftLeft);
    expect(selected()).toBe("abc ");
  });

  it("selects everything with Ctrl+A pressed twice; once, it still goes to the line's start", async () => {
    const { t, value, selected, keys } = await open();
    t.type("first line");
    await keys("\n");
    t.type("second");
    await keys(K.ctrlA, ">");
    expect(value()).toBe("first line\n>second");
    await keys(K.ctrlA, K.ctrlA);
    expect(selected()).toBe("first line\n>second");
    await keys("new");
    expect(value()).toBe("new");
  });

  it("selects through the lines of a message with Shift+↑ ↓; in a one-line message they still scroll", async () => {
    const { t, app, selected, keys } = await open();
    t.type("one line");
    const scroll = (app as any).scroll;
    await keys(K.shiftUp);
    expect(selected()).toBe("");
    expect((app as any).scroll).not.toBe(scroll);
    await keys("\n");
    t.type("two");
    await keys(K.shiftUp);
    expect(selected()).toBe(" line\ntwo");
    await keys(K.shiftUp);
    expect(selected()).toBe("one line\ntwo");
    await keys(K.shiftDown, K.shiftDown);
    expect(selected()).toBe("");
  });

  it("copies with Ctrl+C and cuts with Ctrl+X; with nothing selected Ctrl+C still quits", async () => {
    const { t, value, copied, quits, keys, tui } = await open();
    const flashes: string[] = [];
    const flash = tui.flash.bind(tui);
    tui.flash = (m: string, d?: number) => (flashes.push(m), flash(m, d));
    t.type("copy me please");
    await keys(K.shiftOptLeft, K.ctrlC);
    expect(copied).toEqual(["please"]);
    expect(quits()).toBe(0);
    expect(value()).toBe("copy me please");
    await until(async () => flashes.includes("Copied!"), 2000, "Copied! shown");
    await keys(K.shiftOptLeft, K.ctrlX);
    expect(copied[1]).toBe("me please");
    expect(value()).toBe("copy ");
    await keys(K.ctrlC);
    expect(quits()).toBe(1);
  });

  it("pastes over what's selected, and Ctrl+Z (or Ctrl+-) undoes it", async () => {
    const { t, value, keys } = await open();
    t.type("keep this word");
    await keys(K.shiftOptLeft, paste("text"));
    expect(value()).toBe("keep this text");
    await keys(K.ctrlZ);
    expect(value()).toBe("keep this word");
    await keys("\x1b[F", K.shiftOptLeft, "w", "o", "r", "m");
    expect(value()).toBe("keep this worm");
    // Typing over a selection and its undo are one step.
    await keys(K.ctrlMinus);
    expect(value()).toBe("keep this word");
  });

  it("Esc lets go of a selection first, then clears the message", async () => {
    const { t, value, selected, keys } = await open();
    t.type("draft");
    await keys(K.shiftLeft, K.esc);
    await until(async () => selected() === "", 5_000, "Esc letting go of the selection");
    expect(value()).toBe("draft");
    await keys(K.esc);
    await until(async () => value() === "", 5_000, "Esc clearing the message");
  });

  it("deletes words and to the line's ends with the usual keys", async () => {
    const { t, value, keys } = await open();
    t.type("alpha beta gamma");
    await keys(K.optBs);
    expect(value()).toBe("alpha beta ");
    await keys(K.ctrlW);
    expect(value()).toBe("alpha ");
    t.type("x y");
    await keys(K.optLeft, K.ctrlK);
    expect(value()).toBe("alpha x ");
    await keys(K.ctrlU);
    expect(value()).toBe("");
    t.type("one two");
    await keys(K.cmdBs);
    expect(value()).toBe("");
  });

  it("shows what's selected inverted, says how to copy it, and draws no cursor meanwhile", async () => {
    const { t, keys, textAt } = await open();
    t.type("pick these words");
    await keys(K.shiftOptLeft);
    const { x, y } = await textAt();
    const inv = async (i: number) => (await t.cell(x + i, y)).inverse;
    expect(await inv(0)).toBe(false);
    expect(await inv("pick these ".length)).toBe(true);
    expect(await inv("pick these words".length - 1)).toBe(true);
    // No cursor block after the text while something is selected.
    expect(await inv("pick these words".length)).toBe(false);
    expect(await t.screen()).toContain("^C copy");
    await keys(K.right);
    expect(await inv("pick these ".length)).toBe(false);
    expect(await inv("pick these words".length)).toBe(true);
  });

  it("places the cursor where you click in the box", async () => {
    const { t, value, keys, textAt } = await open();
    t.type("abcdef");
    await sleep(30);
    const { x, y } = await textAt();
    await keys(press(x + 2, y), release(x + 2, y), "X");
    expect(value()).toBe("abXcdef");
    // Past the end of the text is its end.
    await keys(press(x + 40, y), release(x + 40, y), "Y");
    expect(value()).toBe("abXcdefY");
  });

  it("selects by dragging in the box and copies only the text: not the prompt, the frame or the conversation", async () => {
    const { t, tui, value, selected, copied, keys, textAt } = await open();
    t.type("drag over this text");
    await sleep(30);
    const { x, y } = await textAt();
    // From the box's frame on the left, along the row and up into the conversation and back.
    await keys(press(x - 4, y), drag(x + 3, y), drag(x + 10, y - 6), drag(x + 3, y));
    expect(selected()).toBe("drag");
    expect((tui as any).getActiveSelectionText()).toBeUndefined();
    await keys(release(x + 3, y));
    expect(copied).toEqual(["drag"]);
    expect((await t.cell(x, y)).inverse).toBe(true);
    expect((await t.cell(x - 2, y)).inverse).toBe(false);
    // Dragging leftwards takes in the character pressed on too; above the box reaches its start.
    await keys(press(x + 8, y), drag(x + 5, y), release(x + 5, y));
    expect(copied[1]).toBe("over");
    await keys(press(x + 8, y), drag(x + 8, y - 3), release(x + 8, y - 3));
    expect(copied[2]).toBe("drag over");
    await keys("Z");
    expect(value()).toBe("Z this text");
  });

  it("selects a word with a double-click and the line with a triple-click, copying each", async () => {
    const { t, selected, copied, keys, textAt } = await open();
    t.type("see ~/notes/plan-b.md now");
    await sleep(30);
    const { x, y } = await textAt();
    const click = [press(x + 8, y), release(x + 8, y)];
    await keys(...click, ...click);
    expect(selected()).toBe("~/notes/plan-b.md".slice(1));
    expect(copied).toEqual(["/notes/plan-b.md"]);
    await keys(...click);
    expect(selected()).toBe("see ~/notes/plan-b.md now");
    expect(copied[1]).toBe("see ~/notes/plan-b.md now");
  });

  it("lets go of the box's selection when you press elsewhere, and a selection from the footer stays on its row", async () => {
    const { t, tui, selected, keys, textAt } = await open();
    t.type("something");
    await keys(K.shiftOptLeft);
    expect(selected()).toBe("something");
    const { y, lines } = await textAt();
    const convo = lines.findIndex((l) => l.includes("Dependabot opened"));
    await keys(press(60, convo));
    expect(selected()).toBe("");
    await keys(release(60, convo));
    const footer = lines.length - 1;
    await keys(press(1, footer), drag(60, y), drag(60, convo));
    const text: string | undefined = (tui as any).getActiveSelectionText();
    expect(text ?? "").not.toContain("Dependabot");
    expect(text ?? "").not.toContain("something");
    await keys(release(60, convo));
  });

  it("still attaches a dragged-in file, rather than pasting over a selection", async () => {
    const { t, app, value, keys } = await open();
    t.type("see attached");
    await keys(K.shiftOptLeft, paste(new URL(import.meta.url).pathname));
    expect(value()).toBe("see attached");
    expect(app.pending.length).toBe(1);
  });
});

describe("the / menu takes the mouse", () => {
  let stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops) s();
    stops = [];
    style.resetPalette();
  });
  const click = (t: TestTerminal, x: number, y: number) => (t.press(press(x, y)), t.press(release(x, y)));
  const wheel = (down: boolean, x: number, y: number) => `\x1b[<${down ? 65 : 64};${x + 1};${y + 1}M`;
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

  async function open(rows: number, tint: boolean) {
    if (tint) style.applyTerminalColors({ background: { r: 12, g: 12, b: 12 }, foreground: { r: 224, g: 224, b: 224 } }, true);
    const t = new TestTerminal(120, rows);
    const c = new FakeClient();
    const r = await runApp({ terminal: t as any, client: c as any, onQuit: () => {}, opener: () => {}, clipboard: () => true, });
    stops.push(r.stop);
    await until(async () => (await t.screen()).includes("repo-keeper"), 30_000, "the app on screen");
    r.app.skills = names.map((name) => ({ name, description: `the ${name} skill` }));
    t.type("/");
    await until(async () => (await t.screen()).includes("/alpha"), 5_000, "the / menu");
    /** Where an item is drawn: the row and the column its label starts at. */
    const at = async (label: string) => {
      const lines = (await t.screen()).split("\n");
      const y = lines.findIndex((l) => l.includes(`${label} `));
      return { y, x: y < 0 ? -1 : lines[y].indexOf(label) };
    };
    const value = () => r.app.input.getValue();
    return { t, app: r.app, at, value };
  }

  for (const [rows, tint] of [[36, false], [36, true], [14, false]] as const) {
    it(`a click on an item chooses it, as Enter does (${rows} rows${tint ? ", tinted" : ""})`, async () => {
      const { t, at, value } = await open(rows, tint);
      const p = await at("/charlie");
      expect(p.y).toBeGreaterThan(0);
      click(t, p.x + 3, p.y);
      await until(async () => value() === "/charlie ", 5_000, "charlie chosen");
      await until(async () => !(await t.screen()).includes("/delta"), 5_000, "the menu closed");
      // Nothing is sent: like Enter, it only puts the skill in the message.
      t.type("go");
      await until(async () => value() === "/charlie go", 5_000, "typing after it");
    });
  }

  it("the wheel over the menu moves the highlight; a click picks what's drawn under it, even once the list has scrolled", async () => {
    const { t, app, at, value } = await open(36, false);
    const { y, x } = await at("/alpha");
    const before = (app as any).scroll;
    for (let i = 0; i < 6; i++) t.press(wheel(true, x, y));
    await until(async () => (await t.screen()).includes("(7/7)"), 5_000, "highlight on the last");
    expect((app as any).scroll).toBe(before); // the conversation didn't scroll
    t.press(wheel(false, x, y));
    await until(async () => (await t.screen()).includes("(6/7)"), 5_000, "back one");
    expect(await t.screen()).not.toContain("/alpha "); // scrolled: the first items are out of view
    const g = await at("/golf");
    click(t, g.x, g.y);
    await until(async () => value() === "/golf ", 5_000, "golf chosen");
  });

  it("the wheel step then Enter chooses the highlighted item", async () => {
    const { t, at, value } = await open(36, false);
    const { y, x } = await at("/alpha");
    t.press(wheel(true, x, y));
    await until(async () => (await t.screen()).includes("(2/7)"), 5_000, "highlight moved");
    t.press("\r");
    await until(async () => value() === "/bravo ", 5_000, "bravo chosen");
  });

  it("a click on the menu's blank row, its count or outside its items picks nothing", async () => {
    const { t, at, value } = await open(36, false);
    const a = await at("/alpha");
    const lines = (await t.screen()).split("\n");
    const count = lines.findIndex((l) => l.includes("(1/7)"));
    click(t, a.x, a.y - 1); // the blank row between the text and the menu
    click(t, a.x, count);
    click(t, 0, a.y); // the box's frame
    await new Promise((r) => setTimeout(r, 100));
    expect(value()).toBe("/");
    expect(await t.screen()).toContain("/alpha");
  });
});

describe("the mouse wheel never types into the message box", () => {
  let stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops) s();
    stops = [];
  });
  // Wheel up and down over the conversation, as SGR mouse reports.
  const up = "\x1b[<64;80;8M";
  const down = "\x1b[<65;80;8M";

  async function open() {
    const t = new TestTerminal(120, 14);
    const c = new FakeClient();
    const r = await runApp({ terminal: t as any, client: c as any, onQuit: () => {}, opener: () => {}, clipboard: () => true });
    stops.push(r.stop);
    await until(async () => (await t.screen()).includes("lines above"), 30_000, "the app on screen");
    const scroll = () => (r.app as any).scroll as number;
    // Off the bottom, so the wheel can go both ways.
    for (let i = 0; i < 4; i++) t.press(up);
    expect(scroll()).toBeLessThan(Number.MAX_SAFE_INTEGER);
    return { t, app: r.app, scroll, value: () => r.app.input.getValue() };
  }

  it("a wheel report split at any byte, between typed letters, scrolls and leaves only the letters", async () => {
    const { t, scroll, value } = await open();
    const typed = "after doing the thing";
    let n = 0;
    for (let i = 1; i < up.length; i++) {
      for (const [seq, dir] of [[up, -1], [down, 1]] as const) {
        t.type(typed[n++ % typed.length] ?? "");
        const before = scroll();
        t.press(seq.slice(0, i));
        t.press(seq.slice(i));
        expect(Math.sign(scroll() - before), `${JSON.stringify(seq)} split at ${i}`).toBe(dir);
      }
    }
    expect(value()).toBe((typed + typed).slice(0, n));
  });

  it("a report whose start came alone, then the rest a byte at a time and typing straight after, as from macOS Terminal under load", async () => {
    const { t, scroll, value } = await open();
    t.type("af");
    const before = scroll();
    t.press("\x1b[");
    t.type(`${up.slice(2)}ter`);
    t.press("\x1b");
    t.type(`${down.slice(1)} doing`);
    expect(value()).toBe("after doing");
    expect(scroll()).toBe(before);
    t.press("\x1b[<65;8");
    t.press("0;8Mx");
    expect(value()).toBe("after doingx");
    expect(scroll()).toBeGreaterThan(before);
  });
});
