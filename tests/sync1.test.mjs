import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {localD1,world,family,device,snapshot,reference,canon,prng,blankKid,request,clientRealm,cut,L,S,DAY} from './sync-helpers.mjs';
import {backend,environment,root} from './helpers.mjs';
import {checkSyncRequest,openAll,RX} from './sync-privacy.mjs';

/* SYNC1 multi-device sync: real Worker code, real local D1 (workerd), real client engine. Fixture secrets only. */
const {db,dispose}=await localD1();
test.after(()=>dispose());
let n=0;const fresh=(name='f')=>family(db,world(),name+(n++));
const call=async(fam,path,body,token)=>{const r=await fam.b.worker.fetch(request(path,body,token),fam.env);const text=await r.text();return {status:r.status,data:text?JSON.parse(text):null,text};};
// A family with device A (creator, child "Ada" shared) and device B (joined, synced).
async function pair(name='p',{seedA,seedB}={}){
  const clock=world(),fam=family(db,clock,name+(n++));
  const A=await device(fam,clock,{seed:seedA}),B=await device(fam,clock,{seed:seedB});
  const ada=A.kids[0];ada.name='Ada';ada.age=9;A.practice(ada,'add1');
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok,JSON.stringify(c));
  assert.equal(A.engine.shareAll(),1);A.saveKids();assert.deepEqual(await A.sync(),{ok:true});
  assert.ok((await B.engine.join({key:c.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  return {clock,fam,A,B,key:c.key};
}
const ev=(dev,name,skill)=>dev.kid(name).learning.skills[skill]?.ev.map(e=>e.id)||[];

test('1-3: independent offline learning on two phones converges A→server→B and B→server→A',async()=>{
  const {clock,A,B}=await pair('conv');
  assert.equal(snapshot(A),snapshot(B));
  A.online=B.online=false;
  clock.advance(3600000);
  A.practice(A.kid('Ada'),'add1',{s:1});A.addWord(A.kid('Ada'),'hus','et sted å bo');
  B.practice(B.kid('Ada'),'sub1',{s:2});B.practice(B.kid('Ada'),'add1',{ok:false,s:3});B.archive(B.kid('Ada'),{reflection:'Tallinje'});
  assert.notEqual(snapshot(A),snapshot(B));
  A.online=true;assert.deepEqual(await A.sync(),{ok:true});
  B.online=true;assert.deepEqual(await B.sync(),{ok:true});// A→server→B
  assert.equal(B.kid('Ada').learning.items.length,1);assert.equal(ev(B,'Ada','add1').length,3);
  assert.deepEqual(await A.sync(),{ok:true});// B→server→A
  assert.equal(snapshot(A),snapshot(B));assert.equal(snapshot(A),await reference(A));
  assert.equal(ev(A,'Ada','sub1').length,1);assert.equal(A.kid('Ada').learning.sessions.length,1);
  // Every piece of independent evidence survives on both phones.
  assert.deepEqual(ev(A,'Ada','add1'),ev(B,'Ada','add1'));
});

test('4: repeated identical sync is idempotent (no new records, unchanged state); a lost acknowledgement is retried as a duplicate',async()=>{
  const {A,B}=await pair('idem');
  const head=async()=>(await db.prepare('SELECT COUNT(*) AS n FROM sync_records').first()).n;
  const before=[snapshot(A),snapshot(B),await head()];
  for(let i=0;i<3;i++){await A.sync();await B.sync();}
  assert.deepEqual([snapshot(A),snapshot(B),await head()],before);
  // The Worker stores the push, then the reply is lost: the queue is kept, and the retry is acknowledged as 'dup'.
  A.practice(A.kid('Ada'),'add1',{s:1});
  A.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/push')throw Error('connection reset');return r;};
  assert.equal((await A.sync()).code,'offline');assert.equal(A.kid('Ada').sync.pending.length,1);
  let results;A.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/push')results=r.data.results;return r;};
  assert.deepEqual(await A.sync(),{ok:true});assert.equal(results[0].status,'dup');
  await B.sync();assert.equal(snapshot(A),snapshot(B));assert.equal(ev(B,'Ada','add1').length,2);
});

test('5: reordered delivery and upload order give the same state',async()=>{
  // Pure: any order of the same records folds to the same state.
  const {A,B}=await pair('order');
  A.online=B.online=false;
  for(let i=0;i<4;i++){A.practice(A.kid('Ada'),i%2?'add1':'sub1',{s:i%3,ok:i!==2});B.practice(B.kid('Ada'),'add1',{s:1});}
  A.online=B.online=true;await A.sync();await B.sync();await A.sync();
  const log=A.kid('Ada').sync.log.concat([]);const st=A.kid('Ada').sync;
  const base=JSON.stringify(canon(S.fold({cp:st.cp,log,pending:[]})));
  const rnd=prng(7);
  for(let k=0;k<20;k++){const shuffled=log.slice().sort(()=>rnd(1)[0]-128);assert.equal(JSON.stringify(canon(S.fold({cp:st.cp,log:shuffled,pending:[]}))),base);}
  // Upload order: the same offline work uploaded A-first or B-first converges to an identical family state.
  async function run(first){
    const clock=world(),fam=family(db,clock,'ord'+first+(n++));
    const a=await device(fam,clock,{seed:11}),b=await device(fam,clock,{seed:22});
    a.kids[0].name='Ada';a.practice(a.kids[0],'add1');const c=await a.engine.create({code:fam.code});a.engine.shareAll();a.saveKids();await a.sync();
    await b.engine.join({key:c.key});await b.sync();
    a.online=b.online=false;clock.advance(2*DAY);
    a.practice(a.kid('Ada'),'add1',{k:'cold',sid:'x1'});clock.advance(3600000);b.practice(b.kid('Ada'),'add1',{k:'cold',sid:'y1'});b.addWord(b.kid('Ada'),'tre','et tre');
    clock.advance(3600000);a.practice(a.kid('Ada'),'add1',{ok:false,s:3,sid:'x2'});
    a.online=b.online=true;
    const [p,q]=first==='a'?[a,b]:[b,a];await p.sync();await q.sync();await p.sync();
    assert.equal(snapshot(a),snapshot(b));return snapshot(a);
  }
  assert.equal(await run('a'),await run('b'));
});

test('6: duplicate evidence never inflates mastery (retry, replayed record, same evidence id twice)',async()=>{
  const {clock,A,B}=await pair('dup');
  clock.advance(2*DAY);A.practice(A.kid('Ada'),'add1',{k:'cold',sid:'d1',c:'sikker'});await A.sync();await B.sync();
  const once=snapshot(B),totals=JSON.stringify(B.kid('Ada').learning.totals);
  // A Worker (or network) replaying an already-seen record under a new sequence number: ignored by id.
  const old=B.kid('Ada').sync.log.find(r=>r.p.type==='skill')||null;
  const stored=(await db.prepare("SELECT record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records WHERE kind='op' ORDER BY seq DESC LIMIT 1").first());
  B.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/pull'){r.data.records.push({...stored,seq:r.data.next+1});r.data.next+=1;}return r;};
  await B.sync();B.intercept=null;
  assert.equal(snapshot(B),once);assert.equal(JSON.stringify(B.kid('Ada').learning.totals),totals);
  // Two different records carrying the same evidence id (a forged client): the evidence counts once.
  const kid=A.kid('Ada'),input={id:'same-evidence',t:A.now(),sid:'d2',s:0,ok:true,verified:true,k:'cold',e:'',c:'sikker'};
  clock.advance(2*DAY);input.t=A.now();
  const v=L.event(kid.learning,'add1',input);A.engine.enqueue(kid,S.skillOp('add1',input,v));A.engine.enqueue(kid,S.skillOp('add1',input,v));A.saveKids();
  await A.sync();await B.sync();
  const r=B.kid('Ada').learning.skills.add1;assert.equal(r.ev.filter(e=>e.id==='same-evidence').length,1);
  assert.equal(snapshot(A),snapshot(B));assert.ok(old);
});

test('7: an old offline phone cannot erase newer progress (append-only evidence, id-scoped word removal, profile last-writer by time)',async()=>{
  const {clock,fam,A,B,key}=await pair('stale');
  const C=await device(fam,clock);await C.engine.join({key});await C.sync();
  C.online=false;
  // Newer progress on A while C is away: independent cold checks across days, a new word, a profile edit.
  for(let d=1;d<=3;d++){clock.advance(2*DAY);A.practice(A.kid('Ada'),'add1',{k:'cold',sid:'a'+d,c:'sikker'});}
  A.addWord(A.kid('Ada'),'ny','et nytt ord');A.profile(A.kid('Ada'),{interests:'fotball'});
  await A.sync();
  const progress=A.kid('Ada').learning.skills.add1;assert.equal(L.state(progress),'SELVSTENDIG');
  // C, still holding the old state, records a failure, edits the profile with its older view and clears its word list.
  C.skew=-5*DAY;// its edit is older than A's
  C.practice(C.kid('Ada'),'add1',{ok:false,s:3,sid:'c1'});C.profile(C.kid('Ada'),{interests:'gammel'});C.clearWords(C.kid('Ada'));
  C.skew=0;C.online=true;await C.sync();await A.sync();await B.sync();
  for(const d of [A,B,C]){
    const r=d.kid('Ada').learning.skills.add1;
    for(const id of progress.ev.map(e=>e.id))assert.ok(r.ev.some(e=>e.id===id),'A evidence kept on every phone');
    assert.ok(d.kid('Ada').learning.items.some(w=>w.word==='ny'),'a word C never knew is not removed');
    assert.equal(d.kid('Ada').interests,'fotball','the newer profile edit wins');
  }
  assert.equal(snapshot(A),snapshot(C));assert.equal(snapshot(A),snapshot(B));
});

test('8: family deletion: an old offline phone cannot resurrect the child; a key-less family-code holder cannot destroy local data',async()=>{
  const {clock,fam,A,B,key}=await pair('del');
  const C=await device(fam,clock);await C.engine.join({key});await C.sync();
  C.online=false;C.practice(C.kid('Ada'),'add1',{s:1});C.archive(C.kid('Ada'));
  const ada=A.kid('Ada'),id=ada.id;
  assert.equal((await A.engine.deleteChild({code:'wrong-code',kid:ada})).code,'family_code');
  assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:ada}),{ok:true});
  assert.equal(A.kid('Ada'),undefined);
  await B.sync();assert.equal(B.kid('Ada'),undefined);
  const rows=await db.prepare("SELECT kind FROM sync_records WHERE child_id=?1").bind(id).all();
  assert.deepEqual(rows.results.map(r=>r.kind),['tombstone']);
  // C comes back with queued changes for the deleted child: the Worker refuses them, the tombstone removes the child.
  C.online=true;assert.deepEqual(await C.sync(),{ok:true});
  assert.equal(C.kid('Ada'),undefined);assert.ok(C.engine.state().deleted.includes(id));
  assert.deepEqual((await db.prepare("SELECT kind FROM sync_records WHERE child_id=?1").bind(id).all()).results.map(r=>r.kind),['tombstone']);
  await B.sync();assert.equal(B.kid('Ada'),undefined);
  // Replaying the old base for that id is refused: a deleted id never accepts records again.
  const replay=await call(fam,'/sync/push',{v:1,gen:A.engine.state().gen,clientNow:clock.now(),records:[{id:S.b64url(webcrypto.getRandomValues(new Uint8Array(16))),child:id,kind:'base',iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40)}]},A.token());
  assert.equal(replay.data.results[0].status,'child_deleted');
  // Someone with only the family code (no key) deletes a child with a forged tombstone: the Worker copy is gone, but
  // phones cannot verify the tombstone and keep their data as an unshared local copy.
  const D=await device(fam,clock);const bo=D.kids[0];
  const t2=await device(fam,clock);
  const shareFrom=A;const k=blankKid('Bo');k.age=7;shareFrom.kids.push(k);shareFrom.practice(k,'sub1');shareFrom.engine.share(k);shareFrom.saveKids();await shareFrom.sync();await B.sync();
  const boId=B.kid('Bo').id;
  const forged=await call(fam,'/sync/admin',{v:1,gen:A.engine.state().gen,op:'delete-child',code:fam.code,child:boId,record:{id:S.b64url(webcrypto.getRandomValues(new Uint8Array(16))),iv:'AAAAAAAAAAAAAAAA',ct:'B'.repeat(40)}},A.token());
  assert.equal(forged.status,200);
  await B.sync();
  const kept=B.kid('Bo');assert.ok(kept,'local data kept');assert.equal(kept.sync,undefined);assert.equal(kept.fork,true);assert.equal(kept.learning.skills.sub1.ev.length,1);
  assert.ok(B.engine.state().undecryptable>=1);assert.ok(bo&&t2);
});

