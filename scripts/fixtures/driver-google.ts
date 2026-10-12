import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { Capacitor, registerPlugin } from '@capacitor/core';
async function main() {
 const scenario=process.argv[2]; const native=scenario.startsWith('native');
 const replay=scenario.startsWith('claim-response-lost');
 const claimServer=replay?await (await import('../test-driver-claim-replay.mjs')).createClaimTestServer():null;
 const boundary=scenario.startsWith('native-boundary-'),stage=scenario.replace('native-boundary-','');
 const resume=boundary&&process.argv[4]==='resume'?JSON.parse(readFileSync(process.argv[3],'utf8')):null;
 let armed=false,hit=()=>{};const interrupted=new Promise<void>(r=>hit=r);
 const never=()=>new Promise<void>(()=>{});
 const stop=(point:string)=>{if(boundary&&!resume&&armed&&point===stage){hit();return never();}};
 const values=new Map<string,string>(resume?.values??[]); let failStorage=false;
 const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(failStorage&&k==='tracklog-driver-auth')throw Error('synthetic quota');values.set(k,v);if(k==='tracklog-driver-auth')return stop('active');if(k==='tracklog-driver-candidate-attempt'){const a=JSON.parse(v);if(a.phase==='committing')return stop(a.handoff?'handoff':'scrub');}},removeItem:(k:string)=>{values.delete(k)}};
 const locks=new Map<string,Promise<any>>();
 const win=Object.assign(new EventTarget(),{localStorage:storage,sessionStorage:storage,location:{origin:'https://app.example.test',href:'https://app.example.test/driver-login'},setTimeout,clearTimeout,setInterval,clearInterval});
 Object.assign(globalThis,{window:win,document:Object.assign(new EventTarget(),{visibilityState:'hidden'}),localStorage:storage});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true,locks:{request:(name:string,...args:any[])=>{const fn=args[args.length-1];const run=(locks.get(name)??Promise.resolve()).catch(()=>{}).then(()=>fn({name}));locks.set(name,run.catch(()=>{}));return run}}}});
 // Node tests are single-context; candidate race tests exercise multiple controllers separately.
 Capacitor.isNativePlatform=()=>native;Capacitor.getPlatform=()=>native?'android':'web';
 const uid='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const email='driver@example.test';let loginId=scenario.endsWith('wrong')||scenario==='wrong-owner'?other:uid;
 const user=(id:string)=>({id,email,aud:'authenticated',created_at:'2026-01-01T00:00:00Z',is_anonymous:false});
 const encode=(v:any)=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const token=(id:string)=>`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,email,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,session_id:'synthetic-session'})}.c3ludGhldGlj`;
 const session=(id:string)=>({access_token:token(id),refresh_token:'synthetic-refresh-'+id,expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user:user(id)});
 let authorization:any=scenario.startsWith('native-only')?{configured:true,blocked:false,accessToken:token(uid),refreshToken:'synthetic-old-refresh',updatedAt:1}:{configured:false,blocked:false,accessToken:'',refreshToken:'',updatedAt:0};
 if(scenario==='native-pinned-conflict')authorization={configured:true,blocked:false,accessToken:token(other),refreshToken:'synthetic-native-other',updatedAt:1};
 if(resume)authorization=resume.authorization;
 let installFail=scenario==='native-install-failure',claimFail=scenario==='claim-failure';let installs=0,claims=0;
 const bridge={getAuthorization:async()=>({...authorization}),refreshAuthorization:async()=>({...authorization}),getStatus:async()=>({}),installAuthorization:async(v:any)=>{installs++;if(scenario==='native-otp-race'&&installs===1){otpEntered();await gate;}if(installFail)throw Error('synthetic native install failure');authorization={configured:true,blocked:false,accessToken:v.accessToken,refreshToken:v.refreshToken,updatedAt:Date.now()};await stop('native');return {...authorization}},reconcile:async()=>({}),applyTrackingState:async()=>({})};
 registerPlugin('ResidentLocation',{android:bridge,web:bridge});registerPlugin('DeviceIdentity',{android:{getStableDeviceKey:async()=>({stableDeviceKey:'synthetic-device',source:'test'})}});
 let releaseOtp:()=>void=()=>{},otpEntered:()=>void=()=>{};const entered=new Promise<void>(r=>otpEntered=r),gate=new Promise<void>(r=>releaseOtp=r);
 globalThis.fetch=async(input:any,init:any)=>{
  const req=new Request(input,init),url=new URL(req.url);assert.equal(url.origin,'https://synthetic.example.test','network must remain synthetic');
  let data:any;let status=200;
  if(url.pathname==='/auth/v1/token'||url.pathname==='/auth/v1/verify'){if(scenario==='otp-race'&&url.pathname.endsWith('verify')){otpEntered();await gate;}data=session(loginId);if(url.searchParams.get('grant_type')==='refresh_token')data.refresh_token='synthetic-rotated';}
  else if(url.pathname==='/auth/v1/user'){const access=req.headers.get('Authorization')!.split(' ')[1];data=user(JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString()).sub)}
  else if(url.pathname==='/functions/v1/tracklog-privileged'){
   const payload=await req.json();if(payload.action==='claimDeviceProfile'&&claimServer){
    claims++;const accepted=await claimServer.claim(payload,user(uid),false);
    if(claims===1){if(scenario==='claim-response-lost-approved')await claimServer.changeApproval(payload.deviceId,'approved');throw new TypeError('synthetic response lost after committed claim');}
    data={ok:true,data:accepted};
   }else if(payload.action==='claimDeviceProfile'){claims++;await stop('profile-saved');status=claimFail?503:200;data={ok:!claimFail,data:{device_id:payload.deviceId,auth_user_id:uid,display_name:payload.displayName,vehicle_label:payload.vehicleLabel,driver_email:email,driver_phone:payload.driverPhone,approval_status:scenario==='approved-profile'?'approved':'pending'}};await stop('claim');}else data={ok:true,data:{email,isAdmin:false}};
  }else if(url.pathname==='/rest/v1/device_profiles')data=[];
  else throw Error('Unexpected synthetic URL '+url.pathname);
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 };
 const {db}=await import('../../src/db/db');
 await db.meta.bulkPut([{key:'device_stable_key',value:native?'android:synthetic-device':'web:synthetic-device',updatedAt:'test'},{key:'device_id',value:native?'android:synthetic-device':'web:synthetic-device',updatedAt:'test'}]);
 if(scenario==='wrong-owner'||scenario==='same-owner'||scenario.startsWith('refresh-')||scenario.startsWith('stale-')||scenario==='approved-profile'||replay){
  storage.setItem('tracklog-driver-auth',JSON.stringify(session(uid)));
  await db.events.put({id:'synthetic-event',tripId:'synthetic-trip',type:'trip_start',ts:'2026-01-01T00:00:00Z',ownerUserId:uid,syncMutationId:'unsent-synthetic',localRevision:1} as any);
 }
 if(scenario==='approved-profile')await db.meta.bulkPut(Object.entries({remote_auth_initialized:'true',driver_email:email,driver_approval_status:'approved',device_display_name:'Synthetic Driver',driver_phone:'09012345678',device_vehicle_label:'札幌101か1234'}).map(([key,value])=>({key,value,updatedAt:'seed'})));
 if(scenario==='pinned-db-conflict'||scenario==='native-pinned-conflict'){
  values.set('tracklog-driver-auth-owner-id',uid);
  await db.events.put({id:'synthetic-conflict',tripId:'synthetic-trip',type:'trip_start',ts:'2026-01-01T00:00:00Z',ownerUserId:scenario==='pinned-db-conflict'?other:uid,syncMutationId:'unsent-conflict',localRevision:1} as any);
 }
 if(boundary||replay){
  if(resume){for(const t of db.tables){await t.clear();await t.bulkPut(resume.tables[t.name]);}}
  else {
   values.set('tracklog-driver-auth-owner-id',uid);
   await db.meta.bulkPut(['device_display_name','driver_phone','device_vehicle_label'].map((key,i)=>({key,value:['Synthetic Driver','09012345678','札幌101か1234'][i],updatedAt:'seed'})));
   for(const t of db.tables.filter(t=>t.name!=='meta')){
    const row={id:'synthetic-'+t.name,eventId:'synthetic-'+t.name,tripId:'synthetic-trip',type:'trip_start',ts:'2026-01-01T00:00:00Z',createdAt:'2026-01-01T00:00:00Z',deletedAt:'2026-01-01T00:00:00Z',ownerUserId:uid,syncMutationId:'unsent-'+t.name,localRevision:3,syncStatus:'pending'};
    await t.put(row as any);
   }
  }
  const originalPut=db.meta.put.bind(db.meta);
  (db.meta as any).put=async(row:any,...args:any[])=>{
   if(armed&&!resume&&stage==='profile-partial'&&['driver_phone','device_vehicle_label'].includes(row.key))return never();
   const result=await (originalPut as any)(row,...args);
   if(row.key==='device_display_name')await stop('profile-partial');
   if(row.key==='driver_approval_status')await stop('approval');return result;
  };
 }
 const auth=await import('../../src/services/remoteAuth');const supa=await import('../../src/services/supabase');const candidate=await import('../../src/services/driverCandidateAuth');
 await supa.driverAuthSupabase!.auth.initialize();
 const snapshot=async()=>JSON.stringify(await Promise.all(db.tables.map(t=>t.toArray())));
 let before=await snapshot(),beforeSession=values.get('tracklog-driver-auth'),beforeNative=JSON.stringify(authorization);
 const c=candidate.driverCandidateAuth();
 let otp:Promise<any>|undefined;
 if(scenario==='otp-race'||scenario==='native-otp-race'){otp=auth.verifyDriverEmailOtp(email,'123456').then(()=>false,()=>true);await entered;}
 if(scenario==='ui-render') {
   const {createElement}=require('react');const {renderToStaticMarkup}=require('react-dom/server');
   const {MemoryRouter}=require('react-router-dom');const {default:Login}=await import('../../src/ui/screens/DriverLoginScreen');
   const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(Login)));
   assert(html.includes('Googleで続ける'));assert(html.includes('既存アカウントをメール認証で復旧'));assert(!html.includes('id="driver-login-email"'));
   db.close();console.log('PASS Google initial UI render: Google primary, email recovery optional');return;
 }
 if(boundary&&resume){
  const beforeData=JSON.stringify(await Promise.all(db.tables.filter(t=>t.name!=='meta').map(t=>t.toArray())));
  assert.equal(JSON.parse(values.get(candidate.CANDIDATE_RECORD_KEY)!).phase,'committing');
  await assert.rejects(c.discard());
  await auth.confirmDriverGoogleRegistration({displayName:'Synthetic Driver',phone:'09012345678',vehicleLabel:'札幌101か1234'},JSON.parse(values.get(candidate.CANDIDATE_RECORD_KEY)!).id);
  assert.equal(values.has(candidate.CANDIDATE_RECORD_KEY),false);
  assert.equal(JSON.parse(values.get('tracklog-driver-auth')!).user.id,uid);
  assert.equal(values.get('tracklog-driver-auth-owner-id'),uid);
  assert.equal(JSON.parse(Buffer.from(authorization.accessToken.split('.')[1],'base64url').toString()).sub,uid);
  assert.equal(JSON.stringify(await Promise.all(db.tables.filter(t=>t.name!=='meta').map(t=>t.toArray()))),beforeData);
  for(const [key,value] of Object.entries({device_display_name:'Synthetic Driver',driver_phone:'09012345678',device_vehicle_label:'札幌101か1234',driver_approval_status:scenario==='approved-profile'?'approved':'pending'}))assert.equal((await db.meta.get(key))?.value,value);
  assert(claims>0);await supa.driverAuthSupabase!.auth.stopAutoRefresh();db.close();console.log('PASS fresh-process persisted-state recovery '+stage);return;
 }
 const starting=c.start(native,win.location.origin);
 if(otp){await new Promise(r=>setTimeout(r,20));assert.equal(values.has(candidate.CANDIDATE_RECORD_KEY),false,'candidate cannot begin during legacy authentication');releaseOtp();await otp;}
 await starting;
 if(otp){before=await snapshot();beforeSession=values.get('tracklog-driver-auth');beforeNative=JSON.stringify(authorization);}
 const record=()=>JSON.parse(values.get(candidate.CANDIDATE_RECORD_KEY)!);
 await c.handle(record().redirect+'&code=synthetic-code');
 assert.equal(await snapshot(),before,'candidate selection preserves all data');assert.equal(values.get('tracklog-driver-auth'),beforeSession);assert.equal(JSON.stringify(authorization),beforeNative);
 const callbacks=await import('../../src/services/nativeAuthCallbackPersistence');const keysBefore=[...values.keys()].sort();callbacks.persistNativeAuthCallbackUrl('com.tracklog.assist://auth?next=%2Fsettings&candidate='+record().id+'&code=synthetic');assert.deepEqual([...values.keys()].sort(),keysBefore);
 if(native){const {seedNativeDriverSessionBeforeClient}=await import('../../src/services/nativeAuthBootstrap');assert.equal(await seedNativeDriverSessionBeforeClient(),false);assert.equal(values.get('tracklog-driver-auth'),beforeSession);}
 assert.equal((await auth.handleDriverWebAuthCallbackUrl(record().redirect+'&code=old-code')).handled,false);
 if(scenario.startsWith('refresh-')) {
  let unhandled=false;process.on('unhandledRejection',()=>{unhandled=true});
  const original=IDBObjectStore.prototype.put;
  if(scenario==='refresh-storage-failure') {
    failStorage=true;IDBObjectStore.prototype.put=function(value:any,key:any){if(this.name==='sessions'&&key==='tracklog-driver-auth')throw Error('synthetic IDB failure');return original.call(this,value,key)};
  }
  const result=await supa.driverAuthSupabase!.auth.refreshSession();
  if(scenario==='refresh-storage-failure') {assert(result.error);assert.equal(values.get('tracklog-driver-auth'),beforeSession);}
  else {assert.equal(result.error,null);assert.equal(JSON.parse(values.get('tracklog-driver-auth')!).refresh_token,'synthetic-rotated');}
  await new Promise(r=>setTimeout(r,20));assert.equal(unhandled,false);
  failStorage=false;IDBObjectStore.prototype.put=original;
  assert.equal(await snapshot(),before);assert.equal(record().phase,'selected');
 }
 if(boundary){
  armed=true;
  const operation=auth.confirmDriverGoogleRegistration({displayName:'Synthetic Driver',phone:'09012345678',vehicleLabel:'札幌101か1234'},record().id);
  await Promise.race([interrupted,operation.then(()=>{throw Error('boundary was not reached: '+stage)})]);
  const tables=Object.fromEntries(await Promise.all(db.tables.map(async t=>[t.name,await t.toArray()])));
  assert.equal(record().phase,'committing');
  assert.equal(record().owner.id,uid);
  assert.equal(!!record().handoff,['handoff','active'].includes(stage));
  const allBefore=JSON.parse(before);db.tables.forEach((t,i)=>{if(t.name!=='meta')assert.deepEqual(tables[t.name],allBefore[i])});
  writeFileSync(process.argv[3],JSON.stringify({values:[...values],authorization,tables}));
  console.log('PASS interruption snapshot '+stage);process.exit(77);
 }
 if(scenario.startsWith('stale-')) {
  if(scenario==='stale-reauth')await assert.rejects(c.confirm(async()=>{},async()=>{throw Error('synthetic interruption')}));
  const React=require('react');const {act,create}=require('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const {default:Registration}=await import('../../src/ui/screens/DriverGoogleRegistration');
  let renderer:any,completed=0;
  const flush=async(fn:()=>any)=>act(async()=>{await fn();await new Promise(r=>setTimeout(r,80))});
  await flush(()=>{renderer=create(React.createElement(Registration,{onComplete:async()=>{completed++},onPendingChange:()=>{}}))});
  const inputs=renderer.root.findAllByType('input');
  await flush(()=>{inputs[1].props.onChange({target:{value:'Synthetic Driver'}});inputs[2].props.onChange({target:{value:'09012345678'}});inputs[3].props.onChange({target:{value:'札幌101か1234'}})});
  const old=record().id;
  const other=candidate.createDriverCandidateAuth({url:'https://synthetic.example.test',apiKey:'synthetic-test-key',storage,fetch:globalThis.fetch});
  if(scenario!=='stale-reauth')await other.discard();await other.start(false,win.location.origin,scenario==='stale-reauth');await other.handle(record().redirect+'&code=replacement');
  assert.notEqual(record().id,old);const replacement=[...values],beforeData=await snapshot(),nativeBefore=JSON.stringify(authorization);
  const text=scenario==='stale-confirm'?'このアカウントで登録を確定':scenario==='stale-reauth'?'同じGoogleアカウントで再認証':'仮ログインを取消';
  await flush(()=>renderer.root.findAllByType('button').find((b:any)=>b.children.join('')===text).props.onClick());
  assert.deepEqual([...values],replacement,'stale rendered action must not mutate replacement candidate or active session');
  assert.equal(await snapshot(),beforeData);assert.equal(JSON.stringify(authorization),nativeBefore);assert.equal(claims,0);assert.equal(installs,0);assert.equal(completed,0);
  assert.equal(renderer.root.findAllByProps({role:'alert'}).length,1);
  await flush(()=>renderer.unmount());await other.discard();await supa.driverAuthSupabase!.auth.stopAutoRefresh();db.close();console.log('PASS rendered stale action '+scenario);return;
 }
 if(replay){
  const profile={displayName:'Synthetic Driver',phone:'09012345678',vehicleLabel:'札幌101か1234'};
  const oldSession=values.get('tracklog-driver-auth'),tripBefore=JSON.stringify(await Promise.all(db.tables.filter(t=>t.name!=='meta').map(t=>t.toArray())));
  const attempt=record().id;
  await assert.rejects(auth.confirmDriverGoogleRegistration(profile,attempt));
  assert.equal(claims,1,'the first request reached and committed on the synthetic server');
  assert.equal(record().phase,'committing');assert.equal(record().handoff,undefined);
  await assert.rejects(c.discard(attempt));
  const first=await claimServer!.getProfile('web:synthetic-device');
  assert.equal(first.auth_user_id,uid);
  await auth.confirmDriverGoogleRegistration(profile,attempt);
  const final=await claimServer!.getProfile('web:synthetic-device');
  assert.equal((await claimServer!.profiles()).length,1);assert.equal(values.get('tracklog-driver-auth-owner-id'),uid);
  assert.equal((await db.meta.get('device_id'))?.value,'web:synthetic-device');
  assert.equal(final.auth_user_id,uid);assert.equal(final.approval_requested_at,first.approval_requested_at);
  assert.equal(final.approval_status,scenario==='claim-response-lost-approved'?'approved':'pending');
  assert.equal((await db.meta.get('driver_approval_status'))?.value,final.approval_status);
  assert.equal(values.get('tracklog-driver-auth'),oldSession);assert.equal(JSON.stringify(await Promise.all(db.tables.filter(t=>t.name!=='meta').map(t=>t.toArray()))),tripBefore);
  assert.equal(values.has(candidate.CANDIDATE_RECORD_KEY),false);assert.equal(claims,2);
  for(const [key,value] of Object.entries({device_display_name:profile.displayName,driver_phone:profile.phone,device_vehicle_label:profile.vehicleLabel}))assert.equal((await db.meta.get(key))?.value,value);
  await claimServer!.close();await supa.driverAuthSupabase!.auth.stopAutoRefresh();db.close();console.log('PASS actual claim handler response-loss recovery '+scenario);return;
 }
 const profile={displayName:'Synthetic Driver',phone:'09012345678',vehicleLabel:'札幌101か1234'};
 if(scenario==='wrong-owner'||scenario==='native-only-wrong'||scenario==='pinned-db-conflict'||scenario==='native-pinned-conflict'){
  await assert.rejects(auth.confirmDriverGoogleRegistration(profile,record().id));assert.equal(await snapshot(),before);assert.equal(JSON.stringify(authorization),beforeNative);assert.equal(claims,0);assert.equal(installs,0);await c.discard();
 }else{
  if(scenario==='storage-failure'){
   failStorage=true;const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value:any,key:any){if(this.name==='sessions'&&key==='tracklog-driver-auth')throw Error('synthetic IDB failure');return original.call(this,value,key)};
   await assert.rejects(auth.confirmDriverGoogleRegistration(profile,record().id));assert.equal(record().phase,'committing');assert.equal(await snapshot(),before);failStorage=false;IDBObjectStore.prototype.put=original;
  }
  if(installFail||claimFail){await assert.rejects(auth.confirmDriverGoogleRegistration(profile,record().id));assert.equal(record().phase,'committing');await assert.rejects(c.discard());installFail=false;claimFail=false;}
  await auth.confirmDriverGoogleRegistration(profile,record().id);assert.equal(values.has(candidate.CANDIDATE_RECORD_KEY),false);assert.equal((await supa.driverAuthSupabase!.auth.getUser()).data.user?.id,uid);assert.equal((await db.meta.get('driver_approval_status'))?.value,scenario==='approved-profile'?'approved':'pending');assert.equal((await db.meta.get('driver_email'))?.value,email);assert(claims>0);
  if(scenario==='same-owner'||scenario==='approved-profile'){assert.equal((await db.events.get('synthetic-event'))?.syncMutationId,'unsent-synthetic');assert.equal((await db.events.get('synthetic-event'))?.ownerUserId,uid)}
 }
 if(scenario==='approved-profile')for(const [key,value] of Object.entries({device_display_name:'Synthetic Driver',driver_phone:'09012345678',device_vehicle_label:'札幌101か1234'}))assert.equal((await db.meta.get(key))?.value,value);
 await supa.driverAuthSupabase!.auth.stopAutoRefresh();await supa.adminSupabase!.auth.stopAutoRefresh();db.close();console.log('PASS Google integration '+scenario);
}
main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
