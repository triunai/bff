// The ONE reviewed git-WRITE runner (server-only). Threat model: docs/reviews/2026-10-06-usability-blast/fg/fg-gitwrite-threat-model.md
// (webshop repo, bead td-osi.14.1, owner OK 2026-10-07 "you have my okay for this in terms of git").
//   - git spawns through the ONE primitive (work/trusted-bin.ts, D-139): argv ARRAY, no shell, an ABSOLUTE vetted git path, hooks/fsmonitor/ext-diff off, NO inherited env.
//   - Verbs and flags are gated by git-write-rules.ts (argvAllowed): no push/reset/clean/rebase/fetch/commit, never --force/-f/--hard.
//   - Every ref argument comes AFTER `--`; a commit is a full 40-hex sha resolved by git, a name passes validRefName + check-ref-format.
//   - A write needs a one-time preview token bound to (repo, op, sha, name, HEAD, branch); plugin callers are refused in server.ts.
//   - checkout/cherry-pick/revert refuse a dirty tracked tree or an operation in progress; cherry-pick/revert abort cleanly on any stop.
import { constants, statSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { FileDiff, GitResult } from "../git-types.ts";
import { HARDEN_ARGS, resolveGit, spawnGit, validateRepo } from "../git-feed.ts";
import { parseFileDiff } from "../git-diff.ts";
import { CONFIG_PREFLIGHT, FULL_SHA_RE, GIT_ACTIONS_ENABLED, redactKey, unsafeConfigKeys, WRITE_VERBS, REFUSALS, READ_VERBS, SHA_RE, argvAllowed, displayCommand, needsBranch, needsCleanTree, needsTypedConfirm, splitPatch, takesName, validRefName, type WriteOp, WRITE_OPS } from "./git-write-rules.ts";

const OUT_MAX = 1024 * 1024, READ_MS = 5000, WRITE_MS = 30_000, TOKEN_TTL_MS = 120_000, TOKEN_CAP = 32, FILE_CAP = 200;
const IN_PROGRESS = ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"] as const;

export type ExecResult = { code: number | null; stdout: string; /** classification only: never returned to the UI */ stderr?: string; spawnError?: "enoent" | "timeout" | "maxbuffer" | "other" };
export interface GitWriteDeps {
  /** Runs `git <hardening> <argv>` in repo. argv[0] is the verb. Tests inject a fake; the default is the trusted-bin spawn of an absolute git. */
  exec(repo: string, argv: readonly string[], o: { timeoutMs: number; maxBytes: number }): Promise<ExecResult>;
  exists(path: string): boolean;
  /** realpath, or null when it cannot be resolved */
  realpath(path: string): Promise<string | null>;
  /** what `path` is WITHOUT following a symlink: "dir", "file", "symlink", or null */
  kind(path: string): Promise<"dir" | "file" | "symlink" | null>;
  /** first 4 KiB of a small regular file (O_NOFOLLOW, never reads a device or an oversized file), or null */
  readText(path: string): Promise<string | null>;
  now(): number;
  token(): string;
}

/** Overrides for the write verbs only: a repo-local tag.gpgSign must never turn a lightweight tag into an annotated, signed one that opens TAG_EDITMSG (codex R2 M6). */
export const WRITE_HARDEN_ARGS: readonly string[] = Object.freeze(["-c", "tag.gpgsign=false", "-c", "tag.forcesignannotated=false"]);

export function defaultDeps(enabled: readonly string[] = GIT_ACTIONS_ENABLED): GitWriteDeps {
  return {
    exec: async (repo, argv, o) => {
      const bin = resolveGit(); // re-vetted on EVERY call (D-139): a git swapped after startup is refused, not run
      if (!bin) return { code: null, stdout: "", spawnError: "enoent" };
      if (!argvAllowed(argv, enabled)) return { code: null, stdout: "", spawnError: "other" }; // the runner's last line of defence, independent of the callers
      const r = await spawnGit(["-C", repo, ...(READ_VERBS.includes(argv[0]) ? ["--no-optional-locks"] : []), ...HARDEN_ARGS, ...(WRITE_VERBS.includes(argv[0]) ? WRITE_HARDEN_ARGS : []), ...argv],
        { bin, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, extraEnv: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } });
      switch (r.kind) {
        case "exit": return r.code === 0 ? { code: 0, stdout: r.stdout } : { code: r.code, stdout: r.stdout, stderr: r.stderr.slice(0, 4096) };
        case "refused": return { code: null, stdout: "", spawnError: r.reason === "not-found" ? "enoent" : "other" };
        case "overflow": return { code: null, stdout: "", spawnError: "maxbuffer" };
        case "timeout": return { code: null, stdout: "", spawnError: "timeout" };
        default: return { code: null, stdout: r.stdout, stderr: r.stderr.slice(0, 4096), spawnError: r.code === "ENOENT" ? "enoent" : "other" };
      }
    },
    exists: p => { try { statSync(p); return true; } catch { return false; } },
    realpath: async p => { try { return await realpath(p); } catch { return null; } },
    kind: async p => { try { const st = await lstat(p); return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : null; } catch { return null; } },
    readText: async p => {
      let fh; try {
        fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const st = await fh.stat(); if (!st.isFile() || st.size > 4096) return null;
        const buf = Buffer.alloc(Math.max(1, st.size)), { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead).toString("utf8");
      } catch { return null; } finally { await fh?.close().catch(() => undefined); }
    },
    now: () => Date.now(),
    token: () => randomBytes(16).toString("hex"),
  };
}

