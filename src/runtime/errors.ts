/**
 * Errors the agent can't fix by retrying: something the person has to do (sign in, install a backend,
 * top up credit). Recognised from what backends actually say, and turned into one plain instruction.
 */
export function needsPerson(message: string, backend: string, agent: string): string | null {
  const m = message;
  const signIn: Record<string, string> = {
    claude: "Open a terminal, run `claude`, and sign in",
    codex: "Open a terminal and run `codex login`",
    gemini: "Open a terminal, run `gemini`, and sign in",
  };
  if (/Could not start backend[\s\S]*ENOENT|command not found|spawn \S+ ENOENT/i.test(m)) {
    return `The ${backend} backend isn't installed on this machine, so ${agent} can't run. Install it, or switch ${agent} to another backend (Ctrl+T in the app, or \`overtime set ${agent} backend=claude\`).`;
  }
  if (/auth(entication)?[ _-]?required|not (logged|signed) in|please (run )?\/?log ?in|invalid (x-)?api[ _-]?key|\b401\b|unauthori[sz]ed|oauth token (has )?expired|no credentials|login required/i.test(m)) {
    return `${backend} isn't signed in, so ${agent} can't run. ${signIn[backend] ?? `Sign in to ${backend}`}, then wake ${agent} (Ctrl+R in the app, or \`overtime wake ${agent}\`).`;
  }
  if (/credit balance is too low|insufficient[_ ](credit|quota|funds)|billing|payment required|\b402\b|exceeded your current quota/i.test(m)) {
    return `${backend} says the account is out of credit or quota, so ${agent} can't run. Top it up, then wake ${agent} (Ctrl+R).`;
  }
  return null;
}

/**
 * A problem on the provider's side that passes by itself: overloaded, rate limited, a 5xx, a network
 * drop. Retried quietly; it never counts as the agent failing.
 */
export function isTransient(message: string): boolean {
  return /\b(429|500|502|503|504|520|522|524|529)\b|overloaded|rate[ _-]?limit|too many requests|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|internal server error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network (error|is unreachable)|fetch failed|connection (reset|closed|error)|stream (closed|ended) unexpectedly/i.test(message);
}
