import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { PermissionRequest, PermissionResponse } from "../acp/session.js";

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
}

/** Where an agent may freely change and delete things: its own folder and its workspace. */
export interface PermissionScope {
  roots: string[];
}

/** Start of a command: the beginning, or after ; & | ( ` and optional env assignments. */
const AT_CMD = String.raw`(?:^|[;&|(\x60]|\n)\s*(?:\w+=\S*\s+)*`;

/** The few things that must never slip through, wherever they point. */
const HARD_STOPS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|partitionDisk|zeroDisk|secureErase|reformat))\b/, reason: "erases a disk" },
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\/(?!null\b)/, reason: "writes directly to a device" },
  { pattern: /\b(DROP|TRUNCATE)\s+(DATABASE|SCHEMA|TABLE)\b/i, reason: "drops or empties a database table" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: new RegExp(`${AT_CMD}(shutdown|reboot|halt|poweroff)(\\s|$)`), reason: "shuts the machine down" },
  { pattern: new RegExp(`${AT_CMD}(sudo|doas)\\s`), reason: "needs administrator rights" },
  { pattern: /\bchmod\s+(-\w+\s+)*-R\s+(-\w+\s+)*[0-7]*7[0-7]*\s+\/(\s|$)/, reason: "changes permissions on the whole disk" },
];

/** Branches nobody should ever force-push to. */
const PROTECTED_BRANCH = /^(main|master|trunk|develop|development|prod|production|release.*|HEAD)$/;

/** A force push to a protected branch, or one that doesn't say which branch (it may be main). */
function badForcePush(cmd: string): boolean {
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const m = /\bgit\s+(?:-\S+\s+)*push\b(.*)$/.exec(seg.trim());
    if (!m) continue;
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    const force = words.some((w) => w === "-f" || w === "--force" || w.startsWith("--force-with-lease") || w === "--force-if-includes" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w));
    const plusRef = words.filter((w) => w.startsWith("+") && w.length > 1);
    if (!force && !plusRef.length) continue;
    if (words.includes("--mirror") || words.includes("--all")) return true;
    const refs = words.filter((w) => !w.startsWith("-")).slice(1); // after the remote
    if (!refs.length) return true;
    for (const r of refs) {
      if (!force && !r.startsWith("+")) continue;
      const dest = r.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "");
      if (!dest || PROTECTED_BRANCH.test(dest)) return true;
    }
  }
  return false;
}

const DESTRUCTIVE_WORD = /^(rm|rmdir|unlink|shred|trash|mv|truncate|srm)$/;

function within(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
}

function expand(p: string, cwd: string): string {
  const h = p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());
  return isAbsolute(h) ? resolve(h) : resolve(cwd, h);
}

/** A shell word: its text with quotes removed, and whether some of it can only be known when it runs. */
interface Word {
  text: string;
  dynamic: boolean;
  /** Was the whole word quoted (so it is one argument, e.g. a script for -c). */
  quoted: boolean;
}
type Token = { word: Word } | { op: string };

