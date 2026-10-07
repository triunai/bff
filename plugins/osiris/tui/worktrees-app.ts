// `osiris worktrees`: a live, READ-ONLY Arkham-style worktree list. Never modifies any worktree: see worktrees-git.ts.
import { mouseHint, parseArgs } from "./factory-app.ts";
import { editorEnv, loadWtView } from "./worktrees-load.ts";
import { planPrune, readGit } from "./prune-git.ts";
import { REMOVAL_IN_BFF } from "./prune-app.ts";
import { installedDir } from "./prune-app.ts";
import type { PrunePlan } from "./prune-model.ts";
import type { PaneAt } from "./worktrees-git.ts";
import { initialWtUi, layoutWorktrees, renderWorktrees, selectedRow, shq, worktreesKey, worktreesMouse, type WtDiffKey, type WtEnv, type WtUi, type WtView } from "./worktrees-model.ts";
import { termSafe } from "./sanitize.ts";
import { S, renderLine, runScreen, type Reduced } from "./term.ts";

export type WtArgs = ReturnType<typeof parseArgs> & { all: boolean };
export const parseWorktreeArgs = (argv: readonly string[]): WtArgs => ({ ...parseArgs(argv), all: argv.includes("--all") });

export async function runWorktrees(a: WtArgs, o: { load?: (want: WtDiffKey | null) => Promise<WtView>; env?: WtEnv } = {}): Promise<number> {
  let want: WtDiffKey | null = null;
  // Prune (opt-in, confirmed with `y`): a dry-run plan per repo feeds the "Prune candidates" group and the header; a confirmed prune only points at bff, it removes nothing.
  let applying: Promise<void> = Promise.resolve(), pruned: string | undefined, installed: string | null | undefined;
  const plansOf = async (v: WtView, panes: PaneAt[]): Promise<WtView> => {
    await applying;
    installed ??= a.once ? null : await installedDir();
    const ps = await Promise.all(v.groups.map(g => planPrune(g.repo, { now: v.now, minIdleDays: 3, installed: installed ?? null }, { git: readGit, panes })));
    const ok = ps.filter((p): p is PrunePlan => !("error" in p));
    return { ...v, prune: ok.length ? ok : undefined, pruned };
  };
  const startPrune = (_v: WtView | null) => { pruned = `nothing removed. ${REMOVAL_IN_BFF}`; };
  const load = (): Promise<WtView> => (o.load ?? ((w: WtDiffKey | null) => loadWtView(a.repo, a.all, w, plansOf)))(want), env = o.env ?? editorEnv;
  if (a.once) { const v = await load(); console.log(renderWorktrees(v, initialWtUi(), { cols: a.cols ?? (process.stdout.columns || 120), rows: process.stdout.rows || 30, color: a.color }).map(l => renderLine(l, a.color)).join("\n")); return 0; }
  let picked: string | null = null; const hint = mouseHint(a);
  const track = (r: Reduced<WtUi>): Reduced<WtUi> => { want = r.ui.diff; return r; };
  await runScreen<WtView, WtUi>({
    load, ui: initialWtUi(), color: a.color, intervalMs: a.intervalMs, typing: ui => ui.typing, mouse: a.mouse,
    view: (v, ui, cols, rows) => (v ? layoutWorktrees(v, ui, { cols, rows, color: a.color, hint }) : { lines: [[S(" reading worktrees…")]], hits: [] }),
    onKey: (ui, k, v, size) => { const r = worktreesKey(ui, k, v, size, env); if (r.ui.pruneGo) { startPrune(v); r.ui = { ...r.ui, pruneGo: false }; } if (k === "enter" && !ui.typing && !ui.diff && ui.focus === "list") { const row = selectedRow(v, ui); if (row && termSafe(row.path) === row.path) picked = `cd ${shq(row.path)}`; } return track(r); },
    onMouse: (ui, act, v, size) => { const r = worktreesMouse(ui, act, v, size, env); if (act.kind === "dblclick" && ui.focus === "list" && !r.ui.diff) { const row = selectedRow(v, r.ui); if (row && termSafe(row.path) === row.path) picked = `cd ${shq(row.path)}`; } return track(r); },
  });
  if (picked) console.log(picked);
  return 0;
}
