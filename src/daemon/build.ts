import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Which build of Overtime this is: the package version plus when the daemon's code was built. The app
 * and CLI compare theirs with the running daemon's, so after an update (npm, or a local rebuild) the
 * old daemon is replaced instead of serving a newer app with older code.
 */
export function buildId(): string {
  if (cached) return cached;
  let version = "?";
  try {
    version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {}
  let stamp = 0;
  for (const f of ["./main.js", "./main.ts"]) {
    try {
      stamp = Math.round(statSync(fileURLToPath(new URL(f, import.meta.url))).mtimeMs);
      break;
    } catch {}
  }
  return (cached = `${version}+${stamp}`);
}
