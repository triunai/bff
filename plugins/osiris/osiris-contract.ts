import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Call, report } from "./analytics.ts";

export const filtersSchema = z.object({
  threadId: z.string().max(256).optional(),
  workflowId: z.string().max(256).optional(),
  provider: z.string().max(256).optional(),
  source: z.enum(["bb"]).optional(),
  since: z.number().nonnegative().optional(),
});
export const agentSchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["thread", "delegation", "workflow-agent"]),
  threadId: z.string(), parentId: z.string().nullable(), workflowId: z.string().nullable(),
  workflowName: z.string().nullable(), provider: z.string(), model: z.string().nullable(),
  task: z.string().nullable(), workstream: z.string().nullable(),
  status: z.enum(["running", "queued", "completed", "failed", "cancelled", "unknown"]),
  startedAt: z.number().nullable(), endedAt: z.number().nullable(), lastActivityAt: z.number().nullable(),
  callCount: z.number(), errors: z.number(), childThreadId: z.string().nullable(),
});
export type FleetAgent = z.infer<typeof agentSchema>;
export const targetSchema = z.object({callKey:z.string(), threadId:z.string(), eventSeq:z.number().nullable(), agentId:z.string(), workflowId:z.string().nullable()});
export type CallTarget = z.infer<typeof targetSchema>;
export const healthSchema = z.object({
  state:z.enum(["current", "partial", "error"]), checkedAt:z.number(),
  lastEventAt:z.number().nullable(), messages:z.array(z.string()),
});
export const coverageSchema = z.object({
  scannedAt:z.number(), threadLimit:z.number(), eventLimitPerThread:z.number(),
  threadsScanned:z.number(), eventsScanned:z.number(), threadLimitReached:z.boolean(),
  truncatedThreads:z.array(z.string()), failedThreads:z.array(z.string()),
  scanErrors:z.array(z.object({threadId:z.string(),code:z.string()})), retainedHistoryOnly:z.literal(true),
}).passthrough();
const callSchema = z.object({
  source:z.string(),provider:z.string(),sessionId:z.string(),callId:z.string(),turnId:z.string().nullable(),
  parentCallId:z.string().nullable(),model:z.string().nullable(),tool:z.string(),server:z.string().nullable(),
  status:z.enum(["success","error","denied","cancelled","unknown","running"]),
  startedAt:z.number().nullable(),endedAt:z.number().nullable(),durationMs:z.number().nullable(),
  durationKind:z.enum(["provider","observed","unknown"]),errorCode:z.string().nullable(),
});
export const snapshotSchema = z.object({
  version:z.literal(1),calls:z.array(callSchema),totals:z.any(),tools:z.array(z.any()),
  coverage:coverageSchema,threads:z.array(z.object({id:z.string(),provider:z.string()})),
  fleet:z.array(agentSchema),targets:z.array(targetSchema),health:healthSchema,
});
export type OpsSnapshot = ReturnType<typeof report> & Omit<z.infer<typeof snapshotSchema>,"calls"|"totals"|"tools">;
export const detailsSchema = z.object({
  threadId:z.string(),callId:z.string(),available:z.boolean(),
  input:z.string().nullable(),error:z.string().nullable(),stack:z.string().nullable(),
  files:z.array(z.object({path:z.string(),line:z.number().nullable()})),
  raw:z.string().nullable(),truncated:z.boolean(),note:z.string().nullable(),
});
export type CallDetails = z.infer<typeof detailsSchema>;
export const rpcContract = defineRpcContract({
  snapshot:{input:filtersSchema,output:snapshotSchema},
  details:{input:z.object({threadId:z.string().max(256),callId:z.string().max(512),raw:z.boolean().optional()}),output:detailsSchema},
});
export type DisplayCall = Call;
