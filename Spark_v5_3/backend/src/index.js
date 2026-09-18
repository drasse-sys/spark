const GEMINI_CHAIN = [
  'gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash',
  'gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash'
];
const RETIRED = /no longer available|not found|NOT_FOUND|is not supported|does not exist/i;
const DAILY = /per day|daily limit|requests per day|\bRPD\b|GenerateRequestsPerDay/i;
const MINUTE = /per minute|requests per minute|tokens per minute|\bRPM\b|\bTPM\b|rate limit/i;
const enc = new TextEncoder();

function json(data, status=200, extra={}){
  return new Response(JSON.stringify(data), {
    status,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}
  });
}
function allowedOrigins(env){
  return String(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
}
function cors(origin, env){
  const allowed=allowedOrigins(env);
  const ok=allowed.includes('*') || (!!origin && allowed.includes(origin));
  return {
    ok,
    headers: ok ? {
      'access-control-allow-origin': origin || '*',
      'vary':'Origin',
      'access-control-allow-headers':'content-type, authorization',
      'access-control-allow-methods':'GET, POST, OPTIONS'
    } : {}
  };
}
function b64url(bytes){
  let s=''; for(const b of new Uint8Array(bytes)) s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64url(s){
  s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='=';
  const bin=atob(s), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function hmac(secret, text){
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return crypto.subtle.sign('HMAC',key,enc.encode(text));
}
async function makeToken(env, deviceId){
  const payload=b64url(enc.encode(JSON.stringify({v:1,deviceId,exp:Date.now()+365*24*3600*1000})));
  const sig=b64url(await hmac(env.DEVICE_SIGNING_SECRET,payload));
  return payload+'.'+sig;
}
async function verifyToken(env, token){
  try{
    const [payload,sig]=String(token||'').split('.'); if(!payload||!sig) return null;
    const expected=b64url(await hmac(env.DEVICE_SIGNING_SECRET,payload));
    if(expected.length!==sig.length) return null;
    let diff=0; for(let i=0;i<sig.length;i++) diff|=expected.charCodeAt(i)^sig.charCodeAt(i);
    if(diff) return null;
    const data=JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if(!data.deviceId || !data.exp || Date.now()>data.exp) return null;
    return data;
  }catch{return null;}
}
function sameCode(a,b){
  a=String(a||''); b=String(b||''); if(a.length!==b.length) return false;
  let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0;
}
function errorInfo(e){
  const text=((e&&e.message)||'')+' '+((e&&e.details)||'');
  return {daily:DAILY.test(text), minute:MINUTE.test(text)||(/RESOURCE_EXHAUSTED|429/i.test(text)&&!DAILY.test(text))};
}
function hasImage(messages){
  return (messages||[]).some(m=>Array.isArray(m.content)&&m.content.some(b=>b&&b.type==='image'));
}
function validatePayload(body){
  if(!body || typeof body!=='object') return 'Ugyldig forespørsel.';
  if(typeof body.system!=='string' || body.system.length<20 || body.system.length>30000) return 'Ugyldig systemtekst.';
  if(!Array.isArray(body.messages) || body.messages.length<1 || body.messages.length>16) return 'Ugyldig samtale.';
  let imageChars=0, textChars=body.system.length;
  for(const m of body.messages){
    if(!m || !['user','assistant'].includes(m.role)) return 'Ugyldig rolle.';
    if(typeof m.content==='string') textChars+=m.content.length;
    else if(Array.isArray(m.content)){
      for(const part of m.content){
        if(part?.type==='text') textChars+=String(part.text||'').length;
        else if(part?.type==='image') imageChars+=String(part.source?.data||'').length;
        else return 'Ugyldig meldingsdel.';
      }
    } else return 'Ugyldig meldingsinnhold.';
  }
  if(textChars>90000) return 'Samtalen er for stor.';
  if(imageChars>3500000) return 'Bildet er for stort.';
  if(typeof body.transcript!=='string' || body.transcript.length>20000) return 'Ugyldig avskrift.';
  return '';
}
function toGemini(messages){
  return messages.map(m=>({
    role:m.role==='assistant'?'model':'user',
    parts:typeof m.content==='string' ? [{text:m.content}] : m.content.map(b=>{
      if(b.type==='text') return {text:String(b.text||'')};
      if(b.type==='image') return {inline_data:{mime_type:b.source?.media_type||'image/jpeg',data:b.source?.data||''}};
      return null;
    }).filter(Boolean)
  }));
}
async function geminiOnce(env, system, messages, model){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent';
  const r=await fetch(url,{
    method:'POST',
    headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
    body:JSON.stringify({
      system_instruction:{parts:[{text:system}]},
      contents:toGemini(messages),
      generationConfig:{maxOutputTokens:900,temperature:0.8,thinkingConfig:{thinkingLevel:'low'}}
    })
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.error){
    const e=new Error(d.error?.message||('Gemini-feil ('+r.status+')'));
    e.status=r.status; e.details=JSON.stringify(d.error?.details||''); throw e;
  }
  const text=(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('\n').trim();
  if(!text) throw new Error('Tomt svar fra Gemini.');
  return text;
}
async function callGemini(env, system, messages){
  let last;
  for(const model of GEMINI_CHAIN){
    try{return {text:await geminiOnce(env,system,messages,model),model};}
    catch(e){last=e; if(!RETIRED.test(e.message||'')) throw e;}
  }
  throw last||new Error('Ingen Gemini-modell svarte.');
}
function backupMessages(system,messages,transcript){
  const out=[{role:'system',content:system}];
  for(const m of messages){
    let text='';
    if(typeof m.content==='string') text=m.content;
    else{
      const hadImage=m.content.some(b=>b.type==='image');
      const visible=m.content.filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
      text=(hadImage&&transcript ? 'Oppgaven:\n'+transcript+'\n\n' : '')+visible;
    }
    out.push({role:m.role==='assistant'?'assistant':'user',content:text});
  }
  return out;
}
async function callBackup(env, system, messages, transcript){
  const provider=String(env.BACKUP_PROVIDER||'none').toLowerCase();
  let url,key,model;
  if(provider==='openrouter'){
    url='https://openrouter.ai/api/v1/chat/completions'; key=env.OPENROUTER_API_KEY;
    model=env.OPENROUTER_MODEL||'openrouter/free';
  }else if(provider==='groq'){
    url='https://api.groq.com/openai/v1/chat/completions'; key=env.GROQ_API_KEY;
    model=env.GROQ_MODEL||'openai/gpt-oss-120b';
  }else return null;
  if(!key) return null;
  if(hasImage(messages)&&!transcript) throw new Error('Dagskvoten er tom før bildet rakk å bli skrevet av. Skriv oppgaven som tekst, så kan reserven fortsette.');
  const r=await fetch(url,{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+key},
    body:JSON.stringify({model,max_tokens:700,messages:backupMessages(system,messages,transcript)})
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.error){const e=new Error(d.error?.message||('Reserve-feil ('+r.status+')')); e.status=r.status; throw e;}
  const text=d.choices?.[0]?.message?.content?.trim(); if(!text) throw new Error('Tomt svar fra reserven.');
  return {text,provider,model};
}

export default {
  async fetch(request, env){
    const origin=request.headers.get('origin')||'';
    const c=cors(origin,env);
    if(request.method==='OPTIONS') return new Response(null,{status:c.ok?204:403,headers:c.headers});
    if(!c.ok) return json({error:'Denne nettsiden har ikke tilgang til Spark-serveren.'},403,c.headers);
    const url=new URL(request.url);

    if(url.pathname==='/health' && request.method==='GET'){
      return json({ok:true,service:'spark-api',backup:String(env.BACKUP_PROVIDER||'none')},200,c.headers);
    }

    if(url.pathname==='/pair' && request.method==='POST'){
      const ip=request.headers.get('cf-connecting-ip')||'unknown';
      if(env.PAIR_LIMITER){ const {success}=await env.PAIR_LIMITER.limit({key:ip}); if(!success) return json({error:'For mange koblingsforsøk. Prøv igjen om litt.'},429,c.headers); }
      const body=await request.json().catch(()=>null);
      if(!body || !sameCode(body.code,env.FAMILY_CODE)) return json({error:'Feil familiekode.'},401,c.headers);
      const deviceId=crypto.randomUUID();
      return json({token:await makeToken(env,deviceId),expiresInDays:365},200,c.headers);
    }

    if(url.pathname==='/chat' && request.method==='POST'){
      const auth=request.headers.get('authorization')||'';
      const token=auth.replace(/^Bearer\s+/i,'');
      const device=await verifyToken(env,token);
      if(!device) return json({error:'Enheten må kobles til på nytt.'},401,c.headers);
      if(env.CHAT_LIMITER){ const {success}=await env.CHAT_LIMITER.limit({key:device.deviceId}); if(!success) return json({error:'For mange forespørsler på kort tid. Vent litt og prøv igjen.',kind:'minute_quota'},429,c.headers); }
      const len=Number(request.headers.get('content-length')||0);
      if(len>5000000) return json({error:'Forespørselen er for stor.'},413,c.headers);
      const body=await request.json().catch(()=>null);
      const problem=validatePayload(body); if(problem) return json({error:problem},400,c.headers);
      try{
        try{
          const g=await callGemini(env,body.system,body.messages);
          return json({text:g.text,provider:'gemini',model:g.model},200,c.headers);
        }catch(e){
          const q=errorInfo(e);
          if(q.daily){
            const b=await callBackup(env,body.system,body.messages,body.transcript||'');
            if(b) return json(b,200,c.headers);
          }
          const kind=q.minute?'minute_quota':(q.daily?'daily_quota':'provider_error');
          return json({error:e.message||'AI-feil',kind,details:e.details||''},e.status||502,c.headers);
        }
      }catch(e){
        return json({error:e.message||'Reserve-feil',kind:'provider_error'},e.status||502,c.headers);
      }
    }

    return json({error:'Ikke funnet.'},404,c.headers);
  }
};
