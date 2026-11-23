import test from 'node:test';
import assert from 'node:assert/strict';
import {frontend,pairedStorage,backend,body,environment,request,success} from './helpers.mjs';

const timingKey='spark_ai_status_v1';
const el=(f,id)=>f.w.document.getElementById(id);
const timing=f=>JSON.parse(f.w.localStorage.getItem(timingKey));
const ok=(text,timing)=>Response.json({text,provider:'gemini',model:'gemini-2.5-flash',timing});
const failed=(kind,status)=>Response.json({kind,error:'PRIVATE_PROVIDER_ERROR_TEXT'}, {status});

test('controlled response timing covers fast, normal, very slow, quota, temporary failure and retry',async t=>{
  const steps=[
    [1500,ok('Vi tar ett steg.',{serverMs:1100,multipleAttempts:false})],
    [14000,ok('Tenk litt til.')],
    [74000,ok('Prøv et annet eksempel.',{serverMs:72500,multipleAttempts:true})],
    [800,failed('daily_quota',429)],
    [8000,failed('provider_error',503)],
    [21000,ok('Vi prøver igjen.')]
  ];
  let clock=0,calls=0;
  const f=frontend({storage:pairedStorage,fetch:async()=>{
    const [elapsed,response]=steps[calls++];clock+=elapsed;return response;
  }});
  t.after(()=>f.dom.window.close());
  const wall=Date.now();
  f.w.Date.now=()=>wall+clock;
  Object.defineProperty(f.w.performance,'now',{value:()=>clock});
  const label=()=>f.app.set('responseSpeed(currentSparkTiming().success.durationMs)');
  const send=async text=>{el(f,'msg').value=text;await f.app.send();};
  f.app.set("inputMode='text';hwText='PRIVATE_HOMEWORK'; taskMode='lekse'");
  await f.app.start();
  assert.deepEqual(timing(f).success,{durationMs:1500,at:wall+1500,provider:'gemini',model:'gemini-2.5-flash',serverMs:1100,multipleAttempts:false});
  assert.equal(label(),'Raskt');
  await send('PRIVATE_CHILD_MESSAGE');
  assert.equal(timing(f).success.durationMs,14000);assert.equal(label(),'Normalt');
  await send('Et annet spørsmål');
  const lastGood=timing(f).success;
  assert.equal(lastGood.durationMs,74000);assert.equal(label(),'Svært sakte');
  assert.equal(lastGood.multipleAttempts,true);assert.equal(lastGood.serverMs,72500);

  const before=f.app.state().learningSession.events.length;
  const savedProfile=f.w.localStorage.getItem('spark_kids');
  await send('Prøv denne meldingen');
  assert.equal(timing(f).result,'daily_quota');
  assert.equal(timing(f).failure.durationMs,800);
  assert.match(el(f,'chatBox').textContent,/Dagens gratis-kvote/);
  assert.deepEqual(timing(f).success,lastGood);
  assert.equal(f.app.loadSession().pendingTurn,true);
  assert.equal(f.app.loadSession().history.at(-1).role,'user');
  assert.equal(f.app.state().learningSession.events.length,before);
  assert.equal(f.w.localStorage.getItem('spark_kids'),savedProfile);
  await el(f,'retryTurn').onclick();
  assert.equal(timing(f).result,'unavailable');
  assert.equal(timing(f).failure.durationMs,8000);
  assert.equal(f.app.state().learningSession.events.length,before);
  await el(f,'retryTurn').onclick();
  assert.equal(calls,6);
  assert.equal(timing(f).result,'normal');
  assert.equal(timing(f).success.durationMs,21000);assert.equal(label(),'Sakte');
  assert.equal(f.app.loadSession().chatMsgs.filter(m=>m.text==='Prøv denne meldingen').length,1);

  const raw=f.w.localStorage.getItem(timingKey);
  assert.ok(raw.length<512);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),['failure','result','success']);
  assert.doesNotMatch(raw,/PRIVATE_|Prøv denne meldingen/);
  const g=frontend({storage:{...f.w.localStorage}});
  t.after(()=>g.dom.window.close());
  assert.equal(g.app.set('currentSparkTiming().success.durationMs'),21000);
  assert.equal(g.app.set('currentSparkTiming().failure.durationMs'),8000);
});

test('status defines timing thresholds and isolates optional status storage failures',async t=>{
  const f=frontend({storage:{...pairedStorage,spark_voice:'0'}});
  t.after(()=>f.dom.window.close());
  assert.deepEqual(Array.from(f.app.set('[0,4999,5000,19999,20000,59999,60000].map(responseSpeed)')),
    ['Raskt','Raskt','Normalt','Normalt','Sakte','Sakte','Svært sakte']);
  const write=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(key===timingKey)throw Error('quota');
    return write.call(this,key,value);
  };
  f.app.set("inputMode='text';hwText='Oppgaven skal svare'");
  await f.app.start();
  assert.match(el(f,'chatBox').textContent,/Hva tror du/);
  assert.equal(f.app.loadSession().pendingTurn,false);
  assert.equal(f.w.localStorage.getItem(timingKey),null);
  assert.equal(f.app.set('currentSparkTiming().result'),'normal');
  assert.equal(el(f,'status').textContent,'');
});

