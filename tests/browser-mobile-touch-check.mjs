// UX1 real-Chromium mobile touch acceptance. Taps go through Playwright's touchscreen (touchstart/touchend ->
// Chromium gesture -> click), never element.click(). Provider replies, speech output and speech input are faked.
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
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.replace(/^\/spark\//,'');const file=resolve(root,path||'index.html');if(!file.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}try{const data=await readFile(file);res.writeHead(200,{'Content-Type':types[file.slice(file.lastIndexOf('.'))]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const API='https://spark-family-api.drasse.workers.dev';
// The assistant message from the real Android smoke test. No marker, so the ladder shows S2 «Et hint».
const REPLY='Her skal vi finne ut hva 8 ganger 8 er.\nDet betyr at vi har 8 grupper med 8 i hver, akkurat som om du bygger 8 rader i Minecraft med 8 blokker i hver rad.\nHvis vi deler opp tallet litt: Vet du hva 8 ganger 5 er?';
const HELP_TEXT={1:'Gi meg bare en liten påminnelse, uten metode.',2:'Gi meg et lite hint.',3:'Del oppgaven i mindre steg.',4:'Vis metoden med et annet, lignende eksempel.'};
const QUICK=[['1. Lite puff','#quick [data-help="1"]'],['2. Lite hint','#quick [data-help="2"]'],['3. Mindre steg','#quick [data-help="3"]'],['4. Vis et eksempel','#quick [data-help="4"]'],['Jeg vet ikke','#stuckBtn'],['Pause / for vanskelig','#pauseLearning']];
const checks=[];const note=c=>checks.push(c);

function fakeDevice(){
  if(!localStorage.getItem('spark_kids')){
    localStorage.setItem('spark_device_token','fixture-touch');localStorage.setItem('spark_device_server','https://spark-family-api.drasse.workers.dev');
    localStorage.setItem('spark_kids',JSON.stringify([{name:'Olav',age:8},{name:'Ida',age:7}]));localStorage.setItem('spark_voice','1');
  }
  // Android-like speech output with one Norwegian voice; start is asynchronous like the native engine.
  const voices=[{name:'Norsk',lang:'nb-NO',voiceURI:'nb-fixture',default:true,localService:true}];window.__tts=[];
  const synth={getVoices:()=>voices,addEventListener(){},cancel(){if(this.u)this.u.cancelled=true;window.__ttsPending=false;window.__tts.push('cancel');},speak(u){this.u=u;window.__ttsPending=true;window.__tts.push('speak');setTimeout(()=>{window.__ttsPending=false;if(!u.cancelled)u.onstart?.();},30);}};
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:synth});
  window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  // DOM-level speech input: records start/stop, the test drives onresult.
  window.__mic=[];window.SpeechRecognition=class{constructor(){window.__rec=this;}start(){window.__mic.push('start');setTimeout(()=>this.onstart?.(),10);}stop(){window.__mic.push('stop');setTimeout(()=>this.onend?.(),10);}abort(){window.__mic.push('abort');}};
}

