/**
 * Keeps escape sequences whole on their way from the terminal to the screen.
 *
 * The terminal library already reassembles sequences split across reads, but only for 50 ms, measured by a
 * timer. While the app is busy drawing, that timer can go off before the rest of a sequence that has already
 * arrived is read: the start ("ESC [") is then handed over on its own, as a key, and the rest
 * ("<65;57;41M", a mouse wheel report) is typed into the message box as text. So a lone start of a sequence
 * waits here a little longer for its rest, and goes on as it is only if nothing continues it.
 *
 * The library also splits a key sent with ESC before it ("ESC ESC [1;2D", Shift+Option+← in macOS Terminal
 * with "Use Option as Meta key") into Escape and the key, handed over at once. Escape is waiting here
 * then, so the two are joined again: otherwise Escape would clear the message.
 */

const ESC = "\x1b";
/** How long a lone start of a sequence waits for the rest before it goes on as it is. */
const WAIT_MS = 20;
/** Longer than any sequence a terminal sends as input: past this it's not one. */
const MAX = 64;
/** A key sent as CSI (arrows, Home/End, function and editing keys, kitty's keys), not a mouse report or paste mark. */
const CSI_KEY = /^\x1b\[[\d;]*[A-DFHP-S~u]$/;
const PASTE_MARK = /^\x1b\[20[01]~$/;

/**
 * Where the escape sequence at the start of `s` ends: its length if it's complete, "more" if `s` is the
 * start of one, or "broken" if what follows can't continue it. Only CSI (ESC [ params intermediates final)
 * is followed, which is what mouse reports and most keys are; anything else after ESC is its own key.
 */
export function sequenceEnd(s: string): number | "more" | "broken" {
  if (s[0] !== ESC) return "broken";
  if (s.length === 1) return "more";
  if (s[1] !== "[") return "broken";
  // The old X10 mouse report: ESC [ M and three bytes.
  if (s[2] === "M") return s.length >= 6 ? 6 : "more";
  let i = 2;
  while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x3f) i++; // parameters: digits ; < = > ?
  while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x2f) i++; // intermediates
  if (i === s.length) return s.length > MAX ? "broken" : "more";
  const c = s.charCodeAt(i);
  return c >= 0x40 && c <= 0x7e ? i + 1 : "broken";
}

/**
 * Wraps a terminal's input handler so a sequence that arrives in pieces reaches it whole. Input that isn't
 * the start of an unfinished sequence passes straight through, unchanged.
 */
export function wholeSequences(onInput: (data: string) => void, waitMs = WAIT_MS): (data: string) => void {
  let held = "";
  let timer: NodeJS.Timeout | undefined;
  let turn = 0;

  const release = () => {
    const h = held;
    held = "";
    if (h) onInput(h);
  };
  const hold = (s: string) => {
    held = s;
    const mine = ++turn;
    // Wait one more step after the timer: if the app was busy, input that came meanwhile is read first.
    timer = setTimeout(() => setImmediate(() => mine === turn && release()), waitMs);
  };
  const fresh = (data: string) => {
    if (data && sequenceEnd(data) === "more") hold(data);
    else if (data) onInput(data);
  };

  return (data: string) => {
    if (!held) return fresh(data);
    clearTimeout(timer);
    turn++;
    const joined = held + data;
    // Escape followed at once by a key is that key with ESC before it, as the terminal sent it.
    if (held === ESC && CSI_KEY.test(data) && !PASTE_MARK.test(data)) {
      held = "";
      return onInput(joined);
    }
    const end = sequenceEnd(joined);
    if (end === "more") return hold(joined);
    // Not a continuation (a lone ESC followed by anything but "[" is the Escape key, then that key).
    if (end === "broken") {
      release();
      return fresh(data);
    }
    held = "";
    // A paste's start mark goes on with the paste, as the terminal sent it.
    if (joined.startsWith("\x1b[200~")) return onInput(joined);
    onInput(joined.slice(0, end));
    fresh(joined.slice(end));
  };
}
