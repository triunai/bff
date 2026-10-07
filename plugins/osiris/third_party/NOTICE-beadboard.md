# BeadBoard graph port (MIT)

Source: https://github.com/zenchantlive/beadboard clone at commit `9e3059dbb7c2e907cef79b5fa68d51f8cb390457` (7 chars: `9e3059d`).
Licence: MIT, full text in `third_party/beadboard-LICENSE.txt`. Every ported file carries an attribution header naming its BeadBoard file.

| BeadBoard file | Osiris file | Change |
| --- | --- | --- |
| `src/lib/types.ts` | `work/graph/types.ts` | BeadIssue SUBSET (fields the graph reads) |
| `src/lib/epic-graph.ts` | `work/graph/epic-graph.ts` | verbatim; import paths only |
| `src/lib/graph.ts` | `work/graph/graph.ts` | verbatim; import paths only |
| `src/lib/graph-view.ts` | `work/graph/graph-view.ts` | verbatim; import paths only |
| `src/hooks/use-graph-analysis.ts` | `work/graph/graph-analysis.ts` | pure core `analyzeGraph` (no useMemo); `issues.find` became a Map lookup |
| `src/components/graph/offset-edge.tsx` | `components/work/graph/offset-edge.tsx` | verbatim; React import style |
| `src/components/graph/graph-node-card.tsx` | `components/work/graph/graph-node-card.tsx` | removed the 3 `/api/swarm/prep` fetches, radix assign dropdown, lucide icons, action buttons; Tailwind -> `oi-wg-*`; added stage pill, wave chip, change motion |
| `src/components/shared/workflow-graph.tsx` | `components/work/graph/workflow-graph.tsx` | Tailwind and hex/rgba -> `oi-wg-*` and `var(--oi-*)`; labels "blocks"/"part of"; plain legend; swarm/archetype props removed; layout memoised on structure |

Osiris-only (not BeadBoard code): `work/graph/adapter.ts` (maps WorkIssue/WorkDep to BeadIssue), `work/graph/overlay.ts`, `components/work/graph/graph-tab.tsx`, `graph-side-panel.tsx`, `graph-styles.ts`.
Not ported: swarm/assignment, drawers, dependency-flow-strip, smart-dag, task-card-grid.