async function newPage(browser,contextOptions){
  const context=await browser.newContext(contextOptions);await context.addInitScript(fakeDevice);
  const page=await context.newPage();page.setDefaultTimeout(10000);
  const api={calls:[],errors:[],gate:null};
  page.on('pageerror',e=>api.errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route(API+'/**',async route=>{
    const body=route.request().postDataJSON();api.calls.push(body);
    if(api.gate)await api.gate.promise;
    const finish=JSON.stringify(body.messages?.at(-1)?.content||'').includes('Ferdig med leksa');
    await route.fulfill({json:{text:finish?'Takk for i dag! [[LOGG: Gangetabell | delte opp 8 · 8 | øve 8-gangen]]':REPLY,provider:'gemini'}});
  });
  await page.goto(origin+'/spark/spark.html');
  return {context,page,api};
}
function hold(api){let release;api.gate={promise:new Promise(r=>release=r)};return ()=>{api.gate=null;release();};}

// Deterministic hit testing: the control must be fully on screen, inside #app, at least 24 px (WCAG 2.5.8)
// and the topmost element at its centre and four inner points (not covered by quick/doneBar/footer/other).
async function operable(page,selector,name){
  const loc=page.locator(selector).first();await loc.waitFor({state:'visible'});
  const g=await loc.evaluate(el=>{
    el.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=el.getBoundingClientRect(),app=document.getElementById('app').getBoundingClientRect();
    const pts=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]].map(([fx,fy])=>{const x=r.left+r.width*fx,y=r.top+r.height*fy,h=document.elementFromPoint(x,y);return {x,y,ok:!!h&&(h===el||el.contains(h)),by:h?(h.id?'#'+h.id:String(h.className||h.tagName)):'nothing'};});
    return {w:r.width,h:r.height,pts,inApp:r.left>=app.left-1&&r.right<=app.right+1&&r.top>=app.top-1&&r.bottom<=app.bottom+1,inView:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
  });
  assert.ok(g.w>=24&&g.h>=24,`${name}: hit target ${g.w.toFixed(0)}x${g.h.toFixed(0)} is below 24 px`);
  assert.ok(g.inApp,`${name}: outside the visible app container`);assert.ok(g.inView,`${name}: outside the viewport`);
  for(const p of g.pts)assert.ok(p.ok,`${name}: covered at ${p.x.toFixed(0)},${p.y.toFixed(0)} by ${p.by}`);
  return g.pts[0];
}
async function tap(page,selector,name){const p=await operable(page,selector,name);await page.touchscreen.tap(p.x,p.y);}
const disabled=(page,selector)=>page.locator(selector).first().isDisabled();
const style=(page,selector)=>page.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);return {opacity:+s.opacity,color:s.color,background:s.backgroundColor,border:s.borderTopStyle+' '+s.borderTopColor,cursor:s.cursor};});
// A disabled control must not look like its enabled sibling: dimmed, recoloured and a not-allowed cursor.
async function looksDisabled(page,selector,enabledStyle,name){
  const d=await style(page,selector);const differs=['color','background','border'].filter(k=>d[k]!==enabledStyle[k]);
  assert.ok(d.opacity<=.65,`${name}: disabled control is not dimmed (opacity ${d.opacity})`);
  assert.ok(differs.length>=2,`${name}: disabled control looks like an enabled one (${JSON.stringify(d)})`);
  assert.equal(d.cursor,'not-allowed',`${name}: disabled cursor`);
}
async function looksEnabled(page,selector,name){const s=await style(page,selector);assert.ok(s.opacity>.9,`${name}: enabled control is dimmed`);assert.notEqual(s.cursor,'not-allowed',`${name}: enabled control shows not-allowed`);return s;}
const state=page=>page.evaluate(()=>({msgs:chatMsgs.length,last:chatMsgs.at(-1)?.text||'',busy,view,s:learningSession?.task?.s,attempts:learningSession?.task?.attempts}));
// Settled: no reply pending and the async speech start (which re-renders) has fired.
const idle=page=>page.waitForFunction(()=>!busy&&!window.__ttsPending);
async function sendsOnce(page,api,selector,name,expectedText){
  const before=api.calls.length,msgs=(await state(page)).msgs;
  await tap(page,selector,name);await idle(page);
  assert.equal(api.calls.length,before+1,`${name}: exactly one provider request per tap`);
  const after=await page.evaluate(n=>chatMsgs.slice(n).map(m=>m.role+':'+m.text),msgs);
  assert.equal(after.filter(m=>m.startsWith('user:')).length,1,`${name}: exactly one child message per tap`);
  if(expectedText)assert.equal(after[0],'user:'+expectedText,`${name}: sent text`);
}

