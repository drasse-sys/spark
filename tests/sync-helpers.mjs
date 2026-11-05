// SYNC1 test harness. The Worker code under test is the real one (evaluated in-process, as in the other Worker tests),
// bound to a REAL local D1 database: wrangler's getPlatformProxy starts workerd's local D1 for the `sync-lab`
// environment in backend/wrangler.toml, in memory (persist:false). No Cloudflare account or network is used.
// Devices are headless instances of the real client engine (sync.js) with their own storage, clock and network switch.
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {read,backend,environment,request} from './helpers.mjs';

export const DAY=86400000;
export async function localD1(){
  const require=createRequire(new URL('../backend/package.json',import.meta.url));
  const {getPlatformProxy}=require('wrangler');
  const proxy=await getPlatformProxy({configPath:fileURLToPath(new URL('../backend/wrangler.toml',import.meta.url)),environment:'sync-lab',persist:false});
  const db=proxy.env.SYNC_DB;
  await migrate(db);
  return {db,dispose:()=>proxy.dispose()};
}
// Applies backend/migrations/*.sql in order, statement by statement (what `wrangler d1 migrations apply` runs).
export async function migrate(db){
  const dir=new URL('../backend/migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
    const sql=readFileSync(new URL(file,dir),'utf8').replace(/--.*$/gm,'');
    for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
}
// One module realm holding the client code exactly as the page loads it.
// `patch` (negative controls only) rewrites sync.js before evaluation.
export function clientRealm(patch=s=>s){
  const ctx=vm.createContext({TextEncoder,TextDecoder,btoa,atob,console});
  vm.runInContext(['arithmetic.js','learning.js','visuals.js'].map(read).join('\n')+'\n'+patch(read('sync.js')),ctx);
  return ctx;
}
export const realm=clientRealm(),L=realm.SparkLearning,S=realm.SparkSync;
const SS=S,LL=L;
// Removes exactly one check from evaluated source; a missing target fails loudly instead of passing vacuously.
export const cut=(target,replacement='')=>source=>{if(!source.includes(target))throw Error('negative-control target missing: '+target);return source.replace(target,replacement);};
// Shared world clock: the Worker's Date.now() and every device clock (plus its own skew) read it.
export function world(start=Date.parse('2026-11-04T12:00:00Z')){let now=start;return {now:()=>now,advance:ms=>{now+=ms;return now;},set:t=>{now=t;}};}
// A family = one Worker deployment (its own DEVICE_SIGNING_SECRET and FAMILY_CODE) on a given D1 database.
export function family(db,clock,name='a',extra={},syncPatch){
  const b=backend(()=>{throw Error('sync must never reach a provider');},undefined,syncPatch);
  b.__now=()=>clock.now();vm.runInContext('Date.now=()=>__now();',b);
  const {env,calls}=environment({SYNC_ENABLED:'1',SYNC_DB:db,FAMILY_CODE:'fixture-family-code-'+name,DEVICE_SIGNING_SECRET:'fixture-device-signing-'+name,...extra});
  return {b,env,calls,code:env.FAMILY_CODE,name};
}
let seedCounter=1;
// Deterministic PRNG per device (xorshift32) so a scenario can be replayed with identical record ids.
export function prng(seed){let x=seed>>>0||1;return n=>{const out=new Uint8Array(n);for(let i=0;i<n;i++){x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;out[i]=x&255;}return out;};}
export const blankKid=(name='')=>({name,age:8,interests:'',stars:0,notes:[],log:[],sessions:[],level:'',learning:L.empty(),readAloud:false});
export async function device(fam,clock,{skew=0,seed=seedCounter++,random,realm:r}={}){
  const S=r?r.SparkSync:SS,L=r?r.SparkLearning:LL;
  let token=await fam.b.api.makeToken(fam.env,webcrypto.randomUUID());
  const blankKid=(name='')=>({name,age:8,interests:'',stars:0,notes:[],log:[],sessions:[],level:'',learning:L.empty(),readAloud:false});
  const dev={fam,kids:[blankKid()],state:null,online:true,storageOk:true,sent:[],intercept:null,skew,persisted:null};
  const now=()=>clock.now()+dev.skew;
  async function req(path,body){
    if(!dev.online)throw Error('offline');
    dev.sent.push({path,body:JSON.parse(JSON.stringify(body))});
    const call=async()=>{const r=await dev.fam.b.worker.fetch(request(path,body,token),dev.fam.env);const text=await r.text();return {status:r.status,data:text?JSON.parse(text):null,text};};
    return dev.intercept?dev.intercept(path,body,call):call();
  }
  const saveKids=()=>{if(!dev.storageOk)return false;dev.persisted=JSON.stringify(dev.kids);return true;};
  const rnd=random||prng(seed);
  const build=()=>{
    const inner=S.createEngine({
      subtle:webcrypto.subtle,random:rnd,now,request:req,
      loadState:()=>dev.state,saveState:t=>{if(!dev.storageOk)return false;dev.state=t;return true;},
      kids:()=>dev.kids,saveKids,
      addKid:k=>{if(dev.kids.length===1&&S.blank(dev.kids[0]))dev.kids[0]=k;else dev.kids.push(k);},
      removeKid:k=>{const i=dev.kids.indexOf(k);if(i>=0)dev.kids.splice(i,1);if(!dev.kids.length)dev.kids.push(blankKid());},
      newKid:()=>blankKid()
    });
    // Results come from the client realm; plain copies compare structurally in this realm.
    const plain=v=>v&&typeof v==='object'?JSON.parse(JSON.stringify(v)):v;
    return Object.fromEntries(Object.entries(inner).map(([k,fn])=>[k,(...a)=>{const r=fn(...a);return r&&typeof r.then==='function'?r.then(plain):plain(r);}]));
  };
  dev.engine=build();
  // A new page load: a fresh engine over the same persisted storage (in-memory flags such as "already downloaded" are gone).
  dev.restart=()=>{dev.engine=build();};
  dev.now=now;dev.saveKids=saveKids;dev.token=()=>token;
  dev.repair=async()=>{token=await dev.fam.b.api.makeToken(dev.fam.env,webcrypto.randomUUID());};
  // Reload as the page does: parse persisted kids, normalize learning, check sync data.
  dev.reload=()=>{
    const parsed=JSON.parse(dev.persisted||'[]');
    dev.kids=parsed.map(k=>{const out={...blankKid(),...k,learning:L.normalizeMemory(k.learning)};if(out.sync){const s=S.ID.test(out.id||'')?S.normalizeSync(out.sync):null;if(s)out.sync=s;else{delete out.sync;delete out.id;out.fork=true;}}return out;});
    if(!dev.kids.length)dev.kids=[blankKid()];
  };
  dev.kid=name=>dev.kids.find(k=>k.name===name);
  dev.sync=()=>dev.engine.sync();
  let n=0;
  // Mirrors learning-ui.js recordLearning: the live event, then the queue entry built by the same SparkSync.skillOp.
  dev.practice=(kid,skill,{ok=true,s=0,k='task',c='',verified=true,e='',sid}={})=>{
    const session=sid||'d'+seed+'s'+n,input={id:session+':t1:'+(n++),t:now(),sid:session,s,ok,verified,k,e,c};
    const v=L.event(kid.learning,skill,input);if(v)dev.engine.enqueue(kid,S.skillOp(skill,input,v));saveKids();return v;
  };
  // Mirrors learning-ui.js saveWord / recordWord / clearWords.
  dev.addWord=(kid,word,meaning,sentence='')=>{const item=L.addWord(kid.learning,{word,meaning,sentence,id:'w'+(n++)+'-'+word,t:now()});if(item)dev.engine.enqueue(kid,{type:'word-add',t:now(),word:{id:item.id,word:item.word,meaning:item.meaning}});saveKids();return item;};
  dev.reviewWord=(kid,id,{ok=true,s=0,c=''}={})=>{const t=now(),r=L.reviewWord(kid.learning,{wordId:id,t,s,ok,c});if(r)dev.engine.enqueue(kid,{type:'word-review',t,wordId:id,s,ok,c,d:r.delayed});saveKids();return r;};
  dev.clearWords=kid=>{const ids=kid.learning.items.map(w=>w.id);kid.learning.items=[];if(ids.length)dev.engine.enqueue(kid,{type:'word-remove',t:now(),ids});saveKids();};
  // Mirrors spark.html archiveSession (aggregate + optional reflection).
  dev.archive=(kid,{id='d'+seed+'sess'+(n++),mode='matte',reflection=''}={})=>{
    const t=now(),agg={id,startedAt:t-60000,endedAt:t,activeMs:60000,interactions:[t-60000,t],mode,events:[],reflection,interventions:0};
    kid.learning.sessions.push(agg);dev.engine.enqueue(kid,{type:'session',t,session:agg});saveKids();return agg;
  };
  dev.profile=(kid,fields)=>{Object.assign(kid,fields);dev.engine.profileChanged(kid);saveKids();};
  return dev;
}
// Canonical, key-sorted view of every shared child: what must be identical on converged phones.
export function canon(v){if(Array.isArray(v))return v.map(canon);if(v&&typeof v==='object'){const o={};for(const k of Object.keys(v).sort())o[k]=canon(v[k]);return o;}return v;}
// Learning as the app holds it after a load (normalized), without the fields that never sync.
const view=l=>{const m=L.normalizeMemory(JSON.parse(JSON.stringify(l)));return {...m,items:m.items.map(w=>({...w,sentence:''})),sessions:m.sessions.map(x=>({...x,interactions:[]}))};};
export function snapshot(dev){
  return JSON.stringify(canon(dev.kids.filter(k=>k.sync).map(k=>({id:k.id,profile:S.profileOf(k),learning:view(k.learning)})).sort((a,b)=>a.id<b.id?-1:1)));
}
// The family state as a fresh phone would compute it from everything the Worker stores (decrypted with the family key).
export async function reference(dev){
  const st=dev.engine.state(),raw=await S.parseKey(webcrypto.subtle,st.key),k=await S.deriveKeys(webcrypto.subtle,raw);
  const rows=(await dev.fam.env.SYNC_DB.prepare('SELECT seq, record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records ORDER BY seq').all()).results;
  const byChild=new Map();
  for(const r of rows){const p=await S.open(webcrypto.subtle,k.encKey,st.gen,r);if(!p||r.kind==='tombstone')continue;if(!byChild.has(r.child))byChild.set(r.child,[]);byChild.get(r.child).push({seq:r.seq,id:r.id,kind:r.kind,at:r.at,ck:r.ck,p});}
  const out=[];
  for(const [id,log] of byChild){const fold=S.fold({cp:{st:null},log,pending:[]});if(fold)out.push({id,profile:{name:fold.meta.profile.name,age:fold.meta.profile.age,interests:fold.meta.profile.interests,readAloud:fold.meta.profile.readAloud},learning:view(fold.learning)});}
  return JSON.stringify(canon(out.sort((a,b)=>a.id<b.id?-1:1)));
}
export {request};
