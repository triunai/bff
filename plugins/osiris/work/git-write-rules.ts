// PURE rules for the git-write runner (no node imports, no I/O). Threat model: docs/reviews/2026-10-06-usability-blast/fg/fg-gitwrite-threat-model.md
// (webshop repo, lane fg-gitwrite, bead td-osi.14.1). Everything a caller may put into argv is decided HERE and pinned by git-write-rules.test.ts.

export type WriteOp = "new-branch" | "new-tag" | "checkout" | "cherry-pick" | "revert";
/** Every Commits-menu git action Osiris can run. */
export const GIT_ACTIONS_ALL: readonly string[] = Object.freeze(["compare-local", "new-branch", "new-tag", "checkout", "cherry-pick", "revert", "save-patch"]);
/** The Commits-menu git actions that are SWITCHED ON: all of them, by owner decision D-136 (2026-10-07, "git actions UP"). Server and menu both read this list;
 * a verb is argv-allowed only when its op is in it. Pinned by git-write-rules.test.ts. */
// NOTE (m1, accepted residual): the server's plugin gate is not a human gate. Agents and the CLI can preview + run these actions without a human confirm.
// The owner accepted that gap when turning the working-tree actions on (D-136); it is documented in the threat model, not closed.
export const GIT_ACTIONS_ENABLED: readonly string[] = GIT_ACTIONS_ALL;
/** The write verb each write op runs. A write verb is argv-allowed only when its op is in the enabled list (read verbs are always allowed). */
export const OP_VERB: Readonly<Record<string, string>> = Object.freeze({ "new-branch": "branch", "new-tag": "tag", checkout: "switch", "cherry-pick": "cherry-pick", revert: "revert" });

export const WRITE_OPS: readonly WriteOp[] = Object.freeze(["new-branch", "new-tag", "checkout", "cherry-pick", "revert"]);

/** Read-class verbs the runner may issue, and write-class verbs. Nothing else is expressible (threat model A7). */
export const READ_VERBS: readonly string[] = Object.freeze(["rev-parse", "status", "symbolic-ref", "diff", "diff-tree", "ls-files", "format-patch", "check-ref-format"]);
export const WRITE_VERBS: readonly string[] = Object.freeze(["branch", "tag", "switch", "cherry-pick", "revert"]);
export const ALL_VERBS: readonly string[] = Object.freeze([...READ_VERBS, ...WRITE_VERBS]);

/** Flags that are never allowed anywhere after the verb: force, history/ref destruction, rename/copy, editors, outputs, exec, hook skipping. */
const FORBIDDEN_FLAG = /^(?:-f|--force(?:-.*)?|--hard|--soft|--mixed|-D|-d|--delete|-m|-M|-c|-C|--move|--copy|--discard-changes|--merge|--amend|--no-verify|--exec|--edit|--edit-description|-o|--output(?:[-=].*)?|--set-upstream-to|-u|--orphan|-B|--autosquash|--signoff|-S|--gpg-sign(?:=.*)?|--continue|--skip|--quit)$/;
export const isForbiddenFlag = (a: string): boolean => FORBIDDEN_FLAG.test(a);

/** The ONE config read the runner may issue: every effective entry with its scope and origin (includes and config.worktree are followed by git itself).
 * Exact-match only in argvAllowed. The output is judged by unsafeConfigKeys below: DEFAULT-DENY over the repository-owned scopes (codex R2: a deny
 * list kept missing keys: gpg.ssh.defaultKeyCommand, config.worktree, core.worktree...). VALUES are never shown or logged. */
export const CONFIG_PREFLIGHT: readonly string[] = Object.freeze(["config", "--list", "--show-origin", "--show-scope", "-z"]);
const samePreflight = (argv: readonly string[]): boolean => argv.length === CONFIG_PREFLIGHT.length && argv.every((a, i) => a === CONFIG_PREFLIGHT[i]);

/** Keys a repository-owned config may carry. Everything else (filter/merge/diff drivers, gpg programs, includes, editors, pagers, aliases, credential
 * helpers, core.worktree, lfs, http...) is refused. Three keys are allowed ONLY because the runner overrides them on every command line or env:
 * core.hookspath, core.fsmonitor, core.attributesfile (HARDEN_ARGS) and tag.gpgsign / tag.forcesignannotated (explicit lightweight tags). */
