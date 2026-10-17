import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "data");

export function saveNote(user, id, text) {
  mkdirSync(join(ROOT, user), { recursive: true });
  writeFileSync(join(ROOT, user, id + ".txt"), text);
}

export function readNote(user, id) {
  return readFileSync(join(ROOT, user, id + ".txt"), "utf8");
}

export function listNotes(user) {
  return readdirSync(join(ROOT, user)).map((f) => f.replace(".txt", ""));
}
