/* SYNC1 browser glue (candidate, default OFF). The existing app owns kids, storage, pairing and navigation; this file
   connects them to SparkSync. Nothing here runs unless a parent turned sync on (or the `spark_sync_lab` opt-in is set),
   the phone is paired with the Worker this build ships with, and that Worker has sync configured.
   Sync never blocks homework: it runs only outside an open chat, in the background, and every failure is a status line. */
// If sync.js failed to load, sync stays off and the app works as before (see the fallbacks in spark.html).
const SY=globalThis.SparkSync,SYNC_STATE='spark_sync';
let syncEngine=null,syncTimer=null,syncDevicesView='';
function syncVisible(){return !!SY&&(store.getItem('spark_sync_lab')==='1'||!!store.getItem(SYNC_STATE));}
// Same trust root as TR1: only the Worker built into the app, never the ⚙️ address, and only with a token from it.
function syncReachable(){return paired()&&serverUrl===DEFAULT_SERVER_URL;}
async function syncRequest(path,body){
  if(!syncReachable())throw Error('not paired with the build Worker');
  const r=await fetchServer(path,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+deviceToken},body:JSON.stringify(body)},DEFAULT_SERVER_URL);
  return {status:r.status,data:await r.json().catch(()=>null)};
}
function syncEngineGet(){
  return syncEngine ||= SY.createEngine({
    subtle:crypto.subtle,random:n=>crypto.getRandomValues(new Uint8Array(n)),now:()=>Date.now(),request:syncRequest,
    loadState:()=>store.getItem(SYNC_STATE),saveState:text=>store.setItem(SYNC_STATE,text),
    kids:()=>kids,saveKids,addKid:syncAddKid,removeKid:syncRemoveKid,newKid:()=>blankKid('')
  });
}
const syncOn=()=>!!SY&&!!store.getItem(SYNC_STATE)&&syncEngineGet().state().enabled;
// Load-time check of every child's sync data. Malformed data never deletes anything: the child stays as a local copy.
function syncInitKids(){
  // sync.js missing: same as the fallback in spark.html (local copies, download restarts later).
  if(!SY){let n=0;for(const k of kids)if(k.sync){delete k.sync;delete k.id;k.fork=true;n++;}if(n){try{const s=JSON.parse(localStorage.getItem('spark_sync')||'null');if(s){s.cursor=0;localStorage.setItem('spark_sync',JSON.stringify(s));}}catch{}}return;}
  for(const k of kids){
    if(!SY)break;
    if(!k.sync)continue;
    const s=SY.ID.test(k.id||'')?SY.normalizeSync(k.sync):null;
    if(s)k.sync=s;else{delete k.sync;delete k.id;k.fork=true;}
  }
}
// Live changes of a shared child join its queue; the caller's saveKids persists both together.
function syncRecord(k,payload){if(k?.sync)syncEngineGet().enqueue(k,payload);}
function syncProfile(k){if(k?.sync)syncEngineGet().profileChanged(k);}
// A family child arriving on a phone whose only profile is the empty starter profile replaces it.
function syncAddKid(k){
  if(kids.length===1&&SY.blank(kids[0])&&!store.getItem(sessionKey(0))){kids[0]=k;active=0;return;}
  kids.push(k);
}
// Removes a child from this phone. Unfinished-session keys are indexed by position, so later ones move down by one.
function syncRemoveKid(k){
  const i=kids.indexOf(k);if(i<0)return;
  if(i===active){stopSpeak();stopMic();chatMsgs=[];history=[];transcript='';pendingFinal=null;readOnly=false;currentSessionId='';resetLearning();if(view==='chat'||view==='hist')view='start';}
  store.removeItem(sessionKey(i));
  for(let j=i+1;j<kids.length;j++){
    const raw=store.getItem(sessionKey(j));if(!raw)continue;
    try{const s=JSON.parse(raw);s.kid=j-1;store.setItem(sessionKey(j-1),JSON.stringify(s));}catch{}
    store.removeItem(sessionKey(j));
  }
  // The pre-C3 recovery copy is indexed the same way.
  try{const raw=store.getItem('spark_learning_backup');if(raw){const b=JSON.parse(raw),old=JSON.parse(b.kids||'[]');if(Array.isArray(old)){old.splice(i,1);b.kids=JSON.stringify(old);}b.sessions=(b.sessions||[]).filter(([n])=>n!==i).map(([n,s])=>[n>i?n-1:n,s]);store.setItem('spark_learning_backup',JSON.stringify(b));}}catch{}
  kids.splice(i,1);
  if(!kids.length)kids.push(blankKid(''));
  if(active>i)active--;if(active>=kids.length)active=kids.length-1;
}
function syncSoon(delay=800){
  if(!syncOn())return;
  clearTimeout(syncTimer);syncTimer=setTimeout(syncRun,delay);
}
async function syncRun(){
  if(!syncOn())return;
  // Never during homework or a provider call, and never under the open settings form (a background change there could be
  // written back as a stale edit by «Lagre»). Buttons on the settings page sync explicitly and re-render the form.
  if(busy||view==='chat'||view==='setup'){syncSoon(30000);return;}
  const before=JSON.stringify(kids.map(k=>[k.id,k.name]));
  await syncEngineGet().sync().catch(()=>null);
  const changed=JSON.stringify(kids.map(k=>[k.id,k.name]))!==before;
  // A round can finish after the parent opened settings: a form showing old values is re-drawn, never saved stale.
  if((view==='start'||view==='setup')&&!busy&&changed)render();
  else if(view==='setup')syncShowStatus();
}
const SYNC_STATUS={
  ok:'Synkronisert',offline:'Ingen forbindelse. Endringene ligger trygt på telefonen og sendes senere.',unavailable:'Synkroniseringen er utilgjengelig akkurat nå. Prøver igjen senere.',
  rate:'Mange forespørsler. Prøver igjen om litt.',auth:'Denne telefonen må kobles til Spark på nytt.',revoked:'Denne telefonen er fjernet fra familiens synkronisering. Dataene på telefonen er beholdt.',
  rejoin:'Synkroniseringen er startet på nytt. Skriv inn den nye nøkkelen.',storage:'Telefonen har ikke plass til å lagre. Frigjør plass.',quota:'Familiens synkroniseringsplass er full.',key:'Synkroniseringsnøkkelen på denne telefonen er ugyldig.',off:'Av'
};
function syncStatusText(){
  const s=syncEngineGet().state();
  if(!syncReachable())return 'Denne telefonen er ikke koblet til Spark-serveren. Synkronisering er av.';
  const base=SYNC_STATUS[s.status]||'Ikke synkronisert ennå.';
  return base+(s.status==='ok'&&s.lastSync?' '+new Date(s.lastSync).toLocaleString('nb-NO'):'')+(s.undecryptable?' · '+s.undecryptable+' oppføringer kunne ikke leses og ble hoppet over.':'');
}
function syncShowStatus(){const el=$('syncStatus');if(el)el.textContent=syncStatusText();}
function syncNoteHTML(){
  return syncOn()
    ?'<div class="note info"><strong>📱 Flere telefoner:</strong> barn som er delt med familien, synkroniseres kryptert mellom telefonene. Samtaler, bilder, notater og undervisningslogg blir på hver telefon.</div>'
    :'<div class="note info"><strong>📱 Flere telefoner:</strong> den samme Spark-serveren kan brukes av Olav, lillebror og en tredje telefon. Hver telefon pares én gang. Profiler og økthistorikk er foreløpig lokale på hver telefon og synkroniseres ikke mellom enheter.</div>';
}
function syncHTML(){
  if(!syncVisible())return '';
  const intro='<p>Spark sender bare kryptert læringsfremgang: ferdigheter, ord og korte øktoppsummeringer. Samtaler, bilder, notater og undervisningslogg blir på telefonen. Nøkkelen finnes bare på familiens telefoner, så serveren kan ikke lese innholdet.</p>';
  if(!syncOn())return `<section class="prof" id="syncSection"><h2>Synkronisering mellom telefoner (prøveversjon)</h2>${intro}
    <label for="syncCode">Familiekode (bare for å starte)</label><input type="password" id="syncCode" autocomplete="one-time-code">
    <button class="qb" id="syncCreate">Start synkronisering på denne telefonen</button>
    <label for="syncKeyIn">Synkroniseringsnøkkel fra en annen telefon</label><input type="text" id="syncKeyIn" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX">
    <button class="qb" id="syncJoin">Bli med</button><p id="syncStatus" class="t2" role="status">${esc(syncReachable()?'Av':syncStatusText())}</p></section>`;
  const s=syncEngineGet().state(),k=kid();
  const child=k.sync
    ?`<p>${esc(k.name||'Barnet')} er delt med familien.</p><button class="qb" id="syncHide">Fjern fra denne telefonen</button><button class="qb" id="syncDeleteChild">Slett fra hele familien</button>`
    :`<p>${esc(k.name||'Barnet')} finnes bare på denne telefonen.${k.fork?' Dette er en lokal kopi fra før synkroniseringen ble endret.':''}</p><button class="qb" id="syncShare">Del dette barnet med familien</button>`;
  return `<section class="prof" id="syncSection"><h2>Synkronisering mellom telefoner (prøveversjon)</h2>${intro}
    <p id="syncStatus" class="t2" role="status">${esc(syncStatusText())}</p><button class="qb" id="syncNow">Synkroniser nå</button>
    <details><summary>Vis synkroniseringsnøkkel</summary><p><code id="syncKeyOut">${esc(s.key)}</code></p><p class="t2">Skriv den inn på neste telefon. Ta vare på den: uten nøkkelen kan ingen lese de synkroniserte dataene, heller ikke Spark.</p></details>
    ${child}
    <label for="syncAdminCode">Familiekode (for å slette, fjerne enheter eller starte på nytt)</label><input type="password" id="syncAdminCode" autocomplete="one-time-code">
    <button class="qb" id="syncDevices">Vis enheter</button><div id="syncDeviceList">${syncDevicesView}</div>
    ${s.hidden.length?'<button class="qb" id="syncUnhide">Hent fjernede barn tilbake hit</button>':''}
    <button class="qb" id="syncReset">Start på nytt med ny nøkkel</button></section>`;
}
const SYNC_ERRORS={sync_first:'Synkroniser først (telefonen må være på nett), så ingen sletting går tapt.',family_code:'Feil familiekode.',family_exists:'Synkronisering er allerede startet. Bruk nøkkelen fra en annen telefon.',no_family:'Synkronisering er ikke startet ennå. Start den på én telefon først.',key:'Feil synkroniseringsnøkkel.',key_format:'Nøkkelen er skrevet feil. Sjekk alle tegnene.',revoked:'Denne telefonen er fjernet fra familiens synkronisering.',storage:'Telefonen har ikke plass til å lagre.',pending:'Synkroniser først, så ingen endringer går tapt.',device_unknown:'Ukjent enhet.',child_unknown:'Barnet finnes ikke i familiens synkronisering.'};
const syncError=r=>SYNC_ERRORS[r?.code]||r?.error||'Det gikk ikke. Prøv igjen senere.';
async function syncGuard(button,fn){if(busy)return;busy=true;button.disabled=true;try{await fn();}catch{alert('Det gikk ikke. Sjekk forbindelsen og prøv igjen.');}finally{busy=false;render();}}
function bindSync(){
  if(!$('syncSection'))return;
  const e=syncEngineGet();
  if($('syncCreate'))$('syncCreate').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(!syncReachable()){alert('Koble denne telefonen til Spark-serveren først.');return;}
    const r=await e.create({code:$('syncCode').value});if(!r.ok){alert(syncError(r));return;}
    store.setItem('spark_sync_lab','1');
    if(confirm('Dele barna på denne telefonen med familien nå? (Avbryt: de blir bare her, og du kan dele dem senere.)')){e.shareAll();saveKids();}
    alert('Synkroniseringsnøkkel:\n'+r.key+'\n\nSkriv den inn på de andre telefonene, og ta vare på den.');
    await e.sync();
  });
  if($('syncJoin'))$('syncJoin').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(!syncReachable()){alert('Koble denne telefonen til Spark-serveren først.');return;}
    const r=await e.join({key:$('syncKeyIn').value});if(!r.ok){alert(syncError(r));return;}
    store.setItem('spark_sync_lab','1');
    await e.sync();
    const local=kids.filter(k=>!k.sync&&!k.fork&&!SY.blank(k));
    if(local.length&&confirm('Denne telefonen har '+local.length+' barn som ikke er delt. Dele dem med familien som egne barn? (Avbryt: de blir bare her.)')){e.shareAll();saveKids();await e.sync();}
  });
  if($('syncNow'))$('syncNow').onclick=ev=>syncGuard(ev.currentTarget,()=>e.sync());
  if($('syncShare'))$('syncShare').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(kid().fork&&!confirm('Dette er en lokal kopi fra før synkroniseringen ble endret. Hvis barnet er slettet fra familien, deles det nå på nytt. Dele likevel?'))return;
    if(!e.share(kid())){alert('Et tomt barn uten navn deles ikke.');return;}if(!saveKids()){alert(SYNC_ERRORS.storage);return;}await e.sync();});
  if($('syncHide'))$('syncHide').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    const k=kid();if(!confirm('Fjerne '+(k.name||'barnet')+' fra denne telefonen? Barnet beholdes på de andre telefonene. Samtaler som bare finnes her, slettes.'))return;
    // The confirmed child, not whatever is active after the round (a round can add or remove children).
    await e.sync();if(!kids.includes(k)||!k.sync)return;const r=e.hide(k);if(!r.ok)alert(syncError(r));
  });
  if($('syncUnhide'))$('syncUnhide').onclick=ev=>syncGuard(ev.currentTarget,async()=>{e.unhide();await e.sync();});
  if($('syncDeleteChild'))$('syncDeleteChild').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(!confirm('Slette '+(kid().name||'barnet')+' fra ALLE telefonene i familien? Dette kan ikke angres.'))return;
    const r=await e.deleteChild({code:$('syncAdminCode').value,kid:kid()});if(!r.ok)alert(syncError(r));
  });
  if($('syncDevices'))$('syncDevices').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    const r=await e.devices();if(!r.ok){alert(syncError(r));return;}
    syncDevicesView=r.devices.map(x=>`<p>${x.self?'Denne telefonen':'Enhet '+esc(x.device.slice(0,4))} · lagt til ${esc(new Date(x.enrolledAt).toLocaleDateString('nb-NO'))} · sist sett ${esc(new Date(x.seenDay).toLocaleDateString('nb-NO'))}${x.status==='revoked'?` · fjernet <button class="qb" data-reauth="${esc(x.device)}">Gi tilgang igjen</button>`:(x.status==='inactive'?' · må skrive inn den nye nøkkelen':'')+(x.self?'':` <button class="qb" data-revoke="${esc(x.device)}">Fjern enheten</button>`)}</p>`).join('');
  });
  main.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(!confirm('Fjerne denne enheten fra synkroniseringen? Den kan ikke bli med igjen uten å kobles til på nytt med familiekoden.'))return;
    const r=await e.revoke({code:$('syncAdminCode').value,device:b.dataset.revoke});if(!r.ok){alert(syncError(r));return;}syncDevicesView='';
  }));
  main.querySelectorAll('[data-reauth]').forEach(b=>b.onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(!confirm('Gi denne enheten tilgang igjen? Den må fortsatt ha synkroniseringsnøkkelen for å bli med.'))return;
    const r=await e.reauthorize({code:$('syncAdminCode').value,device:b.dataset.reauth});if(!r.ok){alert(syncError(r));return;}syncDevicesView='';
  }));
  if($('syncReset'))$('syncReset').onclick=ev=>syncGuard(ev.currentTarget,async()=>{
    if(!confirm('Starte synkroniseringen på nytt med en ny nøkkel? Alt familien har lagret på serveren slettes. Data på telefonene beholdes, og de andre telefonene må bli med igjen med den nye nøkkelen.'))return;
    const r=await e.reset({code:$('syncAdminCode').value});if(!r.ok){alert(syncError(r));return;}
    alert('Ny synkroniseringsnøkkel:\n'+r.key);await e.sync();
  });
}
// «Slett all historikk» for a shared child is family-wide: the child is deleted from the family and shared again,
// empty, under a new identity. Old offline phones cannot bring the old history back (the old id is a tombstone).
async function syncResetChildLearning(){
  const k=kid(),code=$('syncAdminCode')?.value||'';
  if(!code){alert('Barnet er delt med familien. Skriv familiekoden under «Synkronisering mellom telefoner» for å slette historikken på alle telefonene.');return;}
  if(!confirm('Slette økter, notater, ord og læringshistorikk for '+(k.name||'barnet')+' på ALLE telefonene i familien?'))return;
  if(busy)return;busy=true;
  try{
    const e=syncEngineGet(),profile={name:k.name,age:k.age,interests:k.interests,readAloud:!!k.readAloud};
    const r=await e.deleteChild({code,kid:k});if(!r.ok){alert(syncError(r));return;}
    const fresh={...blankKid(profile.name),...profile};
    // Removing the only child left an empty starter profile: the fresh child takes its place.
    if(kids.length===1&&SY.blank(kids[0])&&!store.getItem(sessionKey(0)))kids[0]=fresh;else kids.push(fresh);active=kids.indexOf(fresh);
    if(!e.share(fresh))alert('Historikken er slettet på alle telefonene. Barnet uten navn blir bare på denne telefonen; del det igjen når det har fått navn.');
    saveKids();await e.sync();
  }catch{alert('Det gikk ikke. Sjekk forbindelsen og prøv igjen.');}
  finally{busy=false;render();}
}
