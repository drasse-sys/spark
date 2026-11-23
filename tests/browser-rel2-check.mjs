import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const root=new URL('../',import.meta.url);
let update=false,skew=false;
const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json',png:'image/png'};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'')||'index.html';
  if(!/^[\w.-]+$/.test(name))return res.writeHead(404).end();
  try{
    let body=await readFile(new URL(name,root));
    if(name==='sw.js'&&update)body=body.toString().replace(/(const CACHE = '[^']+)/,'$1-update');
    if(name==='learning-ui.js'&&skew)body=Buffer.from('throw Error("mixed release")');
    res.writeHead(200,{'Content-Type':types[name.split('.').at(-1)],'Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/spark/';
const api='https://spark-family-api.drasse.workers.dev';
let browser,release;
const errors=[],calls=[];
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  await context.addInitScript(({origin})=>{
    if(localStorage.getItem('spark_kids'))return;
    localStorage.setItem('spark_kids',JSON.stringify([{name:'Barn A'},{name:'Barn B'}]));
    localStorage.setItem('spark_device_token','rel2-browser-fixture');
    localStorage.setItem('spark_device_server',origin);
  },{origin:api});
  let received;
  const firstRequest=new Promise(resolve=>{received=resolve;});
  await context.route(api+'/chat',async route=>{
    calls.push(route.request().postDataJSON());
    if(calls.length===1){
      received();
      await new Promise(resolve=>{release=resolve;});
      await route.abort().catch(()=>{});
    }else if(calls.length===2){
      await route.fulfill({status:503,json:{kind:'provider_error'}});
    }else{
      await route.fulfill({json:{text:'Prøv å forklare med egne ord.',provider:'gemini'}});
    }
  });
  async function open(){
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'spark.html');
    return page;
  }
  let page=await open();
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.locator('#kidPick [data-i="1"]').tap();
  const damaged=page.waitForEvent('dialog').then(async dialog=>{
    assert.match(dialog.message(),/Kunne ikke åpne bildet/);
    await dialog.accept();
  });
  await page.locator('#file').setInputFiles({name:'damaged.png',mimeType:'image/png',buffer:Buffer.from('damaged')});
  await damaged;
  assert.equal(await page.locator('#go').isDisabled(),true);
  const largeImage=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');
    canvas.width=2600;canvas.height=1600;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#7c5cbf';ctx.fillRect(0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#file').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.from(largeImage,'base64')});
  await page.waitForFunction(()=>document.querySelector('#drop img')?.naturalWidth===1100);
  await page.locator('#file').setInputFiles([]);
  assert.equal(await page.locator('#drop img').count(),1);
  await page.locator('#kidPick [data-i="0"]').tap();
  assert.equal(await page.locator('#drop img').count(),0);
  await page.locator('#inTabs [data-m="text"]').tap();
  await page.locator('#hwT').fill('Forklar hvorfor det regner.');
  await page.locator('#go').tap();
  await firstRequest;
  assert.equal(await page.locator('#cogBtn').isDisabled(),true);
  await page.close();release();

  page=await open();
  await page.locator('#kidPick [data-i="1"]').tap();
  assert.equal(await page.locator('#resumeBtn').count(),0);
  await page.locator('#kidPick [data-i="0"]').tap();
  await page.locator('#resumeBtn').tap();
  await page.locator('#retryTurn').tap();
  await page.getByText(/AI-tjenesten er midlertidig utilgjengelig/).waitFor();
  await page.locator('#retryTurn').tap();
  await page.getByText('Prøv å forklare med egne ord.').waitFor();
  assert.equal(await page.locator('#chatBox .row.me').count(),1);
  assert.deepEqual(calls.map(c=>c.messages),Array(3).fill(calls[0].messages));

  await page.locator('#msg').fill('Kladde fra Barn A');
  await page.goBack();
  await page.locator('#resumeBtn').tap();
  assert.equal(await page.locator('#msg').inputValue(),'Kladde fra Barn A');
  update=true;
  await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
  await page.waitForFunction(async()=>!!(await navigator.serviceWorker.ready).waiting);
  assert.equal(await page.locator('#msg').inputValue(),'Kladde fra Barn A');

  await context.setOffline(true);
  await page.reload();
  await page.locator('#resumeBtn').tap();
  assert.equal(await page.locator('#msg').inputValue(),'Kladde fra Barn A');
  await context.setOffline(false);
  await page.close();
  page=await open();
  await page.waitForFunction(async()=>(await caches.keys()).some(k=>k.endsWith('-update')));
  await page.waitForFunction(async()=>(await caches.keys()).filter(k=>k.startsWith('spark-')).length===1);
  await page.locator('#resumeBtn').tap();
  assert.equal(await page.locator('#msg').inputValue(),'Kladde fra Barn A');

  await page.evaluate(async()=>{
    const [key]=await caches.keys();
    await (await caches.open(key)).delete(new URL('learning-ui.js',location.href));
  });
  skew=true;
  assert.equal((await page.reload()).status(),503);
  await page.getByText(/Spark mangler appfiler/).waitFor();
  skew=false;
  assert.equal((await page.reload()).status(),200);
  await page.locator('#resumeBtn').tap();
  assert.equal(await page.locator('#msg').inputValue(),'Kladde fra Barn A');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',viewport:'390x844',checks:[
    'damaged, resized and cancelled photos','close and reopen during request','child ownership','503 and identical retry','browser back and draft',
    'waiting service-worker update','offline reload','activation after tab closes','mismatched missing file refused',
    'matching missing file recovered'
  ],pageErrors:errors}));
  await context.close();
}finally{
  release?.();
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
