import { useState } from "react";
import { copyWithToast } from "../../work/copy-toast.ts";
import { errorCopyText } from "../../work/seam-guards/surface.ts";

/** The ONE "Copy" button for every error surface: copies "what · seam · why · fix" as plain text through the shared copyWithToast. */
export function CopyErrorButton({ what, seam, why, fix, className }: { what: string; seam: string; why: string; fix: string; className?: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  return <button type="button" className={className ?? "oi-err-copy"} aria-label={`Copy this error: ${what}`} onClick={() => { void copyWithToast(errorCopyText(what, seam, why, fix)).then(setDone); }}>{done === null ? "Copy" : done ? "Copied" : "Copy failed"}</button>;
}
