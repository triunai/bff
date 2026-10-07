// Pure model for Osiris's centre terminal: default pick, bounded replay, poll backoff, key ownership. No React/DOM.
export type TermStatus="running"|"starting"|"exited"|"disconnected";
export type TermSession={id:string;title:string;status:TermStatus;initialCwd?:string;updatedAt?:number;lastUserInputAt?:number|null;cols?:number;rows?:number};
export type PickResult={id:string|null;reason:string};
const live=(s:TermSession)=>s.status==="running"||s.status==="starting";
const recency=(s:TermSession)=>s.lastUserInputAt??s.updatedAt??0;
export function pickDefaultTerminal(sessions:readonly TermSession[],opts:{preferredId?:string|null;herdrProbe?:Record<string,boolean>}={}):PickResult{
 const alive=sessions.filter(live);
 if(!alive.length)return {id:null,reason:sessions.length?"No running terminal (all exited or disconnected)":"No BB terminals in host scope"};
 const byRecent=(a:TermSession,b:TermSession)=>recency(b)-recency(a)||(a.id<b.id?-1:1);
 const pref=opts.preferredId&&alive.find(s=>s.id===opts.preferredId);
 if(pref)return {id:pref.id,reason:"Your saved choice"};
 const named=alive.filter(s=>/herdr/i.test(s.title)||/herdr/i.test(s.initialCwd??"")).sort(byRecent)[0];
 if(named)return {id:named.id,reason:"Title or cwd mentions herdr"};
 const probe=opts.herdrProbe??{};
 const probed=alive.filter(s=>probe[s.id]).sort(byRecent)[0];
 if(probed)return {id:probed.id,reason:"Recent output mentions herdr"};
 const recent=[...alive].sort(byRecent)[0];
 return {id:recent.id,reason:"Most recently used running terminal (herdr not detected)"};
}
// ---- replay / sequence state ----
export const REPLAY_TAIL_BYTES=256*1024;
/** Steady-state catch-up bound. BB keeps the NEWEST chunks when a bound bites (measured: limitChunks/tailBytes from sinceSeq
 * return the tail and truncated:true), so bound by bytes, never by a small chunk count a TUI burst can exceed. */
export const POLL_TAIL_BYTES=1024*1024;
export const GAP_MARKER="\r\n\x1b[2m[osiris: output gap - earlier bytes dropped]\x1b[0m\r\n";
export type OutputChunk={seq:number;dataBase64:string};
export type OutputResponse={chunks:readonly OutputChunk[];nextSeq:number;truncated:boolean;status:TermStatus;exitCode:number|null;closeReason:string|null};
export type ReplayState={nextSeq:number;started:boolean;gaps:number};
export const initialReplay=():ReplayState=>({nextSeq:0,started:false,gaps:0});
export type ApplyResult={state:ReplayState;data:string[];gap:boolean};
/** Apply one output response. Duplicate chunks (seq<nextSeq) are dropped; truncation after the first response is a visible gap. */
export function applyOutput(state:ReplayState,res:OutputResponse):ApplyResult{
 const sorted=[...res.chunks].sort((a,b)=>a.seq-b.seq);
 const data:string[]=[];let next=state.nextSeq;
 for(const c of sorted){if(c.seq<next)continue;data.push(c.dataBase64);next=c.seq+1;}
 next=Math.max(next,res.nextSeq,state.nextSeq);
 // A gap is evidence-based: the daemon says it truncated, or the first chunk skips past nextSeq.
 const gap=state.started&&(res.truncated||(sorted.length>0&&sorted[0].seq>state.nextSeq));
 return {state:{nextSeq:next,started:true,gaps:state.gaps+(gap?1:0)},data,gap};
}
// ---- poll backoff ----
export const POLL_FAST_MS=40;export const POLL_IDLE_MAX_MS=1000;export const POLL_ERROR_MAX_MS=5000;
export function pollDelay(lastDataAgoMs:number,consecutiveErrors:number):number{
 if(consecutiveErrors>0)return Math.min(POLL_ERROR_MAX_MS,250*2**Math.min(consecutiveErrors-1,5));
 const ago=Math.max(0,lastDataAgoMs);
 if(ago<300)return POLL_FAST_MS;
 return Math.min(POLL_IDLE_MAX_MS,Math.round(POLL_FAST_MS+(ago-300)/4));
}
// ---- keys ----
export type KeyLike={key:string;metaKey?:boolean;ctrlKey?:boolean;altKey?:boolean;shiftKey?:boolean};
/** True when the terminal should consume the key. Cmd/Meta combos stay with BB/Osiris on mac (Super elsewhere). */
export function terminalOwnsKey(e:KeyLike,_isMac:boolean):boolean{
 return !e.metaKey;
}
/** The documented way out of the terminal (owner 17:18: "an obvious escape back to Osiris shortcuts"): Shift+Escape
 * releases keyboard focus. Terminals send plain ESC for Shift+Esc anyway, so no TUI loses a distinct key. Plain Escape
 * stays with the terminal (Herdr/vim need it). */
