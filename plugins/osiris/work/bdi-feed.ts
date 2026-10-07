// Work-surface feed (server-only, READ-ONLY): bdi --json (pane join, anomalies, tree) + bd --readonly list (timestamps, deps) + wrap commits.
// Every child runs under the curated env from bd-readonly.ts: `bd` is the refusing shim, `gh` is unreachable, GIT_* is stripped.
import { unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fetchWorkSnapshot, type Runner } from "./beads-adapter.ts";
import type { PaneRef, PaneTail, TreeNode, TreeRoot, UnattributedPane, WorkSurfaceSnapshot } from "./surface-types.ts";
import { runGit, validateRepo } from "../git-feed.ts";
import { WRAP } from "../health-feed.ts";
import { ensureReadonlyEnv, resolveBdi, type RoEnv } from "./bd-readonly.ts";
import { trustedRun, trustedSpawn, type SpawnOutcome, type TrustPolicy } from "./trusted-bin.ts";
import { CELLAR_HERDR } from "../herdr-feed.ts";
import { cleanText, INPUT_CAP, redactSecrets, stripTerminalEscapes } from "./sanitize.ts";

export type FeedResult<T> = { ok: true; value: T } | { ok: false; reason: string };
const BDI_MS = 20_000, BDI_BYTES = 32 * 1024 * 1024, CACHE_MS = 3000, WRAP_CAP = 500, PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/, PANE_BYTES = 256 * 1024;

let roP: Promise<RoEnv> | null = null;
const ro = (): Promise<RoEnv> => (roP ??= ensureReadonlyEnv().catch(e => { roP = null; throw e; }));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function pane(a: unknown): PaneRef | null {
  if (!a || typeof a !== "object") return null;
  const r = rec(a), p = rec(r.pane), id = str(p.id); if (!id) return null;
  return { paneId: id, session: str(p.session), state: str(r.pane_status), title: str(r.title) === null ? null : cleanText(str(r.title)!, 200), cwd: str(r.cwd) };
}
const conflictText = (c: unknown): string => {
  if (typeof c === "string") return cleanText(c, 400);
  const { conflict, ...rest } = rec(c), tail = Object.keys(rest).length ? ` ${JSON.stringify(rest).slice(0, 300)}` : "";
  return cleanText(`${str(conflict) ?? "conflict"}${tail}`, 400);
};

/** Pure: map bdi's --json document to the contract pieces. Exported for tests. */
export function mapBdi(doc: unknown): { tree: TreeRoot[]; unattributed: UnattributedPane[]; conflicts: string[]; notes: string[] } {
  const d = rec(doc), notes: string[] = [];
  const tree: TreeRoot[] = arr(d.trees).map(t => {
    const tr = rec(t), c = rec(tr.counts);
    const nodes: TreeNode[] = arr(tr.nodes).map(n => {
      const nn = rec(n), e = nn.edge;
      return { id: String(nn.id ?? ""), depth: Number(nn.depth) || 0, edge: e === "parent-child" || e === "blocks" ? e : null, ready: nn.ready === true, blockedBy: arr(nn.blocked_by).map(String), agent: pane(nn.agent), anomalies: arr(nn.anomalies).map(a => String(rec(a).rule ?? "unknown")) };
    });
    if (tr.tracker !== "ok") notes.push(`tree ${String(tr.root)}: tracker not read (${JSON.stringify(tr.tracker).slice(0, 120)})`);
    return { root: String(tr.root ?? ""), title: cleanText(String(tr.title ?? ""), 200), total: Number(c.total) || 0, finished: Number(c.finished) || 0, liveAgents: Number(c.live_agents) || 0, anomalyCount: Number(c.anomalies) || 0, nodes };
  });
  const unattributed: UnattributedPane[] = arr(d.unattributed).flatMap(u => { const r = rec(u), p = pane(u); return p ? [{ paneId: p.paneId, cwd: str(r.cwd), state: p.state, agent: str(r.display_agent) }] : []; });
  const ag = rec(d.agents);
  if (ag.state !== "answering") notes.push(`Herdr is ${String(ag.state ?? "unknown")}: no live pane join`);
  if (arr(d.failed_projects).length) notes.push("bdi could not read this project's tracker");
  return { tree, unattributed, conflicts: arr(d.conflicts).map(conflictText), notes };
}

