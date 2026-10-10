import YAML from "yaml";

/** Split a Markdown file into YAML front matter and body. Missing front matter is fine. */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  let data: unknown;
  try {
    data = YAML.parse(m[1]);
  } catch {
    data = {};
  }
  return { data: (data && typeof data === "object" ? data : {}) as Record<string, unknown>, body: text.slice(m[0].length) };
}

/** Front matter (with an optional comment line first, which parsing ignores) and the body. Nothing to put in: just the body. */
export function stringifyFrontMatter(data: Record<string, unknown>, body: string, comment?: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if (Object.keys(clean).length === 0) return body;
  return `---\n${comment ? `# ${comment}\n` : ""}${YAML.stringify(clean).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}
