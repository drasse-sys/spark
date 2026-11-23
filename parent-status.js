/* Parent-only diagnostics. No conversation or account data is written or copied. */
const SPARK_TIMING_KEY='spark_ai_status_v1';
const SPARK_PROBE_KEY='spark_status_probe';
const SPARK_RESULTS={
  normal:'Normal',daily_quota:'Dagskvoten er brukt opp',minute_quota:'For mange forespørsler på kort tid',
  unavailable:'AI-tjenesten er midlertidig utilgjengelig',network:'Nettverksproblem',
  timeout:'Tidsavbrudd',connection:'Enheten må kobles til på nytt'
};
let sparkTiming, sparkRegistration, sparkStatusPanel;

function publicProvider(value){
  return ['gemini','openrouter','groq'].includes(value)?value:null;
}
function publicModel(provider,value){
  if(provider==='gemini'&&typeof value==='string'&&/^gemini-\d{1,2}\.\d{1,2}-flash(?:-lite)?$/.test(value))return value;
  if(provider==='openrouter'&&value==='openrouter/free')return value;
  if(provider==='groq'&&value==='openai/gpt-oss-120b')return value;
  return null;
}
function timingMillis(value){
  return Number.isFinite(value)?Math.max(0,Math.min(300000,Math.round(value))):null;
}
function timingEntry(value){
  const durationMs=timingMillis(value?.durationMs), at=value?.at;
  return durationMs!==null&&Number.isSafeInteger(at)&&at>0&&at<8.64e15?{durationMs,at}:null;
}
function successfulTiming(value){
  const entry=timingEntry(value);
  if(!entry)return null;
  const provider=publicProvider(value.provider);
  return {...entry,provider,model:publicModel(provider,value.model),serverMs:timingMillis(value.serverMs),
    multipleAttempts:typeof value.multipleAttempts==='boolean'?value.multipleAttempts:null};
}
function currentSparkTiming(){
  if(sparkTiming)return sparkTiming;
  let saved;
  try{ saved=JSON.parse(localStorage.getItem(SPARK_TIMING_KEY)||'null'); }catch{}
  sparkTiming={
    success:successfulTiming(saved?.success),failure:timingEntry(saved?.failure),
    result:Object.hasOwn(SPARK_RESULTS,saved?.result)?saved.result:null
  };
  return sparkTiming;
}
function sparkFailureKind(error){
  if(isDailyQuota(error))return 'daily_quota';
  if(isMinuteQuota(error))return 'minute_quota';
  if(error?.status===401&&!error.kind)return 'connection';
  if(!navigator.onLine||error?.name==='TypeError'||/Failed to fetch|NetworkError/i.test(error?.message||''))return 'network';
  return error?.name==='TimeoutError'?'timeout':'unavailable';
}
function recordSparkTiming(started,result,response){
  const timing=currentSparkTiming();
  const entry={durationMs:timingMillis(performance.now()-started),at:Date.now()};
  timing.result=result;
  if(result==='normal'){
    timing.success=successfulTiming({...entry,provider:response.provider,model:response.model,
      serverMs:response.timing?.serverMs,multipleAttempts:response.timing?.multipleAttempts});
  }else timing.failure=entry;
  try{ localStorage.setItem(SPARK_TIMING_KEY,JSON.stringify(timing)); }catch{}
}
function durationLabel(ms){
  return new Intl.NumberFormat('nb-NO',{maximumFractionDigits:1}).format(ms/1000)+' s';
}
function responseSpeed(ms){
  if(ms<5000)return 'Raskt';
  if(ms<20000)return 'Normalt';
  if(ms<60000)return 'Sakte';
  return 'Svært sakte';
}

