import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureReport, reduceEvents, report, sanitizeCall } from "../../plugins/osiris/analytics.ts";
import type { EventRow } from "../../plugins/osiris/analytics.ts";
const thread = { id: "bb-thread", providerId: "codex", status: "idle" };
const row = (seq: number, type: string, item: Record<string, unknown>, createdAt?: number): EventRow => ({ id: `e${seq}`, seq, type, createdAt, scope: { kind: "turn", turnId: "turn" }, data: { providerThreadId: "session", item } });
test("shared fixtures: exact denominator, null timings and replay dedupe", () => {
    for (const file of ["fixture.json", "fixture-duplicate.json"]) {
        const r = fixtureReport(JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")));
        assert.equal(r.calls.length, 10);
        assert.deepEqual([r.totals.success, r.totals.error, r.totals.denied, r.totals.cancelled, r.totals.unknown, r.totals.running], [3, 3, 1, 1, 1, 1]);
        assert.equal(r.totals.durationSamples, 6);
        assert.equal(r.totals.errorRate, .5);
        assert.equal(r.calls.find(c => c.callId === "wrapper-timeout:ptc:1")?.parentCallId, "wrapper-timeout");
    }
});
test("shell result facts override misleading completed/exit zero status", () => {
    const r = report(reduceEvents([row(1, "item/completed", { id: "ok", type: "commandExecution", status: "completed", exitCode: 0 }), row(2, "item/completed", { id: "bad", type: "commandExecution", status: "completed", exitCode: 7 }), row(3, "item/completed", { id: "flag", type: "toolCall", tool: "dynamic", status: "completed", success: false, exitCode: 0 })], thread));
    assert.equal(r.totals.success, 1);
    assert.equal(r.totals.error, 2);
    assert.equal(r.totals.errorRate, 2 / 3);
});
test("completed shell calls without exit or explicit outcome remain unknown", () => {
    const calls = reduceEvents([
        row(1, "item/completed", { id: "missing", type: "commandExecution", status: "completed" }),
        row(2, "item/completed", { id: "ok", type: "commandExecution", status: "completed", exitCode: 0 }),
        row(3, "item/completed", { id: "bad", type: "commandExecution", status: "completed", exitCode: 7 }),
        row(4, "item/completed", { id: "explicit", type: "commandExecution", status: "completed", success: true }),
    ], thread);
    assert.deepEqual(calls.map(c => c.status), ["unknown", "success", "error", "success"]);
});
test("start/end pairs, duplicate events, nested identity and zero provider timing", () => {
    const start = row(1, "item/started", { id: "nested", type: "toolCall", tool: "search", server: "docs", parentToolCallId: "wrapper" }, 100);
    const end = row(2, "item/completed", { id: "nested", type: "toolCall", tool: "search", server: "docs", status: "completed", durationMs: 0 }, 110);
    const r = reduceEvents([end, start, start, end], thread);
    assert.equal(r.length, 1);
    assert.equal(r[0].parentCallId, "wrapper");
    assert.equal(r[0].durationMs, 0);
    assert.equal(r[0].durationKind, "provider");
    assert.equal(r[0].startedAt, 100);
    assert.equal(r[0].endedAt, 110);
    const observed = reduceEvents([start, row(3, "item/completed", { id: "nested", type: "toolCall", tool: "search", status: "completed" }, 120)], thread)[0];
    assert.equal(observed.durationMs, 20);
    assert.equal(observed.durationKind, "observed");
});
test("unmatched starts require live turn evidence; finished turn absent result is unknown", () => {
    const start = row(1, "item/started", { id: "tool", type: "fileRead" });
    assert.equal(reduceEvents([start], thread)[0].status, "unknown");
    assert.equal(reduceEvents([start], { ...thread, status: "active" })[0].status, "running");
    const done = { ...row(2, "turn/completed", {}), data: { status: "completed" } };
    assert.equal(reduceEvents([start, done], { ...thread, status: "active" })[0].status, "unknown");
    assert.equal(reduceEvents([start], thread)[0].durationMs, null);
});
test("denied, interrupted, MCP errors and unknown completed outcome stay separate", () => {
    const items = [{ approvalStatus: "denied", status: "failed" }, { status: "interrupted" }, { status: "completed", result: { isError: true } }, { status: "pending" }];
    const r = reduceEvents(items.map((facts, i) => row(i, "item/completed", { id: `c${i}`, type: "toolCall", tool: "mcp", ...facts })), thread);
    assert.deepEqual(r.map(c => c.status), ["denied", "cancelled", "error", "unknown"]);
    assert.equal(report(r).totals.errorRate, 1);
});
test("metadata export strips raw payloads and never clips opaque identities", () => {
    const base = fixtureReport(JSON.parse(readFileSync(new URL("./fixtures/fixture.json", import.meta.url), "utf8"))).calls[0];
    const prefix = "x".repeat(300);
    const r = report([{ ...base, callId: prefix + "a" }, { ...base, callId: prefix + "b" }]);
    assert.equal(r.totals.calls, 2);
    assert.equal(r.calls[0].callId.length, 301);
    const c = sanitizeCall({ ...base, arguments: "SECRET", output: "SECRET", errorCode: "SECRET output" });
    assert.equal(JSON.stringify(c).includes("SECRET"), false);
});
test("message and reasoning events never count as tool calls", () => { assert.equal(reduceEvents([row(1, "item/completed", { id: "r", type: "reasoning", content: ["SECRET"] }), row(2, "item/completed", { id: "a", type: "agentMessage", text: "SECRET" })], thread).length, 0); });
test("mixed synthetic and native records are rejected", () => { const c = fixtureReport(JSON.parse(readFileSync(new URL("./fixtures/fixture.json", import.meta.url), "utf8"))).calls[0]; assert.throws(() => fixtureReport({ version: 1, calls: [c, { ...c, source: "bb" }] }), /separate/); });
