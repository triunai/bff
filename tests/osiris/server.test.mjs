import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost,makeThreadResponse,experimental_scanPublicSdkOnly} from '@get-bb/plugin-sdk/testing';
import plugin from '../../plugins/osiris/server.ts';
test('SDK RPC and CLI share bounded history results, reuse metadata snapshot and dispose cleanly',async()=>{
 const thread=makeThreadResponse({id:'thread',providerId:'codex'});
 const rows=[0,7,1].map((exitCode,i)=>({id:`event-${i}`,threadId:'thread',seq:i+1,scope:{kind:'turn',turnId:'turn'},createdAt:100+i,type:'item/completed',data:{providerThreadId:'native-session',item:{id:`call-${i}`,type:'commandExecution',status:'completed',exitCode,durationMs:0}}}));
 let reads=0;
 const {bb,harness}=createFakePluginHost({pluginId:'tool-observer',sdk:{threads:{get:async()=>thread,list:async()=>[thread],events:{list:async(args)=>{assert.ok(Number(args.limit)<=100,"Live BB limit is100");reads++;return rows;}}}}});
 try{await plugin(bb);const r=await harness.behavior.callRpc('snapshot',{threadId:'thread'});assert.equal(r.totals.calls,3);assert.equal(r.totals.success,1);assert.equal(r.totals.error,2);assert.equal(r.coverage.retainedHistoryOnly,true);assert.equal(r.coverage.eventsScanned,3);const cli=await harness.behavior.runCli(['summary','--thread','thread','--json']);assert.equal(cli.exitCode,0);assert.equal(JSON.parse(cli.stdout).totals.errorRate,2/3);assert.equal(reads,1);await harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:4});assert.equal(harness.realtimeSignals.length,1);}finally{await harness.lifecycle.dispose();}
});
test('Public SDK scanner permits only declared public frontend dependencies',()=>{const r=experimental_scanPublicSdkOnly(new URL('../../plugins/osiris/',import.meta.url).pathname,{allow:[/^react$/, /^react-dom$/, /^@radix-ui\//,/^class-variance-authority$/,/^clsx$/,/^tailwind-merge$/]});assert.deepEqual(r.violations,[]);assert.deepEqual(r.privateDependencies,[]);});


test('event history pages respect live100 limit and disclose truncation beyond1000',async()=>{
 const thread=makeThreadResponse({id:'thread',providerId:'codex'});
 const rows=Array.from({length:1001},(_,i)=>({id:`event-${i}`,threadId:'thread',seq:1001-i,scope:{kind:'turn',turnId:'turn'},createdAt:100+i,type:'item/completed',data:{providerThreadId:'session',item:{id:`call-${i}`,type:'fileRead',status:'completed'}}}));
 const limits=[];
 const {bb,harness}=createFakePluginHost({pluginId:'tool-observer',sdk:{threads:{get:async()=>thread,events:{list:async(args)=>{const limit=Number(args.limit);limits.push(limit);assert.ok(limit<=100);return rows.filter(r=>!args.beforeSeq||r.seq<Number(args.beforeSeq)).slice(0,limit);}}}}});
 try{await plugin(bb);const r=await harness.behavior.callRpc('snapshot',{threadId:'thread'});assert.equal(r.totals.calls,1000);assert.equal(r.coverage.eventsScanned,1000);assert.deepEqual(r.coverage.truncatedThreads,['thread']);assert.equal(limits.length,11);assert.equal(limits.at(-1),1);}finally{await harness.lifecycle.dispose();}
});
test('failed scan exposes bounded code without error payload',async()=>{
 const thread=makeThreadResponse({id:'thread',providerId:'codex'});
 const {bb,harness}=createFakePluginHost({pluginId:'tool-observer',sdk:{threads:{get:async()=>thread,events:{list:async()=>{throw {code:'invalid_request',message:'SECRET'};}}}}});
 try{await plugin(bb);const r=await harness.behavior.callRpc('snapshot',{threadId:'thread'});assert.deepEqual(r.coverage.failedThreads,['thread']);assert.deepEqual(r.coverage.scanErrors,[{threadId:'thread',code:'invalid_request'}]);assert.equal(JSON.stringify(r).includes('SECRET'),false);}finally{await harness.lifecycle.dispose();}
});
