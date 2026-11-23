import test from 'node:test';
import assert from 'node:assert/strict';
import {frontend,pairedStorage} from './helpers.mjs';

const el=(f,id)=>f.w.document.getElementById(id);
const reply=(text='Prøv én gang til.')=>Response.json({text,provider:'gemini'});
const snapshot=f=>({...f.w.localStorage});
const pendingSession={
  id:'recovery-fixture',kid:0,mode:'matte',ts:Date.now(),transcript:'',pendingTurn:true,
  chatMsgs:[{role:'user',text:'Regn ut 2 + 3'},{role:'assistant',text:'Prøv å telle.'},{role:'user',text:'Jeg prøvde med fingrene.'}],
  history:[{role:'user',content:'Regn ut 2 + 3'},{role:'assistant',content:'Prøv å telle.'},{role:'user',content:'Jeg prøvde med fingrene.'}]
};
function fixture(t,options={}){
  const f=frontend(options);
  t.after(()=>f.dom.window.close());
  return f;
}
function failWrite(f,blockedKey){
  const write=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value){
    if(key===blockedKey)throw Error('QuotaExceededError');
    return write.call(this,key,value);
  };
  return ()=>{f.w.Storage.prototype.setItem=write;};
}

test('abandoning a pending reply requires a successful save and preserves both child messages exactly once',async t=>{
  const calls=[];
  const f=fixture(t,{storage:{...pairedStorage,spark_session_0:pendingSession}});
  f.w.SpeechRecognition=class {};
  f.app.resumeSession();
  for(const id of ['msg','sendBtn','micBtn','stuckBtn'])assert.equal(el(f,id).disabled,true,id);
  const recover=failWrite(f,'spark_session_0');
  assert.ok(el(f,'continueTurn'),'pending recovery offers a way to continue');
  el(f,'continueTurn').click();
  assert.ok(el(f,'retryTurn'));
  assert.match(el(f,'status').textContent,/Kunne ikke lagre/);
  assert.equal(f.app.loadSession().pendingTurn,true);
  for(const id of ['msg','sendBtn','micBtn','stuckBtn'])assert.equal(el(f,id).disabled,true,id);
  recover();
  el(f,'continueTurn').click();
  assert.equal(f.app.loadSession().pendingTurn,false);
  assert.equal(el(f,'retryTurn'),null);
  for(const id of ['msg','sendBtn','micBtn','stuckBtn'])assert.equal(el(f,id).disabled,false,id);

  const g=fixture(t,{storage:snapshot(f),fetch:async(url,options)=>{
    calls.push(JSON.parse(options.body).messages);
    return reply();
  }});
  g.app.resumeSession();
  assert.equal(el(g,'msg').disabled,false);
  assert.deepEqual(calls,[]);
  el(g,'msg').value='Hva gjør jeg nå?';
  await g.app.send();
  assert.deepEqual(calls[0],[
    ...pendingSession.history.slice(0,2),
    {role:'user',content:'Jeg prøvde med fingrene.\n\nHva gjør jeg nå?'}
  ]);
  const saved=g.app.loadSession();
  assert.deepEqual(Array.from(saved.chatMsgs.filter(m=>m.role==='user'),m=>m.text),
    ['Regn ut 2 + 3','Jeg prøvde med fingrene.','Hva gjør jeg nå?']);
  assert.equal(saved.chatMsgs.length,5);
});

test('start drafts follow their child across backgrounding and reopen, and clear only after a durable start',async t=>{
  const f=fixture(t,{storage:{...pairedStorage,spark_kids:[{name:'Barn A'},{name:'Barn B'}]},fetch:async()=>reply()});
  const select=(f,selector)=>f.w.document.querySelector(selector).click();
  const type=(f,text)=>{
    el(f,'hwT').value=text;
    el(f,'hwT').dispatchEvent(new f.w.Event('input'));
  };
  select(f,'#modeTabs [data-t="matte"]');
  select(f,'#inTabs [data-m="text"]');
  type(f,'Regn ut 2 + 3');
  Object.defineProperty(f.w.document,'hidden',{value:true,configurable:true});
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
  select(f,'#kidPick [data-i="1"]');
  assert.equal(el(f,'hwT'),null);
  select(f,'#modeTabs [data-t="lesing"]');
  select(f,'#inTabs [data-m="text"]');
  type(f,'\nLes teksten til Barn B.');
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  const g=fixture(t,{storage:snapshot(f),fetch:async()=>reply()});
  assert.equal(el(g,'hwT')?.value,'\nLes teksten til Barn B.');
  assert.equal(g.w.document.querySelector('#modeTabs .on').dataset.t,'lesing');
  select(g,'#kidPick [data-i="0"]');
  assert.equal(el(g,'hwT')?.value,'Regn ut 2 + 3');
  assert.equal(g.w.document.querySelector('#modeTabs .on').dataset.t,'matte');
  assert.equal(el(g,'who').textContent,'Barn A • Matte');
  const recover=failWrite(g,'spark_session_0');
  await g.app.start();
  const h=fixture(t,{storage:snapshot(g)});
  assert.equal(el(h,'hwT').value,'Regn ut 2 + 3');
  recover();
  await el(g,'retryTurn').onclick();
  const k=fixture(t,{storage:snapshot(g)});
  assert.ok(el(k,'resumeBtn'));
  assert.equal(el(k,'hwT').value,'');
  select(k,'#kidPick [data-i="1"]');
  assert.equal(el(k,'hwT').value,'\nLes teksten til Barn B.');
});

