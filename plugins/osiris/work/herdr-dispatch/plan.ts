// Dispatch to Herdr: PURE planning. Nothing here spawns or touches the disk.
// The prompt (status text, an inspector summary, anything) NEVER enters a shell string or an argv of herdr:
//   it is written to a private temp file by run.ts; the pane runs a FIXED command that reads that file into one shell variable and passes
//   it as ONE quoted argv element to the chosen CLI. The only text in the command is two validated absolute paths.
import { PROVIDERS, PROVIDER_IDS, providerById } from "../providers/registry.ts";
/** The product name of the action; every surface that offers it uses this one label. */
export const DISPATCH_LABEL = "Dispatch to Herdr";
export const HERDR_CLIS = PROVIDER_IDS;
export type HerdrCli = (typeof HERDR_CLIS)[number];
export const isHerdrCli = (c: unknown): c is HerdrCli => typeof c === "string" && (HERDR_CLIS as readonly string[]).includes(c);
import { MODEL_RE } from "../runtime-models.ts";
/** What the dialog shows per provider: derived from work/providers/registry.ts (the one provider list). */
export const PROVIDER_CARDS: Readonly<Record<HerdrCli, { label: string; code: string; models: readonly string[]; /** Set ONLY when this provider's permission behaviour differs from APPROVAL_SHARED. */ approval?: string }>> = Object.fromEntries(PROVIDERS.map(p => [p.id, { label: p.label, code: p.chip, models: p.models }])) as Record<HerdrCli, { label: string; code: string; models: readonly string[]; /** Set ONLY when this provider's permission behaviour differs from APPROVAL_SHARED. */ approval?: string }>;
/** User-facing dispatch wording. Never names a provider: the chosen agent is shown by the selected card. */
export const APPROVAL_SHARED = `The agent runs in its default permission mode: it asks before edits and commands. Never "skip permissions" from a click.`;
export const approvalText = (cli: HerdrCli | ""): string => (cli ? PROVIDER_CARDS[cli].approval : undefined) ?? APPROVAL_SHARED;
export type DispatchWhere = "tab" | "pane";
export const dispatchButtonLabel = (where: DispatchWhere = "tab"): string => (where === "pane" ? "Open in this pane" : "Open in a new Herdr tab");
/** The preselected agent: the last one dispatched with, else the one with the most recent live activity, else the first detected. Only installed agents qualify. */
export function defaultProvider(available: readonly HerdrCli[], last?: unknown, live?: unknown): HerdrCli | "" {
  for (const c of [last, live]) if (isHerdrCli(c) && available.includes(c)) return c;
  return available[0] ?? "";
}
/** "/opt/homebrew/bin/claude" -> "/opt/…/bin/claude": first folder, an ellipsis, the last folder and the program. */
export const shortPath = (p: string): string => { const a = p.split("/").filter(Boolean); return a.length <= 3 ? p : `/${a[0]}/…/${a.slice(-2).join("/")}`; };
/** The preview is good for two minutes; after that the human must reopen the dialog (the folder, the prompt or the installed CLIs may have changed). */
export const CONFIRM_TTL_MS = 120_000;
export const confirmExpired = (openedAt: number, now: number): boolean => now - openedAt >= CONFIRM_TTL_MS;
/** The editable first line goes first, then the read-only text. */
export const composePrompt = (first: string, text: string): string => (first.trim() ? `${first.trim()}\n\n${text}` : text);
export const PROMPT_MAX = 20_000, TITLE_MAX = 60;
/** Absolute, no dot segments, only characters that need no quoting at all. Anything else is refused rather than escaped. */
export const SAFE_ABS_PATH = /^\/[A-Za-z0-9._\/-]{1,300}$/;
export const safeAbsPath = (p: unknown): p is string => typeof p === "string" && SAFE_ABS_PATH.test(p) && !p.split("/").some(s => s === ".." || s === ".");

/** Strip control characters (keep \n and \t), bound the length. A prompt that starts with "-" gets a one-line lead so no CLI can read it as an option. */
export function cleanPrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").slice(0, PROMPT_MAX).trim();
  if (!s) return null;
  return s.startsWith("-") ? `Context:\n${s}` : s;
}
/** A title is one argv element after --label; a leading "-" would read as a flag, so it is prefixed (the same guard as cleanPrompt). */
export const cleanTitle = (raw: unknown): string => {
  const t = (typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, TITLE_MAX) : "") || "Osiris dispatch";
  return t.startsWith("-") ? `Osiris ${t}` : t;
};

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
// The typed command is POSIX-shell syntax (`p=$(...)`; `exec`). Herdr panes run the user's login shell, which on macOS (zsh) and WSL (bash) is POSIX-compatible;
// a fish or nushell pane would fail visibly (nothing runs), and the client then falls back to copy. Documented, not reworked (preview.22 review).
/** The text typed into the new pane. `bin` and `file` are validated absolute paths; the prompt itself is not in here. */
export function paneCommand(cli: HerdrCli, bin: string, file: string, model?: string | null): string | null {
  if (!safeAbsPath(bin) || !safeAbsPath(file)) return null;
  if (model != null && !MODEL_RE.test(model)) return null; // team dispatch: the one extra token, validated and quoted
  const flag = providerById(cli)?.dispatchFlag ?? ""; // gemini: -i keeps the session interactive after the prompt; claude and codex take the prompt as their argument
  const m = model ? ` ${providerById(cli)?.modelFlag ?? "-m"} ${q(model)}` : "";
  return `p=$(cat ${q(file)}); rm -f ${q(file)}; exec ${q(bin)}${m}${flag} "$p"`;
}
/** `base` is herdrLaunchPlan's argv: [/usr/bin/env, -u ..., herdr] (no session, so the user's default session). */
export const tabCreateArgv = (base: readonly string[], cwd: string, title: string): string[] => [...base, "tab", "create", "--cwd", cwd, "--label", title, "--focus"];
export const paneRunArgv = (base: readonly string[], pane: string, command: string): string[] => [...base, "pane", "run", pane, command];
/** `herdr pane split <pane> --direction ... --cwd ... --no-focus` -> `.result.pane.pane_id`. The pane id is re-checked against PANE_ID_RE (null = refused). */
export const paneSplitArgv = (base: readonly string[], pane: string, direction: "right" | "down", cwd: string): string[] | null =>
  PANE_ID_RE.test(pane) ? [...base, "pane", "split", pane, "--direction", direction, "--cwd", cwd, "--no-focus"] : null;
export const PANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
/** `herdr tab create` -> `.result.root_pane.pane_id`. */
export function rootPaneOf(stdout: string): string | null {
  try { const p = JSON.parse(stdout)?.result?.root_pane?.pane_id; return typeof p === "string" && PANE_ID_RE.test(p) ? p : null; } catch { return null; }
}
/** `herdr pane split` -> `.result.pane.pane_id`. */
export function splitPaneOf(stdout: string): string | null {
  try { const p = JSON.parse(stdout)?.result?.pane?.pane_id; return typeof p === "string" && PANE_ID_RE.test(p) ? p : null; } catch { return null; }
}
export type HerdrDispatchRequest = { prompt: string; cli: HerdrCli; title: string; repo?: string };
export type HerdrDispatchResult = { ok: true; paneId: string } | { ok: false; reason: string; /** herdr could not be driven: the client falls back to copy + Terminal tab */ fallback: boolean };
