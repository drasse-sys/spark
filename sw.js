/* Cache one verified app generation. API traffic never enters this cache. */
const CACHE = 'spark-family-20261123-rel3';
const CODE = {
  './spark.html':'1f50c44d9ecdf59f54db7168960a43209ae49735faf5faba35f7eb42643958be',
  './arithmetic.js':'05f0cf40c6c7651773e28e12de3083461060a34b5ed7d48e86e0128733b83257',
  './learning.js':'923ce0b56ea1bba469f905ca362cb13a64c21ee275eedff181bd7e64f7faa87e',
  './visuals.js':'97f04390e2fae59b583d6e154aaa629ddd4eccc45f45f207d99b46798a3aa611',
  './learning-ui.js':'cd0ff413b377e48a6c848907f014b39019f26b7be02e2aa3a3b2e317539d3bd5',
};
const STATIC = new Map([
  ...Object.keys(CODE), './manifest.json', './icon-192.png', './icon-512.png'
].map(path => [new URL(path,self.registration.scope).href,CODE[path]]));

async function matchesGeneration(response,digest){
  if(!response?.ok || response.redirected)return false;
  if(!digest)return true;
  const normalized=(await response.clone().text()).replace(/\r\n/g,'\n');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')===digest;
}

self.addEventListener('install', e=>{
  e.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    try{
      await cache.addAll([...STATIC.keys()].map(url=>new Request(url,{cache:'reload'})));
      for(const [url,digest] of STATIC){
        if(digest&&!await matchesGeneration(await cache.match(url),digest))throw Error('Incomplete Spark release');
      }
    }catch(err){
      await caches.delete(CACHE);
      throw err;
    }
    // An update waits until existing homework tabs close.
  })());
});

self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys()
    .then(keys=>Promise.all(keys.filter(key=>key.startsWith('spark-')&&key!==CACHE).map(key=>caches.delete(key))))
    .then(()=>self.clients.claim()));
});

async function getAsset(cache,url){
  const cached=await cache.match(url);
  if(cached)return cached;
  try{
    const response=await fetch(new Request(url,{cache:'reload',signal:AbortSignal.timeout(4000)}));
    if(!await matchesGeneration(response,STATIC.get(url)))return null;
    try{await cache.put(url,response.clone());}catch{}
    return response;
  }catch{return null;}
}

self.addEventListener('fetch', e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  const navigation=e.request.mode==='navigate'&&url.pathname.startsWith(new URL(self.registration.scope).pathname);
  url.search='';url.hash='';
  if(!navigation&&!STATIC.has(url.href))return;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    if(!navigation)return (await getAsset(cache,url.href))||Response.error();
    const app=await Promise.all(Object.keys(CODE).map(path=>getAsset(cache,new URL(path,self.registration.scope).href)));
    return app.every(Boolean)?app[0]:new Response(
      '<!doctype html><html lang="nb"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spark</title><p>Spark mangler appfiler. Koble til nettet, lukk alle Spark-faner og åpne Spark igjen.</p></html>',
      {status:503,headers:{'content-type':'text/html; charset=utf-8'}});
  })());
});
