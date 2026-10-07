// Gemini CLI session feed (fs only, no child process, no network). UNVERIFIED on a real install: written from the documented storage
// format (see docs/design/2026-10-07-osiris-dashboard-harmony.md, "Gemini CLI storage") and fixtures; this Mac has no ~/.gemini.
//   sessions: ~/.gemini/tmp/<project-id>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl
//   subagents: ~/.gemini/tmp/<project-id>/chats/<parentSessionId>/<sessionId>.jsonl
//   records: a metadata record { sessionId, projectHash, startTime, lastUpdated, kind: main | subagent }, then messages
//   { id, timestamp, type: user | gemini, model, tokens, toolCalls[{ id, name, status, timestamp }] } and $rewindTo / $patch / $set edits.
// PRIVACY (default-deny, same rule as codex-feed.ts): only ids, names, numbers and timestamps are copied. `content`, `thoughts`,
// `displayContent`, `summary` and `memoryScratchpad` are dropped at parse time. Bounded like the Codex feed: max files, max age, head bytes.
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "./registry.ts";

/** The registry id of this provider, carried on every session so browser-safe code (fleet-model) never names it. */
const GEMINI_PROVIDER: ProviderId = "gemini";
export const GEMINI_ROOT = join(homedir(), ".gemini", "tmp");
export const GEMINI_LIMITS = { maxFiles: 200, maxAgeMs: 7 * 86_400_000, headBytes: 64 * 1024 } as const;

export interface GeminiFs {
  /** Session files under root with their mtime (regular files only). */
  listSessions(root: string, sinceMs: number): { path: string; mtimeMs: number }[];
  readHead(path: string, bytes: number): string | null;
}
export interface GeminiSession {
  runtime: ProviderId;
  id: string;
  startedAt: number | null;
  /** The registry id of the project directory (or its hash on older builds). Gemini files carry no cwd, so this is the workspace key. */
  projectId: string | null;
  model: string | null;
  parentId: string | null;
  kind: "main" | "subagent";
  lastAt: number;
}
type Head = Omit<GeminiSession, "lastAt" | "runtime">;
export interface GeminiToolCall { id: string; tool: string; status: string | null; at: number | null }
export interface GeminiUsage { messageId: string; model: string | null; input: number; output: number; cached: number; thoughts: number }

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ts = (v: unknown): number | null => { const n = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; };

/** `<root>/<project>/chats/session-….jsonl` -> project; `.../chats/<parent>/<id>.jsonl` -> project + parent. Null when the path is not that shape. */
export function pathParts(root: string, path: string): { projectId: string; parentId: string | null; fileId: string } | null {
  if (!path.startsWith(root)) return null;
  const seg = path.slice(root.length).split("/").filter(Boolean);
  if (seg[1] !== "chats" || !/\.jsonl?$/.test(seg[seg.length - 1] ?? "")) return null;
  const fileId = seg[seg.length - 1].replace(/\.jsonl?$/, "");
  if (seg.length === 3) return { projectId: seg[0], parentId: null, fileId };
  if (seg.length === 4) return { projectId: seg[0], parentId: seg[2], fileId };
  return null;
}

function records(text: string, complete: boolean): Record<string, unknown>[] {
  const lines = text.split("\n");
  if (!complete) lines.pop(); // the cut-off tail line
  const out: Record<string, unknown>[] = [];
  for (const l of lines) { if (!l) continue; try { out.push(obj(JSON.parse(l))); } catch { /* malformed line: skipped */ } }
  return out;
}
/** Apply `$rewindTo` in order (drops the message with that id and everything after it); other edit records are ignored (unverified). */
function messagesOf(recs: Record<string, unknown>[]): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [];
  for (const r of recs) {
    if (typeof r.$rewindTo === "string") { const i = msgs.findIndex(m => m.id === r.$rewindTo); if (i >= 0) msgs.length = i; continue; }
    if (Object.keys(r).some(k => k.startsWith("$")) || (r.type !== "user" && r.type !== "gemini")) continue;
    msgs.push(r);
  }
  return msgs;
}
/** Whitelisted header from the head text: the metadata record and the first model seen. */
export function parseGeminiHead(text: string, complete: boolean): Pick<Head, "id" | "startedAt" | "model" | "kind"> & { projectHash: string | null } | null {
  const recs = records(text, complete), meta = recs.find(r => typeof r.sessionId === "string" && r.type === undefined);
  if (!meta) return null;
  const model = messagesOf(recs).map(m => str(m.model)).find(m => m !== null) ?? null;
  return { id: meta.sessionId as string, startedAt: ts(meta.startTime), model, kind: meta.kind === "subagent" ? "subagent" : "main", projectHash: str(meta.projectHash) };
}
/** Tool calls by id (names, status, time only): the per-call join keys (`toolCalls[].id`). */
export function parseGeminiToolCalls(text: string, complete = true): GeminiToolCall[] {
  const out: GeminiToolCall[] = [];
  for (const m of messagesOf(records(text, complete)))
    if (m.type === "gemini" && Array.isArray(m.toolCalls))
      for (const c of m.toolCalls) { const o = obj(c), id = str(o.id); if (id) out.push({ id, tool: str(o.name) ?? "unknown", status: str(o.status), at: ts(o.timestamp) }); }
  return out;
}
/** Per-message token counts. `cached` and `thoughts` map onto the cacheRead / output buckets (design). No price: Gemini stays "$ n/a". */
export function parseGeminiUsage(text: string, complete = true): GeminiUsage[] {
  const out: GeminiUsage[] = [];
  for (const m of messagesOf(records(text, complete))) {
    const id = str(m.id), t = obj(m.tokens);
    if (m.type === "gemini" && id && Object.keys(t).length) out.push({ messageId: id, model: str(m.model), input: num(t.input), output: num(t.output), cached: num(t.cached), thoughts: num(t.thoughts) });
  }
  return out;
}

