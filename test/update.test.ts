import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome, here, until } from "./helpers.js";

const home = fakeHome();
const { compareVersions, isNewer, installInfo, installCommand, packageRoot, noteRunningVersion, takeNotice, relaunchAfterExit, Updater } = await import("../src/daemon/update.js");
const { loadSettings } = await import("../src/settings.js");
const { Runtime } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");

describe("versions", () => {
  it("orders versions as semver does", () => {
    expect(compareVersions("0.7.9", "0.7.8")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.7.8", "0.7.8")).toBe(0);
    expect(compareVersions("v0.7.8", "0.7.8")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1.1")).toBeLessThan(0);
  });

  it("is never newer for an older or equal version, or for something that isn't a version", () => {
    expect(isNewer("0.7.9", "0.7.8")).toBe(true);
    expect(isNewer("0.7.7", "0.7.8")).toBe(false);
    expect(isNewer("0.7.8", "0.7.8")).toBe(false);
    expect(isNewer("latest", "0.7.8")).toBe(false);
    expect(isNewer("0.8", "0.7.8")).toBe(false);
    expect(isNewer("0.7.9", "?")).toBe(false);
  });
});

describe("how Overtime was installed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "overtime-installs-")));
  /** A copy of the package at this path (just its package.json). */
  const pkg = (...parts: string[]) => {
    const dir = join(root, ...parts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ukanwat/overtime", version: "0.7.8" }));
    return dir;
  };

  it("finds npm, pnpm, bun and yarn global installs, and the command for each", () => {
    const npm = pkg("usr", "lib", "node_modules", "@ukanwat", "overtime");
    expect(installInfo(npm, "darwin")).toEqual({ manager: "npm", root: npm, prefix: join(root, "usr") });
    const bun = pkg(".bun", "install", "global", "node_modules", "@ukanwat", "overtime");
    expect(installInfo(bun, "darwin")).toEqual({ manager: "bun", root: bun });
    // pnpm runs it from its store; the new version appears where the global folder links to it.
    const pnpm = pkg("Library", "pnpm", "global", "5", ".pnpm", "@ukanwat+overtime@0.7.8", "node_modules", "@ukanwat", "overtime");
    expect(installInfo(pnpm, "darwin")).toEqual({ manager: "pnpm", root: join(root, "Library", "pnpm", "global", "5", "node_modules", "@ukanwat", "overtime") });
    const yarn = pkg(".config", "yarn", "global", "node_modules", "@ukanwat", "overtime");
    expect(installInfo(yarn, "darwin")).toEqual({ manager: "yarn", root: yarn });

    const npmCmd = installCommand({ manager: "npm", root: npm, prefix: join(root, "usr") }, "0.7.9");
    expect(npmCmd).toEqual({ file: "npm", args: ["i", "-g", "@ukanwat/overtime@0.7.9"], text: "npm i -g @ukanwat/overtime@0.7.9", env: { npm_config_prefix: join(root, "usr") } });
    expect(installCommand({ manager: "pnpm", root: pnpm }, "0.7.9").text).toBe("pnpm add -g @ukanwat/overtime@0.7.9");
    expect(installCommand({ manager: "bun", root: bun }, "0.7.9").text).toBe("bun add -g @ukanwat/overtime@0.7.9");
    expect(installCommand({ manager: "yarn", root: yarn }, "0.7.9")).toMatchObject({ file: "yarn", args: ["global", "add", "@ukanwat/overtime@0.7.9"] });
  });

  it("skips a source checkout, npm link, npx and a project's own install", () => {
    expect(installInfo(packageRoot())).toEqual({ skip: "it runs from a source checkout" });
    // npm link: the global folder is a link to a folder outside any node_modules.
    const checkout = pkg("code", "overtime");
    mkdirSync(join(root, "linked", "lib", "node_modules", "@ukanwat"), { recursive: true });
    symlinkSync(checkout, join(root, "linked", "lib", "node_modules", "@ukanwat", "overtime"));
    expect(installInfo(join(root, "linked", "lib", "node_modules", "@ukanwat", "overtime"))).toEqual({ skip: "it is linked to a source folder (npm link)" });
    expect(installInfo(pkg(".npm", "_npx", "a1b2", "node_modules", "@ukanwat", "overtime"))).toEqual({ skip: "it runs through npx" });
    const project = pkg("work", "app", "node_modules", "@ukanwat", "overtime");
    expect(installInfo(project, "darwin")).toEqual({ skip: `it is installed in a project (${project}), not globally` });
  });
});

describe("checking for a new version", () => {
  const npm = { manager: "npm" as const, root: "/opt/node/lib/node_modules/@ukanwat/overtime", prefix: "/opt/node" };
  /** An updater with everything stubbed; what it did is in the returned record. */
  function updater(o: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
    const did = { asked: 0, ran: [] as string[], handedOver: [] as string[], notified: [] as string[], logs: [] as string[] };
    let now = Date.parse("2026-10-18T12:00:00Z");
    const u = new Updater({
      log: (l) => did.logs.push(l),
      notify: (t, b) => did.notified.push(`${t}: ${b}`),
      handover: (v, main) => void did.handedOver.push(`${v} ${main}`),
      current: "0.7.8",
      autoUpdate: async () => true,
      latest: async () => (did.asked++, "0.7.9"),
      install: () => npm,
      run: async (c) => void did.ran.push(c.text),
      installedVersion: () => "0.7.9",
      now: () => now,
      ...o,
    });
    return { u, did, later: (ms: number) => void (now += ms) };
  }
  beforeAll(() => writeFileSync(join(home, "update.json"), "{}"));

  it("is on by default", async () => {
    expect((await loadSettings()).autoUpdate).toBe(true);
  });

  it("does nothing when turned off, or when it can't update itself (saying why once)", async () => {
    const off = updater({ autoUpdate: async () => false });
    expect(await off.u.check("test")).toBe("off");
    expect(off.did.asked).toBe(0);
    const dev = updater({ install: () => ({ skip: "it runs from a source checkout" }) });
    expect(await dev.u.check("test")).toBe("skip");
    expect(await dev.u.check("test")).toBe("skip");
    expect(dev.did.asked).toBe(0);
    expect(dev.did.logs).toEqual(["auto-update: off, because it runs from a source checkout"]);
  });

  it("never downgrades, and leaves the same version alone", async () => {
    for (const latest of ["0.7.8", "0.7.7", "0.7.8-beta.1"]) {
      const t = updater({ latest: async () => latest });
      expect(await t.u.check("test")).toBe("current");
      expect(t.did.ran).toEqual([]);
      expect(t.did.handedOver).toEqual([]);
    }
  });

  it("installs a newer version the way it was installed, then hands over to its daemon", async () => {
    const t = updater();
    expect(await t.u.check("test")).toBe("updated");
    expect(t.did.ran).toEqual(["npm i -g @ukanwat/overtime@0.7.9"]);
    expect(t.did.handedOver).toEqual([`0.7.9 ${join(npm.root, "dist", "daemon", "main.js")}`]);
    expect(t.did.logs.join("\n")).toMatch(/0\.7\.8 → 0\.7\.9.*npm i -g @ukanwat\/overtime@0\.7\.9/);
  });

  it("an install that fails tells the person once, with the exact command, and isn't retried until the next day", async () => {
    writeFileSync(join(home, "update.json"), "{}");
    const t = updater({ latest: async () => "0.8.0", run: async () => Promise.reject(Object.assign(new Error("npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, rename '/opt/node/lib/node_modules/@ukanwat/overtime'"), { code: 243 })) });
    expect(await t.u.check("test")).toBe("failed");
    expect(t.did.handedOver).toEqual([]);
    expect(t.did.notified).toEqual(["Overtime couldn't update itself: To update to 0.8.0, run: npm i -g @ukanwat/overtime@0.8.0"]);
    expect(await takeNotice()).toEqual({ text: "Overtime couldn't update itself to 0.8.0 (no permission to write to /opt/node). To update, run: npm i -g @ukanwat/overtime@0.8.0", tone: "err" });
    expect(await takeNotice()).toBeNull();
    // The same day: not tried again.
    expect(await t.u.check("test")).toBe("tried");
    // The next day it tries again, but the person isn't told a second time.
    t.later(25 * 3600_000);
    expect(await t.u.check("test")).toBe("failed");
    expect(t.did.notified.length).toBe(1);
    expect(await takeNotice()).toBeNull();
  });

  it("an install that leaves the old version in place counts as failed", async () => {
    writeFileSync(join(home, "update.json"), "{}");
    const t = updater({ installedVersion: () => "0.7.8" });
    expect(await t.u.check("test")).toBe("failed");
    expect(t.did.handedOver).toEqual([]);
    expect((await takeNotice())?.text).toContain("npm i -g @ukanwat/overtime@0.7.9");
  });

  it("an unreachable registry is only logged", async () => {
    const t = updater({ latest: async () => Promise.reject(new Error("getaddrinfo ENOTFOUND registry.npmjs.org")) });
    expect(await t.u.check("test")).toBe("unreachable");
    expect(t.did.notified).toEqual([]);
  });
});

describe("after an update", () => {
  it('the app is told "Updated to …" once', async () => {
    writeFileSync(join(home, "update.json"), "{}");
    expect(await noteRunningVersion("0.7.8")).toBeNull(); // the first daemon ever
    expect(await noteRunningVersion("0.7.8")).toBeNull(); // a plain restart
    expect(await takeNotice()).toBeNull();
    expect(await noteRunningVersion("0.7.9")).toBe("0.7.8");
    expect(await takeNotice()).toEqual({ text: "Updated to 0.7.9", tone: "ok" });
    expect(await takeNotice()).toBeNull();
    // Going back to an older version by hand isn't announced.
    expect(await noteRunningVersion("0.7.8")).toBeNull();
    expect(await takeNotice()).toBeNull();
  });

  it("the new daemon starts only once the old one has exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "overtime-relaunch-"));
    const started = join(dir, "started");
    const main = join(dir, "main.mjs");
    writeFileSync(main, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(started)}, String(Date.now()));`);
    const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: "ignore" });
    const exited = new Promise<number>((r) => old.on("exit", () => r(Date.now())));
    relaunchAfterExit(old.pid!, main);
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(started)).toBe(false);
    const at = await exited;
    await until(async () => existsSync(started), 10_000, "new daemon started");
    expect(Number(readFileSync(started, "utf8"))).toBeGreaterThanOrEqual(at);
  });
});

describe("the setting, from the command line", () => {
  const rt = new Runtime(() => {});
  let control: InstanceType<typeof ControlServer>;
  beforeAll(async () => {
    control = new ControlServer(rt, () => {}, () => {});
    await control.start();
    control.open();
  });
  afterAll(async () => control.stop());
  const cli = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      const env = { ...process.env };
      delete env.OVERTIME_AGENT;
      execFile(join(here, "..", "node_modules", ".bin", "tsx"), [join(here, "..", "src", "cli.ts"), ...args], { env, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as any).code ?? 1) : 0, out: stdout + stderr }));
    });

  it("overtime set autoUpdate=off turns it off in settings.json, and on again", async () => {
    let r = await cli(["set", "autoUpdate=false"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Auto-update off");
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).autoUpdate).toBe(false);
    r = await cli(["set", "autoUpdate=on"]);
    expect(r.code).toBe(0);
    expect((await loadSettings()).autoUpdate).toBe(true);
    r = await cli(["set", "autoUpdate=maybe"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("isn't on or off");
  });
});
