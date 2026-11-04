// Real Chromium SYNC1 acceptance with independent browser profiles (one context per phone, own localStorage).
// Requests to the build's Worker URL are answered by the real Worker code in-process, bound to a REAL local D1 database
// (workerd via wrangler getPlatformProxy, in memory). Fixture secrets only; no production API is contacted.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import {backend,environment} from './helpers.mjs';
import {localD1} from './sync-helpers.mjs';
const require=createRequire(process.env.SPARK_TEST_MODULE_ROOT||import.meta.url);
const {chromium}=require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=resolve(root,'tests/artifacts');await mkdir(artifacts,{recursive:true});
const SERVER='https://spark-family-api.drasse.workers.dev',SECRET='fixture-browser-export-secret-0123456789abcdef';
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'');const file=resolve(root,path||'index.html');if(!file.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}try{const data=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html; charset=utf-8':'application/json','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const {db,dispose}=await localD1();
const worker=backend(()=>{throw Error('sync must never reach a provider');});
const {env}=environment({ALLOWED_ORIGINS:origin,SYNC_ENABLED:'1',SYNC_DB:db,EXPORT_SIGNING_SECRET:SECRET});
const bodies=[];
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const errors=[];
  async function phone(label){
    const token=await worker.api.makeToken(env,webcrypto.randomUUID());
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
    await context.addInitScript(t=>{if(!localStorage.getItem('spark_device_token')){localStorage.setItem('spark_device_token',t);localStorage.setItem('spark_device_server','https://spark-family-api.drasse.workers.dev');localStorage.setItem('spark_sync_lab','1');}},token);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(label+': '+e.message));
    const p={label,context,page,token,offline:false,dialogs:[]};
    page.on('dialog',d=>{p.dialogs.push(d.message());d.accept();});
    await page.route(SERVER+'/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(p.offline)return route.abort('internetdisconnected');
      if(req.method()!=='OPTIONS'&&path.startsWith('/sync/'))bodies.push({label,path,body:req.postData()||'',auth:req.headers().authorization||''});
      const r=await worker.worker.fetch(new Request(req.url(),{method:req.method(),headers:{...req.headers(),origin,'cf-connecting-ip':'192.0.2.7'},body:['GET','OPTIONS'].includes(req.method())?undefined:req.postData()}),env);
      return route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});
    });
    await page.goto(origin+'/spark/spark.html');
    return p;
  }
  const settings=async p=>{if(!await p.page.locator('#syncSection').count())await p.page.locator('#cogBtn').click();await p.page.locator('#syncSection').waitFor();};
  const idle=p=>p.page.waitForFunction(()=>!busy);
  const sync=p=>p.page.evaluate(()=>syncEngineGet().sync().then(r=>JSON.stringify(r)));
  // Converged view: every shared child as the app holds it after a load, without fields that never sync.
  const view=p=>p.page.evaluate(()=>JSON.stringify(kids.filter(k=>k.sync).map(k=>{const m=L.normalizeMemory(JSON.parse(JSON.stringify(k.learning)));const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(x=>[x,c(v[x])])):v;return c({id:k.id,name:k.name,age:k.age,interests:k.interests,learning:{...m,items:m.items.map(w=>({...w,sentence:''})),sessions:m.sessions.map(s=>({...s,interactions:[]}))}});}).sort((a,b)=>a.id<b.id?-1:1)));
  const statusText=p=>p.page.locator('#syncStatus').textContent();
  // A real practice round in the UI: «Gangetabell», answer the first item correctly, finish.
  async function practiseTimes(p){
    await p.page.locator('#saveBtn').count()&&await p.page.evaluate(()=>{view='start';render();});
    await p.page.locator('.practice > summary').click();await p.page.locator('#timesStart').click();
    await p.page.locator('#msg').fill(await p.page.evaluate(()=>learningSession.check.item.answer));await p.page.locator('#sendBtn').click();
    await p.page.locator('#doneBtn').click();await p.page.waitForFunction(()=>view!=='chat');
  }

  // 1. Phone A: existing local child with learning (pre-sync state), starts family sync through the UI.
  const A=await phone('A');
  await A.page.evaluate(()=>{kid().name='Ada';kid().age=9;L.event(kid().learning,'add1',{t:Date.now()-3*L.DAY,s:0,ok:true,k:'task',sid:'pre',id:'pre1',verified:true});saveWord({word:'hus',meaning:'et sted å bo',sentence:'Ola så et hus.'});saveKids();render();});
  await settings(A);await A.page.locator('#syncCode').fill(env.FAMILY_CODE);await A.page.locator('#syncCreate').click();await idle(A);
  const key=A.dialogs.find(m=>m.startsWith('Synkroniseringsnøkkel:')).split('\n')[1];
  assert.match(key,/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(await A.page.evaluate(()=>!!kid().sync&&kid().sync.pending.length),0,'base sent');
  assert.match(await statusText(A),/Synkronisert/);

  // 2. Phone B: joins with the key; its empty starter profile is replaced by Ada.
  const B=await phone('B');await settings(B);await B.page.locator('#syncKeyIn').fill(key.toLowerCase().replace(/-/g,' '));await B.page.locator('#syncJoin').click();await idle(B);
  assert.deepEqual(await B.page.evaluate(()=>kids.map(k=>k.name)),['Ada']);
  assert.equal(await view(A),await view(B));
  assert.equal(await B.page.evaluate(()=>kid().learning.items[0].sentence),'','the example sentence stayed on A');
  await A.page.locator('#syncSection').screenshot({path:resolve(artifacts,'sync1-settings.png')});

  // 3. Both offline; each phone does real practice in the UI; homework stays usable offline.
  A.offline=B.offline=true;
  for(const p of [A,B]){await p.page.evaluate(()=>{view='start';render();});await practiseTimes(p);}
  await B.page.locator('.practice > summary').click();await B.page.locator('.practice details summary').click();await B.page.locator('#wordList').fill('tre | et tre');await B.page.locator('#saveWords').click();
  const pendingA=await A.page.evaluate(()=>kid().sync.pending.length),pendingB=await B.page.evaluate(()=>kid().sync.pending.length);
  assert.ok(pendingA>=2&&pendingB>=3,'changes queued while offline: '+pendingA+'/'+pendingB);
  assert.notEqual(await view(A),await view(B));

  // 4. A reconnects (the 'online' event starts a background round), then B, then A again: both converge.
  A.offline=false;await A.page.evaluate(()=>dispatchEvent(new Event('online')));
  await A.page.waitForFunction(()=>kid().sync.pending.length===0&&syncEngineGet().state().status==='ok',null,{timeout:15000});
  B.offline=false;assert.equal(await sync(B),'{"ok":true}');assert.equal(await sync(A),'{"ok":true}');
  const converged=await view(A);assert.equal(converged,await view(B));
  const ada=JSON.parse(converged)[0];
  assert.ok(ada.learning.skills.times2510.ev.length>=2,'practice from both phones');assert.equal(ada.learning.items.length,2);assert.equal(ada.learning.sessions.length,2);

  // 5. Reload both phones: still converged, and a further round changes nothing.
  for(const p of [A,B]){await p.page.reload();await p.page.waitForFunction(()=>typeof syncEngineGet==='function');}
  assert.equal(await view(A),converged);assert.equal(await view(B),converged);
  assert.equal(await sync(A),'{"ok":true}');assert.equal(await sync(B),'{"ok":true}');assert.equal(await view(B),converged);

  // 6. Stale phone C: joins, goes offline while A progresses, then reconnects; A's newer evidence survives everywhere.
  const C=await phone('C');await settings(C);await C.page.locator('#syncKeyIn').fill(key);await C.page.locator('#syncJoin').click();await idle(C);
  C.offline=true;
  await A.page.evaluate(()=>{view='start';render();});await practiseTimes(A);await A.page.waitForFunction(()=>kid().sync.pending.length===0,null,{timeout:15000});
  const newest=await A.page.evaluate(()=>kid().learning.skills.times2510.ev.at(-1).id);
  await C.page.evaluate(()=>{view='start';render();});await practiseTimes(C);
  C.offline=false;assert.equal(await sync(C),'{"ok":true}');assert.equal(await sync(A),'{"ok":true}');assert.equal(await sync(B),'{"ok":true}');
  const after=await view(A);assert.equal(after,await view(B));assert.equal(after,await view(C));
  assert.ok(JSON.parse(after)[0].learning.skills.times2510.ev.some(e=>e.id===newest));

  // 7. Revoke C from A (family code), through the device list.
  await settings(A);await A.page.locator('#syncDevices').click();await idle(A);
  assert.equal(await A.page.locator('[data-revoke]').count(),2);
  const cDevice=JSON.parse(Buffer.from(C.token.split('.')[0],'base64url')).deviceId;
  await A.page.locator('#syncAdminCode').fill(env.FAMILY_CODE);await A.page.locator(`[data-revoke="${cDevice}"]`).click();await idle(A);
  const cLocal=await C.page.evaluate(()=>JSON.stringify(kid().learning));
  assert.equal(await sync(C),'{"ok":false,"code":"revoked"}');
  await settings(C);assert.match(await statusText(C),/fjernet/);
  assert.equal(await C.page.evaluate(()=>JSON.stringify(kid().learning)),cLocal,'revoked phone keeps its data');

  // 8. New phone D joins and receives the converged state.
  const D=await phone('D');await settings(D);await D.page.locator('#syncKeyIn').fill(key);await D.page.locator('#syncJoin').click();await idle(D);
  assert.equal(await view(D),await view(A));

  // 9. Delete Ada from the family on A; B follows; D, offline with queued practice, cannot bring her back.
  D.offline=true;await D.page.evaluate(()=>{view='start';render();});await practiseTimes(D);
  const adaId=await A.page.evaluate(()=>kid().id);
  await settings(A);await A.page.locator('#syncAdminCode').fill(env.FAMILY_CODE);await A.page.locator('#syncDeleteChild').click();await idle(A);
  assert.equal(await A.page.evaluate(id=>kids.some(k=>k.id===id),adaId),false);
  assert.equal(await sync(B),'{"ok":true}');assert.equal(await B.page.evaluate(()=>kids.some(k=>k.name==='Ada')),false);
  D.offline=false;assert.equal(await sync(D),'{"ok":true}');assert.equal(await D.page.evaluate(()=>kids.some(k=>k.name==='Ada')),false);
  const rows=(await db.prepare('SELECT kind FROM sync_records WHERE child_id=?1').bind(adaId).all()).results.map(r=>r.kind);
  assert.deepEqual(rows,['tombstone']);

  // 10. Trusted Backup → sync: A builds native mastery for Bo, exports a signed backup, a new phone E restores it (TR1)
  // and shares it; B receives it with authority kept and without duplicated evidence.
  await A.page.evaluate(t0=>{const D=L.DAY;const k={...blankKid('Bo'),age:7};kids.push(k);active=kids.length-1;
    L.event(k.learning,'add1',{t:t0,s:0,ok:true,k:'task',sid:'b0',id:'b0',verified:true});
    L.event(k.learning,'add1',{t:t0+2*D,s:0,ok:true,k:'cold',sid:'b1',id:'b1',verified:true,c:'sikker'});
    L.event(k.learning,'add1',{t:t0+10*D,s:0,ok:true,k:'cold',sid:'b2',id:'b2',verified:true,c:'sikker'});saveKids();render();},Date.now()-40*86400000);
  await settings(A);
  const [download]=await Promise.all([A.page.waitForEvent('download'),A.page.locator('#exportLearning').click()]);
  const signed=await readFile(await download.path(),'utf8');assert.equal(JSON.parse(signed).schema,'spark-signed-backup-v1');
  assert.ok(!/"sync"|"pending"|"seen"|spark_sync/.test(JSON.parse(signed).payload),'backups carry no sync internals or key');assert.ok(!signed.includes(key));
  const E=await phone('E');await settings(E);await E.page.locator('#syncKeyIn').fill(key);await E.page.locator('#syncJoin').click();await idle(E);
  await E.page.locator('#importLearning').setInputFiles({name:'kopi.json',mimeType:'application/json',buffer:Buffer.from(signed)});
  await E.page.waitForFunction(()=>kids.some(k=>k.name==='Bo'));
  assert.ok(E.dialogs.some(m=>m.startsWith('Denne sikkerhetskopien er bekreftet av Spark.')));
  await E.page.evaluate(()=>{active=kids.findIndex(k=>k.name==='Bo');render();});await settings(E);await E.page.locator('#syncShare').click();await idle(E);
  assert.equal(await sync(B),'{"ok":true}');
  const bo=await B.page.evaluate(()=>{const k=kids.find(k=>k.name==='Bo'&&k.sync);return {state:L.state(k.learning.skills.add1),ev:k.learning.skills.add1.ev.length,box:k.learning.skills.add1.box,cold:k.learning.totals.cold};});
  const native=await A.page.evaluate(()=>{const k=kids.find(k=>k.name==='Bo');return {state:L.state(k.learning.skills.add1),ev:k.learning.skills.add1.ev.length,box:k.learning.skills.add1.box,cold:k.learning.totals.cold};});
  assert.deepEqual(bo,native);assert.equal(bo.state,'SITTER');
  assert.equal(await sync(E),'{"ok":true}');assert.equal(await sync(B),'{"ok":true}');
  assert.equal(await B.page.evaluate(()=>kids.find(k=>k.name==='Bo'&&k.sync).learning.skills.add1.ev.length),3,'no duplicated evidence');

  // Request bodies: ciphertext and ids only. No child name, word, token or key; the token travels only in the header.
  for(const b of bodies){
    for(const m of ['Ada','"Bo"','hus','Ola så',key,key.replace(/-/g,''),A.token,B.token])assert.ok(!b.body.includes(m),b.path+' carries '+m);
    assert.ok(b.auth.startsWith('Bearer '));
  }
  await B.page.evaluate(()=>{view='setup';render();});await B.page.locator('#syncSection').scrollIntoViewIfNeeded();await B.page.screenshot({path:resolve(artifacts,'sync1-two-phones.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',phones:5,checks:['UI create on phone with existing child','UI join with typed key (case/space tolerant)','starter profile replaced','both offline: real practice + word list on each phone','reconnect A via online event, then B, then A: converged','reload both: still converged; extra round idempotent','stale phone C: newer evidence kept everywhere','revoke C via device list + family code; C keeps local data','new phone D joins and converges','family delete: B follows; offline D cannot resurrect','Trusted Backup → restore on E → share → B: SITTER kept, no duplicate evidence','request bodies carry no names, words, token or key'],syncRequests:bodies.length,pageErrors:errors,screenshots:['tests/artifacts/sync1-settings.png','tests/artifacts/sync1-two-phones.png']}));
  for(const p of [A,B,C,D,E])await p.context.close();
}finally{await browser?.close();await new Promise(r=>server.close(r));await dispose();}
