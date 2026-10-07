// The keyboard shortcut sheet's rows (pure). Generated from KEYMAP, the one source: a new binding appears here with no further edit.
import { KEYMAP, formatChord } from "./keymap.ts";

export type ShortcutRow = { command: string; label: string; keys: string };
export const shortcutRows = (isMac: boolean): ShortcutRow[] => KEYMAP.map(b => ({ command: b.command, label: b.label, keys: formatChord(b.chord, isMac) }));
