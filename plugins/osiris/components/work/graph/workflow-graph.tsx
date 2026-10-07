// Ported from BeadBoard (MIT, see third_party/beadboard-LICENSE.txt), src/components/shared/workflow-graph.tsx @ 9e3059d.
// Kept: layoutDagre, the edge styling rules (focus up/downstream, transitive dashes, animated in-progress edges), the offset
// grouping, the toolbar (Hierarchy, Horizontal/Vertical, Compact/Normal, Fit) and the ReactFlow wiring. Changed: Tailwind classes
// and hex/rgba colours became oi-wg-* classes and var(--oi-*) tokens; edge labels read "blocks" / "part of"; the legend is plain
// English; the lucide Fit icon is a text glyph; the swarm/assign/archetype props are gone; Osiris adds stage/motion/wave/ghost
// overlays, and the layout is memoised on structure so a stage change never re-lays-out the graph. See third_party/NOTICE-beadboard.md.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Background, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { BeadIssue } from "../../../work/graph/types.ts";
import { buildWorkflowEdges } from "../../../work/graph/epic-graph.ts";
import { cleanText } from "../../../work/sanitize.ts";
import { analyzeGraph } from "../../../work/graph/graph-analysis.ts";
import { identifyTransitiveEdges } from "../../../work/graph/graph-view.ts";
import { stageLabel, STAGES, type Stage } from "../../../work/replay.ts";
import type { Motion } from "../../../work/graph/overlay.ts";
import { layoutPositions, type LayoutDensity, type LayoutDirection } from "../../../work/graph/layout.ts";
import { GraphNodeCard, type GraphNodeData } from "./graph-node-card.tsx";
import { OffsetEdge } from "./offset-edge.tsx";

