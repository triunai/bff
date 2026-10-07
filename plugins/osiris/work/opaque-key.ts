// Opaque fleet keys (pure, no node imports: the server seals with it, the client re-keys with it). Codex R4 M1 (2026-10-07): raw session
// ids left the server as fleet lane keys, parent keys, name-index keys, the short-id label fallback and message laneKey / from / to.
// The fleet MODEL stays raw-keyed (its join with beads and messages needs the real ids); sealFleet is the ONE boundary, applied to every
// fleet payload the server returns (fleetSnapshot, WorkTelemetry.fleet). The per-process salt ships with the payload so the client can
// re-key lanes to the raw call ids it ALREADY holds (the capture / BB call feeds carry them); an id the client does not hold stays opaque.
import { agentTag, fallbackLabel } from "./agent-identity.ts";
import type { FleetName, FleetSnapshot, MessageEvent } from "./fleet-types.ts";

/** SHA-256 (FIPS 180-4), pure and synchronous so server and client derive the same key. Review-opaque M3: with the salt shipped, a
 *  non-cryptographic hash let a 64-bit agent id be recovered by meet-in-the-middle; SHA-256 leaves only brute force over the id space. */
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text), bits = msg.length * 8, n = (((msg.length + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(n); buf.set(msg); buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer); dv.setUint32(n - 8, Math.floor(bits / 0x100000000)); dv.setUint32(n - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64);
  const rot = (x: number, r: number) => (x >>> r) | (x << (32 - r));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) >>> 0; }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0, t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, x => x.toString(16).padStart(8, "0")).join("");
}
/** `k` + 28 hex chars of SHA-256(salt NUL raw). Same raw id + same salt = same key; nothing of the raw id survives. */
export const opaqueKey = (raw: string, salt: string): string => `k${sha256Hex(`${salt}\u0000${raw}`).slice(0, 28)}`;
/** Shapes of ids that may appear as a message sender/recipient: agent ids (a + 16-17 hex, a<name>-<16 hex>, agent- prefixed), uuids. */
const ID_SHAPE = /^(agent-)?a[0-9a-f]{16,17}$|^(agent-)?a[A-Za-z0-9._-]+-[0-9a-f]{16}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A name-index entry made from an id keeps its provider prefix; only the tag is re-derived from the sealed key. */
const retag = (label: string, raw: string, sealed: string) => label.replace(agentTag(raw), agentTag(sealed));
/** Ids embedded in free text: Claude Code names an isolated subagent's worktree `.claude/worktrees/agent-<agentId>`, so a workspace, a label
 *  derived from it, or a branch can carry the raw id (found on the real disk, 16 lanes). Any uuid or run of 16+ hex chars becomes a short tag. */
const EMBEDDED_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/gi;
const tag = (m: string, salt: string) => `#${opaqueKey(m.toLowerCase(), salt).slice(1, 7)}`;
/** Short-id forms of KNOWN ids (review-opaque M2): the 8-hex prefix of a hex agent id / uuid, and of a teammate id's 16-hex suffix. Only hex
 *  forms, so a teammate's lane name (`atooldash-lead-…`) never turns a real word into a tag. Prefix -> the full raw key. */
