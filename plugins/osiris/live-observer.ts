import { callKey, report, statuses, type Call } from "./analytics.ts";
export const CALL_PAGE_SIZE = 60;
export function humanDuration(ms: number | null): string {
  if (ms === null) return "Unknown";
  if (ms === 0) return "Reported 0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export const shortId = (id: string) => id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-5)}` : id;
export const recentCalls = (calls: Call[]) => [...calls].sort((a,b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0) || callKey(a).localeCompare(callKey(b)));
export function callPage(calls: Call[], page: number) {return calls.slice(page*CALL_PAGE_SIZE,(page+1)*CALL_PAGE_SIZE);}
export function callContext(call: Call, calls: Call[]) {
  const scoped = calls.filter(c => c.source === call.source && c.provider === call.provider && c.sessionId === call.sessionId).sort((a,b) => (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0) || callKey(a).localeCompare(callKey(b)));
  const index = scoped.findIndex(c => callKey(c) === callKey(call));
  return index < 0 ? [] : scoped.slice(Math.max(0,index-3),index+4);
}
export function isSlow(call: Call) {const threshold=call.server || /mcp/i.test(call.tool) ? 60000 : /exec|command|shell/i.test(call.tool) ? 5000 : 10000; return call.status === "success" && call.durationMs !== null && call.durationMs >= threshold;}
export const PROBLEM_CLASSES = [
  {id:"error",label:"Errors"}, {id:"denied",label:"Denied"},
  {id:"cancelled",label:"Cancelled"}, {id:"unknown",label:"Unknown"},
  {id:"slow",label:"Slow successes"},
] as const;
export type ProblemClass = typeof PROBLEM_CLASSES[number]["id"];
export function problemClass(call: Call): ProblemClass | null {
  if (call.status === "error" || call.status === "denied" || call.status === "cancelled" || call.status === "unknown") return call.status;
  return isSlow(call) ? "slow" : null;
}
export function problemCounts(calls: Call[]) {
  const counts:Record<ProblemClass,number>={error:0,denied:0,cancelled:0,unknown:0,slow:0};
  for(const call of calls){const kind=problemClass(call);if(kind)counts[kind]++;}
  return counts;
}
export function problemKey(c: Call) {return JSON.stringify([c.provider,c.tool,c.server,c.status,c.errorCode]);}
export function groupProblems(calls: Call[]) {
  const groups=new Map<string,Call[]>();
  for(const c of calls.filter(c=>problemClass(c)!==null)){const key=problemKey(c);groups.set(key,[...(groups.get(key)??[]),c]);}
  return [...groups].map(([key,calls])=>({key,calls})).sort((a,b)=>b.calls.length-a.calls.length);
}
/** Canonical whitelist, even if the server or import gains extra fields later. */
export function exportMetadata(calls: Call[]) {return report(calls);}
export function searchCalls(calls: Call[], query: string): { calls: Call[]; error: string | null } {
  if((query.match(/"/g)?.length??0)%2)return {calls:[],error:"Close the quoted search phrase."};
  const tokens=query.match(/(?:[^\s"]+|"[^"]*")+/g)??[];
  const predicates: ((c:Call)=>boolean)[]=[];
  const fields={tool:"tool",server:"server",status:"status",error:"errorCode",id:"callId",thread:"sessionId",provider:"provider",parent:"parentCallId",source:"source"} as const;
  for(const token of tokens){const colon=token.startsWith('"')?-1:token.indexOf(":"),key=colon<0?null:token.slice(0,colon).toLowerCase(),value=(colon<0?token:token.slice(colon+1)).replace(/^"|"$/g,"").toLowerCase();
    if(key){
      if(!value)return {calls:[],error:`${key}: needs a value.`};
      if(key==="duration"){const m=/^(>=|<=|>|<)?(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);if(!m)return {calls:[],error:"Use duration:>5s, duration:>=100ms or duration:<2m."};const number=Number(m[2])*(m[3]==="ms"?1:m[3]==="m"?60000:1000);predicates.push(c=>c.durationMs!==null&&(m[1]==="<"?c.durationMs<number:m[1]==="<="?c.durationMs<=number:m[1]===">="?c.durationMs>=number:c.durationMs>number));continue;}
      if(key==="status"&&value==="slow"){predicates.push(isSlow);continue;}
      if(key==="status"&&!statuses.includes(value as typeof statuses[number]))return {calls:[],error:"Status must be success, error, denied, cancelled, unknown, running or slow."};
      if(!(key in fields))return {calls:[],error:`Unknown field ${key}:. Use tool, server, status, error, id, thread, provider, parent or duration.`};
      const field=fields[key as keyof typeof fields];predicates.push(c=>key==="status"?c.status===value:String(c[field]??"").toLowerCase().includes(value));
    }else{predicates.push(c=>[c.tool,c.server,c.status,c.errorCode,c.callId,c.parentCallId,c.sessionId,c.provider,c.turnId].some(x=>x?.toLowerCase().includes(value)));}
  }
  return {calls:calls.filter(c=>predicates.every(p=>p(c))),error:null};
}

/** Reserve the default 55% chat share; side panes may borrow from each other. */
export function resizePanes(panes:{left:number;right:number},side:"left"|"right",requested:number,width:number) {
  const budget=.45-5.5/Math.max(1,width),minimum={left:Math.min(.1,100/Math.max(1,width)),right:Math.min(.25,200/Math.max(1,width))};
  const other=side==="left"?"right":"left",otherMinimum=panes[other]===0?0:minimum[other];
  const next=requested<=2/Math.max(1,width)?0:Math.max(minimum[side],Math.min(budget-otherMinimum,requested));
  return {...panes,[side]:next,[other]:Math.max(otherMinimum,Math.min(panes[other],budget-next))};
}
