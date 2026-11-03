import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {read,frontend,backend,environment,request} from './helpers.mjs';

/* TR1 trusted backup and restore. Fixture secrets only; the Worker code under test is the real one, evaluated in-process. */
const SECRET='fixture-export-signing-secret-0123456789-abcdef',OTHER='fixture-export-signing-secret-other-key-98765432';
const SERVER='https://spark-family-api.drasse.workers.dev',ORIGIN='https://drasse-sys.github.io';
const ctx=vm.createContext({});vm.runInContext(['arithmetic.js','learning.js','visuals.js'].map(read).join('\n'),ctx);
const L=ctx.SparkLearning,plain=x=>JSON.parse(JSON.stringify(x)),DAY=L.DAY;
const b64=bytes=>Buffer.from(bytes).toString('base64url');
const digestOf=async text=>b64(new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));
const rawHmac=async(secret,text)=>b64(new Uint8Array(await webcrypto.subtle.sign('HMAC',await webcrypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']),new TextEncoder().encode(text))));
// Change one character of a canonical base64url value and keep it canonical (the last character is never touched).
const flip=(s,i=10)=>s.slice(0,i)+(s[i]==='A'?'B':'A')+s.slice(i+1);
// Removes exactly one trust check from the evaluated source. A missing target fails loudly instead of passing vacuously.
const cut=(target,replacement)=>source=>{source=source.replace(/\r\n/g,'\n');assert.ok(source.includes(target),'negative-control target missing: '+target);return source.replace(target,replacement);};

// The CF1 quarantine exactly as released in 3120ff3 (learning.js), the reference for "unchanged legacy semantics".
function cf1Quarantine(memory,now){
  for(const r of Object.values(memory.skills)){
    r.imported=[...(r.imported||[]),...r.ev,...r.observations].slice(-L.LIMITS.imported);
    r.ev=[];r.observations=[];r.box=r.box?1:0;r.due=r.box?now:null;
    r.lastAt=null;r.lastSession=null;r.independentAt=null;r.firstColdAt=null;r.retainedAt=null;r.helped='';delete r.seenObs;
  }
  for(const w of memory.items){w.box=1;w.due=now;w.lastAt=null;}
  for(const s of memory.sessions)s.imported=true;
  memory.totals={cold:0,independentCold:0};
  return memory;
}
const quarantined=(learning,now)=>plain(cf1Quarantine(L.normalizeMemory(plain(learning)),now));

async function setup(extra={},patch){
  const b=backend(()=>{throw Error('a backup endpoint must never reach a provider');},patch);
  const {env,calls}=environment({EXPORT_SIGNING_SECRET:SECRET,...extra});
  return {b,env,calls,token:await b.api.makeToken(env,'device-1')};
}
const sign=(w,digest,token=w.token,extra={})=>w.b.worker.fetch(request('/backup/sign',{v:1,digest,...extra},token),w.env);
const verify=(w,signature,extra={})=>w.b.worker.fetch(request('/backup/verify',{v:1,...signature,...extra}),w.env);
async function signed(w,digest){const r=await sign(w,digest);assert.equal(r.status,200);return r.json();}
// A container signed by the real Worker for arbitrary payload text: what a paired device holder can always obtain.
async function container(w,payload){return JSON.stringify({schema:'spark-signed-backup-v1',payload,signature:await signed(w,await digestOf(payload))});}

// A jsdom Spark whose network goes to the in-process Worker. `hook(path)` may replace a reply or throw.
function wired(w,{paired=true,hook,patch}={}){
  const sent=[];
  const fetch=async(url,init={})=>{
    const path=new URL(url).pathname;sent.push({path,origin:new URL(url).origin,redirect:init.redirect,headers:{...init.headers},body:init.body?JSON.parse(init.body):null});
    const replaced=hook&&await hook(path,new URL(url).origin);if(replaced)return replaced;
    const r=await w.b.worker.fetch(new Request(url,{method:init.method,headers:{...init.headers,origin:ORIGIN,'cf-connecting-ip':'192.0.2.1'},body:init.body}),w.env);
    return new Response(await r.text(),{status:r.status,headers:{'content-type':'application/json'}});
  };
  const f=frontend({storage:paired?{spark_device_token:w.token,spark_device_server:SERVER}:{},fetch,patch});
  return {...f,sent};
}
const T0=Date.now()-40*DAY;
// Native mastery earned through the real event path: SITTER on add1 (retained across delayed checks), MED_STØTTE on sub1.
function seedMastery(f){
  f.app.set(`kid().name='Ada';kid().age=9;kid().notes=['pluss: tierramme hjalp'];kid().learning=L.empty();
    L.event(kid().learning,'add1',{t:${T0},s:0,ok:true,k:'task',sid:'s0',id:'a0',verified:true});
    L.event(kid().learning,'add1',{t:${T0+2*DAY},s:0,ok:true,k:'cold',sid:'s1',id:'a1',verified:true,c:'sikker'});
    L.event(kid().learning,'add1',{t:${T0+10*DAY},s:0,ok:true,k:'cold',sid:'s2',id:'a2',verified:true,c:'sikker'});
    L.event(kid().learning,'sub1',{t:${T0+11*DAY},s:2,ok:true,k:'task',sid:'s3',id:'b0',verified:true});
    kid().learning.skills.add1.helped='Tallinje';
    saveWord({word:'hus',meaning:'et sted å bo',sentence:''});
    kid().learning.sessions.push({id:'s2',startedAt:${T0+10*DAY},endedAt:${T0+10*DAY+60000},activeMs:60000,interactions:[],mode:'matte',events:[{skill:'add1',t:${T0+10*DAY},s:0,ok:true,verified:true,k:'cold',delayed:true,id:'a2',sid:'s2',e:'',c:'sikker'}],reflection:'',interventions:0});
    saveKids();`);
  const native=plain(f.app.state().kids[0].learning);
  assert.equal(L.state(native.skills.add1),'SITTER');assert.equal(L.state(native.skills.sub1),'MED_STØTTE');
  return native;
}
// A crafted v3 payload: one profile, chosen add1 record.
function craftedPayload(add1,extra={}){
  return JSON.stringify({schema:'spark-learning-export-v3',createdAt:Date.now(),kids:[{name:'Ny',age:8,interests:'',notes:[],log:[],sessions:[],readAloud:false,
    learning:{version:3,skills:{add1:{ev:[],observations:[],...add1}},items:[],sessions:[],totals:{cold:0,independentCold:0}},...extra}]});
}
const ev=(t,extra={})=>({t,s:0,ok:true,k:'cold',sid:'c'+t,id:'c'+t,verified:true,delayed:true,e:'',c:'sikker',...extra});

/* ---------- Worker protocol ---------- */
test('TR1 1: a paired device gets a signature for a digest, and that exact signature verifies',async()=>{
  const w=await setup(),digest=await digestOf('{"x":1}'),before=Date.now();
  const sig=await signed(w,digest);
  assert.deepEqual(Object.keys(sig).sort(),['digest','digestAlg','kid','mac','protocol','sigAlg','signedAt']);
  assert.equal(sig.protocol,'SPARK-EXPORT-V1');assert.equal(sig.digestAlg,'SHA-256');assert.equal(sig.sigAlg,'HMAC-SHA-256');assert.equal(sig.kid,'k1');
  assert.equal(sig.digest,digest);assert.match(sig.mac,w.b.api.EXPORT_B64_32);assert.ok(sig.signedAt>=before&&sig.signedAt<=Date.now());
  const r=await verify(w,sig);assert.equal(r.status,200);assert.deepEqual(await r.json(),{valid:true});
  // Repeat restores are allowed: verification keeps no one-time state.
  assert.deepEqual(await (await verify(w,sig)).json(),{valid:true});
  assert.ok(w.calls.some(c=>c.name==='CHAT_LIMITER'&&c.key==='backup-sign:device-1'));
  assert.ok(w.calls.some(c=>c.name==='PAIR_GLOBAL_LIMITER'&&c.key==='backup-verify'));
  assert.ok(w.calls.some(c=>c.name==='PAIR_LIMITER'&&c.key==='backup-verify:192.0.2.1'));
  assert.deepEqual(w.b.logs,[]);
});
test('TR1 2-4: a one-byte payload change, a changed digest and a changed signature all fail verification',async()=>{
  const w=await setup(),payload='{"schema":"spark-learning-export-v3","kids":[{"name":"Ada"}]}',sig=await signed(w,await digestOf(payload));
  const mutated=await digestOf(payload.replace('Ada','Adb'));assert.notEqual(mutated,sig.digest);
  for(const bad of [{digest:mutated},{digest:flip(sig.digest)},{mac:flip(sig.mac)},{mac:flip(sig.mac,0)},{mac:'A'.repeat(43)},{signedAt:sig.signedAt+1}]){
    const r=await verify(w,{...sig,...bad});assert.equal(r.status,200,JSON.stringify(bad));assert.deepEqual(await r.json(),{valid:false,reason:'signature'},JSON.stringify(bad));
  }
});
test('TR1 5: a different protocol, algorithm or signing domain never verifies',async()=>{
  const w=await setup(),sig=await signed(w,await digestOf('p'));
  for(const bad of [{protocol:'SPARK-EXPORT-V2'},{digestAlg:'SHA-512'},{sigAlg:'HMAC-SHA-512'}])assert.deepEqual(await (await verify(w,{...sig,...bad})).json(),{valid:false,reason:'signature'});
  // Same key, other domains: the bare digest (device-token style), another protocol label, and an ambiguous concatenation.
  const message=p=>[p,'SHA-256','HMAC-SHA-256',sig.kid,String(sig.signedAt),sig.digest].join('\n');
  for(const text of [sig.digest,message('SPARK-EXPORT-V2'),'SPARK-EXPORT-V1'+sig.digest,message('SPARK-EXPORT-V1')+'\n']){
    assert.deepEqual(await (await verify(w,{...sig,mac:await rawHmac(SECRET,text)})).json(),{valid:false,reason:'signature'},text);
  }
  // The correct domain with the same key does verify, so the cases above fail on the domain alone.
  assert.equal(await rawHmac(SECRET,message('SPARK-EXPORT-V1')),sig.mac);
});
test('TR1 6: a signature made under another key does not verify (isolated key fixture)',async()=>{
  const a=await setup(),b=await setup({EXPORT_SIGNING_SECRET:OTHER});
  const sig=await signed(a,await digestOf('p'));
  assert.deepEqual(await (await verify(b,sig)).json(),{valid:false,reason:'signature'});
  assert.equal(await a.b.api.verifyExport(OTHER,sig.kid,sig.signedAt,sig.digest,sig.mac),false);
  assert.equal(await a.b.api.verifyExport(SECRET,sig.kid,sig.signedAt,sig.digest,sig.mac),true);
});
test('TR1 7: malformed digests, signatures and fields are rejected with 400',async()=>{
  const w=await setup(),sig=await signed(w,await digestOf('p'));
  const badB64=[sig.digest.slice(0,-1)+'B',sig.digest+'A',sig.digest.slice(1),sig.digest+'=','+'+sig.digest.slice(1),'/'+sig.digest.slice(1),'a'.repeat(64),'',42,null,['x']];
  for(const digest of badB64)assert.equal((await sign(w,digest)).status,400,String(digest));
  for(const body of [{v:2},{v:'1'},{extra:'x'},{payload:'{"kids":[]}'}])assert.equal((await sign(w,sig.digest,w.token,body)).status,400,JSON.stringify(body));
  const bad=[...badB64.map(digest=>({digest})),...badB64.map(mac=>({mac})),{signedAt:String(sig.signedAt)},{signedAt:1.5},{signedAt:-1},{signedAt:0},{signedAt:2**60},{kid:7},{kid:'k'.repeat(41)},{protocol:null},{v:2},{extra:1}];
  for(const b of bad)assert.equal((await verify(w,sig,b)).status,400,JSON.stringify(b));
  const missing={...sig};delete missing.mac;assert.equal((await w.b.worker.fetch(request('/backup/verify',{v:1,...missing}),w.env)).status,400);
  for(const raw of ['{','null','[]','"x"'])assert.equal((await w.b.worker.fetch(new Request('https://spark.test/backup/verify',{method:'POST',headers:{origin:ORIGIN},body:raw}),w.env)).status,400,raw);
  // Errors are Spark's own text: no crypto exception, no secret.
  const body=await (await verify(w,sig,{mac:'%%%'})).text();assert.deepEqual(JSON.parse(body),{error:'Ugyldig forespørsel.'});assert.ok(!body.includes(SECRET));
});
test('TR1 8: oversized sign and verify requests are refused by byte count',async()=>{
  const w=await setup(),sig=await signed(w,await digestOf('p'));
  assert.equal((await sign(w,sig.digest,w.token,{pad:'x'.repeat(600)})).status,413);
  assert.equal((await verify(w,sig,{pad:'x'.repeat(2000)})).status,413);
  assert.equal((await w.b.worker.fetch(new Request('https://spark.test/backup/verify',{method:'POST',headers:{origin:ORIGIN,'content-length':'99999'},body:'{}'}),w.env)).status,413);
});
test('TR1 9: signing requires an authenticated paired device; verification does not',async()=>{
  const w=await setup(),digest=await digestOf('p');
  const foreign=await (await setup({DEVICE_SIGNING_SECRET:'another-device-secret'})).token;
  const old=await w.b.api.makeToken(w.env,'old');
  for(const token of ['',null,'garbage','a.b',w.token+'x',foreign]){
    const r=await sign(w,digest,token);assert.equal(r.status,401,String(token));const d=await r.json();assert.ok(!('mac' in d));assert.equal(d.error,'Enheten må kobles til på nytt.');
  }
  assert.equal((await w.b.worker.fetch(request('/backup/sign',{v:1,digest},old),{...w.env,REVOKE_BEFORE:Date.now()+1})).status,401);
  const sig=await signed(w,digest);
  const r=await w.b.worker.fetch(new Request('https://spark.test/backup/verify',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({v:1,...sig})}),w.env);
  assert.deepEqual(await r.json(),{valid:true});
  assert.equal((await w.b.worker.fetch(request('/backup/sign',{v:1,digest},w.token,'https://evil.test'),w.env)).status,403);
  assert.equal((await w.b.worker.fetch(request('/backup/verify',{v:1,...sig},undefined,'https://evil.test'),w.env)).status,403);
});
test('TR1 10: neither endpoint accepts anything but digest and signature fields (no child data can be sent)',async()=>{
  const w=await setup(),sig=await signed(w,await digestOf('p'));
  for(const extra of [{name:'Ada'},{payload:'{}'},{kids:[]},{notes:['x']}]){
    assert.equal((await sign(w,sig.digest,w.token,extra)).status,400);assert.equal((await verify(w,sig,extra)).status,400);
  }
});
test('TR1 fail-closed secret handling: missing, short or reused EXPORT_SIGNING_SECRET never signs or verifies',async()=>{
  const digest=await digestOf('p'),base=await setup(),sig=await signed(base,digest);
  for(const secret of [undefined,'','short-secret',environment().env.DEVICE_SIGNING_SECRET.padEnd(32,'x')]){
    const extra=secret===environment().env.DEVICE_SIGNING_SECRET.padEnd(32,'x')?{DEVICE_SIGNING_SECRET:secret}:{};
    const w=await setup({EXPORT_SIGNING_SECRET:secret,...extra});
    const s=await sign(w,digest);assert.equal(s.status,503,String(secret));assert.deepEqual(await s.json(),{error:'Bekreftede sikkerhetskopier er ikke satt opp på serveren.'});
    assert.equal((await verify(w,sig)).status,503);
  }
  for(const name of ['FAMILY_CODE','GEMINI_API_KEY']){const w=await setup({[name]:SECRET});assert.equal((await sign(w,digest)).status,503,name);}
  const denied=await setup({CHAT_LIMITER:{limit:async()=>({success:false})},PAIR_LIMITER:{limit:async()=>({success:false})}});
  assert.equal((await sign(denied,digest)).status,429);assert.equal((await verify(denied,sig)).status,429);
});
test('TR1 key rotation: current + previous key by id; a retired key reads as "cannot confirm", not "tampered"',async()=>{
  const digest=await digestOf('p'),old=await setup(),oldSig=await signed(old,digest);
  const rotated=await setup({EXPORT_SIGNING_KID:'k2',EXPORT_SIGNING_SECRET:OTHER,EXPORT_PREVIOUS_KID:'k1',EXPORT_PREVIOUS_SECRET:SECRET});
  const newSig=await signed(rotated,digest);assert.equal(newSig.kid,'k2');
  assert.deepEqual(await (await verify(rotated,oldSig)).json(),{valid:true});
  assert.deepEqual(await (await verify(rotated,newSig)).json(),{valid:true});
  // A key id must name the secret that signed: k1's signature presented as k2 fails.
  assert.deepEqual(await (await verify(rotated,{...oldSig,kid:'k2'})).json(),{valid:false,reason:'signature'});
  const retired=await setup({EXPORT_SIGNING_KID:'k2',EXPORT_SIGNING_SECRET:OTHER});
  assert.deepEqual(await (await verify(retired,oldSig)).json(),{valid:false,reason:'key'});
  // Rotation that kept the id: the previous key with the same kid still verifies old backups.
  const sameKid=await setup({EXPORT_SIGNING_SECRET:OTHER,EXPORT_PREVIOUS_KID:'k1',EXPORT_PREVIOUS_SECRET:SECRET});
  assert.deepEqual(await (await verify(sameKid,oldSig)).json(),{valid:true});assert.equal((await signed(sameKid,digest)).kid,'k1');
  // Current secret unusable: never falls back to signing with the previous key.
  assert.equal((await sign(await setup({EXPORT_SIGNING_SECRET:'short',EXPORT_PREVIOUS_KID:'k1',EXPORT_PREVIOUS_SECRET:SECRET}),digest)).status,503);
  const f=wired(retired);const g=wired(old);seedMastery(g);const text=await g.app.signedLearningExport();
  assert.equal((await f.app.readLearningCopy(text)).status,'retired');
  f.dom.window.close();g.dom.window.close();
});

/* ---------- Client restore semantics ---------- */
test('TR1 11: a valid signed export restores exactly the native authority on a new, unpaired phone',async()=>{
  const w=await setup(),f=wired(w),native=seedMastery(f);
  const text=await f.app.signedLearningExport();
  const phone=wired(w,{paired:false}),now=Date.now();
  const {status,kids}=await phone.app.readLearningCopy(text,now);
  assert.equal(status,'trusted');assert.equal(kids.length,1);
  const m=plain(kids[0].learning);
  assert.deepEqual(m,plain(L.normalizeMemory(native)));
  assert.equal(L.state(m.skills.add1),'SITTER');assert.equal(L.state(m.skills.sub1),'MED_STØTTE');
  assert.ok(m.skills.add1.retainedAt&&m.skills.add1.independentAt&&m.skills.add1.box>=2);assert.equal(m.skills.add1.helped,'Tallinje');
  assert.deepEqual(m.totals,{cold:2,independentCold:2});assert.ok(m.sessions.every(s=>!s.imported));assert.ok(!m.skills.add1.imported);
  assert.equal(kids[0].name,'Ada');assert.deepEqual(plain(kids[0].notes),['pluss: tierramme hjalp']);
  // The restore phone sent one verify request, to the build's Worker, without credentials.
  assert.deepEqual(phone.sent.map(s=>s.path+' '+s.origin),['/backup/verify '+SERVER]);assert.ok(!('authorization' in phone.sent[0].headers));
  f.dom.window.close();phone.dom.window.close();
});
test('TR1 12: an unsigned export quarantines exactly as the CF1 release did',async()=>{
  const w=await setup(),f=wired(w),native=seedMastery(f),now=Date.now();
  const data=plain(f.app.learningExport());
  const {status,kids}=await f.app.readLearningCopy(JSON.stringify(data),now);
  assert.equal(status,'unsigned');assert.deepEqual(plain(kids[0].learning),quarantined(native,now));
  assert.deepEqual(plain(kids[0].learning),plain(f.app.validateImport(data,now)[0].learning));
  assert.equal(L.state(kids[0].learning.skills.add1),'ØVER');assert.equal(f.sent.length,0);
  // The refactored quarantine is the CF1 function, on native and on crafted memories.
  const crafted={version:3,skills:{add1:{ev:[ev(T0),ev(T0+2*DAY)],observations:[ev(T0+DAY,{verified:false})],box:5,due:T0+400*DAY,independentAt:T0,firstColdAt:T0+2*DAY,retainedAt:T0+10*DAY,helped:'Tallinje',seenObs:'c'+(T0+DAY),imported:[ev(T0-DAY)]}},items:[{id:'w',word:'hus',meaning:'x',box:5,due:T0+400*DAY,lastAt:T0,ev:[]}],sessions:[{id:'o',startedAt:T0,events:[]}],totals:{cold:9,independentCold:9}};
  for(const memory of [native,crafted])assert.deepEqual(plain(L.quarantine(L.normalizeMemory(plain(memory)),now)),quarantined(memory,now));
  f.dom.window.close();
});
test('TR1 13: legacy CF1-era files keep CF1 behaviour; unknown schemas are still refused',async()=>{
  const w=await setup(),f=wired(w),now=Date.now();
  const legacy={schema:'spark-learning-export-v3',createdAt:T0,kids:[{name:'A',age:8,interests:'',notes:[],log:[],sessions:[],readAloud:false,learning:{version:3,skills:{add1:{ev:[ev(T0,{k:'task',delayed:false}),ev(T0+2*DAY),ev(T0+10*DAY)],box:5,due:T0+400*DAY,independentAt:T0,firstColdAt:T0+2*DAY,retainedAt:T0+10*DAY}},items:[],sessions:[],totals:{cold:2,independentCold:2}}}]};
  const {status,kids}=await f.app.readLearningCopy(JSON.stringify(legacy),now);
  assert.equal(status,'unsigned');assert.deepEqual(plain(kids[0].learning),quarantined(legacy.kids[0].learning,now));assert.equal(L.state(kids[0].learning.skills.add1),'ØVER');
  for(const text of ['{"schema":"spark-learning-export-v2","kids":[]}','not json','{"schema":"spark-signed-backup-v1","payload":{"kids":[]}}','{"schema":"spark-signed-backup-v1","payload":"not json"}']){
    await assert.rejects(f.app.readLearningCopy(text,now),/Ukjent format/,text);
  }
  assert.equal(f.sent.length,0);f.dom.window.close();
});
test('TR1 14: a tampered or invalid-signature copy cannot preserve mastery',async()=>{
  const w=await setup(),f=wired(w),native=seedMastery(f),now=Date.now();
  const text=await f.app.signedLearningExport(),file=JSON.parse(text);
  // Edited payload, original envelope: caught locally, before any request.
  const edited={...file,payload:file.payload.replace('"Ada"','"Adb"')};
  const phone=wired(w,{});let r=await phone.app.readLearningCopy(JSON.stringify(edited),now);
  assert.equal(r.status,'invalid');assert.equal(phone.sent.length,0);assert.deepEqual(plain(r.kids[0].learning),quarantined(native,now));
  // Edited payload with its digest recomputed: the Worker refuses the MAC.
  const redigested={...edited,signature:{...file.signature,digest:await digestOf(edited.payload)}};
  r=await phone.app.readLearningCopy(JSON.stringify(redigested),now);assert.equal(r.status,'invalid');assert.equal(L.state(r.kids[0].learning.skills.add1),'ØVER');
  // Forged MAC, other fields, extra container field, surrogate-ambiguous payload.
  for(const bad of [{signature:{...file.signature,mac:flip(file.signature.mac)}},{signature:{...file.signature,signedAt:file.signature.signedAt-1}},{signature:{...file.signature,kid:'k9'}},{signature:{...file.signature,extra:1}},{signature:null},{note:'x'}]){
    r=await phone.app.readLearningCopy(JSON.stringify({...file,...bad}),now);
    assert.notEqual(r.status,'trusted',JSON.stringify(bad));assert.deepEqual(plain(r.kids[0].learning),quarantined(native,now),JSON.stringify(bad));
  }
  const lone=file.payload.replace('"Ada"','"Ad\uD800"');assert.equal(await phone.app.exportDigest(lone),'');
  r=await phone.app.readLearningCopy(JSON.stringify({...file,payload:lone}),now);assert.equal(r.status,'invalid');
  f.dom.window.close();phone.dom.window.close();
});
test('TR1 15: verification unavailable, offline or ambiguous never preserves mastery',async()=>{
  const w=await setup(),f=wired(w),native=seedMastery(f),now=Date.now(),text=await f.app.signedLearningExport();
  const replies=[()=>{throw new TypeError('Failed to fetch');},()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});},
    ()=>new Response('<html>502</html>',{status:502}),()=>Response.json({error:'x'},{status:503}),()=>Response.json({valid:true},{status:429}),
    ()=>Response.json({valid:'true'}),()=>Response.json({valid:1}),()=>Response.json({valid:true,extra:1}),()=>new Response('null'),()=>Response.json([true]),
    ()=>Response.json({valid:false,reason:'key'}),()=>Response.json({valid:false}),()=>Response.json({valid:true},{status:201})];
  for(const reply of replies){
    const phone=wired(w,{hook:async path=>path==='/backup/verify'?reply():undefined});
    const r=await phone.app.readLearningCopy(text,now);
    assert.notEqual(r.status,'trusted',String(reply));assert.deepEqual(plain(r.kids[0].learning),quarantined(native,now));phone.dom.window.close();
  }
  // Server without the secret; and a ⚙️ address elsewhere, which verification ignores.
  const unset=wired({...w,env:{...w.env,EXPORT_SIGNING_SECRET:undefined}},{});assert.equal((await unset.app.readLearningCopy(text,now)).status,'unavailable');
  const local=wired(w,{});local.app.set("serverUrl='http://example.test'");assert.equal((await local.app.readLearningCopy(text,now)).status,'trusted');assert.deepEqual(local.sent.map(s=>s.origin),[SERVER]);
  f.dom.window.close();unset.dom.window.close();local.dom.window.close();
});
test('TR1 16: a valid signature never bypasses schema, structure, bounds, timestamp or limit validation',async()=>{
  const w=await setup(),phone=wired(w,{}),now=Date.now();
  const refused=[[craftedPayload({ev:[ev(T0)]}).replace('"add1"','"hacking"'),/Ukjent ferdighet/],[craftedPayload({ev:[ev(T0,{sid:''})]}),/Ugyldig læringshendelse/],[craftedPayload({ev:[ev(T0)]},{age:99}),/Ugyldig profil/],[craftedPayload({ev:[ev(T0)]}).replace('"version":3','"version":4'),/Ugyldig profil/],
    [craftedPayload({ev:[]}).replace('spark-learning-export-v3','spark-learning-export-v2'),/Ukjent format/],[JSON.stringify({schema:'spark-learning-export-v3',kids:Array(21).fill(JSON.parse(craftedPayload({ev:[]})).kids[0])}),/Ukjent format/],
    [craftedPayload({ev:'x'}),/Ukjent ferdighet/]];
  for(const [payload,error] of refused)await assert.rejects(phone.app.readLearningCopy(await container(w,payload),now),error,payload.slice(0,80));
  const restore=async(add1,extra)=>{const r=await phone.app.readLearningCopy(await container(w,craftedPayload(add1,extra)),now);assert.equal(r.status,'trusted');return r.kids[0];};
  // Out-of-range values are normalized exactly as native load does; an out-of-range event is dropped, not promoted.
  assert.ok(!('add1' in (await restore({ev:[ev(T0,{s:9})]})).learning.skills));
  let k=await restore({ev:[ev(T0,{k:'task',delayed:false})],box:99,due:T0,helped:'<script>',admin:true});
  assert.equal(k.learning.skills.add1.box,0);assert.equal(k.learning.skills.add1.due,null);assert.equal(k.learning.skills.add1.helped,'');assert.ok(!('admin' in k.learning.skills.add1));
  // Authority without the verified evidence `event` always leaves: quarantined, history kept.
  for(const add1 of [{retainedAt:T0,independentAt:T0,box:5,due:T0,imported:[ev(T0)]},{box:5,due:T0,imported:[ev(T0)]},{ev:[ev(T0,{k:'task',delayed:false})],retainedAt:T0+9*DAY}]){
    k=await restore(add1);const r=k.learning.skills.add1;assert.equal(r.retainedAt,null,JSON.stringify(add1));assert.ok(r.box<=1);assert.notEqual(L.state(r),'SITTER');assert.ok(r.imported.length>=1);
  }
  // Evidence claimed after the Worker's signing time (+1 day): quarantined, never authority.
  k=await restore({ev:[ev(now+5*DAY,{k:'task',delayed:false}),ev(now+7*DAY),ev(now+15*DAY)],box:3,due:now+20*DAY,independentAt:now+5*DAY,firstColdAt:now+7*DAY,retainedAt:now+15*DAY});
  assert.equal(L.state(k.learning.skills.add1),'ØVER');assert.equal(k.learning.skills.add1.retainedAt,null);assert.equal(k.learning.skills.add1.imported.length,3);
  // History the file already marks as imported is never promoted to evidence; totals stay bounded.
  k=await restore({imported:[ev(T0),ev(T0+2*DAY),ev(T0+10*DAY)]});assert.equal(k.learning.skills.add1.ev.length,0);assert.equal(L.state(k.learning.skills.add1),'ØVER');
  const totals=JSON.parse(craftedPayload({ev:[ev(T0,{k:'task',delayed:false})]}));totals.kids[0].learning.totals={cold:5,independentCold:9};
  k=(await phone.app.readLearningCopy(await container(w,JSON.stringify(totals)),now)).kids[0];assert.deepEqual(plain(k.learning.totals),{cold:5,independentCold:5});
  // Credit with no surviving evidence restarts; a reviewed word box needs review evidence; signed observations are replayed too.
  const orphan=JSON.parse(craftedPayload({box:5,due:T0,imported:[ev(T0)]}));orphan.kids[0].learning.totals={cold:9,independentCold:9};
  orphan.kids[0].learning.items=[{id:'w',word:'hus',meaning:'x',box:5,due:now+DAY,lastAt:T0,ev:[]},{id:'v',word:'tre',meaning:'y',box:3,due:now+DAY,lastAt:T0,ev:[{t:T0,s:0,ok:true,delayed:true}]}];
  k=(await phone.app.readLearningCopy(await container(w,JSON.stringify(orphan)),now)).kids[0];
  assert.deepEqual(plain(k.learning.totals),{cold:0,independentCold:0});assert.equal(k.learning.items[0].box,1);assert.equal(k.learning.items[1].box,3);
  await assert.rejects(phone.app.readLearningCopy(await container(w,craftedPayload({ev:[ev(T0)],observations:[ev(T0+DAY,{verified:true,sid:''})]})),now),/Ugyldig læringshendelse/);
  phone.dom.window.close();
});
test('TR1 17: neither the signed nor the fallback backup carries pairing, device, provider or Worker secrets',async()=>{
  const w=await setup(),f=wired(w);seedMastery(f);f.w.localStorage.setItem('spark_server_url',SERVER);
  const signedText=await f.app.signedLearningExport(),unsignedText=JSON.stringify(f.app.learningExport());
  const file=JSON.parse(signedText);
  assert.deepEqual(Object.keys(file).sort(),['payload','schema','signature']);assert.ok(f.app.validSignature(file.signature));
  for(const text of [signedText,unsignedText]){
    for(const secret of [w.token,w.token.split('.')[1],SECRET,w.env.DEVICE_SIGNING_SECRET,w.env.FAMILY_CODE,w.env.GEMINI_API_KEY,'spark_device_token','spark_device_server','spark_server_url','authorization','Bearer',SERVER])assert.ok(!text.includes(secret),secret);
  }
  // The sign request carried the digest only.
  const signReq=f.sent.find(s=>s.path==='/backup/sign');assert.deepEqual(Object.keys(signReq.body).sort(),['digest','v']);assert.ok(!JSON.stringify(signReq.body).includes('Ada'));
  f.dom.window.close();
});
test('TR1 18: the import control commits nothing before the trust decision and the parent choice; a failed save rolls back',async()=>{
  const w=await setup(),src=wired(w);seedMastery(src);const text=await src.app.signedLearningExport();src.dom.window.close();
  let release;const gate=new Promise(r=>release=r);
  const f=wired(w,{hook:async path=>{if(path==='/backup/verify')await gate;}});
  const confirms=[];let answer=false;f.w.confirm=m=>{confirms.push(m);return answer;};
  f.app.set("view='setup'");f.app.render();
  const input=()=>{const el=f.w.document.getElementById('importLearning');Object.defineProperty(el,'files',{value:[{size:text.length,text:async()=>text}],configurable:true});return el;};
  const snapshot=()=>[f.w.localStorage.getItem('spark_kids'),f.app.state().kids.length];const before=snapshot();
  const pending=input().onchange({target:input()});
  for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
  assert.deepEqual(snapshot(),before);assert.equal(confirms.length,0);
  release();await pending;
  assert.equal(confirms.length,1);assert.ok(confirms[0].startsWith('Denne sikkerhetskopien er bekreftet av Spark.'));assert.deepEqual(snapshot(),before);
  answer=true;await input().onchange({target:input()});
  assert.equal(f.app.state().kids.length,before[1]+1);assert.equal(L.state(f.app.state().kids.at(-1).learning.skills.add1),'SITTER');
  assert.equal(JSON.parse(f.w.localStorage.getItem('spark_kids')).length,before[1]+1);
  // Storage failure: in-memory profiles roll back, the parent is told.
  const saved=snapshot();f.w.Storage.prototype.setItem=()=>{throw Error('QuotaExceededError');};
  await input().onchange({target:input()});assert.equal(f.app.state().kids.length,saved[1]);assert.ok(f.alerts.at(-1).includes('Lagringen er full'));
  // A refused file never reaches the parent prompt.
  const bad=f.w.document.getElementById('importLearning');Object.defineProperty(bad,'files',{value:[{size:10,text:async()=>'{"schema":"x"}'}],configurable:true});
  const n=confirms.length;await bad.onchange({target:bad});assert.equal(confirms.length,n);assert.equal(f.app.state().kids.length,saved[1]);
  f.dom.window.close();
});
test('TR1 UX: distinguishable restore messages; the export falls back to a clearly unconfirmed copy',async()=>{
  const w=await setup(),f=wired(w);seedMastery(f);
  assert.ok(f.app.RESTORE_TEXT.trusted(1).startsWith('Denne sikkerhetskopien er bekreftet av Spark.'));
  assert.ok(f.app.RESTORE_TEXT.unsigned(1).includes('ikke bekreftet av Spark'));
  assert.ok(f.app.RESTORE_TEXT.invalid(1).startsWith('Advarsel:'));
  assert.ok(f.app.RESTORE_TEXT.unavailable(1).includes('kunne ikke bekrefte'));
  assert.ok(f.app.RESTORE_TEXT.retired(1).includes('nøkkelen er byttet ut'));
  assert.equal(new Set(['trusted','unsigned','invalid','unavailable','retired'].map(k=>f.app.RESTORE_TEXT[k](1))).size,5);
  // Export: signing refused (no secret) asks before a history-only copy; declining downloads nothing.
  const off=wired({...w,env:{...w.env,EXPORT_SIGNING_SECRET:''}});seedMastery(off);off.app.set("view='setup'");off.app.render();
  const downloads=[];off.w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:x';};off.w.URL.revokeObjectURL=()=>{};
  const asked=[];off.w.confirm=m=>{asked.push(m);return false;};
  await off.w.document.getElementById('exportLearning').onclick({currentTarget:off.w.document.getElementById('exportLearning')});
  assert.equal(asked.length,1);assert.ok(asked[0].includes('ubekreftet'));assert.equal(downloads.length,0);
  off.w.confirm=()=>true;await off.w.document.getElementById('exportLearning').onclick({currentTarget:off.w.document.getElementById('exportLearning')});
  assert.equal(downloads.length,1);assert.equal(JSON.parse(await downloads[0].text()).schema,'spark-learning-export-v3');
  f.dom.window.close();off.dom.window.close();
});