test('9: clocks: a fast or slow phone clock cannot manufacture delayed credit through sync; credit is capped by the recording phone',async()=>{
  async function scenario({skew=0,gap=2*DAY,fixBeforeUpload=false}){
    const {clock,A,B}=await pair('clk');
    clock.advance(gap);
    B.skew=skew;B.practice(B.kid('Ada'),'add1',{k:'cold',sid:'late',c:'sikker'});
    if(fixBeforeUpload)B.skew=0;
    await B.sync();await A.sync();await B.sync();
    assert.equal(snapshot(A),snapshot(B));
    const r=A.kid('Ada').learning.skills.add1;return {box:r.box,cold:A.kid('Ada').learning.totals.cold,delayed:r.ev.at(-1).delayed};
  }
  // Control: an honest phone two days later earns delay credit.
  assert.deepEqual(await scenario({}),{box:2,cold:1,delayed:true});
  // Fast clock (+3 days) two hours later: locally it looks delayed; through sync it is placed at its receipt, no credit.
  assert.deepEqual(await scenario({skew:3*DAY,gap:2*3600000}),{box:1,cold:0,delayed:false});
  // Slow clock (-10 days) still wrong at upload: same.
  assert.deepEqual(await scenario({skew:-10*DAY,gap:2*3600000}),{box:1,cold:0,delayed:false});
  // Slow clock corrected before upload: the record cannot be placed before the phone's last sync, so no gap is created.
  assert.deepEqual(await scenario({skew:-10*DAY,gap:2*3600000,fixBeforeUpload:true}),{box:1,cold:0,delayed:false});
  // Author cap (pure): merged order would allow delay credit, the recording phone did not grant it: none is given.
  const {A}=await pair('cap');const st=A.kid('Ada').sync,at=A.now()+3*DAY;
  const mk=d=>({seq:999,id:S.b64url(webcrypto.getRandomValues(new Uint8Array(16))),kind:'op',at,ck:1,p:S.checkPayload('op',{type:'skill',v:1,t:at,after:0,skill:'add1',e:{s:0,ok:true,k:'cold',e:'',c:'sikker',sid:'z',id:'z1',verified:true},d},'')});
  const capped=S.fold({cp:st.cp,log:[...st.log,mk(false)],pending:[]}),granted=S.fold({cp:st.cp,log:[...st.log,mk(true)],pending:[]});
  assert.equal(capped.learning.skills.add1.box,1);assert.equal(capped.learning.totals.cold,0);
  assert.equal(granted.learning.skills.add1.box,2,'negative control: with the author flag the same record earns credit');
});

