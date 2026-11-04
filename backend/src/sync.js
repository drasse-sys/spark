/* SYNC1 multi-device sync relay (candidate V1). Active only when SYNC_ENABLED is "1" and a SYNC_DB (D1) binding exists;
   otherwise every /sync/* path answers 404 exactly like an unknown route, so the production Worker is unchanged.

   The Worker is a relay for ciphertext. Phones encrypt with a family key the Worker never receives. The Worker checks
   authorization (device token, then an enrolled and active device row of this family), validates shape and size,
   assigns order and its own receive time, and stores. It never logs bodies, never echoes credentials, and every query
   is scoped by a family id it derives itself. */
const SYNC_ID=/^[A-Za-z0-9_-]{21}[AQgw]$/,SYNC_IV=/^[A-Za-z0-9_-]{16}$/,SYNC_B64=/^[A-Za-z0-9_-]+$/;
const SYNC_PROOF=/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,SYNC_DEVICE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYNC_SKEW=86400000,SYNC_DAY=86400000;
const SYNC_LIMITS=Object.freeze({pushRecords:40,pushBody:700000,opCt:43700,baseCt:349600,tombCt:1400,pullRows:200,pullBytes:2000000,children:20,childRows:100,familyRecords:200000,familyBytes:268435456});
const SYNC_TEXT={
  off:'Ikke funnet.',auth:'Enheten må kobles til på nytt.',rate:'For mange forespørsler på kort tid. Vent litt og prøv igjen.',
  bad:'Ugyldig forespørsel.',big:'Forespørselen er for stor.',code:'Feil familiekode.',setup:'Spark-serveren må settes opp av en forelder.',
  exists:'Synkronisering er allerede startet for denne familien.',none:'Synkronisering er ikke startet for denne familien.',
  key:'Feil synkroniseringsnøkkel.',revoked:'Denne enheten er fjernet fra familiens synkronisering.',enroll:'Denne enheten må bli med i synkroniseringen på nytt.',
  changed:'Synkroniseringen er startet på nytt. Skriv inn den nye nøkkelen.',quota:'Familiens synkroniseringsplass er full.',
  device:'Ukjent enhet.',child:'Ukjent barn.',unavailable:'Synkroniseringen er utilgjengelig akkurat nå.'
};
const syncEnabled=env=>env.SYNC_ENABLED==='1'&&!!env.SYNC_DB;
const syncKeys=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys.slice().sort().join();
function syncB64(bytes){let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function syncUnb64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const bin=atob(s),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}
const syncId=()=>syncB64(crypto.getRandomValues(new Uint8Array(16)));
async function syncDigest(proof){return syncB64(await crypto.subtle.digest('SHA-256',syncUnb64(proof)));}
function syncSame(a,b){a=String(a);b=String(b);if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
// One family per deployment: the namespace is an HMAC of a fixed label under the device-signing secret. It is not
// guessable from outside, never taken from a request, and stable across FAMILY_CODE rotation.
async function syncFamily(env,h){return syncB64(await h.hmac(env.DEVICE_SIGNING_SECRET,'SPARK-SYNC-FAMILY-V1'));}
const syncDay=now=>Math.floor(now/SYNC_DAY)*SYNC_DAY;
function syncCtLimit(kind){return kind==='base'?SYNC_LIMITS.baseCt:kind==='op'?SYNC_LIMITS.opCt:SYNC_LIMITS.tombCt;}
function syncRecordOk(r,kinds){
  return syncKeys(r,['id','child','kind','iv','ct'])&&typeof r.id==='string'&&SYNC_ID.test(r.id)&&typeof r.child==='string'&&SYNC_ID.test(r.child)&&
    kinds.includes(r.kind)&&typeof r.iv==='string'&&SYNC_IV.test(r.iv)&&typeof r.ct==='string'&&r.ct.length>=22&&r.ct.length<=syncCtLimit(r.kind)&&SYNC_B64.test(r.ct);
}

// Authorization for every family operation after enrolment: this device must have an active row in this family, and the
// phone must still be on the family's current generation.
async function syncMember(db,fam,deviceId,gen){
  const row=await db.prepare('SELECT f.gen AS gen, f.head AS head, f.record_count AS records, f.byte_count AS bytes, d.status AS status FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,deviceId).first();
  if(!row)return {status:403,code:'not_enrolled'};
  if(row.status==='revoked')return {status:403,code:'revoked'};
  if(row.status!=='active')return {status:403,code:'not_enrolled'};
  if(typeof gen!=='string'||!syncSame(gen,row.gen))return {status:409,code:'family_changed'};
  return {row};
}
// Tombstones of every generation, for a phone that proved the key or the family code (bounded by the child-row limit).
async function syncTombstones(db,fam){
  const rows=await db.prepare('SELECT child_id AS child, gen, record_id AS id, iv, ct FROM sync_tombstones WHERE family_id=?1 ORDER BY deleted_at DESC, child_id LIMIT 100').bind(fam).all();
  return rows.results.map(r=>({child:r.child,gen:r.gen,id:r.id,iv:r.iv,ct:r.ct}));
}
const SYNC_CODE_TEXT={not_enrolled:'enroll',revoked:'revoked',family_changed:'changed'};

async function syncHandle(request,env,url,c,h){
  const reply=(data,status=200)=>h.json(data,status,c.headers);
  const error=(status,code,text=code)=>reply({error:SYNC_TEXT[text]||SYNC_TEXT.unavailable,code},status);
  if(!syncEnabled(env)||request.method!=='POST')return reply({error:SYNC_TEXT.off},404);
  const route=url.pathname.slice('/sync/'.length);
  if(!['status','enroll','push','pull','devices','admin'].includes(route))return reply({error:SYNC_TEXT.off},404);
  // Authentication before any read: the same device-token check as /chat (signature, expiry, REVOKE_BEFORE).
  const device=await h.verifyToken(env,(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,''));
  if(!device||typeof device.deviceId!=='string'||!SYNC_DEVICE.test(device.deviceId))return error(401,'auth');
  const limiter=env.SYNC_LIMITER||env.CHAT_LIMITER;
  if(limiter){const {success}=await limiter.limit({key:'sync:'+device.deviceId});if(!success)return error(429,'rate');}
  // Family-code and membership-proof attempts get pairing's strict rate, counted PER DEVICE: a stolen or hostile token
  // can only use up its own budget, never the parent's (a shared family-wide or per-IP budget could be drained to block a
  // revocation). Guessing therefore needs many tokens, and every token needs pairing, which keeps its global limit.
  if((route==='admin'||route==='enroll')&&env.PAIR_LIMITER){const {success}=await env.PAIR_LIMITER.limit({key:'sync-admin:'+device.deviceId});if(!success)return error(429,'rate');}
  const parsed=await h.readBody(request,route==='push'?SYNC_LIMITS.pushBody:route==='admin'?4096:1024);
  if(parsed.error)return reply({error:parsed.error,code:parsed.status===413?'too_large':'bad_request'},parsed.status);
  const b=parsed.body;
  if(!b||typeof b!=='object'||Array.isArray(b)||b.v!==1)return error(400,'bad_request','bad');
  const db=env.SYNC_DB,fam=await syncFamily(env,h),now=Date.now();
  try{
    if(route==='status'){
      if(!syncKeys(b,['v']))return error(400,'bad_request','bad');
      const row=await db.prepare('SELECT f.gen AS gen, d.status AS status FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,device.deviceId).first();
      return reply({v:1,family:!!row,enrolled:row?.status||'none',...(row?.status==='active'?{gen:row.gen}:{}),serverNow:now});
    }
    if(route==='enroll'){
      const create=b.mode==='create';
      if(!syncKeys(b,create?['v','mode','code','proof']:['v','mode','proof'])||!['create','join'].includes(b.mode)||typeof b.proof!=='string'||!SYNC_PROOF.test(b.proof))return error(400,'bad_request','bad');
      const verifier=await syncDigest(b.proof);
      if(create){
        if(!env.FAMILY_CODE)return error(503,'setup');
        if(typeof b.code!=='string'||!h.sameCode(b.code,env.FAMILY_CODE))return error(401,'family_code','code');
        const gen=syncId();
        await db.batch([
          db.prepare('INSERT OR IGNORE INTO sync_families (family_id, gen, verifier, head, record_count, byte_count, created_at) VALUES (?1, ?2, ?3, 0, 0, 0, ?4)').bind(fam,gen,verifier,now),
          db.prepare("INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day) SELECT ?1, ?2, 'active', ?3, ?4 WHERE (SELECT gen FROM sync_families WHERE family_id=?1)=?5 ON CONFLICT(family_id, device_id) DO NOTHING").bind(fam,device.deviceId,now,syncDay(now),gen)
        ]);
        const row=await db.prepare('SELECT gen FROM sync_families WHERE family_id=?1').bind(fam).first();
        if(row?.gen!==gen)return error(409,'family_exists','exists');
        return reply({v:1,gen,serverNow:now,tombstones:await syncTombstones(db,fam)});
      }
      const row=await db.prepare('SELECT f.gen AS gen, f.verifier AS verifier, d.status AS status FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,device.deviceId).first();
      if(!row)return error(404,'no_family','none');
      if(!syncSame(verifier,row.verifier))return error(403,'key');
      // Revocation is permanent for this device id: a lost phone that still holds the key cannot re-enrol itself.
      if(row.status==='revoked')return error(403,'revoked');
      await db.prepare("INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day) VALUES (?1, ?2, 'active', ?3, ?4) ON CONFLICT(family_id, device_id) DO UPDATE SET seen_day=excluded.seen_day WHERE sync_devices.status='active'").bind(fam,device.deviceId,now,syncDay(now)).run();
      return reply({v:1,gen:row.gen,serverNow:now,tombstones:await syncTombstones(db,fam)});
    }
    if(route==='push'){
      if(!syncKeys(b,['v','gen','clientNow','records'])||typeof b.gen!=='string'||!Number.isSafeInteger(b.clientNow)||!Array.isArray(b.records)||b.records.length<1||b.records.length>SYNC_LIMITS.pushRecords||
        !b.records.every(r=>syncRecordOk(r,['base','op']))||new Set(b.records.map(r=>r.id)).size!==b.records.length)return error(400,'bad_request','bad');
      const m=await syncMember(db,fam,device.deviceId,b.gen);if(!m.row)return error(m.status,m.code,SYNC_CODE_TEXT[m.code]);
      const ids=JSON.stringify(b.records.map(r=>r.id)),childIds=JSON.stringify([...new Set(b.records.map(r=>r.child))]);
      const [children,existing,counts]=await db.batch([
        db.prepare('SELECT child_id AS child, status FROM sync_children WHERE family_id=?1 AND child_id IN (SELECT value FROM json_each(?2))').bind(fam,childIds),
        db.prepare('SELECT record_id AS id FROM sync_records WHERE family_id=?1 AND record_id IN (SELECT value FROM json_each(?2))').bind(fam,ids),
        db.prepare("SELECT SUM(status='active') AS active, COUNT(*) AS total FROM sync_children WHERE family_id=?1").bind(fam)
      ]);
      const status=new Map(children.results.map(r=>[r.child,r.status])),known=new Set(existing.results.map(r=>r.id));
      let active=Number(counts.results[0]?.active||0),total=Number(counts.results[0]?.total||0),bytes=0;
      const decided=new Map(),inserts=[],created=[];
      // A child begins with exactly one base; ops need an active child; a deleted child accepts nothing.
      for(const r of b.records){
        if(known.has(r.id))continue;
        const st=status.get(r.child);
        if(r.kind==='base'){
          if(st===undefined){
            // Only active children count: deleted ids are bounded separately (newest 100 kept, see delete-child).
            if(active>=SYNC_LIMITS.children){decided.set(r.id,'quota');continue;}
            status.set(r.child,'active');created.push(r.child);active++;total++;
          }else{decided.set(r.id,st==='deleted'?'child_deleted':'child_exists');continue;}
        }else if(st!=='active'){decided.set(r.id,st==='deleted'?'child_deleted':'child_unknown');continue;}
        inserts.push({id:r.id,child:r.child,kind:r.kind,iv:r.iv,ct:r.ct});bytes+=r.ct.length;
      }
      if(Number(m.row.records)+inserts.length>SYNC_LIMITS.familyRecords||Number(m.row.bytes)+bytes>SYNC_LIMITS.familyBytes)return error(507,'quota');
      const ck=Math.abs(now-b.clientNow)<=SYNC_SKEW?1:0;
      if(inserts.length)await db.batch([
        db.prepare("INSERT OR IGNORE INTO sync_children (family_id, child_id, status, created_at) SELECT ?1, value, 'active', ?2 FROM json_each(?3)").bind(fam,now,JSON.stringify(created)),
        // Conditions are re-checked inside the transaction, so a revocation, reset or deletion that lands between the
        // reads above and this write inserts nothing. Sequence numbers continue the family head without gaps.
        db.prepare(`INSERT INTO sync_records (family_id, seq, record_id, child_id, kind, received_at, clock_ok, iv, ct)
          SELECT ?1, f.head + ROW_NUMBER() OVER (ORDER BY CAST(j.key AS INTEGER)), json_extract(j.value,'$.id'), json_extract(j.value,'$.child'), json_extract(j.value,'$.kind'), ?2, ?3, json_extract(j.value,'$.iv'), json_extract(j.value,'$.ct')
          FROM json_each(?4) j JOIN sync_families f ON f.family_id=?1
          WHERE f.gen=?5
            AND EXISTS (SELECT 1 FROM sync_devices d WHERE d.family_id=?1 AND d.device_id=?6 AND d.status='active')
            AND EXISTS (SELECT 1 FROM sync_children ch WHERE ch.family_id=?1 AND ch.child_id=json_extract(j.value,'$.child') AND ch.status='active')
            AND NOT EXISTS (SELECT 1 FROM sync_records r WHERE r.family_id=?1 AND r.record_id=json_extract(j.value,'$.id'))`).bind(fam,now,ck,JSON.stringify(inserts),b.gen,device.deviceId),
        db.prepare(`UPDATE sync_families SET
            record_count=record_count+(SELECT COUNT(*) FROM sync_records r WHERE r.family_id=?1 AND r.seq>sync_families.head),
            byte_count=byte_count+(SELECT COALESCE(SUM(LENGTH(r.ct)),0) FROM sync_records r WHERE r.family_id=?1 AND r.seq>sync_families.head),
            head=MAX(head,COALESCE((SELECT MAX(seq) FROM sync_records r WHERE r.family_id=?1),0))
          WHERE family_id=?1`).bind(fam)
      ]);
      await db.prepare('UPDATE sync_devices SET seen_day=?3 WHERE family_id=?1 AND device_id=?2').bind(fam,device.deviceId,syncDay(now)).run();
      const stored=(await db.prepare('SELECT record_id AS id, seq, received_at AS at, clock_ok AS ck FROM sync_records WHERE family_id=?1 AND record_id IN (SELECT value FROM json_each(?2))').bind(fam,ids).all()).results;
      const byId=new Map(stored.map(r=>[r.id,r]));
      return reply({v:1,serverNow:now,results:b.records.map(r=>{
        const s=byId.get(r.id);
        if(s)return {id:r.id,status:known.has(r.id)?'dup':'ok',seq:Number(s.seq),at:Number(s.at),ck:Number(s.ck)};
        return {id:r.id,status:decided.get(r.id)||'retry'};
      })});
    }
    if(route==='pull'){
      if(!syncKeys(b,['v','gen','cursor'])||!Number.isSafeInteger(b.cursor)||b.cursor<0)return error(400,'bad_request','bad');
      const m=await syncMember(db,fam,device.deviceId,b.gen);if(!m.row)return error(m.status,m.code,SYNC_CODE_TEXT[m.code]);
      const [rows,children]=await db.batch([
        db.prepare('SELECT seq, record_id AS id, child_id AS child, kind, received_at AS at, clock_ok AS ck, iv, ct FROM sync_records WHERE family_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3').bind(fam,b.cursor,SYNC_LIMITS.pullRows+1),
        db.prepare('SELECT child_id AS child, status FROM sync_children WHERE family_id=?1 ORDER BY created_at, child_id').bind(fam)
      ]);
      const records=[];let size=0;
      for(const r of rows.results.slice(0,SYNC_LIMITS.pullRows)){
        if(records.length&&size+r.ct.length>SYNC_LIMITS.pullBytes)break;
        size+=r.ct.length;records.push({seq:Number(r.seq),id:r.id,child:r.child,kind:r.kind,at:Number(r.at),ck:Number(r.ck),iv:r.iv,ct:r.ct});
      }
      await db.prepare('UPDATE sync_devices SET seen_day=?3 WHERE family_id=?1 AND device_id=?2').bind(fam,device.deviceId,syncDay(now)).run();
      return reply({v:1,records,next:records.length?records.at(-1).seq:b.cursor,more:rows.results.length>records.length,head:Number(m.row.head),children:children.results.map(r=>({child:r.child,status:r.status})),serverNow:now});
    }
    if(route==='devices'){
      if(!syncKeys(b,['v','gen']))return error(400,'bad_request','bad');
      const m=await syncMember(db,fam,device.deviceId,b.gen);if(!m.row)return error(m.status,m.code,SYNC_CODE_TEXT[m.code]);
      const rows=await db.prepare('SELECT device_id AS device, status, enrolled_at AS enrolledAt, seen_day AS seenDay FROM sync_devices WHERE family_id=?1 ORDER BY status=\'active\' DESC, enrolled_at, device_id LIMIT 50').bind(fam).all();
      return reply({v:1,devices:rows.results.map(r=>({device:r.device,status:r.status,enrolledAt:Number(r.enrolledAt),seenDay:Number(r.seenDay),self:r.device===device.deviceId}))});
    }
    // route === 'admin': destructive or family-wide operations. Each needs the family code, which phones do not store,
    // so a stolen phone (token and key) cannot revoke other phones, delete children or reset the family.
    const op=b.op,shape={revoke:['v','gen','op','code','device'],'delete-child':['v','gen','op','code','child','record'],reset:['v','op','code','proof']}[op];
    if(!shape||!syncKeys(b,shape)||typeof b.code!=='string')return error(400,'bad_request','bad');
    if(op==='revoke'&&(typeof b.device!=='string'||!SYNC_DEVICE.test(b.device)))return error(400,'bad_request','bad');
    if(op==='delete-child'&&(typeof b.child!=='string'||!SYNC_ID.test(b.child)||!syncRecordOk({...b.record,child:b.child,kind:'tombstone'},['tombstone'])))return error(400,'bad_request','bad');
    if(op==='reset'&&(typeof b.proof!=='string'||!SYNC_PROOF.test(b.proof)))return error(400,'bad_request','bad');
    if(!env.FAMILY_CODE)return error(503,'setup');
    if(!h.sameCode(b.code,env.FAMILY_CODE))return error(401,'family_code','code');
    if(op==='reset'){
      // Lost key or key rotation: the family's records and active children and enrolments are deleted and a new generation
      // starts with the caller. Kept: revocations (a revoked id stays revoked), deleted child ids (never accepted again)
      // and tombstones (handed to re-joining phones). Phones keep their local data.
      const gen=syncId(),verifier=await syncDigest(b.proof);
      await db.batch([
        db.prepare('DELETE FROM sync_records WHERE family_id=?1').bind(fam),
        db.prepare("DELETE FROM sync_children WHERE family_id=?1 AND status='active'").bind(fam),
        db.prepare("DELETE FROM sync_devices WHERE family_id=?1 AND status='active'").bind(fam),
        db.prepare('INSERT INTO sync_families (family_id, gen, verifier, head, record_count, byte_count, created_at) VALUES (?1, ?2, ?3, 0, 0, 0, ?4) ON CONFLICT(family_id) DO UPDATE SET gen=excluded.gen, verifier=excluded.verifier, record_count=0, byte_count=0').bind(fam,gen,verifier,now),
        // The caller proved the family code (the parent), so its own device is (re)activated.
        db.prepare("INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day) VALUES (?1, ?2, 'active', ?3, ?4) ON CONFLICT(family_id, device_id) DO UPDATE SET status='active', enrolled_at=excluded.enrolled_at, seen_day=excluded.seen_day").bind(fam,device.deviceId,now,syncDay(now))
      ]);
      return reply({v:1,gen,serverNow:now,tombstones:await syncTombstones(db,fam)});
    }
    const m=await syncMember(db,fam,device.deviceId,b.gen);if(!m.row)return error(m.status,m.code,SYNC_CODE_TEXT[m.code]);
    if(op==='revoke'){
      const r=await db.prepare("UPDATE sync_devices SET status='revoked' WHERE family_id=?1 AND device_id=?2").bind(fam,b.device).run();
      if(!r.meta?.changes)return error(404,'device_unknown','device');
      return reply({v:1,revoked:true});
    }
    // delete-child: the child's records are deleted; a tombstone (encrypted by the requesting phone, so other phones can
    // verify it came from a key holder) takes the next sequence number, and the child id never accepts records again.
    const child=await db.prepare("SELECT status FROM sync_children WHERE family_id=?1 AND child_id=?2").bind(fam,b.child).first();
    if(child?.status!=='active')return error(404,'child_unknown','child');
    await db.batch([
      db.prepare('DELETE FROM sync_records WHERE family_id=?1 AND child_id=?2').bind(fam,b.child),
      db.prepare('INSERT OR REPLACE INTO sync_tombstones (family_id, child_id, gen, record_id, iv, ct, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(fam,b.child,m.row.gen,b.record.id,b.record.iv,b.record.ct,now),
      db.prepare("UPDATE sync_children SET status='deleted', deleted_at=?3 WHERE family_id=?1 AND child_id=?2").bind(fam,b.child,now),
      db.prepare("INSERT INTO sync_records (family_id, seq, record_id, child_id, kind, received_at, clock_ok, iv, ct) SELECT ?1, head+1, ?2, ?3, 'tombstone', ?4, 1, ?5, ?6 FROM sync_families WHERE family_id=?1 AND NOT EXISTS (SELECT 1 FROM sync_records WHERE family_id=?1 AND record_id=?2)").bind(fam,b.record.id,b.child,now,b.record.iv,b.record.ct),
      db.prepare(`UPDATE sync_families SET head=MAX(head,COALESCE((SELECT MAX(seq) FROM sync_records WHERE family_id=?1),0)),
          record_count=(SELECT COUNT(*) FROM sync_records WHERE family_id=?1), byte_count=(SELECT COALESCE(SUM(LENGTH(ct)),0) FROM sync_records WHERE family_id=?1) WHERE family_id=?1`).bind(fam),
      // Bounded: the newest 100 deleted ids and tombstones are kept. A phone offline for longer than 100 deletions that still
      // holds an older one gets child_unknown and keeps a local copy, which is never shared again automatically.
      db.prepare("DELETE FROM sync_children WHERE family_id=?1 AND status='deleted' AND child_id NOT IN (SELECT child_id FROM sync_children WHERE family_id=?1 AND status='deleted' ORDER BY deleted_at DESC, child_id LIMIT 100)").bind(fam),
      db.prepare('DELETE FROM sync_tombstones WHERE family_id=?1 AND child_id NOT IN (SELECT child_id FROM sync_tombstones WHERE family_id=?1 ORDER BY deleted_at DESC, child_id LIMIT 100)').bind(fam)
    ]);
    return reply({v:1,deleted:true});
  }catch{
    // Content-free: the route name only. Never a body, SQL, id, key or token.
    try{console.log(JSON.stringify({evt:'sync_failure',route,t:Date.now()}));}catch{}
    return error(503,'unavailable');
  }
}
globalThis.SparkSyncWorker={handle:syncHandle,enabled:syncEnabled,family:syncFamily,LIMITS:SYNC_LIMITS};
