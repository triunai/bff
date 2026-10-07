// `osiris factory`: the live, READ-ONLY text Factory. Reads through the plugin's own feeds (bdi + the refusing bd shim for the tracker, the
// transcript telemetry service for lanes, cost and liveness) and draws tui/factory-view.ts. Writes nothing; never spawns an agent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readWorkSnapshot } from "../work/bdi-feed.ts";
import { createTelemetryService } from "../work/telemetry-rpc.ts";
import { telemetryMaps } from "../work/telemetry-model.ts";
import { factoryKey, factoryMouse, factoryModel, fitFactory, infoText, initialUi, layoutFactory, renderFactory, type FactoryData, type FactoryModel, type FactoryUi } from "./factory-view.ts";
import { termSafe } from "./sanitize.ts";
import { editorEnv, loadWtView } from "./worktrees-load.ts";
import type { WtDiffKey, WtEnv } from "./worktrees-model.ts";
import { herdrMouseHint, renderLine, S, runScreen, type Reduced, type Size } from "./term.ts";

export type TuiArgs = { repo: string; color: boolean; once: boolean; mouse: boolean; cols: number | null; intervalMs: number };
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, isTty = !!process.stdout.isTTY): TuiArgs {
  const opt = (k: string): string | null => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] ?? null : null; };
  const once = argv.includes("--once");
  return { repo: resolve(opt("--repo") ?? process.cwd()), once, mouse: !argv.includes("--no-mouse"), cols: opt("--cols") ? Math.max(40, Number(opt("--cols"))) : null,
    color: !argv.includes("--no-color") && !env.NO_COLOR && (once ? isTty : true), intervalMs: Math.max(2, Number(opt("--interval") ?? 5)) * 1000 };
}

const readOrNull = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
/** The one-line hint shown when this pane's Herdr would swallow the mouse (null otherwise, and always null with --no-mouse). */
export const mouseHint = (a: Pick<TuiArgs, "mouse">, env: NodeJS.ProcessEnv = process.env): string | null => (a.mouse ? herdrMouseHint(env, readOrNull) : null);

/** `o.load` replaces the live feed (the pty test drives the real input path over fixture data); production passes nothing. */
export async function runFactory(a: TuiArgs, o: { load?: () => Promise<FactoryData>; env?: WtEnv } = {}): Promise<number> {
  const svc = createTelemetryService({ readSnapshot: r => readWorkSnapshot(r) });
  let last: FactoryData | null = null, tab: FactoryUi["tab"] = "fleet", want: WtDiffKey | null = null; const env = o.env ?? editorEnv;
  const load = o.load ?? (async (): Promise<FactoryData> => {
    const now = Date.now(), r = await readWorkSnapshot(a.repo, { now });
    if (!r.ok) { if (last) return { ...last, error: r.reason }; throw new Error(r.reason); }
    const t = await svc.read(a.repo), tel = t.ok ? t.value : null, f = svc.fleet();
    // The worktrees view is read only while its tab is open (it runs git per worktree); the diff the owner opened rides along.
    const wt = tab === "worktrees" ? await loadWtView(a.repo, false, want).catch(() => null) : null;
    return (last = { snap: r.value, fleet: tel?.fleet ?? (f.ok ? f.value : null), maps: telemetryMaps(tel), now, error: undefined, wt });
  });
  // The model is cut to the CURRENT terminal size (rows per section), so selection, keys and the mouse all address what is drawn.
  const model = (d: FactoryData | null, ui: FactoryUi, size: Size): FactoryModel | null => (d ? fitFactory(factoryModel(d, ui.filter, ui.idleOpen), { ...size, zoom: ui.zoom ? ui.focus : null, extra: ui.note.length, help: ui.help, tab: ui.tab }) : null);
  if (a.once) {
    try { const d = await load(), m = factoryModel(d); console.log(renderFactory(m, initialUi(), { cols: a.cols ?? (process.stdout.columns || 120), rows: process.stdout.rows || 30, color: a.color }).map(l => renderLine(l, a.color)).join("\n")); return 0; }
    catch (e) { console.error(termSafe(`feed error: ${(e as Error).message}`)); return 1; }
  }
  const hint = mouseHint(a), track = (r: Reduced<FactoryUi>): Reduced<FactoryUi> => { tab = r.ui.tab; want = r.ui.tab === "worktrees" ? r.ui.wt.diff : null; return r; };
  await runScreen<FactoryData, FactoryUi>({
    load, ui: initialUi(), color: a.color, intervalMs: a.intervalMs, mouse: a.mouse,
    view: (d, ui, cols, rows) => { const m = model(d, ui, { cols, rows }); return m ? layoutFactory(m, ui, { cols, rows, color: a.color, info: infoText({ pane: process.env.HERDR_PANE_ID, cols, rows, intervalS: a.intervalMs / 1000, hint }) }) : { lines: [[S(" reading the tracker…")]], hits: [] }; },
    typing: ui => ui.tab === "worktrees" && ui.wt.typing,
    onKey: (ui, k, d, size) => track(factoryKey(ui, k, model(d, ui, size), a.repo, env)),
    onMouse: (ui, act, d, size) => track(factoryMouse(ui, act, model(d, ui, size), a.repo, env)),
  });
  return 0;
}
