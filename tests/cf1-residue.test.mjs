import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {read,frontend,pairedStorage,backend,environment,body,request,success} from './helpers.mjs';
const ctx=vm.createContext({});vm.runInContext(['arithmetic.js','learning.js','visuals.js'].map(read).join('\n'),ctx);
const L=ctx.SparkLearning,plain=x=>JSON.parse(JSON.stringify(x)),DAY=L.DAY,base=1792600000000,YEAR=365*DAY;
const put=(m,{t=base,s=0,ok=true,k='task',sid='s1',id,verified=true,c=''}={},now)=>L.event(m,'add1',{t,s,ok,k,sid,id:id||sid+':'+t,verified,c},now);

/* ---------- Imported verification trust ---------- */
// A hand-made copy claiming retained mastery: verified independent cold checks, checkpoints, box 5, credit totals and a far schedule.
function crafted(){
  const ev=[0,2,10].map(n=>({t:base+n*DAY,s:0,ok:true,k:n?'cold':'task',sid:'x'+n,id:'x'+n,verified:true,delayed:n>0,e:'',c:''}));
  const learning={version:3,skills:{add1:{ev,observations:[],box:5,due:base+400*DAY,lastAt:base+10*DAY,independentAt:base,firstColdAt:base+2*DAY,retainedAt:base+10*DAY,helped:'Tallinje',imported:[{t:base,s:0,ok:true,k:'cold',sid:'y',id:'y',verified:true}]}},
    items:[{id:'w',word:'house',meaning:'hus',box:5,due:base+400*DAY,lastAt:base+10*DAY,ev:[{t:base,s:0,ok:true,delayed:true}]}],
    sessions:[{id:'old',startedAt:base,endedAt:base+1,activeMs:60000,mode:'matte',events:[{skill:'add1',t:base+DAY,s:0,ok:true,verified:true,k:'cold',delayed:true,id:'x1',sid:'x1'}]}],
    totals:{cold:9,independentCold:9}};
  return {schema:'spark-learning-export-v3',kids:[{name:'A',age:8,learning}]};
}
test('CF1 trust: the crafted copy would grant SITTER without the import boundary (fixture discriminates)',()=>{
  assert.equal(L.state(L.normalizeMemory(crafted().kids[0].learning).skills.add1),'SITTER');
});
test('CF1 trust: imported verified evidence cannot manufacture mastery, credit, checkpoints or a suppressed schedule',()=>{
  const f=frontend({storage:pairedStorage});const now=base+30*DAY;
  const [kid]=f.app.validateImport(crafted(),now);const m=kid.learning,r=m.skills.add1;
  assert.equal(L.state(r),'ØVER');
  for(const key of ['independentAt','firstColdAt','retainedAt','lastAt'])assert.equal(r[key],null,key);
  assert.equal(r.ev.length,0);assert.equal(r.observations.length,0);
  assert.equal(r.box,1);assert.equal(r.due,now);assert.deepEqual(plain(L.due(m,now)),['add1']);
  assert.deepEqual(plain(m.totals),{cold:0,independentCold:0});
  assert.equal(m.items[0].box,1);assert.equal(m.items[0].due,now);assert.equal(m.items[0].lastAt,null);
  assert.ok(m.sessions.every(s=>s.imported===true));
  // History is retained for display: prior verified events plus any history the file already marked as imported.
  assert.equal(r.imported.length,4);assert.ok(r.imported.some(e=>e.id==='x2'));assert.equal(r.helped,'Tallinje');assert.equal(m.items[0].word,'house');
  f.dom.window.close();
});
test('CF1 trust: imported history survives reload and re-export, and still carries no authority',()=>{
  const f=frontend({storage:pairedStorage});const now=base+30*DAY;
  const [kid]=f.app.validateImport(crafted(),now);const reloaded=L.normalizeMemory(plain(kid.learning));
  assert.equal(reloaded.skills.add1.imported.length,4);assert.equal(L.state(reloaded.skills.add1),'ØVER');assert.ok(reloaded.sessions.every(s=>s.imported===true));
  const again=f.app.validateImport(plain({schema:'spark-learning-export-v3',kids:[{...kid,learning:reloaded}]}),now+DAY);
  assert.equal(L.state(again[0].learning.skills.add1),'ØVER');assert.equal(again[0].learning.skills.add1.imported.length,4);
  f.dom.window.close();
});
test('CF1 trust: after a restore, mastery is earned only from local verified checks (imported time is not a delay anchor)',()=>{
  const f=frontend({storage:pairedStorage});const now=base+30*DAY;
  const m=f.app.validateImport(crafted(),now)[0].learning;
  const first=put(m,{t:now,k:'cold',sid:'l1'});assert.equal(first.delayed,false);assert.equal(m.totals.cold,0);assert.equal(L.state(m.skills.add1),'SELVSTENDIG');
  put(m,{t:now+2*DAY,k:'cold',sid:'l2'});assert.equal(L.state(m.skills.add1),'SELVSTENDIG');
  put(m,{t:now+10*DAY,k:'cold',sid:'l3'});assert.equal(L.state(m.skills.add1),'SITTER');assert.equal(m.totals.independentCold,2);
  f.dom.window.close();
});
test('CF1 trust: parent view labels imported sessions and excludes them from the verified chart',()=>{
  const f=frontend({storage:pairedStorage});const [kid]=f.app.validateImport(crafted(),Date.now());
  f.w.__kid=kid;f.app.set("kids.push(window.__kid);active=kids.length-1");
  const page=f.app.set('parentHTML()');
  assert.ok(page.includes('fra kopi, ikke bekreftet på denne enheten'));assert.ok(page.includes('tidligere historikk fra kopi'));
  assert.ok(page.includes('Uke 1: S0–S1 0, S2 0, S3–S4 0. Uke 2: S0–S1 0, S2 0, S3–S4 0. Uke 3: S0–S1 0, S2 0, S3–S4 0. Uke 4: S0–S1 0, S2 0, S3–S4 0'));
  f.dom.window.close();
});

