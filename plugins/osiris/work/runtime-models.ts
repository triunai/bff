// Runtime ids and suggested models, browser-safe (no node imports) so the server's argv table (runtimes.ts) and the
// Dispatch dialog share ONE definition.
import type {Runtime} from "./surface-types.ts";

export const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const RUNTIMES: readonly Runtime[] = ["claude", "codex", "cursor-agent", "stub"];
/** The ALLOWED set (server enforces it) and the dialog's suggestions: free-text model ids are rejected. null = the runtime default. */
export const SUGGESTED_MODELS: Record<Runtime, string[]> = {
  claude: ["sonnet", "opus", "haiku"],
  codex: ["gpt-5.5", "gpt-5-codex"],
  "cursor-agent": ["auto", "sonnet-4.5", "gpt-5"],
  stub: ["stub"],
};
export const isAllowedModel = (rt: Runtime, m: string | null): boolean => m === null || (MODEL_RE.test(m) && (SUGGESTED_MODELS[rt] ?? []).includes(m));
/** Bead ids are `<prefix>-<hash>[.n]*`, lowercase alphanumerics only: no shell, path or flag characters can pass. */
export const BEAD_ID_RE = /^[a-z0-9]+-[a-z0-9.]+$/;
/** Identity of a runtime+model selection. The dialog stores it with the loaded preview (W-1B L8). */
export const selectionKey = (runtime: Runtime, model: string | null): string => JSON.stringify([runtime, model || null]);
/** Confirm is allowed only for a preview that was loaded FOR the current selection, carries a token, and no dispatch is running. */
/** W-2A M1: a preview that lists repo hooks also needs `trusted` (the "I trust this repo's hooks" box) before Confirm enables. */
export const canConfirm = (loaded: {key: string; token?: string; hooks?: string[]} | null, runtime: Runtime, model: string | null, busy: boolean, trusted = false): boolean => !!loaded && !busy && !!loaded.token && loaded.key === selectionKey(runtime, model) && (!loaded.hooks?.length || trusted);
