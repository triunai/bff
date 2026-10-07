import { PILE_MAX, build, claim, floorPlane, gate, intake, land, plate, vault, type Box } from "../../work/machine-geometry.ts";
import type { StationId } from "../../work/factory-floor-model.ts";

// GRAND machines for the Factory FLOOR (2D). One machine per station, drawn behind the cards and above the belt, plus a floor
// plane with perspective under the belt. Pure SVG + CSS, theme tokens only. The only text is NUMBERS (station count, waiting / in-progress split); words live in <title>s.
// Props are geometry (x, w from siloLayout), never positions. Shapes come from work/machine-geometry.ts and derive from the bay width, so a machine stretches from a 64 unit sliver to a
// wide bay. Mount each <StationMachine> INSIDE its bay <g> (it inherits the bay's --tone from .oi-fft-*) and one
// <FactoryFloorPlane> right after the floor <rect>. Reduced motion (the `reduced` prop or the media query) = static art.
/** Below this width a silo is a sliver: the machine collapses to one dim glyph (siloLayout() gives an empty silo >= 28). */
export const SLIVER_W = 60;
/** Top of the art below the bay header (the bay pad starts at 52); the art runs from here down to the belt. */
export const ART_TOP = 62;
export type StationMachineProps = { station: StationId; x: number; w: number; floorY: number; /** 0..1, the silo's share of the floor's work: hopper fill, crate pile */ load: number; bottleneck: boolean; reduced: boolean;
  /** The numerals (frame data, never invented): the station count, and its waiting / in-progress split (omit to hide the split). */
  count?: number; waiting?: number; working?: number };
const finite = (n: number, d = 0) => (Number.isFinite(n) ? n : d);

/** The machine for one station, from the geometry siloLayout() hands out (never BAY_W). `floorY` (the belt) anchors the bottom. */
export function StationMachine({ station, x, w, floorY, load, bottleneck, reduced, count, waiting, working }: StationMachineProps) {
  const W = Math.max(0, finite(w)), L = Math.min(1, Math.max(0, finite(load))), active = L > 0 || (count ?? 0) > 0, on = active && !reduced;
  const full = Math.max(40, finite(floorY) - ART_TOP), cls = `oi-fm oi-fm-${station}${active ? " on" : ""}${on ? " live" : ""}${bottleneck ? " jam" : ""}`;
  if (W < SLIVER_W) {
    const r = Math.max(2, Math.min(W * 0.3, 8));
    return <g className={`${cls} sliver`} aria-hidden="true" pointer-events="none"><circle className="oi-fm-glyph" cx={x + W / 2} cy={floorY - r - 6} r={r}><title>{station}</title></circle></g>;
  }
  const bw = W - 12, p = plate({ w: bw, room: full }), room = Math.max(30, full - p.h), box: Box = { w: bw, room }, cx = bw / 2, n = Math.max(0, Math.floor(finite(count ?? 0)));
  const split = p.split.show && waiting !== undefined && working !== undefined;
  return (
    <g className={cls} transform={`translate(${x + 6} ${ART_TOP})`} aria-hidden="true" pointer-events="none">
      <title>{station}</title>
      <g transform={`translate(0 ${p.h})`}>
        <ellipse className="oi-fm-glow" cx={cx} cy={room} rx={bw * 0.46} ry={Math.max(6, room * 0.06)} />
        {station === "intake" && <Intake box={box} load={L} />}
        {station === "claim" && <Claim box={box} />}
        {station === "build" && <Build box={box} />}
        {station === "gate" && <Gate box={box} />}
        {station === "land" && <Land box={box} count={count === undefined ? Math.round(L * PILE_MAX) : n} />}
      </g>
      {count !== undefined && <g className="oi-fm-plate">
        <text className="oi-fm-num" x={p.numeral.x} y={p.numeral.y} fontSize={p.numeral.fs} textAnchor="middle">{n}</text>
        {split && <g className="oi-fm-split" fontSize={p.split.fs}>
          <circle className="oi-fm-pip wait" cx={p.split.waitX - 8} cy={p.split.y - p.split.fs * 0.32} r={p.split.fs * 0.2}><title>waiting</title></circle>
          <text x={p.split.waitX} y={p.split.y}>{Math.max(0, Math.floor(finite(waiting!)))}</text>
          <path className="oi-fm-pip work" d={`M${p.split.workX - 11} ${p.split.y - p.split.fs * 0.62}l${p.split.fs * 0.42} ${p.split.fs * 0.3}l-${p.split.fs * 0.42} ${p.split.fs * 0.3}Z`}><title>in progress</title></path>
          <text x={p.split.workX + 2} y={p.split.y}>{Math.max(0, Math.floor(finite(working!)))}</text>
        </g>}
      </g>}
    </g>
  );
}

