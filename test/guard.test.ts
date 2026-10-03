import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { judge, answer } from "../src/runtime/permissions.js";
import { touchesAgentMd } from "../src/runtime/turn.js";
import { clean, cleanDeep, openPlan } from "../src/tui/app.js";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = join(homedir(), "overtime", "agents", "a");
const ws = join(homedir(), "work", "repo");
const scope = { roots: [agentDir, ws] };
const sh = (command: string) => judge({ toolCall: { kind: "execute", rawInput: { command } }, options: [] } as any, scope, ws);

describe("the permission guard", () => {
  it("lets the agent do anything inside its folder and workspace", () => {
    for (const c of ["rm -rf build", "rm -rf ./node_modules dist", `rm -rf ${agentDir}/scratch`, "mv a.txt b.txt", "git clean -fdx", "find . -name '*.tmp' -delete", "git push origin feature-x", "git push -f origin overtime/a/helper_1", "rm -rf /tmp/xyz", "grep -r shutdown src/", "echo 'use sudo carefully' > notes.md", "dd if=/dev/zero of=/dev/null count=1"]) {
      expect(sh(c).allowed, c).toBe(true);
    }
  });

  it("declines destruction outside them, and says why", () => {
    for (const c of ["rm -rf ~", "rm -rf ~/Documents", "rm -rf /", `rm -rf ${homedir()}/Desktop/x`, "cd ~/Documents && rm -rf old", "cd .. && cd .. && rm -rf *", "find ~ -name '*.log' -delete", "find / -exec rm {} \;", "mv ~/Downloads/a.pdf ./", "git -C ~/other clean -fd"]) {
      const d = sh(c);
      expect(d.allowed, c).toBe(false);
      expect(d.reason).toMatch(/outside your folder|Ask the person/);
    }
  });

  it("declines deletes it can't check in advance", () => {
    for (const c of ["rm -rf ~{,}", "rm -rf {~,x}", "rm -rf a{1..3}", 'rm -rf "$DIR"', "rm -rf $(cat list)", "ls | xargs rm", "cd $X && rm -rf y"]) expect(sh(c).allowed, c).toBe(false);
    expect(sh('rm -rf "$HOME/overtime/agents/a/tmp"').allowed).toBe(true);
  });

  it("always declines the few never-ever actions", () => {
    for (const c of ["sudo rm -rf /var/x", "git push --force origin main", "git push -f", "git push origin +main", "git push --force-with-lease origin master", "git push --mirror --force", "mkfs.ext4 /dev/sda1", "diskutil eraseDisk APFS X disk2", "dd if=x of=/dev/disk2", "psql -c 'DROP TABLE users'", "shutdown -h now", "FOO=1 reboot"]) {
      expect(sh(c).allowed, c).toBe(false);
    }
  });

  it("checks structured deletes and moves too", () => {
    const d = judge({ toolCall: { kind: "delete", locations: [{ path: join(homedir(), "Documents", "x") }] }, options: [] } as any, scope, ws);
    expect(d.allowed).toBe(false);
    const ok = judge({ toolCall: { kind: "delete", locations: [{ path: join(ws, "x") }] }, options: [] } as any, scope, ws);
    expect(ok.allowed).toBe(true);
  });

  it("answers once, never always, so it sees every request", () => {
    const opts = [
      { optionId: "aa", kind: "allow_always", name: "" },
      { optionId: "a1", kind: "allow_once", name: "" },
      { optionId: "r1", kind: "reject_once", name: "" },
    ];
    expect(answer({ options: opts } as any, { allowed: true, reason: "" })).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    expect(answer({ options: opts } as any, { allowed: false, reason: "" })).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });
});

