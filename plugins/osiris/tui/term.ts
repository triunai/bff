// Terminal toolkit shared by the two Osiris text apps (factory, worktrees). PURE except `runScreen`, the one place that touches the tty.
// A line is a list of styled segments, so clipping, padding and the `--no-color` render all work on VISIBLE text; colour is a style on
// a segment and is dropped (every glyph kept) when colour is off. Colour is never the only signal: callers always pair it with a glyph/word.
import { termSafe, type SafeText } from "./sanitize.ts";
export type Style = { c?: number; bg?: number; b?: boolean; inv?: boolean; dim?: boolean };
/** `t` is a SafeText: build segments with S(), which sanitises external text; a bare string does not type-check. */
export type Seg = { t: SafeText; s?: Style };
export type Line = Seg[];

export const S = (t: string, s?: Style): Seg => ({ t: termSafe(t), s });
export const lineLen = (l: Line): number => l.reduce((n, g) => n + g.t.length, 0);
/** Cut a line to `w` visible columns, ending in an ellipsis when it was cut. */
export function clipLine(l: Line, w: number): Line {
  if (w <= 0) return [];
  if (lineLen(l) <= w) return l;
  const out: Line = []; let room = w - 1;
  for (const g of l) { if (room <= 0) break; out.push(g.t.length <= room ? g : S(g.t.slice(0, room), g.s)); room -= g.t.length; }
  out.push(S("…", out.length ? out[out.length - 1].s : undefined));
  return out;
}
export const padLine = (l: Line, w: number): Line => { const c = clipLine(l, w), n = lineLen(c); return n < w ? [...c, S(" ".repeat(w - n))] : c; };
/** Drop trailing blank padding (a selected row keeps its background cells). */
export function trimEnd(l: Line): Line {
  const out = [...l];
  while (out.length) { const g = out[out.length - 1]; if (g.s?.bg !== undefined) break; const t = g.t.replace(/ +$/, ""); if (t === g.t) break; if (t) { out[out.length - 1] = S(t, g.s); break; } out.pop(); }
  return out;
}
export const cat = (...ls: Line[]): Line => ls.flat();
/** Re-style every segment of a line (selection highlight). */
export const withStyle = (l: Line, s: Style): Line => l.map(g => S(g.t, { ...g.s, ...s }));