/** The Archived cabinet at the end of the Land dock (Prune animation: `flash` pops a drawer and pulses). Same body, LAND accent. */
export function VaultMachine({ x, w, floorY, count, flash, reduced = false }: { x: number; w: number; floorY: number; count: number; flash: boolean; reduced?: boolean }) {
  const W = Math.max(0, finite(w)), room = Math.max(40, finite(floorY) - ART_TOP), n = Math.max(0, Math.floor(finite(count)));
  const cls = `oi-fm oi-fm-vault oi-fm-land${n > 0 ? " on" : ""}${flash ? " flash" : ""}${reduced ? " still" : ""}`;
  if (W < SLIVER_W) {
    const r = Math.max(2, Math.min(W * 0.3, 8));
    return <g className={`${cls} sliver`} aria-hidden="true" pointer-events="none"><rect className="oi-fm-glyph" x={x + W / 2 - r} y={floorY - 2 * r - 6} width={2 * r} height={2 * r} rx="2"><title>archived</title></rect></g>;
  }
  const g = vault({ w: W - 12, room });
  return <g className={cls} transform={`translate(${x + 6} ${ART_TOP})`} aria-hidden="true" pointer-events="none">
    <title>archived</title>
    <ellipse className="oi-fm-glow" cx={(W - 12) / 2} cy={room} rx={(W - 12) * 0.46} ry={Math.max(6, room * 0.04)} />
    <rect className="oi-fm-body" x={g.body.x} y={g.body.y} width={g.body.w} height={g.body.h} rx="3" />
    <rect className="oi-fm-trim" x={g.foot.x} y={g.foot.y} width={g.foot.w} height={g.foot.h} />
    <rect className="oi-fm-vplate" x={g.plate.x} y={g.plate.y} width={g.plate.w} height={g.plate.h} rx="3" />
    <text className="oi-fm-num" x={g.numeral.x} y={g.numeral.y} fontSize={g.numeral.fs} textAnchor="middle">{n}</text>
    {g.drawers.map((d, i) => <g key={i} className={`oi-fm-drawer d${i}`}><rect className="oi-fm-drawerbox" x={d.x} y={d.y} width={d.w} height={d.h} rx="2" /><rect className="oi-fm-trim" x={g.handles[i].x} y={g.handles[i].y} width={g.handles[i].w} height={g.handles[i].h} rx="1.5" /></g>)}
  </g>;
}

function Intake({ box, load }: { box: Box; load: number }) {
  const g = intake(box, load);
  return <g>
    <path className="oi-fm-body" d={g.hopper} />{g.level && <path className="oi-fm-level" d={g.level} />}
    <rect className="oi-fm-trim" x={g.rim.x} y={g.rim.y} width={g.rim.w} height={g.rim.h} rx="2" />
    <rect className="oi-fm-body" x={g.spout.x} y={g.spout.y} width={g.spout.w} height={g.spout.h} />
    <path className="oi-fm-body" d={g.funnel} />
    <line className="oi-fm-stream" x1={g.stream.x} y1={g.stream.y1} x2={g.stream.x} y2={g.stream.y2} />
    {g.drops.map((d, i) => <circle key={i} className="oi-fm-drop" cx={d.x} cy={d.y} r="3" style={{ ["--i" as string]: i }} />)}
  </g>;
}

function Claim({ box }: { box: Box }) {
  const g = claim(box);
  return <g>
    {g.bins.map((b, i) => <rect key={i} className="oi-fm-bin" x={b.x} y={b.y} width={b.w} height={b.h} rx="2" />)}
    <rect className="oi-fm-body" x={g.base.x} y={g.base.y} width={g.base.w} height={g.base.h} rx="2" />
    <rect className="oi-fm-body" x={g.post.x} y={g.post.y} width={g.post.w} height={g.post.h} />
    <g transform={`translate(${g.pivot.x} ${g.pivot.y})`}><g className="oi-fm-arm" style={{ ["--swing" as string]: `${g.swing}deg` }}>
      <line className="oi-fm-armbar" x1="0" y1="0" x2={g.arm.x2} y2={g.arm.y2} /><circle className="oi-fm-claw" cx={g.claw.x} cy={g.claw.y} r={g.clawR} />
    </g><circle className="oi-fm-hub" cx="0" cy="0" r={Math.max(3, g.clawR)} /></g>
  </g>;
}

