// Demo mode, browser side. The server holds the real switch (demo/serve.ts answers every RPC from the fixture while it is ON);
// this is the visual mirror: the badge, the View-menu label and the disabled action buttons read it. Nothing here is persisted.
import { useSyncExternalStore } from "react";
import { DEMO_OFF } from "./constants.ts";

export { DEMO_OFF } from "./constants.ts";
let on = false;
const subs = new Set<() => void>();
export const demoOn = (): boolean => on;
export function setDemoLocal(next: boolean): void { if (next === on) return; on = next; subs.forEach(f => f()); }
export const useDemoOn = (): boolean => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => on, () => false);
/** The tooltip for an action button: the demo reason while demo is ON, else whatever the button said before (null = none). */
export const demoTitle = (demo: boolean, otherwise: string | null | undefined): string | undefined => (demo ? DEMO_OFF : otherwise ?? undefined);

type DemoCaller = { call(name: "demoState", args: Record<string, never>): Promise<unknown>; call(name: "demoSet", args: { on: boolean }): Promise<unknown> };
/** Ask the server whether demo is on (it survives a client reload) and mirror the answer. */
export async function syncDemo(rpc: DemoCaller): Promise<void> { try { setDemoLocal((await rpc.call("demoState", {}) as { on?: boolean } | null)?.on === true); } catch { /* an older server without demo: stay off */ } }
export async function setDemo(rpc: DemoCaller, next: boolean): Promise<void> { try { setDemoLocal((await rpc.call("demoSet", { on: next }) as { on?: boolean } | null)?.on === true); } catch { /* stays as it was */ } }
