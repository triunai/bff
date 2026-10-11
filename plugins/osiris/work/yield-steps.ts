// Cooperative steps for long pure builds (2026-10-11 event-loop fix). A build written as a generator `yield`s between its heavy parts;
// the SAME generator runs to completion synchronously (runSteps: browser, tests, TUI) or with an event-loop turn whenever a slice of work
// has run longer than `sliceMs` (runStepsAsync: the plugin server, which shares BB's one event loop). One implementation, two drivers, so
// the async answer cannot drift from the sync one. Pure: no node imports (the client bundles the models too).
export type Steps<T> = Generator<void, T, void>;
/** Drive to completion with no pause. */
export function runSteps<T>(g: Steps<T>): T {
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
const turn = (): Promise<void> => new Promise(r => (typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0)));
/** Drive to completion, giving the event loop a turn after every `sliceMs` of uninterrupted work. */
export async function runStepsAsync<T>(g: Steps<T>, sliceMs: number, clock: () => number = () => performance.now()): Promise<T> {
  let slice = clock();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (clock() - slice >= sliceMs) { await turn(); slice = clock(); }
  }
}