function checkSparkStorage(){
  let readable=false,writable=false,unfinished=null;
  try{
    localStorage.getItem(LS.kids);
    readable=true;
    unfinished=kids.some((_,i)=>{
      const raw=localStorage.getItem(sessionKey(i));
      try{ return isUnfinishedSession(JSON.parse(raw||'null'),i); }catch{return false;}
    });
  }catch{readable=false;}
  try{
    localStorage.setItem(SPARK_PROBE_KEY,'test');
    writable=localStorage.getItem(SPARK_PROBE_KEY)==='test';
  }catch{}
  finally{
    try{localStorage.removeItem(SPARK_PROBE_KEY);}catch{writable=false;}
  }
  return {readable,writable,unfinished};
}
function sparkStatusHTML(){
  return `<details id="sparkStatus">
    <summary>Spark-status</summary>
    <div id="sparkUpdateReady" class="note info hide">En ny Spark-versjon er klar. Lukk alle Spark-faner og åpne Spark igjen når dere er ferdige.</div>
    <div class="spark-status-actions">
      <button type="button" class="btn sm ghost" id="refreshSparkStatus">Sjekk på nytt</button>
      <button type="button" class="btn sm ghost" id="copySparkStatus">Kopier status</button>
    </div>
    <p id="sparkCopyResult" class="t2 hide" role="status"></p>
    <textarea id="sparkCopyText" class="hide" aria-label="Spark-status for manuell kopiering" readonly rows="5"></textarea>
    <div id="sparkStatusRows"></div>
  </details>`;
}
function sparkStatusRows(check,isoDates=false){
  const online=navigator.onLine;
  const controller=navigator.serviceWorker?.controller;
  const controlled=!!controller&&new URL(controller.scriptURL).href===new URL('sw.js',location.href).href;
  const storage=check?.storage;
  const timing=currentSparkTiming(), last=timing.success;
  const yesNo=value=>value===null||value===undefined?'Ukjent':value?'Ja':'Nei';
  const available=value=>value?'Tilgjengelig':'Ikke tilgjengelig';
  const date=ms=>{
    if(!ms)return '–';
    const time=new Date(ms);
    return isoDates?time.toISOString():time.toLocaleString('nb-NO');
  };
  const file=document.createElement('input'); file.type='file';
  const speechOutput=synth&&window.SpeechSynthesisUtterance?
    (pickVoice()?'Norsk stemme tilgjengelig':'Ingen norsk stemme tilgjengelig'):'Ikke tilgjengelig';
  return [
    ['App',[
      ['Versjon',document.querySelector('meta[name="spark-release"]').content],
      ['Spark styrer denne fanen',yesNo(controlled)],
      ['Oppdatering',sparkRegistration?.waiting?'Klar':'Ingen klar']
    ]],
    ['Tjeneste',[
      ['Nett',online?'På nett':'Frakoblet'],
      ['Spark-tjenesten',check?.service||'Ikke sjekket'],
      ['Tjenesteversjon',check?.generation||'–'],
      ['Reservetjeneste',{none:'Ingen',openrouter:'OpenRouter',groq:'Groq'}[check?.backup]||'Ukjent']
    ]],
    ['Siste AI-forespørsler',[
      ['AI-rute',last?.provider?[{gemini:'Gemini',openrouter:'OpenRouter',groq:'Groq'}[last.provider],last.model].filter(Boolean).join(' · '):'–'],
      ['Siste svar',last?durationLabel(last.durationMs)+' · '+responseSpeed(last.durationMs):'–'],
      ['Siste vellykkede svar',date(last?.at)],
      ['Tid på tjenesten',last?.serverMs!=null?durationLabel(last.serverMs):'–'],
      ['Flere modellforsøk',yesNo(last?.multipleAttempts)],
      ['Siste resultat',SPARK_RESULTS[timing.result]||'Ingen forespørsel registrert'],
      ['Siste mislykkede forespørsel',timing.failure?durationLabel(timing.failure.durationMs)+' · '+date(timing.failure.at):'–']
    ]],
    ['Denne enheten',[
      ['Koblet til Spark',yesNo(paired())],
      ['Lagring',!storage?'Ikke sjekket':storage.readable&&storage.writable&&!storageReadFailed?'OK':'Trenger oppmerksomhet'],
      ['Kan lese / skrive',yesNo(storage?.readable)+' / '+yesNo(storage?.writable)],
      ['Uferdig lekse',yesNo(storage?.unfinished)],
      ['Bilde eller fil',available(file.type==='file'&&'files' in file)],
      ['Mikrofon for taleinnskriving',available(speechInputSupported())],
      ['Opplesing',speechOutput],
      ['Sjekket',date(check?.checkedAt)]
    ]]
  ];
}
function paintSparkStatus(){
  const panel=sparkStatusPanel;
  if(!panel?.element.isConnected||!panel.element.open)return;
  $('sparkStatusRows').innerHTML=sparkStatusRows(panel.snapshot).map(([title,rows])=>
    '<h3>'+title+'</h3><dl>'+rows.map(([label,value])=>'<dt>'+label+'</dt><dd>'+esc(value)+'</dd>').join('')+'</dl>'
  ).join('');
  $('sparkUpdateReady').classList.toggle('hide',!sparkRegistration?.waiting);
}
function watchSparkRegistration(registration){
  sparkRegistration=registration;
  function watchInstall(){
    registration.installing?.addEventListener('statechange',paintSparkStatus);
    paintSparkStatus();
  }
  registration.addEventListener('updatefound',watchInstall);
  watchInstall();
}
async function refreshSparkStatus(){
  const panel=sparkStatusPanel;
  if(!panel?.element.isConnected||!panel.element.open)return;
  panel.probe?.abort();
  const abort=new AbortController();
  panel.probe=abort;
  const snapshot={storage:checkSparkStorage(),checkedAt:Date.now(),
    service:navigator.onLine?'Sjekker…':'Kan ikke nås uten nett'};
  panel.snapshot=snapshot;
  paintSparkStatus();
  if(!navigator.onLine)return;
  sparkRegistration?.update().catch(()=>{});
  const timer=setTimeout(()=>abort.abort(),4500);
  try{
    const response=await fetch(endpoint('/health'),{cache:'no-store',credentials:'omit',redirect:'error',signal:abort.signal});
    const data=await response.json();
    if(!response.ok||data?.ok!==true||data.service!=='spark-api')throw Error('Invalid health reply');
    snapshot.service='Kan nås';
    snapshot.generation=typeof data.generation==='string'&&/^[a-z][a-z0-9-]{0,24}-\d{8}$/.test(data.generation)?data.generation:null;
    snapshot.backup=['none','openrouter','groq'].includes(data.backup)?data.backup:null;
  }catch{snapshot.service='Kan ikke nås';}
  finally{
    clearTimeout(timer);
    if(panel.snapshot===snapshot&&sparkStatusPanel===panel)paintSparkStatus();
  }
}
async function copySparkStatus(panel){
  const text=sparkStatusRows(panel.snapshot,true).flatMap(([,rows])=>rows.map(([label,value])=>label+': '+value)).join('\n');
  let copied=false;
  try{await navigator.clipboard.writeText(text);copied=true;}catch{}
  if(!panel.element.isConnected||!panel.element.open)return;
  const output=$('sparkCopyText'), message=$('sparkCopyResult');
  output.classList.toggle('hide',copied);
  message.classList.remove('hide');
  message.textContent=copied?'Status kopiert.':'Velg og kopier teksten nedenfor.';
  if(!copied){output.value=text;output.focus();output.select();}
}
function bindSparkStatus(){
  sparkStatusPanel?.probe?.abort();
  const panel={element:$('sparkStatus')};
  sparkStatusPanel=panel;
  panel.element.addEventListener('toggle',()=>{
    if(panel.element.open)refreshSparkStatus();
    else panel.probe?.abort();
  });
  $('refreshSparkStatus').onclick=refreshSparkStatus;
  $('copySparkStatus').onclick=()=>copySparkStatus(panel);
}
navigator.serviceWorker?.addEventListener('controllerchange',paintSparkStatus);
window.addEventListener('online',refreshSparkStatus);
window.addEventListener('offline',refreshSparkStatus);
window.addEventListener('storage',event=>{
  if(event.storageArea===localStorage&&(event.key===SPARK_TIMING_KEY||event.key===null)){
    sparkTiming=null;
    paintSparkStatus();
  }
});
