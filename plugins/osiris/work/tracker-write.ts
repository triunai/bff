// The Board's drag-and-drop write: the SECOND (and last) beads write Osiris makes, added deliberately at the owner's request
// ("I can't manually intervene to drag and drop", 2026-10-07, td-osi.12). The first is dispatch's claim.
//   - argv ONLY, no shell. The id passes BEAD_ID_RE, the status is one of three literals, the note is one argv element behind its flag.
//   - Only the statuses a board column maps to can be written; "closed" and every other status are unreachable from here.
//   - Server-only caller: the RPC refuses plugin callers and asserts the repo, like dispatch. Tests inject a fake runner; no real tracker is touched.
import { BEAD_ID_RE } from "./runtime-models.ts";
import { cleanText, redactSecrets } from "./sanitize.ts";
import type { Lane } from "./surface-types.ts";
import type { Exec } from "./dispatch.ts";

export const MOVE_STATUSES = ["open", "in_progress", "blocked"] as const;
export type MoveStatus = (typeof MOVE_STATUSES)[number];
/** The ONE bd status a column stands for. null = the column is derived (review, action required), so it is NOT a drop target. */
export const LANE_STATUS: Readonly<Record<Lane, MoveStatus | null>> = Object.freeze({ action: null, ready: "open", in_progress: "in_progress", review: null, blocked: "blocked" });
export const droppable = (lane: Lane): boolean => LANE_STATUS[lane] !== null;
export const NOTE_MAX = 300;
export const NOTE_PREFIX = "Blocked (via Osiris board): ";
export const isMoveStatus = (s: unknown): s is MoveStatus => typeof s === "string" && (MOVE_STATUSES as readonly string[]).includes(s);
export const isMoveId = (s: unknown): s is string => typeof s === "string" && s.length <= 64 && BEAD_ID_RE.test(s);

/** bd's compare-and-set (`--if-status`): the status the card was dragged FROM. Any bd status is allowed (the board may hold a bead in one it cannot write), but never flag-shaped. */
export const isIfStatus = (s: unknown): s is string => typeof s === "string" && /^[a-z][a-z_]{0,31}$/.test(s);
/** bd exits 13 when an --if-status guard no longer held (nothing was written). */
export const CAS_EXIT = 13;
export const CAS_MESSAGE = "This card changed since you loaded the board; refresh";

export type MoveArgv = { ok: true; argv: string[] } | { ok: false; reason: string };
/** The exact bd argv for one move, guarded by `--if-status <from>` so a stale board cannot clobber a concurrent change. A note is honoured only for "blocked"; it is cleaned, bounded and always starts with a fixed prefix (never a flag-shaped value). */
export function moveArgv(id: unknown, status: unknown, note?: unknown, ifStatus?: unknown): MoveArgv {
  if (!isMoveId(id)) return { ok: false, reason: "that is not a valid bead id" };
  if (!isMoveStatus(status)) return { ok: false, reason: "that status cannot be set from the board" };
  if (!isIfStatus(ifStatus)) return { ok: false, reason: "the card's current status is missing; refresh the board" };
  const head = ["update", id, "--status", status, "--if-status", ifStatus];
  if (status !== "blocked" || note === undefined || note === null || note === "") return { ok: true, argv: head };
  if (typeof note !== "string") return { ok: false, reason: "the reason must be text" };
  const text = cleanText(note, NOTE_MAX).replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "the reason must be text" };
  return { ok: true, argv: [...head, "--append-notes", NOTE_PREFIX + text] };
}

export type MoveResult = { ok: true } | { ok: false; reason: string };
const inFlight = new Set<string>();
/** Run one move. `bd` is the reviewed bd runner (work/dispatch.ts defaultDeps().bd). A second move of the same bead while one runs is refused. */
export async function runTrackerMove(req: { repo: string; id: unknown; status: unknown; note?: unknown; ifStatus?: unknown }, bd: Exec): Promise<MoveResult> {
  const a = moveArgv(req.id, req.status, req.note, req.ifStatus);
  if (!a.ok) return a;
  const id = req.id as string;
  if (inFlight.has(id)) return { ok: false, reason: "that bead is already being moved; wait a moment" };
  inFlight.add(id);
  try {
    const r = await bd(a.argv, { cwd: req.repo, timeoutMs: 20_000 });
    if (r.code === 0) return { ok: true };
    if (r.code === CAS_EXIT) return { ok: false, reason: CAS_MESSAGE };
    return { ok: false, reason: `bd refused the change: ${redactSecrets(cleanText(r.stderr || r.stdout || `exit ${r.code}`, 300))}` };
  } catch (e) { return { ok: false, reason: `bd could not run: ${redactSecrets(cleanText(String((e as Error)?.message ?? e), 200))}` }; }
  finally { inFlight.delete(id); }
}

// ---- client-side planning (pure) ----
export type MovePlan = { ok: true; id: string; status: MoveStatus; prev: MoveStatus | null; /** the bd status the card has now: the compare-and-set value for this move */ from: string; needsReason: boolean } | { ok: false; reason: string };
/** What dropping a card on a column means. `prevStatus` is the bead's current bd status (the undo writes it back when it is one the board can write; it is also the compare-and-set value). */
export function planMove(card: { id: string; lane: Lane }, to: Lane, prevStatus: string | null | undefined): MovePlan {
  const status = LANE_STATUS[to];
  if (status === null) return { ok: false, reason: "That column is worked out from the cards, so nothing can be dropped on it." };
  if (card.lane === to) return { ok: false, reason: "That card is already in this column." };
  if (!isMoveId(card.id)) return { ok: false, reason: "that is not a valid bead id" };
  if (!isIfStatus(prevStatus)) return { ok: false, reason: "That card's status is unknown; refresh the board." };
  if (prevStatus === status) return { ok: false, reason: "That card already has this status." };
  return { ok: true, id: card.id, status, prev: isMoveStatus(prevStatus) ? prevStatus : null, from: prevStatus, needsReason: status === "blocked" };
}
/** Undo = write the previous status back. Null when there is nothing safe to write. Guarded by the status the move wrote, so an undo cannot clobber a later change. */
export const undoOf = (p: Extract<MovePlan, { ok: true }>): { id: string; status: MoveStatus; ifStatus: MoveStatus } | null => (p.prev ? { id: p.id, status: p.prev, ifStatus: p.status } : null);
export const EDIT_KEY = "osiris.board.edit";
/** The "edit the board" setting: defaults ON (owner's request); only an explicit "off" disables it. */
export const readEditSetting = (get: (k: string) => string | null | undefined): boolean => { try { return get(EDIT_KEY) !== "off"; } catch { return true; } };
