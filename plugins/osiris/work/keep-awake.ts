// Keep the Mac awake while agents work (td-osi.12). While the live agent count is above zero, hold ONE self-expiring power assertion:
// `/usr/bin/caffeinate -i -t 600` (idle-sleep only: never -s or -d, so the display may still sleep), renewed every 5 minutes while still live.
// The assertion always dies on its own within 10 minutes, so a crashed Osiris or BB can never keep the Mac awake. macOS only; a no-op elsewhere.
// No shell, no PATH lookup: the program must be exactly /usr/bin/caffeinate, root-owned and not writable by group/other (resolveRootBin).
export const CAFFEINATE_BIN = "/usr/bin/caffeinate";
export const CAFFEINATE_ARGV: readonly string[] = ["-i", "-t", "600"];
export const RENEW_MS = 5 * 60_000;
export const TICK_MS = 60_000;

export interface AwakeChild { kill(): void; onExit(cb: () => void): void }
export interface KeepAwakeDeps {
  platform: string;
  enabled(): boolean;
  /** The validated caffeinate path, or null (fails closed with nothing executed). Called fresh on every spawn. */
  trusted(): string | null;
  spawn(bin: string, argv: readonly string[]): AwakeChild;
  now(): number;
}
export type AwakeOutcome = "unsupported" | "off" | "idle" | "holding" | "renewed" | "untrusted" | "failed";

export const keepAwakeTooltip = (live: number): string =>
  `Keeping your Mac awake: ${live} agent${live === 1 ? "" : "s"} working · lid-close still sleeps on battery`;

export function createKeepAwake(d: KeepAwakeDeps) {
  let child: AwakeChild | null = null, since = 0;
  const release = () => { const c = child; child = null; if (c) try { c.kill(); } catch { /* already gone */ } };
  /** One call per tick with the current live agent count. Renews only while live > 0; at 0 it just stops renewing (the assertion expires itself). */
  function tick(live: number): AwakeOutcome {
    if (d.platform !== "darwin") return "unsupported";
    if (!d.enabled()) { release(); return "off"; }
    if (!(live > 0)) return "idle";
    if (child && d.now() - since < RENEW_MS) return "holding";
    release(); // never two children: the old one goes before the new one starts
    const bin = d.trusted();
    if (!bin) return "untrusted";
    try {
      const c = d.spawn(bin, CAFFEINATE_ARGV);
      child = c; since = d.now();
      c.onExit(() => { if (child === c) child = null; });
      return "renewed";
    } catch { child = null; return "failed"; }
  }
  return { tick, release, active: () => child !== null };
}
