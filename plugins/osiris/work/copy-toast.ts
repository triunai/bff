// ONE copy-with-toast helper (pure of React): every Copy button writes through copyWithToast, and the one CopyToastHost shows the message.
export const copiedMessage = (items: number): string => `Copied ${items} item${items === 1 ? "" : "s"}`;
type Listener = (message: string) => void;
const listeners = new Set<Listener>();
export const onCopyToast = (l: Listener): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const emitCopyToast = (message: string): void => { for (const l of listeners) l(message); };
/** Writes `text` to the clipboard and, only when that worked, toasts "Copied N items". Returns false when the clipboard refused (the caller keeps its own fallback). */
export async function copyWithToast(text: string, items = 1, write: (t: string) => Promise<void> = t => navigator.clipboard.writeText(t)): Promise<boolean> {
  try { await write(text); emitCopyToast(copiedMessage(items)); return true; } catch { return false; }
}
