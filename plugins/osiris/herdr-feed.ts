import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fixtureReport } from "./analytics.ts";

export type HerdrSnapshot = {
  available: boolean;
  note: string;
  capturedAt: number | null;
  stale: boolean;
  coverage: { filesScanned: number; discoveryTruncated: boolean } | null;
  report: ReturnType<typeof fixtureReport> | null;
};
const empty = (note: string): HerdrSnapshot => ({ available: false, note, capturedAt: null, stale: true, coverage: null, report: null });
const MAX_BYTES = 8 * 1024 * 1024;
export const HERDR_FEED_PATH = join(homedir(), ".local", "share", "bff", "herdr-feed.json");

/** Consume one bounded metadata feed. Never read provider transcripts or launch a terminal. */
export async function readHerdrFeed(path = HERDR_FEED_PATH, now = Date.now()): Promise<HerdrSnapshot> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return empty("Herdr capture feed is not a bounded regular file.");
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) return empty("Herdr capture feed exceeds 8 MiB.");
      bytes = buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.kind !== "herdr-provider-capture" || !Number.isFinite(value.capturedAt) || value.capturedAt < 0 || value.capturedAt > now + 60000) return empty("Herdr capture feed has invalid provenance or timestamp.");
    const report = fixtureReport(value);
    if (report.calls.some(c => !["claude-transcript", "codex-transcript"].includes(c.source))) return empty("Herdr capture feed contains unsupported sources.");
    const count = value.coverage?.filesScanned;
    if (!Number.isInteger(count) || count < 0) return empty("Herdr capture feed has invalid coverage.");
    const stale = now - value.capturedAt > 30000;
    return {
      available: true, capturedAt: value.capturedAt, stale,
      note: "Local Claude/Codex provider capture; Herdr pane membership is unverified. " + (stale ? "Capture is older than 30 seconds." : "Capture is recent; this is not a process heartbeat."),
      coverage: { filesScanned: count, discoveryTruncated: value.coverage.discoveryTruncated === true }, report,
    };
  } catch { return empty("Herdr capture unavailable. Start bff herdr in a terminal; BB does not read native provider stores."); }
}
