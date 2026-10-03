import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Write a file so a crash never leaves it half-written: write a temp file, then rename. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Read a JSON file. A missing file gives the fallback. A damaged one (a full disk, a bad hand edit) is
 * moved aside as <name>.damaged-<time> so nothing is lost, and the fallback is used, so one bad file
 * can never stop an agent or the daemon.
 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const aside = `${path}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(path, aside).catch(() => {});
    console.error(`${new Date().toISOString()} ${path} was damaged; moved it to ${aside} and started that file fresh`);
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(value) + "\n");
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line after a crash: skip it rather than fail the whole read.
    }
  }
  return out;
}

export function newId(prefix: string): string {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}_${t}_${randomBytes(3).toString("hex")}`;
}

/** Keep only the rows of a JSON-lines file that pass `keep` (rewritten atomically; torn lines dropped). */
export async function trimJsonl<T>(path: string, keep: (row: T, index: number, all: T[]) => boolean): Promise<number> {
  const rows = await readJsonl<T>(path);
  const kept = rows.filter(keep);
  if (kept.length === rows.length) return 0;
  await writeAtomic(path, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
  return rows.length - kept.length;
}
