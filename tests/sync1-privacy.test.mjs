import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {localD1,world,family,device,clientRealm,cut,S} from './sync-helpers.mjs';
import {checkSyncRequest,openAll,assertTamperFails,proofOf,RX} from './sync-privacy.mjs';

/* SYNC1 privacy: structural request evidence (tests/sync-privacy.mjs) with negative controls.
   The validator must REJECT a request that places child content or a credential in a server-readable field, and must
   ACCEPT genuine ciphertext even when its base64url happens to contain a short name (the CI flake of run 41882703763). */
const {db,dispose}=await localD1();
test.after(()=>dispose());
const subtle=webcrypto.subtle;
let n=0;

// A real family round on the real engine and Worker: A creates and shares "Ada" with a word, B joins and syncs.
async function round(realm){
  const clock=world(),fam=family(db,clock,'pv'+(n++));
  const A=await device(fam,clock,{realm}),B=await device(fam,clock);
  const ada=A.kids[0];ada.name='Ada';ada.age=9;ada.interests='hester';
  A.practice(ada,'add1');A.addWord(ada,'hus','et sted å bo');A.archive(ada);
  const c=await A.engine.create({code:fam.code});assert.ok(c.ok,JSON.stringify(c));
  A.engine.shareAll();A.practice(ada,'add1');A.addWord(ada,'tre','et tre');A.saveKids();const ra=await A.sync();
  await B.engine.join({key:c.key});await B.sync();
  return {fam,A,B,key:c.key,ra};
}
const ctxOf=async(dev,{fam,key,A,B})=>({token:dev.token(),familyCode:fam.code,proofs:new Set([await proofOf(S,key)]),secrets:[A.token(),B.token(),key,key.replace(/-/g,'')]});
const captured=(dev,ctx)=>dev.sent.map(({path,body})=>({path,body:JSON.stringify(body),auth:'Bearer '+ctx.token}));

test('privacy: every real request is schema-exact, credentials stay in the header, every ciphertext opens only with the family key',async()=>{
  const r=await round();assert.deepEqual(r.ra,{ok:true});
  const sealed=[];
  for(const dev of [r.A,r.B]){const ctx=await ctxOf(dev,r);for(const q of captured(dev,ctx))sealed.push(...checkSyncRequest(q,ctx));}
  assert.ok(sealed.length>=4,'records sent');
  const opened=await openAll(S,r.key,sealed);
  // The child content exists, but only inside authenticated plaintext.
  assert.deepEqual([...new Set(opened.map(o=>o.p.type))].sort(),['base','session','skill','word-add']);
  const base=opened.find(o=>o.rec.kind==='base').p;
  assert.equal(base.profile.name,'Ada');assert.equal(base.profile.interests,'hester');
  assert.deepEqual(base.learning.items.map(w=>[w.word,w.meaning,w.sentence]),[['hus','et sted å bo','']]);
  assert.ok(opened.some(o=>o.p.type==='session'),'session summary travels encrypted');
  for(const o of opened)await assertTamperFails(S,r.key,o,S.b64url(new Uint8Array(16).fill(7)));
  // A different family key cannot open them.
  const other=await S.keyText(subtle,new Uint8Array(16).fill(9));
  await assert.rejects(openAll(S,other,sealed.slice(0,1)),/must open under authenticated decryption/);
});

test('privacy negative control: a plaintext {name:"Ada"} added to a real push request (engine patched) is rejected',async()=>{
  const realm=clientRealm(cut('clientNow:d.now(),records:batch}','clientNow:d.now(),records:batch,name:kid.name}'));
  const r=await round(realm);
  const ctx=await ctxOf(r.A,r);
  const pushes=captured(r.A,ctx).filter(q=>q.path==='/sync/push');
  assert.ok(pushes.length>=1&&pushes.every(q=>JSON.parse(q.body).name==='Ada'),'the patched engine really sent the plaintext name');
  for(const q of pushes)assert.throws(()=>checkSyncRequest(q,ctx),/server-readable properties must be exactly/);
});

