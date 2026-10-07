import type { ReactNode } from "react";
import type { PaneTail, WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import type { WorkPanelId } from "../../work/panel-ids.ts";
import { BeadTree, beadTreeStyles } from "./bead-tree.tsx";
import { GraphTab } from "./graph/graph-tab.tsx";
import { BoardView, boardViewStyles } from "./board-view.tsx";
import { FactoryView, factoryViewStyles } from "./factory-view.tsx";
import { FactoryFloor, factoryFloorStyles } from "./factory-floor.tsx";
import { DecisionsPanel, decisionsPanelStyles } from "./decisions-panel.tsx";
import { SidebarBottom, sidebarBottomStyles, type SidebarBottomProps } from "./sidebar-bottom.tsx";
import { beadGraphStyles } from "./graph/graph-styles.ts";
import { timeScrubberStyles } from "./time-scrubber.tsx";

/** What the shell hands every Work panel. `snap` is null while no tracker is chosen or it is still being read. */
export type WorkPanelCtx = {
  snap: WorkSurfaceSnapshot | null; now: number; selectedId: string | null; onSelect(id: string): void;
  /** Only `sidebar.bottom` reads this. */
  sidebarBottom?: SidebarBottomProps;
  /** Only `work.factory` reads this: true shows the classic Factory, otherwise the new FactoryFloor. */
  classicFactory?: boolean;
  /** Only `work.tree` reads this: the selected bead's pane tail (app.tsx reads it while a bead inspector is on screen). */
  treeTail?: PaneTail | null;
  /** Only `work.factory` reads these (useWorkTelemetry). Null or absent means "not connected": the legend says so rather than showing zeros. */
  costs?: ReadonlyMap<string, number> | null;
  critical?: ReadonlySet<string> | null;
  transcriptLive?: ReadonlyMap<string, { lane: string; lastAt: number }> | null;
  /** Only `work.factory` reads these: the archive vault opens the Archive view; the shell's pending Mod+K chord start. */
  onOpenArchive?(ids: readonly string[]): void;
  chordAt?(): number | null;
};

const needTracker = (what: string) => <p className="oi-note oi-wp-note">{what}</p>;
const withSnap = (c: WorkPanelCtx, render: (s: WorkSurfaceSnapshot) => ReactNode): ReactNode => (c.snap ? <div className="oi-wp">{render(c.snap)}</div> : needTracker("Choose a tracker to see this."));

/** ONE render map, typed over WORK_PANEL_IDS: adding an id there without a renderer here is a compile error, and a test pins the registry both ways. */
const RENDER: Record<WorkPanelId, (c: WorkPanelCtx) => ReactNode> = {
  "work.tree": c => withSnap(c, s => <BeadTree snap={s} now={c.now} selectedId={c.selectedId} tail={c.treeTail ?? null} onSelect={c.onSelect} />),
  "work.graph": c => withSnap(c, s => <GraphTab snap={s} now={c.now} selectedId={c.selectedId} onSelect={c.onSelect} />),
  "work.board": c => withSnap(c, s => <BoardView snap={s} now={c.now} selectedId={c.selectedId} onSelect={c.onSelect} />),
  "work.factory": c => withSnap(c, s => c.classicFactory ? <FactoryView snap={s} now={c.now} selectedId={c.selectedId} onSelect={c.onSelect} /> : <FactoryFloor snap={s} now={c.now} selectedId={c.selectedId} onSelect={c.onSelect} costs={c.costs ?? null} critical={c.critical ?? null} transcriptLive={c.transcriptLive ?? null} onOpenArchive={c.onOpenArchive} chordAt={c.chordAt} />),
  "work.decisions": c => withSnap(c, s => <DecisionsPanel snap={s} now={c.now} onSelect={c.onSelect} />),
  "sidebar.bottom": c => <SidebarBottom nextUp={null} {...c.sidebarBottom} snap={c.sidebarBottom?.snap ?? c.snap} now={c.sidebarBottom?.now ?? c.now} selectedId={c.sidebarBottom?.selectedId ?? c.selectedId} onSelectBead={c.sidebarBottom?.onSelectBead ?? c.onSelect} />,
};

/** The shell's Work panels (Graph, Board, Factory, Decisions, sidebar bottom). Null for any other id, so the shell falls through to its own renderers. */
export function renderWorkPanel(id: string, ctx: WorkPanelCtx): ReactNode | null {
  const r = (RENDER as Record<string, ((c: WorkPanelCtx) => ReactNode) | undefined>)[id];
  return r ? r(ctx) : null;
}

export const workPanelStyles = beadTreeStyles + boardViewStyles + factoryViewStyles + factoryFloorStyles + decisionsPanelStyles + beadGraphStyles + timeScrubberStyles + sidebarBottomStyles + `
.oi-wp{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;overflow:auto}
.oi-wp-note{padding:8px}
`;
