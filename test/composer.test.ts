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
    await keys(K.esc);
    expect(selected()).toBe("");
    expect(value()).toBe("one two three");
    await keys(K.optLeft, K.optLeft, K.optLeft, K.shiftCtrlRight);
    expect(selected()).toBe("one");
    await keys(K.optRight, "!");
    expect(value()).toBe("one two! three");
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
    expect(selected()).toBe("");
    expect(value()).toBe("draft");
    await keys(K.esc);
    expect(value()).toBe("");
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
