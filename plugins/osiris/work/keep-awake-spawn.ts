// The ONE caffeinate spawner (td-osi.12): through the trusted-bin primitive (D-139), which re-vets the root-owned program on every spawn, runs it with an argv ARRAY (no shell),
// no stdio capture and the minimal env. The caller (server.ts) hands it only the path resolveRootBin validated and keep-awake.ts's fixed argv; the child ends itself after -t seconds.
import {trustedSpawnChild} from "./trusted-bin.ts";
import type {AwakeChild} from "./keep-awake.ts";

export function spawnCaffeinate(bin: string, argv: readonly string[]): AwakeChild {
  const r = trustedSpawnChild(bin, argv, {trust: {rootOnly: true}});
  if (!r.ok) throw new Error(`caffeinate refused: ${r.reason}`);
  const c = r.child;
  c.on("error", () => {});
  return {kill: () => { c.kill(); }, onExit: cb => { c.once("exit", cb); }};
}