function Build({ box }: { box: Box }) {
  const g = build(box);
  return <g>
    {g.cols.map((c, i) => <rect key={i} className="oi-fm-body" x={c.x} y={c.y} width={c.w} height={c.h} rx="2" />)}
    <rect className="oi-fm-trim" x={g.beam.x} y={g.beam.y} width={g.beam.w} height={g.beam.h} rx="2" />
    <path className="oi-fm-body" d={g.anvil} />
    <g className="oi-fm-plunger" style={{ ["--stroke" as string]: `${g.stroke}px` }}>
      <rect className="oi-fm-body" x={g.cylinder.x} y={g.cylinder.y} width={g.cylinder.w} height={g.cylinder.h} />
      <rect className="oi-fm-trim" x={g.head.x} y={g.head.y} width={g.head.w} height={g.head.h} rx="2" />
    </g>
    {g.sparks.map((p, i) => <circle key={i} className="oi-fm-spark" cx={p.x} cy={p.y} r="2.6" style={{ ["--dx" as string]: `${p.dx}px`, ["--dy" as string]: `${p.dy}px`, ["--i" as string]: i }} />)}
  </g>;
}

function Gate({ box }: { box: Box }) {
  const g = gate(box);
  return <g>
    <path className="oi-fm-cone" d={g.cone} />
    {g.pillars.map((p, i) => <rect key={i} className="oi-fm-body" x={p.x} y={p.y} width={p.w} height={p.h} rx="2" />)}
    <path className="oi-fm-arch" d={g.arch} /><rect className="oi-fm-trim" x={g.lintel.x} y={g.lintel.y} width={g.lintel.w} height={g.lintel.h} rx="2" />
    <circle className="oi-fm-lamp" cx={g.lamp.x} cy={g.lamp.y} r={g.lampR} />
    <rect className="oi-fm-beam" x={g.beam.x} y={g.beam.y} width={g.beam.w} height={g.beam.h} rx="1.5" style={{ ["--travel" as string]: `${g.travel}px` }} />
  </g>;
}

function Land({ box, count }: { box: Box; count: number }) {
  const g = land(box, count);
  return <g>
    <rect className="oi-fm-trim" x={g.canopy.x} y={g.canopy.y} width={g.canopy.w} height={g.canopy.h} rx="2" />
    <rect className="oi-fm-body" x={g.door.x} y={g.door.y} width={g.door.w} height={g.door.h} rx="2" />
    {g.slats.map((y, i) => <line key={i} className="oi-fm-slat" x1={g.door.x + 2} x2={g.door.x + g.door.w - 2} y1={y} y2={y} />)}
    <rect className="oi-fm-body" x={g.dock.x} y={g.dock.y} width={g.dock.w} height={g.dock.h} rx="2" />
    {g.pile.map((c, i) => <rect key={i} className="oi-fm-crate" x={c.x} y={c.y} width={c.w} height={c.h} rx="1.5" />)}
  </g>;
}

/** The floor plane with perspective, and the belt's depth (top face, front face, rollers, cast shadow). Mount right after the
 * floor <rect>; the existing belt, return lane and cards draw over it. */
export function FactoryFloorPlane({ W, H, beltY, beltH }: { W: number; H: number; beltY: number; beltH: number }) {
  const p = floorPlane(W, H, beltY, beltH);
  return <g className="oi-fm-floorplane" aria-hidden="true" pointer-events="none">
    <defs><linearGradient id="oi-fm-planegrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="oi-fm-plane0" /><stop offset="1" className="oi-fm-plane1" /></linearGradient>
      <linearGradient id="oi-fm-shadowgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="oi-fm-shade0" /><stop offset="1" className="oi-fm-shade1" /></linearGradient></defs>
    <path className="oi-fm-plane" d={p.plane} fill="url(#oi-fm-planegrad)" />
    {p.hlines.map((y, i) => <line key={`h${i}`} className="oi-fm-pline" x1="0" x2={W} y1={y} y2={y} />)}
    {p.vlines.map((l, i) => <line key={`v${i}`} className="oi-fm-pline" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />)}
    <rect className="oi-fm-bface top" x={p.topFace.x} y={p.topFace.y} width={p.topFace.w} height={p.topFace.h} rx="2" />
    <rect className="oi-fm-bface front" x={p.frontFace.x} y={p.frontFace.y} width={p.frontFace.w} height={p.frontFace.h} />
    {p.rollers.map(x => <line key={x} className="oi-fm-rollline" x1={x} x2={x} y1={p.frontFace.y} y2={p.frontFace.y + p.frontFace.h} />)}
    <rect x={p.shadow.x} y={p.shadow.y} width={p.shadow.w} height={p.shadow.h} fill="url(#oi-fm-shadowgrad)" />
  </g>;
}

