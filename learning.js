/* Learning schema C3. Pure functions: no provider, DOM, clock or credential access. */
(function(root){
  'use strict';
  const DAY=86400000, VERSION=3, MIGRATION='spark-c3-learning-v1', SPACING=[1,3,7,21,60];
  const LIMITS=Object.freeze({archives:8,sessions:120,events:120,interactions:240,observations:8,imported:16});
  // A stored time more than CLOCK_SKEW after the caller's reference time came from a clock that was ahead.
  const CLOCK_SKEW=DAY;
  const rows=[
    ['number20','Tall til 20','number',1,'tallinje'],['number100','Tall til 100','number',2,'tiere'],['number1000','Plassverdi til 1000','number',3,'tiere'],
    ['friends10','Tiervenner','friends',1,'tierramme'],['friends100','Hundrevenner','friends',2,'tallinje'],['double','Dobling','double',1,'rutenett'],['half','Halvering','half',2,'rutenett'],
    ['add1','Pluss til 20','add',1,'tierramme'],['add2','Tosifret pluss uten tierovergang','add',2,'tiere'],['addCarry','Pluss med tierovergang','add',2,'tallinje'],
    ['sub1','Minus til 20','sub',1,'tallinje'],['sub2','Tosifret minus uten veksling','sub',2,'tiere'],['subBorrow','Minus med veksling','sub',2,'tallinje'],['written','Skriftlig regning',null,3,'tiere'],
    ['times2510','Gangetabell 2, 5 og 10','times',2,'rutenett'],['times34','Gangetabell 3 og 4','times',3,'rutenett'],['times69','Gangetabell 6 til 9','times',4,'rutenett'],
    ['divide','Likedeling','divide',3,'rutenett'],['measureDivide','Hvor mange grupper','divide',3,'rutenett'],
    ['fractionPart','Del av en helhet',null,3,'brøk'],['fractionLine','Brøk på tallinje',null,4,'tallinje'],['fractionCompare','Sammenligne brøker',null,4,'brøk'],
    ['clockHour','Hele og halve timer','clock',2,'klokke'],['clockQuarter','Kvart på og kvart over','clock',3,'klokke'],['clockMinute','Klokke med minutter','clock',4,'klokke'],
    ['money','Telle penger','money',2,'penger'],['change','Vekslepenger','sub',3,'penger'],['length','Lengde',null,2,'tallinje'],['wordProblem','Velge regneart',null,3,'tallinje'],
    ['readInfo','Finne informasjon',null,1,null],['readEvidence','Finne belegg',null,2,null],['readWord','Ord fra sammenheng',null,2,null],['readInfer','Slutninger',null,3,null],['readMain','Hovedidé',null,3,null],['readRetell','Gjenfortelling',null,1,null],['annet','Annen oppgave',null,1,null]
  ];
  const CATALOG=Object.fromEntries(rows.map(([id,label,generator,grade,visual])=>[id,{id,label,generator,grade,visual}]));
  const skillId=id=>Object.hasOwn(CATALOG,id)?id:'annet';
  const level=n=>Number.isInteger(n)&&n>=0&&n<=4?n:4;
  function task(id,skill='annet'){return {id,skill:skillId(skill),s:0,attempts:0,completed:false,offered:false};}
  function support(t,n){t.s=Math.max(level(t.s),level(n));return t.s;}
  function marker(text){const m=text.match(/\[\[STØTTE:\s*S([0-4])\s*\|\s*([a-zA-Z0-9_]+)\s*\|\s*(riktig|feil)\s*(?:\|\s*(slurv|fakta|metode|begrep|tolking|ingen))?\s*\]\]/);return m?{s:+m[1],skill:skillId(m[2]),ok:m[3]==='riktig',e:m[4]||'ingen'}:null;}
  function empty(){return {version:VERSION,skills:{},items:[],sessions:[],totals:{cold:0,independentCold:0}};}
  function state(r){
    const e=r?.ev?.findLast(e=>e.verified);if(!e)return r?.observations?.length||r?.ev?.length||r?.imported?.length?'ØVER':'NY';
    if(!e.ok||!e.verified||e.s>=3||e.c==='gjetter')return 'ØVER';
    if(e.s===2)return 'MED_STØTTE';
    return r.retainedAt?'SITTER':'SELVSTENDIG';
  }
  // `now` is the caller's reference time (live UI events: the event time itself). No hidden clock reads.
  function event(memory,skill,e,now=e?.t){
    skill=skillId(skill);
    if(!e||!Number.isSafeInteger(e.t)||e.t<0||!Number.isSafeInteger(now)||!e.sid||!e.id||!['task','prøv','cold','word'].includes(e.k)||typeof e.ok!=='boolean')return false;
    const r=memory.skills[skill] ||= {ev:[],box:0,due:null};
    if(r.ev.some(x=>x.id===e.id)||(r.observations||[]).some(x=>x.id===e.id))return false;
    // An observation already followed by a verified event (`seenObs`) is older evidence; it cannot hold the anchor.
    const observation=r.observations?.at(-1),fresh=observation&&observation.id!==r.seenObs;
    const prior=Math.max(r.lastAt||0,fresh?observation.t:0);
    const lastSession=fresh&&observation.t>=prior?observation.sid:r.lastSession;
    // Clock boundary. Small backwards steps clamp to the last time (evidence kept, never "delayed").
    // A stored time far ahead of `now` is not an anchor: re-anchor at the event time instead of pinning the skill in the future.
    // `peak` (highest retained time) blocks delay credit when the clock comes back across an earlier jump.
    const peak=Math.max(prior,...r.ev.map(x=>x.t),...(r.observations||[]).map(x=>x.t));
    const plausible=x=>x<=now+CLOCK_SKEW;
    const last=plausible(peak)?peak:plausible(prior)?prior:0;
    const jump=!plausible(prior)||(plausible(peak)&&peak>prior+CLOCK_SKEW);
    const t=Math.max(e.t,last);
    const delayed=!jump&&e.k==='cold'&&last>0&&t-last>=DAY&&e.sid!==lastSession;
    if(jump)r.firstColdAt=null;// A retention interval cannot span a clock discontinuity.
    const v={t,s:level(e.s),ok:e.ok,k:e.k,e:['slurv','fakta','metode','begrep','tolking'].includes(e.e)?e.e:'',c:['sikker','usikker','gjetter'].includes(e.c)?e.c:'',sid:String(e.sid).slice(0,80),id:String(e.id).slice(0,120),verified:e.verified===true,delayed};
    // Observations never enter authoritative evidence or change its clock/checkpoints.
    if(!v.verified){v.delayed=false;r.observations=[...(r.observations||[]),v].slice(-LIMITS.observations);return v;}
    const independent=v.ok&&v.verified&&v.s<=1&&v.c!=='gjetter';
    if(v.k==='cold'&&delayed){memory.totals.cold++;if(independent)memory.totals.independentCold++;}
    if(!independent){r.firstColdAt=null;r.retainedAt=null;}
    if(independent){
      r.independentAt ||= v.t;
      if(delayed&&v.c!=='gjetter'){
        if(r.firstColdAt&&v.t-r.firstColdAt>=7*DAY)r.retainedAt=v.t;
        r.firstColdAt ||= v.t;
      }
    }
    if(v.ok&&v.verified&&v.s<=2){
      if(!r.box)r.box=1;
      else if(delayed&&independent&&v.c!=='gjetter')r.box=Math.min(5,r.box+1);
    }else if(r.box)r.box=Math.max(1,r.box-1);
    r.due=r.box?v.t+SPACING[r.box-1]*DAY:null;
    r.lastAt=v.t;r.lastSession=v.sid;if(r.observations?.length)r.seenObs=r.observations.at(-1).id;else delete r.seenObs;
    r.ev.push(v);r.ev=r.ev.slice(-8);
    return v;
  }
  // A due time beyond the longest spacing from `now` cannot come from a consistent clock and is due now.
  const dueBy=(d,now)=>d<=now||d>now+SPACING.at(-1)*DAY+CLOCK_SKEW;
  function due(memory,now){return Object.entries(memory.skills).filter(([id,r])=>CATALOG[id]?.generator&&r.due&&dueBy(r.due,now)).sort((a,b)=>a[1].due-b[1].due||a[0].localeCompare(b[0])).slice(0,3).map(([id])=>id);}
  function dueWords(memory,now){return (memory.items||[]).filter(w=>Number.isSafeInteger(w.due)&&dueBy(w.due,now));}
  function generate(id,seed=0,avoid=''){
    const spec=CATALOG[id];if(!spec?.generator)return null;
    for(let attempt=0;attempt<20;attempt++){
      const n=(Math.abs(Math.trunc(seed))+attempt)%997,a=n%9+1,b=Math.floor(n/9)%8+2;
      let expression='',prompt='',answer='',visual=null;
      switch(spec.generator){
        case 'add': {const x=id==='add1'?a:id==='addCarry'?(b%4+2)*10+a:(b%5+2)*10+(a%5);const y=id==='add1'?b:id==='addCarry'?10+(10-a+n%a):10+(b%4);expression=`${x}+${y}`;break;}
        case 'sub': {const x=id==='sub1'?a+b:id==='subBorrow'?30+a:40+b;const y=id==='sub1'?b:id==='subBorrow'?10+a+1:10+(b%4);expression=`${x}-${y}`;break;}
        case 'times': {const tables=id==='times2510'?[2,5,10]:id==='times34'?[3,4]:[6,7,8,9];expression=`${tables[n%tables.length]}*${b}`;break;}
        case 'divide':expression=`${a*b}/${b}`;break;
        case 'double':{const w=n%20+1;expression=`${w}+${w}`;break;}
        case 'half':expression=`${(n%20+1)*2}/2`;break;
        case 'friends':{const total=id==='friends10'?10:100;const part=id==='friends10'?a:a*10;expression=`${total}-${part}`;prompt=`${part} + ? = ${total}`;break;}
        case 'number':{const total=id==='number20'?a+10:id==='number100'?a*10+b:a*100+b*10;answer=String(total);prompt=`Skriv tallet: ${id==='number1000'?a+' hundrere og '+b+' tiere':Math.floor(total/10)+' tiere og '+total%10+' enere'}`;break;}
        case 'clock':{const h=a,m=id==='clockHour'?[0,30][n%2]:id==='clockQuarter'?[15,45][n%2]:(n%12)*5;answer=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;prompt='Hva viser klokka? Skriv timer:minutter.';visual={type:'klokke',hour:h,minute:m};break;}
        case 'money':{const coins=[20,10,5,1].slice(n%3);answer=String(coins.reduce((x,y)=>x+y,0));prompt='Hvor mange kroner er dette?';visual={type:'penger',coins};break;}
      }
      if(expression){const r=root.SparkArithmetic.parse(expression);answer=r.d==='1'?r.n:r.n+'/'+r.d;prompt ||= expression.replace('*',' × ').replace('/',' ÷ ')+' = ?';}
      const key=expression|| (visual?JSON.stringify(visual):prompt);
      if(key===avoid||(!visual&&prompt===avoid))continue;
      return {skill:id,prompt,answer,expression,visual,key};
    }
    return null;
  }
  // A short round of distinct items (no repeated key) from one skill.
  function round(id,seed=0,count=3){const out=[],seen=new Set();for(let k=0;k<count*20&&out.length<count;k++){const item=generate(id,Math.trunc(seed)+k*11,out.at(-1)?.key||'');if(item&&!seen.has(item.key)){seen.add(item.key);out.push(item);}}return out;}
  function checkItem(item,input){
    // Only money skills accept a trailing currency unit; the numeric value alone is checked.
    if(typeof input==='string'&&(item.skill==='money'||item.skill==='change'))input=input.replace(/(?<=\d)\s*(?:kr|kroner)\.?\s*$/i,'');
    if(item.expression)return root.SparkArithmetic.check(item.expression,input);
    if(item.skill?.startsWith('clock'))return {supported:true,ok:/^\d{1,2}:\d{2}$/.test(input.trim())&&input.trim().padStart(5,'0')===item.answer};
    if(item.word)return {supported:true,ok:input.trim().normalize('NFC').toLocaleLowerCase('nb')===item.answer.normalize('NFC').toLocaleLowerCase('nb')};
    return root.SparkArithmetic.check(item.answer,input);
  }
  function activity(session,now,visible=true){
    if(!Number.isSafeInteger(now))return;
    if(!session.startedAt)session.startedAt=now;
    const gap=now-(session.lastInteraction||now);
    if(visible&&session.lastInteraction&&gap>=0&&gap<=180000)session.activeMs=(session.activeMs||0)+gap;
    session.lastInteraction=visible?now:null;
    session.interactions ||= [];session.interactions.push(now);boundSession(session);
  }
  function boundSession(s){
    s.interactions=(Array.isArray(s.interactions)?s.interactions:[]).slice(-LIMITS.interactions);
    s.events=(Array.isArray(s.events)?s.events:[]).slice(-LIMITS.events);
    return s;
  }
  function aggregate(session,mode,end){
    const tasks=new Map();
    for(const e of session.events||[]){const key=e.id?.replace(/:\d+$/,'')||String(e.t);const prior=tasks.get(key);tasks.set(key,{...e,s:Math.max(e.s,prior?.s||0)});}
    return boundSession({id:session.id,startedAt:session.startedAt||null,endedAt:end,activeMs:session.activeMs||0,interactions:(session.interactions||[]).slice(),mode,events:[...tasks.values()],reflection:session.reflection||'',interventions:session.interventions||0});
  }
  function normalizeMemory(value){
    const out=empty();if(!value||value.version!==VERSION||typeof value.skills!=='object'||!value.skills)return out;
    const time=t=>Number.isSafeInteger(t)&&t>0?t:null;
    for(const [id,r] of Object.entries(value.skills)){
      if(!Object.hasOwn(CATALOG,id)||!r||!Array.isArray(r.ev))continue;
      const clean=list=>(Array.isArray(list)?list:[]).filter(e=>e&&time(e.t)&&Number.isInteger(e.s)&&e.s>=0&&e.s<=4&&typeof e.ok==='boolean'&&typeof e.id==='string'&&typeof e.sid==='string'&&['task','prøv','cold','word'].includes(e.k)).map(e=>({t:e.t,s:e.s,ok:e.ok,id:e.id.slice(0,120),sid:e.sid.slice(0,80),k:e.k,e:['slurv','fakta','metode','begrep','tolking'].includes(e.e)?e.e:'',c:['sikker','usikker','gjetter'].includes(e.c)?e.c:'',verified:e.verified===true,delayed:e.delayed===true}));
      const valid=clean([...r.ev,...(Array.isArray(r.observations)?r.observations:[])]),imported=clean(r.imported).slice(-LIMITS.imported);
      const ev=valid.filter(e=>e.verified).slice(-8),observations=valid.filter(e=>!e.verified).slice(-LIMITS.observations);
      if(!valid.length&&!imported.length)continue;
      const box=Number.isInteger(r.box)&&r.box>=0&&r.box<=5?r.box:0;
      out.skills[id]={ev,observations,box,due:box?time(r.due):null,lastAt:ev.at(-1)?.t||null,lastSession:ev.at(-1)?.sid||null,independentAt:time(r.independentAt),firstColdAt:time(r.firstColdAt),retainedAt:time(r.retainedAt),helped:['Tallinje','Dele opp','Tegne','Hint','Prøve igjen'].includes(r.helped)?r.helped:'',...(typeof r.seenObs==='string'&&observations.some(o=>o.id===r.seenObs.slice(0,120))?{seenObs:r.seenObs.slice(0,120)}:{}),...(imported.length?{imported}:{})};
    }
    if(Array.isArray(value.items))out.items=value.items.filter(w=>w&&typeof w.id==='string'&&typeof w.word==='string'&&typeof w.meaning==='string').slice(0,60).map(w=>({id:w.id.slice(0,80),word:w.word.slice(0,60),meaning:w.meaning.slice(0,160),sentence:typeof w.sentence==='string'?w.sentence.slice(0,220):'',box:Number.isInteger(w.box)&&w.box>=1&&w.box<=5?w.box:1,due:time(w.due),lastAt:time(w.lastAt),ev:Array.isArray(w.ev)?w.ev.filter(e=>e&&time(e.t)&&Number.isInteger(e.s)&&e.s>=0&&e.s<=4&&typeof e.ok==='boolean').slice(-8).map(e=>({t:e.t,s:e.s,ok:e.ok,delayed:e.delayed===true})):[]}));
    if(Array.isArray(value.sessions))out.sessions=value.sessions.filter(s=>s&&typeof s.id==='string'&&Array.isArray(s.events)).slice(-LIMITS.sessions).map(s=>({id:s.id.slice(0,80),startedAt:time(s.startedAt),endedAt:time(s.endedAt),activeMs:Number.isFinite(s.activeMs)&&s.activeMs>=0?s.activeMs:0,interactions:Array.isArray(s.interactions)?s.interactions.filter(t=>time(t)).slice(-LIMITS.interactions):[],mode:['matte','lesing','lekse','quiz'].includes(s.mode)?s.mode:'lekse',events:s.events.filter(e=>e&&Object.hasOwn(CATALOG,e.skill)&&time(e.t)&&Number.isInteger(e.s)&&e.s>=0&&e.s<=4).slice(-LIMITS.events).map(e=>({skill:e.skill,t:e.t,s:e.s,ok:e.ok===true,verified:e.verified===true,k:['task','prøv','cold','word'].includes(e.k)?e.k:'task',delayed:e.delayed===true,id:typeof e.id==='string'?e.id.slice(0,120):'',sid:typeof e.sid==='string'?e.sid.slice(0,80):'',e:['slurv','fakta','metode','begrep','tolking'].includes(e.e)?e.e:'',c:['sikker','usikker','gjetter'].includes(e.c)?e.c:'',...(e.item?{item:true}:{})})),reflection:['Tallinje','Dele opp','Tegne','Hint','Prøve igjen'].includes(s.reflection)?s.reflection:'',interventions:Number.isInteger(s.interventions)&&s.interventions>=0?s.interventions:0,...(s.imported===true?{imported:true}:{})}));
    out.totals={cold:Number.isInteger(value.totals?.cold)&&value.totals.cold>=0?value.totals.cold:0,independentCold:Number.isInteger(value.totals?.independentCold)&&value.totals.independentCold>=0?value.totals.independentCold:0};
    out.totals.independentCold=Math.min(out.totals.cold,out.totals.independentCold);
    return out;
  }
  // An imported copy is history, not verification authority: no file can prove it was checked by this device's checker.
  // Evidence moves to `imported` (shown, never counted); checkpoints, credit totals and anchors restart; practised skills and words are due for local revalidation.
  function quarantine(memory,now){
    for(const r of Object.values(memory.skills)){
      r.imported=[...(r.imported||[]),...r.ev,...r.observations].slice(-LIMITS.imported);
      r.ev=[];r.observations=[];r.box=r.box?1:0;r.due=r.box?now:null;
      r.lastAt=null;r.lastSession=null;r.independentAt=null;r.firstColdAt=null;r.retainedAt=null;r.helped='';delete r.seenObs;
    }
    for(const w of memory.items){w.box=1;w.due=now;w.lastAt=null;}
    for(const s of memory.sessions)s.imported=true;
    memory.totals={cold:0,independentCold:0};
    return memory;
  }
  function prune(k,now){
    k.sessions=(k.sessions||[]).slice(-LIMITS.archives).map(s=>({...s,msgs:Array.isArray(s.msgs)?s.msgs.slice(-40):[]}));
    if(k.learning)k.learning.sessions=(k.learning.sessions||[]).slice(-LIMITS.sessions).map(boundSession);
    for(const s of k.sessions||[]){const t=[s.endedAt,s.ts,s.migratedAt].find(n=>Number.isSafeInteger(n)&&n>0);if(t&&now-t>=30*DAY){s.msgs=[];delete s.transcript;delete s.history;}}
    return k;
  }
  // Learning-only allowlist. Token/server/secret storage is never read or backed up.
  const fields=['name','age','interests','stars','notes','log','sessions','level','learning','readAloud'];
  function migrate(storage,now){
    if(storage.getItem('spark_learning_migration')===MIGRATION)return true;
    const raw=storage.getItem('spark_kids');
    const saved=[];for(let i=0;i<100;i++){const s=storage.getItem('spark_session_'+i);if(s)saved.push([i,s]);}
    const legacy=storage.getItem('spark_session');
    let parsed;try{parsed=JSON.parse(raw||'[]');}catch{parsed=null;}
    const backup={id:MIGRATION,createdAt:now,kids:raw,sessions:saved,legacy};
    if(!storage.getItem('spark_learning_backup')&&!storage.setItem('spark_learning_backup',JSON.stringify(backup)))return false;
    const normalized=Array.isArray(parsed)?parsed.map(value=>{
      const k={};if(value&&typeof value==='object')for(const key of fields)if(Object.hasOwn(value,key))k[key]=value[key];
      k.learning=normalizeMemory(k.learning);
      if(Array.isArray(k.sessions))k.sessions=k.sessions.filter(s=>s&&typeof s==='object').map((s,i)=>({...s,id:s.id||'legacy-'+i,migratedAt:s.migratedAt||now,startedAt:Number.isSafeInteger(s.startedAt)?s.startedAt:null,endedAt:Number.isSafeInteger(s.endedAt)?s.endedAt:null}));
      for(const s of k.sessions||[])if(!k.learning.sessions.some(a=>a.id===s.id))k.learning.sessions.push({id:s.id,startedAt:s.startedAt,endedAt:s.endedAt,activeMs:0,mode:s.m,events:[],reflection:''});
      return prune(k,now);
    }):[];
    if(!storage.setItem('spark_kids',JSON.stringify(normalized)))return false;
    for(const [key,rawSession] of [...saved.map(([i,s])=>['spark_session_'+i,s]),...(legacy?[['spark_session',legacy]]:[])]){
      try{const s=JSON.parse(rawSession);if(s&&typeof s==='object'&&!Array.isArray(s)){if(!Number.isSafeInteger(s.migratedAt))s.migratedAt=now;if(!storage.setItem(key,JSON.stringify(s)))return false;}}catch{/* Original malformed text remains in its key and the recovery copy. */}
    }
    return storage.setItem('spark_learning_migration',MIGRATION);
  }
  function context(session,memory){
    const t=session?.task;if(!t)return '';
    const r=memory.skills[t.skill];
    return JSON.stringify({task:t.id,skill:t.skill,s:t.s,state:state(r),kind:session.check?.kind||'task',helped:r?.helped||'',reading:session.readingGoal||''}).slice(0,300);
  }
  root.SparkLearning={DAY,CLOCK_SKEW,VERSION,MIGRATION,SPACING,LIMITS,CATALOG,skillId,level,task,support,marker,empty,state,event,due,dueWords,generate,round,checkItem,activity,boundSession,aggregate,normalizeMemory,quarantine,prune,migrate,context};
})(globalThis);
