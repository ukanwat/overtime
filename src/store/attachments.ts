import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Attachment } from "./types.js";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".tiff", ".tif", ".svg"]);
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function expand(p: string, base: string): string {
  const q = p.trim().replace(/^(['"])(.*)\1$/, "$2");
  const h = q === "~" ? homedir() : q.startsWith("~/") ? join(homedir(), q.slice(2)) : q;
  return isAbsolute(h) ? resolve(h) : resolve(base, h);
}

async function sizeOf(p: string): Promise<number> {
  const st = await lstat(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await readdir(p)) {
    n += await sizeOf(join(p, e));
    if (n > MAX_ATTACHMENT_BYTES) break;
  }
  return n;
}

/** A file or folder as an attachment, as it is (for files the agent shares from its own folder or workspace). */
export async function describeAttachment(p: string, base: string): Promise<Attachment> {
  const path = expand(p, base);
  if (!existsSync(path)) throw new Error(`There is no file at ${path}.`);
  const st = await lstat(path);
  const kind = st.isDirectory() ? "folder" : IMAGE.has(extname(path).toLowerCase()) ? "image" : "file";
  return { name: basename(path), path, kind, bytes: await sizeOf(path) };
}

/**
 * Files the person sent: copied into the agent's folder (files/received/<date>/), so the agent can always
 * read them, even after the original moves. Names never collide; nothing larger than 50 MB is taken.
 */
export async function receiveAttachments(paths: string[], agentDir: string): Promise<Attachment[]> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(agentDir, "files", "received", day);
  const out: Attachment[] = [];
  for (const raw of paths) {
    const src = expand(raw, homedir());
    if (!existsSync(src)) throw new Error(`Can't attach ${src}: there's no file there.`);
    const bytes = await sizeOf(src);
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`Can't attach ${basename(src)}: it's over 50 MB. Put it in the agent's workspace and mention its path instead.`);
    await mkdir(dir, { recursive: true });
    const ext = extname(src);
    const stem = basename(src, ext);
    let name = basename(src);
    for (let i = 2; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`;
    const dest = join(dir, name);
    await cp(src, dest, { recursive: true, verbatimSymlinks: false });
    const st = await lstat(dest);
    out.push({ name, path: dest, original: src, kind: st.isDirectory() ? "folder" : IMAGE.has(ext.toLowerCase()) ? "image" : "file", bytes });
  }
  return out;
}
