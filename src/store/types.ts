export type ThreadKind = "conversation" | "question" | "report" | "alert";
export type ThreadStatus = "open" | "waiting_on_you" | "answered" | "closed";

export interface ThreadMeta {
  id: string;
  kind: ThreadKind;
  title: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  /** Messages from the agent you haven't seen yet. */
  unread: number;
  urgent?: boolean;
  /** For questions: the kind of decision, for earned autonomy. */
  category?: string;
  /** ACP session id of this thread's chat session, so a reply continues it. */
  chatSessionId?: string | null;
}

export interface ThreadEntry {
  id: string;
  t: string;
  from: "agent" | "you" | "overtime";
  text: string;
  /** For questions. */
  why?: string;
  recommendation?: string;
  options?: string[];
  /** For your answers to a question: the option you picked (1-based), if any. */
  choice?: number;
  /** Paths and URLs found in the text, checked to exist (paths) when written. */
  links?: { label: string; target: string; kind: "file" | "folder" | "url" }[];
}

export type InboxType = "message" | "answer" | "monitor" | "helper" | "system" | "loop";

export interface InboxItem {
  id: string;
  t: string;
  type: InboxType;
  text: string;
  threadId?: string;
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
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  result?: string;
}
