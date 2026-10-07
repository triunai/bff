// Demo mode must never show real terminal or session data (preview.28 review MINOR 1). These are the only places the app decides that, so one test can pin them.
/** The rail's terminal list: none at all while demo is ON (a real BB/Herdr terminal title is live data). */
export const gateTerminals = <T>(demo: boolean, live: readonly T[] | null): T[] | null => (demo ? [] : live ? [...live] : null);
/** BB's native recorded-session list: empty while demo is ON. */
export const gateNative = <N extends { threads: readonly unknown[] }>(demo: boolean, live: N): N => (demo ? { ...live, threads: [] } : live);
/** Whether the centre terminal may mount: never in demo. */
export const terminalAllowed = (demo: boolean): boolean => !demo;
/** The calm note the rail's TERMINALS section shows instead of live panes. */
export const DEMO_TERMINALS_OFF = "demo: terminals are off";
