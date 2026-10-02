import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { home, paths } from "../paths.js";

const exec = promisify(execFile);
const LABEL = "dev.overtime.daemon";

function daemonEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "main.js");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "overtime.service");
}

export function autostartSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function autostartInstalled(): boolean {
  return process.platform === "darwin" ? existsSync(plistPath()) : process.platform === "linux" ? existsSync(unitPath()) : false;
}

/** What would be installed, in plain words, for the person to agree to. */
export function autostartDescription(): string {
  const where = process.platform === "darwin" ? plistPath() : unitPath();
  return `This adds a login item (${where}) that starts Overtime's background process when you log in, so your agents keep their schedules after a restart. Remove it any time with: overtime daemon uninstall`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function installAutostart(): Promise<void> {
  const node = process.execPath;
  const entry = daemonEntry();
  if (!existsSync(entry)) throw new Error(`Build Overtime first (missing ${entry}).`);
  // Backends are started by the daemon, so it needs the same PATH you have (npx, gemini, codex...).
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() };
  if (process.env.OVERTIME_HOME) env.OVERTIME_HOME = home();
  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>StandardOutPath</key><string>${xml(paths.daemonLog())}</string>
  <key>StandardErrorPath</key><string>${xml(paths.daemonLog())}</string>
</dict>
</plist>
`;
    await mkdir(dirname(plistPath()), { recursive: true });
    await writeFile(plistPath(), plist);
    const uid = process.getuid?.() ?? 501;
    await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
    await exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]);
    return;
  }
  if (process.platform === "linux") {
    const unit = `[Unit]
Description=Overtime daemon (agents that exist, not sessions)

[Service]
ExecStart=${node} ${entry}
Restart=on-failure
${Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join("\n")}

[Install]
WantedBy=default.target
`;
    await mkdir(dirname(unitPath()), { recursive: true });
    await writeFile(unitPath(), unit);
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", "overtime.service"]);
    return;
  }
  throw new Error("Starting at login is supported on macOS and Linux.");
}

export async function uninstallAutostart(): Promise<void> {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
    await rm(plistPath(), { force: true });
  } else if (process.platform === "linux") {
    await exec("systemctl", ["--user", "disable", "--now", "overtime.service"]).catch(() => {});
    await rm(unitPath(), { force: true });
  }
}
