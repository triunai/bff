#!/usr/bin/env node
// Single entry for the Osiris terminal apps: `osiris-tui.mjs factory|worktrees|prune [--repo <path>] [--all] [--no-color] [--once] [--cols <n>]`.
// Runs from the repo checkout or from the INSTALLED plugin dir (everything it imports ships in the stage). argv only; reads, never writes.
const [mode, ...rest] = process.argv.slice(2);
const usage = "usage: osiris-tui.mjs prune [--repo <path>] [--apply] [--min-idle-days N] [--installed <dir>] [--json]  (dry run unless --apply)\n       osiris-tui.mjs factory|worktrees [--repo <path>] [--all] [--no-color] [--once] [--cols <n>] [--interval <s>] [--no-mouse]";
if (mode === "--help" || mode === "-h") { console.log(usage); process.exit(0); }
if (mode === "prune") { const m = await import("../tui/prune-app.ts"); process.exit(await m.runPrune(m.parsePruneArgs(rest))); }
if (mode !== "factory" && mode !== "worktrees") { console.error(usage); process.exit(2); }
const code = mode === "factory" ? await (await import("../tui/factory-app.ts")).runFactory((await import("../tui/factory-app.ts")).parseArgs(rest))
  : await (await import("../tui/worktrees-app.ts")).runWorktrees((await import("../tui/worktrees-app.ts")).parseWorktreeArgs(rest));
process.exit(code);
