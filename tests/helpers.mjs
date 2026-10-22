import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';

export const root = new URL('../', import.meta.url);
export const read = path => readFileSync(new URL(path, root), 'utf8');
export const html = read('spark.html');
export const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
export const voice = (lang, name=lang, extra={}) => ({lang, name, voiceURI:name, default:false, localService:false, ...extra});
export const body = (extra={}) => ({mode:'lekse',age:8,name:'Barn',interests:'fotball',notes:[],sessionState:'',transcript:'',messages:[{role:'user',content:'Hjelp meg med leksa'}],...extra});
export function backend(fetch){
  const ctx={crypto:webcrypto,TextEncoder,TextDecoder,Request,Response,URL,AbortSignal,atob,btoa,fetch};
  vm.createContext(ctx);
  vm.runInContext(read('arithmetic.js')+'\n'+read('visuals.js')+'\n'+read('backend/src/index.js').replace(/^import .*;$/gm,'').replace('export default {','globalThis.worker = {')+
    ';globalThis.api={makeToken,verifyToken,b64url,hmac,buildSystemPrompt,validatePayload,GEMINI_CHAIN};',ctx);
  return ctx;
}
export function environment(extra={}){
  const calls=[];
  const env={ALLOWED_ORIGINS:'https://drasse-sys.github.io',GEMINI_API_KEY:'fixture-provider-key',FAMILY_CODE:'fixture-family-code',DEVICE_SIGNING_SECRET:'fixture-signing-key',BACKUP_PROVIDER:'none',...extra};
  for(const name of ['CHAT_GLOBAL_LIMITER','CHAT_LIMITER','PAIR_GLOBAL_LIMITER','PAIR_LIMITER']){
    env[name] ||= {limit:async({key})=>{calls.push({name,key});return {success:true};}};
  }
  return {env,calls};
}
export function request(path, payload, token, origin='https://drasse-sys.github.io'){
  return new Request('https://spark.test'+path,{method:payload===undefined?'GET':'POST',headers:{origin,'content-type':'application/json','cf-connecting-ip':'192.0.2.1',...(token?{authorization:'Bearer '+token}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});
}
export const success = (text='Vi tar ett steg.') => Response.json({candidates:[{content:{parts:[{text}]}}]});
export function frontend({storage={},voices=[],fetch=async()=>Response.json({text:'Hva tror du?',provider:'gemini'}),failStorage=false}={}){
  const require=createRequire(process.env.SPARK_TEST_MODULE_ROOT || import.meta.url);
  const {JSDOM}=require('jsdom');
  const dom=new JSDOM(html,{url:'https://drasse-sys.github.io/spark/spark.html',runScripts:'outside-only'});
  const w=dom.window; let currentVoices=voices; const spoken=[], alerts=[], listeners={};
  for(const [key,value] of Object.entries(storage)) w.localStorage.setItem(key,typeof value==='string'?value:JSON.stringify(value));
  w.fetch=fetch; w.alert=x=>alerts.push(x); w.confirm=()=>true;
  w.speechSynthesis={getVoices:()=>currentVoices,cancel(){},speak:u=>spoken.push(u),addEventListener:(name,fn)=>listeners[name]=fn};
  w.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
  if(failStorage){w.Storage.prototype.setItem=()=>{throw Error('QuotaExceededError');};}
  w.eval(['arithmetic.js','learning.js','visuals.js','learning-ui.js'].map(read).join('\n')+'\n'+script+`;globalThis.testApi={state:()=>({kids,active,taskMode,history,chatMsgs,transcript,view,readOnly,busy,pendingFinal,serverUrl,voiceName,deviceToken,learningSession}),set:code=>eval(code),pickVoice,norwegianVoices,speak,payload,callAI,saveSession,loadSession,resumeSession,archiveSession,finishHomework,harvest,saveForm,render,start,send,toggleMic,stopMic,validServer,initHomeworkLearning,helpStep,beginCheck,startPractice,advancePractice,learningExport,validateImport,readPassage,arithmeticSkill};`);
  return {w,app:w.testApi,spoken,alerts,dom,voices:value=>{currentVoices=value;listeners.voiceschanged?.();}};
}
export const pairedStorage={spark_device_token:'fixture-device',spark_device_server:'https://spark-family-api.drasse.workers.dev'};
