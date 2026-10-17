import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { home, paths } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";
import { withLock } from "../store/mutex.js";
import { packageVersion } from "./build.js";

/**
 * Auto-update: once a day, and each time the daemon starts, Overtime asks the npm registry for its latest
 * version. If that is newer, it installs it the way it was installed (npm, pnpm, bun or yarn, globally),
 * then hands over to the new version's daemon, which resumes everything that was running (see
 * Runtime.recover). Never a downgrade, and never from a source checkout or an `npm link` (development).
 * Off with `autoUpdate: false` in settings.json (overtime set autoUpdate=off, or the app's settings).
 */
export const PACKAGE = "@ukanwat/overtime";
const DAY_MS = 24 * 3600_000;

/** What Overtime keeps about updating, in update.json in its home. */
interface UpdateState {
  /** The version the last daemon to start ran. */
  running?: string;
  /** When the registry was last asked. */
  checkedAt?: string;
  /** The last version an install was tried for, and when: one that didn't take isn't tried again for a day. */
  tried?: { version: string; at: string };
  /** The version a failed install was already reported to the person for (they hear once). */
  alerted?: string;
  /** What the app shows once, the next time it's open. */
  notice?: { text: string; tone: "ok" | "err" } | null;
}

const statePath = () => join(home(), "update.json");

async function patchState(fn: (s: UpdateState) => UpdateState | void): Promise<UpdateState> {
  return withLock("update-state", async () => {
    const s = await readJson<UpdateState>(statePath(), {});
    const next = fn(s) ?? s;
    await writeJson(statePath(), next);
    return next;
  });
}

/**
 * Order two versions ("0.7.9", "1.0.0-beta.2") as semver does: by major, minor and patch, and a
 * pre-release before its release. NaN if either isn't a version.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `latest` is a newer version than `current` (false for anything that isn't a version: never a guess). */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/** How this copy of Overtime was installed, or why it can't update itself. */
export type Install = { manager: "npm" | "pnpm" | "bun" | "yarn"; root: string; prefix?: string } | { skip: string };

/** The folder this copy of Overtime runs from (where its package.json is). */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * How Overtime was installed, from where it runs: a global install of npm (…/lib/node_modules/@ukanwat/overtime),
 * pnpm (…/pnpm/global/…, or its .pnpm store), bun (~/.bun/install/global) or yarn (…/yarn/global). Anything
 * else isn't updated: a source checkout, an `npm link` to one (its real folder isn't in a node_modules), npx's
 * cache, or a project's own node_modules.
 */
export function installInfo(root = packageRoot(), platform = process.platform): Install {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {}
  const s = platform === "win32" ? "\\" : sep;
  const has = (...parts: string[]) => real.includes(s + parts.join(s) + s);
  if (existsSync(join(real, ".git")) || existsSync(join(real, "src", "cli.ts"))) return { skip: "it runs from a source checkout" };
  if (!real.split(/[\\/]/).includes("node_modules")) return { skip: "it is linked to a source folder (npm link)" };
  if (has("_npx")) return { skip: "it runs through npx" };
  if (has(".bun", "install", "global")) return { manager: "bun", root: real };
  if (has(".pnpm") || has("pnpm", "global")) {
    // pnpm runs it from its store (…/.pnpm/@ukanwat+overtime@0.7.8/node_modules/@ukanwat/overtime); the global
    // folder links to the installed version (…/node_modules/@ukanwat/overtime), which is where a new one appears.
    return { manager: "pnpm", root: real.replace(/[\\/]\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/]/, `${s}node_modules${s}`) };
  }
  if (has("yarn", "global")) return { manager: "yarn", root: real };
  const tail = (platform === "win32" ? ["node_modules", "@ukanwat", "overtime"] : ["lib", "node_modules", "@ukanwat", "overtime"]).join(s);
  if (real.endsWith(s + tail)) return { manager: "npm", root: real, prefix: real.slice(0, -tail.length - 1) };
  return { skip: `it is installed in a project (${real}), not globally` };
}

