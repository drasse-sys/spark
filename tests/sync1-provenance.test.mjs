import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {read,frontend,backend,environment,request,pairedStorage} from './helpers.mjs';

/* SYNC1 blocker B5 (review-3 F10): the local-copy provenance label survives Trusted Backup export/import, signed and unsigned,
   and carries nothing else. Fixture secrets only; the Worker is the real code evaluated in-process (as in the TR1 tests). */
const SECRET='fixture-export-signing-secret-0123456789-abcdef';
const SERVER='https://spark-family-api.drasse.workers.dev',ORIGIN='https://drasse-sys.github.io';
const ctx=vm.createContext({});vm.runInContext(['arithmetic.js','learning.js','visuals.js'].map(read).join('\n'),ctx);
const L=ctx.SparkLearning,plain=x=>JSON.parse(JSON.stringify(x)),DAY=L.DAY;
const STATE=JSON.stringify({v:1,key:'KEY-NEVER-EXPORTED',gen:'G'.repeat(21)+'A',cursor:3});
async function setup(){
  const b=backend(()=>{throw Error('a backup endpoint must never reach a provider');});
  const {env}=environment({EXPORT_SIGNING_SECRET:SECRET});
  return {b,env,token:await b.api.makeToken(env,'device-1')};
}
function wired(w,{paired=true,storage={}}={}){
  const fetch=async(url,init={})=>{
    const r=await w.b.worker.fetch(new Request(url,{method:init.method,headers:{...init.headers,origin:ORIGIN,'cf-connecting-ip':'192.0.2.1'},body:init.body}),w.env);
    return new Response(await r.text(),{status:r.status,headers:{'content-type':'application/json'}});
  };
  return frontend({storage:{...(paired?{spark_device_token:w.token,spark_device_server:SERVER}:{}),...storage},fetch});
}
const MASTERY="L.event(kid().learning,'add1',{t:Date.now()-40*86400000,s:0,ok:true,k:'task',sid:'s0',id:'a0',verified:true});L.event(kid().learning,'add1',{t:Date.now()-38*86400000,s:0,ok:true,k:'cold',sid:'s1',id:'a1',verified:true,c:'sikker'});";
// A phone holding a stale local copy: it was a family child, then became an unshared copy with a new identity (SYNC1 `detach`).
const STALE=`kid().name='Gammel';kid().age=9;${MASTERY}kid().fork=true;saveKids();`;
const NATIVE=`kid().name='Vanlig';kid().age=9;${MASTERY}saveKids();`;
const SHARED="kid().name='Delt';kid().age=9;kid().id='C'.repeat(21)+'A';kid().sync={v:1,cp:{st:null},log:[],pending:[],seen:['x'.repeat(16)],wm:77};saveKids();";
const close=(...fs)=>fs.forEach(f=>f.dom.window.close());
const FORBIDDEN=['"sync"','"pending"','"seen"','"wm"','"cp"','"cursor"','"gen"','"key"','KEY-NEVER-EXPORTED','CCCCCCCC'];