let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.SPARK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPARK_CHROMIUM_EXECUTABLE}:{})});
  const {context,page,api}=await newPage(browser,{viewport:{width:360,height:740},deviceScaleFactor:2.625,isMobile:true,hasTouch:true});

  // ---------- START SCREEN ----------
  await tap(page,'#kidPick [data-i="1"]','child selector Ida');assert.equal(await page.evaluate(()=>active),1);
  await tap(page,'#kidPick [data-i="0"]','child selector Olav');assert.equal(await page.evaluate(()=>kid().name),'Olav');
  await tap(page,'#modeTabs [data-t="lesing"]','mode tab Lesing');assert.equal(await page.evaluate(()=>taskMode),'lesing');
  await tap(page,'#modeTabs [data-t="matte"]','mode tab Matte');assert.equal(await page.evaluate(()=>taskMode),'matte');
  await tap(page,'#inTabs [data-m="camera"]','photo tab');await page.locator('#drop').waitFor();
  await tap(page,'#inTabs [data-m="text"]','text tab');await page.locator('#hwT').waitFor();
  assert.equal(await page.getByRole('textbox',{name:'✏️ Skriv oppgaven:'}).count(),1,'homework text box is named by its visible label');
  // Practice buttons, zero provider calls.
  await tap(page,'.practice > summary','practice summary');
  await tap(page,'#wordsStart','practice words');assert.match(await page.locator('main').textContent(),/Ingen oppgaver å hente fram/);
  await tap(page,'.practice > summary','practice summary');await tap(page,'#timesStart','practice times');
  await page.locator('#skipCheck').waitFor();await page.locator('#msg').fill(await page.evaluate(()=>learningSession.check.item.answer));
  await tap(page,'#sendBtn','send (practice answer)');assert.equal((await page.locator('#skipCheck').textContent()).trim(),'Ferdig med denne');
  await tap(page,'#skipCheck','finished current check');assert.equal(await page.evaluate(()=>learningSession.check.done),false);
  await tap(page,'#skipCheck','skip current check');
  await tap(page,'#doneBtn','Ferdig med leksa (practice)');await page.locator('#go').waitFor();assert.equal(api.calls.length,0);
  note('start screen: child selector, mode tabs, photo/text tabs, practice buttons, practice check skip/finish');

  // ---------- REPRODUCE THE OBSERVED SCREEN ----------
  await page.locator('#hwT').fill('Hva er 8 × 8?');await tap(page,'#go','start button');await idle(page);
  assert.equal(api.calls.length,1);await page.waitForFunction(()=>speakingIdx!==null);
  let st=await state(page);
  assert.equal(await page.locator('.ladder-label').textContent(),'Et hint · velg hjelp når du vil');
  assert.equal(st.s,2);assert.equal(st.attempts,0);assert.equal(await page.evaluate(()=>kid().age),8);
  assert.ok((await page.locator('#chatBox').textContent()).includes('Vet du hva 8 ganger 5 er?'));
  await page.screenshot({path:resolve(artifacts,'ux1-observed-state.png'),animations:'disabled'});
  // Existing policy: rung n>2 is locked while support < n-1 and the child has not tried; 1, 2, «Jeg vet ikke», pause always open.
  const policy={1:false,2:false,3:false,4:true,'Jeg vet ikke':false,'Pause / for vanskelig':false};
  for(const [name,selector] of QUICK){const want=policy[name.match(/^\d/)?.[0]]??policy[name];assert.equal(await disabled(page,selector),want,`${name}: policy state at S2 without attempts`);}
  const enabledQb=await looksEnabled(page,'#quick [data-help="3"]','3. Mindre steg');
  await looksDisabled(page,'#quick [data-help="4"]',enabledQb,'4. Vis et eksempel');
  note('observed state S2/no attempt: 1-3, Jeg vet ikke, pause ENABLED; 4 DISABLED and visibly disabled');
  // A disabled rung cannot activate under a real tap.
  st=await state(page);await tap(page,'#quick [data-help="4"]','4. Vis et eksempel (disabled)');
  assert.deepEqual(await state(page),st,'disabled rung changed state');assert.equal(api.calls.length,1);

  // Soft guard (age 8+, no attempt yet) is existing policy: the first tap answers locally, no provider call.
  await tap(page,'#quick [data-help="1"]','1. Lite puff');
  assert.equal(api.calls.length,1);assert.match((await state(page)).last,/^Prøv ett steg først\?/);
  // Second tap sends, and the whole quick bar is inert and visibly so while the reply is pending.
  const release=hold(api);
  await tap(page,'#quick [data-help="1"]','1. Lite puff (after soft guard)');
  await page.waitForFunction(()=>busy);for(let i=0;i<100&&api.calls.length<2;i++)await page.waitForTimeout(20);assert.equal(api.calls.length,2);
  assert.equal(await page.evaluate(()=>chatMsgs.filter(m=>m.role==='user'&&!m.sys).at(-1).text),HELP_TEXT[1]);
  for(const [name,selector] of QUICK){assert.equal(await disabled(page,selector),true,`${name}: must be disabled while a reply is pending`);await looksDisabled(page,selector,enabledQb,name+' (busy)');}
  for(const [selector,name] of [['#checkHomework','check homework'],['#nextLearningTask','next subtask']]){assert.equal(await disabled(page,selector),true,`${name}: must be disabled while busy`);await looksDisabled(page,selector,enabledQb,name+' (busy)');}
  for(const id of ['backBtn','newBtn','cogBtn']){assert.equal(await disabled(page,'#'+id),true);const s=await style(page,'#'+id);assert.ok(s.opacity<=.65&&s.cursor==='not-allowed',`#${id}: busy header button looks active`);}
  for(const id of ['sendBtn','micBtn','doneBtn']){assert.equal(await disabled(page,'#'+id),true);assert.ok((await style(page,'#'+id)).opacity<=.65,`#${id}: busy control looks active`);}
  st=await state(page);
  await tap(page,'#stuckBtn','Jeg vet ikke (busy)');await tap(page,'#pauseLearning','pause (busy)');await tap(page,'#quick [data-help="2"]','2. Lite hint (busy)');
  assert.deepEqual(await state(page),st,'a busy-state tap changed state');assert.equal(api.calls.length,2);
  release();await idle(page);
  note('busy: every quick/panel/header/footer control disabled, visibly disabled, taps inert');

  // After an attempt every rung opens (existing policy) and each enabled control receives exactly one action per tap.
  assert.equal((await state(page)).attempts,1);
  for(const [name,selector] of QUICK)assert.equal(await disabled(page,selector),false,`${name}: enabled after an attempt`);
  await sendsOnce(page,api,'#stuckBtn','Jeg vet ikke',HELP_TEXT[2]);
  await sendsOnce(page,api,'#quick [data-help="2"]','2. Lite hint',HELP_TEXT[2]);
  await sendsOnce(page,api,'#quick [data-help="3"]','3. Mindre steg',HELP_TEXT[3]);
  await sendsOnce(page,api,'#quick [data-help="4"]','4. Vis et eksempel',HELP_TEXT[4]);
  assert.equal(await page.locator('.ladder-label').textContent(),'Et eksempel · velg hjelp når du vil');
  note('enabled quick-help, Jeg vet ikke: one provider request and one child message per tap');

  // ---------- CHAT FOOTER, SPEAKER, MICROPHONE ----------
  await page.waitForFunction(()=>speakingIdx!==null);
  await tap(page,'.spk.on','speaker stop');assert.equal(await page.evaluate(()=>speakingIdx),null);
  await tap(page,'#chatBox .spk >> nth=-1','speaker read aloud');await page.waitForFunction(()=>speakingIdx!==null);
  assert.equal(await page.locator('.spk.on').getAttribute('aria-label'),'Stopp opplesing');
  await tap(page,'#micBtn','microphone start');await page.waitForFunction(()=>listening);assert.deepEqual(await page.evaluate(()=>__mic),['start']);
  await page.evaluate(()=>__rec.onresult({results:[[{transcript:'førti'}]]}));assert.equal(await page.locator('#msg').inputValue(),'førti');
  await tap(page,'#micBtn','microphone stop');await page.waitForFunction(()=>!listening);
  await sendsOnce(page,api,'#sendBtn','send','førti');
  note('send, microphone (DOM-level), speaker read-aloud/stop');

  // ---------- LEARNING PANEL ----------
  await tap(page,'#checkHomework','check homework');assert.equal(await page.evaluate(()=>learningSession.answerTarget?.expression),'8*8');
  await tap(page,'#cancelAnswerTarget','cancel answer target');assert.equal(await page.evaluate(()=>learningSession.answerTarget),null);
  await tap(page,'#checkHomework','check homework');await page.locator('#msg').fill('64');
  const callsBeforeOwn=api.calls.length;await tap(page,'#sendBtn','send own answer');assert.equal(api.calls.length,callsBeforeOwn);
  await tap(page,'#trySelf','Prøv én lignende oppgave selv');assert.equal(await page.evaluate(()=>learningSession.check?.kind),'prøv');
  await tap(page,'#skipCheck','skip current check');assert.equal(await page.evaluate(()=>learningSession.check),null);
  await page.evaluate(()=>{learningSession.transferOffer=L.generate('times69',7,'');render();});
  await tap(page,'#skipTransfer','skip transfer');assert.equal(await page.evaluate(()=>learningSession.transferOffer),null);
  const taskCount=await page.evaluate(()=>learningSession.taskCount);
  await tap(page,'#nextLearningTask','next subtask');assert.equal(await page.evaluate(()=>learningSession.taskCount),taskCount+1);
  await tap(page,'.learning-panel details > summary','reflection summary');await tap(page,'#reflection','reflection selector');
  await page.locator('#reflection').selectOption('Dele opp');assert.equal(await page.evaluate(()=>learningSession.reflection),'Dele opp');
  assert.equal(api.calls.length,callsBeforeOwn);
  note('learning panel: check homework, cancel target, try similar, skip transfer, skip check, next subtask, reflection');

  // ---------- PAUSE / RESUME, HEADER ----------
  await tap(page,'#pauseLearning','Pause / for vanskelig');assert.equal(await page.evaluate(()=>view),'start');
  assert.match(await page.locator('main').textContent(),/Vi tar pause/);
  await tap(page,'#resumeBtn','continue saved session');assert.equal(await page.evaluate(()=>view),'chat');
  await tap(page,'#voiceBtn','voice toggle off');assert.equal(await page.evaluate(()=>voiceOn),false);
  await tap(page,'#voiceBtn','voice toggle on');assert.equal(await page.evaluate(()=>voiceOn),true);
  await tap(page,'#backBtn','back');assert.equal(await page.evaluate(()=>view),'start');
  await tap(page,'#resumeBtn','continue saved session');
  await tap(page,'#cogBtn','settings');assert.equal(await page.evaluate(()=>view),'setup');
  await tap(page,'#saveBtn','settings save');await tap(page,'#resumeBtn','continue saved session');
  const finishCalls=api.calls.length;
  await tap(page,'#doneBtn','Ferdig med leksa');await page.locator('#go').waitFor();
  assert.equal(api.calls.length,finishCalls+1);assert.match(await page.locator('main').textContent(),/Økten er ferdig og lagret/);
  await page.locator('#hwT').fill('Hva er 6 × 7?');await tap(page,'#go','start button');await idle(page);
  const archived=await page.evaluate(()=>kid().sessions.length);await tap(page,'#newBtn','new task');assert.equal(await page.evaluate(()=>view),'start');assert.equal(await page.evaluate(()=>kid().sessions.length),archived+1);
  note('header: voice toggle, back, new task, settings; pause, resume, Ferdig med leksa');

  // Confidence selector: delayed review check, age 8.
  await page.evaluate(()=>{L.event(kid().learning,'sub1',{t:Date.now()-2*L.DAY,s:0,ok:true,k:'task',sid:'prior',id:'prior',verified:true});saveKids();render();});
  await tap(page,'.practice > summary','practice summary');await tap(page,'#reviewStart','practice review');
  await tap(page,'#confidence','confidence selector');await page.locator('#confidence').selectOption('usikker');
  assert.equal(await page.evaluate(()=>learningSession.confidence),'usikker');
  note('confidence selector in delayed review');

  // ---------- NARROW-WIDTH LAYOUT MATRIX ----------
  await page.evaluate(()=>{stopSpeak();});
  const layout=[];
  for(const [width,height] of [[320,640],[320,740],[360,640],[390,844],[412,640],[412,915]]){
    await page.setViewportSize({width,height});
    await page.evaluate(text=>{
      chatMsgs=Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',text:i%2?text:'Svar '+i,ts:Date.now()}));
      const s=ensureLearning();s.check=null;s.practice=false;s.answerTarget=null;s.transferOffer=null;s.task.completed=false;s.task.expression='8*8';s.task.attempts=1;s.task.s=2;
      view='chat';busy=false;render();
    },REPLY);
    // Chat scrolled away from the bottom: bars must stay operable.
    await page.evaluate(()=>{main.scrollTop=0;});
    for(const [name,selector] of QUICK)await operable(page,selector,`${name} @${width}x${height}`);
    for(const [selector,name] of [['#doneBtn','Ferdig med leksa'],['#msg','message box'],['#sendBtn','send'],['#micBtn','microphone'],['#voiceBtn','voice'],['#backBtn','back'],['#newBtn','new task'],['#cogBtn','settings']])await operable(page,selector,`${name} @${width}x${height}`);
    for(const [selector,name] of [['.row:nth-child(2) .spk','speaker (scrolled)'],['#checkHomework','check homework'],['#nextLearningTask','next subtask'],['.learning-panel details > summary','reflection']])await operable(page,selector,`${name} @${width}x${height}`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`horizontal overflow @${width}`);
    const q=await page.evaluate(()=>({quick:Math.round(quick.getBoundingClientRect().height),overflow:quick.scrollHeight>quick.clientHeight+1,main:Math.round(main.getBoundingClientRect().height)}));
    assert.ok(q.main>=120,`chat viewport collapsed to ${q.main}px @${width}x${height}`);
    // Operable after scrolling the chat: a real tap still reaches the bar.
    await page.evaluate(()=>{main.scrollTop=0;});await sendsOnce(page,api,'#stuckBtn',`Jeg vet ikke @${width}x${height}`,HELP_TEXT[2]);
    layout.push({width,height,...q});
  }
  await page.setViewportSize({width:360,height:740});await page.screenshot({path:resolve(artifacts,'ux1-mobile-quick.png'),animations:'disabled'});
  note('320-412 px widths: every critical chat control unobscured, inside #app, >=24 px, tappable after chat scroll');
  assert.deepEqual(api.errors,[]);const touchErrors=api.errors;await context.close();

  // ---------- MOUSE AND KEYBOARD STILL WORK ----------
  const desk=await newPage(browser,{viewport:{width:1024,height:800}});
  await desk.page.locator('#kidPick [data-i="1"]').click();await desk.page.locator('#modeTabs [data-t="matte"]').click();await desk.page.locator('#inTabs [data-m="text"]').click();
  await desk.page.locator('#hwT').fill('Hva er 8 × 8?');await desk.page.locator('#go').click();await idle(desk.page);
  assert.equal(await desk.page.locator('#quick [data-help="4"]').isDisabled(),true);
  await desk.page.locator('#quick [data-help="3"]').focus();await desk.page.keyboard.press('Tab');
  assert.equal(await desk.page.evaluate(()=>document.activeElement.id),'stuckBtn','Tab skips the disabled rung');
  assert.notEqual(await desk.page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'none','keyboard focus is visible');
  await desk.page.locator('#quick [data-help="1"]').click();await idle(desk.page);assert.equal(desk.api.calls.length,2,'mouse click: one request');
  await desk.page.locator('#quick [data-help="2"]').focus();await desk.page.keyboard.press('Enter');await idle(desk.page);assert.equal(desk.api.calls.length,3,'Enter: one request');
  await desk.page.locator('#quick [data-help="3"]').focus();await desk.page.keyboard.press(' ');await idle(desk.page);assert.equal(desk.api.calls.length,4,'Space: one request');
  assert.deepEqual(desk.api.errors,[]);await desk.context.close();
  note('desktop mouse click, keyboard Enter/Space, Tab skips disabled, visible focus');

  console.log(JSON.stringify({result:'PASS',checks,layout,pageErrors:touchErrors,screenshots:['tests/artifacts/ux1-observed-state.png','tests/artifacts/ux1-mobile-quick.png']}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
