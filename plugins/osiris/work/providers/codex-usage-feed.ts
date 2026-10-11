// Codex rollout reader for the call -> usage join (fs only, no child process, no network). Incremental like the Claude feed (byte offsets
// per file via tailFrom), bounded like codex-feed.ts: at most CODEX_USAGE_LIMITS.maxFiles newest rollouts inside the 7-day read window,
// at most chunkBytes per file per poll, so a first poll over a big rollout catches up across polls. PRIVACY: only ids, token counts and the
// turn model are kept (call-usage-index.ts codexStep); no message, argument or output text is retained.
import { tailFrom } from "../../cache-economics.ts";
import { nodeAsyncFeedFs, nodeFeedFs } from "../../transcript-feed.ts";
import type { AsyncFeedFs, FeedFs } from "../../transcript-feed.ts";
import type { ReadChunk } from "../../cache-economics.ts";
import { CODEX_ROOT, idFromPath, nodeCodexFs } from "../codex-feed.ts";
import type { CodexFs } from "../codex-feed.ts";
import { codexStart, codexStep, mergeIndexes } from "./call-usage-index.ts";
import type { CodexFileState } from "./call-usage-index.ts";
import type { ProviderIndex } from "../call-usage-join.ts";

export const CODEX_USAGE_LIMITS = { maxFiles: 60, maxAgeMs: 7 * 86_400_000, chunkBytes: 4 * 1024 * 1024 } as const;
export interface CodexPollBudget { budgetBytes: number; deadline: number; sliceMs: number; clock: () => number }
export interface CodexUsageFeed {
  poll(root?: string): ProviderIndex | null;
  /** The server's path (2026-10-11): fs/promises reads, a byte + time budget per poll, an event-loop turn every sliceMs. Same state as poll. */
  pollAsync?(root: string, budget: CodexPollBudget): Promise<{ index: ProviderIndex | null; capped: boolean }>;
}

/** ONE feed per service: holds per-file offsets and states. A file that leaves the listing leaves the state. Null when no rollout was read. */
export function createCodexUsageFeed(codexFs: CodexFs = nodeCodexFs, feedFs: FeedFs = nodeFeedFs, now: () => number = Date.now, limits: { maxFiles: number; maxAgeMs: number; chunkBytes: number } = CODEX_USAGE_LIMITS, asyncFs: Pick<AsyncFeedFs, "readChunk"> = nodeAsyncFeedFs): CodexUsageFeed {
  let offsets: Record<string, number> = {};
  const files = new Map<string, CodexFileState>();
  const listKept = (root: string) => {
    const t = now();
    const kept = codexFs.listRollouts(root, t - limits.maxAgeMs).filter(f => t - f.mtimeMs <= limits.maxAgeMs).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1)).slice(0, limits.maxFiles);
    const live = new Set(kept.map(k => k.path));
    for (const p of files.keys()) if (!live.has(p)) { files.delete(p); delete offsets[p]; }
    return kept;
  };
  const step = (path: string, read: ReadChunk) => {
    let tail;
    try { tail = tailFrom(Object.hasOwn(offsets, path) ? { [path]: offsets[path] } : {}, path, read, limits.chunkBytes); } catch { return; }
    offsets[path] = tail.offsets[path];
    const st = tail.reset || !files.has(path) ? codexStart(idFromPath(path)) : files.get(path)!;
    files.set(path, tail.lines.length ? codexStep(st, tail.lines) : st);
  };
  const index = () => (files.size ? mergeIndexes([...files.values()].map(s => s.idx)) : null);
  return {
    async pollAsync(root, b) {
      const kept = listKept(root), EMPTY = new Uint8Array(0);
      let budget = b.budgetBytes, capped = false, slice = b.clock();
      for (const f of kept) {
        const from0 = Object.hasOwn(offsets, f.path) ? offsets[f.path] : 0;
        if (budget <= 0 || b.clock() >= b.deadline) { capped = true; continue; } // waits for the next poll; a rollout never read gets no state (index stays null until one is read)
        let first: { bytes: Uint8Array; size: number }, again: { bytes: Uint8Array; size: number } | null = null;
        try {
          first = await asyncFs.readChunk(f.path, from0, limits.chunkBytes);
          if (first.size < from0) again = await asyncFs.readChunk(f.path, 0, limits.chunkBytes);
        } catch { continue; }
        for (const c of again ? [first, again] : [first]) budget -= c.bytes.length;
        const done = again ?? first;
        if ((again ? 0 : from0) + done.bytes.length < done.size) capped = true;
        step(f.path, (_p, from) => (again && from === 0 ? again : from === from0 ? first : { bytes: EMPTY, size: from }));
        if (b.clock() - slice >= b.sliceMs) { await new Promise<void>(r => setImmediate(r)); slice = b.clock(); }
      }
      return { index: index(), capped };
    },
    poll(root = CODEX_ROOT) {
      for (const f of listKept(root)) step(f.path, (p, from) => feedFs.readChunk(p, from, limits.chunkBytes));
      return index();
    },
  };
}
