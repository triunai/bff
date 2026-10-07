// The ONE boundary between external text (git, bd, transcripts, herdr, file contents) and the terminal. Everything the TUI prints is a `SafeText`,
// and the only ways to make one are `termSafe` and `S()` (which calls it), so a raw ESC / OSC / BEL cannot reach the tty by forgetting a call: the
// segment type will not compile. The app's OWN colour escapes are added by renderLine AFTER this, from typed styles, never from text.
export type SafeText = string & { readonly __termSafe: true };

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
const STRING_SEQ = /\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g; // DCS, SOS, PM, APC
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]?/g;
const ESC_PAIR = /\x1b[ -/]*[0-~]?/g; // any other ESC sequence, and a stray ESC
// Bidi overrides/isolates and invisible line/format controls: shown as a placeholder so text cannot be reordered or hidden to spoof.
const BIDI = /[\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const NEEDS_WORK = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const TAB_WIDTH = "    ";

export function termSafe(s: string): SafeText {
  const str = String(s ?? "");
  if (!NEEDS_WORK.test(str)) return str as SafeText;
  return str
    .replace(OSC, "").replace(STRING_SEQ, "").replace(CSI, "").replace(ESC_PAIR, "")
    .replace(/\t/g, TAB_WIDTH)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(BIDI, "▯")
    .replace(LONE_SURROGATE, "�") as SafeText;
}