type Exec = { ok: true; out: string } | { ok: false; reason: string; out: string; over: boolean };
/** One bdi/herdr child through the primitive. `trust` says where the program may live: the generated shim dir (herdr link) or, undefined, the fixed system dirs (bdi). */
async function exec(file: string, args: string[], env: RoEnv, trust: TrustPolicy | undefined, cwd: string | undefined, timeout: number, maxBuffer: number): Promise<Exec> {
  const r: SpawnOutcome = await trustedSpawn(file, args, { ...env.opts, cwd, timeoutMs: timeout, maxBuffer, trust });
  switch (r.kind) {
    case "exit": return r.code === 0 ? { ok: true, out: r.stdout } : { ok: false, over: false, out: r.stdout, reason: `exited ${r.code}: ${r.stderr.trim().slice(0, 160)}` };
    case "overflow": return { ok: false, over: true, out: r.stdout, reason: "output exceeded the size bound" };
    case "timeout": return { ok: false, over: false, out: r.stdout, reason: "timed out" };
    case "refused": return { ok: false, over: false, out: "", reason: r.reason === "not-found" ? "not installed" : `refused (${r.reason})` };
    default: return { ok: false, over: false, out: r.stdout, reason: r.code === "ENOENT" ? "not installed" : `exited ${String(r.code)}: ${r.stderr.trim().slice(0, 160)}` };
  }
}

async function wraps(repo: string): Promise<number[]> {
  const r = await runGit(repo, ["log", "--format=%ct%x09%s", "-n", String(WRAP_CAP), "HEAD"]);
  if (!r.ok) return [];
  return r.value.split("\n").flatMap(l => { const i = l.indexOf("\t"); if (i < 0) return []; const t = Number(l.slice(0, i)); return Number.isFinite(t) && WRAP.test(l.slice(i + 1)) ? [t * 1000] : []; });
}

async function build(repo: string, opts: { bdiPath?: string; timeoutMs?: number; now?: number }): Promise<FeedResult<WorkSurfaceSnapshot>> {
  const v = await validateRepo(repo); if (!v.ok) return v;
  const real = v.value;
  let env: RoEnv; try { env = await ro(); } catch (e) { return { ok: false, reason: `bd is not available: ${(e as Error).message}` }; }
  const ms = opts.timeoutMs ?? BDI_MS;
  const runner: Runner = (args, t) => trustedRun(join(env.binDir, "bd"), args, { ...env.opts, cwd: real, timeoutMs: t, maxBuffer: 64 * 1024 * 1024, trust: { dirs: [env.binDir] }, label: "bd" });
  const beads = await fetchWorkSnapshot({ runner, timeoutMs: ms }); if (!beads.ok) return { ok: false, reason: `bd failed: ${beads.error.message}` };
  const notes: string[] = [], bdi = opts.bdiPath ?? resolveBdi();
  let source: "bdi" | "bd" = "bd", bdiVersion: string | null = null, mapped = { tree: [] as TreeRoot[], unattributed: [] as UnattributedPane[], conflicts: [] as string[], notes: [] as string[] };
  const bdiTrust: TrustPolicy | undefined = opts.bdiPath ? { dirs: [dirname(opts.bdiPath)] } : undefined; // bdiPath is a test seam: it names its own directory, every other check still applies
  if (!bdi) notes.push("bdi is not installed: no pane join, anomalies or tree");
  else {
    const vr = await exec(bdi, ["--version"], env, bdiTrust, real, 5000, 64 * 1024);
    bdiVersion = vr.ok ? (/\d+\.\d+\.\d+/.exec(vr.out)?.[0] ?? null) : null;
    const toml = join(dirname(env.binDir), `work-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.toml`);
    try {
      await writeFile(toml, `[[projects]]\nname = ${JSON.stringify(basename(real).replace(/[^A-Za-z0-9._-]/g, "-") || "repo")}\npath = ${JSON.stringify(real)}\n`, { mode: 0o600 });
      const r = await exec(bdi, ["--config", toml, "--json", "--all"], env, bdiTrust, real, ms, BDI_BYTES);
      if (!r.ok) notes.push(r.reason === "not installed" ? "bdi is not installed: no pane join, anomalies or tree" : `bdi failed (${r.reason}): no pane join, anomalies or tree`);
      else { try { mapped = mapBdi(JSON.parse(r.out)); source = "bdi"; notes.push(...mapped.notes); } catch { notes.push("bdi output was not valid JSON: no pane join, anomalies or tree"); } }
    } finally { await unlink(toml).catch(() => {}); }
  }
  return { ok: true, value: { source, generatedAt: opts.now ?? Date.now(), repo: real, bdVersion: beads.value.bdVersion, bdiVersion, issues: beads.value.issues.map(i => ({ ...i, title: cleanText(i.title, 200) })), deps: beads.value.deps, tree: mapped.tree, unattributed: mapped.unattributed, conflicts: mapped.conflicts, wraps: await wraps(real), notes } };
}

