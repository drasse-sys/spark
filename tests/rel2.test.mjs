import test from 'node:test';
import assert from 'node:assert/strict';
import {frontend,pairedStorage,read} from './helpers.mjs';

const response=text=>Response.json({text,provider:'gemini'});
const el=(f,id)=>f.w.document.getElementById(id);
const session=(kid=0,ts=Date.now())=>({
  id:'existing-'+kid,kid,ts,mode:'lekse',transcript:'',
  chatMsgs:[{role:'user',text:'My homework'},{role:'assistant',text:'Try it'}],
  history:[{role:'user',content:'My homework'},{role:'assistant',content:'Try it'}]
});

test('failed or interrupted turns retry the same saved photo or text without duplicating input',async t=>{
  const calls=[];
  const fetch=async(url,options)=>{
    calls.push(JSON.parse(options.body));
    if(calls.length===1)return Response.json({kind:'provider_error'},{status:503});
    if(calls.length===2)return Response.json(null);
    return response('Try another step');
  };
  const f=frontend({storage:pairedStorage,fetch});
  t.after(()=>f.dom.window.close());
  f.app.set("hwPreview='data:image/jpeg;base64,YWJj'");
  await f.app.start();
  assert.ok(el(f,'retryTurn'));
  const g=frontend({storage:{...f.w.localStorage},fetch});
  t.after(()=>g.dom.window.close());
  g.app.resumeSession();
  assert.ok(el(g,'sendBtn').disabled);
  await el(g,'retryTurn').onclick();
  assert.match(el(g,'chatBox').textContent,/ufullstendig/);
  await el(g,'retryTurn').onclick();
  assert.deepEqual(calls.map(c=>c.messages),[calls[0].messages,calls[0].messages,calls[0].messages]);
  assert.equal(g.app.state().chatMsgs.filter(m=>m.role==='user').length,1);
  assert.equal(el(g,'retryTurn'),null);
});

test('timeout includes response body and retry becomes available after a stalled body',async t=>{
  const f=frontend({storage:pairedStorage,fetch:async(url,{signal})=>({
    status:200,ok:true,json:()=>new Promise((resolve,reject)=>{
      const fallback=setTimeout(()=>reject(Error('body failed late')),100);
      signal.addEventListener('abort',()=>{clearTimeout(fallback);reject(Error('abort'));});
    })
  })});
  t.after(()=>f.dom.window.close());
  const timer=f.w.setTimeout;
  f.w.setTimeout=(fn,ms)=>timer(fn,ms===150000?2:ms);
  f.app.set("inputMode='text';hwText='Explain the clouds'");
  await f.app.start();
  assert.match(el(f,'chatBox').textContent,/for lang tid/);
  assert.equal(f.app.state().busy,false);
});

test('failed turn save sends nothing, failed pause keeps the draft on screen, and reload restores it',async t=>{
  let calls=0,fail=true;
  const f=frontend({storage:pairedStorage,fetch:async()=>{calls++;return response('Try one step');}});
  t.after(()=>f.dom.window.close());
  const write=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(fail&&key==='spark_session_0')throw Error('QuotaExceededError');
    return write.call(this,key,value);
  };
  f.app.set("inputMode='text';hwText='Explain the clouds'");
  await f.app.start();
  assert.equal(calls,0);
  el(f,'pauseLearning').click();
  assert.equal(f.app.state().view,'chat');
  assert.match(el(f,'status').textContent,/Kunne ikke lagre/);
  fail=false;
  await el(f,'retryTurn').onclick();
  assert.equal(calls,1);
  el(f,'msg').value='Unsent thought';
  el(f,'msg').dispatchEvent(new f.w.Event('input'));
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  const g=frontend({storage:{...f.w.localStorage}});
  t.after(()=>g.dom.window.close());
  g.app.resumeSession();
  assert.equal(el(g,'msg').value,'Unsent thought');
});

test('completion intent and failed archive survive reopening with one archive and one log entry',async t=>{
  let release;
  const f=frontend({storage:{...pairedStorage,spark_session_0:session()},fetch:()=>new Promise(r=>{release=r;})});
  t.after(()=>f.dom.window.close());
  f.app.resumeSession();
  const finishing=f.app.finishHomework();
  const g=frontend({storage:{...f.w.localStorage},fetch:async()=>response('Bra! [[LOGG: Skyer | forklarte | prøv mer]]')});
  t.after(()=>g.dom.window.close());
  g.app.resumeSession();
  assert.match(el(g,'doneBtn').textContent,/Fullfør avslutningen/);
  const write=g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem=function(key,value){
    if(key==='spark_kids')throw Error('QuotaExceededError');
    return write.call(this,key,value);
  };
  await g.app.finishHomework();
  assert.equal(g.app.state().kids[0].log.length,0);
  const h=frontend({storage:{...g.w.localStorage},fetch:async()=>assert.fail('Summary already saved')});
  t.after(()=>h.dom.window.close());
  h.app.resumeSession();
  await h.app.finishHomework();
  await h.app.finishHomework();
  assert.equal(h.app.state().kids[0].sessions.length,1);
  assert.equal(h.app.state().kids[0].log.length,1);
  assert.equal(h.app.loadSession(),null);
  release(response('Bra!'));await finishing;
});

