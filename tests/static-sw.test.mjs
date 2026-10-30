import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {read,root,script,html} from './helpers.mjs';

test('frontend, Worker, service-worker syntax and manifest/TOML parse; static paths exist',()=>{
  new vm.Script(script);new vm.Script(read('sw.js'));
  new vm.Script(read('backend/src/index.js').replace(/^import .*;$/gm,'').replace('export default','const worker ='));
  const manifest=JSON.parse(read('manifest.json'));assert.equal(manifest.scope,'./');assert.equal(manifest.start_url,'./spark.html');
  for(const path of [manifest.start_url,...manifest.icons.map(i=>i.src),'sw.js'])assert.ok(existsSync(new URL(path,root)),path);
  const config=JSON.parse(execFileSync('python',['-c','import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',new URL('backend/wrangler.toml',root).pathname.replace(/^\/([A-Z]:)/,'$1')],{encoding:'utf8'}));
  assert.equal(config.vars.ALLOWED_ORIGINS,'https://drasse-sys.github.io');assert.equal(config.ratelimits.length,4);assert.equal(new Set(config.ratelimits.map(r=>r.namespace_id)).size,4);
  for(const r of config.ratelimits)assert.ok([10,60].includes(r.simple.period));
  // Persisted Worker logs carry only the Worker's own content-free lines: no invocation logs (request metadata), no traces.
  assert.deepEqual(config.observability,{logs:{enabled:true,invocation_logs:false,head_sampling_rate:1},traces:{enabled:false}});
  assert.ok(!/user-scalable=no/.test(html));assert.match(html,/aria-label="Svaret ditt"/);
});
test('no provider key formats or credential assignments in static frontend files',()=>{
  for(const path of ['spark.html','sw.js','manifest.json']){
    const s=read(path);assert.ok(!/AIza[\w-]{30,}|sk-(?:or-v1-)?[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}/.test(s),path);
    assert.ok(!/(?:GEMINI_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|FAMILY_CODE|DEVICE_SIGNING_SECRET)\s*[:=]\s*['"][^'"]+['"]/.test(s),path);
  }
});
function serviceWorker(fetcher){
  const handlers={},saved=new Map(),deleted=[],waits=[];
  const cache={addAll:async files=>{for(const f of files){assert.equal(f.cache,'reload');saved.set(f.url,new Response('cached app'));}},match:async key=>saved.get(typeof key==='string'?key:key.url)?.clone(),put:async(key,response)=>saved.set(key,response)};
  const ctx={self:{registration:{scope:'https://app.test/spark/'},location:{origin:'https://app.test'},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(name,fn)=>handlers[name]=fn},URL,Request,Response,Set,Promise,fetch:fetcher,caches:{open:async()=>cache,keys:async()=>['spark-old','other-app-cache'],delete:async key=>deleted.push(key)},setTimeout:fn=>setTimeout(fn,5),clearTimeout};
  vm.runInNewContext(read('sw.js'),ctx);
  async function dispatch(name){handlers[name]({waitUntil:p=>waits.push(p)});await Promise.all(waits.splice(0));}
  function get(url,extra={}){let response;handlers.fetch({request:{url,method:'GET',mode:'navigate',...extra},waitUntil:p=>waits.push(p),respondWith:p=>response=p});return response;}
  return {dispatch,get,saved,deleted,waits};
}
test('SW install/update preserves unrelated origin caches and offline root opens cached app',async()=>{
  const sw=serviceWorker(async()=>{throw Error('offline');});await sw.dispatch('install');await sw.dispatch('activate');
  assert.deepEqual(sw.deleted,['spark-old']);assert.equal(await (await sw.get('https://app.test/spark/')).text(),'cached app');
  assert.equal(await (await sw.get('https://app.test/spark/spark.html?reload=1')).text(),'cached app');
});
test('SW excludes API, foreign resources and POSTs; errors do not poison app cache',async()=>{
  const sw=serviceWorker(async()=>new Response('server error',{status:500}));await sw.dispatch('install');
  assert.equal(sw.get('https://spark-family-api.drasse.workers.dev/health'),undefined);
  assert.equal(sw.get('https://app.test/chat',{mode:'cors'}),undefined);
  assert.equal(sw.get('https://app.test/spark/spark.html',{method:'POST'}),undefined);
  assert.equal(await (await sw.get('https://app.test/spark/spark.html')).text(),'cached app');
  assert.equal(await sw.saved.get('https://app.test/spark/spark.html').clone().text(),'cached app');
});
test('slow network uses cache within deadline and successful response refreshes app',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const sw=serviceWorker(()=>pending);await sw.dispatch('install');
  assert.equal(await (await sw.get('https://app.test/spark/spark.html')).text(),'cached app');
  resolve(new Response('new generation'));await Promise.all(sw.waits);assert.equal(await sw.saved.get('https://app.test/spark/spark.html').clone().text(),'new generation');
});