describe("who changed AGENT.md", () => {
  it("counts the agent's writes, not its reads", () => {
    const md = join(agentDir, "AGENT.md");
    expect(touchesAgentMd({ sessionUpdate: "tool_call", kind: "edit", locations: [{ path: md }] } as any, agentDir)).toBe(true);
    expect(touchesAgentMd({ sessionUpdate: "tool_call", kind: "execute", rawInput: { command: "cat > AGENT.md <<EOF" } } as any, agentDir)).toBe(true);
    expect(touchesAgentMd({ sessionUpdate: "tool_call", kind: "read", locations: [{ path: md }] } as any, agentDir)).toBe(false);
    expect(touchesAgentMd({ sessionUpdate: "tool_call", kind: "edit", locations: [{ path: join(agentDir, "INDEX.md") }] } as any, agentDir)).toBe(false);
  });
});

describe("the terminal app shows agent text safely", () => {
  it("removes escape sequences and control characters but keeps line breaks", () => {
    expect(clean("hi\x1b[2J\x1b]0;pwned\x07 there\r\nnext\x1b]8;;file:///x\x07link\x1b]8;;\x07")).toBe("hi there\nnextlink");
    expect(cleanDeep({ a: ["\x1b[31mred\x1b[0m"], n: 3 })).toEqual({ a: ["red"], n: 3 });
  });

  it("opens documents and web links, but only reveals anything that would run", () => {
    const d = mkdtempSync(join(tmpdir(), "ot-open-"));
    writeFileSync(join(d, "notes.md"), "x");
    writeFileSync(join(d, "run.sh"), "echo");
    writeFileSync(join(d, "tool"), "#!/bin/sh\n");
    chmodSync(join(d, "tool"), 0o755);
    mkdirSync(join(d, "Evil.app"));
    expect(openPlan("https://example.com")).toEqual({ args: ["https://example.com"] });
    expect(openPlan(join(d, "notes.md"))).toEqual({ args: [join(d, "notes.md")] });
    expect(openPlan(d)).toEqual({ args: [d] });
    for (const f of ["run.sh", "tool", "Evil.app"]) {
      const p = openPlan(join(d, f)) as any;
      expect(p.args, f).not.toEqual([join(d, f)]);
    }
    expect("refuse" in openPlan("javascript:alert(1)")).toBe(true);
    expect("refuse" in openPlan(join(d, "missing"))).toBe(true);
  });
});

describe("the guard sees through wrappers", () => {
  it("declines deletes hidden in sh -c, eval, inline scripts, xargs and redirects", () => {
    for (const c of [
      "bash -c 'rm -rf ~'",
      `sh -c "rm -rf $HOME"`,
      'eval "rm -rf ~"',
      "xargs -0 rm < list",
      "find . -print0 | xargs -0 rm -f",
      `python3 -c "import shutil; shutil.rmtree('${homedir()}/Documents')"`,
      `node -e "require('fs').rmSync(require('os').homedir(), {recursive: true})"`,
      ": > ~/.zshrc",
      "echo x > ~/.ssh/config",
      "env FOO=1 rm -rf ~/Pictures",
      "nohup rm -rf ~/Music &",
      "timeout 10 rm -rf /etc/hosts",
      "cat $(rm -rf ~/x)",
      "git -C ~/elsewhere reset --hard",
      "zsh -c \"cd ~ && rm -rf Documents\"",
    ]) {
      expect(sh(c).allowed, c).toBe(false);
    }
  });

  it("still allows ordinary work", () => {
    for (const c of [
      "npm test 2>&1 | tail -20",
      "ls -la > listing.txt",
      "echo done >> log.md",
      "python3 -c 'print(1+1)'",
      "node -e \"console.log(require('fs').readdirSync('.'))\"",
      "bash -c 'rm -rf build && npm run build'",
      "cmd > /dev/null 2>&1",
      "git status && git diff",
      "rm -f ./notes/old.md",
      `python3 -c "import os; os.remove('${ws}/tmp.txt')"`,
    ]) {
      expect(sh(c).allowed, c).toBe(true);
    }
  });
});
