#!/usr/bin/env node
// Beads safety TRIPWIRE (owner, 2026-10-07: `bd init` points Dolt sync at GitHub). Osiris may make TWO beads writes: dispatch's
// `bd --actor <a> update <id> --claim` and the Board's reviewed `update <id> --status <status>` (TRACKER_MOVE below). This scan is a TRIPWIRE, NOT A PROOF: it greps the BUILT bundles (dist/app.js, dist/server.js)
// and every non-test TypeScript source for the shapes a careless edit would leave, and it WILL miss a dynamically built argv
// (`const w = "sync"; run([w])`, array push, string concat, `sh -c "bd sync"`, `"dolt push".split(" ")`). What it checks:
//   1. the client bundle never spawns anything and carries no bd argv at all;
//   2. the server bundle carries exactly one `--claim` and exactly one quoted `"update",` token, next to each other, and the quoted
//      `"update",` token appears exactly ONCE across ALL sources together (a second update argv anywhere fails);
//   3. no bd write subcommand appears as quoted ARGV tokens: adjacent tokens ("dolt","push"), an argv that STARTS with a write
//      subcommand (sync/close/create/delete/.../set-state/assign/export), and any write subcommand quoted within 120 chars after
//      "--actor" other than the single "update" ... "--claim". Prose is not argv: the agent prompt's sentence "Never run bd sync or
//      bd dolt push" passes, by design.
// KNOWN LIMIT, stated on purpose (Codex R3, 2026-10-07): a verb BUILT AT RUNTIME ("cl" + suffix, an array mutated after its literal, a table lookup) is
// invisible to every layer here, including the minified bundles. This scan is a backstop for careless LITERAL edits, never the security boundary. For git
// the boundary is the runtime argv allowlist in work/git-write-rules.ts (argvAllowed: exact verbs, exact flags per verb) plus the default-deny config scan;
// for bd it is the read-only shim. Do not spend effort chasing computed-string completeness here.
// The REAL guarantees are structural (bd-readonly.ts shim for every read, bd --readonly, dispatch's one hard-coded claim argv) and are
// pinned by work/__tests__/security-*.test.ts. Do not read a PASS here as "no write exists".
// Usage: node scripts/safety-scan.mjs <plugin-dir>   (exit 0 = clean, 1 = violations, 2 = cannot run)
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";

const Q = `["'\`]`;
const NOQ = "[^'\"\\x60\\]]"; // any char but a quote, a backtick or a closing bracket
const tok = (...words) => words.map(w => `${Q}${w}${Q}`).join("\\s*,\\s*");
/** Write shapes, as argv. Each is a bd write or a remote/sync action Osiris must never run. */
// git write verbs (commit-menu W-193c: the menu lists mutators but disabled; no module may carry their argv). git-feed.ts READ_ONLY is the
// structural guard; this is the tripwire for a careless second git caller. `["show", ...]`, `["log", ...]` etc. stay legal.
const GIT_WRITE = "push|commit|checkout|reset|rebase|cherry-pick|revert|merge|tag|branch|fetch|pull|clean|am|apply|stash|switch|restore|add|rm|mv|clone|gc|update-ref|filter-branch|gc|prune|notes|replace";
export const FORBIDDEN = [
  // `worktree list` is a read (git-worktree-probe) and herdr has its own `worktree create`; only the mutating git worktree subcommands are shapes to refuse.
  ["git worktree mutation", new RegExp(`${tok("worktree")}\\s*,\\s*${Q}(?:add|remove|move|prune|lock|unlock|repair)${Q}`)],
  ["git write verb as argv", new RegExp(`\\[\\s*(?:(?:${Q}-[Cc]${Q}\\s*,[^\\]]*?|${Q}-[^'"\`\\]]*${Q})\\s*,\\s*)*${Q}(?:${GIT_WRITE})${Q}\\s*[,\\]]`)], // leading global options and a -C operand of any shape (even join(repo, ".")) do not hide the verb (R3)
  ["dolt push/pull/commit/remote add", new RegExp(`${tok("dolt")}\\s*,\\s*${Q}(?:push|pull|commit|fetch|clone)${Q}|${tok("remote")}\\s*,\\s*${Q}(?:add|set-url)${Q}`)],
  ["argv starting with a write subcommand", new RegExp(`\\[\\s*(?:${Q}-${NOQ}*${Q}\\s*,\\s*)*${Q}(?:sync|close|create|delete|reclaim|import|init|migrate|reopen|compact|prune|set-state|assign|export)${Q}\\s*[,\\]]`)],
  ["--readonly followed by a write subcommand", new RegExp(`${Q}--readonly${Q}\\s*,\\s*${Q}(?:sync|close|create|update|delete|reclaim)${Q}`)],
  ["metadata/force writes", new RegExp(`${Q}(?:--set-metadata|--unset-metadata|--add-label|--remove-label)${Q}`)],
  ["gate resolve / comments add / label add / dep add / config set", new RegExp(`${tok("gate", "resolve")}|${tok("comments", "add")}|${tok("label")}\\s*,\\s*${Q}(?:add|remove)${Q}|${tok("dep")}\\s*,\\s*${Q}(?:add|remove)${Q}|${tok("config", "set")}`)],
];
const WRITE_WORD = new RegExp(`${Q}(?:update|create|close|delete|sync|reclaim|import|init|migrate|reopen|compact|prune|label|dep|set-state|assign|export|comments|gate|config|dolt|remote|sql|reset|restore|purge|merge|rename|move|defer|undefer)${Q}`);
const CLAIM_PAIR = new RegExp(`${Q}update${Q}\\s*,[^\\]]{0,60}${Q}--claim${Q}`);
const UPDATE_TOKEN = new RegExp(`${Q}update${Q}\\s*,`, "g");
/** Every "--actor" is followed (within 120 chars) by nothing but the single "update" ... "--claim" pair. */
export function actorWrites(text) {
  const v = []; const re = new RegExp(`${Q}--actor${Q}`, "g"); let m;
  while ((m = re.exec(text))) { const w = text.slice(m.index + m[0].length, m.index + m[0].length + 120).replace(CLAIM_PAIR, ""); const bad = WRITE_WORD.exec(w); if (bad) v.push(bad[0]); }
  return v;
}
/** Quoted `"update",` tokens across all texts together: must be exactly 1 (the claim). */
export const countUpdates = texts => texts.reduce((n, t) => n + (t.match(UPDATE_TOKEN) ?? []).length, 0);
const count = (s, re) => (s.match(new RegExp(re.source, "g")) ?? []).length;