export interface WorkflowGraphProps {
  beads: BeadIssue[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  hideClosed?: boolean;
  /** Osiris overlays, all keyed by bead id. A bead missing from `stages` is a ghost (not created yet at the scrubbed time). */
  stages?: Map<string, Stage>;
  motion?: Map<string, { kind: Motion; tick: number }>;
  waves?: Map<string, number> | null;
  /** Extra toolbar controls (hide done, waves) rendered beside the ported ones. */
  extraControls?: ReactNode;
  /** Drawn inside the graph root (so it stays on top in fullscreen too): the empty-canvas note. */
  overlay?: ReactNode;
  /** Plain titles / short ids by id; fall back to the raw values. */
  plainTitles?: Map<string, string>;
  shortIds?: Map<string, string>;
  /** Bead ids to frame on first open (initialFocus); empty or missing = fit everything. */
  focusIds?: readonly string[];
  className?: string;
}

function layoutDagre(nodes: Node<GraphNodeData>[], edges: Edge[], direction: LayoutDirection, density: LayoutDensity): Node<GraphNodeData>[] {
  const pos = layoutPositions(nodes.map((n) => n.id), edges, direction, density); // the shared layout (work/graph/layout.ts)
  return nodes.map((node) => ({ ...node, position: pos.get(node.id)! }));
}

const tok = (n: string) => `var(--oi-${n})`;
const tint = (n: string, pct: number) => `color-mix(in srgb, var(--oi-${n}) ${pct}%, transparent)`;

function WorkflowGraphInner({ beads, selectedId, onSelect, hideClosed = false, stages, motion, waves = null, extraControls, overlay, plainTitles, shortIds, focusIds, className = "" }: WorkflowGraphProps) {
  const { fitView } = useReactFlow();
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>("LR");
  const [layoutDensity, setLayoutDensity] = useState<LayoutDensity>("normal");
  const [showHierarchy, setShowHierarchy] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<readonly string[] | undefined>(focusIds);
  focusRef.current = focusIds;

  // Use the extracted pure core for all graph analysis
  const { graphModel, signalById, cycleNodeIdSet, actionableNodeIds, blockerTooltipMap, blockerAnalysis, chainNodeIds } = useMemo(() => analyzeGraph(beads, "workflow", selectedId), [beads, selectedId]);

  const transitiveEdges = useMemo(() => identifyTransitiveEdges(graphModel), [graphModel]);

  // Structure: which nodes/edges are visible and how they are styled (no per-node overlay data in here).
  const structure = useMemo(() => {
    const visibleBeads = beads.filter((issue) => (!hideClosed ? true : issue.status !== "closed"));
    if (visibleBeads.length === 0) return { visible: [] as BeadIssue[], graphEdges: [] as Edge[] };

    const visibleIds = new Set(visibleBeads.map((b) => b.id));
    const edgeDescriptors = buildWorkflowEdges({ issues: beads, visibleIds, selectedId: selectedId ?? null, includeHierarchy: showHierarchy });

    const graphEdges: Edge[] = edgeDescriptors.map((edge) => {
      const isSubtask = edge.kind === "subtask";
      const label = isSubtask ? "part of" : "blocks";
      const isTransitive = transitiveEdges.has(`${edge.source}:blocks:${edge.target}`);

      let stroke = tok("tone-muted"); // default for subtasks / generic
      let strokeBg = tint("tone-muted", 30);
      let dashArray: string | undefined = undefined;
      let opacity = 0.78;

      const isFocusedPath = edge.isUpstreamOfFocus || edge.isDownstreamOfFocus || edge.isDirectlyFocused;
      const isAnimated = isFocusedPath || edge.sourceStatus === "in_progress";

      if (isSubtask) {
        stroke = isFocusedPath ? tok("text") : tok("tone-muted");
        strokeBg = isFocusedPath ? tint("text", 40) : tint("tone-muted", 30);
        dashArray = "6 4";
        opacity = isFocusedPath ? 1 : edge.isUnrelated ? 0.15 : 0.58;
      } else {
        // Evaluate Base Status
        if (edge.sourceStatus === "in_progress") { stroke = tok("tone-attention"); strokeBg = tint("tone-attention", 25); }
        else if (edge.sourceStatus === "blocked") { stroke = tok("tone-failure"); strokeBg = tint("tone-failure", 25); }
        else { stroke = tok("tone-info"); strokeBg = tint("tone-info", 25); }

        // Overrides for Selection
        if (selectedId) {
          if (edge.isUnrelated) { stroke = tok("border"); strokeBg = "transparent"; opacity = 0.15; }
          else if (edge.isUpstreamOfFocus || (edge.isDirectlyFocused && edge.target === selectedId)) { stroke = tok("tone-attention"); strokeBg = tint("tone-attention", 35); opacity = 1; }
          else if (edge.isDownstreamOfFocus || (edge.isDirectlyFocused && edge.source === selectedId)) { stroke = tok("tone-running"); strokeBg = tint("tone-running", 35); opacity = 1; }
        }

        // Transitive styling
        if (isTransitive) {
          dashArray = "4 4";
          if (!selectedId || edge.isUnrelated) { stroke = tok("border"); strokeBg = tint("border", 30); opacity = 0.4; }
          else opacity = 0.6; // Keep the focused color but make it dashed & slightly transparent
        }
      }

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        className: isFocusedPath ? "workflow-edge-selected" : "workflow-edge-muted",
        animated: isAnimated,
        label,
        labelStyle: { fill: tok("text"), fontSize: 11, fontWeight: 600 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 999,
        labelBgStyle: { fill: tok("panel"), stroke: strokeBg, strokeWidth: 1 },
        style: { stroke, strokeWidth: isFocusedPath ? 2.8 : 2.1, opacity, strokeDasharray: dashArray },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
      };
    });

    // --- Apply Offsets to Edge Data ---
    const edgeGroups = new Map<string, Edge[]>();
    for (const edge of graphEdges) {
      const key = [edge.source, edge.target].sort().join("-");
      if (!edgeGroups.has(key)) edgeGroups.set(key, []);
      edgeGroups.get(key)!.push(edge);
    }
    for (const groupEdges of edgeGroups.values()) {
      if (groupEdges.length <= 1) continue;
      // OffsetEdge handles adjusting the correct axis based on sourcePosition.
      const step = 8;
      const totalSpread = (groupEdges.length - 1) * step;
      let currentOffset = -(totalSpread / 2);
      for (const edge of groupEdges) { edge.data = { ...edge.data, offset: currentOffset }; currentOffset += step; }
    }
    return { visible: visibleBeads, graphEdges };
  }, [transitiveEdges, beads, hideClosed, selectedId, showHierarchy]);

  // Layout depends on ids + edge ids + direction + density ONLY, so a stage change (colour/pulse) never re-lays-out.
  const layoutKey = `${layoutDirection}|${layoutDensity}|${structure.visible.map((b) => b.id).join(",")}|${structure.graphEdges.map((e) => e.id).join(",")}`;
  const positions = useMemo(() => {
    const sourcePosition = layoutDirection === "TB" ? Position.Bottom : Position.Right;
    const targetPosition = layoutDirection === "TB" ? Position.Top : Position.Left;
    const stub = structure.visible.map((b): Node<GraphNodeData> => ({ id: b.id, data: {} as GraphNodeData, position: { x: 0, y: 0 }, sourcePosition, targetPosition, type: "flowNode" }));
    return layoutDagre(stub, structure.graphEdges, layoutDirection, layoutDensity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const flowNodes = useMemo(() => {
    const byId = new Map(structure.visible.map((b) => [b.id, b]));
    return positions.map((n): Node<GraphNodeData> => {
      const issue = byId.get(n.id)!;
      const stage = stages?.get(issue.id);
      const m = motion?.get(issue.id);
      return {
        ...n,
        selected: n.id === selectedId,
        data: {
          title: plainTitles?.get(issue.id) ?? issue.title,
          fullTitle: cleanText(issue.title),
          shortId: shortIds?.get(issue.id) ?? issue.id,
          kind: "issue",
          status: issue.status,
          priority: issue.priority,
          blockedBy: signalById.get(issue.id)?.blockedBy ?? 0,
          blocks: signalById.get(issue.id)?.blocks ?? 0,
          isActionable: actionableNodeIds.has(issue.id),
          isCycleNode: cycleNodeIdSet.has(issue.id),
          isDimmed: selectedId ? !chainNodeIds.has(issue.id) : false,
          blockerTooltipLines: blockerTooltipMap.get(issue.id) ?? [],
          stage: stage ?? "ready",
          ghost: stages ? stage === undefined : false,
          motion: m?.kind ?? null,
          motionTick: m ? m.tick % 2 : 0,
          wave: waves?.get(issue.id) ?? null,
          labels: issue.labels ?? [],
        },
      };
    });
  }, [positions, structure.visible, stages, motion, waves, plainTitles, shortIds, signalById, actionableNodeIds, cycleNodeIdSet, chainNodeIds, blockerTooltipMap, selectedId]);

  const nodeTypes: NodeTypes = useMemo(() => ({ flowNode: GraphNodeCard as NodeTypes["flowNode"] }), []);
  const edgeTypes = useMemo(() => ({ offset: OffsetEdge }), []);
  const defaultEdgeOptions = useMemo(() => ({ type: "offset" as const, zIndex: 40, interactionWidth: 24 }), []);

  const handleNodeClick = useCallback((_: MouseEvent, node: Node) => { onSelect?.(node.id); }, [onSelect]);

  // First open (and a layout or fullscreen change): frame the active and ready work at a readable zoom (floor 0.6), not everything tiny.
  // The user can still zoom out freely: the ReactFlow minZoom prop below is lower than this floor.
  const visibleIds = useMemo(() => new Set(structure.visible.map((b) => b.id)), [structure.visible]);
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;
  useEffect(() => {
    const timeout = setTimeout(() => {
      const ids = (focusRef.current ?? []).filter((id) => visibleRef.current.has(id));
      fitView({ ...(ids.length ? { nodes: ids.map((id) => ({ id })) } : {}), minZoom: ids.length ? 0.6 : 0.1, maxZoom: 1.2, padding: 0.2, duration: 200 });
    }, 50);
    return () => clearTimeout(timeout);
  }, [fitView, flowNodes.length, layoutDirection, layoutDensity, fullscreen]);

  useEffect(() => { if (fullscreen) rootRef.current?.focus(); }, [fullscreen]);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape" && fullscreen) { e.stopPropagation(); setFullscreen(false); } }, [fullscreen]);

  const handleFitToScreen = useCallback(() => { fitView({ padding: 0.24, duration: 240 }); }, [fitView]);
  const seg = (on: boolean) => `oi-wg-btn${on ? " on" : ""}`;

  return <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className={`oi-wg${fullscreen ? " oi-wg-full" : ""} ${className}`}>
    <div className="oi-wg-legend" aria-label="Legend">
      <span className="oi-wg-legend-h">Legend</span>
      {STAGES.slice().reverse().map((s) => <span key={s} className="oi-wg-legend-i"><i className={`oi-wg-dot oi-wg-s-${s}`} aria-hidden="true" />{stageLabel(s)}</span>)}
      <span className="oi-wg-legend-i" title="An arrow means the first bead must finish before the second can start"><svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="16" y2="4" stroke="currentColor" strokeWidth="2" /><path d="M15 1L21 4L15 7z" fill="currentColor" /></svg>blocks</span>
      <span className="oi-wg-legend-i" title="A dashed line joins a task to the larger piece of work it belongs to"><svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" /></svg>part of</span>
      {blockerAnalysis && <span className="oi-wg-legend-i">Open blockers: {blockerAnalysis.openBlockerCount}</span>}
    </div>
    <div className="oi-wg-tools">
      <div className="oi-wg-seg">
        <button type="button" className={seg(showHierarchy)} aria-pressed={showHierarchy} onClick={() => setShowHierarchy((c) => !c)} title="Show parent and child links">Parent links</button>
        <button type="button" className={seg(layoutDirection === "LR")} aria-pressed={layoutDirection === "LR"} onClick={() => setLayoutDirection("LR")}>Left to right</button>
        <button type="button" className={seg(layoutDirection === "TB")} aria-pressed={layoutDirection === "TB"} onClick={() => setLayoutDirection("TB")}>Top to bottom</button>
      </div>
      <div className="oi-wg-seg">
        <button type="button" className={seg(layoutDensity === "compact")} aria-pressed={layoutDensity === "compact"} onClick={() => setLayoutDensity("compact")}>Compact</button>
        <button type="button" className={seg(layoutDensity === "normal")} aria-pressed={layoutDensity === "normal"} onClick={() => setLayoutDensity("normal")}>Roomy</button>
      </div>
      {extraControls}
      <button type="button" className="oi-wg-btn" aria-pressed={fullscreen} onClick={() => setFullscreen((f) => !f)} title={fullscreen ? "Leave fullscreen (Esc)" : "Fill the whole window with the graph"}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
      <button type="button" className="oi-wg-btn oi-wg-fit" onClick={handleFitToScreen} aria-label="Fit graph to screen" title="Fit graph to screen">⤢ Fit</button>
    </div>
    <ReactFlow
      className="workflow-graph-flow"
      defaultEdgeOptions={defaultEdgeOptions}
      proOptions={{ hideAttribution: true }}
      minZoom={0.1}
      maxZoom={1.5}
      nodes={flowNodes}
      edges={structure.graphEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onlyRenderVisibleElements
      onNodeClick={handleNodeClick}
    >
      <Background gap={32} size={1} color="var(--oi-border)" />
    </ReactFlow>
    {overlay}
  </div>;
}

export function WorkflowGraph(props: WorkflowGraphProps) {
  return <ReactFlowProvider><WorkflowGraphInner {...props} /></ReactFlowProvider>;
}
