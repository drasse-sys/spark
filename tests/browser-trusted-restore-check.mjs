// Real Chromium TR1 acceptance: the page's own Web Crypto digests the export; /backup/* requests are answered by the real
// Worker code evaluated in-process with a fixture EXPORT_SIGNING_SECRET. No production API is contacted.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {backend,environment} from './helpers.mjs';
const require=createRequire(process.env.SPARK_TEST_MODULE_ROOT||import.meta.url);
const {chromium}=require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=resolve(root,'tests/artifacts');await mkdir(artifacts,{recursive:true});
const SERVER='https://spark-family-api.drasse.workers.dev',SECRET='fixture-browser-export-secret-0123456789abcdef';
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'');const file=resolve(root,path||'index.html');if(!file.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}try{const data=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html; charset=utf-8':'application/json','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const worker=backend(()=>{throw Error('no provider');});
const {env}=environment({ALLOWED_ORIGINS:origin,EXPORT_SIGNING_SECRET:SECRET});
const token=await worker.api.makeToken(env,'browser-device');
const requests=[];
// Routes the page's request to the in-process Worker; `env` decides whether signing is configured.
function toWorker(workerEnv,{offline=false}={}){
  return async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()!=='OPTIONS')requests.push({path,headers:req.headers(),body:req.postData()});
    if(offline&&path==='/backup/verify')return route.abort('internetdisconnected');
    const r=await worker.worker.fetch(new Request(req.url(),{method:req.method(),headers:{...req.headers(),origin,'cf-connecting-ip':'192.0.2.9'},body:['GET','OPTIONS'].includes(req.method())?undefined:req.postData()}),workerEnv);
    return route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});
  };
}
const b64sha=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('base64url');
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const errors=[];
  async function phone(paired,workerEnv=env,options){
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
    if(paired)await context.addInitScript(t=>{localStorage.setItem('spark_device_token',t);localStorage.setItem('spark_device_server','https://spark-family-api.drasse.workers.dev');},token);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const dialogs=[];let decide=()=>true;page.on('dialog',d=>{dialogs.push(d.message());decide(d.message())?d.accept():d.dismiss();});
    await page.route(SERVER+'/**',toWorker(workerEnv,options));
    await page.goto(origin+'/spark/spark.html');
    return {context,page,dialogs,decide:fn=>decide=fn};
  }
  const openParent=async page=>{if(!await page.locator('#exportLearning').count()){await page.locator('#cogBtn').click();}await page.locator('#exportLearning').waitFor();};
  async function download(page){const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#exportLearning').click()]);return {name:d.suggestedFilename(),text:await readFile(await d.path(),'utf8')};}

  // 1. Paired phone with native mastery produces a signed backup through the real page.
  const a=await phone(true);
  await a.page.evaluate(t0=>{const D=L.DAY;kid().name='Ada';kid().age=9;kid().learning=L.empty();
    L.event(kid().learning,'add1',{t:t0,s:0,ok:true,k:'task',sid:'s0',id:'a0',verified:true});
    L.event(kid().learning,'add1',{t:t0+2*D,s:0,ok:true,k:'cold',sid:'s1',id:'a1',verified:true,c:'sikker'});
    L.event(kid().learning,'add1',{t:t0+10*D,s:0,ok:true,k:'cold',sid:'s2',id:'a2',verified:true,c:'sikker'});saveKids();render();},Date.now()-40*86400000);
  assert.equal(await a.page.evaluate(()=>L.state(kid().learning.skills.add1)),'SITTER');
  await openParent(a.page);
  const signedFile=await download(a.page);
  assert.equal(signedFile.name,'spark-laeringskopi-bekreftet.json');assert.equal(a.dialogs.length,0);
  const container=JSON.parse(signedFile.text);
  assert.deepEqual(Object.keys(container).sort(),['payload','schema','signature']);assert.equal(container.schema,'spark-signed-backup-v1');
  // Browser Web Crypto and Node agree on the digest of the exact payload bytes.
  assert.equal(container.signature.digest,b64sha(container.payload));
  for(const secret of [token,SECRET,env.DEVICE_SIGNING_SECRET,env.FAMILY_CODE,env.GEMINI_API_KEY,'spark_device_token','Bearer',SERVER])assert.ok(!signedFile.text.includes(secret),secret);
  const signReq=requests.find(r=>r.path==='/backup/sign');
  assert.deepEqual(Object.keys(JSON.parse(signReq.body)).sort(),['digest','v']);assert.ok(!signReq.body.includes('Ada'));assert.ok(signReq.headers.authorization?.startsWith('Bearer '));
  const unsignedText=await a.page.evaluate(()=>JSON.stringify(learningExport()));

  // 2. New, unpaired phone: signed restore keeps mastery; tampered and legacy copies restore as history only.
  const b=await phone(false);await openParent(b.page);
  async function restore(p,text,expectKids){
    const n=p.dialogs.length;await p.page.locator('#importLearning').setInputFiles({name:'kopi.json',mimeType:'application/json',buffer:Buffer.from(text)});
    await expectDialog(p,n);if(expectKids!==undefined)await p.page.waitForFunction(k=>kids.length===k,expectKids);
    return p.dialogs.at(-1);
  }
  async function expectDialog(p,n){for(let i=0;i<200&&p.dialogs.length===n;i++)await p.page.waitForTimeout(25);assert.ok(p.dialogs.length>n,'restore prompt shown');}
  const start=await b.page.evaluate(()=>kids.length);
  let message=await restore(b,signedFile.text,start+1);
  assert.ok(message.startsWith('Denne sikkerhetskopien er bekreftet av Spark.'),message);
  assert.equal(await b.page.evaluate(()=>L.state(kids.at(-1).learning.skills.add1)),'SITTER');
  assert.equal(await b.page.evaluate(()=>kids.at(-1).name),'Ada');
  const verifyReq=requests.filter(r=>r.path==='/backup/verify').at(-1);
  assert.deepEqual(Object.keys(JSON.parse(verifyReq.body)).sort(),['digest','digestAlg','kid','mac','protocol','sigAlg','signedAt','v']);assert.ok(!verifyReq.body.includes('Ada'));assert.equal(verifyReq.headers.authorization,undefined);
  await b.page.evaluate(()=>{active=kids.length-1;render();});await b.page.locator('.prof h2').scrollIntoViewIfNeeded();await b.page.screenshot({path:resolve(artifacts,'tr1-trusted-restore.png')});

  const tampered=JSON.stringify({...container,payload:container.payload.replace('"Ada"','"Adb"')});
  const verifyCount=requests.filter(r=>r.path==='/backup/verify').length;
  message=await restore(b,tampered,start+2);
  assert.ok(message.startsWith('Advarsel:'),message);assert.equal(requests.filter(r=>r.path==='/backup/verify').length,verifyCount,'tampering caught locally');
  assert.equal(await b.page.evaluate(()=>L.state(kids.at(-1).learning.skills.add1)),'ØVER');

  const forged=JSON.stringify({...container,payload:container.payload.replace('"Ada"','"Adc"'),signature:{...container.signature,digest:b64sha(container.payload.replace('"Ada"','"Adc"'))}});
  message=await restore(b,forged,start+3);assert.ok(message.startsWith('Advarsel:'),message);
  assert.equal(await b.page.evaluate(()=>L.state(kids.at(-1).learning.skills.add1)),'ØVER');

  message=await restore(b,unsignedText,start+4);
  assert.ok(message.includes('ikke bekreftet av Spark'),message);assert.equal(await b.page.evaluate(()=>L.state(kids.at(-1).learning.skills.add1)),'ØVER');

  // 3. Verification endpoint unreachable: never trusted. Cancel leaves storage untouched; accepting adds history only.
  const c=await phone(false,env,{offline:true});await openParent(c.page);
  const before=await c.page.evaluate(()=>[kids.length,localStorage.getItem('spark_kids')]);
  c.decide(()=>false);message=await restore(c,signedFile.text);
  assert.ok(message.includes('kunne ikke bekrefte'),message);
  assert.deepEqual(await c.page.evaluate(()=>[kids.length,localStorage.getItem('spark_kids')]),before);
  c.decide(()=>true);await restore(c,signedFile.text,before[0]+1);
  assert.equal(await c.page.evaluate(()=>L.state(kids.at(-1).learning.skills.add1)),'ØVER');

  // 4. Signing unavailable (no EXPORT_SIGNING_SECRET): the parent is asked, then gets a history-only copy.
  const d=await phone(true,{...env,EXPORT_SIGNING_SECRET:undefined});await openParent(d.page);
  const fallback=await download(d.page);
  assert.ok(d.dialogs.at(-1).includes('ubekreftet'));assert.equal(fallback.name,'spark-laeringskopi.json');
  assert.equal(JSON.parse(fallback.text).schema,'spark-learning-export-v3');
  for(const secret of [token,SECRET,'spark_device_token','Bearer'])assert.ok(!fallback.text.includes(secret),secret);

  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',checks:['signed export via page Web Crypto','digest parity browser/Node','no secrets in signed or fallback file','sign request digest-only','unpaired signed restore keeps SITTER','verify request digest+signature only, no credentials','tampered payload caught locally','re-digested forgery refused by Worker','legacy unsigned quarantined','verify offline: cancel untouched, accept history-only','signing unavailable fallback'],backupRequests:requests.length,pageErrors:errors,screenshot:'tests/artifacts/tr1-trusted-restore.png'}));
  for(const p of [a,b,c,d])await p.context.close();
}finally{await browser?.close();await new Promise(r=>server.close(r));}
