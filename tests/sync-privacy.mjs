// SYNC1 privacy evidence for captured sync requests: STRUCTURAL, not substring-based.
//
// Why: record payloads travel as AES-256-GCM ciphertext encoded as base64url. Any fixed 3-letter string (e.g. "Ada")
// occurs by chance in about 1 of 262 144 random base64url positions, and one browser run sends ~10 000 such characters,
// so a raw `body.includes("Ada")` scan fails roughly once per 25 runs without any leak (GitHub run 41882703763).
// What this module proves instead, for every request:
//   1. the body is a JSON object whose keys are EXACTLY the permitted server-readable schema of its endpoint/operation;
//   2. every server-readable value is a bounded opaque id/IV/ciphertext/proof, a fixed enum, an integer, a device UUID,
//      or (only on the two operations that must prove it) the family code typed by the parent;
//   3. the device token appears only as the Authorization header of the phone that sent it, never in the body;
//   4. the membership proof equals the HKDF member derivation of a known family key (so the key itself is never sent);
//   5. every ciphertext opens with the family key under authenticated decryption bound to (generation, child, kind, id),
//      and the opened payload passes the client's exact payload schema. Plaintext child content therefore exists ONLY
//      inside authenticated ciphertext; no plaintext field can sit next to it (rule 1).
// Long secrets (token, key, proof: >= 28 characters) are additionally excluded by substring: a chance match inside
// random base64url has probability below 2^-160, so that check is deterministic in practice. Short words are never
// searched for inside ciphertext.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

export const RX=Object.freeze({
  id:/^[A-Za-z0-9_-]{21}[AQgw]$/,                       // 16 random bytes, canonical base64url (record, child, generation)
  iv:/^[A-Za-z0-9_-]{16}$/,                             // 12 bytes
  ct:/^[A-Za-z0-9_-]{22,}$/,                            // AES-GCM ciphertext + tag, base64url
  proof:/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,        // 32 bytes (HKDF output)
  device:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
});
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keysExactly=(o,keys,where)=>assert.deepEqual(Object.keys(o).sort(),keys.slice().sort(),where+': server-readable properties must be exactly '+keys.join(','));
const match=(v,rx,where)=>assert.ok(typeof v==='string'&&rx.test(v),where+' must be an opaque value matching '+rx);
const int=(v,where)=>assert.ok(Number.isSafeInteger(v)&&v>=0,where+' must be a non-negative integer');
function record(r,kinds,where){
  assert.ok(isObj(r),where+' must be an object');
  keysExactly(r,['id','child','kind','iv','ct'],where);
  match(r.id,RX.id,where+'.id');match(r.child,RX.id,where+'.child');match(r.iv,RX.iv,where+'.iv');match(r.ct,RX.ct,where+'.ct');
  assert.ok(kinds.includes(r.kind),where+'.kind must be one of '+kinds);
}

