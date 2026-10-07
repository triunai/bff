import type {ReactNode} from "react";
import {useCallback,useEffect,useRef,useState} from "react";
import {useRpc,useSdk} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "../server";
import type {GuardResult} from "../work/seam-guards/types.ts";
import {terminalBridge,type BridgedAgent} from "../terminal-bridge.ts";
import {detectAgent} from "../sidebar-model.ts";
import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {copyWithToast} from "../work/copy-toast.ts";
import {TerminalGuardCard,terminalGuardStyles} from "./terminal-guard-card.tsx";
import {MenuSelect} from "./ui/menu-select.tsx";
import {herdrFixCommand,noTerminalMessage,pickLocalHost,GAP_MARKER,PROBE_TAIL_BYTES,REPLAY_TAIL_BYTES,POLL_TAIL_BYTES,applyOutput,base64ToBytes,base64ToText,stripAnsi,initialReplay,looksLikeHerdr,pickDefaultTerminal,pollDelay,shouldForwardInput,isReleaseKey,RELEASE_KEY_LABEL,sizeOwner,sanitizeLabel,shortTerminalId,terminalOwnsKey,utf8ToBase64,type TermSession,TERM_FONT_DEFAULT,clampFontSize,stampVerdict,isOsirisHerdrTerminal,herdrSessionIdentity,herdrSessionHint,hiddenBffSessionHint,herdrSessionLabel,staleBannerText,HERDR_STOP_LEGACY_COMMAND,LEGACY_HERDR_SESSION,type HerdrStamp} from "../terminal-model.ts";
type Sess=TermSession&{cols:number;rows:number;exitCode?:number|null;closeReason?:string|null};
const KEY="osiris-centre-terminal",GAP_REDRAW_MIN_MS=2000,MAX_LIST_CALLS=8,MAX_PROBES=6,SCROLLBACK=5000,RESIZE_DEBOUNCE_MS=120;
const load=()=>{try{return localStorage.getItem(KEY)}catch{return null}};
const save=(id:string)=>{try{localStorage.setItem(KEY,id)}catch{}};
// Which herdr session "Start Herdr in Osiris" attaches. "" = the user's own default session (their normal tabs). Persisted per user; the server re-validates the name.
const SESSION_KEY="osiris-herdr-session";
const NAME_OK=/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const loadSession=()=>{try{const v=localStorage.getItem(SESSION_KEY);return v&&NAME_OK.test(v)?v:""}catch{return ""}};
const saveSession=(v:string)=>{try{if(v)localStorage.setItem(SESSION_KEY,v);else localStorage.removeItem(SESSION_KEY)}catch{}};
const isMac=typeof navigator!=="undefined"&&/Mac/i.test(navigator.platform);
const sleep=(ms:number,signal:AbortSignal)=>new Promise<void>(res=>{const t=setTimeout(res,ms);signal.addEventListener("abort",()=>{clearTimeout(t);res()},{once:true})});
const resolveColor=(el:HTMLElement,v:string,fb:string)=>{const p=document.createElement("span");p.style.color=`var(${v},${fb})`;el.appendChild(p);const c=getComputedStyle(p).color;p.remove();return c||fb};
const theme=(el:HTMLElement)=>({background:resolveColor(el,"--oi-bg","Canvas"),foreground:resolveColor(el,"--oi-text","CanvasText"),cursor:resolveColor(el,"--oi-tone-info","AccentColor"),selectionBackground:resolveColor(el,"--oi-selected","Highlight")});
type Phase={kind:"discovering"}|{kind:"none"}|{kind:"attaching"}|{kind:"attached"}|{kind:"exited";exitCode:number|null;closeReason:string|null}|{kind:"retry";error:string}|{kind:"error";error:string};
export function CentreTerminal({visible,leading,trailing,fontSize=TERM_FONT_DEFAULT}:{visible:boolean;leading?:ReactNode;trailing?:ReactNode;fontSize?:number}){
 const sdk=useSdk(),rpc=useRpc<typeof rpcContract>();
 const [emptyMsg,setEmptyMsg]=useState<string|null>(null);
 const [startState,setStartState]=useState<{busy:boolean;cooling:boolean;error:string|null}>({busy:false,cooling:false,error:null});
 const startingRef=useRef(false);
 const [session,setSession]=useState<string>(loadSession);
 const [sessionNames,setSessionNames]=useState<string[]>([]);
 const [guard,setGuard]=useState<Extract<GuardResult,{ok:false}>|null>(null);
 const [stale,setStale]=useState<{id:string;text:string}[]>([]);
 const [sessions,setSessions]=useState<Sess[]>([]);
 const [selected,setSelected]=useState<string|null>(null);
 const [reason,setReason]=useState("");
 const [phase,setPhase]=useState<Phase>({kind:"discovering"});
 const [locked,setLocked]=useState(false);
 const [nonce,setNonce]=useState(0);
 const [claimed,setClaimed]=useState(false);
 const [inputError,setInputError]=useState<string|null>(null);
 const [discoverNonce,setDiscoverNonce]=useState(0);
 const [probedIds,setProbedIds]=useState<ReadonlySet<string>>(new Set());
 const [menuOpen,setMenuOpen]=useState(false);
 const lineRef=useRef<HTMLDivElement>(null);
 const menuBtnRef=useRef<HTMLButtonElement>(null);
 const hostRef=useRef<HTMLDivElement>(null);
 const visibleRef=useRef(visible);visibleRef.current=visible;
 const lockedRef=useRef(locked);lockedRef.current=locked;
 const actionsRef=useRef<{redraw:()=>void;applySize:()=>void;claimIfFocused:()=>void;applyFont:(n:number)=>void;onShow:()=>void;focus:()=>boolean}>({redraw(){},applySize(){},claimIfFocused(){},applyFont(){},onShow(){},focus(){return false}});
 const fontRef=useRef(fontSize);
 // Discovery: hosts -> host_path terminal lists (bounded) -> optional herdr output probe -> default pick.
 useEffect(()=>{
  const ac=new AbortController();setPhase({kind:"discovering"});
  (async()=>{
   try{
    const hosts=await sdk.hosts.list();
    const byId=new Map<string,Sess>();let calls=0,listErrors=0,listError:string|null=null;
    for(const h of hosts.slice(0,MAX_LIST_CALLS)){if(calls++>=MAX_LIST_CALLS)break;try{const r=await sdk.terminals.list({scope:{kind:"host_path",hostId:h.id},signal:ac.signal});for(const s of r.sessions)byId.set(s.id,s as Sess)}catch(e){if(ac.signal.aborted)return;listErrors++;listError=String((e as Error)?.message??e)}}
    const all=[...byId.values()];if(ac.signal.aborted)return;
    const saved=load();const probe:Record<string,boolean>={},agents:Record<string,BridgedAgent>={};
    // Bounded, read-only output probe of up to MAX_PROBES running terminals: it both finds Herdr for the default pick and
    // labels each terminal's agent (herdr / claude / codex) for the left sidebar. Title/cwd decide when the tail is unread.
    const running=new Set(all.filter(s=>s.status==="running").slice(0,MAX_PROBES).map(s=>s.id));
    // Probes run in parallel (still bounded to MAX_PROBES reads) so discovery is not delayed by sequential round trips.
    const tails=new Map<string,string>();
    await Promise.all(all.filter(s=>running.has(s.id)).map(async s=>{try{const o=await sdk.terminals.output({terminalId:s.id,tailBytes:PROBE_TAIL_BYTES,signal:ac.signal});tails.set(s.id,stripAnsi(o.chunks.map(c=>base64ToText(c.dataBase64)).join("")));probe[s.id]=o.chunks.some(c=>looksLikeHerdr(c.dataBase64))}catch{}}));
    if(ac.signal.aborted)return;
    for(const s of all)agents[s.id]=detectAgent({title:s.title,cwd:s.initialCwd??"",tail:tails.get(s.id)??""});
    // td-osi.12: an Osiris-made herdr terminal with no stamp (pre-fix) or a stamp for another session/plan is never reused silently; it is held out of the pick and offered a one-click switch.
    let stamps:Record<string,HerdrStamp>={};try{stamps=(await rpc.call("herdrStamps",{})).stamps as Record<string,HerdrStamp>}catch{}
    if(ac.signal.aborted)return;
    const staleList=all.filter(s=>(s.status==="running"||s.status==="starting")&&isOsirisHerdrTerminal(s.title)&&stampVerdict(stamps[s.id],loadSession())==="stale").map(s=>({id:s.id,text:staleBannerText(stamps[s.id],loadSession())}));
    const staleIds=new Set(staleList.map(x=>x.id));setStale(staleList);
    const pick=pickDefaultTerminal(all.filter(s=>!staleIds.has(s.id)),{preferredId:saved,herdrProbe:probe});
    if(!pick.id){let panes:number|null=null;try{const h=await rpc.call("herdrPanes",{});panes=h.state==="live"?h.panes.length:null}catch{}if(ac.signal.aborted)return;setEmptyMsg(noTerminalMessage({total:all.length,listErrors,listError,herdrPanes:panes}))}else setEmptyMsg(null);
    terminalBridge.publish({terminals:all.map(s=>({id:s.id,title:s.title,status:s.status,initialCwd:s.initialCwd??"",agent:agents[s.id]??null}))});
    setSessions(all);setProbedIds(new Set(Object.keys(probe).filter(k=>probe[k])));setSelected(pick.id);setReason(pick.reason);setPhase(pick.id?{kind:"attaching"}:{kind:"none"});
   }catch(e){if(!ac.signal.aborted)setPhase({kind:"error",error:String((e as Error)?.message??e)})}
  })();
  return()=>ac.abort();
 },[sdk,rpc,discoverNonce]);
 // Attach by verified id; poll output; cleanup on id change / unmount.
 useEffect(()=>{
  const host=hostRef.current;if(!selected||!host)return;
  const id=selected,ac=new AbortController();
  const term=new Terminal({scrollback:SCROLLBACK,cursorBlink:true,fontSize:fontRef.current,lineHeight:1,allowProposedApi:false,theme:theme(host),fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"});
  const fit=new FitAddon();term.loadAddon(fit);
  let size={cols:0,rows:0},debounce:ReturnType<typeof setTimeout>|undefined,queue:Promise<unknown>=Promise.resolve(),lastActive=Date.now(),replaying=true,engaged=false;
  setClaimed(false);setInputError(null);
  const owner=()=>sizeOwner({locked:lockedRef.current,claimed:engaged});
  const send=(data:string)=>{
   if(!shouldForwardInput({replaying,focused:!!document.activeElement&&host.contains(document.activeElement)}))return;
   lastActive=Date.now();
   // Input failures have their own status: the poll loop must not wipe them, and they must not mask "Exited" (review-2 N1/N3).
   queue=queue.then(()=>sdk.terminals.input({terminalId:id,dataBase64:utf8ToBase64(data)})).then(()=>{if(!ac.signal.aborted)setInputError(null)},e=>{if(!ac.signal.aborted)setInputError(String((e as Error)?.message??e))});
  };
  // Record the size only once the daemon accepted it, so a failed resize is retried by the next applySize (review-1 F5).
  const pushResize=async(cols:number,rows:number)=>{if(cols<2||rows<2)return false;try{await sdk.terminals.resize({terminalId:id,cols,rows});size={cols,rows};return true}catch{return false}};
  const applySize=()=>{
   if(!visibleRef.current||!host.clientWidth)return;
   // Session-owned: render at the PTY's last ACCEPTED size; after an engagement that is the pane size, not the
   // attach-time size, so Lock after engaging freezes the grid where the PTY actually is (review-2 N2).
   if(owner()==="session"){if(size.cols>1&&(term.cols!==size.cols||term.rows!==size.rows))term.resize(size.cols,size.rows);return}
   const d=fit.proposeDimensions();if(!d||!Number.isFinite(d.cols)||!Number.isFinite(d.rows))return;
   if(d.cols!==term.cols||d.rows!==term.rows)term.resize(d.cols,d.rows);
   if(d.cols!==size.cols||d.rows!==size.rows)void pushResize(d.cols,d.rows);
  };
  const redraw=async()=>{if(owner()!=="pane"||term.cols<2||term.rows<3)return;if(await pushResize(term.cols,term.rows-1))await pushResize(term.cols,term.rows)};
  // First engagement (focus or Redraw) hands the PTY size to this pane: fit, then resize; if the size is unchanged,
  // nudge so the TUI receives SIGWINCH and repaints.
  const claim=async()=>{
   if(engaged||lockedRef.current||!visibleRef.current)return;
   const d=fit.proposeDimensions();if(!d||!Number.isFinite(d.cols)||!Number.isFinite(d.rows))return;
   engaged=true;setClaimed(true);
   term.resize(d.cols,d.rows);if(d.cols===size.cols&&d.rows===size.rows)await redraw();else await pushResize(d.cols,d.rows);
  };
  const claimIfFocused=()=>{if(document.activeElement&&host.contains(document.activeElement))void claim()};
  // A size change goes to the LIVE terminal (no re-attach/replay): new cell metrics, then the normal fit -> PTY resize path.
  // While hidden (display:none) xterm cannot measure cells and keeps the OLD metrics, so a change made then is replayed
  // on show by bouncing the value (a changed fontSize forces a fresh measure once the host is laid out). Review font-1 MED.
  let fontPending=false;
  const applyFont=(n:number)=>{if(term.options.fontSize===n)return;term.options.fontSize=n;if(!visibleRef.current||!host.clientWidth){fontPending=true;return;}applySize();requestAnimationFrame(()=>{if(!ac.signal.aborted)applySize();});};
  const onShow=()=>{if(fontPending&&host.clientWidth){fontPending=false;const n=term.options.fontSize??fontRef.current;term.options.fontSize=n+1;term.options.fontSize=n;}applySize();};
  actionsRef.current={redraw:()=>{if(engaged)void redraw();else void claim()},applySize,claimIfFocused,applyFont,onShow,focus:()=>{if(!visibleRef.current)return false;term.focus();return true}};
  // Shift+Esc hands the keyboard back to Osiris/BB (blur); everything else follows terminalOwnsKey.
  term.attachCustomKeyEventHandler(e=>{if(isReleaseKey(e)){if(e.type==="keydown")term.blur();return false}return terminalOwnsKey(e,isMac)});
  term.onData(send);
  term.open(host);
  const onFocus=()=>void claim();host.addEventListener("focusin",onFocus);
  // Observer is created synchronously so cleanup always disconnects it, even if the id changes mid-attach (review-1 F3).
  const ro=new ResizeObserver(()=>{clearTimeout(debounce);debounce=setTimeout(applySize,RESIZE_DEBOUNCE_MS)});ro.observe(host);
  (async()=>{
   try{
    const s=await sdk.terminals.get({terminalId:id,signal:ac.signal});
    if(ac.signal.aborted)return;
    // A focus that already engaged during the get owns the size; do not overwrite it with the pre-claim report.
    if(!engaged){size={cols:s.cols,rows:s.rows};term.resize(s.cols,s.rows);}
    let state=initialReplay();
    const first=await sdk.terminals.output({terminalId:id,tailBytes:REPLAY_TAIL_BYTES,signal:ac.signal});
    if(ac.signal.aborted)return;
    const a=applyOutput(state,first);state=a.state;for(const d of a.data)term.write(base64ToBytes(d));
    // Input stays muted until xterm has PARSED the replay, so query replies to old output never reach the live PTY.
    term.write(new Uint8Array(0),()=>{replaying=false});
    setPhase(first.status==="exited"?{kind:"exited",exitCode:first.exitCode,closeReason:first.closeReason}:first.status==="disconnected"?{kind:"retry",error:"terminal disconnected"}:{kind:"attached"});
    if(first.status==="exited")return;
    let errors=0,lastData=Date.now(),lastGapRedraw=0;
    while(!ac.signal.aborted){
     if(!visibleRef.current){await sleep(500,ac.signal);continue}
     try{
      const r=await sdk.terminals.output({terminalId:id,sinceSeq:state.nextSeq,tailBytes:POLL_TAIL_BYTES,signal:ac.signal});
      if(ac.signal.aborted)return;
      const x=applyOutput(state,r);state=x.state;
      if(x.gap)term.write(GAP_MARKER);
      for(const d of x.data)term.write(base64ToBytes(d));
      // Lost bytes leave a TUI screen inconsistent; ask it to repaint (rate-limited, never when size is locked).
      if(x.gap&&Date.now()-lastGapRedraw>GAP_REDRAW_MIN_MS){lastGapRedraw=Date.now();void redraw()}
      if(x.data.length)lastData=Date.now();
      // Any successful read means attached, including after a re-discovery that kept the same id (review-1 F2).
      if(r.status!=="disconnected"){errors=0;setPhase(p=>p.kind==="attached"?p:{kind:"attached"})}
      if(r.status==="exited"||r.status==="disconnected"){
       if(r.status==="exited"){setPhase({kind:"exited",exitCode:r.exitCode,closeReason:r.closeReason});return}
       setPhase({kind:"retry",error:"terminal disconnected"});errors=Math.max(errors,1);
      }
     }catch(e){if(ac.signal.aborted)return;errors++;setPhase({kind:"retry",error:String((e as Error)?.message??e)})}
     await sleep(pollDelay(Date.now()-Math.max(lastData,lastActive),errors),ac.signal);
    }
   }catch(e){if(!ac.signal.aborted)setPhase({kind:"error",error:String((e as Error)?.message??e)})}
  })();
  return()=>{ac.abort();clearTimeout(debounce);ro.disconnect();host.removeEventListener("focusin",onFocus);actionsRef.current={redraw(){},applySize(){},claimIfFocused(){},applyFont(){},onShow(){},focus(){return false}};fit.dispose();term.dispose()};
 },[sdk,selected,nonce]);
 // Unlocking while the terminal already has focus engages it now; focusin will not fire again (review-2 L1).
 useEffect(()=>{fontRef.current=clampFontSize(fontSize);actionsRef.current.applyFont(fontRef.current);},[fontSize]);
 useEffect(()=>{if(!visible)return;actionsRef.current.onShow();if(!locked)actionsRef.current.claimIfFocused()},[visible,locked]);
 // ··· menu: closes on Escape (focus returns to its button) and on click outside the line.
 useEffect(()=>{if(!menuOpen)return;
  const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!e.shiftKey){setMenuOpen(false);menuBtnRef.current?.focus()}};
  const onDown=(e:MouseEvent)=>{if(lineRef.current&&!lineRef.current.contains(e.target as Node))setMenuOpen(false)};
  document.addEventListener("keydown",onKey);document.addEventListener("mousedown",onDown);
  return()=>{document.removeEventListener("keydown",onKey);document.removeEventListener("mousedown",onDown)};
 },[menuOpen]);
 const choose=useCallback((id:string)=>{save(id);setSelected(id);setReason("Your choice");setPhase({kind:"attaching"})},[]);
 // Human click only (never on load): ask BB for ONE terminal running herdr with the server-planned fixed argv, then attach it.
 const startHerdr=useCallback(async(sessionOverride?:string)=>{
  const want=sessionOverride===undefined?session:sessionOverride;
  if(startingRef.current)return;startingRef.current=true;setStartState({busy:true,cooling:false,error:null});
  try{
   const hostId=pickLocalHost(await sdk.hosts.list());if(!hostId){setStartState({busy:false,cooling:false,error:"BB shows no connected local host (this machine). Open BB's main window, wait for it to connect, then try again."});return}
   // Plan LAST (right before create): the herdr path is re-validated on the server at this moment, shrinking the swap window.
   const plan=await rpc.call("herdrLaunchPlan",want?{session:want}:{});
   if(!plan.ok){setStartState({busy:false,cooling:false,error:plan.reason});return}
   const t=await sdk.terminals.create({cols:120,rows:32,scope:{kind:"host_path",hostId,cwd:plan.cwd},start:{mode:"argv",argv:plan.argv},title:plan.title});
   await rpc.call("herdrStampSet",{terminalId:t.id,session:herdrSessionIdentity(want)}).catch(()=>{});
   choose(t.id);setDiscoverNonce(n=>n+1);setStartState({busy:false,cooling:false,error:null});
  }catch(e){setStartState({busy:false,cooling:false,error:`BB could not start Herdr (${sanitizeLabel(String((e as Error)?.message??e),100)}). Try again, or open a terminal in BB and run herdr.`})}
  finally{setStartState(x=>x.busy?x:{...x,cooling:true});setTimeout(()=>{startingRef.current=false;setStartState(x=>({...x,cooling:false}))},2000)}
 },[rpc,sdk,choose,session]);
 // Banner button (a human click): close ONLY the stale Osiris-made terminal(s) in BB (a BB terminal close detaches the client; it never stops a herdr session), then start on the default session.
 const switchToDefault=useCallback(async(extraId?:string|null)=>{
  setSession("");saveSession("");
  for(const id of new Set([...stale.map(x=>x.id),...(extraId?[extraId]:[])])){try{await sdk.terminals.close({terminalId:id,mode:"force"})}catch{}}
  setStale([]);setGuard(null);await startHerdr("");
 },[sdk,stale,startHerdr]);
 // RUNTIME INVARIANT (td-osi.12): once an Osiris-made herdr terminal is attached, verify it is on the user's default (or picked) session by socket identity. Crit = blocking red state, top-bar indicator, console.error. Unverifiable is crit too.
 const selTitle=sessions.find(x=>x.id===selected)?.title??"";
 useEffect(()=>{
  if(!selected||phase.kind!=="attached"||!isOsirisHerdrTerminal(selTitle)){setGuard(null);return}
  let live=true;
  rpc.call("herdrSessionCheck",{terminalId:selected,...(session?{session}:{})}).then(r=>{if(live)setGuard(r.ok?null:r)}).catch(e=>{if(live)setGuard({ok:false,severity:"warn",what:"Couldn't check which Herdr session Osiris is showing",why:String((e as Error)?.message??e).slice(0,160),fix:"Press Switch to default."})});
  return()=>{live=false};
 },[rpc,selected,phase.kind,selTitle,session,discoverNonce]);
 const guardCrit=guard&&guard.severity==="crit"?guard:null;
 useEffect(()=>{terminalBridge.publish({guardCrit:guardCrit?guardCrit.what:null});if(guardCrit)console.error(`[osiris] herdr-session guard: ${guardCrit.what}. ${guardCrit.why}`)},[guardCrit]);
 useEffect(()=>()=>terminalBridge.publish({guardCrit:null}),[]);
 // Read-only list of the sessions herdr reports, only while the empty state offers the picker.
 useEffect(()=>{if(phase.kind!=="none")return;let live=true;rpc.call("herdrSessions",{}).then(r=>{if(live&&r.ok)setSessionNames(r.sessions.map(x=>x.name).filter(n=>n!=="default"))}).catch(()=>{});return()=>{live=false}},[rpc,phase.kind]);
 // Other surfaces (left sidebar) may only ask to attach an existing terminal; the attach effect still verifies the id.
 useEffect(()=>terminalBridge.registerAttach(id=>choose(id)),[choose]);
 useEffect(()=>{terminalBridge.publish({attachedId:selected});},[selected]);
 // Shell layout (WF1): keyboard focus restore and Redraw reach xterm through the bridge, never a DOM query into this component.
 useEffect(()=>terminalBridge.registerFocus(()=>actionsRef.current.focus()),[]);
 useEffect(()=>terminalBridge.registerRedraw(()=>actionsRef.current.redraw()),[]);
 useEffect(()=>()=>terminalBridge.publish({terminals:null,attachedId:null}),[]);
 const status=phase.kind==="discovering"?"Discovering BB terminals...":phase.kind==="none"?(emptyMsg??"No BB terminals in host scope"):phase.kind==="attaching"?"Attaching...":phase.kind==="attached"?"Attached":phase.kind==="exited"?`Exited${phase.exitCode==null?"":` (code ${phase.exitCode})`}${phase.closeReason?` - ${phase.closeReason}`:""}`:phase.kind==="retry"?`Disconnected, retrying: ${sanitizeLabel(phase.error,80)}`:`Error: ${sanitizeLabel(phase.error,80)}`;
 const sel=sessions.find(s=>s.id===selected);
 const herdrIds=new Set([...probedIds,...sessions.filter(s=>/herdr/i.test(s.title+(s.initialCwd??""))).map(s=>s.id)]);
 const tone=phase.kind==="attached"?"running":phase.kind==="retry"?"attention":phase.kind==="error"?"failure":"muted";
 const hint=selected&&!claimed&&!locked&&phase.kind==="attached"?"Click to type":selected&&claimed?`${RELEASE_KEY_LABEL} to leave`:"";
 const nameTip=[sel?`${sanitizeLabel(sel.title)} · ${status}`:status,reason,selected&&!claimed&&!locked&&phase.kind==="attached"&&"Watching at the session's size. Click the terminal to type here and fit it to this pane (the PTY is shared with BB's terminal panel).",selected&&claimed&&`Typing goes to the terminal; ${RELEASE_KEY_LABEL} or click outside returns keys to Osiris`].filter(Boolean).join(" · ");
 const meta:[string,string][]=sel?[["Terminal",sel.id],["Initial cwd",sel.initialCwd||"unknown"],["PTY size",sel.cols&&sel.rows?`${sel.cols}×${sel.rows} (session)`:"unknown"],["Default pick",reason||"n/a"],["State",status]]:[];
 return <div className="oi-term">
  {guard&&<TerminalGuardCard guard={guard} canUse={!!selected} busy={startState.busy||startState.cooling} onSwitch={()=>void switchToDefault(selected)}/>}
  {stale.length>0&&<div role="alert" className="oi-term-start-error">{stale[0].text} <button type="button" className="oi-term-btn" disabled={startState.busy||startState.cooling} onClick={()=>void switchToDefault()}>Switch to default</button></div>}
  <div className="oi-term-line" ref={lineRef}>
   {leading}
   <span className={`oi-term-dot oi-term-dot-${tone}`} aria-hidden="true"/>
   <span className="oi-term-name" title={nameTip}>Terminal: {sel?sanitizeLabel(sel.title,40):"none"}</span>
   <span className="oi-term-state" role="status">{status}</span>
   {hint&&<span className="oi-term-hint">{hint}</span>}
   {selected&&inputError&&<span className="oi-term-input-failed" role="alert" title={`Input not delivered: ${sanitizeLabel(inputError,80)}`}><span className="oi-term-badge" aria-hidden="true">!</span>input not delivered</span>}
   <span className="oi-term-spacer"/>
   <button type="button" className="oi-term-btn" aria-label="Rediscover terminals" title="Rediscover BB terminals (never creates one)" onClick={()=>setDiscoverNonce(n=>n+1)}>↻</button>
   <button type="button" className="oi-term-btn" disabled={!selected} onClick={()=>setNonce(n=>n+1)}>Reconnect</button>
   <button type="button" ref={menuBtnRef} className="oi-term-btn" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Terminal menu" onClick={()=>setMenuOpen(o=>!o)}>···</button>
   {trailing}
   {menuOpen&&<div className="oi-term-menu" role="menu" aria-label="Terminal menu">
    <div className="oi-term-menu-head" role="presentation">Terminal</div>
    {sessions.length===0&&<div className="oi-term-menu-empty" role="presentation">No BB terminals</div>}
    {sessions.map(x=><button key={x.id} type="button" role="menuitemradio" aria-checked={x.id===selected} onClick={()=>{choose(x.id);setMenuOpen(false);menuBtnRef.current?.focus()}}>{x.id===selected?"✓ ":""}{sanitizeLabel(x.title,40)} · {x.status} · {shortTerminalId(x.id)}{herdrIds.has(x.id)?" (herdr)":""}</button>)}
    <div className="oi-term-menu-sep" role="separator"/>
    <button type="button" role="menuitem" disabled={!selected||locked} onClick={()=>{actionsRef.current.redraw();setMenuOpen(false)}} title="Nudges the PTY size so the TUI repaints. The PTY is shared with BB's native terminal panel.">Redraw</button>
    <button type="button" role="menuitemcheckbox" aria-checked={locked} onClick={()=>setLocked(l=>!l)} title="Stop sending resizes; render at the session's own size. The PTY is shared with BB's native terminal panel, so resizing here resizes it there.">{locked?"✓ ":""}Lock size</button>
    {meta.length>0&&<dl className="oi-term-meta" aria-label="Capture metadata">{meta.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{sanitizeLabel(v,120)}</dd></div>)}</dl>}
   </div>}
  </div>
  <div className="oi-term-host" ref={hostRef} hidden={!selected}/>
  {!selected&&<div className="oi-term-empty"><div>{status}</div>{phase.kind==="none"&&<button type="button" className="oi-term-btn oi-term-start" disabled={startState.busy||startState.cooling} onClick={()=>void startHerdr()} title="Asks BB to open one new terminal on this machine running Herdr (your default session unless you pick another) and attaches it here.">{startState.busy?"Starting Herdr…":startState.cooling?"Wait a moment…":"Start Herdr in Osiris"}</button>}{phase.kind==="none"&&<label className="oi-term-session">Herdr session <MenuSelect ariaLabel="Herdr session" value={session} onChange={v=>{setSession(v);saveSession(v)}} title="Default shows the tabs you already have open in Herdr. Pick a named session to attach that one instead." options={[{value:"",label:herdrSessionLabel("default")},...[...new Set([...sessionNames,...(session&&!sessionNames.includes(session)?[session]:[])])].map(n=>({value:n,label:herdrSessionLabel(n)}))]}/></label>}{phase.kind==="none"&&sessionNames.includes(LEGACY_HERDR_SESSION)&&<div className="oi-term-start-fix">{herdrSessionHint(LEGACY_HERDR_SESSION)} <code>{HERDR_STOP_LEGACY_COMMAND}</code> <button type="button" className="oi-term-btn" onClick={()=>{void copyWithToast(HERDR_STOP_LEGACY_COMMAND)}}>Copy</button></div>}{phase.kind==="none"&&hiddenBffSessionHint(session,sessionNames)&&<div className="oi-term-session-hint" role="note">{hiddenBffSessionHint(session,sessionNames)}</div>}{startState.error&&<div role="alert" className="oi-term-start-error">{startState.error}</div>}{herdrFixCommand(startState.error)&&<div className="oi-term-start-fix"><code>{herdrFixCommand(startState.error)}</code> <button type="button" className="oi-term-btn" onClick={()=>{void copyWithToast(herdrFixCommand(startState.error)!)}}>Copy</button></div>}</div>}
 </div>;
}
export const centreTerminalStyles=terminalGuardStyles+`
.oi-term{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--oi-bg);color:var(--oi-text)}
.oi-term-line{position:relative;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-bottom:1px solid var(--oi-border);flex:none;font-size:11px;min-width:0}
.oi-term-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--oi-tone-muted)}
.oi-term-dot-running{background:var(--oi-tone-running)}.oi-term-dot-attention{background:var(--oi-tone-attention)}.oi-term-dot-failure{background:var(--oi-tone-failure)}.oi-term-dot-muted{background:var(--oi-tone-muted)}
.oi-term-name{font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.oi-term-state,.oi-term-hint{color:var(--oi-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}.oi-term-hint{opacity:.6}
.oi-term-badge{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-weight:700;color:var(--oi-bg);background:var(--oi-tone-failure);flex:none}.oi-term-input-failed{display:inline-flex;align-items:center;gap:4px;color:var(--oi-tone-failure);white-space:nowrap;flex:none}
.oi-term-menu-head{color:var(--oi-muted);font-size:10px;padding:0 2px}.oi-term-menu-empty{color:var(--oi-muted);padding:0 2px}.oi-term-menu-sep{border-top:1px solid var(--oi-border);margin:2px 0}
.oi-term-spacer{flex:1}
.oi-term-btn,.oi-term-menu button{font:inherit;color:var(--oi-text);background:var(--oi-panel);border:1px solid var(--oi-border);border-radius:4px;padding:1px 6px;line-height:18px;cursor:pointer}
.oi-term-menu button[aria-checked="true"]{background:var(--oi-selected);border-color:var(--oi-tone-running)}
.oi-term-line button:hover:not(:disabled){background:var(--oi-hover)}.oi-term-line button:disabled{opacity:.5;cursor:default}
.oi-term-menu{position:absolute;top:100%;right:8px;z-index:10;display:flex;flex-direction:column;gap:4px;min-width:240px;max-width:360px;max-height:60vh;overflow:auto;padding:6px;background:var(--oi-panel);border:1px solid var(--oi-border);border-radius:6px}
.oi-term-menu button{text-align:left}
.oi-term-meta{margin:4px 0 0;padding-top:4px;border-top:1px solid var(--oi-border);color:var(--oi-muted);font-size:10px}.oi-term-meta div{display:flex;gap:6px}.oi-term-meta dt{flex:none;width:76px}.oi-term-meta dd{margin:0;overflow-wrap:anywhere;color:var(--oi-text)}
.oi-term-host{flex:1;min-height:0;min-width:0;padding:4px 6px;overflow:hidden;background:var(--oi-bg)}.oi-term-host[hidden]{display:none}
.oi-term-host .xterm{height:100%}.oi-term-host .xterm-viewport{background:transparent!important}
.oi-term-start{margin-top:12px;padding:4px 12px}.oi-term-start-error{margin-top:8px;color:var(--oi-tone-failure)}
.oi-term-empty{padding:24px;text-align:center;color:var(--oi-muted);font-size:12px}
.oi-term-session{display:inline-flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--oi-muted)}
.oi-term-session .oi-ms{min-height:28px}
`;
