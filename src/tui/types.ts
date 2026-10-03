/** Shapes the app and the command line read from the daemon. Everything in them is agent-written text, cleaned before display. */

export interface Attachment {
  name: string;
  /** The copy in the agent's folder. */
  path: string;
  /** Where it came from. */
  original?: string;
  kind: "image" | "file" | "folder";
  bytes?: number;
}

export interface Link {
  kind: string;
  target: string;
  label: string;
}

/** One message in an agent's DM. */
export interface Message {
  id: string;
  t: string;
  from: "you" | "agent" | "overtime";
  kind: "message" | "question" | "report" | "alert";
  text: string;
  title?: string;
  why?: string;
  recommendation?: string;
  options?: string[];
  urgent?: boolean;
  links?: Link[];
  attachments?: Attachment[];
  /** On a question, once answered. */
  answer?: { choice?: number; text: string; t: string };
  /** On your answer: the question it answers. */
  replyTo?: string;
}

export interface AgentSettingsView {
  backend: string;
  model: string | null;
  dailyBudgetUsd: number;
  dailyTokenBudget: number | null;
  workspace: string;
  workspaceIsDefault: boolean;
  /** Paths it may not write to: all agents' plus its own. */
  protect: string[];
  /** Just this agent's own protected paths. */
  protectOwn: string[];
  spentUsd: number;
  costReported: boolean;
  tokensToday: number;
}

/** A session that is running right now, streamed from the daemon (text so far, current step). */
export interface LiveState {
  agent: string;
  kind: "main" | "chat" | "helper";
  helperId?: string;
  text: string;
  step: string | null;
  startedAt: string;
  done?: boolean;
}

/** The newest question still waiting for an answer. */
/** An option's own words, without any numbering the agent put in front ("3 — Borrowed Sun" -> "Borrowed Sun"). */
export function optionLabel(o: string): string {
  return o.replace(/^\s*(\d{1,2}|[a-zA-Z])\s*[—–\-.):]\s+/, "").trim() || o;
}

/** Which option the agent recommended, if its recommendation names one; -1 if none does. */
export function recommendedOption(options: string[] | undefined, recommendation: string | undefined): number {
  if (!options?.length || !recommendation) return -1;
  const r = optionLabel(recommendation).toLowerCase();
  return options.findIndex((o) => {
    const l = optionLabel(o).toLowerCase();
    return l === r || l.startsWith(r) || r.startsWith(l);
  });
}

export function openQuestion(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "question" && !m.answer) return m;
  }
  return undefined;
}

export function humanBytes(n: number | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** A card's heading and body: its title, or else its first line; the body never repeats the heading. */
export function headed(m: Message, fallback: string): { title: string; body: string } {
  const text = (m.text ?? "").trim();
  const title = (m.title ?? "").trim() || text.split("\n")[0] || fallback;
  const body = text.startsWith(title) ? text.slice(title.length).trim() : text;
  return { title, body };
}
