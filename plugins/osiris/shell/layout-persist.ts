// Persistence boundary for the shell layout: bb.storage.kv key `layout.v1` (server) with a localStorage cache (client). Both
// ends treat stored JSON as untrusted: size-bounded, parsed in a try, and run through normalize().
import type {Layout, PanelDef} from "./layout-types.ts";
import {normalize} from "./layout-model.ts";

export const LAYOUT_KV_KEY = "layout.v1";
export const LAYOUT_LS_KEY = "osiris-layout.v1";
export const MAX_LAYOUT_BYTES = 64 * 1024;

/** JSON for a layout, or null when it would exceed the bound (nothing oversized is ever written). */
export function encodeLayout(layout: unknown): string | null {
  let json: string | undefined;
  try { json = JSON.stringify(layout); } catch { return null; }
  return typeof json === "string" && json.length <= MAX_LAYOUT_BYTES ? json : null;
}

/** A normalised Layout from stored text, or null when there is nothing usable (caller falls back to the default). */
export function decodeLayout(raw: string | null | undefined, registry: readonly PanelDef[]): Layout | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LAYOUT_BYTES) return null;
  try { return normalize(JSON.parse(raw), registry); } catch { return null; }
}

/** The saved form of a layout: everything except focus memory. Focus changes on every click, and must never mark the layout
 * changed or trigger a server write (review W-2B M4). */
export const saveKey = (layout: Layout): string => JSON.stringify({...layout, focus: null});

/** Should a change from `prev` to `next` be written? Only when something other than focus memory differs. */
export const shouldSave = (prev: Layout, next: Layout): boolean => prev !== next && saveKey(prev) !== saveKey(next);

/** Home is the landing view: every launch opens it in the centre (stacked beside the terminal, never replacing it). A Home the person moved to
 *  another slot is left alone. Pure; the result is only saved if the person then changes something (shouldSave). */
export const LANDING_PANEL = "home";
export const landOnHome = (layout: Layout): Layout => {
  const at = (["left", "centre", "right", "bottom"] as const).find(s => layout.slots[s].panels.includes(LANDING_PANEL));
  if (at && at !== "centre") return layout;
  const c = layout.slots.centre;
  if (at && c.active === LANDING_PANEL) return layout;
  return {...layout, slots: {...layout.slots, centre: {panels: at ? c.panels : [...c.panels, LANDING_PANEL], active: LANDING_PANEL}}};
};
/** A layout just read from storage: zen is a session mood, never restored (review W-2B L2); Home is the landing view. */
export const loadedLayout = (layout: Layout): Layout => landOnHome(layout.view.zen ? {...layout, view: {...layout.view, zen: false}} : layout);

export type LayoutKv = {get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>};
export type LayoutGetResult = {ok: true; layout: Layout | null};
export type LayoutSetResult = {ok: true} | {ok: false; reason: string};

export async function layoutGetImpl(kv: LayoutKv, registry: readonly PanelDef[]): Promise<LayoutGetResult> {
  const stored = await kv.get<unknown>(LAYOUT_KV_KEY);
  if (stored === undefined || stored === null) return {ok: true, layout: null};
  const text = encodeLayout(stored);
  return {ok: true, layout: text ? normalize(JSON.parse(text), registry) : null};
}

export async function layoutSetImpl(kv: LayoutKv, registry: readonly PanelDef[], raw: unknown): Promise<LayoutSetResult> {
  const text = encodeLayout(raw);
  if (text === null) return {ok: false, reason: `layout too large (limit ${MAX_LAYOUT_BYTES} bytes) or not JSON`};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as {version?: unknown}).version !== 1) return {ok: false, reason: "not a version 1 layout"};
  await kv.set(LAYOUT_KV_KEY, normalize(parsed, registry));
  return {ok: true};
}
