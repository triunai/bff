// Codex session feed (fs only, no child process, no network): the newest Codex rollout files under ~/.codex/sessions, each reduced to a
// whitelisted header. Bounded the way telemetry-rpc bounds Claude transcripts: at most CODEX_LIMITS.maxFiles files modified within
// maxAgeMs, and only the first headBytes of each file are ever read, ONCE per path (the header is cached); every poll only stats mtimes.
// PRIVACY: from the head only { id, startedAt, cwd, branch, model, parentId, nickname } are copied; every other record and field
// (instructions, messages, tool output) is dropped as soon as it is parsed. Fleet-model turns cwd into a short display name.
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_ROOT = join(homedir(), ".codex", "sessions");
export const CODEX_LIMITS = { maxFiles: 200, maxAgeMs: 7 * 86_400_000, headBytes: 64 * 1024 } as const;

export interface CodexFs {
  /** Rollout files under root (regular files only) with their mtime; `sinceMs` lets an implementation skip old date directories. */
  listRollouts(root: string, sinceMs: number): { path: string; mtimeMs: number }[];
  /** At most `bytes` bytes from the start of the file, decoded as utf8, or null when unreadable. */
  readHead(path: string, bytes: number): string | null;
}
export interface CodexSession {
  id: string;
  startedAt: number | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  /** The parent session's id (subagent rollouts), else null. */
  parentId: string | null;
  /** Short agent nickname Codex assigned to a sub-agent, else null. */
  nickname: string | null;
  /** The file's mtime: when this session last wrote. */
  lastAt: number;
}
type Head = Omit<CodexSession, "lastAt">;

export const nodeCodexFs: CodexFs = {
  listRollouts(root, sinceMs) {
    const out: { path: string; mtimeMs: number }[] = [];
    const dirs = (d: string) => { try { return readdirSync(d).filter(n => /^\d+$/.test(n)).sort(); } catch { return []; } };
    // Layout YYYY/MM/DD: a day directory older than the cutoff (minus a day of slack for timezones) cannot hold a recent file.
    const cut = new Date(sinceMs - 86_400_000), cutKey = cut.getUTCFullYear() * 10_000 + (cut.getUTCMonth() + 1) * 100 + cut.getUTCDate();
    for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
      if (Number(y) * 10_000 + Number(m) * 100 + Number(d) < cutKey) continue;
      const day = join(root, y, m, d);
      let names: string[]; try { names = readdirSync(day); } catch { continue; }
      for (const n of names) {
        if (!/^rollout-.*\.jsonl$/.test(n)) continue;
        const p = join(day, n);
        try { const st = lstatSync(p); if (st.isFile()) out.push({ path: p, mtimeMs: st.mtimeMs }); } catch { /* vanished */ }
      }
    }
    return out;
  },
  readHead(path, bytes) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(bytes), n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
  },
};

/** The trailing uuid of `rollout-<time>-<uuid>.jsonl`, else the bare file name. */
export const idFromPath = (p: string): string => { const n = (p.split("/").pop() ?? p).replace(/\.jsonl$/, ""); return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(n)?.[0] ?? n; };
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Whitelisted header from the head text: `session_meta` (first) and the first `turn_context` model. A trailing partial line is ignored. */
export function parseCodexHead(text: string, complete: boolean): Head | null {
  const lines = text.split("\n");
  if (!complete) lines.pop(); // the cut-off tail line
  let head: Head | null = null, model: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try { o = obj(JSON.parse(line)); } catch { continue; }
    const p = obj(o.payload);
    if (o.type === "session_meta" && !head) {
      const id = str(p.id) ?? str(p.session_id);
      if (!id) return null;
      const at = typeof p.timestamp === "string" ? Date.parse(p.timestamp) : NaN, child = obj(obj(obj(p.source).subagent).thread_spawn);
      head = { id, startedAt: Number.isFinite(at) ? at : null, cwd: str(p.cwd), branch: str(obj(p.git).branch), model: null, parentId: str(p.parent_thread_id) ?? str(child.parent_thread_id), nickname: str(p.agent_nickname) ?? str(child.agent_nickname) };
    } else if (o.type === "turn_context" && model === null) model = str(p.model) ?? str(obj(obj(p.collaboration_mode).settings).model);
    if (head && model) break;
  }
  return head ? { ...head, model } : null;
}

export interface CodexFeed { poll(root?: string): CodexSession[]; /** Header-cache entries held (bounded by limits.maxFiles after every poll). */ size?(): number }
/** ONE feed per service: holds the header cache. Each poll lists, bounds, stats and reads only headers it has not read yet. */
export function createCodexFeed(fs: CodexFs = nodeCodexFs, now: () => number = Date.now, limits: { maxFiles: number; maxAgeMs: number; headBytes: number } = CODEX_LIMITS): CodexFeed {
  // `final`: the header will not change by reading again (parsed WITH a model, or the whole head window was read). A header parsed before
  // its first turn_context is kept and re-read only when the file has grown since (mtime moved), so an abandoned session costs nothing.
  const heads = new Map<string, { h: Head | null; final: boolean; mtimeMs: number }>();
  return {
    poll(root = CODEX_ROOT) {
      const t = now();
      const kept = fs.listRollouts(root, t - limits.maxAgeMs).filter(f => t - f.mtimeMs <= limits.maxAgeMs).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1)).slice(0, limits.maxFiles);
      const live = new Set(kept.map(k => k.path));
      for (const p of heads.keys()) if (!live.has(p)) heads.delete(p);
      const out: CodexSession[] = [];
      for (const f of kept) {
        const had = heads.get(f.path);
        if (!had || (!had.final && had.mtimeMs !== f.mtimeMs)) {
          const text = fs.readHead(f.path, limits.headBytes), size = text === null ? 0 : Buffer.byteLength(text), h = text === null ? null : parseCodexHead(text, size < limits.headBytes);
          // A header that is not there YET (empty or just-created file) is retried next poll; so is one still missing its model.
          const full = size >= limits.headBytes;
          // A FULL window with no readable header (the session_meta line is longer than headBytes) is still a live session: list it with
          // null fields under an id taken from the file name, never drop it (and never cache it as 'no session').
          const shown = h ?? (full ? { id: idFromPath(f.path), startedAt: null, cwd: null, branch: null, model: null, parentId: null, nickname: null } : null);
          if (shown) heads.set(f.path, { h: shown, final: full || (h !== null && h.model !== null), mtimeMs: f.mtimeMs });
          else if (!had?.h) continue; // nothing known yet: retry next poll; a known session stays (a failed re-read is not "gone")
        }
        const h = heads.get(f.path)?.h;
        if (h) out.push({ ...h, lastAt: f.mtimeMs });
      }
      return out;
    },
    size: () => heads.size,
  };
}
