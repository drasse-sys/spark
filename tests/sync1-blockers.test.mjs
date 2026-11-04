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
  assert.equal(c.active,0);assert.equal(c.deleted,0,'deleted ids belong to the old generation; the new one starts clean');
  assert.equal(c.tombstones,1,'the tombstone survives, so phones that re-join verify the deletion and drop their copy');
  assert.equal((await rows(fam,'SELECT status FROM sync_children WHERE family_id=?1 AND child_id=?2',adaId)).length,0);
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
async function longHistory({reviews,realm,name,stepDays=5,extras=false}){
  const clock=world(),fam=family(db,clock,'b3'+name+(n++));
  const A=await device(fam,clock),B=await device(fam,clock,realm?{realm}:{});
  const ada=A.kids[0];ada.name='Ada';ada.age=9;A.practice(ada,'add1');
  const bo=blankKid('Bo');A.kids.push(bo);A.practice(bo,'add1');
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok);
  assert.equal(A.engine.shareAll(),2);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  assert.ok((await B.engine.join({key:c.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  if(extras){                                           // early operations of every kind, so they are old when replay is tried
    const hund=A.addWord(ada,'hund','dog');A.reviewWord(ada,hund.id,{ok:true});A.clearWords(ada);
    A.archive(ada,{id:'early-1'});A.archive(ada,{id:'early-2'});
    A.profile(ada,{interests:'fotball'});
    A.engine.enqueue(ada,{type:'helped',t:A.now(),skill:'add1',value:'Tallinje'});ada.learning.skills.add1.helped='Tallinje';A.saveKids();
    clock.advance(DAY);
  }
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
test('B3 (negative control): without the watermark (and the operation identity) the same scenario diverges',async()=>{
  const broken=clientRealm(s=>cut('if(!firstUse(st,p))return st;','')(cut('rec.seq<=(sync.wm||0)||','')(cut('seen:10000','seen:40')(s))));
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
    const at=t0+(i+1)*step,after=i?t0+i*step:t0,o={s:'InjectStrm01',n:i+1};let payload;
    if(i===0)payload={type:'word-add',v:2,o,t:at,after,word};
    else if(i%150===0)payload={type:'skill',v:2,o,t:at,after,skill:'add1',d:true,e:{s:0,ok:true,k:'cold',e:'',c:'',sid:'cs'+i,id:'cs'+i+':t1',verified:true}};
    else if(i%60===0)payload={type:'session',v:2,o,t:at,after,session:{id:'sess'+i,startedAt:at-60000,endedAt:at,activeMs:60000,mode:'matte',events:[],reflection:'',interventions:0,interactions:[]}};
    else payload={type:'word-review',v:2,o,t:at,after,wordId:word.id,s:0,ok:i%3!==0,c:'',d:true};
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
  // A compromised relay now serves the very first review again, thirty thousand records later, with a fresh sequence number and
  // a receive time that sorts it after everything: it is not remembered by the id window and it is long folded.
  const first=(await db.prepare("SELECT seq, record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records WHERE family_id=?1 AND child_id=?2 ORDER BY seq LIMIT 1 OFFSET 2").bind(await fidOf(fam),ada.id).first());
  assert.ok(!B.kid('Ada').sync.seen.includes(first.id.slice(0,16)),'the id window has long forgotten it');
  assert.ok(B.kid('Ada').sync.wm>first.seq+10000,'and it is more than 10,000 records old');
  for(const restart of [false,true]){
    if(restart)B.reload();
    replayVia(B,[first],{at:clock.now()+30*DAY});assert.deepEqual(await B.sync(),{ok:true});await resumeAtHead(fam,B);
    assert.equal(snapshot(B),truth,'replay after >10,000 later records (restart: '+restart+') changed nothing');
    assert.equal(JSON.stringify(facts(B)),JSON.stringify(f0));
  }
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

/* ---------------- R1: a compromised relay cannot replay old learning evidence as new ---------------- */
// What a malicious Worker can do: take a stored record (same id, same ciphertext) and serve it again under a fresh sequence number.
async function storedOps(fam,dev,type){
  const st=dev.engine.state(),k=await S.deriveKeys(globalThis.crypto.subtle,await S.parseKey(globalThis.crypto.subtle,st.key));
  const fid=await fidOf(fam),out=[];
  for(const r of (await db.prepare("SELECT seq, record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records WHERE family_id=?1 AND kind='op' ORDER BY seq").bind(fid).all()).results){
    const p=await S.open(globalThis.crypto.subtle,k.encKey,st.gen,r);if(p&&p.type===type)out.push({row:r,p});
  }
  return out;
}
const replayVia=(dev,rows,{at}={})=>{dev.intercept=async(path,body,go)=>{
  const r=await go();if(path!=='/sync/pull'||r.status!==200||r.data.more)return r;       // served with the last page of a download
  const data=JSON.parse(JSON.stringify(r.data));let seq=Math.max(data.next,data.head,Number(body.cursor));
  for(const x of rows){seq++;data.records.push({seq,id:x.id,child:x.child,kind:x.kind,at:at??data.serverNow,ck:1,iv:x.iv,ct:x.ct});}
  data.next=seq;data.head=seq;dev.intercept=null;return {...r,data};
};};
// The relay's invented sequence numbers are not the Worker's real ones: point the phone's cursor back at the real head.
const realHead=async(fam)=>Number((await one(fam,'SELECT head FROM sync_families WHERE family_id=?1')).head);
const resumeAtHead=async(fam,dev)=>{const h=await realHead(fam);dev.state=JSON.stringify({...JSON.parse(dev.state),cursor:h});for(const k of dev.kids)if(k.sync)k.sync.wm=Math.min(k.sync.wm,h);};   // (a relay that lied about sequence numbers can make a phone skip records: DoS, not evidence)
const evidenceFacts=d=>JSON.stringify(canon(d.kids.map(k=>({totals:k.learning.totals,skills:Object.entries(k.learning.skills).map(([id,r])=>[id,r.box,r.due,r.ev.map(e=>e.id),r.independentAt,r.retainedAt]),words:k.learning.items.map(w=>[w.id,w.box,w.due,w.lastAt,w.ev.map(e=>[e.t,e.ok,e.delayed])]),sessions:k.learning.sessions.map(s=>s.id)}))));
test('R1: an old word-review record served again under a new sequence number, after the recent-id window forgot it, gains nothing',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {A,B,fam}=await longHistory({reviews:240,realm:small,name:'r1'});
  assert.equal(B.kid('Ada').sync.seen.length,40,'the id window is full and has forgotten the early records');
  const old=(await storedOps(fam,B,'word-review'))[3];assert.ok(old,'an early review');
  assert.ok(!B.kid('Ada').sync.seen.includes(old.row.id.slice(0,16)),'its id is no longer remembered');
  A.practice(A.kid('Ada'),'sub1');await A.sync();             // one honest new event for the next download
  // The relay also chooses the receive time (`at`), so it can order the replay after everything else.
  replayVia(B,[old.row],{at:A.now()+30*DAY});assert.deepEqual(await B.sync(),{ok:true});
  await resumeAtHead(fam,B);await A.sync();
  assert.equal(evidenceFacts(B),evidenceFacts(A),'only the honest new event arrived; the replay added nothing');
  assert.equal(snapshot(B),snapshot(A));
});
const AT_END=A=>({at:A.now()+30*DAY});
test('R2: every kind of operation is replay-safe, however old it is and wherever the relay orders it (skill, word-add, word-review, session, profile, helped)',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {A,B,fam}=await longHistory({reviews:240,realm:small,name:'r2',extras:true});
  const all=[];
  for(const type of ['skill','word-add','word-review','word-remove','session','profile','helped']){
    const ops=await storedOps(fam,B,type);assert.ok(ops.length,'a stored '+type);all.push(...ops.slice(0,type==='word-review'?3:2));
  }
  const mine=all.map(x=>x.row);
  assert.ok(mine.every(r=>!B.kid('Ada').sync.seen.includes(r.id.slice(0,16))||r.seq>B.kid('Ada').sync.wm),'old ones are forgotten by the id window');
  A.practice(A.kid('Ada'),'sub1');await A.sync();await B.sync();
  B.reviewWord(B.kid('Ada'),B.kid('Ada').learning.items[0].id,{ok:true});await B.sync();await A.sync();   // honest work still counts
  assert.equal(snapshot(A),snapshot(B));
  const before=evidenceFacts(A);
  replayVia(B,mine,AT_END(A));assert.deepEqual(await B.sync(),{ok:true});await resumeAtHead(fam,B);await A.sync();
  assert.equal(evidenceFacts(B),evidenceFacts(A));assert.equal(evidenceFacts(A),before);
  assert.equal(snapshot(B),snapshot(A));
  assert.equal(B.kid('Ada').learning.items.some(w=>w.word==='hund'),false,'a removed word is not resurrected by replaying its word-add');
  assert.equal(B.kid('Ada').learning.sessions.length,2);
});
test('R3: replay after restart, after hide/unhide and while a rebuild is in progress; honest events keep working',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {A,B,fam}=await longHistory({reviews:240,realm:small,name:'r3',extras:true});
  const old=(await storedOps(fam,B,'word-review')).slice(0,3).map(x=>x.row),before=evidenceFacts(B);
  B.reload();                                                                     // restart
  A.practice(A.kid('Ada'),'sub1');await A.sync();
  replayVia(B,old,AT_END(A));assert.deepEqual(await B.sync(),{ok:true});await resumeAtHead(fam,B);await A.sync();
  assert.equal(evidenceFacts(B),evidenceFacts(A));
  // hide, unhide: the family log is delivered again, with the replay mixed into the rebuild.
  B.engine.hide(B.kid('Bo'));B.engine.unhide();B.reload();
  replayVia(B,old,AT_END(A));assert.deepEqual(await B.sync(),{ok:true});await resumeAtHead(fam,B);
  assert.equal(evidenceFacts(B),evidenceFacts(A));assert.equal(snapshot(B),snapshot(A));
  // Even a brand-new phone that downloads a log containing a duplicate of an old record applies it once.
  const C=await device(fam,B.fam.__clock||world(),{realm:small});assert.ok((await C.engine.join({key:A.engine.state().key})).ok);
  replayVia(C,old,AT_END(A));assert.deepEqual(await C.sync(),{ok:true});await resumeAtHead(fam,C);assert.deepEqual(await C.sync(),{ok:true});
  assert.equal(evidenceFacts(C),evidenceFacts(A));
  // Honest new work still counts, exactly once, on every phone. (A relay that chooses receive times can make a phone fold early and
  // so change the ORDER derived state is computed in; that is the documented re-timing power. It must not add or remove evidence,
  // so the probe is a distinct session summary.)
  B.archive(B.kid('Ada'),{id:'honest-1'});await B.sync();await A.sync();await C.sync();
  for(const d of [A,B,C])assert.equal(d.kid('Ada').learning.sessions.filter(x=>x.id==='honest-1').length,1);
  assert.equal(A.kid('Ada').learning.sessions.length,B.kid('Ada').learning.sessions.length);assert.equal(A.kid('Ada').learning.sessions.length,C.kid('Ada').learning.sessions.length);
});
test('R4: the operation identity is authenticated: an altered identity, record id, child or generation fails to open; a relay cannot mint a fresh one',async()=>{
  const {fam,A}=await pair('r4');
  const ada=A.kid('Ada');A.addWord(ada,'katt','cat');await A.sync();
  const [op]=await storedOps(fam,A,'word-add');assert.equal(op.p.v,2);assert.match(op.p.o.s,/^[A-Za-z0-9_-]{12}$/);assert.equal(op.p.o.n>=1,true);
  const st=A.engine.state(),k=await S.deriveKeys(globalThis.crypto.subtle,await S.parseKey(globalThis.crypto.subtle,st.key));
  const open=r=>S.open(globalThis.crypto.subtle,k.encKey,st.gen,r);
  assert.ok(await open(op.row),'control: the stored record opens');
  const flip=(t,i)=>t.slice(0,i)+(t[i]==='A'?'B':'A')+t.slice(i+1);
  for(const i of [0,5,20,40])assert.equal(await open({...op.row,ct:flip(op.row.ct,i)}),null,'a changed ciphertext (e.g. a changed counter) does not authenticate: byte '+i);
  assert.equal(await open({...op.row,id:A.engine.newId()}),null,'another record id');
  assert.equal(await open({...op.row,child:A.engine.newId()}),null,'another child');
  assert.equal(await open({...op.row,kind:'base'}),null,'another kind');
  assert.equal(await S.open(globalThis.crypto.subtle,k.encKey,A.engine.newId(),op.row),null,'another generation');
  // The relay holds no key: random bytes are not a record, and a record sealed under another key is not either.
  const rnd=globalThis.crypto.getRandomValues(new Uint8Array(op.row.ct.length)),fake=S.b64url(rnd).slice(0,op.row.ct.length);
  assert.equal(await open({...op.row,ct:fake}),null);
  const other=await S.deriveKeys(globalThis.crypto.subtle,new Uint8Array(16).fill(9));
  const forged=await S.seal(globalThis.crypto.subtle,n=>globalThis.crypto.getRandomValues(new Uint8Array(n)),other.encKey,st.gen,{id:op.row.id,child:op.row.child,kind:'op'},{...op.p,o:{s:op.p.o.s,n:op.p.o.n+1000}});
  assert.equal(await open(forged),null,'a forged identity sealed without the family key');
  // The payload schema accepts only well-formed identities.
  const base={type:'word-review',v:2,t:1000,after:0,wordId:'w1',s:0,ok:true,c:'',d:true};
  for(const bad of [undefined,null,{s:'x',n:1},{s:'AAAAAAAAAAAA',n:0},{s:'AAAAAAAAAAAA',n:-1},{s:'AAAAAAAAAAAA',n:1.5},{s:'AAAAAAAAAAAA',n:2**40},{s:'AAAAAAAAAAAA',n:1,extra:1},{s:'__proto__AAAA',n:1}])
    assert.equal(S.checkPayload('op',{...base,o:bad},''),null,JSON.stringify(bad));
  assert.ok(S.checkPayload('op',{...base,o:{s:'AAAAAAAAAAAA',n:1}},''));
  assert.equal(S.checkPayload('op',{...base,v:1,o:{s:'AAAAAAAAAAAA',n:1}},''),null,'a v1 operation carries no identity field');
  assert.equal(S.checkPayload('base',{type:'base',v:2,t:1,after:0},''),null);
});
test('R5: the replay record is bounded and exact: intervals per stream, no refusal for want of room, bounded junk, corrupt stored state is a local copy',async()=>{
  const st0={learning:L.empty(),meta:{profile:{name:'x',age:8,interests:'',readAloud:false,t:1,id:'A'.repeat(21)+'A'},helped:{},alias:{}}};
  const rec=(id,seq)=>({id,seq,kind:'op',at:5000,ck:1});
  const ADD=(n,s='AAAAAAAAAAAA')=>({type:'word-add',v:2,o:{s,n},t:1000+n,after:0,word:{id:'w'+s+n,word:'ord'+s+n,meaning:'m'+n}});
  const run=(ops)=>{let st=JSON.parse(JSON.stringify(st0));for(const [i,p] of ops.entries())st=S.apply(st,rec('I'.repeat(21)+'A',i),S.checkPayload('op',p,''));return st;};
  const R=(st,s='AAAAAAAAAAAA')=>JSON.stringify(st.meta.vc[s].r);
  // Contiguous, out of order, duplicate and replayed: each counter counts once, and the record collapses into one interval.
  let st=run([ADD(1),ADD(2),ADD(2),ADD(1),ADD(4),ADD(3),ADD(3),ADD(4),ADD(5)]);
  assert.equal(st.learning.items.length,5);assert.equal(R(st),'[[1,5]]');
  // A late counter is a gap, not a refusal; it merges when it arrives; a replay of anything inside an interval is ignored.
  st=run([ADD(1),ADD(3),ADD(4),ADD(5)]);assert.equal(R(st),'[[1,1],[3,5]]');
  st=run([ADD(1),ADD(3),ADD(4),ADD(5),ADD(2),ADD(4),ADD(2)]);assert.equal(R(st),'[[1,5]]');assert.equal(st.learning.items.length,5);
  // 1,000 successors of one late operation do not make anything be refused (this was the evidence-loss case).
  const many=[ADD(1)];for(let i=3;i<=1100;i++)many.push(ADD(i));many.push(ADD(2));
  st=run(many);assert.equal(R(st),'[[1,1100]]');
  // Separate streams are independent.
  st=run([ADD(1),ADD(1,'BBBBBBBBBBBB'),ADD(1),ADD(1,'BBBBBBBBBBBB')]);assert.equal(st.learning.items.length,2);
  // Junk far above the prefix is held in at most LIMITS.holes intervals; the genuine next counters are still accepted.
  const junk=[];for(let i=0;i<S.LIMITS.holes+40;i++)junk.push(ADD(1000+i*3));
  st=run([...junk,ADD(1),ADD(2)]);assert.ok(JSON.parse(R(st)).length<=S.LIMITS.holes,'bounded');assert.equal(JSON.parse(R(st))[0][0],1);
  assert.equal(JSON.stringify(JSON.parse(R(st))[0]),'[1,2]','in-order operations are never refused');
  // The number of streams is bounded too.
  const streams=[];for(let i=0;i<S.LIMITS.streams+10;i++)streams.push(ADD(1,String(i).padStart(12,'S')));
  assert.equal(Object.keys(run(streams).meta.vc).length,S.LIMITS.streams);
  // Version 1 operations keep their old semantics (no identity), and mixed streams converge.
  st=run([{...ADD(1),v:1,word:{id:'wl',word:'gammel',meaning:'old'}},ADD(1)].map(p=>{const q={...p};if(q.v===1)delete q.o;return q}));
  assert.equal(st.learning.items.length,2);
  // Stored state is validated: a malformed replay record never loads (the child becomes a local copy, nothing is deleted).
  const good={v:1,cp:{st:{learning:L.empty(),meta:{profile:{name:'x',age:8,interests:'',readAloud:false,t:1,id:'A'.repeat(21)+'A'},helped:{},vc:{AAAAAAAAAAAA:{r:[[1,3],[7,7]]}}}}},log:[],pending:[],seen:[],wm:0,out:{s:'AAAAAAAAAAAA',n:3}};
  assert.ok(S.normalizeSync(good));
  const bad=f=>{const x=JSON.parse(JSON.stringify(good));f(x);return S.normalizeSync(x);};
  assert.equal(bad(x=>{x.cp.st.meta.vc.AAAAAAAAAAAA.r=[[7,7],[1,3]];}),null,'unsorted');assert.equal(bad(x=>{x.cp.st.meta.vc.AAAAAAAAAAAA.r=[[1,3],[4,5]];}),null,'adjacent intervals must be merged');
  assert.equal(bad(x=>{x.cp.st.meta.vc.AAAAAAAAAAAA.r=[[0,3]];}),null);assert.equal(bad(x=>{x.cp.st.meta.vc.AAAAAAAAAAAA.r=[[3,1]];}),null);assert.equal(bad(x=>{x.cp.st.meta.vc.AAAAAAAAAAAA={h:3,x:[]};}),null);
  assert.equal(bad(x=>{x.cp.st.meta.vc.bad={r:[]};}),null);assert.equal(bad(x=>{x.cp.st.meta.vc=[];}),null);assert.equal(bad(x=>{x.out={s:'x',n:1};}),null);
});
test('R6: an own stream never reuses a counter after local storage was restored from an older copy',async()=>{
  const {A,B,fam}=await pair('r6');
  const ada=B.kid('Ada'),w=B.addWord(ada,'katt','cat');B.reviewWord(ada,w.id,{ok:true});
  const snapshotOld=B.persisted;                                    // storage as of now
  B.reviewWord(ada,w.id,{ok:true});B.reviewWord(ada,w.id,{ok:true});await B.sync();   // two more operations reach the Worker
  const sent=ada.sync.out.n,oldStream=ada.sync.out.s;
  B.persisted=snapshotOld;B.reload();B.state=JSON.stringify({...JSON.parse(B.state),cursor:0});   // rolled back
  assert.ok(B.kid('Ada').sync.out.n<sent);
  await B.sync();                                                   // its own records come back
  assert.ok(B.kid('Ada').sync.out.s!==oldStream||B.kid('Ada').sync.out.n>=sent,'a fresh stream, or a counter past everything the Worker already holds');
  B.reviewWord(B.kid('Ada'),B.kid('Ada').learning.items[0].id,{ok:true});await B.sync();await A.sync();
  assert.equal(snapshot(A),snapshot(B));
});
test('R7: replay after a Trusted Backup restore: a restored copy is a new family child with its own stream; old family records never touch it',async()=>{
  const small=clientRealm(cut('seen:10000','seen:40'));
  const {A,B,fam}=await longHistory({reviews:240,realm:small,name:'r7',extras:true});
  const oldOps=(await storedOps(fam,B,'word-review')).slice(0,3).map(x=>x.row);
  // Phone C restores a backup of Ada (what the import produces: a new, unshared profile with the learning in it; no ids, no sync state).
  const C=await device(fam,B.fam.__clock||world(),{realm:small});assert.ok((await C.engine.join({key:A.engine.state().key})).ok);
  const restored={...blankKid('Ada-kopi'),age:9,learning:JSON.parse(JSON.stringify(B.kid('Ada').learning))};
  C.kids=[restored];assert.equal(restored.sync,undefined);
  assert.ok(C.engine.share(restored));C.saveKids();assert.deepEqual(await C.sync(),{ok:true});
  assert.notEqual(restored.id,B.kid('Ada').id,'a restored copy is a new child');
  assert.equal(restored.sync.out?.s===undefined||restored.sync.out.s!==B.kid('Ada').sync.out?.s,true);
  // The relay serves the old family's records (another child's id) and the copy's own earliest records again.
  const own=(await db.prepare("SELECT seq, record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records WHERE family_id=?1 AND child_id=?2 AND kind='base'").bind(await fidOf(fam),restored.id).all()).results;
  const mine=await storedOps(fam,C,'session');
  replayVia(C,[...oldOps,...own,...mine.map(x=>x.row)],{at:C.now()+30*DAY});assert.deepEqual(await C.sync(),{ok:true});await resumeAtHead(fam,C);
  assert.equal(C.kids.filter(k=>k.sync).length,3,'Ada and Bo (family) arrive next to the copy; nothing is merged into it');
  const copy=C.kids.find(k=>k.id===restored.id);
  assert.equal(JSON.stringify(canon(copy.learning.items.map(w=>w.ev.length))),JSON.stringify(canon(restored.learning.items.map(w=>w.ev.length))));
  assert.equal(copy.learning.sessions.length,restored.learning.sessions.length);
  // And the copy keeps working normally.
  C.addWord(copy,'sol','sun');await C.sync();await A.sync();assert.ok(A.kids.find(k=>k.id===restored.id)?.learning.items.some(w=>w.word==='sol'));
});
test('R8: replay across a family reset cannot cross the generation; the new generation starts with empty replay records',async()=>{
  const {fam,A,B}=await pair('r8');
  const ada=A.kid('Ada'),w=A.addWord(ada,'katt','cat');A.reviewWord(ada,w.id,{ok:true});await A.sync();await B.sync();
  const olds=(await storedOps(fam,A,'word-review')).map(x=>x.row);assert.ok(olds.length);
  const oldGen=A.engine.state().gen,r=await A.engine.reset({code:fam.code});assert.ok(r.ok);await A.sync();
  assert.equal(A.kid('Ada').sync.out,undefined,'a new child has no authoring stream yet');
  assert.equal(JSON.stringify(A.kid('Ada').sync.cp.st?.meta?.vc??null).length<80,true);
  assert.ok((await B.engine.join({key:r.key})).ok);
  // The relay presents the old generation's records (same ciphertext, same ids) in the new one, under the new child's id and its own.
  const before=evidenceFacts(A);
  for(const dev of [A,B]){replayVia(dev,olds.map(x=>({...x,child:A.kid('Ada').id})).concat(olds),{at:dev.now()+30*DAY});assert.deepEqual(await dev.sync(),{ok:true});await resumeAtHead(fam,dev);assert.ok(dev.engine.state().undecryptable>=olds.length,'unreadable in the new generation');}
  assert.equal(evidenceFacts(A),before);assert.equal(snapshot(A),snapshot(B));
  assert.notEqual(oldGen,A.engine.state().gen);
});
test('R9: migration: version-1 records and state from before the operation identity stay readable; mixed phones converge; new work is version 2',async()=>{
  const legacy=clientRealm(cut('{v:2,o,after:s.serverTime,...payload,t}','{v:1,after:s.serverTime,...payload,t}'));
  const clock=world(),fam=family(db,clock,'b9'+(n++));
  const A=await device(fam,clock,{realm:legacy}),B=await device(fam,clock);               // A still writes the old format
  const ada=A.kids[0];ada.name='Ada';ada.age=9;A.practice(ada,'add1');const w=A.addWord(ada,'katt','cat');
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok);A.engine.shareAll();A.saveKids();
  A.reviewWord(ada,w.id,{ok:true});A.practice(ada,'sub1');assert.deepEqual(await A.sync(),{ok:true});
  assert.ok((await B.engine.join({key:c.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  const ops=await storedOps(fam,A,'word-review');assert.equal(ops[0].p.v,1,'the old client wrote version 1 (no identity)');
  B.reviewWord(B.kid('Ada'),B.kid('Ada').learning.items[0].id,{ok:true});B.practice(B.kid('Ada'),'add1');
  A.practice(A.kid('Ada'),'add1');
  assert.deepEqual(await B.sync(),{ok:true});assert.deepEqual(await A.sync(),{ok:true});assert.deepEqual(await B.sync(),{ok:true});
  assert.equal(snapshot(A),snapshot(B));assert.equal(snapshot(A),await reference(A));
  const mixed=await storedOps(fam,B,'word-review');assert.deepEqual(mixed.map(x=>x.p.v).sort(),[1,2]);
  // Stored sync data written before this field existed (no `out`, no `vc`) loads, and the next operation starts a stream.
  const old=JSON.parse(B.persisted);for(const k of old)if(k.sync){delete k.sync.out;if(k.sync.cp.st)delete k.sync.cp.st.meta.vc;}
  B.persisted=JSON.stringify(old);B.reload();assert.ok(B.kid('Ada').sync,'still shared, not a local copy');
  B.reviewWord(B.kid('Ada'),B.kid('Ada').learning.items[0].id,{ok:true});assert.deepEqual(await B.sync(),{ok:true});await A.sync();
  assert.equal(snapshot(A),snapshot(B));
  const v2=(await storedOps(fam,B,'word-review')).filter(x=>x.p.v===2);assert.equal(v2.length,2);
});

/* ---------------- F4: deleted child ids are kept for the whole generation, with a bound; a reset clears them safely ---------------- */
test('F4: a stale phone that retries its (lost-acknowledgement) base after hundreds of later deletions is still refused; the bound is explicit and reset clears it',async()=>{
  const {fam,A,B}=await pair('f4');
  const fid=await fidOf(fam),ada=A.kid('Ada');
  // B recorded Ada's base as pending (its acknowledgement was lost): the exact request it will retry.
  assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:ada}),{ok:true});
  // 120 more deletions (the old bound was 100 and pruned the oldest).
  for(let i=0;i<120;i++)await db.prepare("INSERT INTO sync_children (family_id, child_id, status, created_at, deleted_at) VALUES (?1, ?2, 'deleted', 1, ?3)").bind(fid,'Y'+String(i).padStart(20,'0')+'A',i+1).run();
  const st=A.engine.state(),key=await S.deriveKeys(globalThis.crypto.subtle,await S.parseKey(globalThis.crypto.subtle,st.key));
  const payload={type:'base',v:1,t:A.now(),after:0,profile:{name:'Ada',age:9,interests:'',readAloud:false},learning:{version:L.VERSION,skills:{},items:[],sessions:[],totals:L.empty().totals}};
  const rec=await S.seal(globalThis.crypto.subtle,n=>globalThis.crypto.getRandomValues(new Uint8Array(n)),key.encKey,st.gen,{id:A.engine.newId(),child:ada.id,kind:'base'},payload);
  const r=await call(fam,'/sync/push',{v:1,gen:st.gen,clientNow:A.now(),records:[rec]},A.token());
  assert.equal(r.status,200);assert.equal(r.data.results[0].status,'child_deleted','the deleted identity stays dead');
  assert.equal((await rows(fam,"SELECT child_id FROM sync_children WHERE family_id=?1 AND child_id=?2 AND status='active'",ada.id)).length,0);
  // The bound: 500 deleted ids per generation; the next deletion says so instead of forgetting an older one.
  for(let i=120;i<498;i++)await db.prepare("INSERT INTO sync_children (family_id, child_id, status, created_at, deleted_at) VALUES (?1, ?2, 'deleted', 1, ?3)").bind(fid,'Y'+String(i).padStart(20,'0')+'A',i+1).run();
  const bo=blankKid('Bo');A.kids.push(bo);A.practice(bo,'add1');A.engine.share(bo);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  const bo2=blankKid('Bo2');A.kids.push(bo2);A.practice(bo2,'add1');A.engine.share(bo2);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:bo}),{ok:true});          // the 500th
  const full=await A.engine.deleteChild({code:fam.code,kid:bo2});
  assert.equal(full.ok,false);assert.equal(full.code,'deleted_full');assert.ok(A.kids.includes(bo2),'nothing was deleted or forgotten');
  assert.equal((await counts(fam)).deleted,500);
  // Reset (always possible) starts a clean generation: the deleted-id memory of the old one is not needed there, because nothing
  // from the old generation can write into the new one.
  const reset=await A.engine.reset({code:fam.code});assert.ok(reset.ok);assert.equal((await counts(fam)).deleted,0);
  await A.sync();const k2=A.kids.find(x=>x.name==='Bo2');assert.ok(k2?.sync);assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:k2}),{ok:true});
  void B;
});

