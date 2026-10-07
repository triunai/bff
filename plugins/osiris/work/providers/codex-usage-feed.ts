// Codex rollout reader for the call -> usage join (fs only, no child process, no network). Incremental like the Claude feed (byte offsets
// per file via tailFrom), bounded like codex-feed.ts: at most CODEX_USAGE_LIMITS.maxFiles newest rollouts inside the 7-day read window,
// at most chunkBytes per file per poll, so a first poll over a big rollout catches up across polls. PRIVACY: only ids, token counts and the
// turn model are kept (call-usage-index.ts codexStep); no message, argument or output text is retained.
import { tailFrom } from "../../cache-economics.ts";
import { nodeFeedFs } from "../../transcript-feed.ts";
import type { FeedFs } from "../../transcript-feed.ts";
import { CODEX_ROOT, idFromPath, nodeCodexFs } from "../codex-feed.ts";
import type { CodexFs } from "../codex-feed.ts";
import { codexStart, codexStep, mergeIndexes } from "./call-usage-index.ts";
import type { CodexFileState } from "./call-usage-index.ts";
import type { ProviderIndex } from "../call-usage-join.ts";

export const CODEX_USAGE_LIMITS = { maxFiles: 60, maxAgeMs: 7 * 86_400_000, chunkBytes: 4 * 1024 * 1024 } as const;
export interface CodexUsageFeed { poll(root?: string): ProviderIndex | null }

/** ONE feed per service: holds per-file offsets and states. A file that leaves the listing leaves the state. Null when no rollout was read. */
export function createCodexUsageFeed(codexFs: CodexFs = nodeCodexFs, feedFs: FeedFs = nodeFeedFs, now: () => number = Date.now, limits: { maxFiles: number; maxAgeMs: number; chunkBytes: number } = CODEX_USAGE_LIMITS): CodexUsageFeed {
  let offsets: Record<string, number> = {};
  const files = new Map<string, CodexFileState>();
  return {
    poll(root = CODEX_ROOT) {
      const t = now();
      const kept = codexFs.listRollouts(root, t - limits.maxAgeMs).filter(f => t - f.mtimeMs <= limits.maxAgeMs).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1)).slice(0, limits.maxFiles);
      const live = new Set(kept.map(k => k.path));
      for (const p of files.keys()) if (!live.has(p)) { files.delete(p); delete offsets[p]; }
      for (const f of kept) {
        let tail;
        try { tail = tailFrom(offsets, f.path, (p, from) => feedFs.readChunk(p, from, limits.chunkBytes), limits.chunkBytes); } catch { continue; }
        offsets = tail.offsets;
        const st = tail.reset || !files.has(f.path) ? codexStart(idFromPath(f.path)) : files.get(f.path)!;
        files.set(f.path, tail.lines.length ? codexStep(st, tail.lines) : st);
      }
      return files.size ? mergeIndexes([...files.values()].map(s => s.idx)) : null;
    },
  };
}
