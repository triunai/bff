// Commit right-click menu MODEL + paste-ready text formatters (bead td-osi.14). Pure: no DOM, no clipboard, no git, no shell.
// Every enabled item is a clipboard, read or git-action request described as DATA; the UI (or runAction below) performs it.
// The git-mutating items (td-osi.14.1, owner OK 2026-10-07) only OPEN a confirm dialog: nothing here runs git. Interactive Rebase
// stays listed but disabled with REBASE_REASON. Threat model: docs/reviews/2026-10-06-usability-blast/fg/fg-gitwrite-threat-model.md.
import type { GitCommit, GitCommitDetail, GitResult } from "./git-types.ts";
import { relativeAge, shortSha } from "./git-ui.ts";

import { GIT_ACTIONS_ENABLED, REFUSALS, type WriteOp } from "./work/git-write-rules.ts";

export const REBASE_REASON = "Needs an editor and rewrites history: do it in a terminal (threat model: held on purpose)";
export const NO_GIT_ACTIONS_REASON = "Git actions are not available in this view";

/** A row or a detail: body is only known once the detail is loaded. refs are short names ("main", "origin/main"). */
export type CommitLike = Pick<GitCommit, "sha" | "parents" | "author" | "authoredAt" | "subject"> & { refs?: string[]; body?: string };
export type MenuContext = {
  /** Epoch ms used for the relative age, injected so output is deterministic. */
  now: number;
  /** Read-only patch text for the commit (the reader's `show --patch`). Absent = Copy as Patch is disabled. */
  loadPatch?: (sha: string) => Promise<GitResult<string>>;
  /** The host view can open the git-action dialog. `true` = the shipped set (GIT_ACTIONS_ENABLED); an array of item ids = exactly those (tests, or turning a held action on).
   * Absent = every git item is disabled. An item outside the set is disabled with the "held back" reason. */
  gitActions?: boolean | readonly string[];
};
/** What an enabled item does. No shape carries argv or a path: a git op is a NAME the server turns into a validated argv. That is what the tests pin. */
export type MenuAction = { kind: "copy"; text: string } | { kind: "copy-patch"; sha: string } | { kind: "compare-local"; sha: string } | { kind: "save-patch"; sha: string } | { kind: "git-write"; op: WriteOp; sha: string };
export type MenuItem = { type: "item"; id: string; label: string; shortcut?: string; enabled: boolean; reason?: string; action?: MenuAction; submenu?: MenuItem[] };
export type MenuSeparator = { type: "separator" };
export type MenuEntry = MenuItem | MenuSeparator;
/** Demo mode: every item that would run git or start a download is switched off with the demo reason. Copy items stay (they only copy text). */
export const demoDisable = (entries: MenuEntry[], reason: string): MenuEntry[] => entries.map(e => e.type !== "item" ? e : { ...e, ...(e.action && e.action.kind !== "copy" && e.action.kind !== "copy-patch" ? { enabled: false, reason } : {}), ...(e.submenu ? { submenu: demoDisable(e.submenu, reason) as MenuItem[] } : {}) });

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const HOME = /\/Users\/[^/\s]+\//g;
/** Strip ANSI escapes and replace absolute home paths with "~/". */
export const scrub = (s: string): string => s.replace(ANSI, "").replace(HOME, "~/");

const copy = (id: string, label: string, text: string, shortcut?: string): MenuItem => ({ type: "item", id, label, ...(shortcut ? { shortcut } : {}), enabled: true, action: { kind: "copy", text } });
const off = (id: string, label: string, reason: string, shortcut?: string): MenuItem => ({ type: "item", id, label, ...(shortcut ? { shortcut } : {}), enabled: false, reason });
const SEP: MenuSeparator = { type: "separator" };

/** Paste-ready text for a chat or Slack. Deterministic; the body and its trailers are kept as-is (then scrubbed). */
export function commitInfoText(c: CommitLike, now: number): string {
  const iso = Number.isFinite(c.authoredAt) ? new Date(c.authoredAt).toISOString() : "unknown date";
  const age = Number.isFinite(c.authoredAt) && Number.isFinite(now) ? relativeAge(c.authoredAt, now) : "—";
  // relativeAge reads "now", "5m" ... or, past ~5 weeks, a bare ISO date: only the short forms take " ago" ("2026-08-01 ago" is wrong).
  const ago = /^\d+[mhdw]$/.test(age) ? ` (${age} ago)` : age === "now" ? " (just now)" : "";
  const head = [
    c.subject,
    `sha ${c.sha} (${shortSha(c.sha)})`,
    `author ${c.author}, ${iso}${ago}`,
  ];
  if (c.parents.length > 1) head.push(`merge of ${c.parents.map(shortSha).join(" ")}`);
  if (c.refs && c.refs.length > 0) head.push(`refs ${c.refs.join(", ")}`);
  const body = (c.body ?? "").replace(/\s+$/, "");
  return scrub(body ? `${head.join("\n")}\n\n${body}` : head.join("\n"));
}

