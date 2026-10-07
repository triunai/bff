/**
 * The ONE place Osiris colours are defined. Components reference `var(--oi-*)` only;
 * ui-tokens.test.ts fails on any raw colour literal outside this file.
 *
 * Meaning (owner rule):
 *   muted      grey   inactive / metadata
 *   info       blue   selected / informational
 *   running    cyan   in progress
 *   success    green  ONLY evidence-backed success (a recorded outcome)
 *   attention  amber  needs a look / unknown (unknown must never look like an error)
 *   failure    red    real failure
 */
export const TONES = {
  muted: "muted",
  info: "info",
  running: "running",
  success: "success",
  attention: "attention",
  failure: "failure",
} as const;

export type Tone = keyof typeof TONES;

/** --oi-kind-*: calendar event kinds, owner 01:13 ("commits red badge with red wording", decisions amber, log
 * translucent, threads done green). Calendar KIND identity, not outcome — the pills are always tinted fills, never solid.
 * --oi-lane-0..7: commit-graph branch lanes (W-193c). Hue only identifies a lane; it carries no outcome meaning, so the
 * status tones stay reserved for outcomes. */
export const tokenCss = `.oi-root,[data-bb-portaled-overlay]{--oi-bg:var(--background,Canvas);--oi-panel:var(--sidebar,var(--background,Canvas));--oi-border:var(--border,color-mix(in srgb,CanvasText 16%,Canvas));--oi-text:var(--foreground,CanvasText);--oi-hover:color-mix(in srgb,var(--oi-text) 4%,transparent);--oi-tone-muted:var(--muted-foreground,color-mix(in srgb,CanvasText 58%,Canvas));--oi-tone-info:var(--primary,light-dark(#2f6f86,#6fb1c7));--oi-tone-running:light-dark(#0e7490,#5fd0e6);--oi-tone-success:light-dark(#377752,#88bfa5);--oi-tone-attention:light-dark(#8b661b,#dabb77);--oi-tone-failure:var(--destructive,light-dark(#ac3d4a,#e99199));--oi-kind-commit:var(--oi-tone-failure);--oi-kind-decision:var(--oi-tone-attention);--oi-kind-log:var(--oi-tone-muted);--oi-kind-thread-done:var(--oi-tone-success);--oi-kind-spend:var(--oi-tone-running);--oi-lane-0:light-dark(#3b6fb6,#6fa8f0);--oi-lane-1:light-dark(#2f8a6f,#5ccfa6);--oi-lane-2:light-dark(#9a5bb8,#c99ae6);--oi-lane-3:light-dark(#b8742a,#f0b36a);--oi-lane-4:light-dark(#2a8fa6,#62cde3);--oi-lane-5:light-dark(#b2486a,#ec8aa8);--oi-lane-6:light-dark(#6f7f2a,#b8cc62);--oi-lane-7:light-dark(#5a62c4,#9aa2f2);--oi-selected:color-mix(in srgb,var(--oi-tone-info) 10%,transparent);--oi-shadow:light-dark(#00000022,#00000066);--oi-scrim:light-dark(#00000099,#000000b3);--oi-muted:var(--oi-tone-muted);--oi-accent:var(--oi-tone-info);--oi-error:var(--oi-tone-failure);--oi-warning:var(--oi-tone-attention);}`;

/** Map a call/problem status to a tone. Success requires a recorded "success" outcome. */
export function toneForStatus(status: string, opts: { slow?: boolean; missingTiming?: boolean } = {}): Tone {
  const s = String(status ?? "").toLowerCase();
  if (s === "error" || s === "denied" || s === "failed") return "failure";
  if (s === "unknown" || s === "cancelled" || s === "canceled") return "attention";
  if (s === "running") return "running";
  if (s === "success") return opts.slow || opts.missingTiming ? "attention" : "success";
  if (opts.slow || opts.missingTiming) return "attention";
  return "muted";
}
