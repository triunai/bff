// Ported from BeadBoard (MIT, see third_party/beadboard-LICENSE.txt), src/components/graph/graph-node-card.tsx @ 9e3059d.
// Kept: the ReactFlow node shape, GraphNodeData fields (title/status/priority/blockedBy/blocks/isActionable/isCycleNode/isDimmed/
// blockerTooltipLines), the hover tooltip, the cycle ring and the dim rule. Removed: the three swarm-assignment fetch calls, the radix
// assign dropdown, lucide icons and every action button (selection only). Added: stage pill, wave chip, change motion. See third_party/NOTICE-beadboard.md.
import { useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { stageLabel, type Stage } from "../../../work/replay.ts";
import type { Motion } from "../../../work/graph/overlay.ts";
import type { BeadStatus } from "../../../work/graph/types.ts";
import { labelChips } from "../../../work/graph/focus.ts";

/** Data payload for each custom ReactFlow node. */
export interface GraphNodeData {
  /** Index signature required by ReactFlow's Node<Record<string, unknown>> constraint. */
  [key: string]: unknown;
  /** Plain title (jargon prefix stripped); the full title is `fullTitle`. */
  title: string;
  fullTitle: string;
  shortId: string;
  kind: "epic" | "issue";
  status: BeadStatus;
  priority: number;
  blockedBy: number;
  blocks: number;
  isActionable: boolean;
  isCycleNode: boolean;
  isDimmed: boolean;
  blockerTooltipLines: string[];
  // Osiris additions
  stage: Stage;
  /** Bead does not exist yet at the scrubbed time. */
  ghost: boolean;
  motion: Motion | null;
  /** Alternates 0/1 so the same animation can fire twice in a row. */
  motionTick: number;
  wave: number | null;
  labels: string[];
}

/** Custom ReactFlow node: stage-coloured card (the colour change transitions), a pulse when the stage changes, a bounce on rework. */
export function GraphNodeCard({ id, data, selected }: NodeProps<Node<GraphNodeData>>) {
  const [hovered, setHovered] = useState(false);
  const chips = labelChips(data.labels ?? []);
  const cls = ["oi-wg-card", `oi-wg-s-${data.stage}`, data.kind === "epic" ? "oi-wg-epic" : "", data.ghost ? "oi-wg-ghost" : "", data.isCycleNode ? "oi-wg-cycle" : "", data.isActionable && !selected && !data.ghost ? "oi-wg-actionable" : "", selected ? "oi-wg-selected" : "", data.isDimmed ? "oi-wg-dim" : "", data.motion ? `oi-wg-${data.motion}-${data.motionTick}` : ""].filter(Boolean).join(" ");
  return <div className="oi-wg-node" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <Handle type="target" position={Position.Left} className="oi-wg-handle" />
    <div className={cls} title={data.fullTitle} data-id={id} data-stage={data.stage}>
      <div className="oi-wg-head">
        <span className="oi-wg-id">{data.shortId}</span>
        <span className="oi-wg-head-r">
          {data.wave !== null && <span className="oi-wg-wave">Wave {data.wave}</span>}
          <span className="oi-wg-prio">P{data.priority}</span>
          <span className="oi-wg-pill">{data.ghost ? "Not created yet" : stageLabel(data.stage)}</span>
        </span>
      </div>
      <p className="oi-wg-title">{data.title}</p>
      {chips.chips.length > 0 && <div className="oi-wg-chips">{chips.chips.map(c => <span key={c.title} className="oi-wg-chip" title={c.title}>{c.text}</span>)}{chips.more > 0 && <span className="oi-wg-chip" title={`${chips.more} more label${chips.more === 1 ? "" : "s"}`}>+{chips.more}</span>}</div>}
      {data.blockerTooltipLines.length > 0 && !data.ghost && <div className="oi-wg-wait">
        <p className="oi-wg-wait-h">Waiting on</p>
        {data.blockerTooltipLines.slice(0, 2).map(l => <p key={l} className="oi-wg-wait-l">{l}</p>)}
        {data.blockerTooltipLines.length > 2 && <p className="oi-wg-wait-l">+{data.blockerTooltipLines.length - 2} more</p>}
      </div>}
    </div>
    {hovered && !data.ghost && <div className="oi-wg-tip" role="tooltip">
      {data.stage === "done"
        ? <p className="oi-wg-tip-h oi-wg-tip-ok">Done</p>
        : data.isActionable
        ? <><p className="oi-wg-tip-h oi-wg-tip-ok">Ready to start</p><p className="oi-wg-tip-b">Nothing open is blocking it. {data.blocks} task{data.blocks === 1 ? "" : "s"} {data.blocks === 1 ? "is" : "are"} waiting on this.</p></>
        : <><p className="oi-wg-tip-h oi-wg-tip-bad">Waiting on {data.blockedBy} task{data.blockedBy === 1 ? "" : "s"}</p>
          {data.blockerTooltipLines.length > 0 && <ul>{data.blockerTooltipLines.map(l => <li key={l}>{l}</li>)}</ul>}</>}
    </div>}
    <Handle type="source" position={Position.Right} className="oi-wg-handle" />
  </div>;
}