async function checkedAnswer(t,blockedKey){
  const f=fixture(t,{storage:pairedStorage,fetch:async()=>reply('Se på enerne.')});
  f.app.set("taskMode='matte';inputMode='text';hwText='2 + 3'");
  await f.app.start();
  el(f,'checkHomework').click();
  const recover=failWrite(f,blockedKey);
  el(f,'msg').value='5';
  await f.app.send();
  assert.match(f.app.state().chatMsgs.at(-1).text,/Du fant svaret/);
  return {f,recover};
}
const savedEvidence=f=>JSON.parse(f.w.localStorage.getItem('spark_kids'))[0].learning.skills.add1?.ev||[];

test('a failed chat snapshot cannot commit learning evidence ahead of the answer',async t=>{
  const {f,recover}=await checkedAnswer(t,'spark_session_0');
  const g=fixture(t,{storage:snapshot(f)});
  g.app.resumeSession();
  assert.equal(g.app.state().learningSession.task.completed,false);
  assert.equal(savedEvidence(g).length,0);
  assert.ok(!g.app.state().chatMsgs.some(m=>m.role==='user'&&m.text==='5'));
  recover();
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  const h=fixture(t,{storage:snapshot(f)});
  h.app.resumeSession();
  assert.equal(h.app.state().learningSession.task.completed,true);
  assert.equal(savedEvidence(h).length,1);
  assert.equal(h.app.state().chatMsgs.filter(m=>m.role==='user'&&m.text==='5').length,1);
});

test('a saved answer repairs a failed learning write on reopen without double credit',async t=>{
  const {f}=await checkedAnswer(t,'spark_kids');
  assert.equal(savedEvidence(f).length,0);
  const g=fixture(t,{storage:snapshot(f)});
  g.app.resumeSession();
  assert.equal(g.app.state().learningSession.task.completed,true);
  assert.equal(savedEvidence(g).length,1);
  const h=fixture(t,{storage:snapshot(g)});
  h.app.resumeSession();
  assert.equal(savedEvidence(h).length,1);
  assert.equal(h.app.state().learningSession.events.length,1);
});

test('retrying a reopened follow-up sends the original turn once',async t=>{
  const calls=[];
  const f=fixture(t,{storage:{...pairedStorage,spark_session_0:pendingSession},fetch:async(url,options)=>{
    calls.push(JSON.parse(options.body).messages);
    return reply();
  }});
  f.app.resumeSession();
  await el(f,'retryTurn').onclick();
  assert.deepEqual(calls,[pendingSession.history]);
  assert.equal(f.app.loadSession().chatMsgs.filter(m=>m.text==='Jeg prøvde med fingrene.').length,1);
  assert.equal(el(f,'continueTurn'),null);
});

test('a photo turn and the next typed message share a provider turn without losing the image',async t=>{
  const image={type:'image',source:{type:'base64',media_type:'image/jpeg',data:'YWJj'}};
  const saved={...pendingSession,chatMsgs:[{role:'user',text:'Bilde sendt!',sys:true}],
    history:[{role:'user',content:[image,{type:'text',text:'Les oppgaven.'}]}]};
  let request;
  const f=fixture(t,{storage:{...pairedStorage,spark_session_0:saved},fetch:async(url,options)=>{
    request=JSON.parse(options.body);
    return reply();
  }});
  f.app.resumeSession();
  assert.ok(el(f,'continueTurn'));
  el(f,'continueTurn').click();
  el(f,'msg').value='Se på første linje.';
  await f.app.send();
  assert.deepEqual(request.messages,[{role:'user',content:[image,{type:'text',text:'Les oppgaven.\n\nSe på første linje.'}]}]);
  assert.equal(f.app.loadSession().chatMsgs.filter(m=>m.role==='user').length,2);
});

test('failed draft cleanup cannot resurrect a started task after archiving',async t=>{
  const f=fixture(t,{storage:pairedStorage,fetch:async()=>reply()});
  f.w.document.querySelector('#inTabs [data-m="text"]').click();
  el(f,'hwT').value='Oppgaven er å telle epler.';
  el(f,'hwT').dispatchEvent(new f.w.Event('input'));
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  failWrite(f,'spark_task_draft_0');
  await f.app.start();
  assert.ok(f.app.loadSession().startedDraftId);
  el(f,'newBtn').click();
  assert.equal(JSON.parse(f.w.localStorage.getItem('spark_task_draft_0')).text,'Oppgaven er å telle epler.');
  const g=fixture(t,{storage:snapshot(f)});
  assert.equal(el(g,'hwT').value,'');
  assert.ok(el(g,'histBtn'));
});

test('word review progress recovers with the saved answer after a failed profile write',async t=>{
  const f=fixture(t,{storage:pairedStorage});
  f.app.set("saveWord({word:'house',meaning:'hus',sentence:''});saveKids()");
  f.app.startPractice('words');
  failWrite(f,'spark_kids');
  el(f,'msg').value='house';
  await f.app.send();
  assert.equal(f.app.state().kids[0].learning.items[0].ev.length,0);
  const g=fixture(t,{storage:snapshot(f)});
  g.app.resumeSession();
  assert.equal(g.app.state().learningSession.check.done,true);
  assert.equal(g.app.state().kids[0].learning.items[0].ev.length,1);
  const h=fixture(t,{storage:snapshot(g)});
  assert.equal(h.app.state().kids[0].learning.items[0].ev.length,1);
});