export const RELEASE_KEY_LABEL="Shift+Esc";
export const isReleaseKey=(e:KeyLike&{type?:string})=>(e.type===undefined||e.type==="keydown")&&e.key==="Escape"&&!!e.shiftKey&&!e.metaKey&&!e.ctrlKey&&!e.altKey;
/** The PTY is shared with BB's native terminal panel, so Osiris writes to it only while the user is engaged here.
 * xterm also answers device queries (DA/CPR/focus) through onData: forwarding those during the history replay, or
 * while the terminal is unfocused, would type stray replies into the live shell (review-1 F1). */
export const shouldForwardInput=(o:{replaying:boolean;focused:boolean})=>!o.replaying&&o.focused;
/** Who decides the PTY size: the session's own size until the user locks it or has not yet engaged (focus/Redraw);
 * the pane only after an explicit engagement, so merely opening Osiris never resizes Herdr (review-1 F4). */
export const sizeOwner=(o:{locked:boolean;claimed:boolean}):"session"|"pane"=>o.locked||!o.claimed?"session":"pane";
/** Owner 17:18: the centre DEFAULTS to the live terminal; Sessions is the secondary toggle; his last choice persists.
 * Only an explicit stored "sessions" opens Sessions — first open, cleared storage or junk all mean Terminal. */
export type CentreMode="terminal"|"sessions";
export const CENTRE_MODE_KEY="osiris-centre-mode";
export const centreModeFromStorage=(stored:string|null|undefined):CentreMode=>stored==="sessions"?"sessions":"terminal";
/** Terminal text size (owner 22:53: "a little bigger"). Default raised 12 -> 13px; the View menu steps it within 11-20px and
 * persists it. Line height stays xterm's 1.0 so TUI box-drawing (Herdr) has no gaps between rows. */
export const TERM_FONT_MIN=11,TERM_FONT_MAX=20,TERM_FONT_DEFAULT=13,TERM_FONT_KEY="osiris-terminal-font-size";
export const clampFontSize=(n:number)=>Number.isFinite(n)?Math.min(TERM_FONT_MAX,Math.max(TERM_FONT_MIN,Math.round(n))):TERM_FONT_DEFAULT;
export const fontSizeFromStorage=(stored:string|null|undefined)=>stored==null||stored.trim()===""?TERM_FONT_DEFAULT:clampFontSize(Number(stored));
export const stepFontSize=(current:number,delta:number)=>clampFontSize(current+delta);
// ---- codecs ----
export function base64ToBytes(b64:string):Uint8Array{const bin=atob(b64);const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}
export function bytesToBase64(bytes:Uint8Array):string{let s="";for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(s);}
export const utf8ToBase64=(text:string)=>bytesToBase64(new TextEncoder().encode(text));
export const base64ToText=(b64:string)=>new TextDecoder().decode(base64ToBytes(b64));
/** Strip control characters (incl. ESC, newlines) from picker labels. */
export function sanitizeLabel(text:string,max=60):string{const t=text.replace(/[\u0000-\u001f\u007f-\u009f]+/g," ").replace(/\s+/g," ").trim();return t.length>max?t.slice(0,max-1)+"…":t;}
/** Remove ANSI escape sequences (CSI, OSC, single ESC) for text probing. */
export function stripAnsi(text:string):string{
 return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,"").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/\x1b[@-Z\\-_]/g,"");
}
export const PROBE_TAIL_BYTES=16384;
export const looksLikeHerdr=(b64:string)=>/herdr/i.test(stripAnsi(base64ToText(b64)));
export const shortTerminalId=(id:string)=>id.replace(/^term_/,"").slice(0,8);
/** Plain-words panel text when no BB terminal can be attached: WHY, then the ONE next action. Osiris never creates a terminal,
 * and Herdr panes started outside BB are not BB terminals, so they cannot be attached here. */
export function noTerminalMessage(o:{total:number;listErrors:number;listError?:string|null;herdrPanes?:number|null}):string{
 const why=o.listErrors>0?`BB would not list terminals (${(o.listError??"unknown error").slice(0,100)}). Press Rediscover (↻) to retry.`
  :o.total>0?`BB has ${o.total} terminal${o.total===1?"":"s"}, all exited or disconnected.`:"BB has no terminals open.";
 const herdr=o.herdrPanes?` Herdr is running outside BB with ${o.herdrPanes} pane${o.herdrPanes===1?"":"s"}, which Osiris cannot attach (see TERMINALS in the sidebar).`:"";
 return o.listErrors>0?why:`${why}${herdr} Open a terminal in BB, run \`herdr\` in it, then press Rediscover (↻).`;
}
/** The host a "Start Herdr" terminal may be created on: this machine only. The server validated the herdr path and cwd on its OWN
 * disk, so a remote/cloud host (machineProviderId set), an ephemeral one, or a disconnected one is never chosen. */
