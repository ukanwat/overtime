import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sandboxLaunch } from "../src/runtime/sandbox.js";

const mac = process.platform === "darwin";

/** Run a shell line with the given paths protected, and return what it printed. */
function run(line: string, protect: string[]): string {
  const l = sandboxLaunch("/bin/sh", ["-c", line], protect);
  return execFileSync(l.command, l.args, { encoding: "utf8" });
}

describe("protected paths", () => {
  it("change nothing when none are set: the command runs as is", () => {
    const l = sandboxLaunch("/bin/sh", ["-c", "true"], []);
    expect(l).toEqual({ command: "/bin/sh", args: ["-c", "true"], sandboxed: false });
  });
});

describe.runIf(mac)("protected paths on this machine", () => {
  const base = mkdtempSync(join(homedir(), ".ot-protect-test-"));
  const free = join(base, "free");
  const kept = join(base, "kept");
  mkdirSync(free);
  mkdirSync(kept);
  writeFileSync(join(kept, "file"), "mine");

  it("stay read-only, while everything else stays writable", () => {
    const out = run(`echo a > ${free}/ok && echo free; echo b > ${kept}/new 2>/dev/null && echo LEAK-write; rm -rf ${kept} 2>/dev/null; echo c > ${homedir()}/.ot-protect-probe-$$ && rm ${homedir()}/.ot-protect-probe-$$ && echo home`, [kept]);
    expect(out).toContain("free");
    expect(out).toContain("home");
    expect(out).not.toContain("LEAK");
    expect(existsSync(join(kept, "file"))).toBe(true);
  });

  it("hold for everything the command starts, scripts and programs included", () => {
    const out = run(`printf '#!/bin/sh\\nrm -rf ${kept} && echo LEAK-script' > ${free}/evil.sh; chmod +x ${free}/evil.sh; ${free}/evil.sh 2>/dev/null; node -e "require('fs').writeFileSync('${kept}/x','y')" 2>/dev/null && echo LEAK-node; echo done`, [kept]);
    expect(out).not.toContain("LEAK");
    expect(existsSync(join(kept, "file"))).toBe(true);
  });

  it("can still be read", () => {
    expect(run(`cat ${kept}/file`, [kept])).toBe("mine");
  });

  it("accept ~ paths", () => {
    const rel = "~/" + base.slice(homedir().length + 1) + "/kept";
    expect(run(`echo x > ${kept}/y 2>/dev/null && echo LEAK; echo done`, [rel])).not.toContain("LEAK");
  });

  it("cleans up", () => rmSync(base, { recursive: true, force: true }));
});
