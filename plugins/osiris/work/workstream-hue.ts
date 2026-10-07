// ONE per-workstream colour for every Factory view (Floor, Iso, tree rail, ON THE FLOOR rows). A bead takes the hue of its top-level
// parent (its epic / root workstream); the hue is picked from the 8 audited lane tokens (--oi-lane-0..7, AA on the dark surfaces,
// theme/audit.ts) by a stable hash of the PARENT ID, so the same epic is the same colour everywhere and does not shift when another
// epic appears or sorts above it (it used to be the index in a sorted list).
export const WORKSTREAM_HUES = 8;

/** FNV-1a over the parent id, folded onto the palette: deterministic across sessions, machines and views. */
export function workstreamTone(parentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < parentId.length; i++) { h ^= parentId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % WORKSTREAM_HUES;
}
/** The CSS colour for a tone index (the same `--oi-lane-N` the `.oi-ln-N` classes set). */
export const workstreamVar = (tone: number): string => `var(--oi-lane-${((tone % WORKSTREAM_HUES) + WORKSTREAM_HUES) % WORKSTREAM_HUES})`;
