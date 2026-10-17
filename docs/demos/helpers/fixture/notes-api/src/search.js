import { listNotes, readNote } from "./storage.js";

/** Notes whose text matches the query, best match first. */
export function search(user, query) {
  const re = new RegExp(query, "i");
  const hits = [];
  for (const id of listNotes(user)) {
    const text = readNote(user, id);
    if (re.test(text)) hits.push({ id, score: text.match(new RegExp(query, "gi")).length });
  }
  for (let i = 0; i < hits.length; i++)
    for (let j = 0; j < hits.length - 1; j++)
      if (hits[j].score < hits[j + 1].score) [hits[j], hits[j + 1]] = [hits[j + 1], hits[j]];
  return hits;
}