/** The ordered menu for one commit. Fork's branch submenus become "Copy Ref Name" (clipboard only). */
export function commitMenu(c: CommitLike, ctx: MenuContext): MenuEntry[] {
  const refs = c.refs ?? [];
  const refItem: MenuItem = refs.length > 0
    ? { type: "item", id: "copy-ref", label: "Copy Ref Name", enabled: true, submenu: refs.map((r, i) => copy(`copy-ref:${i}`, scrub(r), scrub(r))) }
    : off("copy-ref", "Copy Ref Name", "No branch or tag points at this commit");
  const patch: MenuItem = ctx.loadPatch
    ? { type: "item", id: "copy-patch", label: "Copy as Patch", enabled: true, action: { kind: "copy-patch", sha: c.sha } }
    : off("copy-patch", "Copy as Patch", "No patch reader is available");
  const git = (id: string, label: string, action: MenuAction, shortcut?: string): MenuItem =>
    !ctx.gitActions ? off(id, label, NO_GIT_ACTIONS_REASON, shortcut)
      : (ctx.gitActions === true ? GIT_ACTIONS_ENABLED : ctx.gitActions).includes(id) ? { type: "item", id, label, ...(shortcut ? { shortcut } : {}), enabled: true, action }
      : off(id, label, REFUSALS.held, shortcut);
  return [
    copy("copy-sha", "Copy Commit SHA", c.sha, "⌘C"),
    copy("copy-short-sha", "Copy Short SHA", shortSha(c.sha)),
    copy("copy-info", "Copy Commit Info", commitInfoText(c, ctx.now)),
    copy("copy-subject", "Copy Subject", scrub(c.subject)),
    refItem,
    patch,
    SEP,
    git("compare-local", "Compare to Local Changes", { kind: "compare-local", sha: c.sha }),
    SEP,
    git("new-branch", "New Branch…", { kind: "git-write", op: "new-branch", sha: c.sha }),
    git("new-tag", "New Tag…", { kind: "git-write", op: "new-tag", sha: c.sha }),
    SEP,
    off("interactive-rebase", "Interactive Rebase", REBASE_REASON),
    git("checkout", "Checkout Commit…", { kind: "git-write", op: "checkout", sha: c.sha }),
    git("cherry-pick", "Cherry-pick Commit…", { kind: "git-write", op: "cherry-pick", sha: c.sha }),
    git("revert", "Revert Commit…", { kind: "git-write", op: "revert", sha: c.sha }),
    git("save-patch", "Save as Patch…", { kind: "save-patch", sha: c.sha }),
  ];
}

/** Flat list of every item including submenu children, separators dropped. */
export const flattenMenu = (m: MenuEntry[]): MenuItem[] => m.flatMap(e => (e.type === "separator" ? [] : [e, ...(e.submenu ?? [])]));

/** Performs a clipboard item's action through injected IO. The only effects are writeText and the injected patch read. The git kinds
 * (compare-local, save-patch, git-write) are NOT performed here: the host opens the dialog that owns the confirm step. */
export async function runAction(a: MenuAction, io: { writeText(t: string): Promise<void>; loadPatch?(sha: string): Promise<GitResult<string>> }): Promise<GitResult<null>> {
  if (a.kind === "copy") { await io.writeText(a.text); return { ok: true, value: null }; }
  if (a.kind !== "copy-patch") return { ok: false, reason: "this action opens a dialog; it is not a clipboard action" };
  if (!io.loadPatch) return { ok: false, reason: "No patch reader is available" };
  const r = await io.loadPatch(a.sha);
  if (!r.ok) return r;
  await io.writeText(scrub(r.value));
  return { ok: true, value: null };
}

/** Accepts a loaded GitCommitDetail where a CommitLike is expected (refs come from the row). */
export const fromDetail = (d: GitCommitDetail, refs: string[] = []): CommitLike => ({ sha: d.sha, parents: d.parents, author: d.author, authoredAt: d.authoredAt, subject: d.subject, body: d.body, refs });

/** What a key does inside the open menu. Pure so the keyboard contract is pinned without a DOM. */
export type MenuKeyResult = { kind: "focus"; index: number } | { kind: "close" } | { kind: "activate" } | { kind: "open" } | { kind: "back" } | null;
export function menuKeyStep(count: number, index: number, key: string): MenuKeyResult {
  if (count <= 0) return key === "Escape" ? { kind: "close" } : null;
  const at = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowDown": return { kind: "focus", index: (at + 1) % count };
    case "ArrowUp": return { kind: "focus", index: (at - 1 + count) % count };
    case "Home": return { kind: "focus", index: 0 };
    case "End": return { kind: "focus", index: count - 1 };
    case "Escape": return { kind: "close" };
    case "Enter": case " ": return { kind: "activate" };
    case "ArrowRight": return { kind: "open" };
    case "ArrowLeft": return { kind: "back" };
    default: return null;
  }
}

/** The rows the menu navigates: every item (disabled ones too, so a keyboard user can read WHY they are off), submenu children
 * only while their parent is expanded. */
export function visibleItems(m: MenuEntry[], expanded: string | null): MenuItem[] {
  return m.flatMap(e => (e.type === "separator" ? [] : e.submenu && expanded === e.id ? [e, ...e.submenu] : [e]));
}