export function idPrefixes(keys: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) {
    const bare = key.replace(/^agent-/, ""), hex = /^a?([0-9a-f]{16,17})$/i.exec(bare)?.[1] ?? /^a.+-([0-9a-f]{16})$/i.exec(bare)?.[1] ?? (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(bare) ? bare : null);
    if (hex) out.set(hex.slice(0, 8).toLowerCase(), key);
  }
  return out;
}
/** Free text -> ids replaced by short tags: uuids and 16+ hex runs, then known 8-hex prefixes as whole hex tokens. */
export function scrubIds(s: string | null, salt: string, prefixes: ReadonlyMap<string, string> = new Map()): string | null {
  if (s === null) return null;
  const out = s.replace(EMBEDDED_ID, m => tag(m, salt));
  return prefixes.size ? out.replace(/(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/gi, m => (prefixes.has(m.toLowerCase()) ? tag(prefixes.get(m.toLowerCase())!, salt) : m)) : out;
}

/** The ONE server boundary: every id-bearing field becomes opaque. Labels that came from the id (labelFrom "id") are re-derived. */
export function sealFleet(f: FleetSnapshot, salt: string): FleetSnapshot & { keySalt: string } {
  const raw = new Set<string>([...f.lanes.map(l => l.key), ...(f.names ?? []).map(n => n.key)]), pre = idPrefixes(raw);
  const k = (id: string | null) => (id === null ? null : opaqueKey(id, salt));
  const scrub = (t: string | null, _salt: string) => scrubIds(t, salt, pre);
  const name = (s: string) => (raw.has(s) || ID_SHAPE.test(s) ? opaqueKey(s.replace(/^agent-/, ""), salt) : pre.has(s.toLowerCase()) ? opaqueKey(pre.get(s.toLowerCase())!, salt) : scrub(s, salt)!);
  // Explicit field type: a quoted lane-text key would trip the bd-write tripwire in dispatch.test (same trap as FleetName).
  const text = (l: { label: string; workspace: string | null; branch: string | null }): { label: string; workspace: string | null; branch: string | null } =>
    ({ label: scrub(l.label, salt)!, workspace: scrub(l.workspace, salt), branch: scrub(l.branch, salt) });
  const lane = <T extends FleetName & { labelFrom?: string; runtime?: string }>(l: T): T => {
    const key = opaqueKey(l.key, salt);
    return { ...l, ...text(l), key, parentKey: k(l.parentKey), ...(l.labelFrom === "id" ? { label: fallbackLabel(key, l.runtime) } : {}) };
  };
  const names = f.names?.map(n => { const key = opaqueKey(n.key, salt), fromId = n.label.includes(agentTag(n.key)); return { ...n, ...text(n), key, parentKey: k(n.parentKey), ...(fromId ? { label: retag(n.label, n.key, key) } : {}) }; });
  const messages = f.messages?.map((m: MessageEvent) => ({ ...m, laneKey: opaqueKey(m.laneKey, salt), from: name(m.from), to: name(m.to), summary: scrub(m.summary, salt) }));
  return { ...f, lanes: f.lanes.map(lane), ...(names ? { names } : {}), ...(messages ? { messages } : {}), keySalt: salt };
}

/** Client side: map opaque keys back to the raw call ids this client already holds, so tool calls still join their lanes. */
export function rekeyFleet<F extends FleetSnapshot & { keySalt?: string }>(f: F | null, rawIds: Iterable<string>): F | null {
  if (!f || !f.keySalt) return f;
  const back = new Map<string, string>();
  for (const id of rawIds) for (const r of [id, id.replace(/^agent-/, "")]) back.set(opaqueKey(r, f.keySalt), id);
  const b = (s: string) => back.get(s) ?? s, bn = (s: string | null) => (s === null ? null : b(s));
  return {
    ...f,
    lanes: f.lanes.map(l => ({ ...l, key: b(l.key), parentKey: bn(l.parentKey) })),
    ...(f.names ? { names: f.names.map(n => ({ ...n, key: b(n.key), parentKey: bn(n.parentKey) })) } : {}),
    ...(f.messages ? { messages: f.messages.map(m => ({ ...m, laneKey: b(m.laneKey), from: b(m.from), to: b(m.to) })) } : {}),
  };
}

/** The whole workTelemetry answer (review-opaque M1): the fleet via sealFleet, plus every lane-name string outside it (cost lanes, miss events,
 *  beads, transcriptLive, coverage.unmatched) through the same id scrub, keyed by the fleet's known ids. */
export function sealWorkTelemetry<W extends { fleet?: FleetSnapshot; lanes?: { lane: string }[]; missEvents?: { lane: string }[]; byDay?: { topAgents: { lane: string }[] }[]; efficiency?: { agents: { lane: string }[]; nearWrap: { lane: string }[]; bigOutputs: { lane: string }[]; repeatedReads: { lane: string }[] }; beads: { lane: string | null }[]; transcriptLive: Record<string, { lane: string; lastAt: number }>; coverage: { unmatched: { lane: string; reason: string }[] } }>(w: W, salt: string): W {
  const pre = idPrefixes([...(w.fleet?.lanes ?? []).map(l => l.key), ...(w.fleet?.names ?? []).map(n => n.key)]);
  const sc = (t: string) => scrubIds(t, salt, pre)!;
  return {
    ...w,
    ...(w.fleet ? { fleet: sealFleet(w.fleet, salt) } : {}),
    ...(w.lanes ? { lanes: w.lanes.map(l => ({ ...l, lane: sc(l.lane) })) } : {}),
    ...(w.byDay ? { byDay: w.byDay.map(d => ({ ...d, topAgents: d.topAgents.map(a => ({ ...a, lane: sc(a.lane) })) })) } : {}),
    ...(w.missEvents ? { missEvents: w.missEvents.map(m => ({ ...m, lane: sc(m.lane) })) } : {}),
    ...(w.efficiency ? { efficiency: { ...w.efficiency, agents: w.efficiency.agents.map(x => ({ ...x, lane: sc(x.lane) })), nearWrap: w.efficiency.nearWrap.map(x => ({ ...x, lane: sc(x.lane) })), bigOutputs: w.efficiency.bigOutputs.map(x => ({ ...x, lane: sc(x.lane) })), repeatedReads: w.efficiency.repeatedReads.map(x => ({ ...x, lane: sc(x.lane) })) } } : {}),
    beads: w.beads.map(b => ({ ...b, lane: b.lane === null ? null : sc(b.lane) })),
    transcriptLive: Object.fromEntries(Object.entries(w.transcriptLive).map(([id, v]) => [id, { ...v, lane: sc(v.lane) }])),
    coverage: { ...w.coverage, unmatched: w.coverage.unmatched.map(u => ({ ...u, lane: sc(u.lane) })) },
  };
}
