import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxLaunch } from "../src/runtime/sandbox.js";

const mac = process.platform === "darwin";

/** Run a shell line in the sandbox and return what it printed. */
function inside(line: string, writable: string[], prot: string[] = []): string {
  const l = sandboxLaunch("/bin/sh", ["-c", line], { writable, protected: prot });
  return execFileSync(l.command, l.args, { encoding: "utf8" });
}

describe.runIf(mac)("Overtime's sandbox", () => {
  const base = mkdtempSync(join(homedir(), ".ot-sandbox-test-"));
  const ws = join(base, "ws");
  const other = join(base, "other");
  const prot = join(ws, "protected");
  mkdirSync(ws);
  mkdirSync(other);
  mkdirSync(prot);

  it("writes where the work lives and in temp folders, and nowhere else", () => {
    const out = inside(
      `echo a > ${ws}/ok && echo ws; echo b > ${tmpdir()}/ot-sb-$$ && echo tmp; echo c > ${other}/no 2>/dev/null && echo LEAK-other; echo d > ${homedir()}/ot-sb-$$ 2>/dev/null && echo LEAK-home; rm -rf ${other} 2>/dev/null; echo done`,
      [ws],
    );
    expect(out).toContain("ws");
    expect(out).toContain("tmp");
    expect(out).not.toContain("LEAK");
    expect(existsSync(other)).toBe(true);
  });

  it("covers everything the agent starts, scripts included", () => {
    const out = inside(`printf '#!/bin/sh\\nrm -rf ${other} && echo LEAK-script' > ${ws}/evil.sh; chmod +x ${ws}/evil.sh; ${ws}/evil.sh 2>/dev/null; node -e "require('fs').writeFileSync('${other}/x','y')" 2>/dev/null && echo LEAK-node; echo done`, [ws]);
    expect(out).not.toContain("LEAK");
    expect(existsSync(other)).toBe(true);
  });

  it("keeps protected paths read-only inside a writable folder", () => {
    const out = inside(`echo x > ${prot}/hook 2>/dev/null && echo LEAK-protected; echo y > ${ws}/fine && echo fine`, [ws], [prot]);
    expect(out).toContain("fine");
    expect(out).not.toContain("LEAK");
  });

  it("still reads anywhere", () => {
    expect(inside(`cat /etc/hosts >/dev/null && echo read`, [ws])).toContain("read");
  });

  it("cleans up", () => rmSync(base, { recursive: true, force: true }));
});