/**
 * Split a command line the way a POSIX shell would, closely enough to see what each command acts on:
 * quotes, escapes, operators (; && || | & newlines), redirections and $(...) / backticks.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let cur = null as Word | null;
  const flush = () => {
    if (cur) out.push({ word: cur });
    cur = null;
  };
  const w = () => (cur ??= { text: "", dynamic: false, quoted: true });
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      flush();
      i++;
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      flush();
      const two = src.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ";;") {
        out.push({ op: two });
        i += 2;
      } else if (c === "&" && src[i + 1] === ">") {
        out.push({ op: ">" });
        i += src[i + 2] === ">" ? 3 : 2;
      } else {
        out.push({ op: c });
        i++;
      }
    } else if (c === ">" || c === "<") {
      // Leading fd number belongs to the redirection (2>file), not to the previous word.
      if (cur && /^\d+$/.test((cur as Word).text) && !(cur as Word).dynamic) cur = null;
      flush();
      let op = c;
      i++;
      if (src[i] === c) {
        op += c;
        i++;
      }
      if (src[i] === "&") {
        // 2>&1 and friends duplicate a descriptor; they write nothing.
        i++;
        while (i < src.length && /[\d-]/.test(src[i])) i++;
        continue;
      }
      if (src[i] === "|") i++;
      out.push({ op });
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      w().text += src.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          w().text += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "$" || src[i] === "`") w().dynamic = true;
        w().text += src[i++];
      }
      i++;
    } else if (c === "\\") {
      w().text += src[i + 1] ?? "";
      w().quoted = false;
      i += 2;
    } else if (c === "$" && src[i + 1] === "(") {
      // Command substitution: what it prints is unknowable; the command inside is checked too.
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      const inner = src.slice(i + 2, j);
      out.push({ op: "subst:" + inner });
      w().dynamic = true;
      w().quoted = false;
      w().text += "$(…)";
      i = j + 1;
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      out.push({ op: "subst:" + src.slice(i + 1, end < 0 ? undefined : end) });
      w().dynamic = true;
      w().quoted = false;
      w().text += "`…`";
      i = end < 0 ? src.length : end + 1;
    } else {
      if (c === "$") w().dynamic = true;
      // Brace expansion (~{,}, a{1..3}) turns one word into several paths: they can't be checked as written.
      if (c === "{") {
        const m = /^\{[^\s{}]*(,|\.\.)[^\s{}]*\}/.exec(src.slice(i));
        if (m) w().dynamic = true;
      }
      w().text += c;
      w().quoted = false;
      i++;
    }
  }
  flush();
  return out;
}

/** Simple commands (words up to an operator), each with its redirection targets. */
function commands(tokens: Token[]): { words: Word[]; redirects: { op: string; target: Word }[]; subst: string[] }[] {
  const cmds: { words: Word[]; redirects: { op: string; target: Word }[]; subst: string[] }[] = [];
  let cur = { words: [] as Word[], redirects: [] as { op: string; target: Word }[], subst: [] as string[] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ("word" in t) cur.words.push(t.word);
    else if (t.op.startsWith("subst:")) cur.subst.push(t.op.slice(6));
    else if (t.op === ">" || t.op === ">>" || t.op === "<" || t.op === "<<") {
      const next = tokens[i + 1];
      if (next && "word" in next) {
        cur.redirects.push({ op: t.op, target: next.word });
        i++;
      }
    } else {
      cmds.push(cur);
      cur = { words: [], redirects: [], subst: [] };
    }
  }
  cmds.push(cur);
  return cmds.filter((c) => c.words.length || c.redirects.length || c.subst.length);
}

/** Inline code that deletes or moves files, in the languages agents reach for. */
const INLINE_DELETE = /\b(rmtree|rmSync|rmdirSync|unlinkSync|unlink|remove|removedirs|rmdir|rm_rf|rm_r|rename|renameSync|move|truncate|FileUtils\.rm|Deno\.remove)\b/;
/** Inline code that runs other programs: the commands it passes are checked like any shell command. */
const INLINE_SPAWN = /\b(os\.system|os\.popen|subprocess|child_process|execSync|execFileSync|spawnSync|Deno\.Command|system|exec|spawn)\b/;
/** A temporary path made by mktemp: as a substitution, or a variable assigned from one. */
const MKTEMP = /^\$\(\s*mktemp\b[^)]*\)$/;
const INTERPRETERS = /^(python\d*(\.\d+)?|node|nodejs|deno|bun|perl|ruby|php|osascript|tclsh|lua)$/;
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish)$/;
/** Programs that just run the rest of their arguments as a command. */
const WRAPPERS = /^(env|command|builtin|exec|nohup|nice|time|timeout|caffeinate|xcrun|stdbuf|ionice|chronic|unbuffer)$/;

const SAFE_DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

interface Finding {
  outside: string[];
  unknown: boolean;
}

/**
 * What a shell command line deletes, moves or overwrites, following `cd`, unwrapping `sh -c`, `eval`,
 * `env`/`nohup`-style wrappers, `xargs`, `find -delete`/`-exec`, `git clean`, redirections and inline
 * scripts (`python -c`, `node -e`...). Paths outside the roots are reported; so is anything whose
 * target can't be known before it runs.
 */
