// Ported from BeadBoard (MIT, see third_party/beadboard-LICENSE.txt), src/hooks/use-graph-analysis.ts @ 9e3059d.
// The hook's pure core: the same derivations without useMemo (the component memoises the call). See third_party/NOTICE-beadboard.md.
import type { BeadIssue } from "./types.ts";
import { plainTitle, shortId } from "../surface-model.ts";
import { buildGraphModel, type GraphModel } from "./graph.ts";
import { analyzeBlockedChain, detectDependencyCycles, type BlockedChainAnalysis, type CycleAnomaly } from "./graph-view.ts";

export interface GraphAnalysis {
  graphModel: GraphModel;
  signalById: Map<string, { blockedBy: number; blocks: number }>;
  cycleAnalysis: CycleAnomaly;
  cycleNodeIdSet: Set<string>;
  actionableNodeIds: Set<string>;
  blockerTooltipMap: Map<string, string[]>;
  blockerAnalysis: BlockedChainAnalysis | null;
  chainNodeIds: Set<string>;
}

/** Plain wording for a tracker status (review W-1B M6: no raw `in_progress` in the UI). */
export const plainStatus = (s: string): string => ({ open: "not started", in_progress: "being built", blocked: "waiting", deferred: "put off", closed: "done", pinned: "being built", hooked: "being built" } as Record<string, string>)[s] ?? "waiting";
/** One "waiting on" line: `f6v.1 · being built · correct the stale docs` (short id, plain stage, jargon-free cleaned title). */
export const blockerLine = (b: Pick<BeadIssue, "id" | "status" | "title">): string => `${shortId(b.id)} · ${plainStatus(b.status)} · ${plainTitle(b.title)}`;

export function analyzeGraph(issues: BeadIssue[], projectRoot: string, selectedId: string | null | undefined): GraphAnalysis {
  const graphModel = buildGraphModel(issues, { projectKey: projectRoot });
  const byId = new Map(issues.map((i) => [i.id, i]));

  const signalById = new Map<string, { blockedBy: number; blocks: number }>();
  for (const issue of issues) {
    const adjacency = graphModel.adjacency[issue.id];
    signalById.set(issue.id, { blockedBy: adjacency?.incoming.length ?? 0, blocks: adjacency?.outgoing.length ?? 0 });
  }

  const cycleAnalysis = detectDependencyCycles(graphModel);
  const cycleNodeIdSet = new Set(cycleAnalysis.cycleNodeIds);

  const actionableNodeIds = new Set<string>();
  for (const issue of issues) {
    if (issue.status === "closed") continue;
    const adjacency = graphModel.adjacency[issue.id];
    if (!adjacency) continue;
    const hasOpenBlocker = adjacency.incoming.some((edge) => {
      if (edge.type !== "blocks") return false;
      const sourceNode = byId.get(edge.source);
      return sourceNode ? sourceNode.status !== "closed" : false;
    });
    if (!hasOpenBlocker) actionableNodeIds.add(issue.id);
  }

  const blockerTooltipMap = new Map<string, string[]>();
  for (const issue of issues) {
    const adjacency = graphModel.adjacency[issue.id];
    if (!adjacency) continue;
    const lines: string[] = [];
    for (const edge of adjacency.incoming) {
      if (edge.type !== "blocks") continue;
      const source = byId.get(edge.source);
      if (source && source.status !== "closed") lines.push(blockerLine(source));
    }
    blockerTooltipMap.set(issue.id, lines);
  }

  const blockerAnalysis = selectedId ? analyzeBlockedChain(graphModel, { focusId: selectedId }) : null;
  const chainNodeIds = !selectedId || !blockerAnalysis ? new Set<string>() : new Set<string>([selectedId, ...blockerAnalysis.blockerNodeIds]);

  return { graphModel, signalById, cycleAnalysis, cycleNodeIdSet, actionableNodeIds, blockerTooltipMap, blockerAnalysis, chainNodeIds };
}
