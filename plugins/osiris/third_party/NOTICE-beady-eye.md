# beady-eye (Apache-2.0): the look of the WORK tree, and the arkham demo data

Source: beady-eye v0.22.0 (v0.23.0 for the terminal-app section below), local clone at commit `4f524d4aa50fe8b29a46ef6c5aaaaa296101dd5e` (v0.23.0: `4e8d302576c502359c3faf39838652de15b8b1b9`) (`~/Repos/reference/beady-eye`).
Licence: Apache License 2.0, full text in `third_party/beady-eye-LICENSE.txt`. beady-eye ships no NOTICE file.

No beady-eye CODE is used (it is Rust/ratatui). Osiris reproduces its terminal LOOK in a web component and borrows:

| From beady-eye | Where in Osiris | What |
| --- | --- | --- |
| `docs/bdi-frame.svg` (README "arkham" frame) | `work/tree-layout.ts`, `components/work/bead-tree.tsx`, `docs/design/ui-v2-mockup.html` ("vs beady-eye") | the layout rules (four-column guides, padded id column, right bloc, selection band, pane band, key row); the frame is redrawn cell for cell in the mockup as a reference |
| `tools/capture/ground.sh` (the arkham fixture) | `work/__tests__/arkham-fixture.ts`, the mockup | bead ids, titles, statuses, parents, pane ids and the pane text, used as test and demo data |
| `docs/design.md` ("The elbow says which", the closed-run count) | `work/tree-layout.ts` | the strings "├─▸" (fold arm) and "✓ n more beads · finished"; the key row "a all  ? keys  / find  q quit" (q relabelled "hide") |

Changes: written fresh in TypeScript against Osiris's `sidebarRows()`. Colours are Osiris theme tokens, not beady-eye's
palette (except inside the mockup's reference rendering, which reproduces the frame as published). Blocks-edge copies are
not drawn (Osiris draws containment only), and ids are shown without the tracker prefix.

## The `osiris worktrees` terminal app (tui/worktrees-model.ts), v0.23.0

Apache-2.0 permits the lift; still no Rust is copied. The app is TypeScript and ports beady-eye's Arkham SCREEN as observed by running `bdi` read-only
against the webshop tracker in a pty (captured as `tui/__tests__/golden/beady-eye-arkham-100x40.txt` and `-160x45.txt`, used to pin the structure):

- the inverse header row (`▾ repo  ✓ time`, counts right-aligned), the `├──` / `└──` tree with the `─▸` selection arm, ◐ / ● state glyphs and the `⚠` counters;
- the full-width `─` rule above a detail pane, the status row, and the key row on the last line (first letter bold, label dim);
- the `list | detail` placement is Osiris's own (beady-eye stacks them; Osiris puts them side by side from 130 columns).

Changes: written fresh against Osiris's read-only git runner; colours are the Osiris palette; the groups (Active now / Dirty / Recent / Stale over 7 days) are Osiris's own.