// The REVIEWED git-write argv shapes (td-h1w.14.1, owner OK 2026-10-07; threat model docs/reviews/2026-10-06-usability-blast/fg/fg-gitwrite-threat-model.md).
// work/git-write.ts is the ONE runner that builds them, and only in exactly these forms: a ref/name operand is a bare identifier, always after "--", and no
// flag other than --detach / --no-edit exists. They are removed from the text BEFORE the "git write verb as argv" rule runs, so the tripwire still fires on
// every other write shape (branch -D, push, commit, checkout, reset, cherry-pick --continue, any flag or operand variation). The shapes match the built
// (minified) bundles as well as the sources, because esbuild keeps string literals.
const SEP = "\\s*,\\s*", ID = "[A-Za-z_$][\\w$]*"; // a bare identifier: no spread, no member access, no literal
// Admitted only where the literal IS the value: directly after `return` or inside Object.freeze(...). A variable initialiser (`const argv = [...]; argv.splice(...)`) is not masked,
// so a mutation after the literal (Codex R3 scan M2) is a violation. No lookbehind needed: the prefix is consumed and re-emitted.
const shape = (...parts) => new RegExp(`((?:\\breturn|Object\\.freeze\\()\\s*)\\[\\s*${parts.join(SEP)}\\s*\\]`, "g");
export const GIT_WRITE_REVIEWED = [
  shape(`${Q}branch${Q}`, `${Q}--${Q}`, ID, ID), shape(`${Q}tag${Q}`, `${Q}--${Q}`, ID, ID), shape(`${Q}switch${Q}`, `${Q}--detach${Q}`, `${Q}--no-overwrite-ignore${Q}`, `${Q}--${Q}`, ID),
  shape(`${Q}cherry-pick${Q}`, `${Q}--no-edit${Q}`, `${Q}--${Q}`, ID), shape(`${Q}revert${Q}`, `${Q}--no-edit${Q}`, `${Q}--${Q}`, ID),
  shape(`${Q}branch${Q}`, `${Q}tag${Q}`, `${Q}switch${Q}`, `${Q}cherry-pick${Q}`, `${Q}revert${Q}`), // the frozen WRITE_VERBS allowlist itself
];
/** Only the reviewed runner and its pure rules may carry these shapes (a built bundle contains them by construction). Any other file keeps the full tripwire. */
export const GIT_WRITE_FILES = new Set(["work/git-write.ts", "work/git-write-rules.ts", "dist/server.js", "dist/app.js"]);
const maskReviewedGit = (name, text) => GIT_WRITE_FILES.has(name) ? GIT_WRITE_REVIEWED.reduce((t, re) => t.replace(re, "$1[]"), text) : text;

