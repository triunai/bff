import { useState, type RefObject } from "react";
import { copyWithToast } from "../../work/copy-toast.ts";
import { trackerPickerModel, type TrackerCandidate } from "../../work/first-run.ts";

/** First-run / no-tracker state of the Work picker: what Beads and Herdr are, a copyable `bd init`, a Pick a folder action (focuses the
 * existing path box, so the existing pin flow does the work) and any repo that already holds a tracker. */
export function TrackerEmpty({ trackers, onUse, onDemo, pathInput }: { trackers: readonly TrackerCandidate[]; onUse: (path: string) => void; /** Loads the synthetic demo board; shown only when the host wires it. */ onDemo?: () => void; pathInput: RefObject<HTMLInputElement | null> }) {
  const m = trackerPickerModel(trackers);
  const [copied, setCopied] = useState<"idle" | "ok" | "no">("idle");
  const copy = async () => { setCopied((await copyWithToast(m.initCommand)) ? "ok" : "no"); };
  return <div className="oi-first-run">
    {m.empty && <><p>{m.beadsLine}</p><p>{m.herdrLine}</p>
      <p className="oi-note">No tracker found yet. In a repo that has none, run this once, then pick the folder:</p>
      <div className="oi-first-run-cmd"><code>{m.initCommand}</code><button type="button" onClick={() => void copy()}>{copied === "ok" ? "Copied" : copied === "no" ? "Copy unavailable: select it" : "Copy"}</button></div></>}
    {!m.empty && <div className="oi-tracker-opts">{m.candidates.map(c => <button key={c.path} type="button" onClick={() => onUse(c.path)}>{c.label}</button>)}</div>}
    <button type="button" className="oi-first-run-pick" onClick={() => pathInput.current?.focus()}>{m.pickLabel}</button>
    {onDemo && <button type="button" className="oi-first-run-demo" title="Fill every view with made-up data. Nothing is read or written." onClick={onDemo}>Try the demo</button>}
  </div>;
}

export const trackerEmptyStyles = `
.oi-first-run{display:flex;flex-direction:column;gap:8px}.oi-first-run p{margin:0}
.oi-first-run-cmd{display:flex;gap:6px;align-items:center}.oi-first-run-cmd code{padding:2px 8px;border:1px solid var(--oi-border);border-radius:4px;user-select:all}
.oi-first-run button{border:1px solid var(--oi-border);border-radius:6px;padding:4px 10px;align-self:flex-start}
`;