test('LOW: "Fjern fra denne telefonen" / "Hent fjernede barn tilbake hit" pressed while a sync round is running are not written back over',async()=>{
  const {A,B}=await pair('lost');
  B.engine.hide(B.kid('Bo')||B.kid('Ada'));                                    // Ada hidden on B
  assert.equal(B.engine.state().hidden.length,1);
  // The parent presses "fetch removed children" while the round's download is in flight.
  B.intercept=async(path,body,go)=>{if(path==='/sync/pull'){B.intercept=null;B.engine.unhide();}return go();};
  assert.deepEqual(await B.sync(),{ok:true});
  assert.equal(B.engine.state().hidden.length,0,'the unhide survived the running round');
  assert.deepEqual(await B.sync(),{ok:true});
  assert.ok(B.kid('Ada'),'and the child is back after the next download');assert.equal(snapshot(A),snapshot(B));
  // The same for hide during a round.
  B.intercept=async(path,body,go)=>{if(path==='/sync/pull'){B.intercept=null;B.engine.hide(B.kid('Ada'));}return go();};
  await B.sync();assert.equal(B.engine.state().hidden.length,1);assert.equal(B.kid('Ada'),undefined);
});

/* ---------------- review follow-up: the replay record must never cost an honest operation ---------------- */
const has=(d,word)=>d.kids.some(k=>k.learning.items.some(w=>w.word===word));
test('R10: a relay that re-times ONE operation far into the future cannot make hundreds of later operations (and new words) disappear',async()=>{
  const {clock,fam,A,B}=await pair('r10');
  const ada=A.kid('Ada');
  A.practice(ada,'sub1');                                                    // the operation the relay will re-time
  A.intercept=async(path,body,go)=>{const r=await go();if(path!=='/sync/push'||r.status!==200)return r;A.intercept=null;
    return {...r,data:{...r.data,results:r.data.results.map((x,i)=>i===r.data.results.length-1?{...x,at:x.at+60*DAY}:x)}};};
  assert.deepEqual(await A.sync(),{ok:true});
  const w=A.addWord(ada,'katt','cat');
  for(const word of ['sol','hus','bil']){
    for(let round=0;round<7;round++){
      for(let i=0;i<45;i++){A.reviewWord(ada,w.id,{ok:i%3!==0});clock.advance(1000);}
      A.saveKids();assert.deepEqual(await A.sync(),{ok:true});assert.deepEqual(await B.sync(),{ok:true});clock.advance(5*DAY);
    }
    A.addWord(ada,word,'x');assert.deepEqual(await A.sync(),{ok:true});assert.deepEqual(await B.sync(),{ok:true});
  }
  for(const word of ['katt','sol','hus','bil']){assert.ok(has(A,word),'A keeps '+word);assert.ok(has(B,word),'B keeps '+word);}
  assert.ok(A.kid('Ada').learning.skills.sub1,'the re-timed operation itself still counts once');
  assert.equal(A.kid('Ada').learning.skills.sub1.ev.length,1);assert.equal(B.kid('Ada').learning.skills.sub1.ev.length,1);
});
test('R11: an honest clock correction (a phone whose clock was 3 days fast) does not make later operations disappear',async()=>{
  const {clock,fam,A,B}=await pair('r11');
  const ada=A.kid('Ada');A.online=false;
  A.skew=3*DAY;A.practice(ada,'sub1');                                       // recorded with a clock 3 days fast
  A.skew=0;clock.advance(2*3600000);
  const w=A.addWord(ada,'katt','cat');for(let i=0;i<300;i++){A.reviewWord(ada,w.id,{ok:i%2===0});clock.advance(1000);}
  A.saveKids();A.online=true;
  clock.advance(DAY);assert.deepEqual(await A.sync(),{ok:true});assert.deepEqual(await B.sync(),{ok:true});
  for(let round=0;round<6;round++){clock.advance(5*DAY);A.reviewWord(ada,w.id,{ok:true});assert.deepEqual(await A.sync(),{ok:true});assert.deepEqual(await B.sync(),{ok:true});}
  A.addWord(ada,'hus','house');assert.deepEqual(await A.sync(),{ok:true});assert.deepEqual(await B.sync(),{ok:true});
  for(const d of [A,B]){assert.ok(has(d,'katt'));assert.ok(has(d,'hus'),'the new word is not dropped');}
  assert.equal(A.kid('Ada').learning.skills.sub1.ev.length,1);
});
test('R12: many hide/unhide cycles keep one authoring stream (no stream budget is used up)',async()=>{
  const {fam,A,B}=await pair('r12');
  const stream=()=>JSON.stringify(Object.keys(B.kid('Ada')?.sync.cp.st?.meta.vc??{}));
  B.addWord(B.kid('Ada'),'start','x');await B.sync();await A.sync();
  const first=B.kid('Ada').sync.out.s;
  for(let i=0;i<70;i++){
    assert.deepEqual(B.engine.hide(B.kid('Ada')),{ok:true});B.engine.unhide();await B.sync();
    B.practice(B.kid('Ada'),'sub1',{sid:'c'+i});assert.deepEqual(await B.sync(),{ok:true});
    assert.equal(B.kid('Ada').sync.out.s,first,'cycle '+i+' continues the same stream');
  }
  await A.sync();
  for(const d of [A,B]){assert.ok(d.kid('Ada').learning.skills.sub1.ev.some(e=>e.sid==='c69'),'the last operation survives');}
  assert.equal(snapshot(A),snapshot(B));
  assert.ok(Object.keys(B.kid('Ada').sync.cp.st?.meta.vc??{}).length<=2);void stream;
});
test('R13: a cloned or restored copy of a phone\'s storage, both freshly opened: no work is lost and nothing is counted twice, in either order',async()=>{
  for(const first of ['clone','original']){
    const {clock,fam,A,B,key}=await pair('r13'+first);
    B.addWord(B.kid('Ada'),'start','x');await B.sync();await A.sync();
    const C=await device(fam,clock);                                          // a restored copy of B's storage on another phone
    C.persisted=B.persisted;C.state=B.state;C.reload();C.restart();assert.ok((await C.engine.join({key})).ok);
    assert.equal(C.kid('Ada').sync.out.s,B.kid('Ada').sync.out.s,'same stream, same counters');
    B.addWord(B.kid('Ada'),'fraB','x');B.practice(B.kid('Ada'),'sub1');
    C.addWord(C.kid('Ada'),'fraC','y');C.practice(C.kid('Ada'),'add1');
    B.reload();B.restart();                                                    // the original is opened again as well
    const order=first==='clone'?[C,B,C,A,B]:[B,C,B,A,C];
    for(const d of [...order,B,C,A,B,C,A])assert.deepEqual(await d.sync(),{ok:true});
    for(const [nm,d] of [['A',A],['B',B],['C',C]]){assert.ok(has(d,'fraB'),first+': fraB on '+nm);assert.ok(has(d,'fraC'),first+': fraC on '+nm);
      for(const [sk,n] of [['sub1',1],['add1',2]])assert.equal(d.kid('Ada').learning.skills[sk].ev.length,n,first+': '+sk+' counted once on '+nm);}   // (add1 already held one event from before sharing)
    assert.equal(snapshot(A),snapshot(B));assert.equal(snapshot(A),snapshot(C));
  }
});
test('R13b: a long-running phone that already sent a counter its clone also used may lose that operation, but nothing is ever counted twice; every phone agrees',async()=>{
  const {clock,fam,A,B,key}=await pair('r13b');
  B.addWord(B.kid('Ada'),'start','x');await B.sync();await A.sync();
  const C=await device(fam,clock);C.persisted=B.persisted;C.state=B.state;C.reload();C.restart();assert.ok((await C.engine.join({key})).ok);
  B.practice(B.kid('Ada'),'sub1');C.practice(C.kid('Ada'),'add1');
  // B was never reopened, so it uploads before it downloads; C downloads first.
  for(const d of [C,B,A,B,C,A,B,C,A])assert.deepEqual(await d.sync(),{ok:true});
  for(const d of [A,B,C])for(const [sk,n] of [['sub1',1],['add1',2]])assert.ok((d.kid('Ada').learning.skills[sk]?.ev.length??0)<=n,'never twice');
  assert.equal(snapshot(A),snapshot(B));assert.equal(snapshot(A),snapshot(C));
});
test('R13c: a push that the Worker stored but whose reply was lost, then an app reopen next to a clone, never counts an operation twice',async()=>{
  const {clock,fam,A,B,key}=await pair('r13c');
  B.addWord(B.kid('Ada'),'start','x');await B.sync();await A.sync();
  const C=await device(fam,clock);C.persisted=B.persisted;C.state=B.state;C.reload();C.restart();assert.ok((await C.engine.join({key})).ok);
  const w=B.kid('Ada').learning.items[0].id;
  B.reviewWord(B.kid('Ada'),w,{ok:true});C.reviewWord(C.kid('Ada'),w,{ok:false});
  await C.sync();                                                              // C's review is stored first
  B.intercept=async(path,body,go)=>{const r=await go();if(path==='/sync/push'){B.intercept=null;throw Error('reply lost');}return r;};
  await B.sync();                                                              // B's is stored, B never hears
  B.reload();B.restart();
  for(const d of [B,C,A,B,C,A,B,C,A])assert.deepEqual(await d.sync(),{ok:true});
  const total=d=>d.kid('Ada').learning.items[0].ev.length;
  assert.equal(total(A),total(B));assert.equal(total(A),total(C));assert.ok(total(A)<=3,'start + at most B + C once each: '+total(A));
  assert.equal(snapshot(A),snapshot(B));
});
test('LOW: a phone that is still catching up (download before upload) says so instead of reporting success',async()=>{
  const {A,B}=await pair('catch');
  B.addWord(B.kid('Ada'),'x','y');B.restart();
  B.intercept=async(path,body,go)=>{const r=await go();if(path==='/sync/pull'&&r.status===200)return {...r,data:{...r.data,more:true}};return r;};
  const r=await B.sync();assert.equal(r.ok,false);assert.equal(r.code,'catchup');assert.equal(B.engine.state().status,'catchup');
  assert.equal(B.sent.filter(x=>x.path==='/sync/push').length,B.sent.filter(x=>x.path==='/sync/push').length);
  B.intercept=null;assert.deepEqual(await B.sync(),{ok:true});await A.sync();assert.equal(snapshot(A),snapshot(B));
});
test('R14: storage rolled back to an older copy, then a restart: the first download comes before any upload, so no counter is reused',async()=>{
  const {A,B}=await pair('r14');
  const ada=B.kid('Ada'),w=B.addWord(ada,'katt','cat');await B.sync();
  const old=B.persisted,oldState=B.state;
  B.reviewWord(ada,w.id,{ok:true});B.reviewWord(ada,w.id,{ok:false});await B.sync();
  B.persisted=old;B.state=oldState;B.reload();B.restart();                    // rolled back, app restarted
  B.addWord(B.kid('Ada'),'etter','after');                                    // work done before the first sync
  assert.deepEqual(await B.sync(),{ok:true});await A.sync();await B.sync();
  for(const d of [A,B])assert.ok(has(d,'etter'),'the work after the rollback is kept');
  assert.equal(snapshot(A),snapshot(B));
});
test('R15: an unhide pressed while a page is being applied is not overwritten by that round',async()=>{
  const {A,B}=await pair('r15');
  B.engine.hide(B.kid('Ada'));A.addWord(A.kid('Ada'),'ny','new');await A.sync();
  // The reset arrives after the page was fetched, while the round is working through it.
  let fired=false;const open=B.engine;
  B.intercept=async(path,body,go)=>{const r=await go();if(path==='/sync/pull'&&!fired&&r.data.records.length){fired=true;B.engine.unhide();}return r;};
  await B.sync();B.intercept=null;
  assert.equal(B.engine.state().hidden.length,0,'the unhide survived the running round');
  assert.ok(B.kid('Ada'),'and the round itself went on to download the child again');void open;
  await B.sync();await A.sync();assert.equal(snapshot(A),snapshot(B));
});