test('10: unsigned/quarantined evidence stays non-authoritative after sync; authority claimed after receipt is quarantined',async()=>{
  const {clock,fam,A,B}=await pair('quar');
  // Native mastery, then the unsigned-restore path (CF1 quarantine) on A, shared with the family.
  const native=L.empty();const t0=clock.now()-40*DAY;
  L.event(native,'add1',{t:t0,s:0,ok:true,k:'task',sid:'q0',id:'q0',verified:true});
  L.event(native,'add1',{t:t0+2*DAY,s:0,ok:true,k:'cold',sid:'q1',id:'q1',verified:true,c:'sikker'});
  L.event(native,'add1',{t:t0+10*DAY,s:0,ok:true,k:'cold',sid:'q2',id:'q2',verified:true,c:'sikker'});
  assert.equal(L.state(native.skills.add1),'SITTER');
  const restored={...blankKid('Kopi'),learning:L.quarantine(L.normalizeMemory(JSON.parse(JSON.stringify(native))),clock.now())};
  A.kids.push(restored);A.engine.share(restored);A.saveKids();await A.sync();await B.sync();
  const r=B.kid('Kopi').learning.skills.add1;
  assert.deepEqual([r.ev.length,r.imported.length,L.state(r),r.box,B.kid('Kopi').learning.totals.cold],[0,3,'ØVER',1,0]);
  // Practising on B only adds new evidence; imported history is never promoted.
  B.practice(B.kid('Kopi'),'add1');await B.sync();await A.sync();
  assert.equal(A.kid('Kopi').learning.skills.add1.imported.length,3);assert.equal(A.kid('Kopi').learning.skills.add1.ev.length,1);
  assert.equal(snapshot(A),snapshot(B));
  // A phone whose clock is 3 days ahead shares a child whose evidence postdates the Worker's receipt: TR1 invariants quarantine it.
  const F=await device(fam,clock,{skew:3*DAY});await F.engine.join({key:A.engine.state().key});await F.sync();
  const fut={...blankKid('Fremtid')};F.kids.push(fut);F.practice(fut,'add1');F.engine.share(fut);F.saveKids();await F.sync();await B.sync();
  const fr=B.kid('Fremtid').learning.skills.add1;assert.equal(fr.ev.length,0);assert.equal(fr.imported.length,1);
  assert.equal(snapshot(F),snapshot(B));
});

test('11: trusted restored evidence keeps authority and is not duplicated by sync',async()=>{
  const {clock,A,B}=await pair('trust');
  const native=L.empty();const t0=clock.now()-40*DAY;
  L.event(native,'add1',{t:t0,s:0,ok:true,k:'task',sid:'t0',id:'t0',verified:true});
  L.event(native,'add1',{t:t0+2*DAY,s:0,ok:true,k:'cold',sid:'t1',id:'t1',verified:true,c:'sikker'});
  L.event(native,'add1',{t:t0+10*DAY,s:0,ok:true,k:'cold',sid:'t2',id:'t2',verified:true,c:'sikker'});
  // The TR1 trusted path: normalize, then L.trust with the Worker's signedAt.
  const restore=()=>({...blankKid('Trygg'),learning:L.trust(L.normalizeMemory(JSON.parse(JSON.stringify(native))),clock.now()-DAY,clock.now())});
  const first=restore();A.kids.push(first);A.engine.share(first);A.saveKids();await A.sync();await B.sync();
  const r=B.kid('Trygg').learning.skills.add1;
  assert.deepEqual([L.state(r),r.ev.length,r.box,B.kid('Trygg').learning.totals.cold],['SITTER',3,native.skills.add1.box,native.totals.cold]);
  for(let i=0;i<2;i++){await A.sync();await B.sync();}
  assert.equal(B.kid('Trygg').learning.skills.add1.ev.length,3);assert.equal(snapshot(A),snapshot(B));
  // Restoring the same backup again creates a separate child (new identity); the first child's evidence is unchanged.
  const second=restore();A.kids.push(second);A.engine.share(second);A.saveKids();await A.sync();await B.sync();
  const both=B.kids.filter(k=>k.name==='Trygg');assert.equal(both.length,2);assert.notEqual(both[0].id,both[1].id);
  for(const k of both)assert.equal(k.learning.skills.add1.ev.length,3);
  assert.equal(snapshot(A),snapshot(B));
});

test('12-13: cross-family reads and writes are rejected; no record, child or device of another family is reachable',async()=>{
  const one=await pair('fam-one'),two=await pair('fam-two');
  const genOne=one.A.engine.state().gen,genTwo=two.A.engine.state().gen;
  // Family two's token on family one's Worker: the signature does not verify.
  assert.equal((await call(one.fam,'/sync/pull',{v:1,gen:genOne,cursor:0},two.A.token())).status,401);
  // Same database, each Worker reads only its own family: two's pull returns nothing of one.
  const pulled=await call(two.fam,'/sync/pull',{v:1,gen:genTwo,cursor:0},two.A.token());
  const oneIds=new Set((await db.prepare('SELECT record_id AS id FROM sync_records').all()).results.map(r=>r.id));
  const oneChild=one.A.kid('Ada').id;
  assert.ok(pulled.data.records.length>0);assert.ok(pulled.data.records.every(r=>r.child!==oneChild));
  assert.ok(pulled.data.children.every(c=>c.child!==oneChild));assert.ok(oneIds.size>pulled.data.records.length);
  // Family one's generation on family two's Worker: refused.
  assert.equal((await call(two.fam,'/sync/pull',{v:1,gen:genOne,cursor:0},two.A.token())).data.code,'family_changed');
  // Writes naming family one's child from family two never touch family one.
  const head=async()=>(await db.prepare("SELECT COUNT(*) AS n FROM sync_records WHERE child_id=?1").bind(oneChild).first()).n;
  const before=await head(),rid=()=>S.b64url(webcrypto.getRandomValues(new Uint8Array(16)));
  const op=await call(two.fam,'/sync/push',{v:1,gen:genTwo,clientNow:Date.now(),records:[{id:rid(),child:oneChild,kind:'op',iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40)}]},two.A.token());
  assert.equal(op.data.results[0].status,'child_unknown');
  const del=await call(two.fam,'/sync/admin',{v:1,gen:genTwo,op:'delete-child',code:two.fam.code,child:oneChild,record:{id:rid(),iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40)}},two.A.token());
  assert.equal(del.data.code,'child_unknown');
  const oneDevice=JSON.parse(Buffer.from(one.B.token().split('.')[0],'base64url')).deviceId;
  assert.equal((await call(two.fam,'/sync/admin',{v:1,gen:genTwo,op:'revoke',code:two.fam.code,device:oneDevice},two.A.token())).data.code,'device_unknown');
  // A base under the same id from family two lands in family two's own namespace only.
  const base=await call(two.fam,'/sync/push',{v:1,gen:genTwo,clientNow:Date.now(),records:[{id:rid(),child:oneChild,kind:'base',iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40)}]},two.A.token());
  assert.equal(base.data.results[0].status,'ok');
  assert.equal(await head(),before+1);
  await one.B.sync();assert.equal(snapshot(one.A),snapshot(one.B));assert.equal(one.B.engine.state().undecryptable,0,'nothing of family two reached family one');
  // Unknown child ids answer the same whether they exist in another family or nowhere: no enumeration oracle.
  const unknown=await call(two.fam,'/sync/push',{v:1,gen:genTwo,clientNow:Date.now(),records:[{id:rid(),child:rid(),kind:'op',iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40)}]},two.A.token());
  assert.equal(unknown.data.results[0].status,'child_unknown');
  assert.equal(await (async()=>{const r=await call(two.fam,'/sync/admin',{v:1,gen:genTwo,op:'delete-child',code:two.fam.code,child:rid(),record:{id:rid(),iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40)}},two.A.token());return r.data.code;})(),'child_unknown');
});

test('14: revoked device is rejected and cannot re-enrol; a stolen phone (token + key, no family code) cannot revoke, delete or reset',async()=>{
  const {fam,A,B,key}=await pair('rev');
  const devices=await A.engine.devices();assert.ok(devices.ok);assert.equal(devices.devices.length,2);
  const other=devices.devices.find(d=>!d.self);
  // B, as a thief would, without the family code:
  assert.equal((await B.engine.revoke({code:'',device:devices.devices.find(d=>d.self).device})).code,'family_code');
  assert.equal((await B.engine.deleteChild({code:'guess',kid:B.kid('Ada')})).code,'family_code');
  assert.equal((await B.engine.reset({code:'guess'})).code,'family_code');
  assert.deepEqual(await A.engine.revoke({code:fam.code,device:other.device}),{ok:true});
  const local=JSON.stringify(B.kids);B.practice(B.kid('Ada'),'sub1');
  const r=await B.sync();assert.deepEqual(r,{ok:false,code:'revoked'});
  assert.ok(B.kid('Ada').learning.skills.sub1,'local data intact');assert.ok(local.length>0);
  assert.equal((await B.engine.join({key})).code,'revoked');
  const pull=await call(fam,'/sync/pull',{v:1,gen:A.engine.state().gen,cursor:0},B.token());
  assert.equal(pull.status,403);assert.equal(pull.data.records,undefined);
  // Re-pairing (family code) gives a new device id; enrolling it needs the key, so the parent decides.
  await B.repair();assert.ok((await B.engine.join({key})).ok);assert.deepEqual(await B.sync(),{ok:true});
});

