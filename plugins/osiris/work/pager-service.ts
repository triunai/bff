// Pager service (build8 lane F): one tick = read the fleet + seam state the server already computes, run the pure core, write the
// local outbox, and (only when a channel is configured) hand the page to the sender. Every dependency is injected, so the tests
// drive it with fakes: no clock, no network, no real BB.
// DISABLED BY DEFAULT: `enabled` false means a tick reads nothing and writes nothing. Enabled with no channel = outbox file only.
import { appendOutbox, ntfySender, scrubPageText, telegramSender, type FetchLike, type PagerSender } from "./pager-senders.ts";
import { evaluatePager, initialPagerState, PAGER_DEFAULTS, type PagerConfig, type PagerInput, type PagerState } from "./pager.ts";

/** How often the service evaluates. One minute matches the seam guards; every trigger is edge-triggered, so a faster tick only adds reads. */
export const PAGER_TICK_MS = 60_000;
export type PagerChannel = "none" | "ntfy" | "telegram";
/** What the BB settings hold. Secrets (`ntfyAuth`, `telegramBotKey`) come from `secret: true` settings, never from plain config. */
export interface PagerSettings {
  enabled: boolean; channel: PagerChannel;
  ntfyServer?: string; ntfyTopic?: string; ntfyAuth?: string;
  telegramBotKey?: string; telegramChatId?: string;
  stallMin?: number; cooldownMin?: number; dailyCap?: number;
}
export interface PagerFleetFacts { live: number; needsYou: number; lanes: PagerInput["lanes"] }
/** The rate-limit memory that must survive a restart: cooldown stamps and the day's count. Without it a crash-looping BB re-arms the cap each start. */
export interface PagerRateMemo { lastSent: PagerState["lastSent"]; day: string; dayCount: number }
export interface PagerDeps {
  /** Durable rate memory (BB kv in production). Optional so a bare service still works; absent means a restart forgets the limits. */
  rate?: { load(): Promise<PagerRateMemo | null>; save(m: PagerRateMemo): Promise<void> };
  now(): number;
  /** null = the fleet could not be read this tick (skip; never page on a failed read). */
  fleet(): Promise<PagerFleetFacts | null> | PagerFleetFacts | null;
  /** Ids of crit seam guards. A throw counts as "unknown" and is treated as none (the seam guards page for themselves in the UI). */
  seamCrits(): Promise<string[]>;
  /** CI reader. Not wired yet (CI is billing-blocked and no reader exists): omit it and ci-red never fires. */
  ciRed?(): Promise<boolean | null>;
  settings(): Promise<PagerSettings>;
  fetch: FetchLike;
  outboxPath: string;
  log(line: string): void;
}

export const configOf = (s: PagerSettings): PagerConfig => ({
  stallMs: (s.stallMin ?? PAGER_DEFAULTS.stallMs / 60_000) * 60_000,
  quietMs: PAGER_DEFAULTS.quietMs,
  cooldownMs: Math.max(1, s.cooldownMin ?? PAGER_DEFAULTS.cooldownMs / 60_000) * 60_000,
  dailyCap: Math.max(0, Math.floor(s.dailyCap ?? PAGER_DEFAULTS.dailyCap)),
});

/** The sender for these settings, or null when the channel is "none" or its settings are incomplete or invalid. */
export function senderOf(s: PagerSettings, fetchFn: FetchLike): PagerSender | null {
  if (s.channel === "ntfy") return ntfySender({ server: s.ntfyServer ?? "", topic: s.ntfyTopic ?? "", auth: s.ntfyAuth || undefined }, fetchFn);
  if (s.channel === "telegram") return telegramSender({ botKey: s.telegramBotKey ?? "", chatId: s.telegramChatId ?? "" }, fetchFn);
  return null;
}

export function createPagerService(d: PagerDeps) {
  let state: PagerState = initialPagerState();
  let primed = false;
  return {
    state: () => state,
    /** One evaluation. Never throws. */
    async tick(): Promise<void> {
      try {
        const s = await d.settings();
        if (!s.enabled) { primed = false; state = initialPagerState(); return; } // off: read nothing, write nothing, forget everything
        const f = await d.fleet();
        if (!f) return;
        const [crits, ci] = await Promise.all([d.seamCrits().catch(() => [] as string[]), d.ciRed ? d.ciRed().catch(() => null) : Promise.resolve(null)]);
        const at = d.now();
        const res = evaluatePager(state, { at, needsYou: f.needsYou, live: f.live, lanes: f.lanes, seamCrits: crits, ciRed: ci }, configOf(s));
        if (!primed) {
          // First tick after (re-)enabling or a restart: learn what is ALREADY true so it does not page as if it just happened.
          // Rate limits are NOT part of what is learned: they come back from durable memory so a restart cannot re-arm the daily cap.
          primed = true;
          const memo = await d.rate?.load().catch(() => null);
          state = { ...res.state, lastSent: memo?.lastSent ?? {}, day: memo?.day ?? res.state.day, dayCount: memo?.dayCount ?? 0 };
          return;
        }
        state = res.state;
        const out = (e: Parameters<typeof appendOutbox>[1]) => { try { appendOutbox(d.outboxPath, e); } catch (err) { d.log(`pager: outbox write failed (${(err as Error)?.name ?? "error"})`); } };
        if (res.page) { try { await d.rate?.save({ lastSent: state.lastSent, day: state.day, dayCount: state.dayCount }); } catch { d.log("pager: could not persist rate limits"); } }
        for (const x of res.suppressed) out({ at, kind: "suppressed", triggers: [x.trigger], reason: x.reason, channel: s.channel, status: "local-only" });
        if (!res.page) return;
        const title = scrubPageText(res.page.title), text = scrubPageText(res.page.text);
        const sender = senderOf(s, d.fetch);
        if (s.channel === "none") { out({ at, kind: "page", triggers: res.page.triggers, title, text, channel: "none", status: "local-only" }); return; }
        if (!sender) { out({ at, kind: "page", triggers: res.page.triggers, title, text, channel: s.channel, status: "failed", error: "channel is not configured correctly" }); d.log(`pager: ${s.channel} is not configured correctly`); return; }
        const r = await sender.send({ title, text, urgent: res.page.triggers.includes("seam-red") || res.page.triggers.includes("ci-red") });
        out({ at, kind: "page", triggers: res.page.triggers, title, text, channel: s.channel, status: r.ok ? "sent" : "failed", ...(r.ok ? {} : { error: r.error }) });
        if (!r.ok) d.log(`pager: ${r.error}`);
      } catch (e) { try { d.log(`pager tick failed: ${(e as Error)?.name ?? "error"}`); } catch { /* a logger must not stop the service */ } }
    },
  };
}
