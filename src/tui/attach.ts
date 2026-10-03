import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** A file or folder waiting to be sent with the next message. */
export interface PendingAttachment {
  path: string;
  name: string;
  kind: "image" | "file" | "folder";
  bytes?: number;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i;

/**
 * Split text the way a shell would, so dragged-in paths come out whole: terminals paste them quoted
 * ('/a b.png'), backslash-escaped (/a\ b.png) or as file:// URLs.
 */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let had = false;
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      had = true;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      had = true;
    } else if (/\s/.test(c)) {
      if (cur || had) out.push(cur);
      cur = "";
      had = false;
    } else {
      cur += c;
      had = true;
    }
  }
  if (cur || had) out.push(cur);
  return out;
}

function toPath(word: string): string | null {
  let p = word.trim();
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  }
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : null;
}

export function describe(path: string): PendingAttachment | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    const kind = st.isDirectory() ? "folder" : IMAGE.test(path) ? "image" : "file";
    return { path, name: basename(path) || path, kind, bytes: st.isDirectory() ? undefined : st.size };
  } catch {
    return null;
  }
}

/**
 * If the pasted text is nothing but paths to things that exist (a drag and drop of one or more files),
 * those become attachments. Anything else is ordinary text and is pasted as is.
 */
export function pastedFiles(text: string): PendingAttachment[] | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 8000) return null;
  // One path with unescaped spaces, as some terminals paste it.
  const whole = toPath(trimmed);
  const one = whole ? describe(whole) : null;
  if (one) return [one];
  const words = splitWords(trimmed);
  if (!words.length) return null;
  const found: PendingAttachment[] = [];
  for (const w of words) {
    const p = toPath(w);
    const d = p ? describe(p) : null;
    if (!d) return null;
    found.push(d);
  }
  return found;
}
