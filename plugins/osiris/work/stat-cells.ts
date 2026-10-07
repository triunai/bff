// The Factory's stat row (pure, data): one table of cells with a short one-line label and the full label (tooltip), the
// container width below which the row wraps into two rows, and the sizes the CSS uses, so a test can check that every
// label and the sparkline fit their cell at real panel widths (720 / 1200 / 1750 px) without a browser.
export type StatCellId = "mode" | "landed" | "ready" | "build" | "review" | "agents" | "wip" | "perHour" | "spent" | "sentBack" | "locks";
export const STAT_CELLS: readonly { id: StatCellId; short: string; full: string }[] = [
  { id: "mode", short: "Mode", full: "Mode: live, catching up, replay or paused" },
  { id: "landed", short: "Landed today", full: "Landed today (since local midnight); the bars are landings per hour over the last 10 hours" },
  { id: "ready", short: "Ready", full: "Ready for an agent: open, and every blocker is done" },
  { id: "build", short: "Build", full: "Being built (Claim + Build)" },
  { id: "review", short: "Review", full: "Waiting for or in review (Gate)" },
  { id: "agents", short: "Agents", full: "Agents working: an open agent terminal, or a transcript written in the last 5 min" },
  { id: "wip", short: "WIP", full: "Work in progress: Claim + Build + Gate" },
  { id: "perHour", short: "Per hour", full: "Landings per hour" },
  { id: "spent", short: "Spent", full: "Cost so far across the agents shown (only when cost is connected)" },
  // "Seen": the count is what this view watched happen. It cannot be rebuilt from history, because review has no history
  // (replay.ts:4), so a trail never passes the Gate before now (FAC-2).
  { id: "sentBack", short: "Sent back", full: "Sent back from review while this view was open (review history is not recorded, so earlier ones are not counted)" },
  { id: "locks", short: "Locks", full: "Active locks (waiting on another work item, on files, or for a free reviewer) and the oldest one's age" },
];
/** Container width at or below which the strip wraps into two rows of six (a container query, not the viewport). */
export const STAT_WRAP_PX = 1100;
/** CSS sizes the fit check relies on: cell padding (both sides), caption character width (11px uppercase + .06em tracking measures ~8px; 9 leaves margin for host fonts,
 * system UI; a generous estimate), and the sparkline's widest size. */
export const STAT = { PAD_X: 12, CAPTION_PX: 8, SPARK_MAX: 56, SPARK_MIN: 40 } as const;
export const statColumns = (containerPx: number) => (containerPx <= STAT_WRAP_PX ? 6 : STAT_CELLS.length);
/** Inner width of one cell at a container width. */
export const cellInner = (containerPx: number) => Math.floor(containerPx / statColumns(containerPx)) - STAT.PAD_X;
/** Estimated width of a caption. */
export const captionPx = (label: string) => Math.ceil(label.length * STAT.CAPTION_PX);
/** The sparkline's drawn width in a cell: the cell's inner width, capped at SPARK_MAX (it never spills into the next cell). */
export const sparkPx = (containerPx: number) => Math.min(STAT.SPARK_MAX, cellInner(containerPx));
