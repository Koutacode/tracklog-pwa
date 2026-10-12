import assert from 'node:assert/strict';
import {createDriverCandidateAuth,CANDIDATE_RECORD_KEY,candidateSessionKey,hasDriverCandidateAttempt} from '../../src/services/driverCandidateAuth';
import {createDriverAccountStorage,verifyInstalledNativeOwner,DRIVER_OWNER_KEY} from '../../src/services/driverAccountStorage';
import {DRIVER_AUTH_STORAGE_KEY} from '../../src/services/authStorageKeys';
import {withDriverRegistrationMutation} from '../../src/services/driverRegistrationLock';
const cases:string[]=[];
async function test(name:string,fn:()=>Promise<void>){await fn();cases.push(name);console.log('PASS '+name)}
function fixture(){
 const map=new Map<string,string>([['active-sentinel','unchanged']]);let clock=Date.now(),id='owner-a',serverId='',failWrite=false; let gate:Promise<void>|null=null,release=()=>{},entered=()=>{}; let entry=Promise.resolve();
 const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{if(failWrite)throw Error('synthetic quota');map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}};
 const calls:string[]=[];const user=(uid:string)=>({id:uid,email:'driver@example.test',aud:'authenticated',created_at:'2026-01-01T00:00:00Z',is_anonymous:false});
 const fetcher=async(url:any,init:any)=>{const u=new URL(String(url));assert.equal(u.origin,'https://synthetic.example.test');calls.push(u.pathname+'?'+u.searchParams.toString());if(u.pathname==='/auth/v1/token' && gate){entered();await gate;}let body:any;
 if(u.pathname==='/auth/v1/token'){body={access_token:'synthetic-'+id,refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:3600,user:user(id)}}
 else if(u.pathname==='/auth/v1/user'){body=user(serverId||id)}else throw Error('unexpected HTTP route');
 return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})};
 const make=()=>createDriverCandidateAuth({url:'https://synthetic.example.test',apiKey:'synthetic-test-key',storage,fetch:fetcher as any,now:()=>clock});
 const c=make();const rec=()=>JSON.parse(map.get(CANDIDATE_RECORD_KEY)!);const callback=()=>rec().redirect+'&code=synthetic-code';
 return {map,storage,c,make,calls,rec,callback,block:()=>{entry=new Promise<void>(r=>entered=r);gate=new Promise<void>(r=>release=r)},entered:()=>entry,release:()=>{release();gate=null},setId:(v:string)=>{id=v},server:(v:string)=>{serverId=v},expire:()=>{clock+=601000},quota:(v:boolean)=>{failWrite=v}};
}
async function run() {
await test('PKCE selection, server verification and cancellation isolate active storage',async()=>{const f=fixture();const u=new URL(await f.c.start(false,'https://app.example.test'));assert.equal(u.searchParams.get('provider'),'google');assert(u.searchParams.get('code_challenge'));await f.c.handle(f.callback());assert.deepEqual(await f.c.read(),{id:f.rec().id,phase:'selected',email:'driver@example.test'});await f.c.discard();assert.deepEqual([...f.map],[['active-sentinel','unchanged']]);assert(f.calls.every(x=>!x.includes('logout')))});
await test('wrong callback origin, nonce, hash and token rejected; TTL expires',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');for(const url of [f.callback().replace('app.example.test','wrong.example.test'),f.callback().replace(f.rec().id,'00000000-0000-0000-0000-000000000000'),f.callback()+'#access_token=x',f.callback()+'&refresh_token=x'])await assert.rejects(f.c.handle(url));assert.equal(f.calls.length,0);f.expire();await assert.rejects(f.c.handle(f.callback()));assert.equal((await f.c.read())?.phase,'expired');await f.c.discard()});
await test('server user differs from SDK session: no selection or promotion',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');f.server('other-id');await assert.rejects(f.c.handle(f.callback()));assert.equal(f.rec().phase,'choosing');await f.c.discard()});
await test('same email with wrong owner rejected by confirmation before handoff',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');await f.c.handle(f.callback());let promoted=false;await assert.rejects(f.c.confirm(async u=>{assert.equal(u.id,'existing-owner')},async()=>{promoted=true}));assert.equal(promoted,false);assert.equal(f.rec().phase,'selected');await f.c.discard()});
await test('quota failure retains old attempt; restart retires old callback',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');const old=f.callback(),snapshot=[...f.map];f.quota(true);await assert.rejects(f.c.start(false,'https://app.example.test',true));assert.deepEqual([...f.map],snapshot);f.quota(false);await f.c.start(false,'https://app.example.test',true);await assert.rejects(f.c.handle(old));await f.c.discard()});
await test('restart resumes selected record and callback capture',async()=>{const f=fixture();await f.c.start(true,'https://app.example.test');assert(f.callback().startsWith('com.tracklog.assist://auth?'));await f.c.capture(f.callback());assert.equal(await f.make().pending(),f.callback());await f.make().handle(f.callback());assert.equal((await f.make().read())?.phase,'selected');await f.c.discard()});
await test('partial promotion keeps committing recovery; retry after TTL needs no candidate refresh',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');await f.c.handle(f.callback());await assert.rejects(f.c.confirm(async()=>{},async(_s,_u,adopted)=>{await adopted();throw Error('synthetic native install failure')}));assert.equal(f.rec().phase,'committing');assert.equal(f.rec().handoff,undefined);assert.equal([...f.map.keys()].some(k=>k.startsWith('tracklog-driver-candidate-auth:')),false);await assert.rejects(f.c.discard());f.expire();const count=f.calls.length;await f.make().confirm(async u=>assert.equal(u.id,'owner-a'),async(s)=>assert.equal(s,null));assert.equal(f.calls.length,count);assert.deepEqual([...f.map],[['active-sentinel','unchanged']])});
await test('committing reauthentication remains same-ID constrained after cancel',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');await f.c.handle(f.callback());await assert.rejects(f.c.confirm(async()=>{},async()=>{throw Error('synthetic failure')}));await f.c.start(false,'https://app.example.test',true);f.setId('owner-b');await assert.rejects(f.c.handle(f.callback()));await f.c.discard();assert.equal(f.rec().phase,'committing');assert.equal(f.rec().owner.id,'owner-a')});
await test('active storage guard rejects owner changes and unknown existing data',async()=>{const f=fixture();const g=createDriverAccountStorage(f.storage,async()=>({owners:['owner-a'],registered:true}));await assert.rejects(g.setItem(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-b'}})));assert.equal(f.map.has(DRIVER_OWNER_KEY),false);await g.setItem(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-a'}}));assert.equal(f.map.get(DRIVER_OWNER_KEY),'owner-a');await assert.rejects(g.withExpectedOwner('owner-a',()=>g.setItem(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-b'}}))));const h=createDriverAccountStorage(fixture().storage,async()=>({owners:[],registered:true}));await assert.rejects(h.assertOwner('owner-a'))});
await test('native-only owner verified from old credential; ambiguous/changed credential rejected',async()=>{const empty={configured:false,blocked:false,accessToken:'',refreshToken:''};assert.equal(await verifyInstalledNativeOwner({read:async()=>empty,verify:async()=>{throw Error('must not call')}}),null);await assert.rejects(verifyInstalledNativeOwner({read:async()=>({configured:false}),verify:async()=>null}));const old={configured:true,blocked:false,accessToken:'synthetic-old',refreshToken:'synthetic-refresh'};assert.equal(await verifyInstalledNativeOwner({read:async()=>old,verify:async t=>{assert.equal(t,old.accessToken);return {id:'owner-a'}}}),'owner-a');let n=0;await assert.rejects(verifyInstalledNativeOwner({read:async()=>++n===1?old:{...old,refreshToken:'changed'},verify:async()=>({id:'owner-a'})}));await assert.rejects(verifyInstalledNativeOwner({read:async()=>old,verify:async()=>({id:'owner-a',is_anonymous:true})}))});
await test('registration mutation serializes and recovers after rejected task',async()=>{let seq:number[]=[];await Promise.allSettled([withDriverRegistrationMutation(async()=>{seq.push(1);throw Error('synthetic')}),withDriverRegistrationMutation(async()=>{seq.push(2)})]);assert.deepEqual(seq,[1,2])});


await test('delayed code exchange cannot repopulate cancelled attempt or overwrite newer attempt',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');const old=f.rec().id;f.block();const pending=f.c.handle(f.callback());const rejected=assert.rejects(pending);await f.entered();const other=f.make();await other.discard();await other.start(false,'https://app.example.test');const newer=f.rec().id;f.release();await rejected;assert.notEqual(old,newer);assert.equal(f.rec().id,newer);assert.equal(f.map.has(candidateSessionKey(old)),false);assert.equal(f.map.get('active-sentinel'),'unchanged');await other.discard()});
await test('delayed refresh cannot restore retired credentials',async()=>{const f=fixture();await f.c.start(false,'https://app.example.test');await f.c.handle(f.callback());const old=f.rec().id;const key=candidateSessionKey(old);const s=JSON.parse(f.map.get(key)!);s.expires_at=1;f.map.set(key,JSON.stringify(s));f.block();const pending=f.c.read();await f.entered();const other=f.make();await other.discard();await other.start(false,'https://app.example.test');const newer=f.rec().id;f.release();await pending;assert.equal(f.rec().id,newer);assert.equal(f.map.has(key),false);await other.discard()});
await test('active session persistence failure retains restrictive owner pin',async()=>{const map=new Map<string,string>();const storage={getItem:(k:string)=>map.get(k)??null,removeItem:(k:string)=>{map.delete(k)},setItem:(k:string,v:string)=>{if(k===DRIVER_AUTH_STORAGE_KEY)throw Error('synthetic persistence failure');map.set(k,v)}};const g=createDriverAccountStorage(storage,async()=>({owners:[],registered:false}));await assert.rejects(g.setItem(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-a'}})));assert.equal(map.get(DRIVER_OWNER_KEY),'owner-a');assert.equal(map.has(DRIVER_AUTH_STORAGE_KEY),false);await assert.rejects(g.assertOwner('owner-b'))});
await test('candidate start waits for an active storage owner check before recording the attempt',async()=>{
 const f=fixture();let release=()=>{},entered=()=>{};const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const guard=createDriverAccountStorage(f.storage,async()=>{entered();await gate;return {owners:[],registered:false}});
 const saving=guard.setItem(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-a'}}));await waiting;
 const starting=f.c.start(false,'https://app.example.test');await new Promise(r=>setTimeout(r,10));assert.equal(f.map.has(CANDIDATE_RECORD_KEY),false);
 release();await saving;await starting;assert.equal(f.map.get(DRIVER_OWNER_KEY),'owner-a');await f.c.discard();
});
await test('expired selection releases background suppression; committing recovery does not expire',async()=>{
 const original=(globalThis as any).window;const f=fixture();(globalThis as any).window={localStorage:f.storage};
 try {f.map.set(CANDIDATE_RECORD_KEY,JSON.stringify({phase:'selected',expiresAt:Date.now()-1}));assert.equal(hasDriverCandidateAttempt(),false);
 f.map.set(CANDIDATE_RECORD_KEY,JSON.stringify({phase:'committing',expiresAt:Date.now()-1}));assert.equal(hasDriverCandidateAttempt(),true);}
 finally {if(original===undefined)delete (globalThis as any).window;else (globalThis as any).window=original;}
});
await test('pinned owner cannot hide a conflicting persisted DB owner',async()=>{
 const f=fixture();f.map.set(DRIVER_OWNER_KEY,'owner-a');
 const guard=createDriverAccountStorage(f.storage,async()=>({owners:['owner-b'],registered:true}));
 const before=[...f.map];await assert.rejects(guard.assertOwner('owner-a'));assert.deepEqual([...f.map],before);
});
await test('pinned owner cannot hide a conflicting installed native owner',async()=>{
 const f=fixture();f.map.set(DRIVER_OWNER_KEY,'owner-a');
 const guard=createDriverAccountStorage(f.storage,async()=>({owners:['owner-a'],registered:true}),async()=>'owner-b');
 const before=[...f.map];await assert.rejects(guard.assertOwner('owner-a'));assert.deepEqual([...f.map],before);
});
await test('normal pinned refresh remains independent of unavailable native verification',async()=>{
 const f=fixture();f.map.set(DRIVER_OWNER_KEY,'owner-a');f.map.set(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-a'},refresh_token:'old'}));
 const guard=createDriverAccountStorage(f.storage,async()=>{throw Error('DB unavailable')},async()=>{throw Error('native offline')});
 await guard.setItem(DRIVER_AUTH_STORAGE_KEY,JSON.stringify({user:{id:'owner-a'},refresh_token:'rotated'}));
 assert.equal(JSON.parse(f.map.get(DRIVER_AUTH_STORAGE_KEY)!).refresh_token,'rotated');
 await assert.rejects(guard.assertOwner('owner-a'));
});
console.log('FINAL TOTAL '+cases.length+' passed');

}
run().catch(e=>{console.error(e);process.exitCode=1});
