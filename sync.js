/* SYNC1 multi-device sync, candidate V1 (default OFF). Pure merge core, record codec and an engine whose network,
   storage, clock, randomness and Web Crypto are injected. No DOM access and no hidden clock or network reads.

   Model (docs/2026-11-04-SPARK-SYNC1-Privacy-First-Multi-Device-Sync.md):
   - Every synced change is an immutable record with a random 128-bit id. The Worker stores records as AES-256-GCM
     ciphertext under a family sync key that never leaves the family's phones, and assigns each a per-family sequence
     number, its own receive time `at` and a clock flag `ck` (the phone's clock agreed with the Worker's at upload).
   - A child's learning state is a deterministic left fold: the child's base snapshot, then its other records in
     (orderKey, id) order. `orderKey` is a time computed only from record data and Worker metadata, so every phone
     holding the same records computes the same state, whatever order they arrived in.
   - Evidence is append-only. Delay credit is recomputed in the merged order AND capped by what the recording phone
     itself granted, so a merge can remove credit but never add it. */
(function(root){
  'use strict';
  const L=root.SparkLearning,DAY=L.DAY,SKEW=L.CLOCK_SKEW;
  const PROTOCOL='SPARK-SYNC-V1';
  // Records received more than WINDOW after their claimed time are ordered at (receive time - WINDOW).
  // That bound makes every record whose orderKey is older than (Worker time - WINDOW) final, so phones may fold them.
  const WINDOW=14*DAY;
  const ID=/^[A-Za-z0-9_-]{21}[AQgw]$/;      // 16 random bytes, canonical unpadded base64url
  const IV=/^[A-Za-z0-9_-]{16}$/;             // 12 bytes
  const B64=/^[A-Za-z0-9_-]+$/;
  const LIMITS=Object.freeze({opCt:32768,baseCt:262144,pushRecords:40,pushBytes:500000,pullPages:40,seen:30000,ids:200,pending:5000});
  const HELPED=['Tallinje','Dele opp','Tegne','Hint','Prøve igjen'];
  const ERRORS=['slurv','fakta','metode','begrep','tolking'],CONFIDENCE=['sikker','usikker','gjetter'];
  const enc=new TextEncoder(),dec=new TextDecoder();
  const exactKeys=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys.slice().sort().join();
  const time=t=>Number.isSafeInteger(t)&&t>0;
  const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));

  /* ---------- encoding ---------- */
  function b64url(bytes){let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function unb64url(s){s=String(s).replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const bin=atob(s),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}
  // Family sync key text: 128 random bits in Crockford base32 (26 characters, last 2 bits zero) plus a 10-bit SHA-256
  // checksum (2 characters) that catches typing errors locally. Shown as 7 groups of 4.
  const B32='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function base32(bytes,bits){let out='',acc=0,n=0;for(const b of bytes){acc=acc<<8|b;n+=8;while(n>=5){out+=B32[acc>>(n-5)&31];n-=5;}}if(n)out+=B32[acc<<(5-n)&31];return out.slice(0,Math.ceil(bits/5));}
  async function keyText(subtle,raw){
    const sum=new Uint8Array(await subtle.digest('SHA-256',raw)),text=base32(raw,128)+base32(sum,10);
    return text.match(/.{4}/g).join('-');
  }
  async function parseKey(subtle,text){
    const s=String(text||'').toUpperCase().replace(/[\s-]/g,'').replace(/[IL]/g,'1').replace(/O/g,'0');
    if(!/^[0-9A-HJKMNP-TV-Z]{28}$/.test(s))return null;
    let acc=0n;for(const ch of s.slice(0,26))acc=acc<<5n|BigInt(B32.indexOf(ch));
    if(acc&3n)return null;acc>>=2n;
    const raw=new Uint8Array(16);for(let i=15;i>=0;i--){raw[i]=Number(acc&255n);acc>>=8n;}
    return await keyText(subtle,raw)===s.match(/.{4}/g).join('-')?raw:null;
  }
  // HKDF-SHA-256 from the 128-bit family key: an AES-256-GCM key (encryption) and a 256-bit membership proof whose
  // SHA-256 the Worker stores. The proof is one-way from the key: knowing it reveals nothing about the encryption key.
  async function deriveKeys(subtle,raw){
    const base=await subtle.importKey('raw',raw,'HKDF',false,['deriveKey','deriveBits']),salt=enc.encode(PROTOCOL);
    const encKey=await subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:enc.encode('enc')},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const proof=b64url(await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:enc.encode('member')},base,256));
    return {encKey,proof};
  }
  // Associated data binds a ciphertext to its family generation, child, Worker-visible kind and record id:
  // the Worker cannot move a payload to another child, kind or id, or replay it into a reset family.
  const aad=(gen,child,kind,id)=>enc.encode([PROTOCOL,gen,child,kind,id].join('\n'));
  async function seal(subtle,random,key,gen,rec,payload){
    // Padded with spaces to a multiple of 256 UTF-8 bytes (what is encrypted), so lengths reveal only the bucket.
    const body=enc.encode(JSON.stringify(payload)),text=new Uint8Array(Math.max(1,Math.ceil(body.length/256))*256).fill(32);text.set(body);
    const iv=random(12),ct=await subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(gen,rec.child,rec.kind,rec.id)},key,text);
    return {id:rec.id,child:rec.child,kind:rec.kind,iv:b64url(iv),ct:b64url(ct)};
  }
  async function open(subtle,key,gen,rec){
    try{
      if(!ID.test(rec.id)||!ID.test(rec.child)||!IV.test(rec.iv)||!B64.test(rec.ct))return null;
      const pt=await subtle.decrypt({name:'AES-GCM',iv:unb64url(rec.iv),additionalData:aad(gen,rec.child,rec.kind,rec.id)},key,unb64url(rec.ct));
      return checkPayload(rec.kind,JSON.parse(dec.decode(pt)),rec.child);
    }catch{return null;}
  }

  /* ---------- payload schema: exact keys, enums and bounds; anything else is rejected ---------- */
  const str=(v,min,max)=>typeof v==='string'&&v.length>=min&&v.length<=max;
  function profile(p){
    if(!exactKeys(p,['name','age','interests','readAloud'])||!str(p.name,0,40)||!Number.isInteger(p.age)||p.age<4||p.age>16||!str(p.interests,0,120)||typeof p.readAloud!=='boolean')return null;
    return {name:p.name,age:p.age,interests:p.interests,readAloud:p.readAloud};
  }
  function skillInput(e){
    if(!exactKeys(e,['s','ok','k','e','c','sid','id','verified']))return null;
    if(!Number.isInteger(e.s)||e.s<0||e.s>4||typeof e.ok!=='boolean'||!['task','prøv','cold','word'].includes(e.k)||!(e.e===''||ERRORS.includes(e.e))||!(e.c===''||CONFIDENCE.includes(e.c))||!str(e.sid,1,80)||!str(e.id,1,120)||typeof e.verified!=='boolean')return null;
    return {s:e.s,ok:e.ok,k:e.k,e:e.e,c:e.c,sid:e.sid,id:e.id,verified:e.verified};
  }
  const WORD_ID=/^[A-Za-z0-9_.:-]{1,80}$/;
  const OPS={
    skill:['skill','e','d'],'word-add':['word'],'word-review':['wordId','s','ok','c','d'],'word-remove':['ids'],helped:['skill','value'],session:['session'],profile:['profile']
  };
  // Returns a normalized copy of a valid payload for `kind`, or null.
  function checkPayload(kind,p,child){
    if(!p||typeof p!=='object'||Array.isArray(p)||p.v!==1||!time(p.t))return null;
    if(kind==='tombstone')return exactKeys(p,['type','v','t','child'])&&p.type==='tombstone'&&p.child===child?{type:'tombstone',v:1,t:p.t,child}:null;
    if(!Number.isSafeInteger(p.after)||p.after<0)return null;
    const head={type:p.type,v:1,t:p.t,after:p.after};
    if(kind==='base'){
      if(!exactKeys(p,['type','v','t','after','profile','learning'])||p.type!=='base')return null;
      const pr=profile(p.profile),l=p.learning;
      if(!pr||!l||typeof l!=='object'||Array.isArray(l)||l.version!==L.VERSION)return null;
      // Native bounds and enums; sessions travel as their own records.
      const m=L.normalizeMemory({...l,sessions:[]});
      return {...head,profile:pr,learning:{version:m.version,skills:m.skills,items:m.items.map(w=>({...w,sentence:''})),sessions:[],totals:m.totals}};
    }
    if(kind!=='op'||!Object.hasOwn(OPS,p.type)||!exactKeys(p,['type','v','t','after',...OPS[p.type]]))return null;
    switch(p.type){
      case 'skill':{const e=skillInput(p.e);return e&&Object.hasOwn(L.CATALOG,p.skill)&&typeof p.d==='boolean'?{...head,skill:p.skill,e,d:p.d}:null;}
      case 'word-add':{const w=p.word;return exactKeys(w,['id','word','meaning'])&&typeof w.id==='string'&&WORD_ID.test(w.id)&&str(w.word,1,60)&&str(w.meaning,0,160)?{...head,word:{id:w.id,word:w.word,meaning:w.meaning}}:null;}
      case 'word-review':return typeof p.wordId==='string'&&WORD_ID.test(p.wordId)&&Number.isInteger(p.s)&&p.s>=0&&p.s<=4&&typeof p.ok==='boolean'&&(p.c===''||CONFIDENCE.includes(p.c))&&typeof p.d==='boolean'?{...head,wordId:p.wordId,s:p.s,ok:p.ok,c:p.c,d:p.d}:null;
      case 'word-remove':return Array.isArray(p.ids)&&p.ids.length>=1&&p.ids.length<=60&&p.ids.every(id=>typeof id==='string'&&WORD_ID.test(id))?{...head,ids:p.ids.slice()}:null;
      case 'helped':return Object.hasOwn(L.CATALOG,p.skill)&&HELPED.includes(p.value)?{...head,skill:p.skill,value:p.value}:null;
      case 'session':{
        const s=p.session;if(!s||typeof s!=='object'||Array.isArray(s)||!str(s.id,1,80))return null;
        const n=L.normalizeMemory({version:L.VERSION,skills:{},items:[],sessions:[s],totals:{}}).sessions[0];
        if(!n)return null;n.interactions=[];return {...head,session:n};
      }
      case 'profile':{const pr=profile(p.profile);return pr?{...head,profile:pr}:null;}
    }
    return null;
  }

  /* ---------- deterministic merge ---------- */
  // Effective time of a record. `after` is the Worker time the recording phone had last seen, a lower bound for an
  // honest phone. A record from a phone whose clock disagreed with the Worker at upload (`ck` 0), or that claims a time
  // more than CLOCK_SKEW after its receipt, is placed at its receive time and earns no delay credit.
  function when(p,rec){
    let t=p.t;const at=rec&&Number.isSafeInteger(rec.at)?rec.at:null;
    if(p.after>0&&(at===null||p.after<=at)&&t<p.after)t=p.after;
    if(at===null)return {t,delay:true};
    if(rec.ck!==1||t>at+SKEW)return {t:at,delay:false};
    return {t:Math.min(t,at),delay:true};
  }
  // The base is the genesis of its child and always folds first.
  const orderKey=r=>r.kind==='base'?-Infinity:Math.max(when(r.p,r).t,r.at-WINDOW);
  // Ties (same effective time) follow the Worker's sequence, which keeps each phone's own order; the id breaks the rest.
  function order(a,b){const x=orderKey(a),y=orderKey(b);return x<y?-1:x>y?1:a.seq!==b.seq?a.seq-b.seq:a.id<b.id?-1:a.id>b.id?1:0;}
  // Keys carry a prefix, so no word id (e.g. "__proto__") can address the object's prototype.
  const alias=st=>st.meta.alias ||= {};
  const later=(t,id,cur)=>!cur||t>cur.t||t===cur.t&&id>cur.id;
  // One record applied to a fold state {learning, meta:{profile, helped}}; null until the base arrives.
  function apply(st,rec,p){
    if(p.type==='base'){
      if(st)return st;
      let learning=clone(p.learning);
      // The receive time is the only trusted clock: TR1's invariants quarantine authority claimed after it.
      if(Number.isSafeInteger(rec.at))learning=L.trust(L.normalizeMemory(learning),rec.at,rec.at);
      const w=when(p,rec),helped={};
      for(const [skill,r] of Object.entries(learning.skills))if(r.helped)helped[skill]={t:w.t,id:rec.id};
      return {learning,meta:{profile:{...p.profile,t:w.t,id:rec.id},helped,alias:{}}};
    }
    if(!st)return st;
    const w=when(p,rec),m=st.learning;
    switch(p.type){
      case 'skill':L.event(m,p.skill,{...p.e,t:w.t,mayDelay:w.delay&&p.d},w.t);break;
      // The same word added on two phones is one word: the later id becomes an alias, so its reviews still count.
      case 'word-add':{if(L.addWord(m,{...p.word,sentence:'',t:w.t}))break;const same=m.items.find(x=>x.word===p.word.word&&x.meaning===p.word.meaning);if(same&&same.id!==p.word.id)alias(st)['w:'+p.word.id]=same.id;break;}
      case 'word-review':L.reviewWord(m,{wordId:alias(st)['w:'+p.wordId]||p.wordId,t:w.t,s:p.s,ok:p.ok,c:p.c,mayDelay:w.delay&&p.d});break;
      case 'word-remove':{const ids=new Set(p.ids.map(id=>alias(st)['w:'+id]||id));m.items=m.items.filter(x=>!ids.has(x.id));break;}
      case 'helped':if(m.skills[p.skill]&&later(w.t,rec.id,st.meta.helped[p.skill])){m.skills[p.skill].helped=p.value;st.meta.helped[p.skill]={t:w.t,id:rec.id};}break;
      case 'session':if(!m.sessions.some(s=>s.id===p.session.id)){m.sessions.push(clone(p.session));m.sessions=m.sessions.slice(-L.LIMITS.sessions);}break;
      case 'profile':if(later(w.t,rec.id,st.meta.profile))st.meta.profile={...p.profile,t:w.t,id:rec.id};break;
    }
    return st;
  }
  // State of one child: checkpoint, then received records in canonical order, then this phone's unsent changes.
  function fold(s){
    let st=clone(s.cp.st);
    for(const r of s.log.slice().sort(order))st=apply(st,r,r.p);
    for(const op of s.pending)st=apply(st,{id:op.id,kind:op.kind},op.p);
    return st;
  }
  // Moves every received record whose order is final (orderKey <= horizon) into the checkpoint. Records arriving
  // later always sort after the horizon, so a checkpoint is a prefix of the same sequence on every phone.
  function checkpoint(s,horizon){
    const sorted=s.log.slice().sort(order),done=sorted.filter(r=>orderKey(r)<=horizon);
    if(!done.length)return false;
    let st=clone(s.cp.st);for(const r of done)st=apply(st,r,r.p);
    if(!st)return false;// never fold away records of a child whose base is missing
    s.cp={st};s.log=sorted.filter(r=>orderKey(r)>horizon);return true;
  }
  function emptySync(){return {v:1,cp:{st:null},log:[],pending:[],seen:[]};}
  // Structural check of a child's stored sync data; anything malformed yields null (the caller keeps the child local).
  function normalizeSync(s){
    if(!s||typeof s!=='object'||s.v!==1||!s.cp||typeof s.cp!=='object'||!Array.isArray(s.log)||!Array.isArray(s.pending)||!Array.isArray(s.seen))return null;
    const st=s.cp.st;
    if(st!==null&&!(st&&st.learning?.version===L.VERSION&&st.learning.skills&&Array.isArray(st.learning.items)&&Array.isArray(st.learning.sessions)&&st.meta?.profile&&st.meta.helped))return null;
    const log=[];
    for(const r of s.log){
      if(!r||!ID.test(r.id)||!['base','op'].includes(r.kind)||!Number.isSafeInteger(r.at)||![0,1].includes(r.ck)||!Number.isSafeInteger(r.seq))return null;
      const p=checkPayload(r.kind,r.p,'');if(!p)return null;log.push({seq:r.seq,id:r.id,kind:r.kind,at:r.at,ck:r.ck,p});
    }
    const pending=[];
    for(const op of s.pending){if(!op||!ID.test(op.id)||!['base','op'].includes(op.kind))return null;const p=checkPayload(op.kind,op.p,'');if(!p)return null;pending.push({id:op.id,kind:op.kind,p});}
    return {v:1,cp:{st},log,pending,seen:s.seen.filter(x=>typeof x==='string'&&x.length===16).slice(-LIMITS.seen),...(profile(s.profile)?{profile:profile(s.profile)}:{}),...(s.blocked===true?{blocked:true}:{})};
  }
  // Local profile and learning as the child's synced state. Fields that never sync stay as they were on this phone.
  function materialize(kid){
    const s=kid.sync;if(!s)return false;const st=fold(s);if(!st)return false;
    const old=kid.learning||{},sentences=new Map((old.items||[]).flatMap(w=>[[w.id,w.sentence],[w.word+'\n'+w.meaning,w.sentence]])),inter=new Map((old.sessions||[]).map(x=>[x.id,x.interactions]));
    for(const w of st.learning.items)w.sentence=sentences.get(w.id)||sentences.get(w.word+'\n'+w.meaning)||'';
    for(const x of st.learning.sessions)x.interactions=Array.isArray(inter.get(x.id))?inter.get(x.id):[];
    const {name,age,interests,readAloud}=st.meta.profile;
    Object.assign(kid,{name,age,interests,readAloud,learning:st.learning});s.profile={name,age,interests,readAloud};
    return true;
  }
  // The queue entry for a live skill event: the observed input plus the delay credit the recording phone granted.
  function skillOp(skill,input,v){return {type:'skill',t:input.t,skill:L.skillId(skill),e:{s:v.s,ok:v.ok,k:v.k,e:v.e,c:v.c,sid:v.sid,id:v.id,verified:v.verified},d:v.delayed};}
  const profileOf=k=>({name:String(k.name||'').slice(0,40),age:Number.isInteger(k.age)?Math.max(4,Math.min(16,k.age)):8,interests:String(k.interests||'').slice(0,120),readAloud:k.readAloud===true});
  const sameProfile=(a,b)=>!!a&&!!b&&['name','age','interests','readAloud'].every(f=>a[f]===b[f]);
  // A profile with no name and no learning, archive or notes: never shared, and replaced by a family child on a new phone.
  const blank=k=>!k.sync&&!k.name&&!Object.keys(k.learning?.skills||{}).length&&!(k.learning?.items||[]).length&&!(k.learning?.sessions||[]).length&&!(k.sessions||[]).length&&!(k.notes||[]).length&&!(k.log||[]).length;

  /* ---------- engine ---------- */
  // d = {subtle, random(n), now(), request(path, body) -> {status, data} (throws when offline), loadState(), saveState(obj),
  //      kids() -> array, saveKids() -> bool, addKid(kid), removeKid(kid), newKid(profile)}
  function createEngine(d){
    let keyCache=null,running=null;
    const newId=()=>b64url(d.random(16));
    function state(){
      let s;try{s=JSON.parse(d.loadState()||'null');}catch{s=null;}
      const ok=s&&s.v===1&&typeof s.key==='string'&&ID.test(s.gen);
      return {v:1,enabled:!!ok,key:ok?s.key:'',gen:ok?s.gen:'',cursor:ok&&Number.isSafeInteger(s?.cursor)&&s.cursor>=0?s.cursor:0,serverTime:ok&&time(s.serverTime)?s.serverTime:0,
        hidden:Array.isArray(s?.hidden)?s.hidden.filter(x=>ID.test(x)).slice(-LIMITS.ids):[],deleted:Array.isArray(s?.deleted)?s.deleted.filter(x=>ID.test(x)).slice(-LIMITS.ids):[],
        status:typeof s?.status==='string'?s.status.slice(0,20):'',lastSync:time(s?.lastSync)?s.lastSync:0,lastT:time(s?.lastT)?s.lastT:0,undecryptable:Number.isSafeInteger(s?.undecryptable)?s.undecryptable:0};
    }
    const save=s=>d.saveState(JSON.stringify(s));
    async function keys(s){
      if(keyCache?.text===s.key)return keyCache;
      const raw=await parseKey(d.subtle,s.key);if(!raw)throw Error('key');
      keyCache={text:s.key,...await deriveKeys(d.subtle,raw)};return keyCache;
    }
    const shared=()=>d.kids().filter(k=>k.sync);
    function seen(s,id){return s.seen.includes(id.slice(0,16));}
    function markSeen(s,id){const p=id.slice(0,16);if(!s.seen.includes(p)){s.seen.push(p);if(s.seen.length>LIMITS.seen)s.seen.splice(0,s.seen.length-LIMITS.seen);}}
    // A change on a shared child. The caller saves kids in the same step, so the change and its queue entry persist together.
    function enqueue(kid,payload){
      const s=state();if(!kid?.sync||!s.enabled)return false;
      // A phone's own changes do not go back in time across small clock steps, so causal order survives the merge.
      // A step back of more than CLOCK_SKEW is a corrected clock: the earlier reading is not carried forward.
      const t=s.lastT>payload.t&&s.lastT-payload.t<=SKEW?s.lastT:payload.t,kind='op',p=checkPayload(kind,{v:1,after:s.serverTime,...payload,t},kid.id);
      // A change that cannot be queued must not be lost at the next fold: the child (which already holds the change
      // locally) leaves the family log and stays here as a local copy.
      if(!p||kid.sync.pending.length>=LIMITS.pending){detach(kid);return false;}
      kid.sync.pending.push({id:newId(),kind,p});s.lastT=t;save(s);return true;
    }
    function profileChanged(kid){
      if(!kid?.sync)return false;const now=profileOf(kid);
      if(sameProfile(now,kid.sync.profile))return false;
      if(enqueue(kid,{type:'profile',t:d.now(),profile:now})){kid.sync.profile=now;return true;}return false;
    }
    // Shares a local child with the family: its current state becomes the immutable base; its session summaries follow.
    function share(kid){
      const s=state();if(!s.enabled||kid.sync||blank(kid))return false;
      kid.id=newId();// a fresh family identity, never reused from a local or restored profile
      const now=d.now(),l=kid.learning||L.empty(),after=s.serverTime;
      const base=checkPayload('base',{type:'base',v:1,t:now,after,profile:profileOf(kid),learning:{version:L.VERSION,skills:l.skills,items:l.items,sessions:[],totals:l.totals}},kid.id);
      if(!base)return false;
      kid.sync={...emptySync(),pending:[{id:newId(),kind:'base',p:base}],profile:base.profile};
      for(const x of l.sessions||[]){const p=checkPayload('op',{type:'session',v:1,t:now,after,session:x},kid.id);if(p)kid.sync.pending.push({id:newId(),kind:'op',p});}
      delete kid.fork;return true;
    }
    // Keeps the data on this phone as an unshared profile with a new identity (after a reset, a server-side deletion
    // that could not be verified, or an inconsistency). Nothing is lost; the parent decides what to do with it.
    function detach(kid){delete kid.sync;delete kid.id;kid.fork=true;}
    function fork(kid){mat(kid);detach(kid);}
    // Stored sync data that cannot be folded (corrupted beyond the load-time shape check) costs only this child's sharing.
    function mat(kid){try{return materialize(kid);}catch{detach(kid);return false;}}
    // Local copies (forks) are never shared in bulk: one may be a child the family deleted while this phone was away.
    function shareAll(){let n=0;for(const kid of d.kids())if(!kid.fork&&share(kid))n++;return n;}
    async function create({code}){
      const raw=d.random(16),text=await keyText(d.subtle,raw),k=await deriveKeys(d.subtle,raw);
      const r=await d.request('/sync/enroll',{v:1,mode:'create',code:String(code||''),proof:k.proof});
      if(r.status!==200||!ID.test(r.data?.gen))return {ok:false,code:r.data?.code||'error',error:r.data?.error||''};
      return activate(text,k,r.data);
    }
    async function join({key}){
      const raw=await parseKey(d.subtle,key);if(!raw)return {ok:false,code:'key_format'};
      const text=await keyText(d.subtle,raw),k=await deriveKeys(d.subtle,raw);
      const r=await d.request('/sync/enroll',{v:1,mode:'join',proof:k.proof});
      if(r.status!==200||!ID.test(r.data?.gen))return {ok:false,code:r.data?.code||'error',error:r.data?.error||''};
      return activate(text,k,r.data);
    }
    // Generation change (first enrolment, re-join after a reset): previously shared children become local copies.
    async function activate(text,k,data){
      const old=state();
      if(old.enabled&&old.gen!==data.gen&&Array.isArray(data.tombstones)){
        // Children deleted from the family in this phone's previous generation, verified with the previous key, are
        // removed rather than kept as copies: a reset never brings a deleted child back.
        let prev=null;try{prev=await keys(old);}catch{}
        if(prev)for(const t of data.tombstones){
          const kid=t&&t.gen===old.gen?d.kids().find(x=>x.sync&&x.id===t.child):null;if(!kid)continue;
          if(await open(d.subtle,prev.encKey,old.gen,{id:t.id,child:t.child,kind:'tombstone',iv:t.iv,ct:t.ct}))d.removeKid(kid);
        }
      }
      for(const kid of shared())if(kid.sync&&old.gen!==data.gen)fork(kid);
      keyCache={text,...k};
      // Same generation (a re-join): what this phone already applied, removed or saw deleted stays valid.
      const same=old.enabled&&old.gen===data.gen;
      const s={...old,v:1,key:text,gen:data.gen,cursor:same?old.cursor:0,serverTime:time(data.serverNow)?data.serverNow:0,hidden:same?old.hidden:[],deleted:same?old.deleted:[],status:'',lastSync:0,undecryptable:same?old.undecryptable:0};
      if(!save(s)||!d.saveKids())return {ok:false,code:'storage'};
      return {ok:true,key:text};
    }
    async function reset({code}){
      // Reset is always possible (it is the way out of a lost key, a full family or a corrupt stored key). Only a phone that
      // has just completed a download in the current generation (so every deletion it can receive is applied) shares its
      // children again automatically. Otherwise they stay here as local copies, shared again only by an explicit choice.
      let fresh=false;if(state().enabled){const r=await sync();fresh=r.ok||r.code==='quota';}
      const raw=d.random(16),text=await keyText(d.subtle,raw),k=await deriveKeys(d.subtle,raw);
      let r;try{r=await d.request('/sync/admin',{v:1,op:'reset',code:String(code||''),proof:k.proof});}catch{return {ok:false,code:'offline'};}
      if(r.status!==200||!ID.test(r.data?.gen))return {ok:false,code:r.data?.code||'error',error:r.data?.error||''};
      const before=fresh?shared():[],result=await activate(text,k,r.data);
      // Children still here (not removed by a verified tombstone) are shared again under new ids.
      if(result.ok&&before.length){for(const kid of before)if(d.kids().includes(kid))share(kid);d.saveKids();}
      return result;
    }
    function hide(kid){
      const s=state();if(!kid.sync)return {ok:false,code:'not_shared'};if(kid.sync.pending.length)return {ok:false,code:'pending'};
      s.hidden=[...s.hidden.filter(x=>x!==kid.id),kid.id].slice(-LIMITS.ids);if(!save(s))return {ok:false,code:'storage'};
      d.removeKid(kid);d.saveKids();return {ok:true};
    }
    function unhide(){const s=state();s.hidden=[];s.cursor=0;return save(s);}
    async function admin(body){
      const s=state();if(!s.enabled)return {status:0,data:{code:'off'}};
      return d.request('/sync/admin',{v:1,gen:s.gen,...body});
    }
    async function deleteChild({code,kid}){
      const s=state();if(!kid?.sync)return {ok:false,code:'not_shared'};
      const k=await keys(s),rec=await seal(d.subtle,d.random,k.encKey,s.gen,{id:newId(),child:kid.id,kind:'tombstone'},{type:'tombstone',v:1,t:d.now(),child:kid.id});
      const r=await admin({op:'delete-child',code:String(code||''),child:kid.id,record:{id:rec.id,iv:rec.iv,ct:rec.ct}});
      if(r.status!==200)return {ok:false,code:r.data?.code||'error',error:r.data?.error||''};
      const t=state();t.deleted=[...t.deleted,kid.id].slice(-LIMITS.ids);save(t);d.removeKid(kid);d.saveKids();return {ok:true};
    }
    async function revoke({code,device}){const r=await admin({op:'revoke',code:String(code||''),device:String(device||'')});return r.status===200?{ok:true}:{ok:false,code:r.data?.code||'error',error:r.data?.error||''};}
    async function devices(){const s=state();const r=await d.request('/sync/devices',{v:1,gen:s.gen});return r.status===200&&Array.isArray(r.data?.devices)?{ok:true,devices:r.data.devices}:{ok:false,code:r.data?.code||'error'};}
    function fail(code){const s=state();s.status=code;save(s);return {ok:false,code};}
    const STOP={401:'auth',403:'revoked',409:'rejoin',429:'rate',507:'quota'};
    function stop(r){if(r.status===403&&r.data?.code==='not_enrolled')return fail('rejoin');return fail(STOP[r.status]||'unavailable');}
    async function push(s,k){
      let quota=false;
      for(const kid of shared()){
        // A child the Worker reported deleted waits for its tombstone (pull) and is never pushed again.
        while(kid.sync&&kid.sync.pending.length&&!kid.sync.blocked){
          const batch=[];let bytes=0;
          let oversize=false;
          for(const op of kid.sync.pending){
            const rec=await seal(d.subtle,d.random,k.encKey,s.gen,{id:op.id,child:kid.id,kind:op.kind},op.p);
            // Native bounds keep every record far below these limits; should one ever exceed them, the child stays here.
            if(rec.ct.length>Math.ceil((op.kind==='base'?LIMITS.baseCt:LIMITS.opCt)*4/3)){oversize=true;break;}
            if(batch.length&&(batch.length>=LIMITS.pushRecords||bytes+rec.ct.length>LIMITS.pushBytes))break;
            batch.push(rec);bytes+=rec.ct.length;
          }
          if(oversize&&!batch.length){fork(kid);if(!d.saveKids())return fail('storage');break;}
          const r=await d.request('/sync/push',{v:1,gen:s.gen,clientNow:d.now(),records:batch});
          if(r.status!==200||!Array.isArray(r.data?.results)||r.data.results.length!==batch.length)return stop(r);
          if(r.data.results.some((res,i)=>res?.id!==batch[i].id))return fail('unavailable');
          let retry=false,lost=false,blocked=false;
          // Family child limit reached: the new child waits (its ops answer child_unknown because its base was refused).
          const full=r.data.results.some(res=>res.status==='quota');if(full)quota=true;
          r.data.results.forEach((res,i)=>{
            const op=kid.sync?.pending.find(o=>o.id===batch[i].id);if(!op)return;
            if(['ok','dup'].includes(res.status)&&Number.isSafeInteger(res.seq)&&Number.isSafeInteger(res.at)&&[0,1].includes(res.ck)){
              kid.sync.pending=kid.sync.pending.filter(o=>o!==op);
              if(!seen(kid.sync,op.id)){kid.sync.log.push({seq:res.seq,id:op.id,kind:op.kind,at:res.at,ck:res.ck,p:op.p});markSeen(kid.sync,op.id);}
            }else if(res.status==='child_deleted')blocked=true;
            else if(res.status==='child_exists'||res.status==='child_unknown'&&!full)lost=true;
            else retry=true;
          });
          if(lost)fork(kid);else{if(blocked)kid.sync.blocked=true;mat(kid);}
          if(!d.saveKids())return fail('storage');
          if(retry||blocked)break;
        }
      }
      return quota?fail('quota'):null;
    }
    async function pull(s,k){
      for(let page=0;page<LIMITS.pullPages;page++){
        const r=await d.request('/sync/pull',{v:1,gen:s.gen,cursor:s.cursor});
        const data=r.data;
        if(r.status!==200||!Array.isArray(data?.records)||!Number.isSafeInteger(data.next)||data.next<s.cursor||!time(data.serverNow)||!Array.isArray(data.children))return stop(r);
        const changed=new Set();
        for(const rec of data.records){
          if(!rec||!Number.isSafeInteger(rec.seq)||rec.seq<=s.cursor||rec.seq>data.next||!Number.isSafeInteger(rec.at)||![0,1].includes(rec.ck))return fail('unavailable');
          if(s.deleted.includes(rec.child)||s.hidden.includes(rec.child))continue;
          const p=await open(d.subtle,k.encKey,s.gen,rec);
          if(!p){s.undecryptable++;continue;}
          const kid=d.kids().find(x=>x.id===rec.child);
          if(rec.kind==='tombstone'){s.deleted=[...s.deleted,rec.child].slice(-LIMITS.ids);if(kid)d.removeKid(kid);continue;}
          let target=kid;
          if(!target){
            if(rec.kind!=='base')continue;// a child begins with its base; nothing else can create one
            target=d.newKid();target.id=rec.child;target.sync=emptySync();d.addKid(target);
          }else if(!target.sync)continue;// an unshared local profile never adopts family records
          if(seen(target.sync,rec.id))continue;
          target.sync.log.push({seq:rec.seq,id:rec.id,kind:rec.kind,at:rec.at,ck:rec.ck,p});markSeen(target.sync,rec.id);changed.add(target);
        }
        // A child the Worker reports deleted, without a tombstone this phone could verify, stays here as a local copy.
        // Checked on the last page only, when every tombstone up to the head has been read.
        if(!data.more){
          const deleted=new Set(data.children.filter(c=>c&&c.status==='deleted').map(c=>c.child));
          for(const kid of shared())if(deleted.has(kid.id)&&!s.deleted.includes(kid.id))fork(kid);
        }
        for(const kid of changed)if(kid.sync)mat(kid);
        if(!d.saveKids())return fail('storage');
        s.cursor=data.next;s.serverTime=data.serverNow;
        if(!save(s))return fail('storage');
        if(!data.more){
          const horizon=data.serverNow-WINDOW-SKEW;
          for(const kid of shared()){try{checkpoint(kid.sync,horizon);}catch{detach(kid);}}
          d.saveKids();return null;
        }
      }
      return null;
    }
    // One full round: send this phone's queue, then fetch everything new. Safe to interrupt at any await: unsent changes
    // stay queued, and records already stored are recognised by id when they arrive again.
    async function sync(){
      if(running)return running;
      running=(async()=>{
        const s=state();if(!s.enabled)return {ok:false,code:'off'};
        let k;try{k=await keys(s);}catch{return fail('key');}
        try{
          // A full family still downloads (so deletions arrive); the quota status is reported after the download.
          const round=async()=>{const a=await push(state(),k);if(a&&a.code!=='quota')return a;return (await pull(state(),k))||a;};
          let p=await round();
          // A phone that was paired again has a new device id: it re-enrols itself with the key it already holds.
          // If the family was reset meanwhile, the stored key no longer matches and the parent must enter the new one.
          if(p?.code==='rejoin'){
            const r=await d.request('/sync/enroll',{v:1,mode:'join',proof:k.proof});
            if(r.status!==200||r.data?.gen!==s.gen)return fail('rejoin');
            p=await round();
          }
          if(p)return p;
          const u=state();u.status='ok';u.lastSync=d.now();save(u);return {ok:true};
        }catch{return fail('offline');}
      })().finally(()=>{running=null;});
      return running;
    }
    return {state,enqueue,profileChanged,share,shareAll,create,join,reset,hide,unhide,deleteChild,revoke,devices,sync,materialize,fork,newId};
  }
  root.SparkSync={PROTOCOL,WINDOW,LIMITS,ID,b64url,unb64url,keyText,parseKey,deriveKeys,seal,open,checkPayload,when,orderKey,order,apply,fold,checkpoint,emptySync,normalizeSync,materialize,profileOf,blank,skillOp,createEngine};
})(globalThis);
