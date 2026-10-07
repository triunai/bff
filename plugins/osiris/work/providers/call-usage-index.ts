// Per-provider transcript -> usage INDEX builders (pure, browser-safe) for the call join (work/call-usage-join.ts). They read ids and
// numbers only: a tool_use / call_id, a request key, token counts, a model id. Content, arguments and output are never touched.
//   Claude: an assistant line has message.id + requestId and `tool_use` blocks { id }; the usage comes from the deduped UsageRow of that pair.
//   Codex:  a `custom_tool_call` / `function_call` (call_id) is claimed by the NEXT `token_usage_record` ({turn_id, response_id, usage});
//           the turn's own total (turn_token_usage) is the fallback for a call only matched by its turn. Codex counts cached tokens INSIDE
//           input_tokens, so the fresh input is input - cached.
//   Gemini: a model message has tokens {input, output, cached, thoughts} and toolCalls[].id. input INCLUDES cached (UNVERIFIED on a real
//           install: written from the documented format and fixtures), so the fresh input is input - cached; thoughts count as output.
import { parseGeminiCallUsage } from "./gemini-feed.ts";
import { rowKey } from "../../cache-economics.ts";
import type { UsageRow } from "../../cache-economics.ts";
import type { ProviderIndex, RequestUsage } from "../call-usage-join.ts";

/** Newest tool-call entries kept per provider: bounds the payload (each entry is two 13-char keys). */
export const INDEX_MAX_CALLS = 3000;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** The request key and `tool_use` ids of one Claude transcript line, or null. Same key format as cache-economics rowKey, so it joins the deduped rows. */
export function claudeToolUses(line: string): { key: string; ids: string[] } | null {
  if (!line.includes('"tool_use"')) return null;
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  const r = obj(o), msg = obj(r.message);
  if (r.type !== "assistant") return null;
  const messageId = str(msg.id), requestId = str(r.requestId);
  if (!messageId || !requestId || !Array.isArray(msg.content)) return null;
  const ids = (msg.content as unknown[]).flatMap(b => { const x = obj(b); return x.type === "tool_use" && str(x.id) ? [x.id as string] : []; });
  return ids.length ? { key: JSON.stringify([messageId, requestId]), ids } : null;
}

export interface ClaudeFileFacts { sessionId: string; agentId: string | null; rows: readonly UsageRow[]; /** tool_use id -> request key, from claudeToolUses */ toolReq: ReadonlyMap<string, string> }
const rowUsage = (r: UsageRow): RequestUsage => ({ model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h });

/** The Claude index: a call id joins to its request key only when that request has a usage row (a streamed request keeps its LAST row). */
export function claudeIndex(files: readonly ClaudeFileFacts[]): ProviderIndex {
  const idx: ProviderIndex = { sessions: [], calls: {}, requests: {} };
  const sessions = new Set<string>();
  for (const f of files) {
    sessions.add(f.sessionId); if (f.agentId) sessions.add(f.agentId);
    const keyed = new Set<string>();
    for (const r of f.rows) { const k = rowKey(r); if (k !== null) { idx.requests[k] = rowUsage(r); keyed.add(k); } }
    for (const [id, k] of f.toolReq) if (keyed.has(k)) idx.calls[id] = k;
  }
  idx.sessions = [...sessions];
  return boundCalls(idx);
}

/** Keep at most INDEX_MAX_CALLS call entries (the newest inserted last) and only the requests they point at. */
function boundCalls(idx: ProviderIndex): ProviderIndex {
  const ids = Object.keys(idx.calls);
  if (ids.length <= INDEX_MAX_CALLS) return idx;
  const calls: Record<string, string> = {};
  for (const id of ids.slice(-INDEX_MAX_CALLS)) calls[id] = idx.calls[id];
  const used = new Set(Object.values(calls)), requests: Record<string, RequestUsage> = {};
  for (const k of Object.keys(idx.requests)) if (used.has(k)) requests[k] = idx.requests[k];
  return { ...idx, calls, requests };
}

