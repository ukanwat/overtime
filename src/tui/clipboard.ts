import { spawn } from "node:child_process";

/** The commands that put text on the system clipboard here, in the order they're tried. */
export function clipboardCommands(platform = process.platform, env = process.env): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  const out: string[][] = [];
  if (env.WAYLAND_DISPLAY) out.push(["wl-copy"]);
  if (env.DISPLAY) out.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
  return out;
}

/** Pipe text into one command; true if it ran and exited cleanly. */
function pipeTo(cmd: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      // Detached from the terminal's input, so a clipboard tool can never read the person's keys.
      child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

/**
 * Copy text to the system clipboard with the platform's own tool. Many terminals (macOS Terminal.app
 * among them) ignore the OSC 52 escape code, so relying on it alone shows "Copied!" while nothing is
 * copied. Over SSH the remote machine's tools can't reach the person's clipboard: OSC 52 is all there is.
 * With no tool that works, OSC 52 is the last resort (some terminals, e.g. kitty and iTerm2, honour it).
 */
export async function copyText(text: string, osc52: (seq: string) => void, platform = process.platform, env = process.env): Promise<boolean> {
  const remote = !!(env.SSH_CONNECTION || env.SSH_TTY);
  if (!remote) for (const cmd of clipboardCommands(platform, env)) if (await pipeTo(cmd, text)) return true;
  osc52(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  return true;
}