export type HostLike={id:string;type:string;status:string;machineProviderId:string|null};
export function pickLocalHost(hosts:readonly HostLike[]):string|null{
 return hosts.find(h=>h.type==="persistent"&&h.status==="connected"&&h.machineProviderId==null)?.id??null;
}
/** The ONE command a missing or untrusted Herdr needs, taken from the plain-words message (null for any other failure, so no button is offered).
 * Pure and client-safe: the server wording is the single source, this only recognises it. */
export const HERDR_INSTALL_COMMAND="brew install herdr";
export const herdrFixCommand=(message:string|null|undefined):string|null=>message&&/brew install herdr/.test(message)?HERDR_INSTALL_COMMAND:null;
// ---- launch-plan stamp (td-osi.12): which herdr session a persisted Osiris terminal was started on ----
/** Bump when the launch plan's session semantics change. A terminal stamped with an older version is stale. */
export const HERDR_PLAN_VERSION=2;
export const OSIRIS_HERDR_TITLE="Herdr (Osiris)";
export const HERDR_DEFAULT_SESSION="default";
/** The legacy session an older Osiris created (`herdr --session osiris`). */
export const LEGACY_HERDR_SESSION="osiris";
export type HerdrStamp={plan:number;session:string};
export const herdrSessionIdentity=(picked:string|null|undefined):string=>picked||HERDR_DEFAULT_SESSION;
/** reuse only when the stamp exists, carries the current plan version and names the configured session. A missing stamp is a pre-fix terminal. */
export const stampVerdict=(stamp:HerdrStamp|null|undefined,picked:string|null|undefined):"reuse"|"stale"=>stamp&&stamp.plan===HERDR_PLAN_VERSION&&stamp.session===herdrSessionIdentity(picked)?"reuse":"stale";
/** Only terminals Osiris itself titled are judged; the user's own BB terminals are never touched. */
export const isOsirisHerdrTerminal=(title:string):boolean=>title===OSIRIS_HERDR_TITLE;
export const isOsirisSessionStampName=(n:string):boolean=>n===HERDR_DEFAULT_SESSION||/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(n);
export const HERDR_STOP_LEGACY_COMMAND=`herdr session stop ${LEGACY_HERDR_SESSION}`;
/** Text-only hint for the picker; a command is shown and copied, never run. */
export function herdrSessionHint(name:string):string|null{
 if(name===LEGACY_HERDR_SESSION)return `created by an older Osiris; safe to stop with \`${HERDR_STOP_LEGACY_COMMAND}\``;
 return null;
}
export const herdrSessionLabel=(name:string):string=>name===HERDR_DEFAULT_SESSION?"Default (your usual session)":name===LEGACY_HERDR_SESSION?`${name} (older Osiris)`:name;
export const staleBannerText=(stamp:HerdrStamp|null|undefined,picked:string|null|undefined):string=>
 !stamp||stamp.session===LEGACY_HERDR_SESSION?`This terminal is on the old '${LEGACY_HERDR_SESSION}' Herdr session, not your default one.`:`This terminal is on the '${stamp.session}' Herdr session, not '${herdrSessionIdentity(picked)}'.`;

/** Herdr session mismatch hint (lane DET). Panes started by `bff osiris` land in a SEPARATE named session ("osiris"), while this tab attaches the default
 *  one unless told otherwise, so their panes do not show here. `selected` is "" for the default session; `names` are the named sessions herdr
 *  reports. Null when nothing is hidden. (Distinct from herdrSessionHint above, which describes the legacy session as a stale leftover.) */
export function hiddenBffSessionHint(selected:string,names:readonly string[]):string|null{
 if(selected!==""||!names.includes(LEGACY_HERDR_SESSION))return null;
 return "Panes started by bff run in the \"osiris\" Herdr session, but this tab shows your default session, so they are hidden. Pick \"osiris\" in the Herdr session list to see them.";
}

// ---- moved from herdr-feed.ts (browser-safe pure parsing; herdr-feed re-exports). The name rule is a pinned copy of herdr-feed.ts HERDR_SESSION_NAME. ----
const isHerdrSessionName = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(n);
export type HerdrSessionRow = { name: string; running: boolean; socket: string };
/** Same table, keeping the SOCKET column (the session's real identity). Null when the shape is unknown or any row lacks a socket path: callers fail closed. */
export function parseSessionRows(stdout: string): HerdrSessionRow[] | null {
  const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length || !/^name\s+status\s+directory\s+socket\b/i.test(lines[0])) return null;
  const out: HerdrSessionRow[] = [];
  for (const l of lines.slice(1)) {
    const t = l.split(/\s+/), socket = t[t.length - 1];
    if (t.length < 4 || !isHerdrSessionName(t[0]) || !(t[1] === "running" || t[1] === "stopped") || !socket.startsWith("/")) return null;
    out.push({ name: t[0], running: t[1] === "running", socket });
  }
  return out;
}