/** One model message: its token counts and the ids of the tool calls it emitted (the per-call join: `toolCalls[].id` -> that message's `tokens`). */
export interface GeminiCallUsage { messageId: string; model: string | null; input: number; output: number; cached: number; thoughts: number; callIds: string[] }
export function parseGeminiCallUsage(text: string, complete = true): GeminiCallUsage[] {
  const out: GeminiCallUsage[] = [];
  for (const m of messagesOf(records(text, complete))) {
    const id = str(m.id), t = obj(m.tokens);
    if (m.type !== "gemini" || !id || !Object.keys(t).length) continue;
    const callIds = Array.isArray(m.toolCalls) ? m.toolCalls.flatMap(c => { const i = str(obj(c).id); return i ? [i] : []; }) : [];
    out.push({ messageId: id, model: str(m.model), input: num(t.input), output: num(t.output), cached: num(t.cached), thoughts: num(t.thoughts), callIds });
  }
  return out;
}

export const nodeGeminiFs: GeminiFs = {
  listSessions(root, sinceMs) {
    const out: { path: string; mtimeMs: number }[] = [];
    const names = (d: string) => { try { return readdirSync(d); } catch { return []; } };
    const file = (p: string) => { try { const st = lstatSync(p); if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs }); } catch { /* vanished */ } };
    for (const proj of names(root)) {
      const chats = join(root, proj, "chats");
      for (const n of names(chats)) {
        const p = join(chats, n);
        if (/^session-.*\.jsonl$/.test(n)) file(p);
        else for (const s of names(p)) if (/\.jsonl$/.test(s)) file(join(p, s)); // chats/<parentSessionId>/<sessionId>.jsonl
      }
    }
    return out;
  },
  readHead(path, bytes) {
    let fd: number | null = null;
    try { fd = openSync(path, "r"); const buf = Buffer.alloc(bytes), n = readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n).toString("utf8"); }
    catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
  },
};

export interface GeminiFeed { poll(root?: string): GeminiSession[]; size?(): number }
/** ONE feed per service, same shape as createCodexFeed: lists, bounds, stats; a header is read once per path (re-read while it has no model and the file grew). */
export function createGeminiFeed(fs: GeminiFs = nodeGeminiFs, now: () => number = Date.now, limits: { maxFiles: number; maxAgeMs: number; headBytes: number } = GEMINI_LIMITS): GeminiFeed {
  const heads = new Map<string, { h: Head; final: boolean; mtimeMs: number }>();
  return {
    poll(root = GEMINI_ROOT) {
      const t = now();
      const kept = fs.listSessions(root, t - limits.maxAgeMs).filter(f => t - f.mtimeMs <= limits.maxAgeMs).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1)).slice(0, limits.maxFiles);
      const live = new Set(kept.map(k => k.path));
      for (const p of heads.keys()) if (!live.has(p)) heads.delete(p);
      const out: GeminiSession[] = [];
      for (const f of kept) {
        const had = heads.get(f.path), parts = pathParts(root, f.path);
        if (!had || (!had.final && had.mtimeMs !== f.mtimeMs)) {
          const text = fs.readHead(f.path, limits.headBytes), full = text !== null && Buffer.byteLength(text) >= limits.headBytes;
          const p = text === null ? null : parseGeminiHead(text, !full);
          // A missing or unreadable header still lists the file under its path-derived id (a live session is never dropped), retried while it grows.
          const h: Head = { id: p?.id ?? parts?.fileId ?? f.path, startedAt: p?.startedAt ?? null, projectId: parts?.projectId ?? null, model: p?.model ?? null, parentId: parts?.parentId ?? null, kind: p?.kind ?? (parts?.parentId ? "subagent" : "main") };
          heads.set(f.path, { h, final: full || (p !== null && p.model !== null), mtimeMs: f.mtimeMs });
        }
        const h = heads.get(f.path)?.h;
        if (h) out.push({ ...h, runtime: GEMINI_PROVIDER, lastAt: f.mtimeMs });
      }
      return out;
    },
    size: () => heads.size,
  };
}