// W-2A M5: the pane ids that appeared as a JOINED agent pane in the latest snapshot of each allowed repo. workPaneTail reads only these.
const SEEN = new Map<string, Set<string>>();
export function notePanes(s: WorkSurfaceSnapshot): void {
  SEEN.set(s.repo, new Set(s.tree.flatMap(t => t.nodes.flatMap(n => (n.agent ? [n.agent.paneId] : [])))));
  if (SEEN.size > 64) SEEN.delete(SEEN.keys().next().value!);
}
export const paneSeen = (id: string): boolean => { for (const set of SEEN.values()) if (set.has(id)) return true; return false; };
export const clearSeenPanes = (): void => SEEN.clear();
const cache = new Map<string, { at: number; p: Promise<FeedResult<WorkSurfaceSnapshot>> }>();
/** Singleflight + 3 s cache per repo (and bdi override). */
export function readWorkSnapshot(repo: string, opts: { bdiPath?: string; timeoutMs?: number; now?: number } = {}): Promise<FeedResult<WorkSurfaceSnapshot>> {
  const key = `${repo}\0${opts.bdiPath ?? ""}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = build(repo, opts).catch((e): FeedResult<WorkSurfaceSnapshot> => ({ ok: false, reason: `work feed failed: ${(e as Error).message}` })).then(r => { if (r.ok) notePanes(r.value); return r; });
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 32) for (const k of cache.keys()) { if (k !== key) { cache.delete(k); break; } }
  return p;
}
export const clearWorkCache = (): void => cache.clear();

export const isPaneId = (s: unknown): s is string => typeof s === "string" && PANE_ID.test(s);
/** Bounded tail of one Herdr pane (`herdr pane read`, text, ANSI stripped). Never reads unless the id is well-formed. */
export async function readPaneTail(paneId: string, lines = 40): Promise<FeedResult<PaneTail>> {
  if (!isPaneId(paneId)) return { ok: false, reason: "invalid pane id" };
  const n = Math.min(200, Math.max(1, Number.isFinite(lines) ? Math.trunc(lines) : 40));
  let env: RoEnv; try { env = await ro(); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  const r = await exec(join(env.binDir, "herdr"), ["pane", "read", paneId, "--source", "recent", "--lines", String(n), "--format", "text"], env, { dirs: [env.binDir], aliasTargets: CELLAR_HERDR }, undefined, 5000, PANE_BYTES);
  if (!r.ok && !r.over) return { ok: false, reason: r.reason === "not installed" ? "herdr is not installed" : `herdr pane read failed (${r.reason})` };
  return { ok: true, value: shapeTail(paneId, r.out, n, !r.ok) };
}
/** Pure: pane text -> bounded lines. Terminal escapes stripped THEN secrets redacted (a pane is attacker-influenced output). */
export function shapeTail(paneId: string, out: string, n: number, over = false, at = Date.now()): PaneTail {
  const all = redactSecrets(stripTerminalEscapes(out.slice(-INPUT_CAP))).split("\n"); // the TAIL is what a tail view wants; capped before any regex (H1)
  while (all.length && all[all.length - 1].trim() === "") all.pop();
  return { paneId, lines: all.slice(-n), truncated: over || all.length > n, at };
}