// A hand-written file with retained mastery that nobody signed: correct digest, made-up MAC.
async function unsignedForgery(now){
  const file={schema:'spark-signed-backup-v1',payload:craftedPayload({ev:[ev(T0,{k:'task',delayed:false}),ev(T0+2*DAY),ev(T0+10*DAY)],box:3,due:T0+20*DAY,independentAt:T0,firstColdAt:T0+2*DAY,retainedAt:T0+10*DAY}),signature:{protocol:'SPARK-EXPORT-V1',digestAlg:'SHA-256',sigAlg:'HMAC-SHA-256',kid:'k1',signedAt:now,digest:'',mac:'A'.repeat(43)}};
  file.signature.digest=await digestOf(file.payload);return JSON.stringify(file);
}
// The phone is re-pointed in ⚙️ and paired with a server that hands out a token and confirms everything.
const EVIL='https://evil.example',evilYes=async(path,origin)=>origin===EVIL?(path==='/pair'?Response.json({token:'evil'}):Response.json({valid:true})):undefined;
const pairEvil=p=>p.app.set(`serverUrl='${EVIL}';tokenServer='${EVIL}';deviceToken='evil'`);
test('TR1 trust root: only the build\'s Worker confirms, never a server chosen or paired in settings',async()=>{
  const w=await setup(),src=wired(w),native=seedMastery(src),text=await src.app.signedLearningExport(),now=Date.now();
  // New phone, never paired: restores trusted before pairing, by asking the build's Worker without credentials.
  const fresh=wired(w,{paired:false});let r=await fresh.app.readLearningCopy(text,now);
  assert.equal(r.status,'trusted');assert.deepEqual(plain(r.kids[0].learning),plain(L.normalizeMemory(native)));
  assert.deepEqual(fresh.sent.map(s=>[s.path,s.origin,s.redirect]),[['/backup/verify',SERVER,'error']]);
  // Phone paired with a server that always says yes: a forged file still goes to the build's Worker, which refuses it.
  const evil=wired(w,{hook:evilYes});pairEvil(evil);
  r=await evil.app.readLearningCopy(await unsignedForgery(now),now);
  assert.equal(r.status,'invalid');assert.notEqual(L.state(r.kids[0].learning.skills.add1),'SITTER');
  assert.ok(evil.sent.every(s=>s.origin===SERVER));
  // ...and a genuine file still restores, and that phone cannot mint a "confirmed" file through its own server.
  assert.equal((await evil.app.readLearningCopy(text,now)).status,'trusted');
  await assert.rejects(evil.app.signedLearningExport());assert.ok(evil.sent.every(s=>s.origin===SERVER&&s.path==='/backup/verify'));
  // A signature from another Worker key never verifies at the build's Worker.
  const other=await setup({EXPORT_SIGNING_SECRET:OTHER}),foreignSrc=wired(other);seedMastery(foreignSrc);
  r=await fresh.app.readLearningCopy(await foreignSrc.app.signedLearningExport(),now);assert.equal(r.status,'invalid');
  for(const p of [src,fresh,evil,foreignSrc])p.dom.window.close();
});

