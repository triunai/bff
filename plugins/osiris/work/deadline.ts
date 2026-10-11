// D-138: a call that can wait on a busy host must END with a plain error, never spin. One definition, used by the Day tab's commit load (app.tsx)
// and by the repo allowlist build (work/repo-allow.ts), the shared first step of every git RPC.
export class DeadlineError extends Error { constructor(msg: string) { super(msg); this.name = "DeadlineError"; } }

/** Race `p` against a timer. The timer is always cleared. A late result is dropped (the caller has already shown the error). */
export function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new DeadlineError(message)), ms); });
  return Promise.race([p, late]).finally(() => { if (timer) clearTimeout(timer); });
}

export const DAY_LOAD_MS = 20_000;
export const DAY_LOAD_TIMEOUT_MESSAGE = `Commits did not load within ${DAY_LOAD_MS / 1000} seconds. The BB host is probably overloaded (many agents or test runs at once). Wait a minute and press Refresh; if it keeps happening, check the machine's load and the BB log (~/.bb/logs, "Event loop stalled").`;
