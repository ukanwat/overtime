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
const DESTRUCTIVE = /(^|[\s;&|(`])(rm|rmdir|unlink|shred|trash|mv|truncate|srm)\b|\s-delete\b|\bgit\b[^;&|\n]*\sclean\b/;

function within(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
}

function unquote(p: string): string {
  return p.replace(/^(['"])(.*)\1$/, "$2");
}

function expand(p: string, cwd: string): string {
  const unq = unquote(p);
  const h = unq === "~" ? homedir() : unq.startsWith("~/") ? homedir() + unq.slice(1) : unq.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());
  return isAbsolute(h) ? resolve(h) : resolve(cwd, h);
}

/** A path we can't know before the shell runs: a variable, a command substitution. */
function unknowable(w: string): boolean {
  const unq = unquote(w).replace(/^\$\{?HOME\}?(?=\/|$)/, "");
  return /[$`]/.test(unq);
}

/**
 * What a destructive shell command acts on, following `cd` between commands. Returns the paths, and
 * whether some target can't be known in advance (a variable, or names piped in from elsewhere).
 */
function targets(cmd: string, cwd: string): { paths: string[]; unknown: boolean } {
  const paths: string[] = [];
  let unknown = false;
  let here = cwd;
  for (const raw of cmd.split(/&&|\|\||;|\n/)) {
    for (const seg of raw.split("|")) {
      const words = seg.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      if (words[0] === "cd") {
        const to = words[1];
        if (!to || to === "~") here = homedir();
        else if (unknowable(to)) unknown = true;
        else here = expand(to, here);
        continue;
      }
      const i = words.findIndex((w) => DESTRUCTIVE_WORD.test(w.replace(/^.*\//, "")));
      if (i >= 0) {
        const args = words.slice(i + 1).filter((w) => w && !w.startsWith("-"));
        if (!args.length && (words.slice(0, i).some((w) => w === "xargs") || /^\s*xargs\b/.test(seg))) unknown = true;
        for (const w of args) unknowable(w) ? (unknown = true) : paths.push(expand(w, here));
      }
      // find <paths> ... -delete / -exec rm: what it deletes lies under the paths it searches.
      if (words[0] === "find" && (words.includes("-delete") || words.some((w, j) => (w === "-exec" || w === "-execdir") && DESTRUCTIVE_WORD.test((words[j + 1] ?? "").replace(/^.*\//, ""))))) {
        const roots = [];
        for (const w of words.slice(1)) {
          if (w.startsWith("-") || w === "(" || w === "!") break;
          roots.push(w);
        }
        if (!roots.length) roots.push(".");
        for (const w of roots) unknowable(w) ? (unknown = true) : paths.push(expand(w, here));
      }
      // git clean deletes untracked files in the repo it runs in.
      if (/^git$/.test(words[0]) && words.includes("clean")) {
        const c = words.indexOf("-C");
        paths.push(c >= 0 && words[c + 1] ? expand(words[c + 1], here) : here);
      }
    }
  }
  return { paths, unknown };
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
  const command: string = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : Array.isArray(input.command) ? input.command.join(" ") : "";
  // Shell tools sometimes only show the command in the title.
  const shell = command || (tc?.kind === "execute" && typeof tc?.title === "string" ? tc.title : "");
  for (const h of HARD_STOPS) if (h.pattern.test(shell)) return { allowed: false, reason: h.reason };
  if (badForcePush(shell)) return { allowed: false, reason: "force-pushes to a main branch (or without naming the branch), which rewrites shared history. Ask the person first." };
  if (shell && DESTRUCTIVE.test(shell)) {
    const t = targets(shell, cwd);
    const outside = t.paths.filter((p) => !within(p, scope.roots));
    if (outside.length) return { allowed: false, reason: `deletes or moves something outside your folder and workspace (${outside.slice(0, 3).join(", ")}). Ask the person first.` };
    if (t.unknown) return { allowed: false, reason: "deletes or moves files whose paths aren't known until it runs (a variable or piped names). Write the paths out in full so they can be checked, or ask the person." };
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

/** Answer immediately. Never "always": every request comes back here, so the guard sees every action. */
export function answer(req: PermissionRequest, decision: PermissionDecision): PermissionResponse {
  const opts = req.options ?? [];
  const pick = decision.allowed ? opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") : opts.find((o) => o.kind === "reject_once") ?? opts.find((o) => o.kind === "reject_always");
  if (!pick) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: pick.optionId } };
}