test('B5: a stale local copy restored from a SIGNED Trusted Backup is still a warned local copy; the file carries only the label',async()=>{
  const w=await setup(),f=wired(w,{storage:{spark_sync:STATE}});f.app.set(STALE);
  const text=await f.app.signedLearningExport(),outer=JSON.parse(text);
  assert.equal(outer.schema,'spark-signed-backup-v1');
  const payload=JSON.parse(outer.payload);
  assert.equal(payload.kids[0].origin,'local-copy');
  for(const m of FORBIDDEN)assert.ok(!text.includes(m),'backup holds no '+m);
  // Restored on a brand-new, unpaired, sync-less phone: the label survives, the authority is the signed one.
  const phone=wired(w,{paired:false}),{status,kids}=await phone.app.readLearningCopy(text,Date.now());
  assert.equal(status,'trusted');assert.equal(kids.length,1);
  assert.equal(kids[0].fork,true,'still a local copy');assert.equal(kids[0].sync,undefined);assert.equal(kids[0].id,undefined);
  assert.equal(L.state(kids[0].learning.skills.add1),L.state(L.normalizeMemory(plain(f.app.state().kids[0].learning)).skills.add1),'the label changed no mastery');
  close(f,phone);
});
test('B5: the same through an UNSIGNED backup (quarantine is unchanged, the label survives)',async()=>{
  const w=await setup(),f=wired(w,{storage:{spark_sync:STATE}});f.app.set(STALE);
  const data=plain(f.app.learningExport());assert.equal(data.kids[0].origin,'local-copy');
  const {status,kids}=await f.app.readLearningCopy(JSON.stringify(data),Date.now());
  assert.equal(status,'unsigned');assert.equal(kids[0].fork,true);
  assert.equal(L.state(kids[0].learning.skills.add1),'ØVER','unsigned history still has no verified authority');
  assert.deepEqual(plain(kids[0].learning.totals),{cold:0,independentCold:0});
  close(f);
});
test('B5: a normal child, and a shared family child, back up and restore as ordinary profiles (no label, no sync internals)',async()=>{
  const w=await setup(),f=wired(w,{storage:{spark_sync:STATE}});
  f.app.set(NATIVE);let data=plain(f.app.learningExport());
  assert.equal('origin' in data.kids[0],false);
  let r=await f.app.readLearningCopy(await f.app.signedLearningExport(),Date.now());assert.equal(r.status,'trusted');assert.equal(r.kids[0].fork,undefined);
  r=await f.app.readLearningCopy(JSON.stringify(data),Date.now());assert.equal(r.kids[0].fork,undefined);
  f.app.set(SHARED);const text=JSON.stringify(f.app.learningExport());
  assert.ok(!text.includes('origin'),'a shared child is not labelled');for(const m of FORBIDDEN)assert.ok(!text.includes(m),m);
  r=await f.app.readLearningCopy(text,Date.now());assert.equal(r.kids[0].fork,undefined);assert.equal(r.kids[0].sync,undefined);assert.equal(r.kids[0].id,undefined);
  close(f);
});
test('B5: old backups (no label) stay compatible; unknown or malformed labels are ignored and cannot add authority',async()=>{
  const w=await setup(),f=wired(w);
  f.app.set(NATIVE);const base=plain(f.app.learningExport());
  const legacy=JSON.parse(JSON.stringify(base));delete legacy.kids[0].origin;
  let r=await f.app.readLearningCopy(JSON.stringify(legacy),Date.now());assert.equal(r.status,'unsigned');assert.equal(r.kids[0].fork,undefined);
  for(const bad of ['family','LOCAL-COPY',true,1,null,{},['local-copy']]){
    const d=JSON.parse(JSON.stringify(base));d.kids[0].origin=bad;
    r=await f.app.readLearningCopy(JSON.stringify(d),Date.now());assert.equal(r.kids[0].fork,undefined,'ignored: '+JSON.stringify(bad));
    assert.ok(!('origin' in r.kids[0]),'the raw label is not stored either');
  }
  // Forged "local-copy" on an ordinary file only makes the restored profile more careful.
  const forged=JSON.parse(JSON.stringify(base));forged.kids[0].origin='local-copy';
  r=await f.app.readLearningCopy(JSON.stringify(forged),Date.now());assert.equal(r.kids[0].fork,true);
  assert.equal(L.state(r.kids[0].learning.skills.add1),'ØVER');
  close(f);
});
test('B5: tampering with the label in a signed backup invalidates the signature (no trusted restore)',async()=>{
  const w=await setup(),f=wired(w,{storage:{spark_sync:STATE}});f.app.set(STALE);
  const outer=JSON.parse(await f.app.signedLearningExport()),payload=JSON.parse(outer.payload);
  delete payload.kids[0].origin;
  const stripped=JSON.stringify({...outer,payload:JSON.stringify(payload)});
  const r=await f.app.readLearningCopy(stripped,Date.now());
  assert.notEqual(r.status,'trusted','stripping the label breaks the digest');
  assert.equal(L.state(r.kids[0].learning.skills.add1),'ØVER','and the history is quarantined');
  close(f);
});
test('B5: an imported local copy is never shared in bulk and needs the explicit, warned choice for a single share',async()=>{
  const w=await setup(),f=wired(w,{storage:{...pairedStorage,spark_sync:STATE}});f.app.set(STALE);
  const {kids}=await f.app.readLearningCopy(JSON.stringify(f.app.learningExport()),Date.now());
  f.app.set(`kids.length=0;kids.push(...${JSON.stringify(plain(kids))});active=0;saveKids();`);
  assert.equal(f.app.state().kids[0].fork,true);
  assert.equal(f.app.set('syncEngineGet().shareAll()'),0,'no bulk share');
  assert.equal(f.app.state().kids[0].sync,undefined);
  // The single share asks first; declining keeps it local, accepting shares it as a new family child.
  f.app.set("view='setup';render();");const d=f.w.document;const asked=[];
  f.w.confirm=t=>{asked.push(t);return false;};
  await d.getElementById('syncShare').onclick({currentTarget:d.getElementById('syncShare')});
  assert.equal(asked.length,1);assert.match(asked[0],/lokal kopi/);assert.match(asked[0],/slettet fra familien/);
  assert.equal(f.app.state().kids[0].sync,undefined,'declined: still not shared');
  close(f);
});
test('B5: a restored profile that is shared explicitly loses the label (it is then an ordinary family child), and a native one never had it',async()=>{
  const w=await setup(),f=wired(w,{storage:{...pairedStorage,spark_sync:STATE}});
  f.app.set(STALE);assert.equal(f.app.set('syncEngineGet().share(kid())'),true);
  assert.equal(f.app.state().kids[0].fork,undefined);assert.ok(f.app.state().kids[0].id);
  f.app.set(NATIVE.replace("kid().name='Vanlig'","kids[0]=blankKid('Vanlig');kid().name='Vanlig'"));
  assert.equal(f.app.state().kids[0].fork,undefined);
  close(f);
});