test('15: malformed, oversized and injected input is rejected before storage',async()=>{
  const {clock,fam,A}=await pair('bad');const gen=A.engine.state().gen,token=A.token(),id=()=>S.b64url(webcrypto.getRandomValues(new Uint8Array(16)));
  const child=A.kid('Ada').id,rec=(x={})=>({id:id(),child,kind:'op',iv:'AAAAAAAAAAAAAAAA',ct:'A'.repeat(40),...x});
  const push=(body)=>call(fam,'/sync/push',body,token);
  const count=async()=>(await db.prepare('SELECT COUNT(*) AS n FROM sync_records').first()).n;const before=await count();
  const bad=[
    {v:1,gen,clientNow:clock.now(),records:[rec()],extra:1},{v:2,gen,clientNow:clock.now(),records:[rec()]},{v:1,gen,clientNow:'now',records:[rec()]},
    {v:1,gen,clientNow:clock.now(),records:[]},{v:1,gen,clientNow:clock.now(),records:Array.from({length:41},()=>rec())},
    {v:1,gen,clientNow:clock.now(),records:[rec({kind:'tombstone'})]},{v:1,gen,clientNow:clock.now(),records:[rec({iv:'short'})]},
    {v:1,gen,clientNow:clock.now(),records:[rec({ct:'A'.repeat(43701)})]},{v:1,gen,clientNow:clock.now(),records:[rec({ct:'not base64!'})]},
    {v:1,gen,clientNow:clock.now(),records:[rec({id:'x'})]},{v:1,gen,clientNow:clock.now(),records:[rec({child:'../../etc'})]},
    {v:1,gen,clientNow:clock.now(),records:[{...rec(),__proto__:{admin:true},owner:'x'}]},
    (()=>{const r=rec();return {v:1,gen,clientNow:clock.now(),records:[r,{...r}]};})()
  ];
  for(const body of bad)assert.equal((await push(body)).status,400,JSON.stringify(body).slice(0,120));
  assert.equal((await push({v:1,gen,clientNow:clock.now(),records:[rec({ct:'A'.repeat(700001)})]})).status,413);
  assert.equal((await call(fam,'/sync/pull',{v:1,gen,cursor:-1},token)).status,400);
  assert.equal((await call(fam,'/sync/pull',{v:1,gen,cursor:0,limit:9999},token)).status,400);
  assert.equal((await call(fam,'/sync/enroll',{v:1,mode:'join',proof:'x'},token)).status,400);
  assert.equal((await call(fam,'/sync/admin',{v:1,gen,op:'drop-table',code:fam.code},token)).status,400);
  const raw=await fam.b.worker.fetch(new Request('https://spark.test/sync/pull',{method:'POST',headers:{origin:'https://drasse-sys.github.io',authorization:'Bearer '+token},body:'{'}),fam.env);
  assert.equal(raw.status,400);
  assert.equal(await count(),before);
  // Client side: decrypted payloads must match an exact schema; extra or prototype keys are refused.
  const ok={type:'skill',v:1,t:1,after:0,skill:'add1',e:{s:0,ok:true,k:'task',e:'',c:'',sid:'s',id:'i',verified:true},d:false};
  assert.ok(S.checkPayload('op',ok,''));
  for(const p of [{...ok,extra:1},{...ok,skill:'__proto__'},{...ok,e:{...ok.e,s:9}},JSON.parse('{"type":"skill","v":1,"t":1,"after":0,"skill":"add1","e":{"s":0,"ok":true,"k":"task","e":"","c":"","sid":"s","id":"i","verified":true},"d":false,"__proto__":{"x":1}}'),{...ok,type:'tombstone'},{...ok,v:2}])
    assert.equal(S.checkPayload('op',p,''),null,JSON.stringify(p));
  assert.equal(S.checkPayload('base',{type:'base',v:1,t:1,after:0,profile:{name:'x',age:99,interests:'',readAloud:false},learning:{version:3,skills:{}}},''),null);
});

test('16: Worker or storage errors and malformed replies never corrupt local state; storage-full does not advance the cursor',async()=>{
  const {fam,A,B}=await pair('err');
  A.practice(A.kid('Ada'),'add1',{s:1});await A.sync();
  const keep=()=>[JSON.stringify(B.kids),B.engine.state().cursor];const before=keep();
  // D1 unavailable: 503 with a content-free log line, nothing changes on the phone.
  const broken={prepare(){throw Error('D1_ERROR: secret detail Ada fixture-family');},batch(){throw Error('x');}};
  const logs=fam.b.logs.length;
  B.fam={...fam,env:{...fam.env,SYNC_DB:broken}};
  assert.deepEqual(await B.sync(),{ok:false,code:'unavailable'});assert.deepEqual(keep(),before);
  const line=fam.b.logs.slice(logs).join('\n');assert.match(line,/"evt":"sync_failure"/);assert.ok(!/Ada|fixture|D1_ERROR|secret/.test(line),line);
  B.fam=fam;
  // Malformed replies: wrong shapes, a sequence at or below the cursor, an out-of-range clock flag.
  for(const mutate of [d=>{d.records='x';},d=>{d.next=-1;},d=>{if(d.records[0])d.records[0].seq=0;},d=>{if(d.records[0])d.records[0].ck=7;},d=>{d.serverNow='soon';}]){
    B.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/pull'&&r.data?.records?.length)mutate(r.data);return r;};
    const r=await B.sync();assert.equal(r.ok,false);assert.deepEqual(keep(),before);
  }
  // An undecryptable record is skipped and counted; the rest applies.
  B.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/pull'&&r.data.records.length)r.data.records[0]={...r.data.records[0],ct:'A'+r.data.records[0].ct.slice(1)};return r;};
  await B.sync();assert.ok(B.engine.state().undecryptable>=1);B.intercept=null;
  // Storage full while applying: the cursor does not move; once space is back, the same records arrive again.
  const B2=await device(fam,A.fam===fam?world():world());B2.fam=fam;
  const C=await device(fam,{now:()=>Date.parse('2026-11-04T12:00:00Z')});
  await C.engine.join({key:A.engine.state().key});C.storageOk=false;
  const r=await C.sync();assert.equal(r.ok,false);C.storageOk=true;
  assert.equal(C.engine.state().cursor,0);
  assert.deepEqual(await C.sync(),{ok:true});assert.equal(snapshot(C),snapshot(A));assert.ok(B2);
  // Offline: queued changes stay queued.
  A.online=false;A.practice(A.kid('Ada'),'sub1');assert.deepEqual(await A.sync(),{ok:false,code:'offline'});assert.equal(A.kid('Ada').sync.pending.length,1);
});

test('17: interrupted sync resumes safely (lost push reply, failure between pull pages, reload mid-way)',async()=>{
  const {clock,fam,A,key}=await pair('resume');
  for(let i=0;i<260;i++){A.practice(A.kid('Ada'),['add1','sub1','times2510'][i%3],{s:i%4,ok:i%5!==0});if(i%50===0)clock.advance(3600000);}
  await A.sync();
  const C=await device(fam,clock);await C.engine.join({key});
  let pages=0;C.intercept=async(path,body,call)=>{if(path==='/sync/pull'&&++pages===2)throw Error('network dropped');return call();};
  assert.equal((await C.sync()).code,'offline');const cursor=C.engine.state().cursor;assert.ok(cursor>0);
  C.reload();C.intercept=null;assert.deepEqual(await C.sync(),{ok:true});
  assert.equal(snapshot(C),snapshot(A));assert.equal(snapshot(C),await reference(A));
});

