// Loop / flip-flop / unverified detection over the osiris-bridge feed's HASH rows. Pure: no I/O, no clock.
// Nothing here ever sees a command, path or edit text: the bridge emits salted hashes only (D-135, D-140).
//
// The three rules and their thresholds are ported from receipt
// (https://github.com/hoobnn/agent-mods @ 60ee5dde9d92aa6496a611b8611a78d736ab8ed2, claude-code/receipt/hooks/ledger.ts: watchCall, addCall),
// MIT, (c) 2026 hoobnn. Licence text: third_party/receipt-LICENSE.txt. Adapted: operates on hashes, per lane, replayed from feed rows.
import type { FeedRow } from "../mod-feed.ts";

/** The same call failing this many times in a row with nothing changed between. */
export const REPEAT_FAILURES = 3;
/** An edit that puts back what an earlier edit took out of the same file, this many times. */
export const FLIP_FLOPS = 2;
/** Edit pairs remembered per file for the flip rule. */
const KEEP_EDITS = 20;
/** Lanes returned (newest first); the feed tail is bounded anyway. */
export const MAX_LANES = 200;

export interface LaneSignal {
    /** The lane's join key: a subagent's agentId, else the session id. Same key as FleetLane.key. */
    lane: string;
    /** Current failing streak of one identical call (>= REPEAT_FAILURES means looping). 0 when none. */
    repeat: number;
    /** Most flip-flops on any one file. */
    flips: number;
    /** Code edited after the last check (test, build, lint), or edited and never checked. */
    unverified: boolean;
    looping: boolean;
    lastTs: number;
}

interface State { failKey: string | null; failCount: number; edits: Map<string, [string, string][]>; flips: Map<string, number>; maxFlips: number; unverified: boolean; lastTs: number }
const fresh = (): State => ({ failKey: null, failCount: 0, edits: new Map(), flips: new Map(), maxFlips: 0, unverified: false, lastTs: 0 });

/** Feed one tool row into a lane's state. Row order must be chronological. */
export function step(st: State, r: Extract<FeedRow, { kind: "tool" }>): void {
    st.lastTs = r.ts;
    if (r.outcome === "denied" || !r.h) return; // a denied call never ran; a pre-signal row carries nothing to compare
    const failed = r.outcome === "error";
    const edited = !failed && !!r.ed;
    const changed = edited || (!failed && r.mut === true);
    if (failed) {
        st.failCount = st.failKey === r.h ? st.failCount + 1 : 1;
        st.failKey = r.h;
    } else if (changed || r.h === st.failKey) {
        st.failKey = null;
        st.failCount = 0;
    }
    if (r.ed) {
        if (!failed) {
            const before = st.edits.get(r.ed.p) ?? [];
            const isFlip = r.ed.pairs.some(([f, t]) => f !== t && before.some(([bf, bt]) => bf === t && bt === f));
            const n = (st.flips.get(r.ed.p) ?? 0) + (isFlip ? 1 : 0);
            st.flips.set(r.ed.p, n);
            st.maxFlips = Math.max(st.maxFlips, n);
            st.edits.set(r.ed.p, [...before, ...r.ed.pairs].slice(-KEEP_EDITS));
            if (r.ed.code) st.unverified = true;
        }
    }
    // A check that ran counts whatever it found: its failure is its own signal.
    if (r.chk) st.unverified = false;
}

/** Replay rows (chronological) into per-lane signals; only lanes with something to say are returned, newest first. */
export function laneSignals(rows: readonly FeedRow[]): LaneSignal[] {
    const lanes = new Map<string, State>();
    for (const r of rows) {
        if (r.kind !== "tool") continue;
        const key = r.agentId ?? r.sid;
        let st = lanes.get(key);
        if (!st) { st = fresh(); lanes.set(key, st); }
        step(st, r);
    }
    const out: LaneSignal[] = [];
    for (const [lane, st] of lanes) {
        const repeat = st.failCount, looping = repeat >= REPEAT_FAILURES || st.maxFlips >= FLIP_FLOPS;
        if (looping || st.unverified) out.push({ lane, repeat, flips: st.maxFlips, unverified: st.unverified, looping, lastTs: st.lastTs });
    }
    return out.sort((a, b) => b.lastTs - a.lastTs).slice(0, MAX_LANES);
}

/** Badge words for a lane (shape-backed in the UI, never colour alone). Null when the lane is clean. */
export function badgeOf(s: LaneSignal | undefined): { word: string; title: string } | null {
    if (!s) return null;
    if (s.looping) {
        const why = s.repeat >= REPEAT_FAILURES ? `the same call has failed ${s.repeat} times in a row with nothing changed in between` : `a file has been edited back and forth ${s.flips} times`;
        return { word: "looping", title: `Looping: ${why}. Detected from call fingerprints; no command or file text is read.` };
    }
    if (s.unverified) return { word: "unverified", title: "Code was edited after the last test, build or lint (or none ran). Detected from call fingerprints; prose-only edits do not count." };
    return null;
}