test('failed legacy recovery leaves family unchanged and cannot leak staged work to a new child',t=>{
  const fixture=JSON.parse(read('tests/fixtures/legacy-learning.json'));
  fixture.spark_session_2.ts=Date.now();
  fixture.spark_session_0=session();
  const f=frontend({storage:fixture});
  t.after(()=>f.dom.window.close());
  f.app.set("view='setup'");f.app.render();
  const original=f.w.localStorage.getItem('spark_kids');
  const write=f.w.Storage.prototype.setItem,remove=f.w.Storage.prototype.removeItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(key==='spark_session_5')throw Error('QuotaExceededError');
    return write.call(this,key,value);
  };
  f.w.Storage.prototype.removeItem=function(key){
    if(key==='spark_session_3')throw Error('Storage unavailable');
    return remove.call(this,key);
  };
  el(f,'recoverLearning').click();
  assert.equal(f.w.localStorage.getItem('spark_kids'),original);
  assert.equal(f.app.state().kids.length,3);
  el(f,'addKid').click();
  assert.equal(f.app.state().active,3);
  assert.equal(f.app.loadSession(),null);
  assert.equal(JSON.parse(f.w.localStorage.getItem('spark_session_3')).kid,3);
});

test('failed learning deletion keeps unfinished work and a successful deletion masks a stale key',t=>{
  const f=frontend({storage:{...pairedStorage,spark_session_0:session()}});
  t.after(()=>f.dom.window.close());
  f.app.set("view='setup'");f.app.render();
  const write=f.w.Storage.prototype.setItem,remove=f.w.Storage.prototype.removeItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(key==='spark_kids')throw Error('QuotaExceededError');
    return write.call(this,key,value);
  };
  el(f,'deleteLearning').click();
  assert.equal(f.app.loadSession().id,'existing-0');
  f.w.Storage.prototype.setItem=write;
  f.w.Storage.prototype.removeItem=function(key){
    if(key==='spark_session_0')throw Error('Storage unavailable');
    return remove.call(this,key);
  };
  el(f,'deleteLearning').click();
  assert.equal(f.app.loadSession(),null);
  const g=frontend({storage:{...f.w.localStorage}});
  t.after(()=>g.dom.window.close());
  assert.equal(g.app.loadSession(),null);
});

test('early microphone cancellation and delayed recognition preserve typed input',t=>{
  const f=frontend({storage:{...pairedStorage,spark_session_0:session()}});
  t.after(()=>f.dom.window.close());
  const instances=[];
  f.w.SpeechRecognition=class {
    constructor(){instances.push(this);}
    start(){}
    abort(){this.aborted=true;}
  };
  f.app.resumeSession();
  f.app.toggleMic();
  const callback=instances[0].onresult;
  f.app.toggleMic();
  assert.equal(instances.length,1);
  assert.equal(instances[0].aborted,true);
  el(f,'msg').value='typed';
  callback({results:[[{transcript:'stale'}]]});
  assert.equal(el(f,'msg').value,'typed');
  f.app.toggleMic();
  el(f,'msg').value='typed more';
  instances[1].onresult({results:[[{transcript:'stale'}]]});
  assert.equal(el(f,'msg').value,'typed more');
});

test('returning from settings rejects a photo callback from the old start screen',async t=>{
  let resolvePhoto;
  const f=frontend({storage:pairedStorage,patch:source=>source.replace(
    'function shrink(file){','function shrink(file){ return window.deferPhoto(); } function realShrink(file){'
  )});
  t.after(()=>f.dom.window.close());
  f.w.deferPhoto=()=>new Promise(resolve=>{resolvePhoto=resolve;});
  const processing=el(f,'file').onchange({target:{files:[{}]}});
  el(f,'cogBtn').click();
  el(f,'saveBtn').click();
  resolvePhoto('data:image/jpeg;base64,YWJj');
  await processing;
  assert.equal(el(f,'go').disabled,true);
  assert.equal(f.w.document.querySelector('#drop img'),null);
});

test('expiration never drops the old session before its aggregate is durable',t=>{
  const f=frontend({storage:pairedStorage});
  t.after(()=>f.dom.window.close());
  const ts=Date.now()-31*86400000;
  const old={...session(0,ts),learning:{id:'existing-0',events:[],activeMs:7000}};
  f.w.localStorage.setItem('spark_session_0',JSON.stringify(old));
  const write=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(key==='spark_kids')throw Error('QuotaExceededError');
    return write.call(this,key,value);
  };
  assert.equal(f.app.loadSession().id,old.id);
  assert.equal(f.app.loadSession().id,old.id);
  assert.ok(f.w.localStorage.getItem('spark_session_0'));
  assert.equal(f.app.state().kids[0].learning.sessions.length,0);
  f.w.Storage.prototype.setItem=write;
  assert.equal(f.app.loadSession(),null);
  assert.equal(f.app.state().kids[0].learning.sessions[0].activeMs,7000);
});

test('a transient family read failure cannot overwrite stored children with a blank profile',t=>{
  const f=frontend({storage:{...pairedStorage,spark_kids:[{name:'Existing child'}]},patch:source=>`
    const originalRead=Storage.prototype.getItem;
    let failed=false;
    Storage.prototype.getItem=function(key){
      if(key==='spark_kids'&&!failed){failed=true;throw Error('Storage unavailable');}
      return originalRead.call(this,key);
    };
  `+source});
  t.after(()=>f.dom.window.close());
  assert.equal(JSON.parse(f.w.localStorage.getItem('spark_kids'))[0].name,'Existing child');
  assert.match(el(f,'status').textContent,/kunne ikke leses/);
});
