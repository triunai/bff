# BFF roadmap — candidates, not commitments

Items move from here into a release (and a ledger entry) when they are built and verified. Each says why it matters and where the evidence came from.

## v0.1.2 candidates — Osiris call inspector (from owner screenshots, 2026-10-05)

Source: the owner watched a live Claude Code session in Osiris. In that session's own log, 34 of 717 tool calls were marked as errors, and about half of those were not real failures.

1. **Values in the call inspector are cut off.** The value column truncates (`Unavailab…`, `05/10/202…`). Wrap long values, or show the full value on hover with a copy action.
2. **Fill fields the provider log already has.** Claude Code's transcript records each tool call's input, its result text, and timestamps for both the call and the result. Today the inspector shows `Unknown` / `Unavailable` for these. Capture:
   - the input (the command or arguments), with secrets redacted;
   - the error text;
   - start and end times, so observed duration can be computed.

   This is the biggest single gain: "error" alone says that something failed, not what failed.
3. **Classify errors instead of a single `TOOL_ERR`.** Use at least these classes:
   - a hook or guard blocked the call;
   - the command exited non-zero (note that `grep` finding nothing and `diff` finding a difference both exit 1, which is often not a failure);
   - the tool rejected its input (validation);
   - a file or edit failed.

   Group the Problems tab by class, so a blocked command is not counted the same as a crash.
4. **Session header is missing the provider name.** It renders ` · a697fe19…` with nothing before the dot.
5. **Make "stale" concrete.** Show how old the capture is (for example "captured 3 min ago") so the counts can be trusted or refreshed.

## Still open from earlier releases

See `CHANGELOG.md` and the latest ledger entry: full agent lineage and worktree joins, manual terminal capture, enforced hooks/CI, Beads/Gas/DSH adapters and their evals.