test('R16: two clones that both stay in use lose at most the first concurrent operation; the second sees the clash and moves to a fresh stream',async()=>{
  const {clock,fam,A,B,key}=await pair('r16');
  B.addWord(B.kid('Ada'),'start','x');await B.sync();await A.sync();
  const C=await device(fam,clock);C.persisted=B.persisted;C.state=B.state;C.reload();C.restart();assert.ok((await C.engine.join({key})).ok);
  const w=B.kid('Ada').learning.items[0].id;
  let made=0;
  for(let round=0;round<3;round++){
    // Both are online and in use, each pushing before it pulls, both recording one review between syncs.
    B.reviewWord(B.kid('Ada'),w,{ok:true});C.reviewWord(C.kid('Ada'),w,{ok:round%2===0});made+=2;
    for(const d of [B,C,B,C,A])assert.deepEqual(await d.sync(),{ok:true});
  }
  const counted=d=>d.kid('Ada').learning.items[0].ev.length;
  assert.equal(counted(A),counted(B));assert.equal(counted(A),counted(C));
  assert.ok(counted(A)>=Math.min(8,made-1),'only the first collision may cost an operation: '+counted(A));
  assert.notEqual(B.kid('Ada').sync.out.s,C.kid('Ada').sync.out.s,'the clones no longer share a stream');
  assert.equal(snapshot(A),snapshot(B));assert.equal(snapshot(A),snapshot(C));
});
