import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {read,frontend,pairedStorage,backend,environment,body,request,success} from './helpers.mjs';
const ctx=vm.createContext({});vm.runInContext(['arithmetic.js','learning.js','visuals.js'].map(read).join('\n'),ctx);
const {SparkLearning:L,SparkVisuals:V,SparkArithmetic:A}=ctx,base=1792600000000,DAY=L.DAY;
const plain=x=>JSON.parse(JSON.stringify(x));
async function worker(replies,backup=false){
  let calls=0;
  const b=backend(async url=>{
    if(backup&&url.includes('googleapis'))return Response.json({error:{message:'daily limit'}},{status:429});
    const text=replies[Math.min(calls++,replies.length-1)];if(text instanceof Error)throw text;
    return backup?Response.json({choices:[{message:{content:text}}]}):success(text);
  });
  const {env}=environment(backup?{BACKUP_PROVIDER:'groq',GROQ_API_KEY:'fixture-groq'}:{});
  const response=await b.worker.fetch(request('/chat',body({mode:'matte'}),await b.api.makeToken(env,'d')),env);
  assert.equal(response.status,200);return {data:await response.json(),calls};
}
const markers='[[VIS: {"type":"tierramme","n":7}]] [[LOGG: pluss | tierovergang | ingen]] [[PROFIL: pluss: dele opp hjalp]] [[PRØV: readInfo | Hva skjedde så?]] [[ORD: tier | ti enere | En tier er ti enere.]] [[STØTTE: S2 | addCarry | riktig | ingen]]';
test('B-1 correct review fixture retains fact, next step and all valid side effects',async()=>{
  const {data,calls}=await worker(['Riktig! 47+38 er 85. Nå neste steg: hva er 85-20? '+markers+' [[SJEKK: 47+38 | 85 | riktig]]']);
  assert.equal(calls,1);assert.match(data.text,/Svaret stemmer/);assert.doesNotMatch(data.text,/47\+38 = 85/);assert.match(data.text,/Hva er 85-20\?/);
  for(const type of ['VIS','LOGG','PROFIL','PRØV','ORD','STØTTE','SJEKK'])assert.ok(data.text.includes('[['+type+':'),type);
  assert.equal(V.extract(data.text).length,1);
});
test('B-1 wrong review fixture retains exact diagnostic fact and exchange hint',async()=>{
  const {data,calls}=await worker(['Nesten! Husk at 7+8 er 15, så du må veksle en tier. '+markers+' [[SJEKK: 47+38 | 75 | feil]]']);
  assert.equal(calls,1);assert.match(data.text,/Sjekk regnestykket/);assert.match(data.text,/7\+8 = 15/);assert.match(data.text,/Ti enere kan byttes/);
  assert.match(data.text,/STØTTE: S2 \| addCarry \| feil/);assert.match(data.text,/\[\[LOGG:/);
});
test('B-1 code renders bounded STEG and excludes contradictory verdicts and false facts',async()=>{
  const {data,calls}=await worker(['Nei, 5 er feil. [[STEG: {"type":"fakta","expression":"2+3","answer":"6"}]] [[STEG: {"type":"spørsmål","expression":"5-2"}]] [[STEG: {"type":"hint","strategy":"forklare","text":"5 er feil"}]] [[SJEKK: 2+3 | 5 | riktig]]']);
  assert.equal(calls,1);assert.match(data.text,/Svaret stemmer/);assert.match(data.text,/Hva er 5-2/);assert.ok(!/5 er feil|2\+3 = 6/.test(data.text));
});
test('B-1 reconciliation retries once, preserves missing side effects and maximum support',async()=>{
  const {data,calls}=await worker([markers.replace('S2','S3')+' [[SJEKK: 47+38 | 75 | riktig]]','[[STEG: {"type":"hint","strategy":"enerne"}]] [[SJEKK: 47+38 | 75 | feil]] [[STØTTE: S0 | addCarry | feil]]']);
  assert.equal(calls,2);assert.equal(data.verifier.interventions,1);assert.match(data.text,/Se på enerne/);assert.match(data.text,/STØTTE: S3/);assert.match(data.text,/\[\[VIS:/);assert.match(data.text,/\[\[LOGG:/);
});
for(const retry of [Error('private provider error'),'[[SJEKK: 47+38 | 75 | riktig]]','Jeg vet ikke.'])test('B-1 failed reconciliation has bounded safe fallback '+String(retry),async()=>{
  const {data,calls}=await worker(['[[OPPGAVE: 47+38]] [[SJEKK: 47+38 | 75 | riktig]]',retry]);
  assert.equal(calls,2);assert.equal(data.verifier.verified,false);assert.match(data.text,/La oss se/);assert.match(data.text,/OPPGAVE: 47\+38/);assert.ok(!/private|SJEKK|Kontroller/.test(data.text));
});
test('B-1 structured-only response retains valid markers without requiring prose',async()=>{
  const {data,calls}=await worker([markers+' [[SJEKK: 47+38 | 85 | riktig]]']);assert.equal(calls,1);assert.match(data.text,/Svaret stemmer/);assert.match(data.text,/\[\[PRØV:/);assert.match(data.text,/\[\[ORD:/);
});
for(const suffix of ['kr','kroner'])test('B-1 currency suffix '+suffix+' checks numeric value without another call',async()=>{
  const {data,calls}=await worker(['[[SJEKK: 20+16 | 36 '+suffix+' | riktig]]']);assert.equal(calls,1);assert.equal(data.verifier.verified,true);assert.match(data.text,/SJEKK: 20\+16 \| 36 \| riktig/);assert.equal(A.answer('36 '+suffix),null);
});
test('B-1 unit injection, mixed malformed markers and arbitrary teaching intents fail closed',async()=>{
  for(const answer of ['36 kg','36 kr; alert(1)','36 kr riktig']){const {data}=await worker(['[[SJEKK: 20+16 | '+answer+' | riktig]]']);assert.equal(data.verifier.verified,false);}
  const {data}=await worker(['[[SJEKK: 2+3 | 5 | riktig]] [[sjekk: broken']);assert.equal(data.verifier.verified,false);
  const valid=await worker(['[[STEG: {"type":"html","text":"bad-verdict"}]] [[STEG: {"type":"spørsmål","expression":"alert(1)"}]] [[VIS: {"type":"html","html":"bad-visual"}]] [[SJEKK: 2+3 | 5 | riktig]]']);
  assert.ok(!/bad-|alert|STEG|VIS/.test(valid.data.text));
});
test('S10 STEG fact equal to checked answer value is not rendered',async()=>{const {data,calls}=await worker(['[[STEG: {"type":"fakta","expression":"80+5","answer":"85"}]] [[STEG: {"type":"fakta","expression":"7+8","answer":"15"}]] [[SJEKK: 47+38 | 76 | feil]]']);assert.equal(calls,1);assert.doesNotMatch(data.text,/80\+5 = 85/);assert.match(data.text,/7\+8 = 15/);});
test('S10 legacy prose fact revealing checked answer is dropped',async()=>{const {data,calls}=await worker(['Husk at 47+38 er 85. [[SJEKK: 47+38 | 76 | feil]]']);assert.equal(calls,1);assert.doesNotMatch(data.text,/47\+38 = 85/);assert.doesNotMatch(data.text,/85/);});
test('S10 identical duplicate SJEKK markers collapse without a retry',async()=>{const {data,calls}=await worker(['[[SJEKK: 2+3 | 5 | riktig]] [[SJEKK: 2 + 3 | 5 | riktig]]']);assert.equal(calls,1);assert.equal(data.verifier.verified,true);assert.equal(data.text.split('[[SJEKK:').length-1,1);});
test('S10 contradictory duplicate SJEKK markers force reconciliation then neutral fallback',async()=>{const {data,calls}=await worker(['[[OPPGAVE: 2+3]] [[SJEKK: 2+3 | 5 | riktig]] [[SJEKK: 2+3 | 6 | feil]]','[[OPPGAVE: 2+3]] [[SJEKK: 2+3 | 5 | riktig]] [[SJEKK: 2+3 | 6 | feil]]']);assert.equal(calls,2);assert.equal(data.verifier.verified,false);assert.match(data.text,/La oss se/);assert.doesNotMatch(data.text,/SJEKK/);});
test('S10 A.inspect dedupes and flags contradictions',async()=>{const r1=A.inspect('[[SJEKK: 2+3 | 5 | riktig]] [[SJEKK: 2+3 | 5 | riktig]]');assert.equal(r1.checks.length,1);assert.equal(r1.repair,false);assert.equal(r1.raw,2);const r2=A.inspect('[[SJEKK: 2+3 | 5 | riktig]] [[SJEKK: 2+3 | 6 | feil]]');assert.equal(r2.repair,true);});
test('B-1 backup provider uses the same bounded teaching protocol',async()=>{
  const {data,calls}=await worker(['[[STEG: {"type":"hint","strategy":"deleOpp"}]] '+markers+' [[SJEKK: 47+38 | 75 | feil]]'],true);
  assert.equal(calls,1);assert.equal(data.provider,'groq');assert.match(data.text,/dele tallene/);assert.match(data.text,/\[\[VIS:/);
});
function homework(){
  const calls=[];const f=frontend({storage:pairedStorage,fetch:async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({text:'Hva er 40 + 30? [[STØTTE: S2 | addCarry | feil]]'});}});
  f.app.set("inputMode='text';hwText='47+38';taskMode='matte'");return {f,calls};
}
async function send(f,text){f.w.document.getElementById('msg').value=text;await f.app.send();}
test('B-2 original 47+38, tutor asks 40+30, child 70 reaches tutor without verified failure',async()=>{
  const {f,calls}=homework();await f.app.start();await send(f,'70');assert.equal(calls.length,2);assert.equal(calls[1].messages.at(-1).content,'70');
  const r=f.app.state().kids[0].learning.skills.addCarry;assert.equal(r.ev.length,0);assert.equal(r.observations.length,1);assert.equal(r.observations[0].verified,false);f.dom.window.close();
});
for(const [answer,ok] of [['85',true],['75',false]])test('B-2 explicitly owned homework answer '+answer+' is verified',async()=>{
  const {f,calls}=homework();await f.app.start();f.w.document.getElementById('checkHomework').click();assert.match(f.w.document.getElementById('main').textContent,/Svarer på hele regnestykket: 47\+38/);await send(f,answer);
  assert.equal(calls.length,1);const e=f.app.state().kids[0].learning.skills.addCarry.ev.at(-1);assert.equal(e.ok,ok);assert.equal(e.verified,true);assert.equal(e.s,2);f.dom.window.close();
});
test('B-2 cancelled original check returns numeric messages to the tutor',async()=>{
  const {f,calls}=homework();await f.app.start();f.w.document.getElementById('checkHomework').click();f.w.document.getElementById('cancelAnswerTarget').click();await send(f,'70');assert.equal(calls.length,2);assert.equal(f.app.state().kids[0].learning.skills.addCarry.ev.length,0);f.dom.window.close();
});
test('B-2 tutor help clears ownership before intermediate numeric replies',async()=>{
  const {f,calls}=homework();await f.app.start();f.w.document.getElementById('checkHomework').click();f.app.set('learningSession.task.attempts=1');f.app.helpStep(3);await new Promise(r=>setTimeout(r,15));await send(f,'70');assert.equal(calls.length,3);assert.equal(f.app.state().kids[0].learning.skills.addCarry.ev.length,0);f.dom.window.close();
});
for(const action of ['nextLearningTask()',"currentSessionId='different';ensureLearning()","kids.push(blankKid('B'));chooseChild(1)"])test('B-2 stale ownership cannot survive '+action,async()=>{
  const {f}=homework();await f.app.start();f.w.document.getElementById('checkHomework').click();f.app.set(action);assert.ok(!f.app.state().learningSession?.answerTarget);assert.equal(f.app.set("interceptAnswer('70')"),false);f.dom.window.close();
});
test('B-2 restored homework requires a fresh explicit check',async()=>{
  const {f}=homework();await f.app.start();f.w.document.getElementById('checkHomework').click();const storage={...f.w.localStorage};f.dom.window.close();const g=frontend({storage});g.app.resumeSession();assert.equal(g.app.state().learningSession.answerTarget,null);assert.equal(g.app.set("interceptAnswer('70')"),false);g.dom.window.close();
});
test('B-2 transfer and practice retain their explicit targets and clear on finish',async()=>{
  const f=frontend({storage:pairedStorage});f.app.set("view='chat';initHomeworkLearning('47+38')");f.app.beginCheck(L.generate('addCarry',23));await send(f,f.app.state().learningSession.check.item.answer);assert.equal(f.app.state().kids[0].learning.skills.addCarry.ev.at(-1).verified,true);
  await f.app.finishHomework();assert.equal(f.app.state().learningSession,null);f.app.startPractice('times');const s=f.app.state().learningSession;await send(f,s.check.item.answer);assert.equal(f.app.state().kids[0].learning.skills.times2510.ev.at(-1).ok,true);await f.app.finishHomework();assert.equal(f.app.state().learningSession,null);f.dom.window.close();
});
const put=(m,n,extra={})=>L.event(m,'add1',{t:base+n*DAY,s:0,ok:true,k:n?'cold':'task',sid:'s'+n,id:'e'+n,verified:true,...extra});
function retained(){const m=L.empty();put(m,0);put(m,2);put(m,10);assert.equal(L.state(m.skills.add1),'SITTER');return m;}
for(const ok of [true,false])test('I-1 SITTER survives unverified '+ok+' and all checkpoints/box stay intact',()=>{
  const m=retained(),before=plain(m.skills.add1),totals=plain(m.totals);put(m,11,{verified:false,ok,s:4});const r=m.skills.add1;
  assert.equal(L.state(r),'SITTER');for(const key of ['box','due','firstColdAt','retainedAt','independentAt','lastAt','lastSession','ev'])assert.deepEqual(plain(r[key]),before[key]);assert.deepEqual(plain(m.totals),totals);assert.equal(r.observations.length,1);
  assert.equal(L.state(L.normalizeMemory(m).skills.add1),'SITTER');
});
test('I-1 SELVSTENDIG survives model observations, which cannot crowd out verified events',()=>{
  const m=L.empty();put(m,0);for(let i=1;i<100;i++)put(m,i,{verified:false,ok:false,s:4});assert.equal(L.state(m.skills.add1),'SELVSTENDIG');assert.equal(m.skills.add1.ev.length,1);assert.equal(m.skills.add1.observations.length,8);assert.equal(m.skills.add1.box,1);
});
test('I-1 model-only success cannot promote or start a review schedule',()=>{
  const m=L.empty();put(m,0,{verified:false});put(m,10,{verified:false});const r=m.skills.add1;assert.equal(L.state(r),'ØVER');assert.equal(r.box,0);assert.equal(r.due,null);assert.equal(r.ev.length,0);assert.equal(m.totals.independentCold,0);
});
test('I-1 verified later failure can still demote and clear delayed checkpoints',()=>{
  const m=retained();put(m,11,{verified:false});put(m,12,{ok:false,s:2});const r=m.skills.add1;assert.equal(L.state(r),'ØVER');assert.equal(r.box,2);assert.equal(r.retainedAt,null);assert.equal(r.firstColdAt,null);
});
test('I-1 normalization separates legacy observations without demoting remaining verified state',()=>{
  const m=retained(),r=m.skills.add1;r.ev.push({...r.ev.at(-1),id:'model',t:base+11*DAY,verified:false,ok:false});const n=L.normalizeMemory(m);assert.equal(L.state(n.skills.add1),'SITTER');assert.equal(n.skills.add1.observations.length,1);assert.equal(n.skills.add1.box,3);assert.deepEqual(plain(L.normalizeMemory(n)),plain(n));
});
for(const [hour,minute] of [[4,45],[12,0],[7,30],[1,15],[23,55],[0,1],[4,59]])test('I-2 clock positions, hand coordinates and all text surfaces '+hour+':'+minute,()=>{
  const html=V.render({type:'klokke',hour,minute},true);
  const label=html.match(/aria-label="([^"]+)"/)[1];assert.equal(html.match(/<title>(.*?)<\/title>/)[1],label);assert.equal(html.match(/<figcaption>(.*?)<\/figcaption>/)[1],label);
  assert.ok(!/minutt|Klokka er|\d\d:\d\d/.test(label));assert.match(label,/Den korte viseren peker/);assert.match(label,/Den lange viseren peker/);
  if(minute===45)assert.match(label,/lange viseren peker på 9/);
  const hands=[...html.matchAll(/<line x1="145" y1="100" x2="([^"]+)" y2="([^"]+)"/g)];assert.equal(hands.length,2);
  for(const [i,angle,length] of [[0,(hour%12+minute/60)*Math.PI/6,45],[1,minute*Math.PI/30,64]]){assert.ok(Math.abs(+hands[i][1]-(145+Math.sin(angle)*length))<1e-9);assert.ok(Math.abs(+hands[i][2]-(100-Math.cos(angle)*length))<1e-9);}
});
test('I-2 all clock skill generators use the hidden positional caption',()=>{
  for(const skill of ['clockHour','clockQuarter','clockMinute'])for(let seed=0;seed<60;seed++){const item=L.generate(skill,seed);assert.ok(!V.render(item.visual,true).includes(item.answer));assert.ok(!V.render(item.visual,true).includes('minutter'));}
});
function archive(i){return {id:'archive'+i,d:'date',m:'matte',t:'math',endedAt:base,msgs:[{role:'user',text:'session'+i}]};}
function session(i){return {id:'session'+i,startedAt:base+i,endedAt:base+i+1,activeMs:60000,mode:'matte',interactions:[base+i],events:[{id:'session'+i+':t1:1',sid:'session'+i,skill:'add1',s:0,ok:true,verified:true,k:'task',t:base+i}]};}
test('I-3 rolling archive/aggregate bounds preserve mastery and sibling and are idempotent',()=>{
  const k={sessions:Array.from({length:30},(_,i)=>archive(i)),learning:retained()},sibling={sessions:[archive(99)],learning:retained()},before=JSON.stringify(sibling),skill=JSON.stringify(k.learning.skills);
  k.learning.sessions=Array.from({length:1000},(_,i)=>session(i));L.prune(k,base);assert.equal(k.sessions.length,8);assert.equal(k.sessions[0].id,'archive22');assert.equal(k.learning.sessions.length,120);assert.equal(k.learning.sessions[0].id,'session880');assert.equal(JSON.stringify(k.learning.skills),skill);assert.equal(JSON.stringify(sibling),before);assert.equal(L.state(k.learning.skills.add1),'SITTER');const once=JSON.stringify(k);L.prune(k,base);assert.equal(JSON.stringify(k),once);
});
test('I-3 load-time bound, migration backup and export/import preserve compact mastery',()=>{
  const learning=retained();learning.sessions=Array.from({length:140},(_,i)=>session(i));const legacy=[{name:'A',age:8,notes:['keep'],sessions:Array.from({length:12},(_,i)=>archive(i)),learning},{name:'B',age:8,sessions:[archive(99)],learning:L.empty()}];
  const f=frontend({storage:{...pairedStorage,spark_kids:legacy}});assert.equal(f.app.state().kids[0].sessions.length,8);assert.equal(f.app.state().kids[1].sessions.length,1);assert.equal(f.app.state().kids[0].learning.sessions.length,120);assert.equal(JSON.parse(JSON.parse(f.w.localStorage.getItem('spark_learning_backup')).kids)[0].sessions.length,12);
  const exported=f.app.learningExport(),imported=f.app.validateImport(plain(exported));assert.equal(imported[0].sessions.length,8);assert.equal(imported[0].learning.sessions.length,120);assert.equal(L.state(imported[0].learning.skills.add1),'SITTER');assert.equal(imported[1].sessions.length,1);const storage={...f.w.localStorage};f.dom.window.close();const g=frontend({storage});assert.equal(g.app.state().kids[0].sessions.length,8);assert.equal(g.app.state().kids[0].learning.sessions.length,120);g.dom.window.close();
});
test('I-3 nested session collections and active events stay bounded while duration accumulates',()=>{
  const s=session(0);s.events=Array.from({length:5000},(_,i)=>({...session(i).events[0]}));s.interactions=Array.from({length:5000},(_,i)=>base+i);L.boundSession(s);assert.equal(s.events.length,120);assert.equal(s.interactions.length,240);
  for(let i=0;i<2000;i++)L.activity(s,base+6000+i*1000);assert.equal(s.interactions.length,240);assert.ok(s.activeMs>=1999000);const aggregate=L.aggregate(s,'matte',base+3000000);assert.equal(aggregate.events.length,120);
  const m=retained();m.sessions=[{...s,events:Array(900).fill(s.events[0]),interactions:Array(900).fill(base)}];const n=L.normalizeMemory(m);assert.equal(n.sessions[0].events.length,120);assert.equal(n.sessions[0].interactions.length,240);
});
test('I-3 ongoing session autosave bounds loaded collections',()=>{
  const f=frontend({storage:pairedStorage});f.app.set("view='chat';initHomeworkLearning('2+3');learningSession.events=Array(1000).fill({});learningSession.interactions=Array(1000).fill(Date.now());chatMsgs=[{role:'user',text:'x'}];history=[{role:'user',content:'x'}]");f.app.saveSession();const saved=JSON.parse(f.w.localStorage.getItem('spark_session_0'));assert.equal(saved.learning.events.length,120);assert.equal(saved.learning.interactions.length,240);f.dom.window.close();
});
test('I-3 save failure at archive capacity keeps all previous sessions for retry',()=>{
  const f=frontend({storage:pairedStorage});f.app.set(`kid().sessions=${JSON.stringify(Array.from({length:8},(_,i)=>archive(i)))};view='chat';chatMsgs=[{role:'user',text:'new'}];history=[{role:'user',content:'new'}];initHomeworkLearning('2+3')`);
  const before=JSON.stringify(f.app.state().kids[0].sessions),write=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value){if(key==='spark_kids')throw Error('QuotaExceededError');return write.call(this,key,value);};assert.equal(f.app.archiveSession(),false);assert.equal(JSON.stringify(f.app.state().kids[0].sessions),before);
  f.w.Storage.prototype.setItem=write;assert.equal(f.app.archiveSession(),true);assert.equal(f.app.state().kids[0].sessions.length,8);assert.equal(f.app.state().kids[0].sessions[0].id,'archive1');f.dom.window.close();
});
test('I-3 repeatedly appending sessions has fixed collection size and keeps recent IDs',()=>{
  const k={sessions:[],learning:retained()};let size=0;
  for(let i=1000;i<3000;i++){k.sessions.push(archive(i));k.learning.sessions.push(session(i));L.prune(k,base);if(i===1999)size=JSON.stringify(k).length;}
  assert.equal(JSON.stringify(k).length,size);assert.equal(k.sessions.at(-1).id,'archive2999');assert.equal(k.learning.sessions.at(-1).id,'session2999');assert.equal(L.state(k.learning.skills.add1),'SITTER');
});
test('I-3 transcript age and per-archive message cap still apply',()=>{
  const k={sessions:[{...archive(0),msgs:Array(200).fill({role:'user',text:'private'})}],learning:retained()};L.prune(k,base);assert.equal(k.sessions[0].msgs.length,40);L.prune(k,base+30*DAY);assert.equal(k.sessions[0].msgs.length,0);assert.equal(L.state(k.learning.skills.add1),'SITTER');
});
for(const [s,ok,verified,c,green,label] of [[0,true,true,'',1,'klarte selv'],[1,true,true,'',1,'klarte med liten påminnelse'],[0,false,true,'',0,'forsøk uten riktig svar'],[1,false,true,'',0,'forsøk uten riktig svar'],[2,true,true,'',0,'klarte med støtte S2'],[0,true,false,'',0,'tutorobservasjon'],[0,true,true,'gjetter',0,'barnet valgte gjetting']])test('I-4 truthful parent metric '+JSON.stringify({s,ok,verified,c}),()=>{
  const f=frontend({storage:pairedStorage});const e={skill:'add1',t:Date.now()-10000,s,ok,verified,c};f.app.set(`kid().learning.sessions=[{id:'s',startedAt:Date.now()-10000,activeMs:60000,mode:'matte',events:[${JSON.stringify(e)}]}];view='setup'`);f.app.render();const chart=f.w.document.querySelector('.prof svg');const aria=chart.getAttribute('aria-label');assert.match(aria,new RegExp('Uke 4: S0–S1 '+green));assert.ok(f.w.document.querySelector('.prof').textContent.includes(label));if(!ok)assert.ok(!f.w.document.querySelector('.prof').textContent.includes('— lite støtte'));f.dom.window.close();
});
test('I-4 sibling success never enters the active child chart',()=>{
  const f=frontend({storage:pairedStorage});f.app.set("kids.push(blankKid('B'));kids[1].learning.sessions=[{id:'b',startedAt:Date.now()-10000,activeMs:60000,events:[{skill:'add1',t:Date.now()-10000,s:0,ok:true,verified:true}]}];view='setup'");f.app.render();assert.match(f.w.document.querySelector('.prof svg').getAttribute('aria-label'),/Uke 4: S0–S1 0/);f.dom.window.close();
});
test('B-1 reconciliation cannot change the checked target or child answer to manufacture success',async()=>{
  for(const repair of ['[[SJEKK: 47+38 | 85 | riktig]]','[[SJEKK: 40+35 | 75 | riktig]]']){
    const {data,calls}=await worker(['[[SJEKK: 47+38 | 75 | riktig]]',repair]);assert.equal(calls,2);assert.equal(data.verifier.verified,false);assert.ok(!data.text.includes('Svaret stemmer'));
  }
});
test('I-1 observed practice prevents a premature cold success without altering mastery checkpoints',()=>{
  const m=retained();put(m,11,{verified:false,ok:false});const before=plain(m.skills.add1);put(m,11.5);assert.equal(m.skills.add1.ev.at(-1).delayed,false);assert.equal(m.skills.add1.box,before.box);assert.equal(m.skills.add1.retainedAt,before.retainedAt);
});
