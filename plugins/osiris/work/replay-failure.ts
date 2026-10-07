// Replay with a typed failure (pure). Idea re-implemented from Cordis agent-team projection (MIT, (c) 2026 DeepSeek): a replay keeps the
// last valid state and NAMES the first rejected record instead of dropping data silently. No Cordis code is copied.
// Today the transcript and codex feeds `continue` past a malformed line; this gives them (and health messages) a "line N" to point at.
// Reasons are fixed strings: a line's content is never echoed (it can hold secrets).
export interface ReplayFailure { line: number; reason: "not valid JSON" | "not a JSON object" }
export interface Replay { records: Record<string, unknown>[]; failure?: ReplayFailure; skipped: number }

/** `complete` false: the final line may be cut off mid-write, so it is ignored rather than reported (a short read is not corruption). */
export function replayJsonl(text: string, complete: boolean): Replay {
  const lines = text.split("\n");
  if (!complete) lines.pop();
  const records: Record<string, unknown>[] = [];
  let failure: ReplayFailure | undefined, skipped = 0;
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let v: unknown, reason: ReplayFailure["reason"] | null = null;
    try { v = JSON.parse(l); } catch { reason = "not valid JSON"; }
    if (!reason && (!v || typeof v !== "object" || Array.isArray(v))) reason = "not a JSON object";
    if (reason) { skipped++; failure ??= { line: i + 1, reason }; return; }
    records.push(v as Record<string, unknown>);
  });
  return failure ? { records, failure, skipped } : { records, skipped };
}
