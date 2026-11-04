import test from 'node:test';
import assert from 'node:assert/strict';
import {frontend,pairedStorage} from './helpers.mjs';

/* SYNC1 page integration (jsdom). Network is a spy; the Worker side is covered in sync1.test.mjs and the Chromium check. */
const MIGRATED={spark_learning_migration:'spark-c3-learning-v1'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const spy=()=>{const calls=[];return {calls,fetch:async(url,init={})=>{calls.push({url:String(url),init});return Response.json({text:'Hva tror du?',provider:'gemini'});}};};
// Each test closes its window even when an assertion fails (an open window keeps its timers, and the process, alive).
async function page(options,fn){const f=frontend(options);try{await fn(f);}finally{f.dom.window.close();}}
const SHARED="kid().name='Ada';kid().id='C'.repeat(21)+'A';kid().sync={v:1,cp:{st:null},log:[],pending:[],seen:[]};saveKids();";
const STATE=JSON.stringify({v:1,key:'KEY-NEVER-EXPORTED',gen:'G'.repeat(21)+'A',cursor:3});

test('default OFF: no sync UI, no /sync request, no sync data on children for existing users',async()=>{
  const net=spy();
  await page({storage:pairedStorage,fetch:net.fetch},async f=>{
    f.app.set("kid().name='Ada';L.event(kid().learning,'add1',{t:Date.now(),s:0,ok:true,k:'task',sid:'x',id:'x1',verified:true});saveKids();view='setup';render();");
    assert.equal(f.w.document.getElementById('syncSection'),null);
    assert.match(f.w.document.getElementById('main').textContent,/synkroniseres ikke mellom enheter/);
    f.app.set("view='chat';chatMsgs=[{role:'user',text:'7+5'},{role:'assistant',text:'Hva tror du?'}];initHomeworkLearning('7+5');learningSession.task.attempts=1;recordLearning(true,true);archiveSession('');view='start';");
    await wait(1700);
    assert.ok(net.calls.every(c=>!c.url.includes('/sync/')),'no sync request');
    assert.equal(f.w.localStorage.getItem('spark_sync'),null);
    const kids=JSON.parse(f.w.localStorage.getItem('spark_kids'));assert.equal(kids[0].sync,undefined);assert.equal(kids[0].id,undefined);
    assert.equal(kids[0].learning.sessions.length,1,'ordinary single-device behaviour unchanged');
  });
});

test('lab opt-in shows the section; sync talks only to the build Worker, never to the ⚙️ address',async()=>{
  const net=spy();
  await page({storage:{spark_sync_lab:'1',spark_server_url:'https://evil.example',spark_device_server:'https://evil.example',spark_device_token:'evil'},fetch:net.fetch},async f=>{
    f.app.set("view='setup';render();");const d=f.w.document;
    assert.ok(d.getElementById('syncCreate'));assert.ok(d.getElementById('syncJoin'));
    assert.match(d.getElementById('syncStatus').textContent,/ikke koblet til Spark-serveren/);
    d.getElementById('syncCode').value='fixture-family';await d.getElementById('syncCreate').onclick({currentTarget:d.getElementById('syncCreate')});
    assert.ok(f.alerts.some(a=>/Koble denne telefonen/.test(a)));
    assert.ok(net.calls.every(c=>!c.url.includes('/sync/')),'nothing sent to the ⚙️ server');
  });
});

test('backups of a shared child carry no sync identity, queue, checkpoint or key',async()=>{
  await page({storage:{...pairedStorage,spark_sync:STATE}},async f=>{
    f.app.set(SHARED);
    const text=JSON.stringify(f.app.learningExport());
    for(const m of ['"sync"','"pending"','"seen"','KEY-NEVER-EXPORTED','CCCCCCCC'])assert.ok(!text.includes(m),m);
  });
});

test('malformed stored sync data never deletes a child: it stays as a local copy',async()=>{
  const kid={name:'Ada',age:9,interests:'',notes:[],log:[],sessions:[],learning:{version:3,skills:{},items:[],sessions:[],totals:{cold:0,independentCold:0}},id:'C'.repeat(21)+'A',sync:{v:1,cp:{st:{evil:true}},log:'x',pending:[],seen:[]}};
  await page({storage:{...pairedStorage,...MIGRATED,spark_kids:JSON.stringify([kid])}},async f=>{
    const k=f.app.state().kids[0];assert.equal(k.name,'Ada');assert.equal(k.sync,undefined);assert.equal(k.fork,true);
  });
});

test('removing a child shifts unfinished-session keys and the active index without losing other children',async()=>{
  await page({storage:pairedStorage},async f=>{
    f.app.set(`kids=[{...blankKid('A')},{...blankKid('B')},{...blankKid('C')}];active=2;saveKids();
      store.setItem(sessionKey(1),JSON.stringify({id:'s-b',kid:1,mode:'matte',transcript:'',chatMsgs:[{role:'user',text:'B'}],history:[{role:'user',content:'B'}],ts:Date.now()}));
      store.setItem(sessionKey(2),JSON.stringify({id:'s-c',kid:2,mode:'matte',transcript:'',chatMsgs:[{role:'user',text:'C'}],history:[{role:'user',content:'C'}],ts:Date.now()}));
      syncRemoveKid(kids[0]);`);
    const s=f.app.state();assert.equal(JSON.stringify(s.kids.map(k=>k.name)),'["B","C"]');assert.equal(s.active,1);
    assert.equal(f.app.loadSession(0).id,'s-b');assert.equal(f.app.loadSession(1).id,'s-c');assert.equal(f.w.localStorage.getItem('spark_session_2'),null);
    f.app.set("syncRemoveKid(kids[0]);syncRemoveKid(kids[0]);");assert.equal(f.app.state().kids.length,1,'never zero profiles');
  });
});

test('archiving a shared child queues reflection and summary; a failed save rolls the queue back',async()=>{
  await page({storage:{...pairedStorage,spark_sync:STATE}},async f=>{
    f.app.set(SHARED+"view='chat';taskMode='matte';chatMsgs=[{role:'user',text:'7+5'},{role:'assistant',text:'Hva tror du?'}];history=[{role:'user',content:'7+5'}];initHomeworkLearning('7+5');");
    f.app.set("learningSession.task.attempts=1;recordLearning(true,true);learningSession.task.completed=true;learningSession.reflection='Tallinje';");
    assert.equal(f.app.state().kids[0].sync.pending.length,1,'the checked answer is queued');
    const original=f.w.Storage.prototype.setItem;
    f.w.Storage.prototype.setItem=()=>{throw Error('QuotaExceededError');};
    assert.equal(f.app.archiveSession(''),false);assert.equal(f.app.state().kids[0].sync.pending.length,1,'rolled back with the archive');
    f.w.Storage.prototype.setItem=original;
    assert.equal(f.app.archiveSession(''),true);
    const queue=f.app.state().kids[0].sync.pending;assert.equal(JSON.stringify(queue.map(o=>o.p.type)),'["skill","helped","session"]');
    assert.equal(queue[2].p.session.interactions.length,0,'interaction timestamps stay on the phone');
  });
});
