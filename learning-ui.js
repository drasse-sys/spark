/* C3 integration. The existing app owns navigation, pairing, photos and provider calls. */
const L=SparkLearning, V=SparkVisuals, A=SparkArithmetic;
let learningSession=null, nextVisuals=[], pendingWords=[], readingSentence=-1, readingRun=0;
function freshLearning(){
  const id=currentSessionId||newSessionId();currentSessionId=id;
  learningSession={id,startedAt:Date.now(),activeMs:0,interactions:[],events:[],task:L.task('t1'),taskCount:1,transferCount:0,interventions:0};
  L.activity(learningSession,Date.now());return learningSession;
}
function ensureLearning(){if(!learningSession||learningSession.id!==currentSessionId)freshLearning();kid().learning ||= L.empty();return learningSession;}
function touchLearning(){if(readOnly)return;L.activity(ensureLearning(),Date.now(),!document.hidden);}
function resetLearning(){learningSession=null;nextVisuals=[];pendingWords=[];readingSentence=-1;readingRun++;}
function restoreLearning(s){
  resetLearning();
  if(s.learning&&s.learning.id===s.id&&s.learning.task&&Array.isArray(s.learning.events)){
    learningSession=s.learning;L.boundSession(learningSession);learningSession.task.s=L.level(learningSession.task.s);learningSession.lastInteraction=null;learningSession.answerTarget=null;
  }else freshLearning();
}
function nextLearningTask(skill='annet'){
  const s=ensureLearning();s.task=L.task('t'+(++s.taskCount),skill);s.check=null;s.answerTarget=null;s.transferOffer=null;s.softHelp=false;s.confidence='';saveSession();
}
function detectExpression(text){
  const clean=String(text||'').trim().replace(/^(?:regn(?: ut)?|hva er)\s+/i,'').replace(/[?=]\s*$/,'').trim();
  return A.parse(clean)&&/[+\-−×*·÷/:]/.test(clean)?clean.replace(/\s/g,'').replace(/−/g,'-').replace(/[×·]/g,'*').replace(/[÷:]/g,'/'):'';
}
function arithmeticSkill(expression){
  const m=expression.replace(/\s/g,'').match(/^(\d{1,2})([+\-−×*·÷/:])(\d{1,2})$/);
  if(!m)return 'annet';const a=+m[1],b=+m[3],op=m[2];
  if(/[×*·]/.test(op))return a<=10&&b<=10?(a===3||a===4?'times34':a>=6&&a<=9?'times69':'times2510'):'annet';
  if(/[÷/:]/.test(op))return b&&a%b===0?'divide':'annet';
  if(/[-−]/.test(op))return a>=b?(a<=20?'sub1':a%10<b%10?'subBorrow':'sub2'):'annet';
  return a+b<=20?'add1':a%10+b%10>=10?'addCarry':'add2';
}
function initHomeworkLearning(text){
  freshLearning();const expression=detectExpression(text);
  if(expression){learningSession.task.expression=expression;learningSession.task.skill=arithmeticSkill(expression);}
  if(taskMode==='lesing'){learningSession.readingText=text.slice(0,12000);learningSession.readingGoal='comprehension';}
}
function learningContext(){return L.context(ensureLearning(),kid().learning);}
function recordLearning(ok,verified,kind='task',error='',confidence=''){
  const s=ensureLearning(),t=s.task;
  const e=L.event(kid().learning,t.skill,{id:s.id+':'+t.id+':'+t.attempts,t:Date.now(),sid:s.id,s:t.s,ok,verified,k:kind,e:error,c:confidence});
  if(e){s.events.push({...e,skill:t.skill});L.boundSession(s);saveKids();}
  return e;
}
function offerTransfer(){
  const s=ensureLearning(),t=s.task;
  if(s.transferCount||s.practice||!t.completed||t.s<2||t.skill==='annet')return;
  const item=L.generate(t.skill,s.taskCount+Date.now()%997,t.lastPrompt||t.expression||'');
  if(item&&item.expression!==t.expression){s.transferOffer=item;s.transferCount++;}
}
function receiveLearning(raw){
  const s=ensureLearning(),t=s.task,m=L.marker(raw);
  s.answerTarget=null;
  nextVisuals=V.extract(raw);pendingWords=[];
  if(!s.check||s.check.item?.model){
    // Unmarked tutor content cannot be evidence of unaided work.
    L.support(t,Math.max(2,m?.s||0));
    if(nextVisuals.length)L.support(t,2);
    if(m){
      if(t.skill==='annet')t.skill=m.skill;
      if(!t.completed&&t.attempts>0){recordLearning(m.ok,false,'task',m.e);if(m.ok){t.completed=true;offerTransfer();}}
    }
  }
  if(taskMode==='lesing'){
    if(!s.readingText&&transcript)s.readingText=transcript.slice(0,12000);
    for(const m of raw.matchAll(/\[\[ORD:\s*([^|\]\n]{1,60})\|([^|\]\n]{1,160})\|([^\]\n]{1,220})\]\]/g))pendingWords.push({word:m[1].trim(),meaning:m[2].trim(),sentence:m[3].trim()});
    pendingWords=pendingWords.slice(0,3);
  }
  // Non-numeric transfer remains explicitly tutor-observed, never a checked badge.
  const proposed=raw.match(/\[\[PRØV:\s*([^|\]\n]+)\|([^\]]{1,250})\]\]/);
  if(proposed&&t.completed&&t.s>=2&&!s.transferCount&&!s.practice){s.transferOffer={skill:L.skillId(proposed[1].trim()),prompt:proposed[2].trim(),model:true};s.transferCount++;}
}
function stripLearningMarkers(raw){return raw.replace(/\[\[[\s\S]*?(?:\]\]|$)/g,'').replace(/⭐?\s*POENG!?/gi,'').trim();}
function learningReply(text,visuals=[]){chatMsgs.push({role:'assistant',text,ts:Date.now(),visuals});saveSession();render();}
function ownHomeworkAnswer(){
  const s=ensureLearning(),t=s.task;
  if(busy||readOnly||pendingFinal||s.check||s.practice||t.completed||!A.parse(t.expression))return;
  s.answerTarget={sid:s.id,task:t.id,child:active,expression:t.expression};
  learningReply('Sjekk hele regnestykket: '+t.expression+' = ?\nSkriv svaret, eller velg «Tilbake til samtalen».');
}
function interceptAnswer(input){
  const s=ensureLearning(),t=s.task,item=s.check?.item;
  if(s.check?.done){learningReply('Denne er ferdig. Du kan gå videre eller avslutte.');return true;}
  const owner=s.answerTarget;
  if(!item&&(!owner||owner.sid!==s.id||owner.task!==t.id||owner.child!==active||owner.expression!==t.expression||t.completed))return false;
  if(item?.model)return false;
  const verdict=item?L.checkItem(item,input):A.check(owner.expression,input);
  if(!verdict.supported){learningReply('Skriv bare svaret, for eksempel 12, 1,5 eller 1/2. Du kan også velge hjelp.');return true;}
  stopSpeak();stopMic();$('msg').value='';touchLearning();t.attempts++;
  chatMsgs.push({role:'user',text:input,ts:Date.now()});history.push({role:'user',content:input});
  const confidence=$('confidence')?.value||s.confidence||'';
  const kind=s.check?.kind||'task';
  if(item?.word)recordWord(item,verdict.ok,t.s,confidence);
  else recordLearning(verdict.ok,true,kind,'',confidence);
  let reply;
  if(verdict.ok){
    t.completed=true;
    s.answerTarget=null;
    reply=confidence==='gjetter'?'Svaret stemmer.':t.s===0?'✓ Klarte selv.':t.s===1?'Du fant svaret etter en liten påminnelse.':'Du fant svaret med hjelp.';
    if(kind==='cold'&&confidence==='gjetter')reply+=' Du valgte «gjetter». Vi prøver igjen en annen dag.';
    if(s.check)s.check.done=true;else offerTransfer();
  }else{
    reply=item?.word?'Vi øver på ordet fra ordlisten. Et annet ord kan også passe. Prøv igjen, eller velg hjelp.':'Prøv å sjekke én gang til. Du kan velge hjelp eller gå videre.';L.support(t,1);
  }
  history.push({role:'assistant',content:reply});learningReply(reply);return true;
}
function beginCheck(item,kind='prøv'){
  nextLearningTask(item.skill);const s=ensureLearning();s.check={item,kind,done:false};s.task.lastPrompt=item.key||item.prompt;s.task.expression=item.expression||'';
  history.push({role:'user',content:'Prøv selv: '+item.prompt});
  learningReply('Prøv selv — du kan hoppe over.\n'+item.prompt,item.visual?[item.visual]:[]);
}
function preparePractice(){
  if(busy)return false;
  const saved=loadSession();
  if(saved){
    if(!confirm('Den uferdige økten lagres før du begynner å øve. Fortsette?'))return false;
    chatMsgs=saved.chatMsgs;history=saved.history;transcript=saved.transcript;taskMode=saved.mode;currentSessionId=saved.id;restoreLearning(saved);
    if(!archiveSession(saved.pendingFinal?.summary||''))return false;
  }
  stopSpeak();stopMic();readOnly=false;pendingFinal=null;chatMsgs=[];history=[];transcript='';currentSessionId='';$('msg').value='';taskMode='matte';freshLearning();learningSession.practice=true;view='chat';return true;
}
function startPractice(type){
  const memory=kid().learning ||= L.empty(),now=Date.now();
  let items=type==='review'?L.due(memory,now).map((id,i)=>L.generate(id,Math.floor(now/L.DAY)+i)):
    type==='words'?memory.items.slice(0,3).map(wordItem):[0,1,2].map(n=>L.generate('times2510',Math.floor(now/1000)+n*11));
  if(type==='review')items=[...items,...L.dueWords(memory,now).map(wordItem)].slice(0,3);
  items=items.filter(Boolean);if(!items.length){startNotice='Ingen oppgaver å hente fram akkurat nå. Du kan fortsette med leksa.';render();return;}
  if(!preparePractice())return;
  learningSession.queue=items;learningSession.practiceKind=type==='review'?'cold':'task';advancePractice();
}
function advancePractice(){
  const s=ensureLearning(),item=s.queue?.shift();
  if(item){beginCheck(item,s.practiceKind);return;}
  s.check=null;s.practiceDone=true;learningReply('Det var dagens lille runde. Du kan avslutte nå.');
}
function wordItem(item){return {skill:'readWord',word:true,itemId:item.id,prompt:item.meaning?'Hvilket ord fra ordlisten betyr «'+item.meaning+'»?':'Skriv ordet du hører.',answer:item.word,sentence:item.sentence};}
function recordWord(item,ok,s,c){
  const w=kid().learning.items.find(w=>w.id===item.itemId);if(!w)return;
  const now=Date.now(),delayed=w.lastAt&&now-w.lastAt>=L.DAY;
  if(ok&&s<=1&&c!=='gjetter'&&delayed)w.box=Math.min(5,(w.box||1)+1);else if(!ok||s>=3)w.box=Math.max(1,(w.box||1)-1);
  w.box ||=1;w.lastAt=now;w.due=now+L.SPACING[w.box-1]*L.DAY;
  w.ev ||= [];w.ev.push({t:now,s,ok,delayed:!!delayed});w.ev=w.ev.slice(-8);
  ensureLearning().events.push({skill:'readWord',t:now,s,ok,verified:true,k:'word',delayed:!!delayed,item:true});L.boundSession(learningSession);saveKids();
}
function helpStep(n){
  if(busy||readOnly||pendingFinal)return;
  const s=ensureLearning(),t=s.task;
  if(kid().age>=8&&!t.attempts&&!s.softHelp){s.softHelp=true;learningReply('Prøv ett steg først? Det er lov å bomme. Trykk på hjelpen igjen hvis du vil.');return;}
  touchLearning();L.support(t,n);s.softHelp=false;
  s.answerTarget=null;
  if(s.check?.item?.word){learningReply('Ordet er «'+s.check.item.answer+'». Prøv å bruke det i en setning.');L.support(t,4);s.check.done=true;saveSession();render();return;}
  if(s.check){s.check.help=true;s.check=null;}
  $('msg').value=n===1?'Gi meg bare en liten påminnelse, uten metode.':n===2?'Gi meg et lite hint.':n===3?'Del oppgaven i mindre steg.':'Vis metoden med et annet, lignende eksempel.';
  send();
}
function learningQuick(){
  if(readOnly){quick.innerHTML='';return;}
  const s=ensureLearning(),t=s.task;
  quick.innerHTML=`<span class="ladder-label">${['Du prøver selv','Liten påminnelse','Et hint','Mindre steg','Et eksempel'][t.s]} · velg hjelp når du vil</span>`+
    [[1,'Lite puff'],[2,'Lite hint'],[3,'Mindre steg'],[4,'Vis et eksempel']].map(([n,label])=>`<button class="qb" data-help="${n}" ${busy||pendingFinal?'disabled':''}>${n}. ${label}</button>`).join('')+
    `<button class="qb" id="stuckBtn">Jeg vet ikke</button><button class="qb" id="pauseLearning">Pause / for vanskelig</button>`;
  quick.querySelectorAll('[data-help]').forEach(b=>{b.disabled ||= +b.dataset.help>2&&t.s<+b.dataset.help-1&&!t.attempts;b.onclick=()=>helpStep(+b.dataset.help);});
  $('stuckBtn').onclick=()=>{s.softHelp=true;helpStep(2);};
  $('pauseLearning').onclick=()=>{if(busy)return;stopSpeak();stopMic();s.lastInteraction=null;saveSession();view='start';startNotice='Vi tar pause. Oppgaven er lagret, og du kan fortsette eller avslutte senere.';render();};
}
function renderLearningPanel(box){
  if(readOnly)return;
  const s=ensureLearning(),panel=document.createElement('div');panel.className='learning-panel';
  if(s.activeMs>=25*60000)panel.innerHTML+='<p class="note">Du har jobbet en stund. Du kan ta pause eller avslutte nå.</p>';
  if(!s.check&&!s.practice&&!s.task.completed&&s.task.expression)panel.innerHTML+=s.answerTarget?'<p>Svarer på hele regnestykket: '+esc(s.answerTarget.expression)+' = ?</p><button class="qb" id="cancelAnswerTarget">Tilbake til samtalen</button>':'<button class="qb" id="checkHomework">Sjekk svaret på '+esc(s.task.expression)+'</button>';
  if(s.transferOffer){panel.innerHTML+='<button class="btn ghost sm" id="trySelf">Prøv én lignende oppgave selv</button><button class="qb" id="skipTransfer">Hopp over</button>';}
  if(s.check?.kind==='cold'&&kid().age>=8&&!s.check.done)panel.innerHTML+='<label for="confidence">Før du sender (valgfritt)</label><select id="confidence"><option value="">Velg om du vil</option><option value="sikker">Sikker</option><option value="usikker">Litt usikker</option><option value="gjetter">Gjetter</option></select>';
  if(s.check||s.practice&&!s.practiceDone)panel.innerHTML+=`<button class="qb" id="skipCheck">${s.check?.done?'Ferdig med denne':'Hopp over denne'}</button>`;
  if(!s.check&&!s.practice)panel.innerHTML+='<button class="qb" id="nextLearningTask">Neste deloppgave</button>';
  panel.innerHTML+='<details><summary>Hva hjalp i dag? (valgfritt)</summary><select id="reflection" aria-label="Hva hjalp i dag?"><option value="">Hopp over</option><option>Tallinje</option><option>Dele opp</option><option>Tegne</option><option>Hint</option><option>Prøve igjen</option></select></details>';
  box.appendChild(panel);
  if($('checkHomework'))$('checkHomework').onclick=ownHomeworkAnswer;
  if($('cancelAnswerTarget'))$('cancelAnswerTarget').onclick=()=>{s.answerTarget=null;saveSession();render();};
  if($('trySelf'))$('trySelf').onclick=()=>{if(busy)return;const item=s.transferOffer;s.transferOffer=null;beginCheck(item);};
  if($('skipTransfer'))$('skipTransfer').onclick=()=>{s.transferOffer=null;saveSession();render();};
  if($('skipCheck'))$('skipCheck').onclick=()=>{if(busy)return;if(s.practice)advancePractice();else{nextLearningTask();learningReply('Vi fortsetter når du vil.');}};
  if($('nextLearningTask'))$('nextLearningTask').onclick=()=>{if(busy)return;nextLearningTask();learningReply('Skriv den neste deloppgaven når du er klar.');};
  if($('confidence')){$('confidence').value=s.confidence||'';$('confidence').onchange=e=>{s.confidence=e.target.value;saveSession();};}
  $('reflection').value=s.reflection||'';$('reflection').onchange=e=>{s.reflection=e.target.value;saveSession();};
  if(taskMode==='lesing')renderReading(box);
}
function learningStartHTML(){
  const memory=kid().learning ||= L.empty(),count=L.due(memory,Date.now()).length+L.dueWords(memory,Date.now()).length;
  const learned=Object.entries(memory.skills).filter(([,r])=>['SELVSTENDIG','SITTER'].includes(L.state(r)));
  return `<details class="practice"><summary>En liten øverunde${count?' · noe er klart for repetisjon':''}</summary><p class="t2">Inntil tre oppgaver. Du kan hoppe over.</p><button class="btn ghost sm" id="reviewStart">5-minutters oppvarming</button><button class="qb" id="timesStart">Gangetabell</button><button class="qb" id="wordsStart">Ukeord / gloser</button><details><summary>Legg inn ord til øving</summary><label for="wordList">Ett ord | forklaring per linje (maks 20)</label><textarea id="wordList" rows="3" placeholder="house | hus"></textarea><button class="qb" id="saveWords">Lagre ordene</button></details></details>
  ${learned.length?`<details><summary>Ting jeg kan nå</summary>${learned.map(([id,r])=>`<p>${esc(L.CATALOG[id].label)} · ${L.state(r)==='SITTER'?'Sitter':'Klarte med lite eller ingen hjelp'} · ${new Date(r.independentAt).toLocaleDateString('nb-NO')}</p>`).join('')}</details>`:''}`;
}
function bindLearningStart(){
  $('reviewStart').onclick=()=>startPractice('review');$('timesStart').onclick=()=>startPractice('times');$('wordsStart').onclick=()=>startPractice('words');
  $('saveWords').onclick=()=>{
    const rows=$('wordList').value.split('\n').filter(s=>s.trim());
    if(rows.length>20||rows.some(s=>{const a=s.split('|');return a.length!==2||!a.every(x=>x.trim())||a[0].trim().length>60||a[1].trim().length>160;})){alert('Bruk ord | forklaring, én per linje, inntil 20.');return;}
    for(const row of rows){const [word,meaning]=row.split('|').map(s=>s.trim());saveWord({word,meaning,sentence:''});}
    saveKids();startNotice='Ordene er lagret på denne telefonen.';render();
  };
}
function saveWord(w){
  const items=kid().learning.items;
  if(items.some(i=>i.word===w.word&&i.meaning===w.meaning))return;
  if(items.length>=60){alert('Ordlisten er full. Fjern gamle ord i foreldreoversikten først.');return;}
  items.push({...w,id:newSessionId(),box:1,due:Date.now()+L.DAY,ev:[]});
}
function parentEventLabel(e){
  if(!e.verified)return 'tutorobservasjon · støtte S'+e.s;
  if(!e.ok)return 'forsøk uten riktig svar · støtte S'+e.s;
  if(e.c==='gjetter')return 'riktig svar, barnet valgte gjetting · støtte S'+e.s;
  return e.s===0?'klarte selv':e.s===1?'klarte med liten påminnelse':'klarte med støtte S'+e.s;
}
function parentHTML(){
  const m=kid().learning ||= L.empty(),records=Object.entries(m.skills),sessions=m.sessions.slice().sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));
  const names=records.map(([id,r])=>{const events=r.ev||[],sessions=new Set(events.filter(e=>e.s>=3||e.e==='begrep').map(e=>e.sid));return `<li>${esc(L.CATALOG[id]?.label||id)}: ${esc({NY:'Ny',ØVER:'Øver på',MED_STØTTE:'Klarer med hint',SELVSTENDIG:'Klarte med lite eller ingen hjelp',SITTER:'Sitter etter utsatte sjekker'}[L.state(r)])}${r.independentAt?' · selvstendig '+new Date(r.independentAt).toLocaleDateString('nb-NO'):''}${r.retainedAt?' · sitter '+new Date(r.retainedAt).toLocaleDateString('nb-NO'):''}${r.due?' · repetisjon '+new Date(r.due).toLocaleDateString('nb-NO'):''}${sessions.size>=2?' · trengte mye støtte i flere økter':''}${r.helped?' · hjalp: '+esc(r.helped):''}</li>`;}).join('');
  const weeks=[3,2,1,0].map(n=>{const end=Date.now()-n*7*L.DAY,start=end-7*L.DAY;const counts=[0,0,0];for(const s of sessions)for(const e of s.events||[])if(e.t>=start&&e.t<end&&e.ok===true&&e.verified===true&&e.c!=='gjetter')counts[e.s<=1?0:e.s===2?1:2]++;return counts;});
  const max=Math.max(1,...weeks.map(a=>a.reduce((x,y)=>x+y,0)));
  const bars=weeks.map((counts,i)=>{let y=100;return counts.map((n,j)=>{const h=n/max*85;y-=h;return `<rect x="${20+i*65}" y="${y}" width="38" height="${h}" fill="${['#2a7558','#b78a26','#7851a9'][j]}"/>`;}).join('');}).join('');
  return `<section class="prof"><h2>Læring over tid</h2><p>Observasjoner av oppgaver, ikke en vurdering av barnet. Samtaler vises bare i «Tidligere økter».</p><ul>${names||'<li>Ingen læringshendelser ennå.</li>'}</ul>
    <svg viewBox="0 0 290 125" role="img" aria-label="Bekreftede riktige svar de siste fire ukene. ${weeks.map((a,i)=>'Uke '+(i+1)+': S0–S1 '+a[0]+', S2 '+a[1]+', S3–S4 '+a[2]).join('. ')}">${bars}<text x="10" y="120" font-size="11">Fire uker siden → nå · S0–S1 / S2 / S3–S4</text></svg><p>Kun bekreftede riktige svar: grønn med lite/ingen støtte (S0–S1), gul med hint (S2), lilla med mye støtte (S3–S4). Forsøk uten bekreftet riktig svar og gjetting er ikke med. Høyeste støtte per oppgave, ikke poeng.</p>
    <p>Utsatte sjekker: ${m.totals.independentCold} med lite/ingen støtte av ${m.totals.cold} observerte. Dette er et læringssignal, ikke en karakter.</p>
    ${sessions.slice(0,30).map(s=>`<p>${s.startedAt?new Date(s.startedAt).toLocaleString('nb-NO'):'Eldre økt – tidspunkt ukjent'} · ${esc(MODE_NAME[s.mode]||s.mode)} · ${Math.round(s.activeMs/60000)} aktive minutter<br>${(s.events||[]).map(e=>esc(L.CATALOG[e.skill]?.label||e.skill)+' — '+parentEventLabel(e)).join('<br>')}${s.reflection?'<br>Hva hjalp: '+esc(s.reflection):''}</p>`).join('')}
    <p>Samtaleforslag: Be barnet vise én ting det fant ut selv. La barnet være læreren.</p><p>Les høyt sammen med en voksen. Spark vurderer ikke uttale eller leseflyt.</p>
    <label><input type="checkbox" id="readAloudAllowed" ${kid().readAloud?'checked':''}> Tillat «Les for meg» ved tekstforståelse</label>
    <p>Mikrofon er valgfri. Nettleseren kan sende tale til sin skytjeneste. Spark lagrer ikke lyd. Gjenkjent tekst må sjekkes før sending. Inntil 8 samtaler beholdes i maksimalt 30 dager. Inntil 120 lette øktoppsummeringer og kompakt ferdighetsevidens beholdes lokalt.</p>
    <button class="qb" id="clearWords">Tøm ordlisten</button><button class="qb" id="exportLearning">Last ned læringskopi</button><label for="importLearning">Gjenopprett læringskopi som nye profiler</label><input id="importLearning" type="file" accept="application/json"><button class="qb" id="recoverLearning">Gjenopprett sikkerhetskopi før migrering</button><button class="qb" id="deleteLearning">Slett all historikk for dette barnet</button></section>`;
}
function learningExport(){kids.forEach(k=>L.prune(k,Date.now()));return {schema:'spark-learning-export-v3',createdAt:Date.now(),kids:kids.map(k=>({name:k.name,age:k.age,interests:k.interests,notes:k.notes,log:k.log,sessions:k.sessions,learning:k.learning,readAloud:!!k.readAloud}))};}
function bindParent(){
  $('readAloudAllowed').onchange=e=>{kid().readAloud=e.target.checked;saveKids();};
  $('clearWords').onclick=()=>{if(confirm('Tømme ordlisten for dette barnet?')){kid().learning.items=[];saveKids();render();}};
  $('exportLearning').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(learningExport())],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='spark-laeringskopi.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  $('importLearning').onchange=async e=>{try{const file=e.target.files[0];if(!file||file.size>4000000)throw Error('For stor fil.');const data=JSON.parse(await file.text());const imported=validateImport(data);if(!confirm('Legge til '+imported.length+' profiler fra kopien? Eksisterende barn beholdes.'))return;const oldLength=kids.length;kids.push(...imported);if(!saveKids()){kids.length=oldLength;throw Error('Lagringen er full. Kopien er ikke importert.');}render();}catch(err){alert('Kunne ikke lese læringskopien: '+err.message);}};
  $('recoverLearning').onclick=()=>{
    const raw=store.getItem('spark_learning_backup');if(!raw){alert('Ingen migreringskopi finnes.');return;}
    if(!confirm('Gjenopprette tidligere data som nye profiler? Nåværende barn beholdes.'))return;
    try{const backup=JSON.parse(raw),old=JSON.parse(backup.kids||'[]');if(!Array.isArray(old))throw Error('Ugyldig eldre data');const imported=old.map(k=>({...blankKid(''),name:typeof k?.name==='string'?k.name:'Gjenopprettet',age:Number.isInteger(k?.age)?k.age:8,notes:Array.isArray(k?.notes)?k.notes.filter(n=>typeof n==='string'):[],log:Array.isArray(k?.log)?k.log.filter(e=>e&&['d','m','t'].every(x=>typeof e[x]==='string')).slice(-20):[],sessions:Array.isArray(k?.sessions)?k.sessions.filter(s=>validChat(s?.msgs)).map(s=>({...s,migratedAt:Number.isSafeInteger(s.migratedAt)?s.migratedAt:Date.now()})):[],learning:L.empty()}));imported.forEach(k=>L.prune(k,Date.now()));const offset=kids.length;kids.push(...imported);if(!saveKids()){kids.length=offset;return;}for(const [i,session] of backup.sessions||[]){if(i>=imported.length)continue;try{const s=JSON.parse(session);s.kid=offset+i;if(!Number.isSafeInteger(s.migratedAt)&&!Number.isSafeInteger(s.ts))s.migratedAt=Date.now();store.setItem(sessionKey(offset+i),JSON.stringify(s));}catch{}}render();}catch{alert('Kopien kunne ikke gjenopprettes automatisk. Den er bevart lokalt.');}
  };
  $('deleteLearning').onclick=()=>{if(!confirm('Slette økter, notater, ord og læringshistorikk for dette barnet?'))return;const k=kid();k.notes=[];k.log=[];k.sessions=[];k.learning=L.empty();store.removeItem(sessionKey());const raw=store.getItem('spark_learning_backup');if(raw){try{const b=JSON.parse(raw),old=JSON.parse(b.kids||'[]');if(Array.isArray(old)){old[active]=null;b.kids=JSON.stringify(old);}b.sessions=(b.sessions||[]).filter(([i])=>i!==active);b.legacy=null;store.setItem('spark_learning_backup',JSON.stringify(b));}catch{store.removeItem('spark_learning_backup');}}resetLearning();chatMsgs=[];history=[];transcript='';saveKids();render();};
}
function validateImport(data){
  if(data?.schema!=='spark-learning-export-v3'||!Array.isArray(data.kids)||!data.kids.length||data.kids.length>20)throw Error('Ukjent format.');
  return data.kids.map(k=>{
    if(!k||typeof k.name!=='string'||!Number.isInteger(k.age)||k.age<4||k.age>16||k.learning?.version!==3||!Array.isArray(k.learning.items)||!Array.isArray(k.learning.sessions)||!k.learning.skills)throw Error('Ugyldig profil.');
    const clean={...blankKid(k.name.slice(0,40)),age:k.age,interests:String(k.interests||'').slice(0,120),notes:Array.isArray(k.notes)?k.notes.filter(n=>typeof n==='string').slice(-12):[],log:[],sessions:[],learning:L.empty(),readAloud:k.readAloud===true};
    for(const [id,r] of Object.entries(k.learning.skills)){
      if(!Object.hasOwn(L.CATALOG,id)||!Array.isArray(r.ev))throw Error('Ukjent ferdighet.');
      for(const e of r.ev)if(!L.event(clean.learning,id,e))throw Error('Ugyldig læringshendelse.');
    }
    // Preserve validated checkpoints, schedules and word evidence across export/import.
    const memory=L.normalizeMemory(k.learning);
    clean.learning=memory;
    clean.log=Array.isArray(k.log)?k.log.filter(e=>e&&['d','m','t'].every(key=>typeof e[key]==='string')).map(e=>({d:e.d,m:e.m,t:e.t.slice(0,240),...(Number.isSafeInteger(e.ts)?{ts:e.ts}:{})})):[];
    clean.sessions=(k.sessions||[]).filter(s=>typeof s?.d==='string'&&typeof s.m==='string'&&typeof s.t==='string'&&Array.isArray(s.msgs)).map(s=>({id:String(s.id||newSessionId()),d:s.d,m:s.m,t:s.t.slice(0,60),summary:String(s.summary||'').slice(0,260),startedAt:s.startedAt,endedAt:s.endedAt,migratedAt:Date.now(),msgs:s.msgs.filter(m=>['assistant','user'].includes(m?.role)&&typeof m.text==='string').map(m=>({role:m.role,text:m.text,ts:m.ts}))}));
    return L.prune(clean,Date.now());
  });
}
function readingSentences(){return (ensureLearning().readingText||transcript||'').match(/[^.!?]+[.!?]*/g)?.slice(0,60)||[];}
function readPassage(){
  if(!kid().readAloud||ensureLearning().readingGoal!=='comprehension')return;
  const sentences=readingSentences(),voice=pickVoice();if(!voice){speak(' ',0,true);voiceNotice='Ingen norsk stemme er tilgjengelig. Les teksten sammen med en voksen.';showStatus();return;}
  stopSpeak();const run=++readingRun;let n=0;
  const next=()=>{if(run!==readingRun||view!=='chat'||taskMode!=='lesing')return;if(n>=sentences.length){readingSentence=-1;render();return;}readingSentence=n;render();const u=new SpeechSynthesisUtterance(sentences[n]);u.voice=voice;u.lang=voice.lang.replace(/_/g,'-');u.rate=.9;u.onend=()=>{n++;next();};u.onerror=()=>{readingSentence=-1;render();};synth.speak(u);};next();
}
function renderReading(box){
  const s=ensureLearning(),node=document.createElement('section');node.className='reading-panel';
  node.innerHTML=`<h2>Les og fortell</h2><p class="t2">Les en liten del, og fortell med egne ord. Mikrofonen lager bare et tekstforslag. Du kan rette det før du sender. Spark vurderer ikke uttale eller leseflyt.</p><label for="readingGoal">Hva øver du på?</label><select id="readingGoal"><option value="comprehension">Forstå teksten</option><option value="decoding">Lese høyt for en voksen</option></select>
    ${readingSentences().length?`<details><summary>Teksten</summary><p>${readingSentences().map((t,i)=>`<span ${readingSentence===i?'class="reading-active"':''}>${esc(t)}</span>`).join(' ')}</p></details>`:''}
    ${kid().readAloud&&s.readingGoal==='comprehension'?'<button class="qb" id="readPassage">Les for meg</button><button class="qb" id="stopPassage">Stopp</button>':''}
    <button class="qb" data-reading="Fortell om hvem eller hva teksten handler om, hva som skjedde og hvordan det endte. Be meg bare om én ting om gangen.">Gjenfortell</button><button class="qb" data-reading="Hjelp meg å finne hovedideen og ett viktig spor i teksten.">Hovedidé</button>${!s.predictionUsed?'<button class="qb" id="predictReading">Hva skjer videre?</button>':''}
    ${pendingWords.map((w,i)=>`<button class="qb" data-word="${i}">Øv senere: ${esc(w.word)}</button>`).join('')}`;
  box.appendChild(node);$('readingGoal').value=s.readingGoal||'comprehension';$('readingGoal').onchange=e=>{s.readingGoal=e.target.value;readingRun++;stopSpeak();saveSession();render();};
  if($('readPassage'))$('readPassage').onclick=readPassage;if($('stopPassage'))$('stopPassage').onclick=()=>{readingRun++;readingSentence=-1;stopSpeak();render();};
  node.querySelectorAll('[data-reading]').forEach(b=>b.onclick=()=>{if(busy)return;$('msg').value=b.dataset.reading;send();});
  if($('predictReading'))$('predictReading').onclick=()=>{if(busy)return;s.predictionUsed=true;$('msg').value='La meg gjette hva som skjer videre før vi leser slutten. Spør etter ett spor etterpå.';send();};
  node.querySelectorAll('[data-word]').forEach(b=>b.onclick=()=>{saveWord(pendingWords[+b.dataset.word]);saveKids();b.disabled=true;b.textContent='Lagret til senere';});
}