test('a network or short-term quota result stays normalized without provider detail',async t=>{
  const f=frontend({storage:pairedStorage,fetch:async()=>{throw new TypeError('Failed to fetch: private host');}});
  t.after(()=>f.dom.window.close());
  await assert.rejects(f.app.callAI([{role:'user',content:'Oppgave'}]), /private host/);
  assert.equal(timing(f).result,'network');
  assert.equal(timing(f).success,null);
  assert.doesNotMatch(f.w.localStorage.getItem(timingKey),/private host/);
  assert.equal(f.app.set("sparkFailureKind({kind:'minute_quota',status:429})"),'minute_quota');
  assert.equal(f.app.set("sparkFailureKind({name:'TimeoutError'})"),'timeout');
});

test('the local status probe reads normally, removes its temporary key, and never edits family or learning',t=>{
  const session={id:'open-work',kid:0,mode:'lekse',transcript:'PRIVATE_TRANSCRIPT',ts:Date.now(),
    chatMsgs:[{role:'user',text:'PRIVATE_HOMEWORK'}],history:[{role:'user',content:'PRIVATE_HOMEWORK'}]};
  const f=frontend({storage:{...pairedStorage,spark_session_0:session}});
  t.after(()=>f.dom.window.close());
  const before={...f.w.localStorage};
  const check=()=>({...f.app.set('checkSparkStorage()')});
  assert.deepEqual(check(),{readable:true,writable:true,unfinished:true});
  assert.deepEqual({...f.w.localStorage},before);
  const write=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(key==='spark_status_probe')throw Error('quota');
    return write.call(this,key,value);
  };
  assert.deepEqual(check(),{readable:true,writable:false,unfinished:true});
  assert.deepEqual({...f.w.localStorage},before);
  assert.equal(el(f,'status').textContent,'');
  f.app.set("recordSparkTiming(performance.now(),'normal',{provider:'gemini',model:'PRIVATE_MODEL',text:'PRIVATE_REPLY'})");
  const {[timingKey]:savedTiming,...family}=f.w.localStorage;
  assert.deepEqual(family,before);
  assert.doesNotMatch(savedTiming,/PRIVATE_/);
});

test('Worker measures server time and counts real upstream attempts in successful metadata',async()=>{
  let calls=0;
  const b=backend(async()=>{
    calls++;
    b.statusClock+=calls===1?2100:1800;
    if(calls===1)return Response.json({error:{message:'high demand'}},{status:503});
    return success();
  },source=>'Date.now=()=>globalThis.statusClock;\n'+source);
  b.statusClock=Date.now();
  const {env}=environment();
  const token=await b.api.makeToken(env,'private-device');
  const response=await b.worker.fetch(request('/chat',body(),token),env);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.provider,'gemini');
  assert.equal(data.model,b.api.GEMINI_CHAIN[1]);
  assert.deepEqual(data.timing,{serverMs:3900,multipleAttempts:true});
  assert.doesNotMatch(JSON.stringify(data.timing),/private-device|Hjelp|fixture-provider/);
});

test('Worker reports the public backup route but withholds private configured model aliases',async()=>{
  const privateModel='private-family-model';
  let outgoing;
  const b=backend(async(url,options)=>{
    if(url.includes('googleapis.com'))return Response.json({error:{message:'daily limit'}},{status:429});
    outgoing=JSON.parse(options.body);
    return Response.json({choices:[{message:{content:'Et nytt hint.'}}]});
  });
  const {env}=environment({BACKUP_PROVIDER:'GROQ',GROQ_API_KEY:'private-provider-key',GROQ_MODEL:privateModel});
  const token=await b.api.makeToken(env,'private-device');
  const response=await b.worker.fetch(request('/chat',body(),token),env);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(outgoing.model,privateModel);
  assert.equal(data.provider,'groq');
  assert.equal(Object.hasOwn(data,'model'),false);
  assert.equal(data.timing.multipleAttempts,true);
  assert.doesNotMatch(JSON.stringify(data),/private-/);
  const health=await b.worker.fetch(request('/health'),env);
  assert.equal((await health.json()).backup,'groq');
  const unknown=await b.worker.fetch(request('/health'),{...env,BACKUP_PROVIDER:'private-config-value'});
  assert.equal((await unknown.json()).backup,'none');
});

test('successful timing includes automatic quota backoff while failure timing covers the failed request',async t=>{
  let now=0,calls=0;
  const f=frontend({storage:pairedStorage,fetch:async()=>{
    if(++calls===1){now+=1000;return failed('minute_quota',429);}
    now+=2000;return ok('Vi fortsetter.');
  }});
  t.after(()=>f.dom.window.close());
  Object.defineProperty(f.w.performance,'now',{value:()=>now});
  const timer=f.w.setTimeout.bind(f.w);
  f.w.setTimeout=(fn,ms)=>ms===30000?timer(()=>{now+=ms;fn();},0):timer(fn,ms);
  f.app.set("inputMode='text';hwText='Les denne oppgaven'");
  await f.app.start();
  assert.equal(calls,2);
  assert.equal(timing(f).success.durationMs,33000);
  assert.equal(timing(f).failure.durationMs,1000);
  assert.equal(timing(f).result,'normal');
  assert.equal(f.app.loadSession().chatMsgs.length,2);
});

test('new local timing from another tab invalidates an open tab’s cached status',t=>{
  const f=frontend({storage:pairedStorage});
  t.after(()=>f.dom.window.close());
  assert.equal(f.app.set('currentSparkTiming().success'),null);
  const value=JSON.stringify({success:{durationMs:74000,at:Date.now(),provider:'gemini'},result:'normal'});
  f.w.localStorage.setItem(timingKey,value);
  f.w.dispatchEvent(new f.w.StorageEvent('storage',{key:timingKey,newValue:value,storageArea:f.w.localStorage}));
  assert.equal(f.app.set('currentSparkTiming().success.durationMs'),74000);
});
