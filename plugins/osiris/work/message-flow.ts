// Agent message events from ONE transcript line (pure). td-osi.21.2: who sent whom what, as METADATA only.
// Verified shapes (real files, 2026-10): assistant tool_use `SendMessage` input { to, summary?, message (string | object), ... };
// tool_use `Agent` input { description, subagent_type?, name?, prompt, ... } with `id`; user string/text content carrying
// `<teammate-message teammate_id=".." summary="..">`; `<cross-session-message from="..">`; a hand-back arrives in the SPAWNER's file as a
// user record with `toolUseResult { status, agentId, agentType, ... }` and a tool_result whose `tool_use_id` is the Agent tool_use id.
// A failed one holds the text "ended without delivering a report through SubagentHandback" (only that boolean is read).
// PRIVACY: kept = timestamp, names, the summary field (redacted, capped 80), subagent_type, a protocol word from the first 16 chars of the
// message. Never kept: message bodies, Agent prompt/description, tool_result text.
import type { MessageEvent, MessageKind, MessageProtocol } from "./fleet-types.ts";
import { cleanText, redactForDisplay, redactSecrets } from "./sanitize.ts";

export const SUMMARY_MAX = 80, NAME_MAX = 64;
const LOST_MARK = "ended without delivering a report through SubagentHandback";
const PROTOCOL = /^[\s\[(*#]*(DONE|HANDOFF|BLOCKED|DECISION|LANDABLE)\b/i;
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
/** Default-deny: a name that leaves is an id-shaped token (lane name, agent id, alias); anything else (prose, newline) becomes "?" and the event stays. */
const NAME_OK = /^[A-Za-z0-9._@:*-]{1,64}$/;
const nameOf = (v: unknown): string | null => { if (typeof v !== "string") return null; const o = redactSecrets(v).trim(); return !o ? null : NAME_OK.test(o) ? o : "?"; };
/** THE flip point for message summaries leaving the server (owner call, main session 2026-10-07: ON by default). A SendMessage `summary` /
 *  teammate-message `summary` attribute can quote work content, the same class as the removed task label. When false, every event keeps
 *  its names, kind and protocol word, and NO summary text leaves this module. */
export const EXPOSE_MESSAGE_SUMMARY = false; // td-osi.37: default-DENY until the receive scanner has a trustworthy envelope boundary (Codex B1)
const summaryOf = (v: unknown): string | null => { if (typeof v !== "string") return null; const o = redactForDisplay(v, SUMMARY_MAX).replace(/\s+/g, " ").trim(); return o || null; };
/** The protocol word from the summary's leading word, else the first 16 chars of the message. The message is read and dropped. */
export function protocolOf(summary: string | null, message: unknown): MessageProtocol | null {
  const m = (summary ? PROTOCOL.exec(summary) : null) ?? (typeof message === "string" ? PROTOCOL.exec(message.slice(0, 16)) : null);
  return m ? m[1].toUpperCase() as MessageProtocol : null;
}
const TAGS = ["teammate-message", "cross-session-message"] as const;
type TagName = (typeof TAGS)[number];
const ATTR = /([a-z_]+)="([^"]*)"/y;
const TOKEN = /<(\/?)(teammate-message|cross-session-message)(?=[\s>])/g;
const PREAMBLE = /^[A-Z][a-z]+ Claude session sent a message:[ \t]*\r?\n/;
const TRAILER_HEAD = "This came from another Claude session", TRAILER_MAX = 2000, MAX_TOKENS = 512;
/** Receive tags of a GENUINE harness receive envelope, else []. td-osi.37 (Codex B1): the record fields cannot tell a harness message from a
 *  human prompt (verified: identical key sets), so the TEXT must be the envelope, verified whole before any tag is read:
 *  [one "<Word> Claude session sent a message:" line] + balanced receive tags separated only by whitespace + [one short trailer paragraph,
 *  only after that preamble]. Any other non-whitespace outside the tags (prose, a code fence, a stray line), an unbalanced or nested tag, a
 *  literal closing tag inside a body, an unparsable attribute list, or more than MAX_TOKENS tag tokens => the WHOLE block is not an envelope
 *  and yields nothing (fail closed). A code fence INSIDE a body is fine (real bodies carry them). One regex pass plus slices: linear. */
export function leadingTags(text: string): { tag: TagName; attrs: Record<string, string> }[] {
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start++;
  const pre = PREAMBLE.exec(text.slice(start, start + 80));
  if (pre) start += pre[0].length;
  const toks: { close: boolean; tag: TagName; at: number }[] = [];
  TOKEN.lastIndex = start;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) { if (toks.length >= MAX_TOKENS) return []; toks.push({ close: m[1] === "/", tag: m[2] as TagName, at: m.index }); }
  if (toks.length === 0 || toks.length % 2 !== 0) return [];
  const blank = (a: number, b: number) => !/\S/.test(text.slice(a, b));
  const out: { tag: TagName; attrs: Record<string, string> }[] = [];
  let at = start;
  for (let i = 0; i < toks.length; i += 2) {
    const o = toks[i], c = toks[i + 1];
    if (o.close || !c.close || c.tag !== o.tag || !blank(at, o.at)) return [];
    let q = o.at + 1 + o.tag.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (q < c.at && /\s/.test(text[q])) q++;
      if (text[q] === ">") break;
      ATTR.lastIndex = q;
      const m = ATTR.exec(text);
      if (!m || ATTR.lastIndex > c.at) return [];
      attrs[m[1]] = m[2]; q = ATTR.lastIndex;
    }
    if (q >= c.at || text.startsWith(`</${c.tag}>`, c.at) === false) return [];
    out.push({ tag: o.tag, attrs });
    at = c.at + c.tag.length + 3;
  }
  const rest = text.slice(at).trim();
  if (rest && !(pre && rest.startsWith(TRAILER_HEAD) && rest.length <= TRAILER_MAX && !rest.includes("<"))) return [];
  return out;
}