test('18-19: normal sync payloads carry no transcript, image, notes, log, example sentence, credential or secret',async()=>{
  const clock=world(),fam=family(db,clock,'priv'+(n++));const A=await device(fam,clock),B=await device(fam,clock);
  const k=A.kids[0];Object.assign(k,{name:'Ada',notes:['HEMMELIG-NOTAT'],log:[{d:'1',m:'matte',t:'HEMMELIG-LOGG'}],sessions:[{id:'x',d:'1',m:'matte',t:'HEMMELIG-TITTEL',summary:'HEMMELIG-SAMMENDRAG',msgs:[{role:'user',text:'HEMMELIG-TRANSKRIPT data:image/jpeg;base64,/9j/4AAQ'}]}]});
  A.practice(k,'add1');A.addWord(k,'hus','et sted å bo','HEMMELIG-SETNING');A.archive(k);
  const c=await A.engine.create({code:fam.code});A.engine.shareAll();A.saveKids();await A.sync();
  await B.engine.join({key:c.key});await B.sync();
  const markers=['HEMMELIG','data:image','/9j/4AAQ'];
  const secrets=[A.token(),B.token(),fam.env.FAMILY_CODE,fam.env.DEVICE_SIGNING_SECRET,fam.env.GEMINI_API_KEY,c.key,c.key.replace(/-/g,'')];
  // Every plaintext the Worker could ever hold for this family:
  const st=A.engine.state(),keys=await S.deriveKeys(webcrypto.subtle,await S.parseKey(webcrypto.subtle,st.key));
  const rows=(await db.prepare('SELECT * FROM sync_records WHERE family_id=(SELECT family_id FROM sync_families WHERE gen=?1)').bind(st.gen).all()).results;
  assert.ok(rows.length>=2);
  for(const r of rows){
    const p=JSON.stringify(await S.open(webcrypto.subtle,keys.encKey,st.gen,{id:r.record_id,child:r.child_id,kind:r.kind,iv:r.iv,ct:r.ct}));
    for(const m of [...markers,...secrets])assert.ok(!p.includes(m),m+' in synced plaintext');
  }
  // Stored rows and request bodies hold neither child names nor credentials (the device token travels only in the header).
  const db1=JSON.stringify(rows)+JSON.stringify((await db.prepare('SELECT * FROM sync_families').all()).results)+JSON.stringify((await db.prepare('SELECT * FROM sync_devices').all()).results);
  // Long markers and secrets only (>= 8 characters, or containing characters outside base64url): a chance match inside
  // random ciphertext is negligible. Short words ("Ada", "hus") are excluded structurally instead (tests/sync-privacy.mjs).
  for(const m of [...markers,...secrets,keys.proof])assert.ok(!db1.includes(m),m+' stored by the Worker');
  const RECORD_COLUMNS=['family_id','seq','record_id','child_id','kind','received_at','clock_ok','iv','ct'];
  for(const r of rows){
    assert.deepEqual(Object.keys(r).sort(),RECORD_COLUMNS.slice().sort());
    for(const c of ['record_id','child_id'])assert.match(r[c],RX.id);assert.match(r.iv,RX.iv);assert.match(r.ct,RX.ct);assert.ok(['base','op','tombstone'].includes(r.kind));
    for(const c of ['seq','received_at','clock_ok'])assert.ok(Number.isSafeInteger(r[c]));
  }
  const sealed=[];
  for(const dev of [A,B]){
    const ctx={token:dev.token(),familyCode:fam.env.FAMILY_CODE,proofs:new Set([keys.proof]),secrets:[A.token(),B.token(),c.key,c.key.replace(/-/g,'')]};
    for(const {path,body} of dev.sent){
      const text=JSON.stringify(body);sealed.push(...checkSyncRequest({path,body:text,auth:'Bearer '+dev.token()},ctx));
      for(const m of markers)assert.ok(!text.includes(m),path+' carries '+m);
    }
  }
  assert.ok((await openAll(S,c.key,sealed)).some(o=>o.p.type==='base'&&o.p.profile.name==='Ada'),'the name exists only inside authenticated ciphertext');
  // Responses never echo the device token.
  const resp=await call(fam,'/sync/pull',{v:1,gen:st.gen,cursor:0},A.token());assert.ok(!resp.text.includes(A.token())&&!resp.text.includes(A.token().split('.')[1]));
  // Local-only fields stay on A.
  assert.equal(B.kid('Ada').notes.length,0);assert.equal(B.kid('Ada').sessions.length,0);assert.equal(B.kid('Ada').learning.items[0].sentence,'');
  assert.equal(A.kid('Ada').learning.items[0].sentence,'HEMMELIG-SETNING');assert.equal(A.kid('Ada').sessions[0].msgs.length,1);
  assert.ok(A.kid('Ada').learning.sessions[0].interactions.length>0);assert.equal(B.kid('Ada').learning.sessions[0].interactions.length,0);
});

test('20: seeded randomized operations on three phones always converge to the reference state; reload keeps it',async()=>{
  for(const seed of [1,2,3,4,5,6]){
    const rnd=prng(seed*7919),pick=a=>a[rnd(1)[0]%a.length],chance=p=>rnd(1)[0]<p*256;
    const clock=world(),fam=family(db,clock,'prop'+seed+'-'+(n++));
    const devs=[await device(fam,clock,{seed:seed*10+1}),await device(fam,clock,{seed:seed*10+2}),await device(fam,clock,{seed:seed*10+3})];
    const [A]=devs;A.kids[0].name='Ada';A.practice(A.kids[0],'add1');const bo=blankKid('Bo');A.kids.push(bo);A.practice(bo,'readInfo',{verified:false});
    const c=await A.engine.create({code:fam.code});A.engine.shareAll();A.saveKids();await A.sync();
    for(const d of devs.slice(1)){await d.engine.join({key:c.key});await d.sync();}
    for(let step=0;step<70;step++){
      const d=pick(devs),kid=pick(d.kids.filter(k=>k.sync));
      const r=rnd(1)[0];
      if(r<30)d.online=!d.online;
      else if(r<150&&kid)d.practice(kid,pick(['add1','sub1','times2510','addCarry']),{ok:chance(.7),s:rnd(1)[0]%5,k:pick(['task','cold','prøv']),c:pick(['','sikker','gjetter']),verified:chance(.8)});
      else if(r<170&&kid)d.addWord(kid,pick(['hus','tre','bil','sol']),pick(['a','b']));
      else if(r<185&&kid&&kid.learning.items.length)d.reviewWord(kid,pick(kid.learning.items).id,{ok:chance(.6),s:rnd(1)[0]%3});
      else if(r<190&&kid)d.clearWords(kid);
      else if(r<200&&kid)d.profile(kid,{interests:pick(['fotball','dyr','rom']),age:6+rnd(1)[0]%5});
      else if(r<210&&kid)d.archive(kid,{reflection:pick(['','Tallinje','Hint'])});
      else if(r<240&&d.online)await d.sync();
      else clock.advance(rnd(1)[0]*1200000);
      if(chance(.05))d.skew=pick([0,0,0,-2*DAY,3*3600000]);
    }
    for(const d of devs){d.online=true;d.skew=0;}
    for(let round=0;round<2;round++)for(const d of devs.slice().sort(()=>rnd(1)[0]-128))assert.deepEqual(await d.sync(),{ok:true});
    const ref=await reference(A);
    for(const d of devs)assert.equal(snapshot(d),ref,'seed '+seed);
    for(const d of devs){d.reload();assert.deepEqual(await d.sync(),{ok:true});}
    for(const d of devs)assert.equal(snapshot(d),ref,'seed '+seed+' after reload');
  }
});

