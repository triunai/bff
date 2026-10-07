// The ONLY module that knows `bd`. Single-writer rule: Osiris only READS beads; it never repairs or writes
// (beady-eye's rule). Only read subcommands are ever spawned (`--version`, `list --all --json`).
// Never throws raw: every failure comes back as a typed AdapterError. Schema drift fails LOUDLY with the field name.
import {BD_CHILD, BD_TRUST, resolveBd} from "./bd-readonly.ts";
import {trustedRun, type TrustPolicy} from "./trusted-bin.ts";
import type {WorkDep, WorkIssue, WorkStatus} from "./types.ts";
import {DESCRIPTION_CAP, WORK_STATUSES} from "./types.ts";

export const SUPPORTED_BD = {major: 1, minor: 3} as const; // 1.3.x
export type AdapterError =
  | {kind: "spawn"; message: string}
  | {kind: "timeout"; message: string}
  | {kind: "exit"; code: number; message: string}
  | {kind: "version-unparseable"; message: string}
  | {kind: "version-unsupported"; found: string; supported: string; message: string}
  | {kind: "bad-json"; message: string}
  | {kind: "schema"; field: string; issueId: string | null; message: string};
export type Result<T> = {ok: true; value: T} | {ok: false; error: AdapterError};
export interface RunResult {code: number; stdout: string; stderr: string}
export type Runner = (args: string[], timeoutMs: number) => Promise<RunResult>;
export interface WorkSnapshot {issues: WorkIssue[]; deps: WorkDep[]; bdVersion: string}

const fail = (error: AdapterError): Result<never> => ({ok: false, error});

// Argument array, no shell, bounded time. `bd` is an absolute program from the fixed trusted directories (never PATH), run with the minimal bd env (trusted-bin.ts, D-139).
export const makeRunner = (resolve: () => string | null = resolveBd, trust: TrustPolicy = BD_TRUST): Runner => async (args, timeoutMs) => {
  const bin = resolve();
  if (!bin) throw new Error("bd is not installed in a trusted location");
  try { return await trustedRun(bin, args, {...BD_CHILD, timeoutMs, maxBuffer: 64 * 1024 * 1024, trust, label: "bd"}); }
  catch (e) { throw (e as {timeout?: boolean}).timeout ? Object.assign(new Error(`bd ${args.join(" ")} timed out after ${timeoutMs}ms`), {timeout: true}) : e; }
};
export const defaultRunner: Runner = makeRunner();

async function run(runner: Runner, args: string[], timeoutMs: number): Promise<Result<string>> {
  try {
    const r = await runner(args, timeoutMs);
    if (r.code !== 0) return fail({kind: "exit", code: r.code, message: `bd ${args.join(" ")} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`});
    return {ok: true, value: r.stdout};
  } catch (e) {
    const err = e as Error & {timeout?: boolean};
    return fail(err.timeout ? {kind: "timeout", message: err.message} : {kind: "spawn", message: `could not run bd: ${err.message}`});
  }
}

export function parseBdVersion(text: string): {major: number; minor: number; patch: number} | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? {major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3])} : null;
}

export function checkBdVersion(text: string): Result<string> {
  const v = parseBdVersion(text);
  if (!v) return fail({kind: "version-unparseable", message: `cannot read a version from bd --version output: ${text.trim().slice(0, 120)}`});
  const found = `${v.major}.${v.minor}.${v.patch}`;
  const supported = `${SUPPORTED_BD.major}.${SUPPORTED_BD.minor}.x`;
  if (v.major !== SUPPORTED_BD.major || v.minor !== SUPPORTED_BD.minor)
    return fail({kind: "version-unsupported", found, supported, message: `bd ${found} is outside the supported range ${supported}`});
  return {ok: true, value: found};
}

const schemaErr = (field: string, issueId: string | null): Result<never> =>
  fail({kind: "schema", field, issueId, message: `bd JSON is missing or mistyped required field "${field}"${issueId ? ` on issue ${issueId}` : ""}`});

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// Required: id, title, status, priority, issue_type, created_at, updated_at. Optional: labels (absent when none),
// dependencies (absent when none), parent, assignee, external_ref, started_at, heartbeat_at.
export function normalizeIssues(raw: unknown): Result<{issues: WorkIssue[]; deps: WorkDep[]}> {
  if (!Array.isArray(raw)) return schemaErr("<root array>", null);
  const issues: WorkIssue[] = [];
  const deps: WorkDep[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") return schemaErr("<issue object>", null);
    if (!isStr(r.id)) return schemaErr("id", null);
    const id = r.id;
    if (!isStr(r.title)) return schemaErr("title", id);
    if (typeof r.status !== "string" || !(WORK_STATUSES as readonly string[]).includes(r.status)) return schemaErr("status", id);
    if (typeof r.priority !== "number") return schemaErr("priority", id);
    if (!isStr(r.issue_type)) return schemaErr("issue_type", id);
    if (!isStr(r.created_at)) return schemaErr("created_at", id);
    if (!isStr(r.updated_at)) return schemaErr("updated_at", id);
    if (r.labels !== undefined && r.labels !== null && !(Array.isArray(r.labels) && r.labels.every((l) => typeof l === "string"))) return schemaErr("labels", id);
    if (r.dependencies !== undefined && r.dependencies !== null && !Array.isArray(r.dependencies)) return schemaErr("dependencies", id);
    let parent = optStr(r.parent);
    for (const d of (r.dependencies as Record<string, unknown>[] | null | undefined) ?? []) {
      if (!d || !isStr(d.issue_id)) return schemaErr("dependencies[].issue_id", id);
      if (!isStr(d.depends_on_id)) return schemaErr("dependencies[].depends_on_id", id);
      if (!isStr(d.type)) return schemaErr("dependencies[].type", id);
      deps.push({issueId: d.issue_id, dependsOnId: d.depends_on_id, type: d.type});
      if (d.type === "parent-child" && d.issue_id === id && !parent) parent = d.depends_on_id;
    }
    issues.push({
      id, title: r.title, type: r.issue_type, status: r.status as WorkStatus, priority: r.priority, parent,
      labels: (r.labels as string[] | null | undefined) ?? [], assignee: optStr(r.assignee), externalRef: optStr(r.external_ref),
      createdAt: r.created_at, updatedAt: r.updated_at, startedAt: optStr(r.started_at), heartbeatAt: optStr(r.heartbeat_at),
      ...(optStr(r.description) ? { description: optStr(r.description)!.slice(0, DESCRIPTION_CAP) } : {}),
    });
  }
  return {ok: true, value: {issues, deps}};
}

export async function fetchWorkSnapshot(opts: {runner?: Runner; timeoutMs?: number} = {}): Promise<Result<WorkSnapshot>> {
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ver = await run(runner, ["--version"], timeoutMs);
  if (!ver.ok) return ver;
  const checked = checkBdVersion(ver.value);
  if (!checked.ok) return checked;
  const out = await run(runner, ["list", "--all", "--json", "--limit", "0"], timeoutMs);
  if (!out.ok) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(out.value); } catch (e) { return fail({kind: "bad-json", message: `bd list --json was not valid JSON: ${(e as Error).message}`}); }
  const norm = normalizeIssues(parsed);
  if (!norm.ok) return norm;
  return {ok: true, value: {...norm.value, bdVersion: checked.value}};
}
