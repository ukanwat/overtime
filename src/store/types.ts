/** What a message is: an ordinary message, a question for you, a report of finished work, or an alert. */
export type MessageKind = "message" | "question" | "report" | "alert";

export interface Attachment {
  name: string;
  /** Where it lives now: a copy in the agent's folder (for files you sent), or the agent's own file. */
  path: string;
  /** Where it came from, for files you sent. */
  original?: string;
  kind: "image" | "file" | "folder";
  bytes: number;
}

export interface Link {
  label: string;
  target: string;
  kind: "file" | "folder" | "url";
}

/** One message in an agent's conversation with the person. Each agent has exactly one conversation. */
export interface Message {
  id: string;
  t: string;
  from: "agent" | "you" | "overtime";
  kind: MessageKind;
  text: string;
  /** Short headline for reports and alerts. */
  title?: string;
  /** For questions. */
  why?: string;
  recommendation?: string;
  options?: string[];
  /** For questions: the kind of decision, for earned autonomy. */
  category?: string;
  urgent?: boolean;
  /** For your answer to a question: which question, and the option picked (1-based). */
  replyTo?: string;
  choice?: number;
  /** For your answer: what you wrote, on its own (text is the whole answer as the agent reads it). */
  note?: string;
  /** A reply that closes a question without answering it: the agent withdrew it, or the person dismissed it. Not shown as a message. */
  closes?: "withdrawn" | "dismissed";
  /** On a question once answered (derived from the answer message when read). */
  answer?: { choice?: number; note?: string; text: string; t: string; closed?: "withdrawn" | "dismissed" };
  attachments?: Attachment[];
  /** Paths and URLs found in the text, checked to exist (paths) when written. */
  links?: Link[];
}

/** The conversation's bookkeeping. */
export interface Conversation {
  /** The newest message the person has seen. */
  lastReadId: string | null;
  /** ACP session of the chat session answering the person, so replies continue it. */
  chatSessionId?: string | null;
  /** Fingerprints of AGENT.md and INDEX.md as the chat session last saw them (when its turn began). */
  chatFiles?: { agent: string; index: string };
  /** The last message the chat session had seen, so a resumed one is told what happened since. */
  chatSeen?: string | null;
  /** The version of Overtime's instructions the chat session started with. */
  chatPrompt?: string;
}

export type InboxType = "message" | "answer" | "monitor" | "helper" | "system" | "loop";

export interface InboxItem {
  id: string;
  t: string;
  type: InboxType;
  text: string;
  /** The message this came from, if any (yours, or your answer). */
  messageId?: string;
  attachments?: Attachment[];
  data?: unknown;
}

export interface Loop {
  id: string;
  everyMs: number;
  task: string;
  nextAt: string;
  createdAt: string;
}

export interface Schedule {
  /** Next self-chosen wake-up. */
  wakeAt: string | null;
  wakeReason: string | null;
  /** Set when the agent chose its wake in the current turn, so the runtime doesn't apply the default. */
  chosenInTurn?: boolean;
  loops: Loop[];
}

export interface Monitor {
  id: string;
  run: string;
  /** Repeating monitors run every everyMs; long-running ones have none. */
  everyMs: number | null;
  why: string;
  cooldownMs: number;
  createdAt: string;
  lastFiredAt: string | null;
  lastOutput: string | null;
  failures: number;
  status: "active" | "failing" | "removed";
}

export interface Decision {
  t: string;
  threadId: string;
  /** The kind of decision, as the agent labelled it (e.g. "dependency-update"). */
  category: string;
  question: string;
  answer: string;
  /** The option picked, in its own words (absent when the person only wrote an answer). */
  choice?: string;
}

export interface HelperRecord {
  id: string;
  task: string;
  role?: string;
  backend?: string;
  model?: string | null;
  /** Where it works: a git worktree or a scratch folder. */
  workdir: string;
  /** Git branch of the worktree, if any. */
  branch?: string;
  /** Who started it: "main" or another helper's id. */
  parent: string;
  depth: number;
  status: "running" | "done" | "failed" | "cancelled" | "stopped";
  startedAt: string;
  finishedAt?: string;
  /** When its folder was removed (a week after it finished). */
  cleanedAt?: string;
  result?: string;
  /** Its backend session, so it can be told more, or carry on after it finished, with what it knew. */
  sessionId?: string | null;
}