function inspect(cmd: string, cwd: string, roots: string[], depth = 0): Finding {
  const f: Finding = { outside: [], unknown: false };
  if (depth > 4) return { outside: [], unknown: true };
  let here = cwd;
  // Variables this command line set from mktemp: deleting them later is deleting a temp file.
  const temps = new Set<string>();
  let substHere: string[] = [];
  const isTemp = (w: Word) => {
    if (MKTEMP.test(w.text)) return true;
    if (w.text === "$(…)" && substHere.length === 1 && /^\s*mktemp\b/.test(substHere[0])) return true;
    const v = /^\$\{?(\w+)\}?(\/[^$`]*)?$/.exec(w.text);
    return !!v && temps.has(v[1]);
  };
  const target = (w: Word) => {
    if (w.dynamic && isTemp(w)) return;
    if (w.dynamic && !/^\$\{?HOME\}?(\/[^$`]*)?$/.test(w.text)) {
      f.unknown = true;
      return;
    }
    const p = expand(w.text, here);
    if (!within(p, roots)) f.outside.push(p);
  };
  const merge = (g: Finding) => {
    f.outside.push(...g.outside);
    f.unknown ||= g.unknown;
  };
  for (const c of commands(tokenize(cmd))) {
    substHere = c.subst;
    for (const s of c.subst) merge(inspect(s, here, roots, depth + 1));
    // NAME=$(mktemp ...) on its own: remember NAME as a temp path.
    const asg = c.words.length === 1 ? /^(\w+)=/.exec(c.words[0].text) : null;
    if (asg && (c.subst.some((x) => /^\s*mktemp\b/.test(x)) || MKTEMP.test(c.words[0].text.slice(asg[0].length)))) temps.add(asg[1]);
    // Truncating redirections overwrite files: check where they point.
    for (const r of c.redirects) if (r.op === ">" && !SAFE_DEVICES.test(r.target.text)) target(r.target);
    let words = c.words.filter((w, i) => !(i === 0 && /^\w+=/.test(w.text) && !w.quoted));
    while (words.length && /^\w+=/.test(words[0].text)) words = words.slice(1);
    // Unwrap programs that only run the rest of their arguments.
    while (words.length && WRAPPERS.test(base(words[0].text))) {
      words = words.slice(1);
      while (words.length && (words[0].text.startsWith("-") || /^\w+=/.test(words[0].text) || /^\d+[smhd]?$/.test(words[0].text))) words = words.slice(1);
    }
    if (!words.length) continue;
    const prog = base(words[0].text);
    const args = words.slice(1);
    if (prog === "cd") {
      const to = args[0];
      if (!to) here = homedir();
      else if (to.dynamic && !/^\$\{?HOME\}?/.test(to.text)) f.unknown = true;
      else here = expand(to.text, here);
      continue;
    }
    if (prog === "eval") {
      merge(inspect(args.map((a) => a.text).join(" "), here, roots, depth + 1));
      if (args.some((a) => a.dynamic)) f.unknown = true;
      continue;
    }
    if (SHELLS.test(prog)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
      if (ci >= 0 && args[ci + 1]) merge(inspect(args[ci + 1].text, here, roots, depth + 1));
      else if (args[0] && !args[0].text.startsWith("-")) f.unknown ||= false; // runs a script file: protected paths stay read-only for it (see sandbox.ts)
      continue;
    }
    if (INTERPRETERS.test(prog)) {
      const ci = args.findIndex((a) => /^-(c|e|E|-eval|-command|p)$/.test(a.text) || a.text === "-");
      const code = ci >= 0 ? args[ci + 1]?.text ?? "" : "";
      const strings = [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
      const pathLike = (x: string) => /^(~|\/|\.\.?\/|\$HOME|\$\{HOME\})/.test(x);
      if (code && INLINE_DELETE.test(code)) {
        // Every path the code mentions must be inside the roots; one it builds from your home folder can't be checked.
        for (const l of strings.filter(pathLike)) target({ text: l, dynamic: false, quoted: true });
        if (/\b(homedir|expanduser|os\.environ|process\.env|Path\.home|ENV\[|getenv)\b/.test(code)) f.unknown = true;
      }
      if (code && INLINE_SPAWN.test(code)) {
        // A command passed as one string is a shell line; one passed as a list is checked if it deletes.
        for (const str of strings) if (/\s/.test(str)) merge(inspect(str, here, roots, depth + 1));
        if (strings.some((x) => DESTRUCTIVE_WORD.test(base(x)))) for (const l of strings.filter(pathLike)) target({ text: l, dynamic: false, quoted: true });
      }
      continue;
    }
    if (prog === "xargs") {
      // The paths come from its input: never knowable here.
      const rest = args.filter((a) => !a.text.startsWith("-"));
      if (rest.some((a) => DESTRUCTIVE_WORD.test(base(a.text)) || SHELLS.test(base(a.text)))) f.unknown = true;
      continue;
    }
    if (DESTRUCTIVE_WORD.test(prog)) {
      for (const a of args) {
        if (a.text.startsWith("-") && !a.quoted) continue;
        target(a);
      }
      continue;
    }
    if (prog === "find") {
      const deletes = args.some((a) => a.text === "-delete") || args.some((a, j) => (a.text === "-exec" || a.text === "-execdir" || a.text === "-ok") && (DESTRUCTIVE_WORD.test(base(args[j + 1]?.text ?? "")) || SHELLS.test(base(args[j + 1]?.text ?? ""))));
      if (!deletes) continue;
      const starts: Word[] = [];
      for (const a of args) {
        if (a.text.startsWith("-") || a.text === "(" || a.text === "!") break;
        starts.push(a);
      }
      if (!starts.length) starts.push({ text: ".", dynamic: false, quoted: false });
      for (const s of starts) target(s);
      continue;
    }
    if (prog === "git") {
      let dir = here;
      let k = 0;
      while (k < args.length && args[k].text.startsWith("-")) {
        if (args[k].text === "-C" && args[k + 1]) {
          dir = expand(args[k + 1].text, here);
          k += 2;
        } else k++;
      }
      const sub = args[k]?.text;
      if (sub === "clean" || (sub === "checkout" && args.slice(k + 1).some((a) => a.text === "--" || a.text === ".")) || (sub === "reset" && args.some((a) => a.text === "--hard"))) {
        if (!within(dir, roots)) f.outside.push(dir);
      }
      continue;
    }
  }
  return f;
}

function base(p: string): string {
  return p.replace(/^.*\//, "");
}

/**
 * Decide a permission request instantly, without a model, so no session ever waits on one.
 * Inside the agent's own folder and workspace, anything goes. Destruction outside them, and a short
 * list of never-ever actions, is declined with a reason; the agent can then ask the person.
 */
export function judge(req: PermissionRequest, given: PermissionScope, cwd: string): PermissionDecision {
  // Temporary folders are scratch space for everyone.
  const scope = { roots: [...given.roots, tmpdir(), "/tmp", "/private/tmp"].filter(Boolean).map((r) => resolve(r)) };
  const tc = req.toolCall as any;
  const input = tc?.rawInput ?? {};
  const command: string = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : Array.isArray(input.command) ? commandLine(input.command) : "";
  // A shell tool that sends no command shows it only in its title. Each backend words titles its own
  // way (some add the folder or a description), so a title is checked for the never-ever actions and
  // for paths outside, but not declined for having parts that can't be read as a command.
  const fromTitle = !command && tc?.kind === "execute" && typeof tc?.title === "string";
  const shell = command || (fromTitle ? tc.title : "");
  for (const h of HARD_STOPS) if (h.pattern.test(shell)) return { allowed: false, reason: h.reason };
  if (badForcePush(shell)) return { allowed: false, reason: "force-pushes to a main branch (or without naming the branch), which rewrites shared history. Ask the person first." };
  if (shell) {
    const f = inspect(shell, cwd, scope.roots);
    if (f.outside.length) return { allowed: false, reason: `deletes, moves or overwrites something outside your folder and workspace (${[...new Set(f.outside)].slice(0, 3).join(", ")}). Ask the person first.` };
    if (f.unknown && !fromTitle) return { allowed: false, reason: "deletes, moves or overwrites files whose paths aren't known until it runs (a variable, piped names, or code that builds paths). Write the paths out in full so they can be checked, or ask the person." };
  }
  // File edits/deletes reported as structured tool calls (not shell).
  const paths: string[] = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input[k] === "string") paths.push(expand(input[k], cwd));
  for (const l of tc?.locations ?? []) if (typeof l?.path === "string") paths.push(expand(l.path, cwd));
  const kind = tc?.kind as string | undefined;
  if ((kind === "delete" || kind === "move") && paths.some((p) => !within(p, scope.roots))) {
    return { allowed: false, reason: "deletes or moves a file outside your folder and workspace. Ask the person first." };
  }
  return { allowed: true, reason: "autonomous" };
}

/**
 * A command sent as a list of arguments, as one shell line: a shell running a script (["zsh", "-lc",
 * "…"]) is that script; anything else is its arguments, each quoted so spaces stay inside them.
 */
function commandLine(argv: unknown[]): string {
  const args = argv.map(String);
  const exe = args[0]?.split("/").pop() ?? "";
  if (["sh", "bash", "zsh", "dash"].includes(exe) && args.length === 3 && (args[1] === "-c" || args[1] === "-lc")) return args[2];
  return args.map((a) => (a && [...a].every((ch) => /[A-Za-z0-9_@%+=:,./-]/.test(ch)) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
}

/** Answer immediately. Never "always": every request comes back here, so the guard sees every action. */
export function answer(req: PermissionRequest, decision: PermissionDecision): PermissionResponse {
  const opts = req.options ?? [];
  const pick = decision.allowed ? opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") : opts.find((o) => o.kind === "reject_once") ?? opts.find((o) => o.kind === "reject_always");
  if (!pick) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: pick.optionId } };
}
