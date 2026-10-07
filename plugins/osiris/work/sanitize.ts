// Untrusted-text sanitising, ONE definition (server). Bead titles/descriptions, pane titles and pane tails are attacker-influenced
// text: they must not reach a terminal, a prompt or the UI carrying escape sequences, hidden characters or secrets. Browser-safe
// (no node imports) so the client can reuse cleanText.
const ESC = "\\x1b", C1_OSC = "\\x9d";
// OSC (incl. 52 clipboard, 8 hyperlinks), DCS, SOS, PM, APC strings. Hand-rolled and LINEAR (W-2A H1: the old lazy regex rescanned to the
// end of input for every unterminated intro, O(n^2)): a terminated string runs to the FIRST terminator (BEL, ESC\, ST) even across
// lines, an unterminated one to the end of its line. The next terminator position is memoised, so each scan resumes where the last stopped.
const INTRO = new RegExp(`(?:${ESC}[\\]PX^_]|${C1_OSC}|\\x90|\\x98|\\x9e|\\x9f)`, "g"), TERMS = new RegExp(`\\x07|${ESC}\\\\|\\x9c`, "g");
function stripStrings(s: string): string {
  let out = "", at = 0, ti = -2, tl = 0; INTRO.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = INTRO.exec(s)); ) {
    const from = m.index + m[0].length;
    if (ti !== -1 && ti < from) { TERMS.lastIndex = from; const t = TERMS.exec(s); ti = t ? t.index : -1; tl = t ? t[0].length : 0; }
    let end: number; if (ti !== -1) end = ti + tl; else { const nl = s.indexOf("\n", from); end = nl === -1 ? s.length : nl; }
    out += s.slice(at, m.index); at = end; INTRO.lastIndex = end;
  }
  return out + s.slice(at);
}
const CSI = new RegExp(`(?:${ESC}\\[|\\x9b)[0-?]*[ -/]*[@-~]`, "g");
const ESC_OTHER = new RegExp(`${ESC}[ -/]*[0-~]`, "g");
// C0 except \t \n, DEL, C1; bidi overrides, zero-width/invisible characters, Unicode TAG characters (hidden ASCII an LLM reads) and variation selectors (M4).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f­͏ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁩⠀ㅤ︀-️﻿\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export const INPUT_CAP = 64 * 1024;
/** Input is cut to `max` (default 64 KB) BEFORE any pattern runs, so attacker text can never make this expensive. */
export const stripTerminalEscapes = (s: string, max = INPUT_CAP): string => stripStrings(String(s ?? "").slice(0, max)).replace(CSI, "").replace(ESC_OTHER, "").replace(CONTROLS, "");
/** Escapes + hidden characters stripped; optional hard output cap (UTF-16 units). The input is pre-cut to 4x that cap (callers' caps first). */
export const cleanText = (s: string, max?: number): string => { const o = stripTerminalEscapes(typeof s === "string" ? s : "", max === undefined ? INPUT_CAP : Math.min(INPUT_CAP, max * 4)); return max !== undefined && o.length > max ? o.slice(0, max) : o; };