/* ---------- Clock boundary ---------- */
test('CF1 clock: normal forward time gives delay credit and schedules from the event time',()=>{
  const m=L.empty();put(m);const v=put(m,{t:base+2*DAY,k:'cold',sid:'s2'});assert.equal(v.delayed,true);assert.equal(m.skills.add1.due,base+2*DAY+3*DAY);
});
test('CF1 clock: mildly fast clock (within skew) clamps, earns no credit and shifts the schedule by less than a day',()=>{
  const m=L.empty();put(m,{t:base+12*3600000});const v=put(m,{t:base+3600000,k:'cold',sid:'s2'});
  assert.equal(v.t,base+12*3600000);assert.equal(v.delayed,false);assert.ok(m.skills.add1.due-(base+3600000)<2*DAY);
});
test('CF1 clock: one extreme future timestamp cannot pin the skill, suppress review or block later credit',()=>{
  const m=L.empty();put(m);put(m,{t:base+1000*YEAR,sid:'f'});
  const back=put(m,{t:base+DAY,k:'cold',sid:'s2'});assert.equal(back.t,base+DAY);assert.equal(back.delayed,false);assert.equal(m.totals.cold,0);
  assert.equal(m.skills.add1.lastAt,base+DAY);assert.ok(m.skills.add1.due<base+10*DAY);assert.deepEqual(plain(L.due(m,base+3*DAY)),['add1']);
  const later=put(m,{t:base+3*DAY,k:'cold',sid:'s3'});assert.equal(later.delayed,true);assert.equal(m.totals.independentCold,1);
});
test('CF1 clock: a clock far behind and later corrected never manufactures delay or retention credit',()=>{
  const m=L.empty();put(m,{t:base});
  const behind=put(m,{t:base-5*YEAR,k:'cold',sid:'b1'});assert.equal(behind.delayed,false);
  const stillBehind=put(m,{t:base-5*YEAR+2*DAY,k:'cold',sid:'b2'});assert.equal(stillBehind.delayed,true);// two real days on the same (offset) clock
  const corrected=put(m,{t:base+3*3600000,k:'cold',sid:'c1'});assert.equal(corrected.delayed,false);assert.equal(corrected.t,base+3*3600000);
  assert.equal(m.skills.add1.firstColdAt,null);assert.notEqual(L.state(m.skills.add1),'SITTER');
});
test('CF1 clock: returning across a jump to slightly below the earlier peak clamps to the peak (anchor stays monotone)',()=>{
  const m=L.empty();put(m,{t:base});put(m,{t:base-5*YEAR,sid:'b1'});
  const back=put(m,{t:base-6*3600000,k:'cold',sid:'c1'});assert.equal(back.t,base);assert.equal(back.delayed,false);
  assert.equal(put(m,{t:base+DAY-7*3600000,k:'cold',sid:'c2'}).delayed,false);
});
test('CF1 clock: an observation crossing a clock jump also restarts the retention interval',()=>{
  const m=L.empty();put(m,{t:base});put(m,{t:base+2*DAY,k:'cold',sid:'s2'});assert.equal(m.skills.add1.firstColdAt,base+2*DAY);
  put(m,{t:base-5*YEAR,sid:'o',verified:false});assert.equal(m.skills.add1.firstColdAt,null);
});
test('CF1 clock: the reference time is explicit and injectable (no hidden clock read)',()=>{
  const ahead=()=>{const m=L.empty();put(m,{t:base+3*DAY});return m;};
  const a=ahead(),b=ahead();
  assert.equal(put(a,{t:base,sid:'s2'},base+3*DAY).t,base+3*DAY);// authoritative reference agrees with the stored time: device is behind, clamp
  assert.equal(put(b,{t:base,sid:'s2'}).t,base);// reference = event time: stored time is in the future, re-anchor
  assert.equal(L.event(L.empty(),'add1',{t:base,s:0,ok:true,k:'task',sid:'s',id:'i',verified:true},NaN),false);
  assert.ok(!/Date\.now|new Date/.test(read('learning.js')));
});
test('CF1 clock: implausibly distant due dates are due now; ordinary long spacing is not',()=>{
  const m=L.empty();put(m);m.skills.add1.due=base+1000*YEAR;m.items=[{id:'w',due:base+1000*YEAR},{id:'v',due:base+59*DAY}];
  assert.deepEqual(plain(L.due(m,base)),['add1']);assert.deepEqual(plain(L.dueWords(m,base)).map(w=>w.id),['w']);
  m.skills.add1.due=base+60*DAY;assert.deepEqual(plain(L.due(m,base)),[]);
});

