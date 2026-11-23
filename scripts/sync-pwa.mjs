import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

const shell=new URL('../spark.html',import.meta.url);
const worker=new URL('../sw.js',import.meta.url);
const html=readFileSync(shell,'utf8');
const release=html.match(/<meta name="spark-release" content="([a-z0-9-]+)">/)?.[1];
if(!release)throw Error('Missing Spark release in spark.html');
const scripts=Array.from(html.matchAll(/<script src="([a-z0-9-]+\.js)"><\/script>/g),match=>match[1]);
const pins=['spark.html',...scripts].map(file=>{
  const text=readFileSync(new URL(file,shell),'utf8').replace(/\r\n/g,'\n');
  return "  './"+file+"':'"+createHash('sha256').update(text).digest('hex')+"',";
});
const original=readFileSync(worker,'utf8');
const old=original.replace(/\r\n/g,'\n');
const cacheLine=/const CACHE = '[^']+';/;
const codeBlock=/const CODE = \{[\s\S]*?\n\};/;
if(!cacheLine.test(old)||!codeBlock.test(old))throw Error('Missing generated cache fields in sw.js');
const next=old.replace(cacheLine,"const CACHE = 'spark-family-"+release+"';")
  .replace(codeBlock,'const CODE = {\n'+pins.join('\n')+'\n};');
if(process.argv.includes('--check')){
  if(old!==next)throw Error('Run node scripts/sync-pwa.mjs to update the Spark cache release and file hashes');
}else writeFileSync(worker,original.includes('\r\n')?next.replace(/\n/g,'\r\n'):next);