// The ONE reviewed tracker-move argv (td-h1w.12, owner OK 2026-10-07 "I can't manually intervene to drag and drop"): `bd update <id> --status <status> --if-status <from>` (compare-and-set), optionally
// `--append-notes <text>`, built only by work/tracker-write.ts from a validated id and a three-literal status allowlist (pinned in tracker-write.test.ts). The id and status
// are bare identifiers (never literals), so a second literal update argv, a different flag, or a --claim-less variant anywhere else still fails the count below.
export const TRACKER_MOVE = new RegExp(`\\[\\s*${Q}update${Q}${SEP}${ID}${SEP}${Q}--status${Q}${SEP}${ID}${SEP}${Q}--if-status${Q}${SEP}${ID}(?:${SEP}${Q}--append-notes${Q}${SEP}[^\\]\\[]{1,80})?\\s*\\]`, "g");
export const TRACKER_MOVE_FILES = new Set(["work/tracker-write.ts", "dist/server.js"]);
export const maskTrackerMove = (name, text) => TRACKER_MOVE_FILES.has(name) ? text.replace(TRACKER_MOVE, "[]") : text;

export function scanText(name, text0, kind) {
  const v = [];
  const text = maskTrackerMove(name, text0);
  const gitMasked = maskReviewedGit(name, text);
  for (const [what, re] of FORBIDDEN) if (re.test(what === "git write verb as argv" ? gitMasked : text)) v.push(`${name}: forbidden ${what}`);
  for (const w of actorWrites(text)) v.push(`${name}: write subcommand ${w} near "--actor" (only the one update/--claim is allowed)`);
  if (kind === "client") {
    for (const t of ["child_process", "--claim", "--readonly", "execFile"]) if (text.includes(t)) v.push(`${name}: client bundle contains ${t}`);
  }
  if (kind === "server") {
    const claims = count(text, new RegExp(`${Q}--claim${Q}`)), updates = count(text, new RegExp(`${Q}update${Q}\\s*,`));
    if (claims !== 1) v.push(`${name}: expected exactly 1 "--claim" argv token, found ${claims}`);
    if (updates !== 1) v.push(`${name}: expected exactly 1 "update" argv token (the claim), found ${updates}`);
    const i = text.search(new RegExp(`${Q}update${Q}\\s*,`)), j = text.search(new RegExp(`${Q}--claim${Q}`));
    if (claims === 1 && updates === 1 && Math.abs(i - j) > 200) v.push(`${name}: the one "update" is not the claim argv`);
  }
  return v;
}

function sources(root) {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "third_party", "evidence", "docs", "sdk", "fixtures"].includes(e.name) || e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); } else if (/\.(ts|tsx|mjs|js|cjs|jsx)$/.test(e.name) && !/\.test\.(ts|mjs|js|cjs)$/.test(e.name) && e.name !== "safety-scan.mjs") out.push(p);
  } };
  walk(root); return out;
}

export function scanPlugin(root) {
  const app = join(root, "dist", "app.js"), server = join(root, "dist", "server.js");
  if (!existsSync(app) || !existsSync(server)) return { ok: false, error: `no built bundle under ${join(root, "dist")} (run bb plugin build first)` };
  const v = [...scanText("dist/app.js", readFileSync(app, "utf8"), "client"), ...scanText("dist/server.js", readFileSync(server, "utf8"), "server")];
  const files = sources(root);
  const texts = files.map(f => readFileSync(f, "utf8"));
  files.forEach((f, i) => v.push(...scanText(relative(root, f), texts[i], "source")));
  const updates = countUpdates(files.map((f, i) => maskTrackerMove(relative(root, f), texts[i]))); if (updates !== 1) v.push(`sources: expected exactly 1 quoted "update", token across all sources (the claim), found ${updates}`);
  return { ok: true, violations: v, scanned: files.length + 2, bytes: statSync(app).size + statSync(server).size };
}

// Main-module check on REALPATHS: run from macOS's /var (a symlink to /private/var), argv[1] and import.meta.url differ, and
// the plain string compare made the stage gate's scan silently do nothing and exit 0 (caught while staging 0.2.15).
export const isMain = (metaUrl, argv1) => { try { return !!argv1 && pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(new URL(metaUrl))).href; } catch { return false; } };
if (isMain(import.meta.url, process.argv[1])) {
  const r = scanPlugin(process.argv[2] ?? process.cwd());
  if (!r.ok) { console.error(`SAFETY FAIL: ${r.error}`); process.exit(2); }
  if (r.violations.length) { for (const x of r.violations) console.error(x); console.error(`SAFETY FAIL: ${r.violations.length} violation(s)`); process.exit(1); }
  console.log(`SAFETY PASS: 0 forbidden bd calls · 1 claim path · ${r.scanned} files scanned`);
}