test('migration: single-device legacy state → stable id → first sync → second phone joins → converged; local-only fields stay',async()=>{
  const clock=world(),fam=family(db,clock,'mig'+(n++));const A=await device(fam,clock);
  // Old local-only state as C3/TR1 phones hold it: no id, no sync data.
  const legacy=L.empty();const t0=clock.now()-20*DAY;
  for(let i=0;i<12;i++)L.event(legacy,i%2?'add1':'readInfo',{t:t0+i*DAY,s:i%3,ok:i%4!==0,k:i%3?'cold':'task',sid:'l'+i,id:'l'+i,verified:i%5!==0,c:'sikker'});
  legacy.items.push({id:'w1',word:'hus',meaning:'et sted å bo',sentence:'Ola så et hus.',box:2,due:t0+30*DAY,lastAt:t0+5*DAY,ev:[{t:t0+5*DAY,s:0,ok:true,delayed:true}]});
  legacy.sessions.push({id:'old',startedAt:t0,endedAt:t0+60000,activeMs:60000,interactions:[t0],mode:'matte',events:[],reflection:'Hint',interventions:0});
  A.kids=[{...blankKid('Ola'),age:10,notes:['lokal'],learning:L.normalizeMemory(JSON.parse(JSON.stringify(legacy)))},{...blankKid('')}];
  A.persisted=JSON.stringify(A.kids);A.reload();
  const before=JSON.parse(JSON.stringify(A.kids[0].learning));
  assert.equal(A.kids[0].id,undefined);
  const c=await A.engine.create({code:fam.code});assert.equal(A.engine.shareAll(),1,'the empty starter profile is not shared');A.saveKids();
  assert.match(A.kids[0].id,S.ID);await A.sync();
  // The shared state is the legacy state: nothing lost or changed by the first sync.
  assert.equal(JSON.stringify(canon(A.kids[0].learning)),JSON.stringify(canon(before)));
  const B=await device(fam,clock);await B.engine.join({key:c.key});await B.sync();
  assert.equal(B.kids.length,1,'the joining phone\'s empty starter profile is replaced');
  assert.equal(snapshot(A),snapshot(B));assert.equal(B.kids[0].name,'Ola');
  assert.equal(JSON.stringify(A.kids[0].notes),'["lokal"]');assert.equal(B.kids[0].notes.length,0);
  // The id is stable from now on.
  const id=A.kids[0].id;A.reload();await A.sync();assert.equal(A.kids[0].id,id);
});

test('checkpoints: records folded after the order window give the same state as a full replay on a fresh phone',async()=>{
  const {clock,fam,A,B,key}=await pair('cp');
  for(let week=0;week<5;week++){
    for(let i=0;i<6;i++){clock.advance(DAY);A.practice(A.kid('Ada'),'add1',{k:'cold',c:'sikker',sid:'w'+week+i});B.practice(B.kid('Ada'),'sub1',{s:i%3});await A.sync();await B.sync();}
  }
  await A.sync();
  assert.ok(A.kid('Ada').sync.log.length<40,'old records are folded into the checkpoint');
  const C=await device(fam,clock);await C.engine.join({key});await C.sync();
  assert.equal(snapshot(C),snapshot(A));assert.equal(snapshot(B),snapshot(A));assert.equal(snapshot(A),await reference(A));
});

test('reset and re-pair: a new key starts a new generation; old copies stay as local forks; a re-paired phone re-enrols itself',async()=>{
  const {fam,A,B}=await pair('reset');
  B.online=false;B.practice(B.kid('Ada'),'sub1');B.online=true;
  // Re-pair: new device id, same key, enrols itself on the next round.
  await B.repair();assert.deepEqual(await B.sync(),{ok:true});
  B.online=false;B.practice(B.kid('Ada'),'times2510');B.online=true;
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok);await A.sync();
  assert.equal((await B.sync()).code,'rejoin');
  assert.ok((await B.engine.join({key:r.key})).ok);assert.deepEqual(await B.sync(),{ok:true});
  const copies=B.kids.filter(k=>k.name==='Ada');assert.equal(copies.length,2);
  const fork=copies.find(k=>!k.sync);assert.equal(fork.fork,true);assert.ok(fork.learning.skills.times2510,'unsent work kept locally');
  assert.equal(snapshot(A),snapshot(B));
});

test('remove from this phone keeps the family copy; fetching removed children brings them back',async()=>{
  const {A,B}=await pair('hide');
  assert.deepEqual(B.engine.hide(B.kid('Ada')),{ok:true});assert.equal(B.kid('Ada'),undefined);
  A.practice(A.kid('Ada'),'sub1');await A.sync();await B.sync();assert.equal(B.kid('Ada'),undefined);
  // Re-paired with nothing queued: the pull re-enrols the phone with its stored key; the removal still holds.
  await B.repair();assert.deepEqual(await B.sync(),{ok:true});assert.equal(B.kid('Ada'),undefined);
  assert.ok((await B.engine.join({key:A.engine.state().key})).ok);await B.sync();assert.equal(B.kid('Ada'),undefined,'a same-generation re-join keeps removals');
  B.engine.unhide();await B.sync();assert.equal(snapshot(A),snapshot(B));
  B.practice(B.kid('Ada'),'add1');assert.equal(B.engine.hide(B.kid('Ada')).code,'pending','unsent changes block removal');
});

test('feature gate and auth-before-read: /sync/* is 404 unless enabled with a database; no token, no database access',async()=>{
  const touched=[];const spy={prepare(){touched.push('prepare');throw Error('touched');},batch(){touched.push('batch');throw Error('touched');}};
  const b=backend(()=>{throw Error('no provider');});
  for(const extra of [{},{SYNC_ENABLED:'1'},{SYNC_DB:spy},{SYNC_ENABLED:'true',SYNC_DB:spy}]){
    const {env}=environment(extra);
    const r=await b.worker.fetch(request('/sync/pull',{v:1,gen:'x',cursor:0},await b.api.makeToken(env,webcrypto.randomUUID())),env);
    assert.equal(r.status,404,JSON.stringify(Object.keys(extra)));
  }
  const {env}=environment({SYNC_ENABLED:'1',SYNC_DB:spy});
  for(const path of ['/sync/status','/sync/enroll','/sync/push','/sync/pull','/sync/devices','/sync/admin']){
    assert.equal((await b.worker.fetch(request(path,{v:1}),env)).status,401,path);
    assert.equal((await b.worker.fetch(request(path,{v:1},'forged.token'),env)).status,401,path);
  }
  assert.equal((await b.worker.fetch(new Request('https://spark.test/sync/pull',{headers:{origin:'https://drasse-sys.github.io'}}),env)).status,404);
  assert.deepEqual(touched,[]);
  // The production configuration has no sync binding or switch.
  const config=JSON.parse(execFileSync('python',['-c','import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',new URL('backend/wrangler.toml',root).pathname],{encoding:'utf8'}));
  assert.equal(config.d1_databases,undefined);assert.equal(config.vars.SYNC_ENABLED,undefined);assert.equal(config.ratelimits.length,4);
  assert.equal(config.env['sync-lab'].vars.SYNC_ENABLED,'1');assert.equal(config.env['sync-lab'].d1_databases[0].binding,'SYNC_DB');
});

test('rate limits: sync uses its own per-device budget; enrolment and parent operations use pairing\'s budget',async()=>{
  const clock=world(),fam=family(db,clock,'rl'+(n++),{SYNC_LIMITER:{limit:async()=>({success:false})}});
  const token=await fam.b.api.makeToken(fam.env,webcrypto.randomUUID());
  const r=await call(fam,'/sync/status',{v:1},token);assert.equal(r.status,429);assert.equal(r.data.code,'rate');
  const f2=family(db,clock,'rl'+(n++));const t2=await f2.b.api.makeToken(f2.env,webcrypto.randomUUID());
  await call(f2,'/sync/status',{v:1},t2);await call(f2,'/sync/enroll',{v:1,mode:'join',proof:'A'.repeat(43)},t2);
  assert.ok(f2.calls.some(c=>c.name==='CHAT_LIMITER'&&c.key.startsWith('sync:')));
  const device=JSON.parse(Buffer.from(t2.split('.')[0],'base64url')).deviceId;
  assert.ok(f2.calls.some(c=>c.name==='PAIR_LIMITER'&&c.key==='sync-admin:'+device),'per device, not per IP');
  assert.ok(!f2.calls.some(c=>c.name==='PAIR_GLOBAL_LIMITER'),'no family-wide budget a token holder could drain');
  const f3=family(db,clock,'rl'+(n++),{PAIR_LIMITER:{limit:async()=>({success:false})}});const t3=await f3.b.api.makeToken(f3.env,webcrypto.randomUUID());
  assert.equal((await call(f3,'/sync/admin',{v:1,op:'reset',code:f3.code,proof:'A'.repeat(43)},t3)).status,429);
  assert.equal((await call(f3,'/sync/pull',{v:1,gen:'x',cursor:0},t3)).status,403,'ordinary sync is not on the pairing budget');
});

