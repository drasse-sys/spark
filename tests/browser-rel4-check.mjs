import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const root=new URL('../',import.meta.url);
const html=await readFile(new URL('spark.html',root),'utf8');
const release=html.match(/<meta name="spark-release" content="([^"]+)">/)[1];
const nextRelease=release.replace('-','b-');
const nextHTML=html.replace('content="'+release+'"','content="'+nextRelease+'"');
const nextHash=createHash('sha256').update(nextHTML.replace(/\r\n/g,'\n')).digest('hex');
const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json',png:'image/png'};
let newer=false;
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'')||'index.html';
  if(!/^[\w.-]+$/.test(name))return res.writeHead(404).end();
  try{
    let body=await readFile(new URL(name,root));
    if(newer&&name==='spark.html')body=nextHTML;
    if(newer&&name==='sw.js')body=body.toString().replace('spark-family-'+release,'spark-family-'+nextRelease)
      .replace(/('\.\/spark\.html':')[a-f0-9]{64}/,'$1'+nextHash);
    res.writeHead(200,{'Content-Type':types[name.split('.').at(-1)],'Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/spark/';
const service='https://spark-family-api.drasse.workers.dev';
const saved={
  spark_kids:[{name:'PRIVATE_CHILD',notes:['PRIVATE_PARENT_NOTE'],interests:'PRIVATE_INTEREST'}],
  spark_device_token:'PRIVATE_DEVICE_TOKEN',spark_device_server:service,spark_voice:'0',
  spark_session_0:{id:'PRIVATE_SESSION_ID',kid:0,mode:'lekse',ts:Date.now(),transcript:'PRIVATE_TRANSCRIPT',draft:'PRIVATE_CHAT_DRAFT',
    chatMsgs:[{role:'user',text:'PRIVATE_HOMEWORK'},{role:'assistant',text:'PRIVATE_CHAT_REPLY'}],
    history:[{role:'user',content:'PRIVATE_HOMEWORK'},{role:'assistant',content:'PRIVATE_CHAT_REPLY'}]},
  spark_ai_status_v1:{result:'daily_quota',success:{durationMs:74000,at:Date.now(),provider:'gemini',model:'gemini-2.5-flash',
    serverMs:72000,multipleAttempts:true},failure:{durationMs:1300,at:Date.now(),error:'PRIVATE_PROVIDER_DETAIL'},device:'PRIVATE_ID'}
};
let browser,healthy=true,healthCalls=0;
const errors=[];
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  await context.addInitScript(seed=>{
    window.SpeechRecognition=class {};
    Object.defineProperty(navigator,'clipboard',{value:{async writeText(text){
      if(window.denyClipboard)throw Error('permission denied');
      window.copiedStatus=text;
    }}});
    if(!localStorage.getItem('spark_kids')){
      for(const [key,value] of Object.entries(seed))localStorage.setItem(key,typeof value==='string'?value:JSON.stringify(value));
    }
  },saved);
  await context.route(service+'/**',async route=>{
    assert.equal(new URL(route.request().url()).pathname,'/health');
    assert.equal(route.request().method(),'GET');
    const headers=await route.request().allHeaders();
    assert.equal(headers.authorization,undefined);
    assert.equal(headers.cookie,undefined);
    assert.equal(route.request().postData(),null);
    healthCalls++;
    if(!healthy)return route.fulfill({status:503,json:{error:'PRIVATE_HEALTH_DETAIL'}});
    await route.fulfill({json:{ok:true,service:'spark-api',generation:'service-20261123',backup:'groq',
      familyId:'PRIVATE_FAMILY_ID',notes:'PRIVATE_SERVICE_NOTES'}});
  });
  async function open(){
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'spark.html');
    return page;
  }
  async function openPanel(page){
    await page.locator('#cogBtn').tap();
    await page.locator('#sparkStatus summary').tap();
    await page.locator('#sparkStatusRows').getByText('Kan nås',{exact:true}).waitFor();
  }
  let page=await open();
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(healthCalls,0);
  const before=await page.evaluate(()=>({family:localStorage.getItem('spark_kids'),session:localStorage.getItem('spark_session_0')}));
  await openPanel(page);
  const check=(label)=>page.locator('#sparkStatusRows dt').getByText(label,{exact:true}).locator('xpath=following-sibling::dd[1]');
  assert.equal(await check('Versjon').textContent(),release);
  assert.equal(await check('Spark styrer denne fanen').textContent(),'Ja');
  assert.equal(await check('Tjenesteversjon').textContent(),'service-20261123');
  assert.equal(await check('Reservetjeneste').textContent(),'Groq');
  assert.equal(await check('Siste svar').textContent(),'74 s · Svært sakte');
  assert.equal(await check('Uferdig lekse').textContent(),'Ja');
  assert.equal(await check('Lagring').textContent(),'OK');
  assert.equal(await page.locator('#sparkUpdateReady').isVisible(),false);
  assert.equal(await page.evaluate(()=>localStorage.getItem('spark_status_probe')),null);

  await page.locator('#fName').fill('PRIVATE_UNSAVED_NAME');
  await page.locator('#copySparkStatus').tap();
  const copied=await page.evaluate(()=>window.copiedStatus);
  assert.match(copied,new RegExp('Versjon: '+release));
  assert.match(copied,/AI-rute: Gemini · gemini-2\.5-flash/);
  assert.match(copied,/Siste resultat: Dagskvoten er brukt opp/);
  assert.match(copied,/Sjekket: \d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(copied,/PRIVATE_|spark-family-api/);
  await page.evaluate(()=>{window.denyClipboard=true;});
  await page.locator('#copySparkStatus').tap();
  const fallback=await page.locator('#sparkCopyText').inputValue();
  assert.equal(fallback,copied);

  healthy=false;
  await page.locator('#refreshSparkStatus').tap();
  await page.locator('#sparkStatusRows').getByText('Kan ikke nås',{exact:true}).waitFor();
  assert.equal(await page.locator('#fName').inputValue(),'PRIVATE_UNSAVED_NAME');
  const calls=healthCalls;
  await context.setOffline(true);
  await page.locator('#sparkStatusRows').getByText('Kan ikke nås uten nett',{exact:true}).waitFor();
  assert.equal(await check('Nett').textContent(),'Frakoblet');
  assert.equal(healthCalls,calls);
  healthy=true;
  await context.setOffline(false);
  await page.locator('#sparkStatusRows').getByText('Kan nås',{exact:true}).waitFor();
  assert.equal(await check('Nett').textContent(),'På nett');

  await page.evaluate(()=>{
    const write=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      if(key==='spark_status_probe'&&window.blockProbe)throw Error('quota');
      return write.call(this,key,value);
    };
    window.blockProbe=true;
  });
  await page.locator('#refreshSparkStatus').tap();
  await page.locator('#sparkStatusRows').getByText('Trenger oppmerksomhet',{exact:true}).waitFor();
  assert.equal(await check('Kan lese / skrive').textContent(),'Ja / Nei');
  assert.deepEqual(await page.evaluate(()=>({family:localStorage.getItem('spark_kids'),session:localStorage.getItem('spark_session_0')})),before);

  newer=true;
  await page.locator('#refreshSparkStatus').tap();
  await page.locator('#sparkUpdateReady').waitFor({state:'visible'});
  assert.equal(await check('Versjon').textContent(),release);
  assert.equal(await check('Oppdatering').textContent(),'Klar');
  await page.goBack();
  await page.locator('#resumeBtn').tap();
  assert.equal(await page.locator('#msg').inputValue(),'PRIVATE_CHAT_DRAFT');
  assert.equal(await page.locator('meta[name="spark-release"]').getAttribute('content'),release);

  await page.close();
  page=await open();
  await page.waitForFunction(async key=>!(await caches.keys()).includes(key),'spark-family-'+release);
  if(await page.locator('meta[name="spark-release"]').getAttribute('content')!==nextRelease)await page.reload();
  await openPanel(page);
  assert.equal(await check('Versjon').textContent(),nextRelease);
  assert.equal(await page.locator('#sparkUpdateReady').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',viewport:'390x844',checks:[
    'release and service-worker control','authenticated data omitted from health requests','health failure without edits lost',
    'offline and reconnect refresh','storage probe failure without writes to family','private data excluded from clipboard and fallback',
    'waiting update on old tab','resume keeps draft during update','new release after old tab closes'
  ],pageErrors:errors}));
  await context.close();
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
