import test from 'node:test';
import assert from 'node:assert/strict';
import {frontend,pairedStorage,voice,backend,environment} from './helpers.mjs';

test('Norwegian ranking filters language before defaults, names, locality or list order',()=>{
  const foreign=[voice('en-US','Norwegian-looking name',{default:true,localService:true}),voice('da-DK'),voice('sv-SE'),voice('hi-IN')];
  const preferred=['nb-NO','no-NO','nb','no','nn-NO'];
  for(let i=0;i<preferred.length;i++){
    const candidates=preferred.slice(i).reverse().map(lang=>voice(lang));
    const f=frontend({voices:[...foreign,...candidates]});
    assert.equal(f.app.pickVoice().lang,preferred[i]);f.dom.window.close();
  }
  const f=frontend({voices:[...foreign,voice('nb_NO')]});assert.equal(f.app.pickVoice().lang,'nb_NO');f.dom.window.close();
});
test('manual Bokmål choice survives empty asynchronous population and same-name distinct URIs',()=>{
  const f=frontend({storage:{spark_voice_name:'manual-uri'},voices:[]});
  assert.equal(f.app.pickVoice(),null);assert.equal(f.app.state().voiceName,'manual-uri');
  const manual=voice('nb-NO','Bokmål',{voiceURI:'manual-uri'});
  f.voices([voice('nb-NO','Bokmål',{voiceURI:'other-uri',default:true}),manual,voice('en-US')]);
  assert.equal(f.app.pickVoice(),manual);f.app.speak('Hei!',0);
  assert.equal(f.spoken[0].voice,manual);assert.equal(f.spoken[0].lang,'nb-NO');
  f.voices([]);f.voices([manual]);assert.equal(f.app.pickVoice(),manual);f.dom.window.close();
});
test('legacy saved manual name works; no Norwegian voice never speaks another language',()=>{
  const manual=voice('nb-NO','Norsk bokmål',{voiceURI:'new-uri'});
  const f=frontend({voices:[manual],storage:{spark_voice_name:manual.name}});assert.equal(f.app.pickVoice(),manual);f.dom.window.close();
  const g=frontend({voices:[voice('en-US','Norsk',{default:true})]});g.app.speak('Hei!',0);
  assert.equal(g.spoken.length,0);assert.match(g.w.document.getElementById('status').textContent,/Ingen norsk stemme/);g.dom.window.close();
});
test('voiceschanged and speech callbacks preserve unsaved setup fields',()=>{
  const f=frontend();const doc=f.w.document;
  doc.getElementById('fName').value='Ulagret navn';doc.getElementById('fFamily').value='private-fixture-code';
  f.voices([voice('nb-NO')]);assert.equal(doc.getElementById('fName').value,'Ulagret navn');assert.equal(doc.getElementById('fFamily').value,'private-fixture-code');
  f.app.speak('Hei',-1);f.spoken[0].onstart();f.spoken[0].onend();assert.equal(doc.getElementById('fName').value,'Ulagret navn');f.dom.window.close();
});
test('default server pairing needs no URL; override validation and settings persist',async()=>{
  const calls=[];const f=frontend({fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return Response.json({token:'new-fixture-device'});}});
  const d=f.w.document;assert.equal(f.app.state().serverUrl,'https://spark-family-api.drasse.workers.dev');
  d.getElementById('fName').value='Barn A';d.getElementById('fFamily').value='family-fixture';
  await d.getElementById('pairBtn').onclick();assert.equal(calls[0].url,'https://spark-family-api.drasse.workers.dev/pair');
  assert.equal(calls[0].body.code,'family-fixture');assert.equal(f.w.localStorage.getItem('spark_device_token'),'new-fixture-device');
  assert.ok(!JSON.stringify({...f.w.localStorage}).includes('family-fixture'));
  assert.ok(f.app.validServer('https://spark.test'));assert.ok(f.app.validServer('http://localhost:8787'));
  for(const url of ['javascript:alert(1)','http://evil.test','https://a.test/chat','https://u:p@a.test','https://a.test?key=x']) assert.equal(f.app.validServer(url),false,url);
  d.getElementById('fServer').value='https://dev.test';d.getElementById('fFun').value='Fotball';assert.ok(f.app.saveForm());
  assert.equal(f.w.localStorage.getItem('spark_server_url'),'https://dev.test');assert.equal(f.app.state().kids[0].interests,'Fotball');f.dom.window.close();
});
test('all modes send Worker-compatible structured requests with only eight newest notes',async()=>{
  const sent=[];const f=frontend({storage:pairedStorage,fetch:async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({text:'Hei',provider:'gemini'});}});
  const b=backend(()=>{});f.app.set("kid().notes=Array.from({length:12},(_,i)=>'notat '+i)");
  for(const mode of ['lekse','matte','lesing','quiz']){
    f.app.set(`taskMode='${mode}'`);await f.app.callAI([{role:'user',content:'Oppgave'}]);
    const request=sent.at(-1);assert.equal(b.api.validatePayload(request),'');assert.ok(!('system' in request));assert.equal(request.notes.length,8);assert.equal(request.notes[0],'notat 4');
  }
  f.dom.window.close();
});
test('photo survives failed first response/reload; transcript replaces image in subsequent requests',()=>{
  const f=frontend({storage:pairedStorage});
  f.app.set(`taskMode='matte';chatMsgs=[{role:'user',text:'📸 Bilde sendt!'}];history=[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'YWJj'}},{type:'text',text:'Les bildet'}]}];view='chat'`);
  assert.ok(f.app.saveSession());const saved=f.w.localStorage.getItem('spark_session_0');assert.ok(saved.includes('YWJj'));
  const g=frontend({storage:{...pairedStorage,spark_session_0:saved}});g.app.resumeSession();assert.ok(JSON.stringify(g.app.payload()).includes('YWJj'));assert.equal(g.app.state().taskMode,'matte');
  g.app.harvest('Her er starten. [[OPPGAVE: 2 + 3]]');const payload=g.app.payload();assert.ok(!JSON.stringify(payload).includes('YWJj'));assert.ok(JSON.stringify(payload).includes('2 + 3'));
  g.app.saveSession();assert.ok(!g.w.localStorage.getItem('spark_session_0').includes('YWJj'));f.dom.window.close();g.dom.window.close();
});
test('initial request is autosaved and late answers cannot navigate into another profile',async()=>{
  let resolve;const reply=new Promise(r=>resolve=r);const f=frontend({storage:pairedStorage,fetch:()=>reply});
  f.app.set("inputMode='text';hwText='Regn 2 + 3'");const task=f.app.start();
  assert.ok(f.w.localStorage.getItem('spark_session_0'));assert.equal(f.app.state().busy,true);
  f.w.document.getElementById('cogBtn').onclick();f.w.document.getElementById('backBtn').onclick();f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
  assert.equal(f.app.state().view,'chat');assert.equal(f.w.document.getElementById('cogBtn').disabled,true);
  resolve(Response.json({text:'Se på enerne. [[PROFIL: pluss: konkreter hjalp]]',provider:'gemini'}));await task;
  assert.equal(f.app.state().busy,false);assert.equal(f.app.state().kids[0].notes.length,1);f.dom.window.close();
});
test('children have independent sessions, notes, archives and unsent drafts',()=>{
  const f=frontend({storage:pairedStorage});
  f.app.set("kids=[blankKid('A'),blankKid('B')];chatMsgs=[{role:'user',text:'Oppgave A'},{role:'assistant',text:'Svar A'}];history=[{role:'user',content:'A'}];view='chat'");
  f.app.harvest('[[PROFIL: A-notat]]');f.app.saveSession();
  f.app.set("view='start';hwText='A privat kladd';hwPreview='data:image/jpeg;base64,YWJj'");f.app.render();
  f.w.document.querySelector('#kidPick [data-i="1"]').click();assert.equal(f.app.state().active,1);assert.equal(f.app.loadSession(),null);
  f.app.set("chatMsgs=[{role:'user',text:'B'},{role:'assistant',text:'Svar B'}];history=[{role:'user',content:'B'}]");f.app.harvest('[[PROFIL: B-notat]]');f.app.saveSession();assert.ok(f.app.archiveSession('B-oppsummering'));
  assert.equal(f.app.state().kids[0].sessions.length,0);assert.equal(f.app.state().kids[1].sessions.length,1);
  f.app.set('active=0');f.app.resumeSession();assert.equal(f.app.state().chatMsgs[0].text,'Oppgave A');assert.equal(f.app.state().readOnly,false);
  assert.deepEqual(Array.from(f.app.state().kids[0].notes),['A-notat']);assert.deepEqual(Array.from(f.app.state().kids[1].notes),['B-notat']);f.dom.window.close();
});
test('finish path archives summary, and unavailable providers still produce an honest local summary',async()=>{
  for(const fail of [false,true]){
    const f=frontend({storage:pairedStorage,fetch:async()=>{if(fail)throw Error('NetworkError');return Response.json({text:'Takk for i dag! [[LOGG: Pluss | brukte tiere | øv på enerne]]',provider:'gemini'});}});
    f.app.set("chatMsgs=[{role:'user',text:'Regn 2 + 3'},{role:'assistant',text:'Vi teller'}];history=[{role:'user',content:'Regn 2 + 3'},{role:'assistant',content:'Vi teller'}];view='chat'");
    await f.app.finishHomework();const s=f.app.state();assert.equal(s.view,'start');assert.equal(s.kids[0].sessions.length,1);assert.equal(f.w.localStorage.getItem('spark_session_0'),null);
    assert.match(s.kids[0].sessions[0].summary,fail?/ikke tilgjengelig/:/Pluss/);assert.ok(s.kids[0].log.length);f.dom.window.close();
  }
});
test('archive quota failure keeps chat and summary; retry uses no extra provider quota',async()=>{
  let calls=0;const f=frontend({storage:pairedStorage,fetch:async()=>{calls++;return Response.json({text:'Ha det! [[LOGG: Pluss | prøvde selv | øv mer]]',provider:'gemini'});}});
  f.app.set("chatMsgs=[{role:'user',text:'Oppgave'},{role:'assistant',text:'Svar'}];history=[{role:'user',content:'Oppgave'}];view='chat'");
  const original=f.w.Storage.prototype.setItem;f.w.Storage.prototype.setItem=function(key,value){if(key==='spark_kids')throw Error('QuotaExceededError');return original.call(this,key,value);};
  await f.app.finishHomework();assert.equal(f.app.state().view,'chat');assert.ok(f.app.state().pendingFinal);assert.equal(f.app.state().kids[0].sessions.length,0);assert.ok(f.app.state().chatMsgs.length>=3);
  assert.match(f.w.document.getElementById('status').textContent,/Kunne ikke lagre/);
  f.w.Storage.prototype.setItem=original;await f.app.finishHomework();assert.equal(calls,1);assert.equal(f.app.state().kids[0].sessions.length,1);assert.equal(f.app.state().view,'start');f.dom.window.close();
});
test('read-only archive cannot send; resume exits read-only; malformed stored data does not crash',async()=>{
  const f=frontend({storage:{...pairedStorage,spark_kids:'{"bad":true}',spark_active:'-1'}});assert.equal(f.app.state().active,0);assert.equal(f.app.state().kids.length,1);
  f.app.set("view='chat';readOnly=true");f.w.document.getElementById('msg').value='Do not send';await f.app.send();assert.equal(f.app.state().history.length,0);f.dom.window.close();
  for(const value of ['null','[null,3]','[{"name":4,"notes":[{}],"sessions":[{}]}]']){
    const g=frontend({storage:{spark_kids:value,spark_active:'NaN'}});assert.equal(g.app.state().active,0);g.dom.window.close();
  }
});
test('provider 401 with kind retains device; actual expired device unpairs',async()=>{
  for(const kind of ['provider_error','']){
    const f=frontend({storage:pairedStorage,fetch:async()=>Response.json({error:'Error',...(kind?{kind}:{})},{status:401})});
    await assert.rejects(f.app.callAI([{role:'user',content:'x'}]));assert.equal(!!f.app.state().deviceToken,!!kind);f.dom.window.close();
  }
});
test('speech input uses Bokmål; aborted recognition cannot insert another child’s answer',()=>{
  const f=frontend({storage:pairedStorage});let rec;
  f.w.SpeechRecognition=class {constructor(){rec=this;}start(){this.onstart();}abort(){}};
  f.app.set("view='chat'");f.app.toggleMic();assert.equal(rec.lang,'nb-NO');
  rec.onresult({results:[[{transcript:'Sju'}]]});assert.equal(f.w.document.getElementById('msg').value,'Sju');f.app.stopMic();assert.equal(rec.onresult,null);f.dom.window.close();
});
test('failed session cleanup cannot make a durable archive appear unfinished again',()=>{
  const f=frontend({storage:pairedStorage});
  f.app.set("chatMsgs=[{role:'user',text:'A'},{role:'assistant',text:'B'}];history=[{role:'user',content:'A'}]");f.app.saveSession();
  const original=f.w.Storage.prototype.removeItem;f.w.Storage.prototype.removeItem=function(key){if(key==='spark_session_0')throw Error('storage unavailable');return original.call(this,key);};
  assert.ok(f.app.archiveSession('Ferdig'));assert.equal(f.app.loadSession(),null);assert.equal(f.app.state().kids[0].sessions.length,1);f.dom.window.close();
});
test('client request timeout returns control and preserves pairing',async()=>{
  const f=frontend({storage:pairedStorage,fetch:(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('AbortError'))))});
  const timer=f.w.setTimeout;f.w.setTimeout=(fn,ms)=>timer(fn,ms===150000?1:ms);
  await assert.rejects(f.app.callAI([{role:'user',content:'A'}]),/brukte for lang tid/);assert.ok(f.app.state().deviceToken);f.dom.window.close();
});
test('malformed child entry cannot reindex another child into the wrong saved session',()=>{
  const session={kid:1,mode:'lekse',transcript:'',chatMsgs:[{role:'user',text:'B sin oppgave'}],history:[{role:'user',content:'B sin oppgave'}]};
  const f=frontend({storage:{...pairedStorage,spark_kids:[null,{name:'B'}],spark_active:'1',spark_session_1:session}});
  assert.equal(f.app.state().active,1);assert.equal(f.app.state().kids[1].name,'B');f.app.resumeSession();assert.equal(f.app.state().chatMsgs[0].text,'B sin oppgave');f.dom.window.close();
});
