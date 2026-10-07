// The live data and the one side effect of the worktrees view, shared by `osiris worktrees` and the Factory's embedded Worktrees panel (so the two can
// never load or open things differently).
import { readWorkSnapshot } from "../work/bdi-feed.ts";
import { openInEditor } from "./open-editor.ts";
import { collectAll, readDiff, realGit, type PaneAt } from "./worktrees-git.ts";
import { groupRows, type WtDiffKey, type WtEnv, type WtView } from "./worktrees-model.ts";

type Feed = { panes: PaneAt[]; titles: Map<string, string> };
/** Panes the work feed joined (bdi), as cwd + pane id. Best effort: no bdi means no agent column, never an error. */
async function feedOf(repo: string): Promise<Feed> {
  const r = await readWorkSnapshot(repo).catch(() => null);
  if (!r?.ok) return { panes: [], titles: new Map() };
  return {
    panes: [...r.value.tree.flatMap(t => t.nodes.flatMap(n => (n.agent?.cwd ? [{ cwd: n.agent.cwd, label: n.agent.paneId }] : []))), ...r.value.unattributed.flatMap(p => (p.cwd ? [{ cwd: p.cwd, label: p.paneId }] : []))],
    titles: new Map(r.value.issues.map(i => [i.id, i.title])),
  };
}

/** The reducers' one side effect: open a worktree (or a file in it) in the editor (open-editor.ts: trusted binary, argv only, confined path). */
export const editorEnv: WtEnv = { open: (wt, file) => openInEditor(wt, file) };
/** The live view: every worktree, plus the diff of `want` (the file or commit the owner opened) when there is one. Shared with the Factory's embedded panel. */
/** `post` lets the standalone app add the prune plans (it gets the same pane list the agent column used). */
export async function loadWtView(repo: string, all: boolean, want: WtDiffKey | null = null, post?: (v: WtView, panes: PaneAt[]) => Promise<WtView>): Promise<WtView> {
  const now = Date.now(), f = await feedOf(repo), rows = (await collectAll(repo, all, realGit, f.panes)).map(r => ({ ...r, beadTitle: r.bead ? f.titles.get(r.bead) ?? null : null }));
  const row = want ? rows.find(r => r.path === want.path) : undefined;
  const v: WtView = { groups: groupRows(rows), now, all, fileDiff: want && row ? await readDiff(realGit, row, want) : undefined };
  return post ? post(v, f.panes) : v;
}

