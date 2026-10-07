// Runtime argv table for dispatch. PORTED from Mardi Gras (MIT, (c) 2025 Matt Wright; third_party/mardi-gras-LICENSE.txt):
// internal/agent/launch.go agentArgv (argv per runtime) and agentCommand (the binary is resolved to an ABSOLUTE path and
// resolution FAILS CLOSED: a missing binary is an error, never a silent bare-name fallback). Extended with model flags.
// NO runtime gets a force / yolo / skip-approvals flag: agents run in their default approval mode (pinned by security.test.ts).
import {isAbsolute} from "node:path";
import type {Runtime} from "./surface-types.ts";
import {detectLaunchPath} from "./providers/detect.ts";
import {isAllowedModel, MODEL_RE, RUNTIMES} from "./runtime-models.ts";

export type Which = (bin: string) => string | null;

/** The runtime CLI as an absolute path (the alias the user types) from the fixed trusted directories (providers/detect.ts, ADR D-139): NEVER a PATH lookup, so a planted `claude` cannot win. Null when absent or untrusted. */
export const defaultWhich: Which = (bin) => detectLaunchPath(bin);

export type ArgvResult = {ok: true; argv: string[]} | {ok: false; reason: string};
/** Build the launch argv. `model` null omits the model flag (runtime default). Binary resolution fails closed. */
export function buildArgv(rt: Runtime, o: {model: string | null; prompt: string; worktree: string; beadId: string}, which: Which = defaultWhich): ArgvResult {
  if (!RUNTIMES.includes(rt)) return {ok: false, reason: `unknown runtime: ${String(rt)}`};
  if (o.model !== null && !MODEL_RE.test(o.model)) return {ok: false, reason: "model id must match [A-Za-z0-9._:-]{1,64}"};
  if (!isAllowedModel(rt, o.model)) return {ok: false, reason: `model "${o.model}" is not in the allowed list for ${rt}`};
  if (rt === "stub") return {ok: true, argv: ["/bin/echo", "osiris-stub", o.beadId, o.model ?? "stub"]};
  const bin = which(rt);
  if (!bin || !isAbsolute(bin)) return {ok: false, reason: `${rt} not found in a trusted install directory (refusing a bare-name launch)`};
  const m = o.model;
  switch (rt) {
    case "claude": return {ok: true, argv: [bin, ...(m ? ["--model", m] : []), o.prompt]};
    case "codex": return {ok: true, argv: [bin, ...(m ? ["-m", m] : []), "--sandbox", "workspace-write", "-a", "on-request", "-C", o.worktree, o.prompt]};
    default: return {ok: true, argv: [bin, ...(m ? ["-m", m] : []), "-p", o.prompt]}; // cursor-agent: default approval mode, no force flag
  }
}