const SAFE_KEYS: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol|quotepath|untrackedcache|longpaths|sharedrepository|abbrev|commentchar|trustctime|checkstat|sparsecheckout|sparsecheckoutcone|excludesfile|hookspath|fsmonitor|attributesfile)$/i,
  /^extensions\.(objectformat|compatobjectformat|partialclone|worktreeconfig|refstorage|preciousobjects)$/i,
  /^remote\.pushdefault$/i, /^remote\..+\.(url|pushurl|fetch|push|tagopt|promisor|partialclonefilter|mirror|prune)$/i,
  /^branch\.(autosetupmerge|autosetuprebase|sort)$/i, /^branch\..+\.(remote|merge|rebase|description|pushremote|vscode-merge-base)$/i,
  /^user\.(name|email|signingkey|useconfigonly)$/i, /^commit\.(gpgsign|cleanup|status|verbose|template)$/i, /^tag\.(gpgsign|forcesignannotated|sort)$/i, /^gpg\.format$/i,
  /^(pull\.(rebase|ff)|push\.(default|followtags|autosetupremote)|fetch\.(prune|prunetags)|rebase\.(autostash|autosquash)|init\.defaultbranch|color\.ui|gc\.(auto|autodetach|pruneexpire)|status\.showuntrackedfiles|advice\.detachedhead)$/i, // individually vetted: no namespace wildcards (a gc.* wildcard admitted gc.recentObjectsHook, a shell command)
  /^diff\.(renames|algorithm|context|mnemonicprefix|noprefix|colormoved|external)$/i, /^merge\.(ff|conflictstyle|renormalize|stat|verbosity)$/i,
  /^url\..+\.(insteadof|pushinsteadof)$/i,
  /^submodule\.(active|recurse|fetchjobs)$/i, /^submodule\..+\.(url|path|active|branch|ignore|fetchrecursesubmodules)$/i,
  /^beads\.role$/i,
];
/** A key name safe to SHOW: the subsection (a URL, which can carry credentials, or a branch name) is replaced. "http.https://u:SECRET@h/.extraheader" becomes "http.<...>.extraheader". */
export function redactKey(key: string): string {
  const first = key.indexOf("."), last = key.lastIndexOf(".");
  return first === -1 ? key.slice(0, 40) : last === first ? key.slice(0, 80) : `${key.slice(0, first)}.<...>.${key.slice(last + 1)}`.slice(0, 80);
}
/** Keys from system, global and command-line scope are the owner's (or ours) and are not judged. Returns the offending key NAMES (no values). */
export function unsafeConfigKeys(raw: string): string[] {
  const parts = raw.split("\0"); if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length % 3 !== 0) return ["(unparseable config output)"];
  const bad: string[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const scope = parts[i], key = parts[i + 2].split("\n")[0];
    if (scope === "system" || scope === "global" || scope === "command") continue;
    if (!SAFE_KEYS.some(re => re.test(key)) && !bad.includes(key)) bad.push(key);
  }
  return bad;
}

/** The ONLY flags each verb may carry, matched EXACTLY (review MAJOR 3: a denylist cannot see a clustered short flag such as a combined force-and-delete
 * cluster; an allowlist can). Only arguments BEFORE the first "--" are flags: after "--" everything is an operand (a validated sha, a validated name, or a
 * path from git), and git never reads it as an option. A verb absent here accepts no flag at all. */
export const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  branch: [], tag: [], "check-ref-format": [],
  switch: ["--detach", "--no-overwrite-ignore"],
  "cherry-pick": ["--no-edit", "--abort"], revert: ["--no-edit", "--abort"],
  diff: ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--name-only", "-z"],
  "diff-tree": ["-r", "--name-only", "-z", "--no-commit-id", "--root", "--no-ext-diff"],
  "ls-files": ["--others", "--ignored", "--exclude-standard", "-z"],
  "format-patch": ["-1", "--stdout", "--no-ext-diff", "--no-textconv", "--no-signature"],
  status: ["--porcelain=v1", "-z", "-uno", "--ignore-submodules=all"],
  "symbolic-ref": ["--quiet", "--short"],
  "rev-parse": ["--verify", "--quiet", "--git-path", "--absolute-git-dir", "--show-toplevel", "--git-common-dir", "--path-format=absolute"],
});