/** The command that installs a version the way Overtime was installed, and the same in words for the person. */
export interface InstallCommand {
  file: string;
  args: string[];
  text: string;
  env?: Record<string, string>;
}

export function installCommand(inst: Exclude<Install, { skip: string }>, version: string): InstallCommand {
  const pkg = `${PACKAGE}@${version}`;
  switch (inst.manager) {
    case "pnpm":
      return { file: "pnpm", args: ["add", "-g", pkg], text: `pnpm add -g ${pkg}` };
    case "bun":
      return { file: "bun", args: ["add", "-g", pkg], text: `bun add -g ${pkg}` };
    case "yarn":
      return { file: "yarn", args: ["global", "add", pkg], text: `yarn global add ${pkg}` };
    default:
      // Into the same global folder it's in now, whichever npm comes first on the PATH.
      return { file: "npm", args: ["i", "-g", pkg], text: `npm i -g ${pkg}`, env: inst.prefix ? { npm_config_prefix: inst.prefix } : undefined };
  }
}

/** Run an install. The node that runs Overtime comes first on the PATH, so its own npm is the one used. */
export function runInstall(c: InstallCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), ...c.env };
    execFile(c.file, c.args, { env, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32" }, (e, _out, err) => {
      if (!e) return resolve();
      const tail = String(err ?? "").trim().split("\n").slice(-6).join("\n");
      reject(Object.assign(new Error(tail || e.message), { code: (e as any).code }));
    });
  });
}

/** The latest version on the npm registry (its "latest" tag). */
export async function latestVersion(): Promise<string> {
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "");
  const r = await fetch(`${registry}/-/package/${PACKAGE.replace("/", "%2f")}/dist-tags`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`the registry answered ${r.status}`);
  const latest = ((await r.json()) as { latest?: unknown }).latest;
  if (typeof latest !== "string") throw new Error("the registry gave no latest version");
  return latest;
}

/** The version of Overtime in a folder, or null. */
function versionIn(root: string): string | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Note which version this daemon runs. Returns the version it replaced when that was older (an update,
 * whether Overtime updated itself or the person did), and then the app says "Updated to …" once.
 */
export async function noteRunningVersion(version = packageVersion()): Promise<string | null> {
  let from: string | null = null;
  await patchState((s) => {
    if (s.running && isNewer(version, s.running)) {
      from = s.running;
      s.notice = { text: `Updated to ${version}`, tone: "ok" };
    }
    s.running = version;
  });
  return from;
}

/** What the app should show once about updating, if anything: taken, so it shows once. */
export async function takeNotice(): Promise<{ text: string; tone: "ok" | "err" } | null> {
  let notice: UpdateState["notice"] = null;
  await patchState((s) => {
    notice = s.notice ?? null;
    delete s.notice;
  });
  return notice;
}

/**
 * Start the new version's daemon once this one (pid) has exited: a separate process of its own, so it
 * outlives this one. When a login item runs the daemon, the exit code asks it to start it again too;
 * of the two, the single-daemon lock lets one run.
 */
export function relaunchAfterExit(pid: number, mainJs: string): void {
  const script = `
const [pid, main, log] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
const since = Date.now();
const wait = () => {
  if (alive() && Date.now() - since < 120000) return setTimeout(wait, 250);
  const out = require("node:fs").openSync(log, "a");
  require("node:child_process").spawn(process.execPath, [main], { detached: true, stdio: ["ignore", out, out] }).unref();
};
wait();`;
  spawn(process.execPath, ["-e", script, String(pid), mainJs, paths.daemonLog()], { detached: true, stdio: "ignore", env: process.env }).unref();
}

/** The exit code of a daemon handing over to a newer one: not 0, so a login item (launchd, systemd) starts it again. */
export const HANDOVER_EXIT = 75;