/* ---------- Negative controls: each trust check above is load-bearing ---------- */
test('TR1 NC: without the MAC comparison a forged signature would verify',async()=>{
  const w=await setup({},cut("return crypto.subtle.verify('HMAC',await exportKey(secret,'verify'),unb64url(mac),exportMessage(kid,signedAt,digest));",'return true;'));
  const sig=await signed(w,await digestOf('p'));assert.deepEqual(await (await verify(w,{...sig,mac:flip(sig.mac)})).json(),{valid:true});
});
test('TR1 NC: without domain separation a same-key MAC over the bare digest would verify',async()=>{
  const w=await setup({},cut("[EXPORT_PROTOCOL,EXPORT_DIGEST_ALG,EXPORT_SIG_ALG,kid,String(signedAt),digest].join('\\n')",'digest'));
  const sig=await signed(w,await digestOf('p'));assert.deepEqual(await (await verify(w,{...sig,mac:await rawHmac(SECRET,sig.digest)})).json(),{valid:true});
});
test('TR1 NC: without the device check anyone could obtain signatures',async()=>{
  const w=await setup({},cut("const device=await verifyToken(env,(request.headers.get('authorization')||'').replace(/^Bearer\\s+/i,''));","const device={deviceId:'anyone'};"));
  assert.equal((await sign(w,await digestOf('p'),'')).status,200);
});
test('TR1 NC: without the local digest comparison an edited payload would restore as trusted mastery',async()=>{
  const w=await setup(),src=wired(w);seedMastery(src);const file=JSON.parse(await src.app.signedLearningExport());
  // Manufacture mastery: sub1 claims retention it never had.
  const learning=JSON.parse(file.payload);learning.kids[0].learning.skills.sub1.retainedAt=T0+30*DAY;learning.kids[0].learning.skills.sub1.independentAt=T0;
  const forged=JSON.stringify({...file,payload:JSON.stringify(learning)});
  const safe=wired(w,{});assert.equal((await safe.app.readLearningCopy(forged)).status,'invalid');
  const broken=wired(w,{patch:cut('if(digest&&digest===data.signature.digest)status=await verifyBackup(data.signature,digest);','status=await verifyBackup(data.signature,data.signature.digest);')});
  const r=await broken.app.readLearningCopy(forged);assert.equal(r.status,'trusted');assert.equal(r.kids[0].learning.skills.sub1.retainedAt,T0+30*DAY);
  src.dom.window.close();safe.dom.window.close();broken.dom.window.close();
});
test('TR1 NC: a loose reply check would trust an ambiguous verifier reply',async()=>{
  const w=await setup(),src=wired(w);seedMastery(src);const text=await src.app.signedLearningExport();
  const ambiguous=async path=>path==='/backup/verify'?Response.json({valid:'true'},{status:500}):undefined;
  const safe=wired(w,{hook:ambiguous});assert.equal((await safe.app.readLearningCopy(text)).status,'unavailable');
  const broken=wired(w,{hook:ambiguous,patch:cut("if(r.status===200&&exactKeys(d,['valid'])&&d.valid===true)return 'trusted';","if(d&&d.valid)return 'trusted';")});
  const r=await broken.app.readLearningCopy(text);assert.equal(r.status,'trusted');assert.equal(L.state(r.kids[0].learning.skills.add1),'SITTER');
  src.dom.window.close();safe.dom.window.close();broken.dom.window.close();
});
test('TR1 NC: a settings-chosen verifier (the paired server) would confirm a forged file',async()=>{
  const w=await setup(),now=Date.now(),text=await unsignedForgery(now);
  const safe=wired(w,{hook:evilYes});pairEvil(safe);assert.equal((await safe.app.readLearningCopy(text,now)).status,'invalid');
  const broken=wired(w,{hook:evilYes,patch:cut('const backupServer=()=>DEFAULT_SERVER_URL;','const backupServer=()=>serverUrl;')});pairEvil(broken);
  const r=await broken.app.readLearningCopy(text,now);assert.equal(r.status,'trusted');assert.equal(L.state(r.kids[0].learning.skills.add1),'SITTER');assert.equal(broken.sent[0].origin,EVIL);
  safe.dom.window.close();broken.dom.window.close();
});
test('TR1 NC: ignoring the verification result would restore mastery from a forged signature',async()=>{
  const w=await setup(),src=wired(w);seedMastery(src);const file=JSON.parse(await src.app.signedLearningExport());
  const forged=JSON.stringify({...file,signature:{...file.signature,mac:flip(file.signature.mac)}});
  const broken=wired(w,{patch:cut("status==='trusted'?{signedAt:data.signature.signedAt}:null","{signedAt:data.signature.signedAt}")});
  const r=await broken.app.readLearningCopy(forged);assert.equal(r.status,'invalid');assert.equal(L.state(r.kids[0].learning.skills.add1),'SITTER');
  src.dom.window.close();broken.dom.window.close();
});
test('TR1 NC: skipping normalization or the trust invariants would admit impossible signed state',async()=>{
  const w=await setup(),now=Date.now();
  const raw=wired(w,{patch:cut('L.trust(L.normalizeMemory(k.learning),trusted.signedAt,now)','L.trust(k.learning,trusted.signedAt,now)')});
  let r=await raw.app.readLearningCopy(await container(w,craftedPayload({ev:[ev(T0,{k:'task',delayed:false})],box:99,due:T0,lastAt:T0,independentAt:null,firstColdAt:null,retainedAt:null,admin:true})),now);
  assert.equal(r.kids[0].learning.skills.add1.box,99);assert.equal(r.kids[0].learning.skills.add1.admin,true);
  const loose=wired(w,{patch:cut('if(!times.every(ok)||!dueOk(r.due)||!consistent)quarantineSkill(r,now);','')});
  r=await loose.app.readLearningCopy(await container(w,craftedPayload({ev:[ev(now+5*DAY,{k:'task',delayed:false}),ev(now+7*DAY),ev(now+15*DAY)],box:3,due:now+20*DAY,independentAt:now+5*DAY,firstColdAt:now+7*DAY,retainedAt:now+15*DAY})),now);
  assert.equal(L.state(r.kids[0].learning.skills.add1),'SITTER');
  raw.dom.window.close();loose.dom.window.close();
});