test('privacy negative controls: plaintext beside ciphertext, unencrypted payloads, credentials in the body, foreign tokens',async()=>{
  const r=await round();const ctx=await ctxOf(r.A,r);
  const reqs=captured(r.A,ctx),push=reqs.find(q=>q.path==='/sync/push'),body=JSON.parse(push.body);
  const variant=f=>{const b=JSON.parse(push.body);f(b);return {...push,body:JSON.stringify(b)};};
  // Accepted as captured.
  checkSyncRequest(push,ctx);
  // Child content in any extra server-readable property, top level or per record.
  for(const [k,v] of [['name','Ada'],['interests','hester'],['word','hus'],['meaning','et sted å bo'],['summary','x'],['transcript','x'],['image','data:image/jpeg;base64,x'],['notes',['x']],['log',['x']]]){
    assert.throws(()=>checkSyncRequest(variant(b=>{b[k]=v;}),ctx),/exactly/,k);
    assert.throws(()=>checkSyncRequest(variant(b=>{b.records[0][k]=v;}),ctx),/exactly/,'record '+k);
  }
  // Plaintext disguised in an opaque-looking field: a schema value that is not opaque, or a ciphertext that is not.
  assert.throws(()=>checkSyncRequest(variant(b=>{b.records[0].child='Ada';}),ctx),/opaque/);
  assert.throws(()=>checkSyncRequest(variant(b=>{b.records[0].kind='name';}),ctx),/kind/);
  const plainCt=S.b64url(new TextEncoder().encode(JSON.stringify({type:'profile',v:1,t:1,after:0,profile:{name:'Ada',age:9,interests:'',readAloud:false}})));
  const smuggled=checkSyncRequest(variant(b=>{b.records[0].ct=plainCt;}),ctx);// shape-valid: only decryption can tell
  await assert.rejects(openAll(S,r.key,smuggled),/authenticated decryption/);
  // Credentials: token or key in the body; the key sent instead of its proof; another phone's token in the header.
  assert.throws(()=>checkSyncRequest(variant(b=>{b.token=r.A.token();}),ctx),/exactly/);
  assert.throws(()=>checkSyncRequest(variant(b=>{b.records[0].ct=r.key.replace(/-/g,'');}),ctx),/credential/);
  assert.throws(()=>checkSyncRequest({...push,body:push.body.replace('"v":1','"v":1,"k":"'+r.key+'"')},ctx),/exactly/);
  assert.throws(()=>checkSyncRequest({...push,auth:'Bearer '+r.B.token()},ctx),/Authorization/);
  const enroll=reqs.find(q=>q.path==='/sync/enroll');checkSyncRequest(enroll,ctx);
  const raw=S.b64url(await S.parseKey(subtle,r.key));
  assert.throws(()=>checkSyncRequest({...enroll,body:JSON.stringify({...JSON.parse(enroll.body),proof:raw+'A'.repeat(43-raw.length-1)+'A'})},ctx),/HKDF member derivation/);
  // The family code is accepted only on the two operations that must prove it.
  assert.throws(()=>checkSyncRequest(variant(b=>{b.code=r.fam.code;}),ctx),/exactly/);
  assert.equal(body.records.length>0,true);
});

test('privacy CI-flake reproduction: genuine ciphertext that happens to contain "Ada" fails the old substring scan and passes the structural proof',async()=>{
  // Deterministic: the real codec with counter IVs until the base64url ciphertext of a payload WITHOUT "Ada" contains "Ada".
  const key=await S.keyText(subtle,new Uint8Array(16).fill(3)),{encKey}=await S.deriveKeys(subtle,await S.parseKey(subtle,key));
  const gen=S.b64url(new Uint8Array(16).fill(1)),child=S.b64url(new Uint8Array(16).fill(2)),payload={type:'profile',v:1,t:1e12,after:0,profile:{name:'Bo',age:7,interests:'',readAloud:false}};
  let rec=null,tries=0;
  for(;tries<200000&&!rec;tries++){
    const iv=new Uint8Array(12);new DataView(iv.buffer).setUint32(8,tries);
    const r=await S.seal(subtle,()=>iv,encKey,gen,{id:S.b64url(new Uint8Array(16).fill(4)),child,kind:'op'},payload);
    if(r.ct.includes('Ada'))rec=r;
  }
  assert.ok(rec,'found within '+tries+' IVs');
  const body=JSON.stringify({v:1,gen,clientNow:1e12,records:[rec]});
  assert.ok(body.includes('Ada'),'the old scan `body.includes("Ada")` would have failed here');
  const sealed=checkSyncRequest({path:'/sync/push',body,auth:'Bearer t'},{token:'t',familyCode:'c',secrets:[]});
  const [o]=await openAll(S,key,sealed);
  assert.equal(o.p.profile.name,'Bo');assert.ok(!JSON.stringify(o.p).includes('Ada'),'no "Ada" in the plaintext: the match is pure ciphertext chance');
  assert.match(rec.ct,RX.ct);
});