export interface UpdaterDeps {
  log: (line: string) => void;
  notify: (title: string, body: string) => void;
  /** Hand over to the new version: start its daemon (its main.js) once this one has stopped, and stop. */
  handover: (version: string, mainJs: string) => Promise<void> | void;
  /** The rest are replaced by tests. */
  latest?: () => Promise<string>;
  install?: () => Install;
  run?: (c: InstallCommand) => Promise<void>;
  installedVersion?: (root: string) => string | null;
  current?: string;
  autoUpdate?: () => Promise<boolean>;
  now?: () => number;
}

export type CheckResult = "off" | "skip" | "busy" | "unreachable" | "current" | "tried" | "failed" | "updated";

export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Said once per daemon: why it doesn't update itself. */
  private skipSaid = false;
  private stopped = false;

  constructor(private readonly d: UpdaterDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Check now, then once a day (looked at every hour, so a sleeping laptop catches up when it wakes). */
  start(): void {
    void this.check("the daemon started");
    this.timer = setInterval(() => void this.checkIfDue(), 3600_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async checkIfDue(): Promise<void> {
    const s = await readJson<UpdateState>(statePath(), {});
    if (!s.checkedAt || this.now() - Date.parse(s.checkedAt) >= DAY_MS) await this.check("daily check");
  }

  async check(why: string): Promise<CheckResult> {
    if (this.busy || this.stopped) return "busy";
    this.busy = true;
    try {
      return await this.checkNow(why);
    } finally {
      this.busy = false;
    }
  }

  private async checkNow(why: string): Promise<CheckResult> {
    const { log } = this.d;
    const on = this.d.autoUpdate ? await this.d.autoUpdate() : (await import("../settings.js").then((m) => m.loadSettings())).autoUpdate !== false;
    if (!on) return "off";
    const inst = (this.d.install ?? installInfo)();
    if ("skip" in inst) {
      if (!this.skipSaid) log(`auto-update: off, because ${inst.skip}`);
      this.skipSaid = true;
      return "skip";
    }
    const current = this.d.current ?? packageVersion();
    let latest: string;
    try {
      latest = await (this.d.latest ?? latestVersion)();
    } catch (e: any) {
      log(`auto-update: couldn't ask the npm registry (${why}): ${e?.message ?? e}`);
      return "unreachable";
    }
    const at = new Date(this.now()).toISOString();
    const state = await patchState((s) => void (s.checkedAt = at));
    // Never a downgrade: an older or equal latest (a version pulled from the registry, or a newer local build) stays as it is.
    if (!isNewer(latest, current)) return "current";
    if (state.tried?.version === latest && this.now() - Date.parse(state.tried.at) < DAY_MS) return "tried";
    const cmd = installCommand(inst, latest);
    log(`auto-update: ${current} → ${latest} (${why}): ${cmd.text}`);
    await patchState((s) => void (s.tried = { version: latest, at }));
    try {
      await (this.d.run ?? runInstall)(cmd);
      const got = (this.d.installedVersion ?? versionIn)(inst.root);
      if (got !== latest) throw new Error(`after installing, ${inst.root} holds ${got ?? "no Overtime"}, not ${latest}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      log(`auto-update: installing ${latest} failed: ${msg}`);
      const denied = /EACCES|EPERM|permission denied/i.test(msg) || e?.code === "EACCES";
      const missing = e?.code === "ENOENT";
      const where = inst.manager === "npm" && inst.prefix ? inst.prefix : inst.root;
      const reason = denied ? ` (no permission to write to ${where})` : missing ? ` (${cmd.file} isn't on the PATH Overtime runs with)` : "";
      const text = `Overtime couldn't update itself to ${latest}${reason}. To update, run: ${cmd.text}`;
      await patchState((s) => {
        if (s.alerted === latest) return;
        s.alerted = latest;
        s.notice = { text, tone: "err" };
        this.d.notify("Overtime couldn't update itself", `To update to ${latest}, run: ${cmd.text}`);
      });
      return "failed";
    }
    log(`auto-update: installed ${latest}; handing over to its daemon (everything running carries on there)`);
    await this.d.handover(latest, join(inst.root, "dist", "daemon", "main.js"));
    return "updated";
  }
}