const REDACTED = "[redacted]";
// Credentials embedded in a URL (W-7 MED-3, widened by W-8, W-9): take the WHOLE non-space run after scheme:// and redact
// everything before its LAST '@', so an empty user, an '@' or '/' inside the password, and token-only userinfo all go.
// Over-redacting a path that contains '@' is the safe failure for paste-into-chat text. The run is UNBOUNDED on purpose:
// every length bound tried (256, then 8192) became a bypass; each match consumes its run, so the scan stays linear. The
// scheme stays bounded (an unbounded scheme class went quadratic on "a-a-a-…", caught by the M6 pin), and the anchor is
// "not after a letter" (W-9 LOW-3: `\b` let "_https://" and "1https://" through).
const CRED_URL = /(?<![a-z])([a-z][\w+.-]{0,31}:\/\/)(\S*)/gi;
const credUrl = (m: string, scheme: string, rest: string): string => { const at = rest.lastIndexOf("@"); return at > 0 ? `${scheme}${REDACTED}@${rest.slice(at + 1)}` : m; };
// W-9 LOW-4: scheme-less "user:pass@host.tld" keeps the user and host, masks the password (starts only after whitespace or
// an opening bracket/quote, and each run ends at whitespace: linear).
const BARE_CRED = /(^|[\s(<"'])([\w.%+-]{1,64}):([^\s@/]+)@(?=[\w-]+(?:\.[\w-]+)+)/g;
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  // W-2A M6: stripe-style, npm, google, gitlab tokens and Authorization bearers.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, /\bnpm_[A-Za-z0-9]{20,}/g, /\bAIza[0-9A-Za-z_-]{20,}/g, /\bglpat-[0-9A-Za-z_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  // W-9 LOW-4: HTTP Basic credentials, only after an Authorization header (W-10: "Basic authentication" is English).
  /\bAuthorization:\s*Basic\s+[A-Za-z0-9+/]{4,}=*/gi,
];
// name=value / name: value pairs: the KEY NAME stays (it says what was hidden), the value goes. The name part is length-bounded (linear).
const KEYED = /([\w-]{0,30}(?:secret|token|passw(?:or)?d|api[_-]?key)[\w-]{0,30}\s*[=:]\s*)\S+/gi;
// W-9 LOW-2, narrowed by W-10: the weak names (key, sig, auth, credential, session) only in the `name=value` form, at a
// query/assignment boundary. As unanchored substrings they ate ordinary tail text ("Author: …", "Unauthorized: 401",
// "signal: SIGTERM", "keyboard: ok"), which the owner needs to read.
const KEYED_QUERY = /((?:^|[?&#;\s])(?:key|sig|signature|auth|credential|session(?:_?id)?|access_key)=)[^\s&#]+/gi;
/** Mask token-shaped strings, private-key blocks, key=value secrets and the user name in home paths. */
export function redactSecrets(s: string): string {
  let o = String(s ?? "");
  o = o.replace(CRED_URL, credUrl).replace(BARE_CRED, `$1$2:${REDACTED}@`);
  for (const re of SECRETS) o = o.replace(re, REDACTED);
  return o.replace(KEYED, `$1${REDACTED}`).replace(KEYED_QUERY, `$1${REDACTED}`).replace(/\/(Users|home)\/[^/\s]+(?=\/|\s|$)/g, "/$1/~");
}

// Failure reasons (a thrown error, a tracker message) are free text that can quote file paths and session ids. They leave the server and
// reach the UI, so paths and id-shaped tokens are masked: a diagnosis keeps its words, never the location or the identity.
const PATH_RE = /(?:~|\.{1,2})?(?:\/[^\s/'"`:;,()<>]+)+\/?|[\w.-]+(?:\/[\w.-]+){2,}|[A-Za-z]:\\[^\s'"`]+/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_ID_RE = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g;
/** cleanText, then paths -> "[path]" and uuid / long id-like tokens -> "[id]". Not a promise to catch an arbitrary secret word. */
export const redactReason = (s: string, max = 200): string => cleanText(String(s ?? ""), max * 4).replace(PATH_RE, "[path]").replace(UUID_RE, "[id]").replace(LONG_ID_RE, "[id]").slice(0, max);

/** Display text that may hold a secret (Codex review-codex-r2 B2, td-osi.37): BOUND the input, CANONICALIZE (terminal escapes, controls and
 *  invisible characters such as U+200B stripped) BEFORE secret detection, redact (twice: a first pass can expose a second shape), and only
 *  then cap. Redacting first and stripping after let `ghp_` + 18 + U+200B + 18 rejoin into an unredacted 36-char token. */
export const redactForDisplay = (s: string, max: number): string => {
  const canon = stripTerminalEscapes(typeof s === "string" ? s : "", Math.min(INPUT_CAP, Math.max(1, max) * 4));
  return cleanText(redactSecrets(redactSecrets(canon)), max);
};
