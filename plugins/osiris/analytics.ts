export const statuses = ["success", "error", "denied", "cancelled", "unknown", "running"] as const;
export type Status = typeof statuses[number];
export interface Call {
    source: string;
    provider: string;
    sessionId: string;
    callId: string;
    turnId: string | null;
    parentCallId: string | null;
    model: string | null;
    tool: string;
    server: string | null;
    status: Status;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
    durationKind: "provider" | "observed" | "unknown";
    errorCode: string | null;
}
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === "object" ? v as Obj : {};
const string = (v: unknown) => typeof v === "string" && v.length ? v : null;
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export const callKey = (c: Call) => JSON.stringify([c.source, c.provider, c.sessionId, c.callId]);
/** Whitelist metadata; never retain commands, arguments, output or reasoning. */
export function sanitizeCall(value: unknown): Call {
    const c = object(value);
    for (const k of ["source", "provider", "sessionId", "callId", "tool"])
        if (!string(c[k]))
            throw new Error(`Missing call metadata: ${k}`);
    if (!statuses.includes(c.status as Status))
        throw new Error("Invalid call status");
    const durationMs = number(c.durationMs);
    return { source: string(c.source)!, provider: string(c.provider)!, sessionId: string(c.sessionId)!, callId: string(c.callId)!, tool: string(c.tool)!, status: c.status as Status, server: string(c.server), turnId: string(c.turnId), parentCallId: string(c.parentCallId), model: string(c.model), startedAt: number(c.startedAt), endedAt: number(c.endedAt), durationMs, durationKind: durationMs !== null && (c.durationKind === "provider" || c.durationKind === "observed") ? c.durationKind : "unknown", errorCode: typeof c.errorCode === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(c.errorCode) ? c.errorCode : null };
}
export function dedupe(calls: Call[]): Call[] {
    const map = new Map<string, Call>();
    for (const incoming of calls) {
        const c = sanitizeCall(incoming), key = callKey(c), old = map.get(key);
        if (!old)
            map.set(key, c);
        else if (!(["running", "unknown"].includes(c.status) && !["running", "unknown"].includes(old.status)))
            map.set(key, { ...c, startedAt: old.startedAt ?? c.startedAt, durationMs: c.durationMs ?? old.durationMs, durationKind: c.durationMs !== null ? c.durationKind : old.durationKind });
    }
    return [...map.values()];
}
export function totals(calls: Call[]) {
    const counts = { calls: calls.length, success: 0, error: 0, denied: 0, cancelled: 0, unknown: 0, running: 0 };
    for (const c of calls)
        counts[c.status]++;
    const ds = calls.flatMap(c => c.durationMs === null ? [] : [c.durationMs]).sort((a, b) => a - b);
    return { ...counts, durationSamples: ds.length, errorRate: counts.success + counts.error ? counts.error / (counts.success + counts.error) : null, meanDurationMs: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null, p50DurationMs: ds.length ? ds[Math.ceil(ds.length * .5) - 1] : null, p95DurationMs: ds.length ? ds[Math.ceil(ds.length * .95) - 1] : null };
}
export function report(input: Call[]) { const calls = dedupe(input), groups = new Map<string, Call[]>(); for (const c of calls) {
    const key = JSON.stringify([c.source, c.provider, c.server, c.tool]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
} return { version: 1 as const, calls, totals: totals(calls), tools: [...groups.values()].map(cs => ({ source: cs[0].source, provider: cs[0].provider, tool: cs[0].tool, server: cs[0].server, ...totals(cs) })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)) }; }
export function fixtureReport(value: unknown) { const e = object(value); if (e.version !== 1 || !Array.isArray(e.calls))
    throw new Error("Expected version 1 calls envelope"); if (e.calls.length > 100000)
    throw new Error("Fixture exceeds 100000 records"); const calls = e.calls.map(sanitizeCall); if (calls.some(c => c.source === "fixture") && calls.some(c => c.source !== "fixture"))
    throw new Error("Keep fixture and native sources in separate imports"); return report(calls); }
export interface EventRow {
    id?: string;
    seq: number;
    type: string;
    createdAt?: number;
    scope?: {
        kind: string;
        turnId?: string;
    };
    data: unknown;
}
const toolTypes = new Set(["commandExecution", "fileChange", "webSearch", "imageView", "imageGeneration", "fileRead", "search", "toolCall", "mcpToolCall", "dynamicToolCall", "backgroundTask", "delegation"]);
function outcome(item: Obj, completed: boolean, live: boolean): {
    status: Status;
    errorCode: string | null;
} {
    if (item.approvalStatus === "denied" || item.status === "denied")
        return { status: "denied", errorCode: "PERMISSION_DENIED" };
    if (["interrupted", "cancelled", "canceled"].includes(String(item.status)))
        return { status: "cancelled", errorCode: "CANCELLED" };
    if (typeof item.exitCode === "number" && item.exitCode !== 0)
        return { status: "error", errorCode: "NONZERO_EXIT" };
    if (item.status === "failed" || item.success === false || item.isError === true || object(item.result).isError === true || item.error)
        return { status: "error", errorCode: "TOOL_ERROR" };
    if (completed && item.type === "commandExecution" && item.exitCode !== 0 && item.success !== true && item.status !== "success")
        return { status: "unknown", errorCode: null };
    if (completed && (item.status === "completed" || item.status === "success" || item.exitCode === 0))
        return { status: "success", errorCode: null };
    return { status: live && !completed ? "running" : "unknown", errorCode: null };
}
export function reduceEvents(rows: EventRow[], thread: {
    id: string;
    providerId: string;
    status: string;
}): Call[] {
    const calls = new Map<string, Call>(), seen = new Set<string>(), finished = new Set<string>();
    const sorted = [...rows].sort((a, b) => a.seq - b.seq);
    for (const row of sorted)
        if (row.type === "turn/completed" && row.scope?.turnId)
            finished.add(row.scope.turnId);
    for (const row of sorted) {
        const eventKey = row.id ?? `${row.seq}:${row.type}`;
        if (seen.has(eventKey))
            continue;
        seen.add(eventKey);
        if (row.type !== "item/started" && row.type !== "item/completed")
            continue;
        const data = object(row.data), item = object(data.item), id = string(item.id), type = string(item.type);
        if (!id || !type || !toolTypes.has(type))
            continue;
        const sessionId = string(data.providerThreadId) ?? thread.id, key = JSON.stringify([sessionId, id]), old = calls.get(key), completed = row.type === "item/completed", turnId = string(row.scope?.turnId) ?? old?.turnId ?? null;
        const live = thread.status === "active" && !!turnId && !finished.has(turnId), when = number(row.createdAt), measured = number(item.durationMs), startedAt = old?.startedAt ?? (!completed ? when : null), endedAt = completed ? when : old?.endedAt ?? null;
        const durationMs = measured ?? (startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : old?.durationMs ?? null);
        const c: Call = { source: "bb", provider: thread.providerId, sessionId, callId: id, turnId, parentCallId: string(item.parentToolCallId) ?? string(data.parentToolCallId) ?? old?.parentCallId ?? null, model: old?.model ?? null, tool: string(item.tool) ?? type, server: string(item.server), ...outcome(item, completed, live), startedAt, endedAt, durationMs, durationKind: measured !== null ? "provider" : durationMs !== null ? "observed" : "unknown" };
        if (!old || completed || old.endedAt === null)
            calls.set(key, c);
    }
    return [...calls.values()];
}
