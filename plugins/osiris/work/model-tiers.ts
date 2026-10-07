// Model tiers (pure, data): ONE table mapping a model id to its provider, tier and display label. The Factory's agent badge
// reads it for three separate signals: provider = the icon inside the badge, tier = the topper (strong: crown, king: cape),
// role (lead / worker, from the bead's role label) = the badge shape. An unknown model is NEVER guessed: it gets a neutral
// "?" badge. Icons are ORIGINAL glyphs, not the providers' logos (their guidelines require prior permission; see the report).
export type Provider = "anthropic" | "openai" | "other";
export type Tier = "base" | "strong" | "king";
/** `letter`: the model's initial, drawn INSIDE the badge (FAC-4: with only provider + tier, Sonnet and Haiku were the same mark).
 * Unique across the table (Sol is "So", so it never reads as Sonnet). */
export type ModelTier = { key: string; provider: Provider | null; tier: Tier | null; label: string; letter: string };

/** First match wins, so the specific names come before the broad ones (sol before gpt/codex). */
export const MODEL_TIERS: readonly { pattern: RegExp; key: string; provider: Provider; tier: Tier; label: string; letter: string }[] = [
  { pattern: /fable/, key: "fable", provider: "anthropic", tier: "king", label: "Fable", letter: "F" },
  { pattern: /astra/, key: "astra", provider: "other", tier: "king", label: "Astra", letter: "A" },
  { pattern: /opus/, key: "opus", provider: "anthropic", tier: "strong", label: "Opus", letter: "O" },
  { pattern: /sonnet/, key: "sonnet", provider: "anthropic", tier: "base", label: "Sonnet", letter: "S" },
  { pattern: /haiku/, key: "haiku", provider: "anthropic", tier: "base", label: "Haiku", letter: "H" },
  { pattern: /(^|[^a-z])sol([^a-z]|$)/, key: "sol", provider: "openai", tier: "strong", label: "Sol", letter: "So" },
  { pattern: /gemini.*pro/, key: "gemini-pro", provider: "other", tier: "strong", label: "Gemini Pro", letter: "P" },
  { pattern: /gemini.*flash/, key: "gemini-flash", provider: "other", tier: "base", label: "Gemini Flash", letter: "Fl" },
  { pattern: /gemini/, key: "gemini-other", provider: "other", tier: "base", label: "Gemini", letter: "G" },
  { pattern: /codex|gpt/, key: "codex", provider: "openai", tier: "base", label: "Codex", letter: "C" },
];
export const UNKNOWN_MODEL: ModelTier = { key: "unknown", provider: null, tier: null, label: "Unknown model", letter: "?" };

/** The tier row for a model id (case-insensitive), or the neutral unknown. Null / empty is unknown too. */
export function modelTier(id: string | null | undefined): ModelTier {
  const m = (id ?? "").trim().toLowerCase();
  if (!m) return UNKNOWN_MODEL;
  const row = MODEL_TIERS.find(r => r.pattern.test(m));
  return row ? { key: row.key, provider: row.provider, tier: row.tier, label: row.label, letter: row.letter } : UNKNOWN_MODEL;
}
/** What a tier and a role mean, in words (uh-factory-strings-12/13: "strong", "king", "lead" were system names). */
export const TIER_WORDS: Readonly<Record<Tier, string>> = { base: "standard model", strong: "strong model", king: "top model" };
export const ROLE_WORDS = { lead: "lead (runs other agents)", worker: "worker (does one work item)" } as const;
/** Tooltip text, e.g. "Opus · strong model · lead (runs other agents)", "Unknown model · worker (does one work item)". */
export const tierTitle = (t: ModelTier, role: "lead" | "worker" | null) => [t.label, t.tier ? TIER_WORDS[t.tier] : null, role ? ROLE_WORDS[role] : null].filter(Boolean).join(" · ");
