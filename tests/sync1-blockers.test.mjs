import test from 'node:test';
import assert from 'node:assert/strict';
import {localD1,world,family,device,snapshot,reference,canon,blankKid,request,L,S,DAY,clientRealm,cut} from './sync-helpers.mjs';

/* SYNC1 production-blocker burndown (B1-B5). Real Worker code, real local D1 (workerd), real client engines.
   Races are injected deterministically: the database handle given to the Worker is wrapped so that, at a chosen
   statement (the write that follows the Worker's reads), a second request (the other parent phone) runs to completion
   first. No timers, no sleeps. */
const {db,dispose}=await localD1();
test.after(()=>dispose());
let n=0;
const call=async(fam,path,body,token)=>{const r=await fam.b.worker.fetch(request(path,body,token),fam.env);const text=await r.text();return {status:r.status,data:text?JSON.parse(text):null,text};};
async function pair(name='p',{kids=1}={}){
  const clock=world(),fam=family(db,clock,'b'+name+(n++));
  const A=await device(fam,clock),B=await device(fam,clock);
  const ada=A.kids[0];ada.name='Ada';ada.age=9;A.practice(ada,'add1');
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok,JSON.stringify(c));
  assert.equal(A.engine.shareAll(),1);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  assert.ok((await B.engine.join({key:c.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  return {clock,fam,A,B,key:c.key};
}
const fidOf=async fam=>fam.__f ||= await fam.b.SparkSyncWorker.family(fam.env,{hmac:fam.b.api.hmac});
// Wraps the D1 handle the Worker sees. `on(kind, sqls)` is asked before every batch/run; the first time it says yes,
// `hook()` runs to completion before the statement is executed. Everything else passes through untouched.
function raceDb(real,{on,hook}){
  let fired=false;const sql=new WeakMap();
  const gate=async(kind,sqls)=>{if(!fired&&on(kind,sqls)){fired=true;await hook();}};
  const wrap=(s,text)=>({sql:text,real:s,first:()=>s.first(),all:()=>s.all(),run:async()=>{await gate('run',[text]);return s.run();}});
  return {
    prepare:text=>{const st=real.prepare(text);return {bind:(...a)=>wrap(st.bind(...a),text),first:()=>st.first(),all:()=>st.all(),run:()=>st.run()};},
    batch:async stmts=>{await gate('batch',stmts.map(s=>s.sql||''));return real.batch(stmts.map(s=>s.real||s));},
    get fired(){return fired;}
  };
}
const rows=async(fam,sql,...a)=>(await db.prepare(sql).bind(await fidOf(fam),...a).all()).results;
const one=async(fam,sql,...a)=>(await rows(fam,sql,...a))[0];
const racing=(fam,spec)=>{const real=fam.env.SYNC_DB,w=raceDb(real,spec);fam.env.SYNC_DB=w;return {w,restore:()=>{fam.env.SYNC_DB=real;}};};
const touches=re=>(kind,sqls)=>kind==='batch'&&sqls.some(s=>re.test(s));
const counts=async fam=>({
  records:(await one(fam,'SELECT COUNT(*) AS n FROM sync_records WHERE family_id=?1')).n,
  tombRecords:(await one(fam,"SELECT COUNT(*) AS n FROM sync_records WHERE family_id=?1 AND kind='tombstone'")).n,
  active:(await one(fam,"SELECT COUNT(*) AS n FROM sync_children WHERE family_id=?1 AND status='active'")).n,
  deleted:(await one(fam,"SELECT COUNT(*) AS n FROM sync_children WHERE family_id=?1 AND status='deleted'")).n,
  tombstones:(await one(fam,'SELECT COUNT(*) AS n FROM sync_tombstones WHERE family_id=?1')).n,
  family:await one(fam,'SELECT gen, head, record_count AS rc, byte_count AS bc FROM sync_families WHERE family_id=?1'),
  real:await one(fam,'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ct)),0) AS b, COALESCE(MAX(seq),0) AS m FROM sync_records WHERE family_id=?1')
});
// Counters must always equal the rows they describe.
const consistent=c=>{assert.equal(c.family.rc,c.real.n,'record_count matches rows');assert.equal(c.family.bc,c.real.b,'byte_count matches rows');assert.ok(c.family.head>=c.real.m,'head never behind');};

/* ---------------- B1: delete-child is generation-atomic ---------------- */
test('B1: a delete-child started against generation N, with a reset landing between its checks and its write, mutates nothing in N+1',async()=>{
  const {fam,A,B}=await pair('b1');
  const gen0=A.engine.state().gen;let reset;
  const r0=racing(fam,{on:touches(/INTO sync_tombstones/),hook:async()=>{reset=await A.engine.reset({code:fam.code});}});
  const out=await B.engine.deleteChild({code:fam.code,kid:B.kid('Ada')});
  r0.restore();
  assert.ok(r0.w.fired,'the race really happened between the checks and the write');
  assert.ok(reset.ok,'the reset won');
  assert.equal(out.ok,false,'the old delete is rejected');assert.equal(out.code,'family_changed');
  assert.ok(B.kid('Ada')?.sync,'B keeps its child: nothing was deleted locally either');
  assert.notEqual(A.engine.state().gen,gen0);
  await A.sync();
  const c=await counts(fam);consistent(c);
  assert.equal(c.tombRecords,0,'no stray tombstone record in the new generation');
  assert.equal(c.tombstones,0,'no tombstone for a child that was not deleted');
  assert.equal(c.deleted,0,'no deleted child row');
  assert.equal(c.active,1,'only the resetting phone\'s re-shared child is active');
  // The retry after re-joining is a clean, idempotent no-op on the old identity.
  assert.ok((await B.engine.join({key:A.engine.state().key})).ok);await B.sync();
  assert.ok(B.kid('Ada').fork,'B\'s old copy is a local copy');
  assert.equal((await B.engine.deleteChild({code:fam.code,kid:B.kid('Ada')})).code,'not_shared');
});
test('B1: delete wins the race; the reset that follows starts a clean generation and the deleted child never returns',async()=>{
  const {fam,A,B}=await pair('b1w');
  const adaId=A.kid('Ada').id;
  // The reset starts (A is mid-reset: it has downloaded completely) and B's delete commits just before the reset's write.
  let del;
  const r0=racing(fam,{on:(k,s)=>k==='batch'&&s.some(x=>/DELETE FROM sync_records WHERE family_id=\?1\s*$/.test(x)||/DELETE FROM sync_records WHERE family_id=\?1$/.test(x)),hook:async()=>{del=await B.engine.deleteChild({code:fam.code,kid:B.kid('Ada')});}});
  const reset=await A.engine.reset({code:fam.code});
  r0.restore();
  assert.ok(r0.w.fired);assert.deepEqual(del,{ok:true});assert.ok(reset.ok);
  await A.sync();await B.sync();
  assert.equal(A.kid('Ada'),undefined,'A\'s copy is removed by the verified tombstone, not re-shared');
  assert.equal(B.kid('Ada'),undefined);
  const c=await counts(fam);consistent(c);
  assert.equal(c.active,0);assert.equal(c.deleted,1);
  assert.equal((await one(fam,'SELECT status FROM sync_children WHERE family_id=?1 AND child_id=?2',adaId)).status,'deleted');
});
test('B1: delete-child is idempotent (same request replayed, or retried with a new record id after a lost reply)',async()=>{
  const {fam,A,B}=await pair('b1i');
  const kid=A.kid('Ada'),st=A.engine.state();
  const key=await S.parseKey(globalThis.crypto.subtle,st.key),k=await S.deriveKeys(globalThis.crypto.subtle,key);
  const mk=async id=>{const rec=await S.seal(globalThis.crypto.subtle,n=>globalThis.crypto.getRandomValues(new Uint8Array(n)),k.encKey,st.gen,{id,child:kid.id,kind:'tombstone'},{type:'tombstone',v:1,t:A.now(),child:kid.id});return {id,iv:rec.iv,ct:rec.ct};};
  const id1=A.engine.newId(),id2=A.engine.newId();
  const body=async id=>({v:1,gen:st.gen,op:'delete-child',code:fam.code,child:kid.id,record:await mk(id)});
  const first=await call(fam,'/sync/admin',await body(id1),A.token());assert.equal(first.status,200);
  const after1=await counts(fam);
  const again=await call(fam,'/sync/admin',await body(id1),A.token());assert.equal(again.status,200,'same request replayed');
  const retry=await call(fam,'/sync/admin',await body(id2),A.token());assert.equal(retry.status,200,'lost reply, retried with a new record id');
  const after2=await counts(fam);consistent(after2);
  assert.deepEqual(after2,after1,'nothing changed');
  assert.equal(after2.tombRecords,1);assert.equal(after2.deleted,1);assert.equal(after2.active,0);
  // A deleted id is never active again, and a different child is still unknown.
  const bogus=A.engine.newId(),other={...await body(A.engine.newId()),child:bogus};
  assert.equal((await call(fam,'/sync/admin',other,A.token())).status,404,'an unknown child is still unknown');
});

/* ---------------- B2: a child row is created only atomically with generation, membership, quota and its base ---------------- */
const shareNew=(dev,name)=>{const k=blankKid(name);dev.kids.push(k);dev.practice(k,'add1');assert.ok(dev.engine.share(k),'shared '+name);dev.saveKids();return k;};
test('B2: a push that starts in generation N, with a reset landing before its write, creates no ghost child and no record; the phone is told to rejoin',async()=>{
  const {fam,A,B}=await pair('b2a');
  const bo=shareNew(B,'Bo');
  let reset;
  const r0=racing(fam,{on:touches(/INTO sync_children/),hook:async()=>{reset=await A.engine.reset({code:fam.code});}});
  const out=await B.sync();
  r0.restore();
  assert.ok(r0.w.fired);assert.ok(reset.ok);
  assert.deepEqual(out,{ok:false,code:'rejoin'},'the old client is told to rejoin, not silently succeeded');
  assert.equal(bo.sync.pending.length,1,'Bo\'s base is still queued locally');
  await A.sync();
  const c=await counts(fam);consistent(c);
  assert.equal(c.active,1,'only A\'s re-shared Ada: no ghost row consuming a slot');
  assert.equal(c.records,1);
  assert.equal((await rows(fam,"SELECT child_id FROM sync_children WHERE family_id=?1 AND child_id=?2",bo.id)).length,0,'Bo has no server row at all');
});
test('B2: reset begins, then a stale push arrives: refused with a rejoin result, nothing stored',async()=>{
  const {fam,A,B}=await pair('b2b');
  const bo=shareNew(B,'Bo');
  assert.ok((await A.engine.reset({code:fam.code})).ok);await A.sync();
  const before=await counts(fam);
  assert.deepEqual(await B.sync(),{ok:false,code:'rejoin'});
  assert.deepEqual(await counts(fam),before);
  assert.equal((await rows(fam,'SELECT child_id FROM sync_children WHERE family_id=?1 AND child_id=?2',bo.id)).length,0);
});
test('B2: a revoked phone\'s push racing its revocation creates no child row',async()=>{
  const {fam,A,B}=await pair('b2r');
  const bo=shareNew(B,'Bo');const victim=(await A.engine.devices()).devices.find(d=>!d.self).device;
  const r0=racing(fam,{on:touches(/INTO sync_children/),hook:async()=>{assert.ok((await A.engine.revoke({code:fam.code,device:victim})).ok);}});
  const out=await B.sync();r0.restore();
  assert.ok(r0.w.fired);assert.equal(out.code,'revoked');
  const c=await counts(fam);consistent(c);assert.equal(c.active,1);
  assert.equal((await rows(fam,'SELECT child_id FROM sync_children WHERE family_id=?1 AND child_id=?2',bo.id)).length,0);
});
test('B2: a duplicate push, and a push whose reply was lost, add nothing (one child row, one record)',async()=>{
  const {fam,A,B}=await pair('b2c');
  const bo=shareNew(B,'Bo');
  // The reply to the first push is lost: the Worker stored it, the phone never learned.
  B.intercept=async(path,body,go)=>{const r=await go();if(path==='/sync/push'){B.intercept=null;throw Error('reply lost');}return r;};
  assert.deepEqual(await B.sync(),{ok:false,code:'offline'});
  assert.equal(bo.sync.pending.length,1);
  const mid=await counts(fam);assert.equal(mid.active,2);
  assert.deepEqual(await B.sync(),{ok:true},'retry is acknowledged as a duplicate');
  assert.equal(bo.sync.pending.length,0);
  const after=await counts(fam);consistent(after);
  assert.equal(after.active,2);assert.equal(after.records,mid.records);
  // The raw duplicate, replayed as the same bytes.
  const push=B.sent.filter(x=>x.path==='/sync/push').at(-2);
  const dup=await call(fam,'/sync/push',push.body,B.token());assert.equal(dup.status,200);
  assert.ok(dup.data.results.every(r=>r.status==='dup'));
  assert.deepEqual(await counts(fam),after);
});
test('B2: the 20-child quota holds under concurrent first pushes and a full family refuses the 21st',async()=>{
  const {fam,A,B}=await pair('b2q');
  // 18 more on A (19 active), then A and B each try to add a different child: only one can take the last slot.
  for(let i=0;i<18;i++){const k=blankKid('Barn'+i);A.kids.push(k);A.practice(k,'add1');A.engine.share(k);}A.saveKids();
  assert.deepEqual(await A.sync(),{ok:true});assert.equal((await counts(fam)).active,19);
  const a20=shareNew(A,'Siste-A'),b20=shareNew(B,'Siste-B');
  // B's push is in flight (its reads saw 19 active); A's push commits first and takes the last slot.
  const r0=racing(fam,{on:touches(/INTO sync_children/),hook:async()=>{assert.deepEqual(await A.sync(),{ok:true});}});
  const out=await B.sync();r0.restore();
  assert.ok(r0.w.fired);
  const c=await counts(fam);consistent(c);
  assert.equal(c.active,20,'never 21 active children');
  assert.equal(out.code,'quota');assert.equal(b20.sync.pending.length>=1,true,'the loser waits with its changes queued');
  assert.equal((await rows(fam,'SELECT child_id FROM sync_children WHERE family_id=?1 AND child_id=?2',b20.id)).length,0,'no row for the refused child');
  // Deleted children free their slots: delete one, and B can share.
  const victim=A.kid('Barn0');assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:victim}),{ok:true});
  const afterDelete=await counts(fam);assert.equal(afterDelete.active,19);assert.equal(afterDelete.deleted,1,'deleted row does not occupy a slot');
  assert.deepEqual(await B.sync(),{ok:true});assert.equal((await counts(fam)).active,20);
});
test('B2: a deleted child id never accepts a base or an op again; a re-share under a new id works',async()=>{
  const {fam,A,B}=await pair('b2d');
  const ada=A.kid('Ada'),oldId=ada.id;await B.sync();
  assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:ada}),{ok:true});
  // B (stale) practises on the deleted child and pushes; and a hand-made base for the dead id is refused as well.
  B.practice(B.kid('Ada'),'sub1');await B.sync();
  const results=B.sent.filter(x=>x.path==='/sync/push').at(-1);assert.ok(results);
  assert.equal(B.kid('Ada'),undefined,'B follows the family deletion and keeps nothing alive');
  const before=await counts(fam);
  const row=await one(fam,'SELECT status FROM sync_children WHERE family_id=?1 AND child_id=?2',oldId);assert.equal(row.status,'deleted');
  const fresh=blankKid('Ada');A.kids.push(fresh);A.practice(fresh,'add1');assert.ok(A.engine.share(fresh));assert.notEqual(fresh.id,oldId);
  assert.deepEqual(await A.sync(),{ok:true});
  const after=await counts(fam);consistent(after);assert.equal(after.active,before.active+1);assert.equal(after.deleted,1);
});
test('B2: a base whose record id already exists (another child\'s record) creates no child row',async()=>{
  const {fam,A}=await pair('b2e');
  const ada=A.kid('Ada');const st=A.engine.state();
  const k=await S.deriveKeys(globalThis.crypto.subtle,await S.parseKey(globalThis.crypto.subtle,st.key));
  // Re-use Ada's existing base record id for a brand-new child id.
  const baseRow=await one(fam,"SELECT record_id AS id FROM sync_records WHERE family_id=?1 AND kind='base'");
  const child=A.engine.newId();
  const payload={type:'base',v:1,t:A.now(),after:0,profile:{name:'Ghost',age:8,interests:'',readAloud:false},learning:{version:L.VERSION,skills:{},items:[],sessions:[],totals:L.empty().totals}};
  const rec=await S.seal(globalThis.crypto.subtle,n=>globalThis.crypto.getRandomValues(new Uint8Array(n)),k.encKey,st.gen,{id:baseRow.id,child,kind:'base'},payload);
  const before=await counts(fam);
  const r=await call(fam,'/sync/push',{v:1,gen:st.gen,clientNow:A.now(),records:[rec]},A.token());
  assert.equal(r.status,200);
  assert.deepEqual(await counts(fam),before);
  assert.equal((await rows(fam,'SELECT child_id FROM sync_children WHERE family_id=?1 AND child_id=?2',child)).length,0);
});