/** Styles for the machines and the floor plane; append to factoryFloorStyles. Theme tokens only (the colour fitness scan
 * covers this file); every animation is off under reduced motion (the `live` class is never set, and the media query backs it). */
export const factoryMachinesStyles = `
.oi-fm{--m:var(--tone,var(--oi-tone-running))}
.oi-fm-intake{--m:var(--oi-station-intake,var(--oi-tone-info))}.oi-fm-claim{--m:var(--oi-station-claim,var(--oi-tone-running))}.oi-fm-build{--m:var(--oi-station-build,var(--oi-tone-attention))}.oi-fm-gate{--m:var(--oi-station-gate,var(--oi-accent,var(--oi-lane-2)))}.oi-fm-land{--m:var(--oi-station-land,var(--oi-tone-success))}
.oi-fm-body{fill:var(--oi-machine-body,color-mix(in srgb,var(--oi-text) 8%,var(--oi-panel)));stroke:color-mix(in srgb,var(--m) 78%,transparent);stroke-width:1;stroke-linejoin:round} /* the iso part look: a thin station-hue outline on the shared body */
.oi-fm{filter:drop-shadow(0 0 2px color-mix(in srgb,var(--m) 32%,transparent))}
.oi-fm-trim{fill:color-mix(in srgb,var(--m) 34%,var(--oi-panel));stroke:color-mix(in srgb,var(--m) 60%,var(--oi-border));stroke-width:1}
.oi-fm-level{fill:color-mix(in srgb,var(--m) 46%,transparent)}
.oi-fm-glow{fill:var(--m);opacity:0;filter:blur(6px);transition:opacity .4s}
.oi-fm.on .oi-fm-glow{opacity:.28}
.oi-fm.on .oi-fm-trim{stroke:var(--m)}
.oi-fm:not(.on){opacity:.55}
.oi-fm.jam{--m:var(--oi-tone-attention)}
.oi-fm-num{font-family:var(--oi-font-mono,ui-monospace,monospace);font-weight:800;fill:var(--m);paint-order:stroke;stroke:var(--oi-machine-body,var(--oi-panel));stroke-width:3px;stroke-linejoin:round;filter:drop-shadow(0 0 5px color-mix(in srgb,var(--m) 70%,transparent))}
.oi-fm-split{font-family:var(--oi-font-mono,ui-monospace,monospace);font-weight:700;fill:var(--oi-text)}
.oi-fm-pip.wait{fill:var(--oi-tone-muted)}.oi-fm-pip.work{fill:var(--m)}
.oi-fm-vplate{fill:color-mix(in srgb,var(--m) 30%,var(--oi-bg));stroke:var(--m);stroke-width:1} /* the iso vault door: the station hue over the ground */
.oi-fm-drawerbox{fill:color-mix(in srgb,var(--oi-text) 5%,var(--oi-machine-body,var(--oi-panel)));stroke:color-mix(in srgb,var(--m) 55%,transparent);stroke-width:1}
.oi-fm-vault.flash .oi-fm-glow{opacity:.9}.oi-fm-vault.flash .oi-fm-vplate{stroke-width:2.4}.oi-fm-vault.flash .oi-fm-drawer.d0 .oi-fm-drawerbox{transform:translateY(-4px)}
.oi-fm-vault.flash:not(.still) .oi-fm-glow{animation:oi-fm-pulse .9s ease-out 2}
.oi-fm-glyph{fill:color-mix(in srgb,var(--m) 40%,transparent);stroke:var(--m);stroke-width:1;opacity:.55}
.oi-fm-stream{stroke:color-mix(in srgb,var(--m) 55%,transparent);stroke-width:2;stroke-dasharray:3 4}
.oi-fm-drop{fill:var(--m);opacity:.0}.oi-fm.on .oi-fm-drop{opacity:.85}
.oi-fm.live .oi-fm-drop{animation:oi-fm-fall 1.3s linear infinite;animation-delay:calc(var(--i,0)*.43s)}
.oi-fm-bin{fill:color-mix(in srgb,var(--m) 14%,var(--oi-panel));stroke:color-mix(in srgb,var(--m) 40%,var(--oi-border));stroke-width:1}
.oi-fm-armbar{stroke:var(--m);stroke-width:4;stroke-linecap:round}
.oi-fm-claw{fill:color-mix(in srgb,var(--m) 50%,var(--oi-panel));stroke:var(--m);stroke-width:1.4}
.oi-fm-hub{fill:var(--oi-panel);stroke:var(--m);stroke-width:1.6}
.oi-fm.live .oi-fm-arm{animation:oi-fm-swing 2.6s ease-in-out infinite alternate}
.oi-fm-plunger{transform:translateY(0)}
.oi-fm.live .oi-fm-plunger{animation:oi-fm-press 1.6s cubic-bezier(.5,0,.2,1) infinite}
.oi-fm-spark{fill:var(--oi-tone-attention);opacity:0}
.oi-fm.live .oi-fm-spark{animation:oi-fm-fly 1.6s ease-out infinite;animation-delay:calc(var(--i,0)*.07s + .62s)}
.oi-fm-arch{fill:none;stroke:var(--m);stroke-width:5;stroke-linecap:round;opacity:.8}
.oi-fm-lamp{fill:var(--m);opacity:.5}.oi-fm.on .oi-fm-lamp{opacity:1}
.oi-fm-cone{fill:color-mix(in srgb,var(--m) 14%,transparent);opacity:0}.oi-fm.on .oi-fm-cone{opacity:1}
.oi-fm-beam{fill:var(--m);opacity:.45;filter:drop-shadow(0 0 4px var(--m))}.oi-fm.on .oi-fm-beam{opacity:.95}
.oi-fm.live .oi-fm-beam{animation:oi-fm-scan 2.2s ease-in-out infinite alternate}
.oi-fm-slat{stroke:color-mix(in srgb,var(--m) 40%,var(--oi-border));stroke-width:1}
.oi-fm-crate{fill:color-mix(in srgb,var(--m) 36%,var(--oi-machine-body,var(--oi-panel)));stroke:var(--m);stroke-width:1}
.oi-fm-plane0{stop-color:var(--oi-tone-muted);stop-opacity:.16}.oi-fm-plane1{stop-color:var(--oi-tone-muted);stop-opacity:.02}
.oi-fm-pline{stroke:var(--oi-border);stroke-width:.7;opacity:.5}
.oi-fm-bface.top{fill:color-mix(in srgb,var(--oi-text) 14%,var(--oi-panel));opacity:.8}
.oi-fm-bface.front{fill:color-mix(in srgb,var(--oi-tone-muted) 30%,var(--oi-bg))}
.oi-fm-rollline{stroke:var(--oi-border);stroke-width:1}
.oi-fm-shade0{stop-color:var(--oi-shadow);stop-opacity:.5}.oi-fm-shade1{stop-color:var(--oi-shadow);stop-opacity:0}
@keyframes oi-fm-pulse{0%{opacity:.2}40%{opacity:1}100%{opacity:.5}}
@keyframes oi-fm-fall{0%{transform:translateY(-14px);opacity:0}15%{opacity:.9}100%{transform:translateY(16px);opacity:0}}
@keyframes oi-fm-swing{from{transform:rotate(calc(var(--swing,38deg)*-.6))}to{transform:rotate(var(--swing,38deg))}}
@keyframes oi-fm-press{0%,45%{transform:translateY(0)}60%,68%{transform:translateY(var(--stroke,30px))}100%{transform:translateY(0)}}
@keyframes oi-fm-fly{0%{opacity:0;transform:translate(0,0)}8%{opacity:1}100%{opacity:0;transform:translate(var(--dx,0),var(--dy,-16px))}}
@keyframes oi-fm-scan{from{transform:translateY(0)}to{transform:translateY(var(--travel,60px))}}
@media (prefers-reduced-motion:reduce){.oi-fm *{animation:none!important}.oi-fm-glow{transition:none}}
`;