// Validates one captured request. ctx: {token, familyCode, proofs:Set|undefined, secrets:[long strings]}.
// Returns the sealed records the request carries ({gen, rec}) so the caller can open them with the family key.
export function checkSyncRequest({path,method='POST',body,auth},ctx){
  const where=path;
  assert.equal(method,'POST',where+': only POST');
  assert.equal(auth,'Bearer '+ctx.token,where+': Authorization must be exactly this phone\'s own device token');
  let b;try{b=JSON.parse(body);}catch{assert.fail(where+': body must be JSON');}
  assert.ok(isObj(b),where+': body must be a JSON object');
  assert.equal(b.v,1,where+'.v');
  const sealed=[];
  const proof=v=>{match(v,RX.proof,where+'.proof');if(ctx.proofs)assert.ok(ctx.proofs.has(v),where+'.proof must be the HKDF member derivation of a family key, never the key');};
  const code=v=>assert.equal(v,ctx.familyCode,where+'.code may only carry the family code the parent typed');
  switch(path){
    case '/sync/status':keysExactly(b,['v'],where);break;
    case '/sync/enroll':
      assert.ok(['create','join'].includes(b.mode),where+'.mode');
      keysExactly(b,b.mode==='create'?['v','mode','code','proof']:['v','mode','proof'],where+' ('+b.mode+')');
      if(b.mode==='create')code(b.code);proof(b.proof);break;
    case '/sync/push':
      keysExactly(b,['v','gen','clientNow','records'],where);match(b.gen,RX.id,where+'.gen');int(b.clientNow,where+'.clientNow');
      assert.ok(Array.isArray(b.records)&&b.records.length>=1&&b.records.length<=40,where+'.records');
      b.records.forEach((r,i)=>{record(r,['base','op'],where+'.records['+i+']');sealed.push({gen:b.gen,rec:r});});break;
    case '/sync/pull':keysExactly(b,['v','gen','cursor'],where);match(b.gen,RX.id,where+'.gen');int(b.cursor,where+'.cursor');break;
    case '/sync/devices':keysExactly(b,['v','gen'],where);match(b.gen,RX.id,where+'.gen');break;
    case '/sync/admin':{
      const shape={revoke:['v','gen','op','code','device'],'delete-child':['v','gen','op','code','child','record'],reset:['v','op','code','proof']}[b.op];
      assert.ok(shape,where+'.op must be revoke, delete-child or reset');
      keysExactly(b,shape,where+' ('+b.op+')');code(b.code);
      if(b.op==='reset')proof(b.proof);else match(b.gen,RX.id,where+'.gen');
      if(b.op==='revoke')match(b.device,RX.device,where+'.device');
      if(b.op==='delete-child'){
        match(b.child,RX.id,where+'.child');assert.ok(isObj(b.record),where+'.record');keysExactly(b.record,['id','iv','ct'],where+'.record');
        const rec={id:b.record.id,child:b.child,kind:'tombstone',iv:b.record.iv,ct:b.record.ct};record(rec,['tombstone'],where+'.record');sealed.push({gen:b.gen,rec});
      }
      break;
    }
    default:assert.fail('unexpected sync endpoint '+path);
  }
  // Credentials: never in the body (the token is a header; the key and proof-derivation input never leave the phone).
  for(const s of ctx.secrets||[]){assert.ok(s.length>=28,'only long secrets are substring-checked');assert.ok(!body.includes(s),where+' body carries a credential');}
  return sealed;
}

// Opens every sealed record with the family key through the REAL client codec (authenticated AES-GCM, associated data
// bound to generation/child/kind/id, then the exact payload schema). Fails if any ciphertext is not a genuine record.
export async function openAll(S,keyText,sealed,subtle=webcrypto.subtle){
  const raw=await S.parseKey(subtle,keyText);assert.ok(raw,'family key parses');
  const {encKey}=await S.deriveKeys(subtle,raw);
  const out=[];
  for(const {gen,rec} of sealed){
    const p=await S.open(subtle,encKey,gen,rec);
    assert.ok(p,'record '+rec.id+' ('+rec.kind+') must open under authenticated decryption with the family key');
    out.push({gen,rec,p:JSON.parse(JSON.stringify(p))});
  }
  return out;
}

// Tampering: a flipped ciphertext bit, or the same ciphertext presented for another child, kind, id or generation,
// must fail authentication (AES-GCM raises; the codec returns null).
export async function assertTamperFails(S,keyText,{gen,rec},otherId,subtle=webcrypto.subtle){
  const {encKey}=await S.deriveKeys(subtle,await S.parseKey(subtle,keyText));
  const bytes=S.unb64url(rec.ct);bytes[Math.floor(bytes.length/2)]^=1;
  const variants={flippedBit:[gen,{...rec,ct:S.b64url(bytes)}],otherChild:[gen,{...rec,child:otherId}],otherId:[gen,{...rec,id:otherId}],
    otherKind:[gen,{...rec,kind:rec.kind==='op'?'base':'op'}],otherGeneration:[otherId,rec]};
  for(const [name,[g,r]] of Object.entries(variants)){
    assert.equal(await S.open(subtle,encKey,g,r),null,'tampered ('+name+') must not open');
    await assert.rejects(subtle.decrypt({name:'AES-GCM',iv:S.unb64url(r.iv),additionalData:new TextEncoder().encode([S.PROTOCOL,g,r.child,r.kind,r.id].join('\n'))},encKey,S.unb64url(r.ct)),'tampered ('+name+') must fail AES-GCM authentication');
  }
}

export async function proofOf(S,keyText,subtle=webcrypto.subtle){return (await S.deriveKeys(subtle,await S.parseKey(subtle,keyText))).proof;}
