// Provider registry (browser-safe: no node imports): the ONE place that lists the agent providers Osiris reads (Claude, Codex, Gemini).
// Every other file derives from PROVIDERS / ProviderId (fitness pin: work/__tests__/provider-registry.test.ts). The server-side behaviour
// (transcript parsers) hangs off the same ids in adapters.ts, keyed by `Record<ProviderId, ...>` so the compiler forces completeness.
// An adapter is `{id, label, chip, binary, transcriptRoots, parse (adapters.ts), joinKey, price}`:
//   - joinKey names the per-call id a provider's transcript carries, so a call can be joined to its lane (Claude tool_use id,
//     Codex turn_id / response_id, Gemini toolCalls[].id).
//   - price returns null for "no price on file", never zero. Only Claude has a table; Codex and Gemini stay n/a until the owner
//     approves one with a source URL (D6).
import { priceFor } from "../../cache-economics.ts";
import type { Price } from "../../cache-economics.ts";

export const PROVIDER_IDS = ["claude", "codex", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** 2-letter mark drawn as a tinted chip (CL, CX, GM); the model letter goes next to it (CL·O, GM·P). */
  chip: string;
  /** The CLI program name looked up for "installed". */
  binary: string;
  /** Directories the transcripts live under; an empty result means the provider has no readable store on this machine. */
  transcriptRoots(home: string): string[];
  /** Which per-call id joins a call to its transcript lane. */
  joinKey: string;
  /** Extra flag (with its leading space) a dispatched pane passes so the CLI stays interactive after the prompt; gemini needs -i. */
  dispatchFlag: string;
  /** The flag that selects a model when dispatching (team dispatch). */
  modelFlag: string;
  /** Names a provider in free text (a Call.provider, a Herdr pane agent). */
  /** Model names the dispatch dialog offers as chips (first is the default). */
  models: readonly string[];
  match: RegExp;
  /** True when the reader was written from docs and fixtures only and has not seen a real install. */
  unverified: boolean;
  /** True when a price table exists (the UI says "$ n/a" otherwise). */
  priced: boolean;
  price(model: string | null): Price | null;
}

export const PROVIDERS: readonly ProviderMeta[] = [
  { id: "claude", label: "Claude", chip: "CL", binary: "claude", transcriptRoots: h => [`${h}/.claude/projects`], joinKey: "tool_use id", dispatchFlag: "", modelFlag: "--model", models: ["Sonnet", "Opus", "Haiku"], match: /claude/i, unverified: false, priced: true, price: priceFor },
  { id: "codex", label: "Codex", chip: "CX", binary: "codex", transcriptRoots: h => [`${h}/.codex/sessions`], joinKey: "turn_id / response_id", dispatchFlag: "", modelFlag: "-m", models: ["GPT-5.5", "gpt-5-codex"], match: /codex/i, unverified: false, priced: false, price: () => null },
  { id: "gemini", label: "Gemini", chip: "GM", binary: "gemini", transcriptRoots: h => [`${h}/.gemini/tmp`], joinKey: "toolCalls[].id", dispatchFlag: " -i", modelFlag: "-m", models: ["2.5 Pro", "2.5 Flash"], match: /gemini/i, unverified: true, priced: false, price: () => null },
];

export const providerById = (id: string | null | undefined): ProviderMeta | null => PROVIDERS.find(p => p.id === id) ?? null;
/** The provider a free-text name (Call.provider, a Herdr agent name) refers to, or null. Registry order wins. */
export const providerOf = (text: string | null | undefined): ProviderMeta | null => (text ? PROVIDERS.find(p => p.match.test(text)) ?? null : null);
export const providerLabel = (id: string): string => providerById(id)?.label ?? id;