/* ---------- Provider chain policy ---------- */
const fail={
  http:(status,message)=>()=>Response.json({error:{message}},{status}),
  timeout:()=>{throw new DOMException('timed out','TimeoutError');},
  network:()=>{throw new TypeError('fetch failed');},
  lost:()=>{throw new Error('Network connection lost.');},
  empty:()=>Response.json({candidates:[{content:{parts:[{text:''}]},finishReason:'MAX_TOKENS'}]}),
  invalid:()=>new Response('not json',{status:200}),
  blockedPrompt:()=>Response.json({promptFeedback:{blockReason:'SAFETY'}}),
  blockedReply:()=>Response.json({candidates:[{finishReason:'SAFETY'}]})
};
const advance=[['5xx 500',fail.http(500,'Internal')],['5xx 502',fail.http(502,'Bad gateway')],['5xx 503',fail.http(503,'UNAVAILABLE')],['5xx 504',fail.http(504,'Deadline')],['429 overloaded',fail.http(429,'The model is experiencing high demand')],['retired 404',fail.http(404,'models/x is not found')],['timeout',fail.timeout],['network',fail.network],['network lost',fail.lost],['empty',fail.empty],['invalid json',fail.invalid]];
for(const [label,first] of advance)test('CF1 provider: '+label+' advances to the next Gemini model',async()=>{
  let calls=0;const b=backend(async()=>++calls===1?first():success()),{env}=environment();
  const r=await b.worker.fetch(request('/chat',body(),await b.api.makeToken(env,'d')),env);
  assert.equal(r.status,200,label);assert.equal(calls,2,label);assert.equal((await r.json()).model,b.api.GEMINI_CHAIN[1]);
});
const stop=[['401 auth',fail.http(401,'API key not valid'),502,'provider_error'],['403 permission',fail.http(403,'PERMISSION_DENIED'),502,'provider_error'],['429 rate',fail.http(429,'Quota exceeded'),429,'minute_quota'],['429 daily',fail.http(429,'requests per day'),429,'daily_quota'],['400 bad request',fail.http(400,'Invalid argument'),400,'provider_error'],['413',fail.http(413,'Request too large'),413,'provider_error'],['blocked prompt',fail.blockedPrompt,502,'provider_error'],['blocked reply',fail.blockedReply,502,'provider_error']];
for(const [label,first,status,kind] of stop)test('CF1 provider: '+label+' fails fast without walking the chain',async()=>{
  let calls=0;const b=backend(async()=>{calls++;return first();}),{env}=environment();
  const r=await b.worker.fetch(request('/chat',body(),await b.api.makeToken(env,'d')),env);const data=await r.json();
  assert.equal(calls,1,label);assert.equal(r.status,status,label);assert.equal(data.kind,kind,label);
});
test('CF1 provider: classifier verdicts are explicit for every branch',()=>{
  const {api}=backend(()=>{});const e=(props,message='')=>Object.assign(new Error(message),props);
  const cases=[[e({status:503}),true],[e({status:500}),true],[e({status:404},'model not found'),true],[e({name:'TimeoutError'}),true],[Object.assign(new TypeError('fetch failed')),true],[e({},'Tomt svar fra Gemini.'),true],
    [e({status:401}),false],[e({status:403}),false],[e({status:429},'Quota exceeded'),false],[e({status:400},'Invalid argument'),false],[e({status:404},'Requested entity was not found'),true],[e({status:400},'field is not supported'),false],[e({blocked:true},'Tomt svar fra Gemini.'),false],[e({status:401},'model overloaded'),false],[e({},'something else'),false]];
  for(const [error,expected] of cases)assert.equal(api.chainAdvance(error),expected,String(error.status)+' '+error.message+' '+error.name);
});
test('CF1 provider: repeated timeouts stop at the chain budget instead of walking all models',async()=>{
  let now=0,calls=0;const b=backend(async()=>{calls++;now+=20000;throw new DOMException('t','TimeoutError');}),{env}=environment();
  await assert.rejects(b.api.callGemini(env,'sys',[{role:'user',content:'x'}],()=>now),e=>e.name==='TimeoutError'&&Array.isArray(e.tried));
  assert.ok(calls<=3,'calls '+calls);assert.ok(calls<b.api.GEMINI_CHAIN.length);
});
test('CF1 provider: client bodies carry Spark text only; logs stay content-free with the walked chain',async()=>{
  const child='Hjelp meg med leksa',providerText='internal detail '+child;
  for(const first of [fail.http(400,providerText),fail.http(503,providerText),()=>{throw new TypeError('fetch failed '+child);}]){
    const b=backend(async()=>first()),{env}=environment();
    const r=await b.worker.fetch(request('/chat',body({messages:[{role:'user',content:child}]}),await b.api.makeToken(env,'d')),env);const text=await r.text();
    for(const forbidden of [child,'internal detail','fixture-provider-key','fixture-family-code','fixture-signing-key'])assert.ok(!text.includes(forbidden),forbidden);
    const line=b.logs.find(l=>l.includes('chat_provider_failure'));assert.ok(line);
    for(const forbidden of [child,'internal detail','fixture-provider-key','Bearer'])assert.ok(!line.includes(forbidden),forbidden);
    assert.ok(JSON.parse(line).tried.every(t=>/^[\w.-]+:(timeout|network|empty|blocked|http_\d+|other)$/.test(t)));
  }
});
test('CF1 provider: Spark-authored backup guidance still reaches the child',async()=>{
  const b=backend(async()=>Response.json({error:{message:'daily limit'}},{status:429})),{env}=environment({BACKUP_PROVIDER:'groq',GROQ_API_KEY:'fixture-groq-key'});
  const r=await b.worker.fetch(request('/chat',body({messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'YWJj'}}]}]}),await b.api.makeToken(env,'d')),env);
  assert.ok((await r.json()).error.includes('Skriv oppgaven som tekst'));
});
for(const [label,first,check] of [['daily',fail.http(429,'requests per day'),'isDailyQuota'],['minute',fail.http(429,'Quota exceeded'),'isMinuteQuota']])test('CF1 provider: controlled '+label+' text is still recognised by the app',async()=>{
  const b=backend(async()=>first()),{env}=environment();const worker=await b.worker.fetch(request('/chat',body(),await b.api.makeToken(env,'d')),env);const payload=await worker.json();
  const f=frontend({storage:pairedStorage,fetch:async()=>Response.json(payload,{status:worker.status})});
  await assert.rejects(f.app.callAI([{role:'user',content:'x'}]),e=>{f.w.__err=e;return true;});
  assert.equal(f.app.set(check+'(window.__err)'),true);if(label==='minute')assert.equal(f.app.set('isDailyQuota(window.__err)'),false);
  f.dom.window.close();
});
