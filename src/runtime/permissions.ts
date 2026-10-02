import type { PermissionRequest, PermissionResponse } from "../acp/session.js";

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
}

/**
 * The few things that must never slip through even if the model misjudges.
 * No model call here: instant, and it can never time out or leave a session waiting.
 */
const HARD_STOPS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b[^;&|]*\s(\/|~\/?|\$HOME\/?)(\s|$)/, reason: "deletes the whole home folder or disk" },
  { pattern: /\bgit\s+push\b[^;&|]*\s(--force|-f)\b[^;&|]*\b(main|master|trunk)\b/, reason: "force-pushes over a shared default branch" },
  { pattern: /\bgit\s+push\b[^;&|]*\b(main|master|trunk)\b[^;&|]*\s(--force|-f)\b/, reason: "force-pushes over a shared default branch" },
  { pattern: /\b(mkfs|diskutil\s+erase|dd\s+if=[^;&|]*of=\/dev\/)/, reason: "erases a disk" },
  { pattern: /\bDROP\s+(DATABASE|SCHEMA)\b/i, reason: "drops a whole database" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
];

export function judge(req: PermissionRequest): PermissionDecision {
  const raw = req.toolCall as any;
  const text = [raw?.title, JSON.stringify(raw?.rawInput ?? "")].filter(Boolean).join(" ");
  for (const h of HARD_STOPS) {
    if (h.pattern.test(text)) return { allowed: false, reason: h.reason };
  }
  return { allowed: true, reason: "autonomous by default" };
}

/** Answer a permission request immediately. Never leaves the session waiting. */
export function answer(req: PermissionRequest, decision: PermissionDecision): PermissionResponse {
  const opts = req.options ?? [];
  const pick = decision.allowed
    ? opts.find((o) => o.kind === "allow_always") ?? opts.find((o) => o.kind === "allow_once")
    : opts.find((o) => o.kind === "reject_once") ?? opts.find((o) => o.kind === "reject_always");
  if (!pick) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: pick.optionId } };
}