export type Preview = {
  ok: true; op: WriteOp; repo: string; branch: string | null; head: string | null; sha: string; shortSha: string; command: string;
  /** What the human must type for checkout/cherry-pick/revert, else null. */
  confirmWith: string | null; blocked: string | null; token: string | null;
};
export type WriteResult = { ok: true; message: string; head: string | null } | { ok: false; reason: string; aborted?: boolean };
export type LocalDiff = { files: FileDiff[]; filesTruncated: boolean };
type Pending = { identity: string; repo: string; op: WriteOp; sha: string; name: string; head: string; branch: string | null; exp: number };

const spawnReason = (r: ExecResult): string => r.spawnError === "enoent" ? "git executable not found" : r.spawnError === "timeout" ? "git timed out" : r.spawnError === "maxbuffer" ? "git output exceeded the size bound (1 MiB)" : r.spawnError ? "git failed" : `git exited with status ${r.code}`;

export function makeGitWrite(deps: GitWriteDeps = defaultDeps(), enabled: readonly string[] = GIT_ACTIONS_ENABLED) {
  const pending = new Map<string, Pending>(), inFlight = new Set<string>();
  const read = (repo: string, argv: string[], maxBytes = 64 * 1024) => deps.exec(repo, argv, { timeoutMs: READ_MS, maxBytes });

  async function resolveCommit(repo: string, sha: unknown): Promise<GitResult<string>> {
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return { ok: false, reason: REFUSALS.badSha };
    const r = await read(repo, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    const full = r.stdout.trim();
    return r.code === 0 && FULL_SHA_RE.test(full) ? { ok: true, value: full } : { ok: false, reason: REFUSALS.badSha };
  }

  async function checkName(repo: string, op: WriteOp, name: unknown): Promise<GitResult<string>> {
    if (!validRefName(name)) return { ok: false, reason: REFUSALS.badName };
    const prefix = op === "new-tag" ? "refs/tags/" : "refs/heads/";
    if ((await read(repo, ["check-ref-format", `${prefix}${name}`])).code !== 0) return { ok: false, reason: REFUSALS.badName };
    if ((await read(repo, ["rev-parse", "--verify", "--quiet", `${prefix}${name}`])).code === 0) return { ok: false, reason: `a ${op === "new-tag" ? "tag" : "branch"} named "${name}" already exists` };
    return { ok: true, value: name };
  }

  /** The directory must BE the repository, and its config must be one Osiris can vet (codex R2 M2/M4/M5). Runs before ANY object is resolved, because reading an
   * object can lazy-fetch over a configured ssh command, and before any status/diff, because those re-hash files through a clean filter.
   *  1. effective git dir and toplevel must belong to this directory: a `.git` file pointing at another repo, or core.worktree, is refused. A genuine linked
   *     worktree is accepted because its git dir carries a `gitdir` back-pointer to this directory's `.git`.
   *  2. every repository-owned config entry (local, worktree, includes) must be on the SAFE_KEYS allowlist: default-deny, values never read out. */
  async function gate(repo: string): Promise<GitResult<string>> {
    const no = { ok: false as const, reason: REFUSALS.notThisRepo };
    // `.git` itself must be a real directory, or a regular file (a linked worktree's pointer): never a symlink, never anything else (codex R3 M1).
    const dotKind = await deps.kind(join(repo, ".git")); if (dotKind !== "dir" && dotKind !== "file") return no;
    const [gd, top, cd] = await Promise.all([read(repo, ["rev-parse", "--absolute-git-dir"]), read(repo, ["rev-parse", "--show-toplevel"]), read(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])]);
    if (gd.code !== 0 || top.code !== 0 || cd.code !== 0) return no;
    const [gdR, topR, dotR, cdR] = await Promise.all([deps.realpath(gd.stdout.trim()), deps.realpath(top.stdout.trim()), deps.realpath(join(repo, ".git")), deps.realpath(cd.stdout.trim())]);
    if (!gdR || !topR || !dotR || !cdR || topR !== repo) return no;
    if (dotKind === "dir") { if (gdR !== dotR || cdR !== gdR) return no; } // an ordinary repository: git dir and common dir are both `.git`; a `commondir` file pointing elsewhere breaks this
    else {
      // a linked worktree: git dir = <common>/worktrees/<name>, the common dir is exactly two levels up, and the git dir points back at THIS `.git` file
      const wtDir = dirname(gdR);
      if (basename(wtDir) !== "worktrees" || dirname(wtDir) !== cdR) return no;
      const back = await deps.readText(join(gdR, "gitdir")), backR = back ? await deps.realpath(back.trim()) : null;
      if (!backR || backR !== dotR) return no;
    }
    const cfg = await read(repo, [...CONFIG_PREFLIGHT], OUT_MAX);
    if (cfg.code !== 0) return { ok: false, reason: REFUSALS.localConfigRuns };
    const bad = unsafeConfigKeys(cfg.stdout).map(redactKey);
    return bad.length === 0 ? { ok: true, value: `${gdR}|${cdR}` } : { ok: false, reason: `${REFUSALS.localConfigRuns} [${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ", ..." : ""}]` };
  }

  /** HEAD and the branch RIGHT NOW. Read last in inspect and again just before the write, so the comparison with the preview is as close to the exec as separate subprocesses allow. */
  async function snapshot(repo: string) {
    const [headR, branchR] = await Promise.all([read(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]), read(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])]);
    return { head: headR.code === 0 ? headR.stdout.trim() : null, branch: branchR.code === 0 ? branchR.stdout.trim() || null : null };
  }

  /** Paths this action would rewrite that collide with an IGNORED, untracked local file: the leaf itself, an ANCESTOR that is a file where a directory is
   * needed (private vs private/key), or a leaf that is an ignored DIRECTORY with content (codex R2 M3). checkout's `--no-overwrite-ignore` covers switch; a
   * cherry-pick or revert merge has no such option. Returns up to 3 names, [] for none, null when it cannot be checked. */
  async function ignoredCollisions(repo: string, op: WriteOp, full: string): Promise<string[] | null> {
    const names = op === "checkout"
      ? await read(repo, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", full, "--"], OUT_MAX)
      : await read(repo, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "-z", "--no-ext-diff", full, "--"], OUT_MAX);
    if (names.code !== 0) return null;
    const leaves = names.stdout.split("\0").filter(Boolean);
    if (leaves.length > 2000) return null;
    const watch = new Set(leaves);
    for (const l of leaves) { const parts = l.split("/"); for (let i = 1; i < parts.length; i++) watch.add(parts.slice(0, i).join("/")); }
    const all = [...watch], hits: string[] = [];
    for (let i = 0; i < all.length; i += 100) {
      const r = await read(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...all.slice(i, i + 100)], OUT_MAX);
      if (r.code !== 0) return null;
      for (const f of r.stdout.split("\0").filter(Boolean)) if (watch.has(f) || leaves.some(l => f.startsWith(`${l}/`))) hits.push(f);
    }
    return hits.slice(0, 3);
  }

  /** Everything that decides whether a write may proceed, re-run at preview AND at run. The caller has already passed gate(). The working-tree questions come
   * first and the HEAD/branch snapshot LAST, so a branch switch that lands during the checks is what the caller compares (codex R2 M7). */
  async function inspect(repo: string, op: WriteOp, full: string) {
    let blocked: string | null = null;
    if (needsCleanTree(op)) {
      const dirtyR = await read(repo, ["status", "--porcelain=v1", "-z", "-uno", "--ignore-submodules=all"]);
      if (dirtyR.code !== 0) blocked = "could not read the working tree status";
      else if (dirtyR.stdout.length > 0) blocked = REFUSALS.dirty;
      else {
        for (const n of IN_PROGRESS) {
          const gp = await read(repo, ["rev-parse", "--git-path", n]), p = gp.stdout.trim();
          if (gp.code === 0 && p && deps.exists(isAbsolute(p) ? p : join(repo, p))) { blocked = REFUSALS.inProgress; break; }
        }
        if (!blocked) {
          const hit = await ignoredCollisions(repo, op, full);
          if (hit === null) blocked = "could not check which files this would change";
          else if (hit.length > 0) blocked = `${REFUSALS.ignoredCollision}: ${hit.join(", ")}`;
        }
      }
    }
    const { head, branch } = await snapshot(repo);
    if (!blocked && !head) blocked = "the repository has no commits yet";
    if (!blocked && needsBranch(op)) {
      if (!branch) blocked = REFUSALS.detached;
      else if ((await read(repo, ["rev-parse", "--verify", "--quiet", `${full}^2`])).code === 0) blocked = REFUSALS.merge;
    }
    return { head, branch, blocked };
  }

  function argvFor(op: WriteOp, full: string, name: string): string[] {
    switch (op) {
      case "new-branch": return ["branch", "--", name, full];
      case "new-tag": return ["tag", "--", name, full];
      case "checkout": return ["switch", "--detach", "--no-overwrite-ignore", "--", full];
      case "cherry-pick": return ["cherry-pick", "--no-edit", "--", full];
      case "revert": return ["revert", "--no-edit", "--", full];
    }
  }

  async function preview(repoIn: string, op: unknown, sha: unknown, nameIn?: unknown): Promise<GitResult<Preview>> {
    if (typeof op !== "string" || !WRITE_OPS.includes(op as WriteOp)) return { ok: false, reason: "unknown git action" };
    if (!enabled.includes(op)) return { ok: false, reason: REFUSALS.held };
    const v = await validateRepo(repoIn); if (!v.ok) return v;
    const repo = v.value, o = op as WriteOp;
    const gt = await gate(repo); if (!gt.ok) return gt;
    const identity = gt.value;
    const c = await resolveCommit(repo, sha); if (!c.ok) return c;
    let name = "";
    if (takesName(o)) { const n = await checkName(repo, o, nameIn); if (!n.ok) return n; name = n.value; }
    const st = await inspect(repo, o, c.value);
    let token: string | null = null;
    if (!st.blocked && st.head) {
      for (const [k, p] of pending) if (p.exp <= deps.now()) pending.delete(k);
      while (pending.size >= TOKEN_CAP) pending.delete(pending.keys().next().value!);
      token = deps.token(); pending.set(token, { identity, repo, op: o, sha: c.value, name, head: st.head, branch: st.branch, exp: deps.now() + TOKEN_TTL_MS });
    }
    const short = c.value.slice(0, 7);
    return { ok: true, value: { ok: true, op: o, repo, branch: st.branch, head: st.head, sha: c.value, shortSha: short, command: displayCommand(o, c.value, name), confirmWith: needsTypedConfirm(o) ? short : null, blocked: st.blocked, token } };
  }

  /** Runs a previewed write. The token is consumed whatever happens (one try per preview). */
  async function run(req: { repo: string; op: unknown; sha: unknown; name?: unknown; token: unknown; confirm?: unknown }): Promise<WriteResult> {
    const tok = typeof req.token === "string" ? pending.get(req.token) : undefined;
    if (typeof req.token === "string") pending.delete(req.token);
    if (!tok || tok.exp <= deps.now()) return { ok: false, reason: REFUSALS.noToken };
    const v = await validateRepo(req.repo);
    if (!v.ok || v.value !== tok.repo || req.op !== tok.op) return { ok: false, reason: REFUSALS.noToken };
    if (!enabled.includes(tok.op)) return { ok: false, reason: REFUSALS.held };
    const gt0 = await gate(tok.repo); if (!gt0.ok) return gt0; if (gt0.value !== tok.identity) return { ok: false, reason: REFUSALS.notThisRepo };
    const c = await resolveCommit(tok.repo, req.sha);
    if (!c.ok || c.value !== tok.sha) return { ok: false, reason: REFUSALS.noToken };
    if (takesName(tok.op) && req.name !== tok.name) return { ok: false, reason: REFUSALS.noToken };
    if (needsTypedConfirm(tok.op) && (typeof req.confirm !== "string" || req.confirm.trim() !== tok.sha.slice(0, 7))) return { ok: false, reason: REFUSALS.noConfirm };
    if (inFlight.has(tok.repo)) return { ok: false, reason: REFUSALS.busy };
    inFlight.add(tok.repo);
    try {
      if (takesName(tok.op)) { const n = await checkName(tok.repo, tok.op, tok.name); if (!n.ok) return n; }
      const st = await inspect(tok.repo, tok.op, tok.sha);
      if (st.blocked) return { ok: false, reason: st.blocked };
      const changed = { ok: false as const, reason: "the repository changed since the preview: review the command again" };
      if (st.head !== tok.head || st.branch !== tok.branch) return changed;
      // last look, immediately before the write: the config may not have been swapped, and HEAD/branch must still be what the human previewed
      const gt1 = await gate(tok.repo); if (!gt1.ok) return gt1; if (gt1.value !== tok.identity) return changed;
      const last = await snapshot(tok.repo); if (last.head !== tok.head || last.branch !== tok.branch) return changed;
      const r = await deps.exec(tok.repo, argvFor(tok.op, tok.sha, tok.name), { timeoutMs: WRITE_MS, maxBytes: OUT_MAX });
      if (r.code === 0) {
        const after = await read(tok.repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
        return { ok: true, message: `Done: ${displayCommand(tok.op, tok.sha.slice(0, 7), tok.name)}`, head: after.code === 0 ? after.stdout.trim() : null };
      }
      if (tok.op === "cherry-pick" || tok.op === "revert") return await recover(tok, r); // awaited: the finally below must not release the repo lock until recovery has finished (review MAJOR 2)
      return { ok: false, reason: spawnReason(r) };
    } finally { inFlight.delete(tok.repo); }
  }

  /** cherry-pick/revert stopped (conflict, empty pick, hook-free failure): abort through git's own verb, then prove the pre-state is back. */
  async function recover(tok: Pending, r: ExecResult): Promise<WriteResult> {
    const verb = tok.op as "cherry-pick" | "revert", marker = verb === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD";
    const gp = await read(tok.repo, ["rev-parse", "--git-path", marker]), p = gp.stdout.trim();
    const started = gp.code === 0 && !!p && deps.exists(isAbsolute(p) ? p : join(tok.repo, p));
    let abortOk = true;
    if (started) abortOk = (await deps.exec(tok.repo, [verb, "--abort"], { timeoutMs: WRITE_MS, maxBytes: OUT_MAX })).code === 0;
    const head = await read(tok.repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const dirty = await read(tok.repo, ["status", "--porcelain=v1", "-z", "-uno", "--ignore-submodules=all"]);
    const clean = head.code === 0 && head.stdout.trim() === tok.head && dirty.code === 0 && dirty.stdout.length === 0 && abortOk;
    const signing = /gpg|ssh-keygen|failed to sign|signing failed|failed to write commit object/i.test(r.stderr ?? "");
    const why = signing ? `${verb} could not sign the commit (check your gpg or ssh signing setup)` : started ? `${verb} stopped (conflict or empty change)` : `${verb} failed (${spawnReason(r)})`;
    return clean
      ? { ok: false, aborted: true, reason: `${why}; aborted cleanly, nothing changed` }
      : { ok: false, aborted: false, reason: `${why}; the repository may need attention: run \`git ${verb} --abort\` then \`git status\` in a terminal` };
  }

  async function localDiff(repoIn: string, sha: unknown): Promise<GitResult<LocalDiff>> {
    if (!enabled.includes("compare-local")) return { ok: false, reason: REFUSALS.held };
    const v = await validateRepo(repoIn); if (!v.ok) return v;
    const gt = await gate(v.value); if (!gt.ok) return gt; // diff against the working tree re-hashes files through any clean filter
    const c = await resolveCommit(v.value, sha); if (!c.ok) return c;
    const r = await deps.exec(v.value, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", c.value, "--"], { timeoutMs: READ_MS, maxBytes: OUT_MAX });
    if (r.code !== 0) return { ok: false, reason: spawnReason(r) };
    const chunks = splitPatch(r.stdout);
    return { ok: true, value: { files: chunks.slice(0, FILE_CAP).map(ch => parseFileDiff(ch.raw, ch.path)), filesTruncated: chunks.length > FILE_CAP } };
  }

  async function formatPatch(repoIn: string, sha: unknown): Promise<GitResult<string>> {
    if (!enabled.includes("save-patch")) return { ok: false, reason: REFUSALS.held };
    const v = await validateRepo(repoIn); if (!v.ok) return v;
    const gt = await gate(v.value); if (!gt.ok) return gt;
    const c = await resolveCommit(v.value, sha); if (!c.ok) return c;
    const r = await deps.exec(v.value, ["format-patch", "-1", "--stdout", "--no-ext-diff", "--no-textconv", "--no-signature", c.value, "--"], { timeoutMs: READ_MS, maxBytes: OUT_MAX });
    if (r.code !== 0) return { ok: false, reason: spawnReason(r) };
    return r.stdout ? { ok: true, value: r.stdout } : { ok: false, reason: "this commit has no patch (merge commits are skipped by format-patch)" };
  }

  return { preview, run, localDiff, formatPatch, pendingCount: () => pending.size };
}
export type GitWrite = ReturnType<typeof makeGitWrite>;