/** `spawns` (optional, mutated): Agent tool_use id -> the name it was spawned under, so the hand-back in the same file can name its sender. */
/** `opts.exposeSummary` defaults to EXPOSE_MESSAGE_SUMMARY; it exists so the off state is testable, production passes nothing. */
export function messageEventsFromLine(line: string, laneKey: string, laneName: string | null, spawns?: Map<string, string>, opts: { exposeSummary?: boolean } = {}): MessageEvent[] {
  const expose = opts.exposeSummary ?? EXPOSE_MESSAGE_SUMMARY;
  const hit = line.includes('"name":"SendMessage"') || line.includes("teammate-message") || line.includes("cross-session-message") || line.includes('"name":"Agent"')
    || (line.includes("SubagentHandback") && line.includes('"toolUseResult"')) || (!!spawns?.size && line.includes('"toolUseResult"') && line.includes('"agentType"'));
  if (!hit) return [];
  let o: unknown;
  try { o = JSON.parse(line); } catch { return []; }
  const r = rec(o), msg = rec(r?.message);
  if (!r || !msg) return [];
  const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  if (!Number.isFinite(at)) return [];
  const mine = nameOf(laneName), me = mine && mine !== "?" ? mine : laneKey /* the full key, sealed opaque at the RPC boundary; a raw prefix would leak (Codex R4 M1) */, out: MessageEvent[] = [];
  const push = (kind: MessageKind, from: string, to: string, summary: string | null, protocol: MessageProtocol | null) => out.push({ at, kind, from, to, summary: expose ? summary : null, protocol, laneKey });
  const content = msg.content;
  if (r.type === "assistant" && Array.isArray(content)) {
    for (const c of content) {
      const b = rec(c), input = rec(b?.input);
      if (!b || b.type !== "tool_use" || !input) continue;
      if (b.name === "SendMessage") {
        const to = nameOf(input.to);
        if (!to) continue;
        const summary = summaryOf(input.summary);
        push("send", me, to, summary, protocolOf(summary, input.message));
      } else if (b.name === "Agent") {
        const type = nameOf(input.subagent_type), to = nameOf(input.name) ?? type ?? "agent";
        if (typeof b.id === "string" && spawns) { if (spawns.size >= 64) spawns.delete(spawns.keys().next().value as string); spawns.set(b.id, to); }
        push("spawn", me, to, type, null);
      }
    }
  } else if (r.type === "user") {
    // Harness receives are STRING content on a record with no isMeta/origin (verified); arrays (tool results, pasted prompts) never are.
    const texts = typeof content === "string" && !r.isMeta && !r.origin ? [content] : [];
    for (const t of texts) {
      if (!t.includes("<teammate-message") && !t.includes("<cross-session-message")) continue;
      for (const { tag, attrs: a } of leadingTags(t)) {
        const from = nameOf(tag === "teammate-message" ? a.teammate_id : a.from);
        if (!from) continue;
        if (tag === "teammate-message") { const summary = summaryOf(a.summary); push("receive", from, me, summary, protocolOf(summary, null)); }
        else push("receive", from, me, null, null);
      }
    }
    const tur = rec(r.toolUseResult);
    if (tur && typeof tur.agentType === "string" && tur.status === "completed" && Array.isArray(content)) {
      for (const c of content) {
        const b = rec(c);
        if (!b || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const from = spawns?.get(b.tool_use_id) ?? nameOf(tur.agentType) ?? "agent";
        // The result text is only searched for the failure marker; no part of it is kept.
        const bc = b.content, lost = (typeof bc === "string" ? bc : Array.isArray(bc) ? bc.map(x => rec(x)?.text).filter((x): x is string => typeof x === "string").join("\n") : "").includes(LOST_MARK);
        push(lost ? "handback-lost" : "handback", from, me, null, null);
        spawns?.delete(b.tool_use_id);
      }
    }
  }
  return out;
}