test('key format: typing errors are caught locally; separators and confusable letters are tolerated',async()=>{
  const raw=webcrypto.getRandomValues(new Uint8Array(16)),text=await S.keyText(webcrypto.subtle,raw);
  assert.match(text,/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual([...await S.parseKey(webcrypto.subtle,text)],[...raw]);
  assert.deepEqual([...await S.parseKey(webcrypto.subtle,' '+text.toLowerCase().replace(/-/g,' ')+' ')],[...raw]);
  const typo=text.slice(0,5)+(text[5]==='A'?'B':'A')+text.slice(6);assert.equal(await S.parseKey(webcrypto.subtle,typo),null);
  assert.equal(await S.parseKey(webcrypto.subtle,text.slice(0,-1)),null);
  // Different keys give unrelated encryption keys and proofs; the proof reveals nothing usable for decryption.
  const a=await S.deriveKeys(webcrypto.subtle,raw),b=await S.deriveKeys(webcrypto.subtle,webcrypto.getRandomValues(new Uint8Array(16)));
  assert.notEqual(a.proof,b.proof);
  const sealed=await S.seal(webcrypto.subtle,n=>webcrypto.getRandomValues(new Uint8Array(n)),a.encKey,'G'.repeat(21)+'A',{id:'I'.repeat(21)+'A',child:'C'.repeat(21)+'A',kind:'op'},{type:'word-remove',v:1,t:1,after:0,ids:['w']});
  assert.equal(sealed.ct.length%4!==1,true);assert.equal((S.unb64url(sealed.ct).length-16)%256,0,'padded to 256-byte buckets');
  assert.ok(await S.open(webcrypto.subtle,a.encKey,'G'.repeat(21)+'A',sealed));
  assert.equal(await S.open(webcrypto.subtle,b.encKey,'G'.repeat(21)+'A',sealed),null);
  // Associated data: moving a payload to another child, kind, id or generation fails authentication.
  for(const moved of [{...sealed,child:'D'.repeat(21)+'A'},{...sealed,kind:'base'},{...sealed,id:'J'.repeat(21)+'A'}])assert.equal(await S.open(webcrypto.subtle,a.encKey,'G'.repeat(21)+'A',moved),null);
  assert.equal(await S.open(webcrypto.subtle,a.encKey,'H'.repeat(21)+'A',sealed),null);
});

/* Negative controls: each removes exactly one defence from the evaluated source and shows the attack it blocks succeeds. */
async function pairWith({clientPatch,serverPatch,name='nc'}={}){
  const clock=world(),fam=family(db,clock,name+(n++),{},serverPatch),realm=clientPatch?clientRealm(clientPatch):undefined;
  const A=await device(fam,clock,{realm}),B=await device(fam,clock,{realm});
  A.kids[0].name='Ada';A.practice(A.kids[0],'add1');const c=await A.engine.create({code:fam.code});A.engine.shareAll();A.saveKids();await A.sync();
  await B.engine.join({key:c.key});await B.sync();return {clock,fam,A,B};
}
async function replayedReview(clientPatch){
  const {A,B}=await pairWith({clientPatch,name:'nc-seen'});
  const w=A.addWord(A.kid('Ada'),'hus','et sted å bo');await A.sync();await B.sync();
  A.reviewWord(A.kid('Ada'),w.id);await A.sync();await B.sync();
  const stored=await db.prepare("SELECT record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records WHERE family_id=(SELECT family_id FROM sync_families WHERE gen=?1) ORDER BY seq DESC LIMIT 1").bind(B.engine.state().gen).first();
  B.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/pull'){r.data.records.push({...stored,seq:r.data.next+1});r.data.next+=1;}return r;};
  await B.sync();return B.kid('Ada').learning.items[0].ev.length;
}
test('negative control: without the seen-id check a replayed record is applied twice',async()=>{
  assert.equal(await replayedReview(),1);
  assert.equal(await replayedReview(cut('if(seen(target.sync,rec.id))continue;')),2);
});
async function fastClockCredit(clientPatch){
  const {clock,A,B}=await pairWith({clientPatch,name:'nc-ck'});
  // True gap 1 hour; the phone's clock says 3 days; it uploads 29 hours later, so its receipt time alone would look delayed.
  clock.advance(3600000);B.online=false;B.skew=3*DAY;B.practice(B.kid('Ada'),'add1',{k:'cold',sid:'late',c:'sikker'});
  clock.advance(29*3600000);B.online=true;await B.sync();await A.sync();
  return A.kid('Ada').learning.totals.cold;
}
test('negative control: without the Worker clock flag a fast phone clock manufactures delay credit',async()=>{
  assert.equal(await fastClockCredit(),0);
  assert.equal(await fastClockCredit(cut("if(rec.ck!==1||t>at+SKEW)return {t:at,delay:false};")),1);
});
test('negative control: without family scoping in pull another family\'s records are readable',async()=>{
  const one=await pair('nc-fam-one');
  const two=await pairWith({serverPatch:cut('FROM sync_records WHERE family_id=?1 AND seq>?2 ORDER BY seq','FROM sync_records WHERE seq>?2 ORDER BY seq'),name:'nc-fam-two'});
  const oneChild=one.A.kid('Ada').id,gen=two.A.engine.state().gen;
  const scoped=await call(one.fam,'/sync/pull',{v:1,gen:one.A.engine.state().gen,cursor:0},one.A.token());assert.ok(scoped.data.records.every(r=>r.child===oneChild));
  const leaked=await call(two.fam,'/sync/pull',{v:1,gen,cursor:0},two.A.token());
  assert.ok(leaked.data.records.some(r=>r.child===oneChild),'the patched Worker leaks family one');
});

/* Repairs after the fresh review (each test reproduces the reviewer's scenario). */
test('review #1: a reset never brings back a child deleted earlier (resetting phone was stale, or another phone resets)',async()=>{
  {// The stale phone resets: it applies the deletion first.
    const {fam,A,B}=await pair('r1a');B.online=false;
    assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:A.kid('Ada')}),{ok:true});
    B.online=true;const r=await B.engine.reset({code:fam.code});assert.ok(r.ok);
    assert.equal(B.kid('Ada'),undefined);await B.sync();
    assert.ok((await A.engine.join({key:r.key})).ok);await A.sync();assert.equal(A.kid('Ada'),undefined);
    B.online=false;assert.equal((await B.engine.reset({code:fam.code})).code,'offline');
  }
  {// Another phone resets; the stale phone re-joins and verifies the old tombstone with its previous key.
    const {fam,A,B}=await pair('r1b');B.online=false;
    assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:A.kid('Ada')}),{ok:true});
    const r=await A.engine.reset({code:fam.code});assert.ok(r.ok);
    B.online=true;assert.equal((await B.sync()).code,'rejoin');
    assert.ok((await B.engine.join({key:r.key})).ok);assert.equal(B.kids.some(k=>k.name==='Ada'),false,'removed, not kept as a copy');
  }
});
test('review #2: a token holder spamming parent operations cannot use up the parent\'s budget',async()=>{
  const counts=new Map();const limiter={limit:async({key})=>{const n=(counts.get(key)||0)+1;counts.set(key,n);return {success:n<=6};}};
  const clock=world(),fam=family(db,clock,'r2'+(n++),{PAIR_LIMITER:limiter,PAIR_GLOBAL_LIMITER:limiter});
  const A=await device(fam,clock),B=await device(fam,clock);A.kids[0].name='Ada';const c=await A.engine.create({code:fam.code});
  await B.engine.join({key:c.key});await A.sync();await B.sync();
  for(let i=0;i<20;i++)await call(fam,'/sync/admin',{junk:1},B.token());
  const victim=(await A.engine.devices()).devices.find(d=>!d.self).device;
  assert.deepEqual(await A.engine.revoke({code:fam.code,device:victim}),{ok:true});
});
test('review #4/#5: the same word added on two phones keeps both phones\' reviews; an empty meaning still syncs',async()=>{
  const {clock,A,B}=await pair('r4');A.online=B.online=false;
  A.addWord(A.kid('Ada'),'hus','et sted å bo');B.addWord(B.kid('Ada'),'hus','et sted å bo','Ola så et hus.');
  const bid=B.kid('Ada').learning.items[0].id;clock.advance(2*DAY);B.reviewWord(B.kid('Ada'),bid);clock.advance(2*DAY);B.reviewWord(B.kid('Ada'),bid);
  A.addWord(A.kid('Ada'),'katt','');
  A.online=B.online=true;await A.sync();await B.sync();await A.sync();
  assert.equal(snapshot(A),snapshot(B));
  const hus=A.kid('Ada').learning.items.filter(w=>w.word==='hus');assert.equal(hus.length,1);assert.equal(hus[0].ev.length,2,'B\'s reviews count');
  assert.equal(B.kid('Ada').learning.items.find(w=>w.word==='hus').sentence,'Ola så et hus.','B keeps its sentence');
  assert.ok(B.kid('Ada').learning.items.some(w=>w.word==='katt'),'empty-meaning word reached B');assert.ok(A.kid('Ada').sync,'still shared');
});
test('review #6: a late review never moves the last-review anchor back (no delay credit gained)',()=>{
  const m=L.empty();L.addWord(m,{id:'w',word:'hus',meaning:'x',t:0});
  L.reviewWord(m,{wordId:'w',t:DAY,s:0,ok:true,c:''});L.reviewWord(m,{wordId:'w',t:5*DAY,s:0,ok:true,c:''});
  // A review from day 2 merged after day 5 (stale upload): no credit for it, and none for the next review either.
  assert.equal(L.reviewWord(m,{wordId:'w',t:2*DAY,s:2,ok:true,c:''}).delayed,false);
  assert.equal(L.reviewWord(m,{wordId:'w',t:5*DAY+12*3600000,s:0,ok:true,c:''}).delayed,false);
  // Within a day the review is clamped to the last one, so the anchor does not move back at all.
  L.reviewWord(m,{wordId:'w',t:9*DAY,s:0,ok:true,c:''});L.reviewWord(m,{wordId:'w',t:8.5*DAY,s:0,ok:true,c:''});assert.equal(m.items[0].lastAt,9*DAY);
});
test('review #8: padding buckets count encrypted UTF-8 bytes, so non-ASCII letters do not change the length',async()=>{
  const k=await S.deriveKeys(webcrypto.subtle,webcrypto.getRandomValues(new Uint8Array(16))),r=x=>webcrypto.getRandomValues(new Uint8Array(x));
  const len=async name=>(await S.seal(webcrypto.subtle,r,k.encKey,'G'.repeat(21)+'A',{id:'I'.repeat(21)+'A',child:'C'.repeat(21)+'A',kind:'op'},{type:'profile',v:1,t:1,after:0,profile:{name,age:9,interests:'',readAloud:false}})).ct.length;
  assert.equal(await len('Bjorn Aagard'),await len('Bjørn Ågård'));assert.equal(await len('Bjorn Aagard'),await len('Æøå æøå æøå'));
});
test('review #9/#11/#13: full child quota waits instead of forking; malformed acknowledgements stop the round; corrupt stored data costs one child only',async()=>{
  const {fam,A,B}=await pair('r9');
  for(let i=0;i<20;i++){const k=blankKid('Barn'+i);A.kids.push(k);A.practice(k,'add1');A.engine.share(k);}A.saveKids();
  assert.equal((await A.sync()).code,'quota');
  const waiting=A.kids.filter(k=>k.sync&&k.sync.pending.length);assert.equal(waiting.length,1);assert.equal(waiting[0].fork,undefined,'still shared, waiting');
  let pushes=0;B.practice(B.kid('Ada'),'sub1');
  B.intercept=async(path,body,call)=>{const r=await call();if(path==='/sync/push'){pushes++;r.data.results=r.data.results.map(x=>({...x,id:'X'.repeat(21)+'A'}));}return r;};
  assert.equal((await B.sync()).code,'unavailable');assert.equal(pushes,1);B.intercept=null;
  assert.ok(fam);
  const other=await pair('r13');const D=other.B;
  D.kid('Ada').sync.cp.st.learning.skills.add1.ev='corrupt';
  const C=blankKid('Cia');D.kids.push(C);D.practice(C,'add1');D.engine.share(C);D.saveKids();other.A.practice(other.A.kid('Ada'),'add1');await other.A.sync();
  assert.deepEqual(await D.sync(),{ok:true});assert.equal(D.kid('Ada').fork,true);assert.ok(D.kid('Cia').sync&&D.kid('Cia').sync.pending.length===0);
});
test('review #14: a revoked device stays revoked after a reset',async()=>{
  const {fam,A,B}=await pair('r14');
  const victim=(await A.engine.devices()).devices.find(d=>!d.self).device;await A.engine.revoke({code:fam.code,device:victim});
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok);
  assert.equal((await B.engine.join({key:r.key})).code,'revoked');
});