/** Codex usage with the cached tokens taken out of input (they are counted inside it). */
function codexUsage(u: Record<string, unknown>, model: string | null): RequestUsage {
  const cached = num(u.cached_input_tokens);
  return { model, input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cacheRead: cached, cacheWrite5m: num(u.cache_write_input_tokens), cacheWrite1h: 0 };
}
/** What a Codex rollout reader carries between chunks: the index so far, the calls waiting for their response's usage record, the turn models. */
export interface CodexFileState { idx: ProviderIndex; pending: string[]; turnModel: Record<string, string> }
export const codexStart = (sessionId: string): CodexFileState => ({ idx: { sessions: [sessionId], calls: {}, turns: {}, requests: {} }, pending: [], turnModel: {} });
/** Fold more rollout lines into the state (mutates and returns it: the feed owns it). */
export function codexStep(st: CodexFileState, lines: readonly string[]): CodexFileState {
  const { idx } = st, sessions = new Set(idx.sessions);
  for (const l of lines) {
    if (!l.includes('"call_id"') && !l.includes('"token_usage_record"') && !l.includes('"turn_context"')) continue;
    let o: Record<string, unknown>;
    try { o = obj(JSON.parse(l)); } catch { continue; }
    const p = obj(o.payload);
    if (o.type === "turn_context") { const t = str(p.turn_id), m = str(p.model); if (t && m) st.turnModel[t] = m; continue; }
    if (o.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) { const id = str(p.call_id); if (id) st.pending.push(id); continue; }
    if (o.type !== "token_usage_record") continue;
    const turn = str(p.turn_id), resp = str(p.response_id), usage = obj(p.usage);
    if (!turn) { st.pending = []; continue; }
    for (const s of [str(p.thread_id), str(p.session_id)]) if (s) sessions.add(s);
    const model = st.turnModel[turn] ?? null;
    if (resp && Object.keys(usage).length) {
      const rk = JSON.stringify([turn, resp]);
      idx.requests[rk] = codexUsage(usage, model);
      for (const id of st.pending) idx.calls[id] = rk;
    }
    const tt = obj(p.turn_token_usage);
    if (Object.keys(tt).length) { const tk = JSON.stringify([turn]); idx.requests[tk] = codexUsage(tt, model); idx.turns![turn] = tk; }
    st.pending = [];
  }
  idx.sessions = [...sessions];
  return st;
}
/** The Codex index of one rollout's lines. `sessionId` is the file's own id (a call carries it as its sessionId). */
export const codexIndex = (lines: readonly string[], sessionId: string): ProviderIndex => boundCalls(codexStep(codexStart(sessionId), lines).idx);

/** The Gemini index of one session file's text: toolCalls[].id -> that message's tokens (shared by every call the message emitted). */
export function geminiIndex(text: string, sessionId: string, complete = true): ProviderIndex {
  const idx: ProviderIndex = { sessions: [sessionId], calls: {}, requests: {} };
  for (const m of parseGeminiCallUsage(text, complete)) {
    if (!m.callIds.length) continue;
    const rk = JSON.stringify([m.messageId]);
    idx.requests[rk] = { model: m.model, input: Math.max(0, m.input - m.cached), output: m.output + m.thoughts, cacheRead: m.cached, cacheWrite5m: 0, cacheWrite1h: 0 };
    for (const id of m.callIds) idx.calls[id] = rk;
  }
  return boundCalls(idx);
}

/** Merge several per-file indexes of one provider into one (later files win on a clash, which only a reused id could cause). */
export function mergeIndexes(parts: readonly ProviderIndex[]): ProviderIndex {
  const out: ProviderIndex = { sessions: [], calls: {}, requests: {} }, sessions = new Set<string>();
  for (const p of parts) {
    for (const s of p.sessions) sessions.add(s);
    Object.assign(out.calls, p.calls); Object.assign(out.requests, p.requests);
    if (p.turns) out.turns = Object.assign(out.turns ?? {}, p.turns);
  }
  out.sessions = [...sessions];
  return boundCalls(out);
}