const sgr = (s: Style): string => [s.b ? "1" : "", s.dim ? "2" : "", s.inv ? "7" : "", s.c !== undefined ? `38;5;${s.c}` : "", s.bg !== undefined ? `48;5;${s.bg}` : ""].filter(Boolean).join(";");
export function renderLine(l: Line, color: boolean): string {
  let out = "";
  for (const g of l) { const p = color && g.s ? sgr(g.s) : ""; const t = termSafe(g.t); out += p ? `\x1b[${p}m${t}\x1b[0m` : t; } // final guard: a hand-cast segment is still sealed here
  return out;
}
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** The bytes that turn the screen showing `prev` into `next`: only changed rows are rewritten (no flicker); rows that vanished are cleared. */
export function diffFrame(prev: readonly string[] | null, next: readonly string[]): string {
  if (!prev) return `\x1b[2J${next.map((l, i) => `\x1b[${i + 1};1H${l}\x1b[K`).join("")}`;
  let out = "";
  for (let i = 0; i < Math.max(prev.length, next.length); i++) if (prev[i] !== next[i]) out += `\x1b[${i + 1};1H${next[i] ?? ""}\x1b[K`;
  return out;
}

export const ageText = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
export const clockText = (t: number): string => { const d = new Date(t), p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
/** 4-cell filled/empty bar for a fraction 0..1. */
export const barText = (f: number, cells = 4): string => { const x = Math.max(0, Math.min(cells, f * cells)), full = Math.floor(x), mid = full < cells && x - full >= 0.25 ? "▒" : ""; return "▓".repeat(full) + mid + "░".repeat(cells - full - mid.length); };

export type Key = "up" | "down" | "tab" | "shift-tab" | "enter" | "quit" | "esc" | { ch: string };
/** Raw stdin chunk -> a key (or null). Arrow keys map to up/down so they work beside j/k. `typing` = a text field has focus, so q is a letter. */
export function parseKey(d: string, typing = false): Key | null {
  if (d === "\x03" || (!typing && (d === "q" || d === "Q"))) return "quit";
  if (d === "\t") return "tab";
  if (d === "\x1b[Z") return "shift-tab";
  if (d === "\r" || d === "\n") return "enter";
  if (d === "\x1b[A") return "up";
  if (d === "\x1b[B") return "down";
  if (d === "\x1b") return "esc";
  return d.length === 1 && d >= " " ? { ch: d } : null;
}
export const isCh = (k: Key, ...chs: string[]): boolean => typeof k === "object" && chs.includes(k.ch);
export const isDown = (k: Key): boolean => k === "down" || isCh(k, "j");
export const isUp = (k: Key): boolean => k === "up" || isCh(k, "k");

// ---- mouse (xterm SGR reporting) -----------------------------------------------------------------------------------------------
// 1000 = press/release, 1002 = also drags while a button is held, 1006 = SGR encoding (no 223-column limit). A terminal that ignores 1006 sends the
// legacy X10 encoding instead; `drainInput` reads both, so a click works either way.
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
/** One decoded SGR mouse report. x/y are 0-based screen cells (the wire is 1-based). */
export type Mouse = { kind: "press" | "release" | "drag" | "wheel"; button: "left" | "middle" | "right" | "none"; dir: 1 | -1 | 0; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean };
/** Every SGR report (`ESC [ < b ; x ; y M|m`) in a stdin chunk, in order. Anything else in the chunk is ignored. */
export function parseMouse(d: string): Mouse[] {
  return [...d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map(m => mouseOf(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "m"));
}
const SGR_PREFIX = "\x1b[<", X10_PREFIX = "\x1b[M";
const SGR_FULL = /^\x1b\[<\d+;\d+;\d+[Mm]/, SGR_PART = /^\x1b\[<[\d;]*$/;
/** One mouse report from its button byte, 1-based cell and press/release flag (shared by the SGR and the legacy X10 decoders). */
function mouseOf(b: number, x: number, y: number, up: boolean): Mouse {
  const wheel = (b & 64) !== 0, motion = (b & 32) !== 0, low = b & 3;
  return {
    kind: wheel ? "wheel" : up ? "release" : motion ? "drag" : "press", button: wheel || low === 3 ? "none" : (["left", "middle", "right"] as const)[low], dir: wheel ? (low === 0 ? -1 : low === 1 ? 1 : 0) : 0,
    x: x - 1, y: y - 1, shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0,
  };
}
export type InputEvent = { mouse: Mouse } | { keys: string };
/** PURE: split a stdin stream into ordered mouse reports (SGR or legacy X10) and key chunks. A report cut by a chunk boundary is held in `pending`
 * and finished by the next chunk, and a report is found ANYWHERE in a chunk (not only at its start), so a multiplexer that coalesces a click with
 * other bytes, or splits one across writes, still delivers it. Legacy X10 carries each field as a byte + 32; a byte over 127 is mangled by utf8
 * decoding, so X10 clicks past column 95 are the one thing only SGR can address. */
export function drainInput(pending: string, chunk: string): { events: InputEvent[]; pending: string } {
  const s = pending + chunk, events: InputEvent[] = []; let i = 0, keys = "";
  const flush = () => { if (keys) events.push({ keys }); keys = ""; };
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest.startsWith(SGR_PREFIX)) {
      const m = SGR_FULL.exec(rest);
      if (m) { flush(); const [b, x, y] = m[0].slice(3, -1).split(";").map(Number); events.push({ mouse: mouseOf(b, x, y, m[0].endsWith("m")) }); i += m[0].length; continue; }
      if (SGR_PART.test(rest)) { flush(); return { events, pending: rest }; }
    } else if (rest.startsWith(X10_PREFIX)) {
      if (rest.length < 6) { flush(); return { events, pending: rest }; }
      const b = rest.charCodeAt(3) - 32, x = rest.charCodeAt(4) - 32, y = rest.charCodeAt(5) - 32;
      flush(); events.push({ mouse: mouseOf(b, x, y, (b & 3) === 3 && (b & 64) === 0) }); i += 6; continue;
    } else if (SGR_PREFIX.startsWith(rest) && rest.length > 1) { flush(); return { events, pending: rest }; }
    keys += s[i]; i++;
    if (s.startsWith(SGR_PREFIX, i) || s.startsWith(X10_PREFIX, i)) flush();
  }
  flush();
  return { events, pending: "" };
}
/** One line for the info row when this app runs inside Herdr with its mouse capture switched off (ui.mouse_capture = false in config.toml), the one
 * setting that stops clicks reaching a pane app. Read-only: the config file is only read. Herdr exposes no per-pane mouse state, so this is the one
 * capability that can be checked; null when not under Herdr or when capture is on. */
export function herdrMouseHint(env: NodeJS.ProcessEnv, readText: (path: string) => string | null): string | null {
  if (!env.HERDR_PANE_ID) return null;
  const home = env.HOME ?? "", path = env.HERDR_CONFIG_PATH ?? `${env.XDG_CONFIG_HOME ?? `${home}/.config`}/herdr/config.toml`, t = readText(path);
  if (t === null) return null;
  let ui = false;
  for (const raw of t.split("\n")) {
    const l = raw.replace(/#.*$/, "").trim();
    if (l.startsWith("[")) ui = l === "[ui]";
    else if (ui && /^mouse_capture\s*=\s*false$/.test(l)) return "mouse: off in this Herdr pane, enable with ui.mouse_capture = true in herdr config.toml";
  }
  return null;
}
/** What a cell is: a selectable row of a panel, a panel title, or a key-legend item (which acts as that key). */
export type HitAct = { k: "row"; panel: string; i: number } | { k: "panel"; panel: string } | { k: "key"; key: Key };
/** A clickable rectangle of ONE screen row, x1 exclusive. Produced by the same layout pass that draws the frame. */
export type Hit = { y: number; x0: number; x1: number; act: HitAct };
export type Frame = { lines: Line[]; hits: Hit[] };
export const shiftHits = (hs: readonly Hit[], dy: number): Hit[] => hs.map(h => ({ ...h, y: h.y + dy }));
/** The hit under a cell; when rectangles overlap the LAST one pushed wins (a key item over its row). */
export function hitAt(hits: readonly Hit[], x: number, y: number): HitAct | null {
  for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (h.y === y && x >= h.x0 && x < h.x1) return h.act; }
  return null;
}
/** The hit for a text found in a drawn line (key legend / title): x0 is where its first segment starts. */
export function segHit(l: Line, y: number, text: string, act: HitAct): Hit[] {
  let x = 0;
  for (const g of l) { if (g.t.includes(text)) { const x0 = x + g.t.indexOf(text); return [{ y, x0, x1: x0 + text.length, act }]; } x += g.t.length; }
  return [];
}
export type Click = { at: number; key: string };
/** What the app reducers see: a click, a double-click on the same target, or a wheel step over the frame. */
export type MouseAct = { kind: "click" | "dblclick"; hit: HitAct | null } | { kind: "wheel"; dir: 1 | -1 };
export const DOUBLE_CLICK_MS = 400;
/** PURE: a mouse report -> the action (or null) and the new double-click memory. Only a left press clicks; release/drag/other buttons are ignored. */
export function mouseStep(prev: Click | null, m: Mouse, hits: readonly Hit[], now: number): { click: Click | null; act: MouseAct | null } {
  if (m.kind === "wheel") return m.dir === 0 ? { click: prev, act: null } : { click: prev, act: { kind: "wheel", dir: m.dir } };
  if (m.kind !== "press" || m.button !== "left") return { click: prev, act: null };
  const hit = hitAt(hits, m.x, m.y), key = JSON.stringify(hit);
  const dbl = hit !== null && prev !== null && prev.key === key && now - prev.at <= DOUBLE_CLICK_MS;
  return { click: dbl ? null : { at: now, key }, act: { kind: dbl ? "dblclick" : "click", hit } };
}

export type Reduced<U> = { ui: U; quit?: boolean; refresh?: boolean };
/** The one tty loop. `load` fetches data (slow, async); `view` is pure over (data, ui, size) and returns the lines AND the hit rectangles of that same
 * layout; `onKey`/`onMouse` are pure reducers. Redraws changed rows only. The terminal (alt screen, cursor, mouse mode, raw mode) is restored in ONE
 * `restore` that runs on quit, SIGINT/SIGTERM, a throw in a reducer/view, and the process `exit` event. `mouse: false` never enables reporting. */
export type Size = { cols: number; rows: number };
export type Screen<D, U> = {
  load: () => Promise<D>; view: (d: D | null, ui: U, cols: number, rows: number) => Frame; ui: U; onKey: (ui: U, k: Key, d: D | null, size: Size) => Reduced<U>;
  onMouse?: (ui: U, a: MouseAct, d: D | null, size: Size) => Reduced<U>; mouse?: boolean; now?: () => number;
  color: boolean; intervalMs: number; typing?: (ui: U) => boolean; out?: NodeJS.WriteStream; input?: NodeJS.ReadStream;
};
export function runScreen<D, U>(o: Screen<D, U>): Promise<void> {
  const out = o.out ?? process.stdout, input = o.input ?? process.stdin, mouse = (o.mouse ?? true) && !!o.onMouse, now = o.now ?? Date.now;
  let fail: (e: unknown) => void = () => {}, data: D | null = null, ui = o.ui, prev: string[] | null = null, loading = false, done = false, hits: Hit[] = [], click: Click | null = null, pending = "";
  const size = (): Size => ({ cols: out.columns || 100, rows: out.rows || 40 });
  const draw = () => {
    const { cols, rows } = size(), f = o.view(data, ui, cols, rows);
    const next = f.lines.slice(0, rows).map(l => renderLine(l, o.color));
    hits = f.hits; out.write(diffFrame(prev, next)); prev = next;
  };
  const refresh = async () => { if (loading) return; loading = true; try { data = await o.load(); } catch { /* keep the last good data */ } loading = false; if (!done) try { draw(); } catch (e) { fail(e); } };
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => void refresh(), o.intervalMs);
    let restored = false;
    const restore = () => {
      if (restored) return; restored = true; clearInterval(timer);
      try { out.write(`${mouse ? MOUSE_OFF : ""}\x1b[?25h\x1b[?1049l`); } finally { if (input.isTTY) { input.setRawMode(false); input.pause(); } }
    };
    const onSig = () => finish();
    const finish = (err?: unknown) => { if (done) return; done = true; try { restore(); } finally { process.removeListener("exit", restore); process.removeListener("SIGINT", onSig); process.removeListener("SIGTERM", onSig); if (err) reject(err); else resolve(); } };
    const apply = (r: Reduced<U>) => { ui = r.ui; if (r.quit) return finish(); if (r.refresh) void refresh(); else draw(); };
    const guard = (f: () => void) => { try { f(); } catch (e) { finish(e); } };
    fail = finish;
    process.once("exit", restore);
    out.write(`\x1b[?1049h\x1b[?25l${mouse ? MOUSE_ON : ""}`);
    if (input.isTTY) {
      input.setRawMode(true); input.resume(); input.setEncoding("utf8");
      input.on("data", (d: string) => guard(() => {
        const r = drainInput(pending, String(d)); pending = r.pending;
        for (const ev of r.events) {
          if (done) return;
          if ("mouse" in ev) { // mouse reports are ignored entirely when mouse is off
            if (!mouse) continue;
            const st = mouseStep(click, ev.mouse, hits, now()); click = st.click; if (st.act) apply(o.onMouse!(ui, st.act, data, size()));
            continue;
          }
          const k = parseKey(ev.keys, o.typing?.(ui) ?? false); if (k) apply(o.onKey(ui, k, data, size()));
        }
      }));
    }
    process.once("SIGINT", onSig); process.once("SIGTERM", onSig); out.on("resize", () => guard(() => { prev = null; draw(); }));
    guard(() => { draw(); void refresh(); });
  });
}
