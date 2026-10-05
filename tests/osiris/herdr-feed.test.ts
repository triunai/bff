import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHerdrFeed } from "../../plugins/osiris/herdr-feed.ts";
import { fixtureReport } from "../../plugins/osiris/analytics.ts";
import { readFileSync } from "node:fs";

test("Herdr feed is distinct, metadata-only, deduplicated and freshness-labelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osiris-feed-"));
  try {
    const base = fixtureReport(JSON.parse(readFileSync(new URL("./fixtures/fixture.json", import.meta.url), "utf8"))).calls[0];
    const call = { ...base, source: "claude-transcript", output: "SECRET", command: "SECRET" };
    const path = join(dir, "feed.json");
    await writeFile(path, JSON.stringify({ version: 1, kind: "herdr-provider-capture", capturedAt: 1000, calls: [call, call], coverage: { filesScanned: 1, discoveryTruncated: true } }));
    const value = await readHerdrFeed(path, 1100);
    assert.equal(value.available, true); assert.equal(value.report?.totals.calls, 1); assert.equal(value.stale, false);
    assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.equal(value.coverage?.discoveryTruncated, true);
    assert.equal((await readHerdrFeed(path, 32000)).stale, true);
  } finally { await rm(dir, { recursive: true }); }
});

test("missing, symlink, wrong-source and oversized feeds are unavailable, never clean zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osiris-feed-"));
  try {
    const path = join(dir, "feed.json");
    assert.equal((await readHerdrFeed(path)).report, null);
    await writeFile(path, JSON.stringify({ version: 1, kind: "fake", calls: [], capturedAt: 1 }));
    assert.equal((await readHerdrFeed(path)).available, false);
    const link = join(dir, "link.json"); await symlink(path, link);
    assert.equal((await readHerdrFeed(link)).available, false);
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.equal((await readHerdrFeed(path)).available, false);
  } finally { await rm(dir, { recursive: true }); }
});
