// Safe public checks: no family code, device token or provider call is used.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const frontend='https://drasse-sys.github.io/spark/';
const worker='https://spark-family-api.drasse.workers.dev';
const origin='https://drasse-sys.github.io';
// Expected Worker generation is read from source, so a release only bumps GENERATION in backend/src/index.js.
const expectedGeneration=/const GENERATION = '([^']+)'/.exec(await readFile(new URL('backend/src/index.js',root),'utf8'))[1];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=['spark.html','sw.js','manifest.json','index.html','icon-192.png','icon-512.png','arithmetic.js','learning.js','visuals.js','learning-ui.js'];
const checks=[];
for(const file of files){
  const r=await fetch(frontend+file+'?generation='+expectedGeneration+'',{cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200,file);
  const local=await readFile(new URL(file,root)),remote=Buffer.from(await r.arrayBuffer());
  // Git working-tree line endings must not obscure deployed generation checks.
  const normalized=buffer=>file.endsWith('.png')?buffer:Buffer.from(buffer.toString('utf8').replace(/\r\n/g,'\n'));
  const same=hash(normalized(local))===hash(normalized(remote));checks.push({file,same,sha256:hash(normalized(remote))});
}
const health=await fetch(worker+'/health',{headers:{Origin:origin},signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);assert.equal(health.headers.get('access-control-allow-origin'),origin);assert.equal(health.headers.get('cache-control'),'no-store');const data=await health.json();assert.equal(data.ok,true);
const options=await fetch(worker+'/chat',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});assert.equal(options.status,204);
const rejected=await fetch(worker+'/health',{headers:{Origin:'https://untrusted.example'}});assert.equal(rejected.status,403);assert.equal(rejected.headers.get('access-control-allow-origin'),null);
const unauth=await fetch(worker+'/chat',{method:'POST',headers:{Origin:origin,'content-type':'application/json'},body:'{}'});assert.equal(unauth.status,401);
console.log(JSON.stringify({frontend:checks,worker:{health:data,allowedOrigin:200,deniedOrigin:403,preflight:204,unauthenticatedChat:401,candidateDeployed:data.generation===expectedGeneration}},null,2));
assert.ok(checks.every(c=>c.same),'Pages has not yet published every candidate asset');
if(process.argv.includes('--require-worker-candidate'))assert.equal(data.generation,expectedGeneration,'Worker deployment remains pending');
