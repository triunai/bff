import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { report, reduceEvents } from "./analytics.ts";
import type { Call } from "./analytics.ts";
import { readHerdrFeed } from "./herdr-feed.ts";
const input = z.object({ threadId: z.string().max(256).optional(), provider: z.string().max(256).optional(), source: z.enum(["bb"]).optional(), since: z.number().nonnegative().optional() });
const callSchema = z.object({ source: z.string(), provider: z.string(), sessionId: z.string(), callId: z.string(), turnId: z.string().nullable(), parentCallId: z.string().nullable(), model: z.string().nullable(), tool: z.string(), server: z.string().nullable(), status: z.enum(["success", "error", "denied", "cancelled", "unknown", "running"]), startedAt: z.number().nullable(), endedAt: z.number().nullable(), durationMs: z.number().nullable(), durationKind: z.enum(["provider", "observed", "unknown"]), errorCode: z.string().nullable() });
export const rpcContract = defineRpcContract({
    herdrSnapshot: { input: z.object({}), output: z.object({ available: z.boolean(), note: z.string(), capturedAt: z.number().nullable(), stale: z.boolean(), coverage: z.object({ filesScanned: z.number(), discoveryTruncated: z.boolean() }).nullable(), report: z.object({ version: z.literal(1), calls: z.array(callSchema), totals: z.any(), tools: z.array(z.any()) }).nullable() }) },
    snapshot: { input, output: z.object({ version: z.literal(1), calls: z.array(callSchema), totals: z.any(), tools: z.array(z.any()), coverage: z.object({ scannedAt: z.number(), threadLimit: z.number(), eventLimitPerThread: z.number(), threadsScanned: z.number(), eventsScanned: z.number(), threadLimitReached: z.boolean(), truncatedThreads: z.array(z.string()), failedThreads: z.array(z.string()), scanErrors:z.array(z.object({threadId:z.string(),code:z.string()})), retainedHistoryOnly: z.literal(true) }), threads: z.array(z.object({ id: z.string(), provider: z.string() })) }) }
});
export type Snapshot = ReturnType<typeof report> & {
    coverage: {
        scannedAt: number;
        threadLimit: number;
        eventLimitPerThread: number;
        threadsScanned: number;
        eventsScanned: number;
        threadLimitReached: boolean;
        truncatedThreads: string[];
        failedThreads: string[];
        scanErrors:{threadId:string;code:string}[];
        retainedHistoryOnly: true;
    };
    threads: {
        id: string;
        provider: string;
    }[];
};
const THREAD_LIMIT = 40, EVENT_LIMIT = 1000, PAGE_SIZE = 100;
export default async function plugin(bb: BbPluginApi) {
    const cache = new Map<string, {
        at: number;
        value: Promise<Snapshot>;
        pending: boolean;
    }>();
    async function collect(filters: z.infer<typeof input>): Promise<Snapshot> {
        let threadLimitReached = false;
        let threads;
        if (filters.threadId)
            threads = [await bb.sdk.threads.get({ threadId: filters.threadId })];
        else {
            const [open, archived] = await Promise.all([bb.sdk.threads.list({ limit: THREAD_LIMIT + 1, includeHidden: true, archived: false }), bb.sdk.threads.list({ limit: THREAD_LIMIT + 1, includeHidden: true, archived: true })]);
            const unique = [...new Map([...open, ...archived].map(t => [t.id, t])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
            threadLimitReached = unique.length > THREAD_LIMIT;
            threads = unique.slice(0, THREAD_LIMIT);
        }
        const choices = threads.map(t => ({ id: t.id, provider: t.providerId }));
        if (filters.provider)
            threads = threads.filter(t => t.providerId === filters.provider);
        const calls: Call[] = [], truncatedThreads: string[] = [], failedThreads: string[] = [],scanErrors:{threadId:string;code:string}[]=[];
        let eventsScanned = 0;
        for (let i = 0; i < threads.length; i += 4)
            await Promise.all(threads.slice(i, i + 4).map(async (thread) => {
                try {
                    const rows: Parameters<typeof reduceEvents>[0] = [];
                    let beforeSeq: string | undefined;
                    while (rows.length < EVENT_LIMIT) {
                        const page = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: String(PAGE_SIZE), beforeSeq, types: ["item/started", "item/completed", "turn/started", "turn/completed"] });
                        rows.push(...page);
                        if (page.length < PAGE_SIZE)
                            break;
                        beforeSeq = String(Math.min(...page.map(e => e.seq)));
                    }
                    if (rows.length >= EVENT_LIMIT) {
                        const extra = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", beforeSeq, types: ["item/started", "item/completed", "turn/started", "turn/completed"] });
                        if (extra.length)
                            truncatedThreads.push(thread.id);
                    }
                    eventsScanned += rows.length;
                    calls.push(...reduceEvents(rows, thread));
                }
                catch(error) {
                    const candidate=error!==null&&typeof error==="object"&&"code" in error?String(error.code):error instanceof Error?error.name:"SCAN_ERROR";
                    const code=/^[A-Za-z0-9_.:-]{1,64}$/.test(candidate)?candidate:"SCAN_ERROR";
                    failedThreads.push(thread.id);scanErrors.push({threadId:thread.id,code});
                    bb.log.warn(`thread event scan failed: ${code} (${thread.id})`);
                }
            }));
        const filtered = calls.filter(c => filters.since === undefined || (c.endedAt ?? c.startedAt ?? -1) >= filters.since);
        return { ...report(filtered), threads: choices, coverage: { scannedAt: Date.now(), threadLimit: THREAD_LIMIT, eventLimitPerThread: EVENT_LIMIT, threadsScanned: threads.length, eventsScanned, threadLimitReached, truncatedThreads, failedThreads, scanErrors, retainedHistoryOnly: true } };
    }
    function snapshot(filters: z.infer<typeof input>): Promise<Snapshot> { const normalized = { ...filters, ...(filters.since === undefined ? {} : { since: Math.floor(filters.since / 5000) * 5000 }) }; const key = JSON.stringify(normalized), old = cache.get(key); if (old && (old.pending || Date.now() - old.at < 5000))
        return old.value; const value = collect(normalized); if (cache.size >= 20)
        cache.delete(cache.keys().next().value!); const entry = { at: Date.now(), value, pending: true }; cache.set(key, entry); void value.then(() => { entry.pending = false; entry.at = Date.now(); }, () => cache.delete(key)); return value; }
    bb.rpc.register(rpcContract, { snapshot, herdrSnapshot: async () => readHerdrFeed() });
    const changed = () => { bb.realtime.publish("changed", { changed: true }); };
    bb.events.on("experimental_thread.events", changed);
    bb.events.on("thread.deleted", changed);
    bb.cli.register({ name: "tool-observer", summary: "Metadata-only tool frequency and failure analytics", commands: [{ name: "summary", summary: "Read bounded BB event history", usage: "bb tool-observer summary [--thread ID] [--provider ID] [--json]" }], async run(argv) {
            if (argv[0] !== "summary")
                return { exitCode: 1, stderr: "Usage: bb tool-observer summary [--thread ID] [--provider ID] [--json]" };
            const options: {
                threadId?: string;
                provider?: string;
            } = {};
            for (let i = 1; i < argv.length; i++) {
                if (argv[i] === "--json")
                    continue;
                if ((argv[i] === "--thread" || argv[i] === "--provider") && argv[i + 1])
                    options[argv[i] === "--thread" ? "threadId" : "provider"] = argv[++i];
                else
                    return { exitCode: 1, stderr: "Unknown or missing argument" };
            }
            return { exitCode: 0, stdout: JSON.stringify(await snapshot(options), null, 2) };
        } });
}
