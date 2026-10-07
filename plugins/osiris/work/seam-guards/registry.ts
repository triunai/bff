// The ONE registry of seam guards, and the ONE runner. Fail closed: a guard that throws, times out or answers something that is not a
// GuardResult is a CRIT, never ok. Guards run on load, every SEAM_PERIOD_MS and on relevant events (the client calls on each).
import { buildIdentityGuard, dispatchTargetGuard, gitRepoGuard, keepAwakeGuard, telemetrySealingGuard, trackerIdentityGuard, transcriptSourcesGuard } from "./guards.ts";
import { herdrSessionGuard } from "./herdr-session.ts";
import type { GuardCtx, GuardEntry, GuardResult, SeamGuard, SeamReport } from "./types.ts";

export const SEAM_PERIOD_MS = 60_000;
export const GUARD_TIMEOUT_MS = 5_000;

export const SEAM_GUARDS: SeamGuard[] = [trackerIdentityGuard, buildIdentityGuard, transcriptSourcesGuard, gitRepoGuard, keepAwakeGuard, dispatchTargetGuard, telemetrySealingGuard, herdrSessionGuard];

const failed = (g: SeamGuard, why: string): GuardResult => ({ ok: false, severity: "crit", what: `The guard for "${g.seam}" could not run`, why, fix: "Treat this seam as broken until the guard runs again; check the plugin log and reload Osiris." });
/** A reader's error text can carry a path or a token: keep a short, single-line, home-redacted form. */
const brief = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\/Users\/[^/\s]+/g, "~").replace(/\s+/g, " ").slice(0, 120);
const isResult = (r: unknown): r is GuardResult => { const x = r as GuardResult | null; return !!x && typeof x === "object" && (x.ok === true || (x.ok === false && (x.severity === "crit" || x.severity === "warn") && typeof x.what === "string" && typeof x.why === "string" && typeof x.fix === "string")); };

async function runOne(g: SeamGuard, ctx: GuardCtx, timeoutMs: number): Promise<GuardEntry> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GuardResult>(res => { timer = setTimeout(() => res(failed(g, `it did not answer within ${timeoutMs} ms`)), timeoutMs); });
  try {
    const r = await Promise.race([Promise.resolve().then(() => g.run(ctx)), timeout]);
    return { id: g.id, seam: g.seam, result: isResult(r) ? r : failed(g, "it returned something that is not a guard result") };
  } catch (e) { return { id: g.id, seam: g.seam, result: failed(g, `it threw: ${brief(e)}`) }; }
  finally { if (timer) clearTimeout(timer); }
}

export async function runGuards(ctx: GuardCtx, guards: readonly SeamGuard[] = SEAM_GUARDS, opts: { timeoutMs?: number } = {}): Promise<SeamReport> {
  const timeoutMs = opts.timeoutMs ?? GUARD_TIMEOUT_MS;
  return { at: ctx.now(), entries: await Promise.all(guards.map(g => runOne(g, ctx, timeoutMs))) };
}