/** Verb is allowlisted, every flag before the first "--" is on that verb's exact allowlist, and no argument carries a NUL. `config` is the exact preflight only. */
export function argvAllowed(argv: readonly string[], enabled: readonly string[] = GIT_ACTIONS_ALL): boolean {
  if (argv[0] === "config") return samePreflight(argv);
  const [verb, ...rest] = argv;
  if (!verb || !ALL_VERBS.includes(verb) || (WRITE_VERBS.includes(verb) && !enabled.some(a => OP_VERB[a] === verb)) || argv.some(a => typeof a !== "string" || a.includes("\0"))) return false;
  const flags = ALLOWED_FLAGS[verb] ?? [], cut = rest.indexOf("--"), head = cut === -1 ? rest : rest.slice(0, cut);
  return head.every(a => !a.startsWith("-") || flags.includes(a));
}

export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Strict ref name gate, applied BEFORE `git check-ref-format` (which accepts a leading "-" under a ref prefix: verified on git 2.54). */
export function validRefName(name: unknown): name is string {
  if (typeof name !== "string" || name.length < 1 || name.length > 200) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".") || name.includes("@{")) return false;
  if (name === "HEAD" || name === "@" || FULL_SHA_RE.test(name)) return false;
  return name.split("/").every(part => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export const REFUSALS = {
  badSha: "invalid commit id",
  badName: "invalid name: use letters, digits and . _ - / (no leading dash, no \"..\", no \".lock\")",
  ignoredCollision: "this would overwrite ignored local files (a local secrets file, for example): move them aside first",
  dirty: "the working tree has uncommitted changes: commit or stash first",
  inProgress: "another git operation is in progress (cherry-pick, revert, merge, rebase or bisect): finish or abort it first",
  detached: "HEAD is detached: check out a branch first",
  merge: "this is a merge commit: pick the mainline yourself in a terminal",
  noToken: "preview expired or does not match: review the command again",
  noConfirm: "type the short commit id to confirm",
  busy: "another git action is already running in this repository",
  localConfigRuns: "this repository's local git config makes git run programs, or uses a setting Osiris does not vet (a filter, merge or diff driver, a gpg/ssh program, an include, core.worktree...): run the action in a terminal where you can see it",
  held: "held back on purpose: this action is waiting for its own clean security review (td-osi.14.1)",
  notThisRepo: "this directory's git data does not belong to this directory (a .git file or core.worktree points elsewhere)",
  plugin: "git actions are not available to other plugins",
} as const;

/** Only these ops need the typed short sha (they move HEAD or add a commit). Branch/tag are additive. */
export const needsTypedConfirm = (op: WriteOp): boolean => op === "checkout" || op === "cherry-pick" || op === "revert";
/** Only these refuse a dirty tracked tree and an operation in progress. */
export const needsCleanTree = needsTypedConfirm;
/** Only these refuse a detached HEAD. */
export const needsBranch = (op: WriteOp): boolean => op === "cherry-pick" || op === "revert";
export const takesName = (op: WriteOp): boolean => op === "new-branch" || op === "new-tag";

/** The command the dialog shows. Display only: the runner builds the REAL argv separately from validated parts; a test pins them equal. */
export function displayCommand(op: WriteOp, sha: string, name?: string): string {
  switch (op) {
    case "new-branch": return `git branch -- ${name} ${sha}`;
    case "new-tag": return `git tag -- ${name} ${sha}`;
    case "checkout": return `git switch --detach --no-overwrite-ignore -- ${sha}`;
    case "cherry-pick": return `git cherry-pick --no-edit -- ${sha}`;
    case "revert": return `git revert --no-edit -- ${sha}`;
  }
}

/** Split one `git diff` patch into per-file chunks (path taken from the b/ side, else the a/ side). Pure; the caller bounds the input. */
export function splitPatch(raw: string): { path: string; raw: string }[] {
  if (typeof raw !== "string" || raw === "") return [];
  const out: { path: string; raw: string }[] = [];
  for (const chunk of raw.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1], minus = /^--- a\/(.+)$/m.exec(chunk)?.[1];
    const head = /^diff --git a\/(.+) b\/(.+)$/m.exec(chunk);
    out.push({ path: (plus ?? minus ?? head?.[2] ?? "(unknown)").replace(/\t.*$/, ""), raw: chunk });
  }
  return out;
}

/** Filename the CLIENT offers for a saved patch: short sha + slug, nothing path-like can survive. */
export function patchFileName(sha: string, subject: string): string {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${sha.slice(0, 7).replace(/[^0-9a-f]/g, "")}${slug ? `-${slug}` : ""}.patch`;
}
