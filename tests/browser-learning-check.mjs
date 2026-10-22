// Real browser C3 acceptance, all provider replies mocked. No real microphone claim.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(process.env.SPARK_TEST_MODULE_ROOT||import.meta.url);
const {chromium}=require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=resolve(root,'tests/artifacts');await mkdir(artifacts,{recursive:true});
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'');const file=resolve(root,path||'index.html');if(!file.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}try{const data=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html; charset=utf-8':'application/json','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{localStorage.setItem('spark_device_token','fixture-browser');localStorage.setItem('spark_device_server','https://spark-family-api.drasse.workers.dev');});
  const page=await context.newPage(),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('https://spark-family-api.drasse.workers.dev/**',route=>{const body=route.request().postDataJSON();calls.push(body);return route.fulfill({json:{text:body.mode==='lesing'?'Fortell hvem teksten handler om. [[STØTTE: S2 | readRetell | feil | ingen]] [[ORD: hus | et sted å bo | Ola så et hus.]]':'Del opp i tiere. [[STØTTE: S2 | addCarry | feil | ingen]] [[VIS: {"type":"tiere","tens":4,"ones":7}]]',provider:'gemini'}});});
  await page.goto(origin+'/spark/spark.html');
  await page.locator('#modeTabs [data-t="matte"]').click();await page.locator('#inTabs [data-m="text"]').click();await page.locator('#hwT').fill('47+38');await page.locator('#go').click();await page.locator('.math-visual').waitFor();
  assert.equal(await page.locator('.math-visual svg rect').count(),47);
  await page.locator('#msg').fill('85');await page.locator('#sendBtn').click();await page.locator('#trySelf').click();
  const item=await page.evaluate(()=>learningSession.check.item);assert.notEqual(item.expression,'47+38');
  await page.locator('#msg').fill(item.answer);await page.locator('#sendBtn').click();assert.ok((await page.locator('#chatBox').textContent()).includes('✓ Klarte selv.'));assert.equal(calls.length,1);
  await page.locator('.learning-panel details summary').click();await page.locator('#reflection').selectOption('Dele opp');await page.locator('#backBtn').click();await page.reload();await page.locator('#resumeBtn').click();
  assert.equal(await page.evaluate(()=>learningSession.task.s),0);assert.equal(await page.locator('#reflection').inputValue(),'Dele opp');
  await page.locator('#doneBtn').click();await page.locator('#cogBtn').click();assert.ok((await page.locator('main').textContent()).includes('Læring over tid'));assert.ok((await page.locator('main').textContent()).includes('Dele opp'));
  await page.locator('.prof h2').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(artifacts,'c3-parent.png')});await page.locator('#saveBtn').click();
  await page.locator('.practice > summary').click();await page.locator('#timesStart').click();
  const practiceCalls=calls.length;await page.locator('#skipCheck').click();await page.locator('#doneBtn').click();assert.equal(calls.length,practiceCalls);
  // Seed an older verified skill, then exercise the actual review UI.
  await page.evaluate(()=>{L.event(kid().learning,'sub1',{t:Date.now()-2*L.DAY,s:0,ok:true,k:'task',sid:'prior',id:'prior',verified:true});saveKids();render();});
  await page.locator('.practice > summary').click();await page.locator('#reviewStart').click();await page.locator('#confidence').selectOption('sikker');
  await page.locator('#msg').fill(await page.evaluate(()=>learningSession.check.item.answer));await page.locator('#sendBtn').click();assert.equal(await page.evaluate(()=>kid().learning.skills.sub1.ev.at(-1).delayed),true);assert.equal(calls.length,practiceCalls);await page.locator('#doneBtn').click();
  await page.locator('#modeTabs [data-t="lesing"]').click();await page.locator('#inTabs [data-m="text"]').click();await page.locator('#hwT').fill('Ola så et hus. Han gikk inn.');await page.locator('#go').click();await page.locator('.reading-panel').waitFor();assert.equal(await page.locator('#readPassage').count(),0);
  await page.locator('[data-word="0"]').click();assert.equal(await page.evaluate(()=>kid().learning.items.length),1);
  // Each deterministic tool at narrow and wider mobile sizes, no overflow or script execution.
  const specs=[{type:'tallinje',min:0,max:100,start:47,jumps:[30,8]},{type:'tierramme',n:7},{type:'tiere',tens:9,ones:9},{type:'rutenett',rows:10,cols:10},{type:'brøk',numerator:3,denominator:4},{type:'klokke',hour:7,minute:45},{type:'penger',coins:Array(20).fill(20)}];
  for(const width of [320,390,768]){
    await page.setViewportSize({width,height:844});
    await page.evaluate(specs=>{chatMsgs=[{role:'assistant',text:'Se på figuren.',visuals:specs}];render();},specs);
    assert.equal(await page.locator('.math-visual').count(),7);assert.equal(await page.locator('.math-visual svg[aria-label]').count(),7);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    for(const el of await page.locator('.math-visual').all())assert.ok(await el.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
    if(width===390)await page.screenshot({path:resolve(artifacts,'c3-mobile.png')});
  }
  await page.setViewportSize({width:390,height:844});
  // Real service-worker offline cache includes the new modules and deterministic practice.
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);await context.setOffline(true);await page.goto(origin+'/spark/');
  await page.locator('.practice > summary').click();await page.locator('#timesStart').click();await page.locator('#skipCheck').waitFor();assert.ok(await page.evaluate(()=>typeof SparkArithmetic.check==='function'&&typeof SparkLearning.event==='function'));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',widths:[320,390,768],checks:['supported-to-transfer','checked S0 success','reflection restore','structured parent view','zero-call practice','delayed review','text-only reading','vocabulary review item','seven accessible visuals','offline modules and practice'],mockProviderCalls:calls.length,pageErrors:errors,screenshots:['tests/artifacts/c3-parent.png','tests/artifacts/c3-mobile.png']}));
  await context.close();
}finally{await browser?.close();await new Promise(r=>server.close(r));}