/* Repairs after the narrow re-review. */
test('re-review HIGH-1: a stale phone from an older generation never re-shares a child deleted in a later one',async()=>{
  const {fam,A,B}=await pair('rr1');B.online=false;
  const r1=await A.engine.reset({code:fam.code});assert.ok(r1.ok);await A.sync();
  const ada2=A.kid('Ada');assert.ok(ada2.sync);assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:ada2}),{ok:true});
  B.online=true;const r2=await B.engine.reset({code:fam.code});assert.ok(r2.ok);
  const local=B.kid('Ada');assert.ok(local&&!local.sync&&local.fork,'kept on B as a local copy only');
  assert.equal(B.engine.shareAll(),0,'local copies are never shared in bulk');
  assert.ok((await A.engine.join({key:r2.key})).ok);await A.sync();assert.equal(A.kid('Ada'),undefined);
  // Join variant.
  const {fam:f2,A:A2,B:B2}=await pair('rr1b');B2.online=false;
  const k1=await A2.engine.reset({code:f2.code});await A2.sync();await A2.engine.deleteChild({code:f2.code,kid:A2.kid('Ada')});
  B2.online=true;assert.ok((await B2.engine.join({key:k1.key})).ok);await B2.sync();
  assert.ok(B2.kid('Ada').fork);assert.equal(B2.engine.shareAll(),0);await A2.sync();assert.equal(A2.kid('Ada'),undefined);
});
test('re-review HIGH-2: a full family can still reset; deleted ids are bounded and never fill the child quota',async()=>{
  const {fam,A}=await pair('rr2');
  for(let i=0;i<20;i++){const k=blankKid('Barn'+i);A.kids.push(k);A.practice(k,'add1');A.engine.share(k);}A.saveKids();
  assert.equal((await A.sync()).code,'quota');
  const r=await A.engine.reset({code:fam.code});assert.ok(r.ok,'reset is the way out');
  // 150 deletions over time: ids and tombstones stay bounded at 100, and sharing still works.
  const famId=(await db.prepare('SELECT family_id AS f FROM sync_families WHERE gen=?1').bind(A.engine.state().gen).first()).f;
  for(let i=0;i<150;i++)await db.prepare("INSERT INTO sync_children (family_id, child_id, status, created_at, deleted_at) VALUES (?1, ?2, 'deleted', 1, ?3)").bind(famId,'Z'+String(i).padStart(20,'0')+'A',i).run();
  await A.sync();
  for(const k of A.kids.filter(x=>x.sync&&!x.sync.pending.length).slice(0,2))assert.deepEqual(await A.engine.deleteChild({code:fam.code,kid:k}),{ok:true});
  const n=(await db.prepare("SELECT COUNT(*) AS n FROM sync_children WHERE family_id=?1 AND status='deleted'").bind(famId).first()).n;assert.equal(n,100);
  const fresh=blankKid('Ny');A.kids.push(fresh);A.practice(fresh,'add1');A.engine.share(fresh);A.saveKids();await A.sync();
  assert.equal(fresh.sync.pending.length,0,'shared despite 100 deleted ids');
});
test('re-review MEDIUM: one far-future review does not pin a word in the future',()=>{
  const m=L.empty();L.addWord(m,{id:'w',word:'hus',meaning:'x',t:0});
  L.reviewWord(m,{wordId:'w',t:DAY,s:0,ok:true,c:''});L.reviewWord(m,{wordId:'w',t:400*DAY,s:0,ok:true,c:''});
  const r=L.reviewWord(m,{wordId:'w',t:3*DAY,s:0,ok:true,c:''});assert.equal(r.delayed,false);assert.equal(m.items[0].lastAt,3*DAY,'re-anchored');
  assert.equal(L.reviewWord(m,{wordId:'w',t:5*DAY,s:0,ok:true,c:''}).delayed,true,'normal credit resumes');
});