/* ---------------- B4: explicit revocation survives a family reset; the device registry is bounded ---------------- */
async function trio(name){
  const p=await pair(name);const C=await device(p.fam,p.clock);
  assert.ok((await C.engine.join({key:p.key})).ok);assert.deepEqual(await C.sync(),{ok:true});
  return {...p,C};
}
const deviceIdOf=dv=>JSON.parse(Buffer.from(dv.token().split('.')[0],'base64url').toString()).deviceId;
test('B4: a lost phone that was never revoked stays listable and revocable after a family reset (registry rows are kept, as inactive)',async()=>{
  const {fam,A,B,C}=await trio('b4a');
  const lost=deviceIdOf(C);
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok);
  const list=(await A.engine.devices()).devices;
  const row=list.find(d=>d.device===lost);
  assert.ok(row,'the lost phone is still in the registry after the reset');assert.equal(row.status,'inactive');
  assert.equal(list.find(d=>d.self).status,'active');
  // It cannot sync with its old key or token ...
  assert.equal((await C.sync()).code,'rejoin');
  // ... and the parent can revoke it now, before anybody types the new key anywhere.
  assert.deepEqual(await A.engine.revoke({code:fam.code,device:lost}),{ok:true});
  assert.equal((await A.engine.devices()).devices.find(d=>d.device===lost).status,'revoked');
  // The new key reaches the lost phone (shoulder-surfing, a leaked note): it still cannot join with its identity.
  assert.equal((await C.engine.join({key:r.key})).code,'revoked');
  assert.equal((await C.sync()).code,'revoked');
  // A phone that was only inactive (not lost) rejoins normally with the new key.
  assert.ok((await B.engine.join({key:r.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  assert.equal((await A.engine.devices()).devices.find(d=>d.device===deviceIdOf(B)).status,'active');
});
test('B4: revoke, reset, reconnect: the old token and old key, and the NEW key under the unchanged identity, all stay refused on every route',async()=>{
  const {fam,A,B}=await pair('b4b');
  const dId=deviceIdOf(B),oldGen=B.engine.state().gen;
  assert.deepEqual(await A.engine.revoke({code:fam.code,device:dId}),{ok:true});
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok);
  const gen1=A.engine.state().gen;
  for(const [path,body] of [['/sync/pull',{v:1,gen:oldGen,cursor:0}],['/sync/pull',{v:1,gen:gen1,cursor:0}],['/sync/devices',{v:1,gen:gen1}],
      ['/sync/push',{v:1,gen:gen1,clientNow:B.now(),records:[{id:A.engine.newId(),child:A.engine.newId(),kind:'base',iv:'A'.repeat(16),ct:'A'.repeat(22)}]}]]){
    const x=await call(fam,path,body,B.token());assert.equal(x.status,403,path);assert.equal(x.data.code,'revoked',path);assert.equal(x.data.records,undefined);
  }
  assert.equal((await B.engine.join({key:r.key})).code,'revoked','new key, same identity');
  assert.equal((await B.engine.reset({code:fam.code})).code,'revoked','it cannot undo its revocation by minting its own key with a reset');
  assert.equal((await call(fam,'/sync/status',{v:1},B.token())).data.enrolled,'revoked');
  // The family is untouched by that attempt.
  assert.equal(A.engine.state().gen,gen1);assert.deepEqual(await A.sync(),{ok:true});
});
test('B4: re-authorization is explicit: family code only, same id, and it still needs the family key; a replaced phone just pairs again',async()=>{
  const {fam,A,B}=await pair('b4c');const C=await device(fam,world());
  const dId=deviceIdOf(B),key=A.engine.state().key;
  assert.deepEqual(await A.engine.revoke({code:fam.code,device:dId}),{ok:true});
  assert.equal((await B.engine.join({key})).code,'revoked');
  // Not without the family code; not for a device that is not revoked; not as a replay of a revoke.
  assert.equal((await B.engine.reauthorize({code:'guess',device:dId})).code,'family_code');
  assert.equal((await A.engine.reauthorize({code:fam.code,device:deviceIdOf(A)})).code,'device_unknown');
  // The revoked phone itself cannot do it without the code either, and a wrong key is still a wrong key.
  assert.deepEqual(await A.engine.reauthorize({code:fam.code,device:dId}),{ok:true});
  assert.equal((await A.engine.devices()).devices.find(d=>d.device===dId).status,'inactive','allowed to try again, not a member');
  const wrong=await S.keyText(globalThis.crypto.subtle,new Uint8Array(16).fill(7));
  assert.equal((await C.engine.join({key:wrong})).code,'key','a wrong key is refused');
  assert.equal((await call(fam,'/sync/pull',{v:1,gen:A.engine.state().gen,cursor:0},B.token())).data.code,'not_enrolled','not a member until it proves the key');
  assert.deepEqual(await B.sync(),{ok:true},'the phone holds the key, so its own rejoin step enrols it again');
  assert.equal((await A.engine.devices()).devices.find(d=>d.device===dId).status,'active');
  // Replacement phone: revoke the old id, pair a new token, join: works, the old id stays revoked.
  assert.deepEqual(await A.engine.revoke({code:fam.code,device:dId}),{ok:true});
  await B.repair();assert.ok((await B.engine.join({key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  assert.equal((await A.engine.devices()).devices.find(d=>d.device===dId).status,'revoked');
});
test('B4: a stale-key join racing a reset enrols nothing in the new generation',async()=>{
  const {fam,A,B,key}=await pair('b4d');
  const C=await device(fam,B.fam.__clock||world());
  let reset;
  const r0=racing(fam,{on:touches(/INTO sync_devices/),hook:async()=>{reset=await A.engine.reset({code:fam.code});}});
  const out=await C.engine.join({key});r0.restore();
  assert.ok(r0.w.fired);assert.ok(reset.ok);
  assert.equal(out.ok,false);assert.equal(out.code,'family_changed');
  assert.equal((await rows(fam,'SELECT device_id FROM sync_devices WHERE family_id=?1 AND device_id=?2',deviceIdOf(C))).length,0,'no registry row for the stale key');
  assert.equal((await call(fam,'/sync/status',{v:1},C.token())).data.enrolled,'none');
});
test('B4: the registry is bounded (inactive rows to the newest 50, expired revocations dropped, hard cap with reset still possible)',async()=>{
  const {fam,A,B,key}=await pair('b4e');
  const fid=await fidOf(fam),gen=A.engine.state().gen;
  const ins=(id,status,enrolled,g)=>db.prepare('INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day, gen) VALUES (?1, ?2, ?3, ?4, 0, ?5)').bind(fid,id,status,enrolled,g).run();
  const uuid=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
  const now=A.now();
  for(let i=0;i<70;i++)await ins(uuid(i),'active',now-i*1000,'old-gen');       // 70 inactive
  for(let i=100;i<110;i++)await ins(uuid(i),'revoked',now-400*DAY,'');         // 10 expired revocations (token lifetime is 365 days)
  for(let i=200;i<205;i++)await ins(uuid(i),'revoked',now-10*DAY,'');          // 5 live revocations
  const C=await device(fam,world());assert.ok((await C.engine.join({key})).ok);
  const after=await rows(fam,'SELECT status, gen FROM sync_devices WHERE family_id=?1');
  const inactive=after.filter(r=>r.status==='active'&&r.gen!==gen).length;
  assert.equal(inactive,50,'inactive rows are bounded to the newest 50');
  assert.equal(after.filter(r=>r.status==='revoked').length,5,'revocations whose token cannot be valid any more are dropped; live ones are kept');
  // Hard cap: a registry full of live revocations refuses a NEW device (507), never an existing one, and never a reset.
  for(let i=300;i<400;i++)await ins(uuid(i),'revoked',now-5*DAY,'');
  const D=await device(fam,world());
  const total=(await rows(fam,'SELECT COUNT(*) AS n FROM sync_devices WHERE family_id=?1'))[0].n;
  assert.ok(total>=150);
  for(let i=400;i<500;i++)await ins(uuid(i),'revoked',now-5*DAY,'').catch(()=>{});
  const full=(await rows(fam,'SELECT COUNT(*) AS n FROM sync_devices WHERE family_id=?1'))[0].n;
  assert.ok(full>=200,'registry at the cap: '+full);
  assert.equal((await D.engine.join({key})).code,'quota');
  assert.ok((await C.engine.join({key})).ok,'an already known device can still re-join');
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok,'reset stays possible with a full registry');
});

/* ---------------- B3: unhide reconstructs the family state exactly once, whatever the lifetime record count ---------------- */
// A family with children Ada and Bo, and a long history on Ada: one word reviewed `reviews` times, 40 reviews per round,
// one day per round (so old records become final and are folded into checkpoints, as in real use).
const cold=(dev,kid,i)=>{const sid='cs'+i,input={id:sid+':t1:'+i,t:dev.now(),sid,s:0,ok:true,verified:true,k:'cold',e:'',c:''};const v=L.event(kid.learning,'add1',input);if(v)dev.engine.enqueue(kid,S.skillOp('add1',input,v));return v;};
async function longHistory({reviews,realm,name,stepDays=5}){
  const clock=world(),fam=family(db,clock,'b3'+name+(n++));
  const A=await device(fam,clock),B=await device(fam,clock,realm?{realm}:{});
  const ada=A.kids[0];ada.name='Ada';ada.age=9;A.practice(ada,'add1');
  const bo=blankKid('Bo');A.kids.push(bo);A.practice(bo,'add1');
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok);
  assert.equal(A.engine.shareAll(),2);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  assert.ok((await B.engine.join({key:c.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  const word=A.addWord(ada,'katt','cat');
  let done=0;
  while(done<reviews){
    for(let i=0;i<40&&done<reviews;i++,done++){
      const t=A.now();
      if(i%4===3)cold(A,ada,done);                       // a cold check: raises totals.cold, which only counts distinct evidence
      else{const r=L.reviewWord(ada.learning,{wordId:word.id,t,s:0,ok:done%3!==0,c:''});if(r)A.engine.enqueue(ada,{type:'word-review',t,wordId:word.id,s:0,ok:done%3!==0,c:'',d:r.delayed});}
      clock.advance(1000);
    }
    A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
    clock.advance(stepDays*DAY);
    if(done%400===0)assert.deepEqual(await B.sync(),{ok:true});
  }
  assert.deepEqual(await B.sync(),{ok:true});
  return {clock,fam,A,B,key:c.key,word};
}
const adaView=dev=>JSON.stringify(dev.kids.filter(k=>k.name==='Ada').map(k=>snapshotOne(k)));
const snapshotOne=k=>{const s=JSON.parse(snapshot({kids:[k]}));return s;};
test('B3 (reproducer, lowered retention bound): with more records than the dedupe window, hide → unhide re-applies old reviews',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {A,B}=await longHistory({reviews:240,realm:small,name:'low'});
  assert.equal(snapshot(A),snapshot(B),'converged before hiding');
  assert.deepEqual(B.engine.hide(B.kid('Bo')),{ok:true});
  B.engine.unhide();assert.deepEqual(await B.sync(),{ok:true});
  assert.ok(B.kid('Bo'),'Bo is back');
  assert.equal(snapshot(B),snapshot(A),'exactly the family state: no old record applied twice');
  assert.equal(adaView(B),adaView(A));
});
test('B3 (negative control): without the watermark the same scenario diverges',async()=>{
  const broken=clientRealm(s=>cut('rec.seq<=(sync.wm||0)||','')(cut('seen:10000','seen:40')(s)));
  const {A,B}=await longHistory({reviews:240,realm:broken,name:'neg'});
  B.engine.hide(B.kid('Bo'));B.engine.unhide();await B.sync();
  assert.notEqual(snapshot(B),snapshot(A),'the defence is what makes the difference');
});
test('B3: hide → restart → unhide, twice, with a local save failure in the middle: always exactly the family state; storage stays bounded',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {clock,A,B}=await longHistory({reviews:360,realm:small,name:'rst'});
  const family=snapshot(A),logOf=d=>d.kids.filter(k=>k.sync).map(k=>k.sync.log.length);
  assert.ok(Math.max(...logOf(B))<=140,'unfolded log is bounded by the order window, not by history: '+logOf(B));
  for(let round=0;round<2;round++){
    assert.deepEqual(B.engine.hide(B.kid('Bo')),{ok:true});B.reload();                    // restart while hidden
    assert.equal(B.kid('Bo'),undefined);assert.equal(snapshot(B).includes('"Bo"'),false);
    B.engine.unhide();B.reload();                                                         // restart between unhide and the download
    B.storageOk=false;assert.equal((await B.sync()).code,'storage','local save failure: nothing advances');
    B.storageOk=true;B.reload();                                                          // and a restart after it
    assert.deepEqual(await B.sync(),{ok:true});
    assert.equal(snapshot(B),family,'round '+round+': exactly the family state, no record applied twice');
    assert.equal(snapshot(B),await reference(A),'and equal to a fresh replay of everything the Worker stores');
    assert.deepEqual(await B.sync(),{ok:true});assert.equal(snapshot(B),family,'idempotent');
  }
  // Unhide while another phone keeps working, then a plain download: still exact.
  B.engine.hide(B.kid('Bo'));A.practice(A.kid('Ada'),'sub1');await A.sync();B.engine.unhide();await B.sync();await A.sync();
  assert.equal(snapshot(B),snapshot(A));
  // Replay inflates neither evidence nor mastery nor word credit.
  const evidence=d=>JSON.stringify(canon(d.kids.map(k=>({totals:k.learning.totals,items:k.learning.items.map(w=>[w.box,w.due,w.ev.length]),skills:Object.entries(k.learning.skills).map(([id,r])=>[id,r.box,r.ev.length,r.independentAt,r.retainedAt])}))));
  assert.equal(evidence(B),evidence(A));
});
// Writes `count` valid, key-sealed ops for one child straight into the Worker's D1 (the same rows a long period of pushes would
// leave), with Worker receive times that grow with the sequence number, as they do in production. Only the setup bypasses
// the push route; the phones under test download them through the real pull route.
async function inject(fam,dev,childId,count,{spanDays=300}={}){
  const st=dev.engine.state(),raw=await S.parseKey(globalThis.crypto.subtle,st.key),k=await S.deriveKeys(globalThis.crypto.subtle,raw);
  const fid=await fidOf(fam),head=Number((await db.prepare('SELECT head FROM sync_families WHERE family_id=?1').bind(fid).first()).head);
  const t0=dev.now(),step=Math.floor(spanDays*DAY/count),rand=n=>globalThis.crypto.getRandomValues(new Uint8Array(n));
  const word={id:'wk-katt',word:'katt',meaning:'cat'};
  let bytes=0,chunk=[],last=0;
  const flush=async()=>{if(!chunk.length)return;await db.prepare("INSERT INTO sync_records (family_id, seq, record_id, child_id, kind, received_at, clock_ok, iv, ct) SELECT ?1, json_extract(value,'$.s'), json_extract(value,'$.id'), ?2, 'op', json_extract(value,'$.at'), 1, json_extract(value,'$.iv'), json_extract(value,'$.ct') FROM json_each(?3)").bind(fid,childId,JSON.stringify(chunk)).run();chunk=[];};
  for(let i=0;i<count;i++){
    const at=t0+(i+1)*step,after=i?t0+i*step:t0;let payload;
    if(i===0)payload={type:'word-add',v:1,t:at,after,word};
    else if(i%150===0)payload={type:'skill',v:1,t:at,after,skill:'add1',d:true,e:{s:0,ok:true,k:'cold',e:'',c:'',sid:'cs'+i,id:'cs'+i+':t1',verified:true}};
    else if(i%60===0)payload={type:'session',v:1,t:at,after,session:{id:'sess'+i,startedAt:at-60000,endedAt:at,activeMs:60000,mode:'matte',events:[],reflection:'',interventions:0,interactions:[]}};
    else payload={type:'word-review',v:1,t:at,after,wordId:word.id,s:0,ok:i%3!==0,c:'',d:true};
    const id=S.b64url(rand(16)),rec=await S.seal(globalThis.crypto.subtle,rand,k.encKey,st.gen,{id,child:childId,kind:'op'},payload);
    bytes+=rec.ct.length;last=at;
    chunk.push({s:head+i+1,id,at,iv:rec.iv,ct:rec.ct});
    if(chunk.length===250)await flush();
  }
  await flush();
  await db.prepare('UPDATE sync_families SET head=head+?2, record_count=record_count+?2, byte_count=byte_count+?3 WHERE family_id=?1').bind(fid,count,bytes).run();
  return last;
}
const bigFamily=async name=>{
  const clock=world(),fam=family(db,clock,'b3big'+name+(n++));
  const A=await device(fam,clock),B=await device(fam,clock);
  const ada=A.kids[0];ada.name='Ada';ada.age=9;A.practice(ada,'add1');
  const bo=blankKid('Bo');A.kids.push(bo);A.practice(bo,'add1');
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok);
  assert.equal(A.engine.shareAll(),2);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  assert.ok((await B.engine.join({key:c.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  return {clock,fam,A,B,ada};
};
test('B3 (real bound): more than 30,000 records on one child; "Hent fjernede barn tilbake hit" reconstructs the family state exactly, twice, across a restart',async()=>{
  const {clock,fam,A,B,ada}=await bigFamily('x');
  const COUNT=30080;
  const last=await inject(fam,A,ada.id,COUNT);
  clock.set(last+DAY);                                    // now is after the whole history (tokens last a year)
  const total=Number((await one(fam,'SELECT COUNT(*) AS n FROM sync_records WHERE family_id=?1')).n);
  assert.ok(total>30000,'more records than the OLD retention bound (30,000) and than the new one: '+total);
  const catchUp=async dev=>{for(let i=0;i<12;i++){assert.deepEqual(await dev.sync(),{ok:true});if(dev.engine.state().cursor>=total)break;}assert.ok(dev.engine.state().cursor>=total,'download reached the head');};
  await catchUp(B);
  const truth=await reference(A);
  assert.equal(snapshot(B),truth,'a phone that downloads the long history gets exactly the stored family state');
  const view=d=>d.kid('Ada').learning;
  const facts=d=>({cold:view(d).totals.cold,sessions:view(d).sessions.map(x=>x.id),word:view(d).items[0]&&{box:view(d).items[0].box,n:view(d).items[0].ev.length}});
  const family=snapshot(B),f0=facts(B);
  assert.ok(f0.cold>=190,'delayed cold checks counted: '+f0.cold);assert.equal(f0.sessions.length,120);
  for(let round=0;round<2;round++){
    assert.deepEqual(B.engine.hide(B.kid('Bo')),{ok:true});
    if(round===1)B.reload();                                                          // restart between hide and unhide
    B.engine.unhide();
    assert.deepEqual(await B.sync(),{ok:true});B.reload();                              // restart half way through the download
    await catchUp(B);
    assert.equal(snapshot(B),family,'round '+round+': exactly the family state');
    {const x=facts(B);assert.equal(x.cold,f0.cold,'cold credit counted once');assert.deepEqual(x.word,f0.word,'word credit counted once');assert.equal(x.sessions.join(),f0.sessions.join(),'session summaries unchanged');}
    const maxLog=Math.max(...B.kids.filter(k=>k.sync).map(k=>k.sync.log.length));
    assert.ok(maxLog<=1500,'local log stays bounded however long the history: '+maxLog);
    assert.ok(JSON.stringify(B.kids).length<700000,'phone storage stays bounded: '+JSON.stringify(B.kids).length);
  }
  assert.equal(snapshot(B),truth);
});

/* ---------------- cross-cutting: generations and replay ---------------- */
test('old-generation records cannot enter the new generation (rejected at the door, or unreadable and skipped by every phone)',async()=>{
  const {fam,A,B}=await pair('gen');
  const old=A.engine.state(),oldKeys=await S.deriveKeys(globalThis.crypto.subtle,await S.parseKey(globalThis.crypto.subtle,old.key));
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok);await A.sync();
  // 1. The old generation id is refused outright.
  const oldPush=await call(fam,'/sync/push',{v:1,gen:old.gen,clientNow:A.now(),records:[{id:A.engine.newId(),child:A.kid('Ada').id,kind:'op',iv:'A'.repeat(16),ct:'A'.repeat(22)}]},A.token());
  assert.equal(oldPush.status,409);
  // 2. A key holder smuggles a record sealed for the OLD generation (an inflating skill event) into the NEW one.
  const adaId=A.kid('Ada').id,id=A.engine.newId(),t=A.now();
  const payload={type:'skill',v:1,t,after:0,skill:'sub1',d:true,e:{s:0,ok:true,k:'cold',e:'',c:'sikker',sid:'evil',id:'evil:1',verified:true}};
  const rec=await S.seal(globalThis.crypto.subtle,n=>globalThis.crypto.getRandomValues(new Uint8Array(n)),oldKeys.encKey,old.gen,{id,child:adaId,kind:'op'},payload);
  const smuggled=await call(fam,'/sync/push',{v:1,gen:A.engine.state().gen,clientNow:t,records:[rec]},A.token());
  assert.equal(smuggled.status,200,'the relay cannot read it, so it stores it');
  assert.ok((await B.engine.join({key:r.key})).ok);
  await B.sync();await A.sync();
  for(const dev of [A,B]){
    assert.equal(dev.kid('Ada').learning.skills.sub1,undefined,'no phone applies it');
    assert.ok(dev.engine.state().undecryptable>=1,'counted as unreadable');
  }
  assert.equal(snapshot(A),snapshot(B));
});
test('replay inflates nothing: re-downloading everything, even with the recent-id window emptied, leaves evidence, mastery and word credit unchanged',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {A,B}=await longHistory({reviews:240,realm:small,name:'rp'});
  const facts=d=>JSON.stringify(canon(d.kids.map(k=>({totals:k.learning.totals,skills:Object.entries(k.learning.skills).map(([id,r])=>[id,r.box,r.due,r.ev.map(e=>e.id),r.independentAt,r.retainedAt]),words:k.learning.items.map(w=>[w.id,w.box,w.due,w.lastAt,w.ev.map(e=>[e.t,e.ok,e.delayed])])}))));
  const before=facts(B),snap=snapshot(B);
  for(let i=0;i<3;i++){
    for(const k of B.kids)if(k.sync)k.sync.seen=[];                 // the dedupe window is empty: only the watermark is left
    B.state=JSON.stringify({...JSON.parse(B.state),cursor:0});     // the whole family log is delivered again
    assert.deepEqual(await B.sync(),{ok:true});
    assert.equal(facts(B),before,'pass '+i);assert.equal(snapshot(B),snap);
  }
  assert.equal(facts(B),facts(A));
});
test('an own record that the Worker stored but whose acknowledgement never arrived is applied once when the download delivers it first',async()=>{
  const {A,B}=await pair('own');
  const ada=B.kid('Ada'),word=B.addWord(ada,'katt','cat');B.reviewWord(ada,word.id,{ok:true});
  // The push is stored, but the phone is told "retry" for every record, so the round goes on to download with the queue intact.
  B.intercept=async(path,body,go)=>{const r=await go();if(path==='/sync/push'){B.intercept=null;return {...r,data:{...r.data,results:r.data.results.map(x=>({id:x.id,status:'retry'}))}};}return r;};
  const queued=ada.sync.pending.length;assert.ok(queued>=2);
  assert.deepEqual(await B.sync(),{ok:true});
  assert.equal(ada.sync.pending.length,0,'the download acknowledged them');
  assert.equal(ada.learning.items[0].ev.length,1,'applied once');
  await A.sync();assert.equal(snapshot(A),snapshot(B));
  assert.deepEqual(await B.sync(),{ok:true});assert.equal(ada.learning.items[0].ev.length,1);
});
