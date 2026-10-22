// Optional real Chromium smoke: npm install --no-save playwright, then node browser-check.mjs.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(process.env.SPARK_TEST_MODULE_ROOT || import.meta.url);
const {chromium}=require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'');
  const file=resolve(root,path||'index.html');
  if(!file.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}
  try{const data=await readFile(file);res.writeHead(200,{'Content-Type':types[file.slice(file.lastIndexOf('.'))]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const payloads=[];
  await page.route('https://spark-family-api.drasse.workers.dev/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/pair')return route.fulfill({json:{token:'browser-fixture-token'}});
    const body=route.request().postDataJSON();payloads.push(body);
    const finish=body.messages.at(-1).content.includes?.('Ferdig med leksa');
    await route.fulfill({json:{text:finish?'Takk for i dag! [[LOGG: Pluss | telte selv | øv videre]]':'Hva skjer med enerne? [[OPPGAVE: 2 + 3]]',provider:'gemini'}});
  });
  await page.goto(origin+'/spark/');await page.waitForURL('**/spark.html');
  assert.equal(await page.locator('#fServer').inputValue(),'https://spark-family-api.drasse.workers.dev');
  await page.locator('#fName').fill('Barn A');await page.locator('#fFamily').fill('browser-family-fixture');
  await page.locator('#pairBtn').click();await page.locator('#unpairBtn').waitFor();await page.locator('#saveBtn').click();
  await page.locator('#inTabs [data-m="text"]').click();await page.locator('#hwT').fill('Regn 2 + 3');await page.locator('#go').click();
  await page.locator('#chatBox').getByText('Hva skjer med enerne?').waitFor();
  await page.locator('#msg').fill('Fem');await page.locator('#sendBtn').click();
  await page.waitForFunction(()=>document.querySelectorAll('#chatBox .bub').length>=4);
  await page.locator('#backBtn').click();await page.reload();await page.locator('#resumeBtn').click();
  assert.ok((await page.locator('#chatBox').textContent()).includes('Fem'));
  page.on('dialog',dialog=>dialog.accept());await page.locator('#doneBtn').click();await page.locator('#histBtn').click();
  await page.locator('[data-s="0"]').click();assert.ok(await page.locator('#foot').evaluate(e=>e.classList.contains('hide')));
  await page.locator('#backBtn').click();await page.locator('#cogBtn').click();
  await page.locator('#addKid').click();await page.locator('#fName').fill('Barn B');await page.locator('#saveBtn').click();
  assert.equal(await page.locator('#histBtn').count(),0);assert.equal(await page.locator('#resumeBtn').count(),0);
  await page.locator('#kidPick [data-i="0"]').click();assert.equal(await page.locator('#histBtn').count(),1);
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('header button')].map(e=>{const r=e.getBoundingClientRect();return {id:e.id,width:r.width,height:r.height};})}));
  assert.ok(layout.scroll<=layout.width,'no horizontal mobile overflow');
  // Real browser SW installation and offline root navigation.
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await context.setOffline(true);await page.goto(origin+'/spark/');await page.locator('#who').waitFor();
  assert.ok((await page.title()).includes('Spark'));
  if(process.env.SPARK_SCREENSHOT)await page.screenshot({path:process.env.SPARK_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors,[]);assert.equal(payloads.length,3);assert.equal(payloads[0].mode,'lekse');assert.ok(!('system' in payloads[0]));
  console.log(JSON.stringify({result:'PASS',viewport:'390x844',checks:['default pairing','text chat','restore','finish summary','read-only archive','multi-child separation','mobile overflow','real service-worker offline root'],providerRequests:payloads.length,pageErrors:errors,layout}));
  await context.close();
}finally{await browser?.close();await new Promise(r=>server.close(r));}
