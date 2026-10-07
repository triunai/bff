import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkSurfaceSnapshot } from "../../../work/surface-types.ts";
import { historyFromTimestamps, plainTitle, shortId } from "../../../work/surface-model.ts";
import { scrubMarks, stagesAt, timeRange, type Stage } from "../../../work/replay.ts";
import { INITIAL_SCRUB, graphEmptyNote, graphNodesAt, scrubTime } from "../../../work/graph/graph-at.ts";
import { initialFocus } from "../../../work/graph/focus.ts";
import { toBeadIssues } from "../../../work/graph/adapter.ts";
import { motionFor, stageStatus, waveOverlay, type Motion } from "../../../work/graph/overlay.ts";
import { TimeScrubber } from "../time-scrubber.tsx";
import { WorkflowGraph } from "./workflow-graph.tsx";

const PULSE_MS = 1300;

/** The Work surface's GRAPH tab: the ported BeadBoard dependency graph, driven by the shared time scrubber. The scrubbed time sets each
 *  bead's stage (stagesAt); a stage change recolours (CSS transition) and pulses, and a stage going backwards in forward time bounces. */
export function GraphTab(props: { snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; onSelect(id: string): void }) {
  const { snap, now, selectedId, onSelect } = props;
  const [scrub, setScrub] = useState<number | null>(INITIAL_SCRUB.scrub); // null = follow "now"
  const [playing, setPlaying] = useState(INITIAL_SCRUB.playing);
  const [hideDone, setHideDone] = useState(false);
  const [showWaves, setShowWaves] = useState(false);
  const [motion, setMotion] = useState<Map<string, { kind: Motion; tick: number }>>(new Map());
  const prev = useRef<{ stages: Map<string, Stage>; t: number } | null>(null);
  const tick = useRef(0);

  const events = useMemo(() => historyFromTimestamps(snap), [snap]);
  const range = useMemo(() => timeRange(events, now), [events, now]);
  const marks = useMemo(() => scrubMarks(events), [events]);
  const t = scrubTime(scrub, now);
  const stages = useMemo(() => stagesAt(snap, events, t, now), [snap, events, t, now]);
  const base = useMemo(() => toBeadIssues(snap), [snap]);
  // Beads at the scrubbed time: BeadBoard's analysis reads `status`, so it is the stage's status; a not-yet-created bead stays a ghost.
  const beads = useMemo(() => base.map(b => { const s = stages.get(b.id); return s ? { ...b, status: stageStatus(s) } : { ...b, status: "open" as const }; }), [base, stages]);
  const titles = useMemo(() => new Map(snap.issues.map(i => [i.id, plainTitle(i.title)])), [snap]);
  const shorts = useMemo(() => new Map(snap.issues.map(i => [i.id, shortId(i.id)])), [snap]);
  const waves = useMemo(() => waveOverlay(snap), [snap]);
  const existing = useMemo(() => graphNodesAt(snap, events, t, now), [snap, events, t, now]);
  const shownCount = useMemo(() => hideDone ? beads.filter(b => b.status !== "closed").length : beads.length, [beads, hideDone]);
  const emptyNote = graphEmptyNote({ total: snap.issues.length, existing: existing.length, shown: existing.length === 0 && snap.issues.length > 0 ? 0 : shownCount, t, now, hideDone });
  const focusIds = useMemo(() => initialFocus(snap, now), [snap, now]);

  useEffect(() => {
    const before = prev.current;
    prev.current = { stages, t };
    if (!before) return;
    const next = new Map<string, { kind: Motion; tick: number }>();
    for (const [id, s] of stages) { const m = motionFor(before.stages.get(id), s, t >= before.t); if (m) next.set(id, { kind: m, tick: ++tick.current }); }
    if (!next.size) return;
    setMotion(next);
    const h = setTimeout(() => setMotion(new Map()), PULSE_MS);
    return () => clearTimeout(h);
  }, [stages, t]);

  const toggle = (on: boolean, set: (v: boolean) => void, label: string, title: string) => <button type="button" className={`oi-wg-btn${on ? " on" : ""}`} aria-pressed={on} title={title} onClick={() => set(!on)}>{label}</button>;
  const controls = <div className="oi-wg-seg">
    {toggle(hideDone, setHideDone, "Hide done", "Hide finished work")}
    {toggle(showWaves, setShowWaves, "Show waves", "Label each bead with the wave it can start in (Wave 1 can start now)")}
  </div>;

  return <div className="oi-wgt">
    <TimeScrubber t0={range.t0} t1={range.t1} value={t} playing={playing} marks={marks} onChange={v => setScrub(v >= range.t1 ? null : v)} onPlaying={setPlaying} />
    <div className="oi-wgt-body">
      <WorkflowGraph beads={beads} selectedId={selectedId ?? undefined} onSelect={onSelect} hideClosed={hideDone} stages={stages} motion={motion} waves={showWaves ? waves.waveOf : null} extraControls={controls} plainTitles={titles} shortIds={shorts} focusIds={focusIds} overlay={emptyNote ? <div className="oi-wgt-empty" role="status">{emptyNote}</div> : null} />
    </div>
    {showWaves && waves.unschedulable.length > 0 && <div className="oi-wgt-wave-note">
      <b>Can't be scheduled (loop)</b>{" "}these wait on each other, or on something that does:{" "}
      {waves.unschedulable.map(id => <code key={id} title={titles.get(id)}>{shortId(id)}</code>)}
    </div>}
  </div>;
}
