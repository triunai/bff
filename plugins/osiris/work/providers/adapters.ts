// Server-side half of the provider adapters: the transcript parsers, WRAPPED from the existing readers (no parser is duplicated here).
// Keyed by `Record<ProviderId, ...>` so adding an id to registry.ts fails to compile until its parser is registered.
import { parseUsageLines } from "../../cache-economics.ts";
import { parseCodexHead } from "../codex-feed.ts";
import { parseGeminiHead } from "./gemini-feed.ts";
import { PROVIDERS } from "./registry.ts";
import type { ProviderId, ProviderMeta } from "./registry.ts";

/** Each provider's transcript parser: Claude = per-request usage rows, Codex / Gemini = the whitelisted session header. */
export const PARSERS: Readonly<Record<ProviderId, (...a: never[]) => unknown>> = {
  claude: parseUsageLines as (...a: never[]) => unknown,
  codex: parseCodexHead as (...a: never[]) => unknown,
  gemini: parseGeminiHead as (...a: never[]) => unknown,
};
export type ProviderAdapter = ProviderMeta & { parse: (typeof PARSERS)[ProviderId] };
/** The full adapters: registry metadata + parser. */
export const ADAPTERS: readonly ProviderAdapter[] = PROVIDERS.map(p => ({ ...p, parse: PARSERS[p.id] }));
