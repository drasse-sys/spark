/* SYNC1 multi-device sync relay (candidate V1). Active only when SYNC_ENABLED is "1" and a SYNC_DB (D1) binding exists;
   otherwise every /sync/* path answers 404 exactly like an unknown route, so the production Worker is unchanged.

   The Worker is a relay for ciphertext. Phones encrypt with a family key the Worker never receives. The Worker checks
   authorization (device token, then an enrolled and active device row of this family), validates shape and size,
   assigns order and its own receive time, and stores. It never logs bodies, never echoes credentials, and every query
   is scoped by a family id it derives itself. */
const SYNC_ID=/^[A-Za-z0-9_-]{21}[AQgw]$/,SYNC_IV=/^[A-Za-z0-9_-]{16}$/,SYNC_B64=/^[A-Za-z0-9_-]+$/;
const SYNC_PROOF=/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,SYNC_DEVICE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYNC_SKEW=86400000,SYNC_DAY=86400000;
const SYNC_LIMITS=Object.freeze({pushRecords:40,pushBody:700000,opCt:43700,baseCt:349600,tombCt:1400,pullRows:200,pullBytes:2000000,children:20,deletedPerGeneration:500,familyRecords:200000,familyBytes:268435456,devices:200,devicesInactive:50,revokedKeepMs:366*86400000});
const SYNC_TEXT={
  off:'Ikke funnet.',auth:'Enheten må kobles til på nytt.',rate:'For mange forespørsler på kort tid. Vent litt og prøv igjen.',
  bad:'Ugyldig forespørsel.',big:'Forespørselen er for stor.',code:'Feil familiekode.',setup:'Spark-serveren må settes opp av en forelder.',
  exists:'Synkronisering er allerede startet for denne familien.',none:'Synkronisering er ikke startet for denne familien.',
  key:'Feil synkroniseringsnøkkel.',revoked:'Denne enheten er fjernet fra familiens synkronisering.',enroll:'Denne enheten må bli med i synkroniseringen på nytt.',
  changed:'Synkroniseringen er startet på nytt. Skriv inn den nye nøkkelen.',quota:'Familiens synkroniseringsplass er full.',
  device:'Ukjent enhet.',child:'Ukjent barn.',deletedFull:'Familien har slettet for mange barn i denne synkroniseringen. Start på nytt med ny nøkkel for å rydde opp.',unavailable:'Synkroniseringen er utilgjengelig akkurat nå.'
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

// SQL for "this device is a member of generation G of this family": an active registry row that proved the key of the
// CURRENT generation. Used inside every write batch, so the check and the write are one atomic database step.
const syncMemberSql=(fam,dev,gen)=>`EXISTS (SELECT 1 FROM sync_devices md JOIN sync_families mf ON mf.family_id=md.family_id WHERE md.family_id=${fam} AND md.device_id=${dev} AND md.status='active' AND md.gen=mf.gen AND mf.gen=${gen})`;
// Authorization for every family operation after enrolment: this device must have an active row in this family for the
// family's current generation, and the phone must be on that generation. (A cheap early rejection: writes re-check in SQL.)
async function syncMember(db,fam,deviceId,gen){
  const row=await db.prepare('SELECT f.gen AS gen, f.head AS head, f.record_count AS records, f.byte_count AS bytes, d.status AS status, d.gen AS dgen FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,deviceId).first();
  if(!row)return {status:403,code:'not_enrolled'};
  if(row.status==='revoked')return {status:403,code:'revoked'};
  if(row.status!=='active')return {status:403,code:'not_enrolled'};
  if(typeof gen!=='string'||!syncSame(gen,row.gen))return {status:409,code:'family_changed'};
  // Enrolled for an earlier generation (kept by a reset so it stays revocable): it must prove the new key again.
  if(row.dgen!==row.gen)return {status:403,code:'not_enrolled'};
  return {row};
}
// Tombstones of every generation, for a phone that proved the key or the family code (bounded by the child-row limit).
async function syncTombstones(db,fam){
  const rows=await db.prepare('SELECT child_id AS child, gen, record_id AS id, iv, ct FROM sync_tombstones WHERE family_id=?1 ORDER BY deleted_at DESC, child_id LIMIT 100').bind(fam).all();
  return rows.results.map(r=>({child:r.child,gen:r.gen,id:r.id,iv:r.iv,ct:r.ct}));
}
// Bounded device registry. Kept: every revoked row while its token could still be valid (tokens last 365 days from
// pairing, which is never after enrolment), and the newest `devicesInactive` rows of devices that predate the current
// generation (so a lost phone stays listable and revocable after a reset). Everything else is housekeeping.
function syncDevicePrune(db,fam,now){
  const stale="status='active' AND gen<>(SELECT gen FROM sync_families WHERE family_id=?1)";
  return [
    db.prepare(`DELETE FROM sync_devices WHERE family_id=?1 AND ${stale} AND device_id NOT IN (SELECT device_id FROM sync_devices WHERE family_id=?1 AND ${stale} ORDER BY enrolled_at DESC, device_id LIMIT ?2)`).bind(fam,SYNC_LIMITS.devicesInactive),
    db.prepare("DELETE FROM sync_devices WHERE family_id=?1 AND status='revoked' AND enrolled_at<?2").bind(fam,now-SYNC_LIMITS.revokedKeepMs)
  ];
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
      const row=await db.prepare('SELECT f.gen AS gen, d.status AS status, d.gen AS dgen FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,device.deviceId).first();
      const member=row?.status==='active'&&row.dgen===row.gen;
      return reply({v:1,family:!!row,enrolled:!row||!row.status?'none':row.status==='revoked'?'revoked':member?'active':'inactive',...(member?{gen:row.gen}:{}),serverNow:now});
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
          db.prepare("INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day, gen) SELECT ?1, ?2, 'active', ?3, ?4, ?5 WHERE (SELECT gen FROM sync_families WHERE family_id=?1)=?5 ON CONFLICT(family_id, device_id) DO NOTHING").bind(fam,device.deviceId,now,syncDay(now),gen)
        ]);
        const row=await db.prepare('SELECT gen FROM sync_families WHERE family_id=?1').bind(fam).first();
        if(row?.gen!==gen)return error(409,'family_exists','exists');
        return reply({v:1,gen,serverNow:now,tombstones:await syncTombstones(db,fam)});
      }
      const row=await db.prepare('SELECT f.gen AS gen, f.verifier AS verifier, d.status AS status FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,device.deviceId).first();
      if(!row)return error(404,'no_family','none');
      if(!syncSame(verifier,row.verifier))return error(403,'key');
      // Revocation is permanent for this device id: a lost phone that still holds the key cannot re-enrol itself, and a
      // family reset does not forgive it. Only the parent-authorized `reauthorize` (family code) lifts it.
      if(row.status==='revoked')return error(403,'revoked');
      // One atomic step: housekeeping (bounded registry), then the upsert, guarded by the generation AND the verifier read
      // above. A reset that lands between the read and the write changes both, so a stale key enrols nothing.
      await db.batch([
        ...syncDevicePrune(db,fam,now),
        db.prepare(`INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day, gen)
          SELECT ?1, ?2, 'active', ?3, ?4, f.gen FROM sync_families f
          WHERE f.family_id=?1 AND f.gen=?5 AND f.verifier=?6
            AND (EXISTS (SELECT 1 FROM sync_devices x WHERE x.family_id=?1 AND x.device_id=?2) OR (SELECT COUNT(*) FROM sync_devices x WHERE x.family_id=?1)<?7)
          ON CONFLICT(family_id, device_id) DO UPDATE SET seen_day=excluded.seen_day, enrolled_at=CASE WHEN sync_devices.gen=excluded.gen THEN sync_devices.enrolled_at ELSE excluded.enrolled_at END, gen=excluded.gen WHERE sync_devices.status='active'`).bind(fam,device.deviceId,now,syncDay(now),row.gen,verifier,SYNC_LIMITS.devices)
      ]);
      const post=await db.prepare('SELECT f.gen AS gen, d.status AS status, d.gen AS dgen FROM sync_families f LEFT JOIN sync_devices d ON d.family_id=f.family_id AND d.device_id=?2 WHERE f.family_id=?1').bind(fam,device.deviceId).first();
      if(post?.status==='revoked')return error(403,'revoked');
      if(post?.gen!==row.gen)return error(409,'family_changed','changed');
      if(post.status!=='active'||post.dgen!==row.gen)return error(507,'quota');
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
            status.set(r.child,'active');created.push({child:r.child,id:r.id});active++;total++;
          }else{decided.set(r.id,st==='deleted'?'child_deleted':'child_exists');continue;}
        }else if(st!=='active'){decided.set(r.id,st==='deleted'?'child_deleted':'child_unknown');continue;}
        inserts.push({id:r.id,child:r.child,kind:r.kind,iv:r.iv,ct:r.ct});bytes+=r.ct.length;
      }
      if(Number(m.row.records)+inserts.length>SYNC_LIMITS.familyRecords||Number(m.row.bytes)+bytes>SYNC_LIMITS.familyBytes)return error(507,'quota');
      const ck=Math.abs(now-b.clientNow)<=SYNC_SKEW?1:0;
      if(inserts.length)await db.batch([
        // Every statement is conditioned, inside the transaction, on the same facts: this device is a member of THIS
        // generation, the child is (or is being created as) active, the id is unused. A reset, revocation or deletion that
        // landed after the reads above therefore leaves no trace: no ghost child, no record, no quota use.
        // A child row is created only together with its base (the record id must be unused) and only while the family
        // has room, counted inside the database, so concurrent first pushes cannot exceed the quota either.
        db.prepare(`INSERT INTO sync_children (family_id, child_id, status, created_at)
          SELECT ?1, json_extract(j.value,'$.child'), 'active', ?2 FROM json_each(?3) j
          WHERE ${syncMemberSql('?1','?5','?4')}
            AND NOT EXISTS (SELECT 1 FROM sync_children c WHERE c.family_id=?1 AND c.child_id=json_extract(j.value,'$.child'))
            AND NOT EXISTS (SELECT 1 FROM sync_records r WHERE r.family_id=?1 AND r.record_id=json_extract(j.value,'$.id'))
            AND (SELECT COUNT(*) FROM sync_children c WHERE c.family_id=?1 AND c.status='active')+CAST(j.key AS INTEGER)+1<=?6`).bind(fam,now,JSON.stringify(created),b.gen,device.deviceId,SYNC_LIMITS.children),
        // Sequence numbers continue the family head without gaps.
        db.prepare(`INSERT INTO sync_records (family_id, seq, record_id, child_id, kind, received_at, clock_ok, iv, ct)
          SELECT ?1, f.head + ROW_NUMBER() OVER (ORDER BY CAST(j.key AS INTEGER)), json_extract(j.value,'$.id'), json_extract(j.value,'$.child'), json_extract(j.value,'$.kind'), ?2, ?3, json_extract(j.value,'$.iv'), json_extract(j.value,'$.ct')
          FROM json_each(?4) j JOIN sync_families f ON f.family_id=?1
          WHERE f.gen=?5
            AND ${syncMemberSql('?1','?6','?5')}
            AND EXISTS (SELECT 1 FROM sync_children ch WHERE ch.family_id=?1 AND ch.child_id=json_extract(j.value,'$.child') AND ch.status='active')
            AND NOT EXISTS (SELECT 1 FROM sync_records r WHERE r.family_id=?1 AND r.record_id=json_extract(j.value,'$.id'))`).bind(fam,now,ck,JSON.stringify(inserts),b.gen,device.deviceId),
        db.prepare(`UPDATE sync_families SET
            record_count=record_count+(SELECT COUNT(*) FROM sync_records r WHERE r.family_id=?1 AND r.seq>sync_families.head),
            byte_count=byte_count+(SELECT COALESCE(SUM(LENGTH(r.ct)),0) FROM sync_records r WHERE r.family_id=?1 AND r.seq>sync_families.head),
            head=MAX(head,COALESCE((SELECT MAX(seq) FROM sync_records r WHERE r.family_id=?1),0))
          WHERE family_id=?1`).bind(fam),
        // Belt and braces: a child row created by this request that ended up without any record is removed again.
        db.prepare("DELETE FROM sync_children WHERE family_id=?1 AND status='active' AND child_id IN (SELECT json_extract(value,'$.child') FROM json_each(?2)) AND NOT EXISTS (SELECT 1 FROM sync_records r WHERE r.family_id=?1 AND r.child_id=sync_children.child_id)").bind(fam,JSON.stringify(created))
      ]);
      await db.prepare('UPDATE sync_devices SET seen_day=?3 WHERE family_id=?1 AND device_id=?2').bind(fam,device.deviceId,syncDay(now)).run();
      const stored=(await db.prepare('SELECT record_id AS id, seq, received_at AS at, clock_ok AS ck FROM sync_records WHERE family_id=?1 AND record_id IN (SELECT value FROM json_each(?2))').bind(fam,ids).all()).results;
      const byId=new Map(stored.map(r=>[r.id,r]));
      // A record that was neither stored nor refused for a reason of its own means a condition changed after the reads.
      // If this phone's generation or membership is the reason, say so (409/403) instead of a silent "retry".
      const unresolved=b.records.filter(r=>!byId.has(r.id)&&!decided.has(r.id));
      if(unresolved.length){
        const again=await syncMember(db,fam,device.deviceId,b.gen);if(!again.row)return error(again.status,again.code,SYNC_CODE_TEXT[again.code]);
        // Still a member: if a concurrent push took the last child slot, report it as the quota (as the reads above would have).
        const now_=Number((await db.prepare("SELECT COUNT(*) AS n FROM sync_children WHERE family_id=?1 AND status='active'").bind(fam).first())?.n||0);
        const made=new Set(created.map(c=>c.child));
        if(now_>=SYNC_LIMITS.children)for(const r of unresolved)if(made.has(r.child)&&!byId.has(r.id))decided.set(r.id,r.kind==='base'?'quota':'child_unknown');
      }
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
      // 'active' = member of the current generation; 'inactive' = enrolled before a reset (still revocable); 'revoked'.
      const rows=await db.prepare("SELECT d.device_id AS device, CASE WHEN d.status='revoked' THEN 'revoked' WHEN d.gen=f.gen THEN 'active' ELSE 'inactive' END AS status, d.enrolled_at AS enrolledAt, d.seen_day AS seenDay FROM sync_devices d JOIN sync_families f ON f.family_id=d.family_id WHERE d.family_id=?1 ORDER BY CASE WHEN d.status='revoked' THEN 2 WHEN d.gen=f.gen THEN 0 ELSE 1 END, d.enrolled_at, d.device_id LIMIT 200").bind(fam).all();
      return reply({v:1,devices:rows.results.map(r=>({device:r.device,status:r.status,enrolledAt:Number(r.enrolledAt),seenDay:Number(r.seenDay),self:r.device===device.deviceId}))});
    }
    // route === 'admin': destructive or family-wide operations. Each needs the family code, which phones do not store,
    // so a stolen phone (token and key) cannot revoke other phones, delete children or reset the family.
    const op=b.op,shape={revoke:['v','gen','op','code','device'],reauthorize:['v','op','code','device'],'delete-child':['v','gen','op','code','child','record'],reset:['v','op','code','proof']}[op];
    if(!shape||!syncKeys(b,shape)||typeof b.code!=='string')return error(400,'bad_request','bad');
    if((op==='revoke'||op==='reauthorize')&&(typeof b.device!=='string'||!SYNC_DEVICE.test(b.device)))return error(400,'bad_request','bad');
    if(op==='delete-child'&&(typeof b.child!=='string'||!SYNC_ID.test(b.child)||!syncRecordOk({...b.record,child:b.child,kind:'tombstone'},['tombstone'])))return error(400,'bad_request','bad');
    if(op==='reset'&&(typeof b.proof!=='string'||!SYNC_PROOF.test(b.proof)))return error(400,'bad_request','bad');
    if(!env.FAMILY_CODE)return error(503,'setup');
    if(!h.sameCode(b.code,env.FAMILY_CODE))return error(401,'family_code','code');
    if(op==='reauthorize'){
      // The only way to lift a revocation of the same device id: the family code (a parent), from any phone, including the
      // revoked one. The device becomes INACTIVE, not a member: it must still prove the family key with a normal join.
      // (A replaced phone needs none of this: pairing it again gives a new device id, which only needs the key.)
      const r=await db.prepare("UPDATE sync_devices SET status='active', gen='' WHERE family_id=?1 AND device_id=?2 AND status='revoked'").bind(fam,b.device).run();
      if(!r.meta?.changes)return error(404,'device_unknown','device');
      return reply({v:1,reauthorized:true});
    }
    if(op==='reset'){
      // Lost key or key rotation: the family's records, active children and enrolments are replaced by a new generation
      // that starts with the caller. Kept: revocations (a revoked id stays revoked), every earlier device row (now
      // INACTIVE: it must prove the new key, and stays listable and revocable), deleted child ids (never accepted again)
      // and tombstones (handed to re-joining phones). Phones keep their local data.
      // A revoked caller cannot reset: it would mint its own key and re-enrol itself, undoing the revocation.
      const self=await db.prepare('SELECT status FROM sync_devices WHERE family_id=?1 AND device_id=?2').bind(fam,device.deviceId).first();
      if(self?.status==='revoked')return error(403,'revoked');
      const gen=syncId(),verifier=await syncDigest(b.proof);
      // `prev` (read inside the same transaction) is the generation this reset replaced. A phone re-shares automatically
      // only when it equals the generation it has just downloaded completely: a concurrent reset (and deletions in its
      // generation) between that download and this request make the phone's copies local copies instead.
      const [before]=await db.batch([
        db.prepare('SELECT gen FROM sync_families WHERE family_id=?1').bind(fam),
        db.prepare('DELETE FROM sync_records WHERE family_id=?1').bind(fam),
        // Deleted child ids belong to the generation they were deleted in: nothing from an earlier generation can write into the
        // new one (membership and ciphertexts are bound to the generation), and a phone that re-joins forks what it holds.
        db.prepare('DELETE FROM sync_children WHERE family_id=?1').bind(fam),
        db.prepare('INSERT INTO sync_families (family_id, gen, verifier, head, record_count, byte_count, created_at) VALUES (?1, ?2, ?3, 0, 0, 0, ?4) ON CONFLICT(family_id) DO UPDATE SET gen=excluded.gen, verifier=excluded.verifier, record_count=0, byte_count=0').bind(fam,gen,verifier,now),
        // The caller proved the family code (the parent), so its own device is (re)enrolled for the new generation. A revoked
        // row is never touched (the WHERE below), whatever happened since the check above.
        db.prepare("INSERT INTO sync_devices (family_id, device_id, status, enrolled_at, seen_day, gen) VALUES (?1, ?2, 'active', ?3, ?4, ?5) ON CONFLICT(family_id, device_id) DO UPDATE SET enrolled_at=excluded.enrolled_at, seen_day=excluded.seen_day, gen=excluded.gen WHERE sync_devices.status='active'").bind(fam,device.deviceId,now,syncDay(now),gen),
        ...syncDevicePrune(db,fam,now)
      ]);
      return reply({v:1,gen,prev:before.results[0]?.gen||'',serverNow:now,tombstones:await syncTombstones(db,fam)});
    }
    const m=await syncMember(db,fam,device.deviceId,b.gen);if(!m.row)return error(m.status,m.code,SYNC_CODE_TEXT[m.code]);
    if(op==='revoke'){
      // Conditioned on the generation this phone was authorized in; the target may be active, inactive or already revoked.
      const r=await db.prepare("UPDATE sync_devices SET status='revoked' WHERE family_id=?1 AND device_id=?2 AND EXISTS (SELECT 1 FROM sync_families WHERE family_id=?1 AND gen=?3)").bind(fam,b.device,m.row.gen).run();
      if(!r.meta?.changes){
        const again=await syncMember(db,fam,device.deviceId,b.gen);if(!again.row)return error(again.status,again.code,SYNC_CODE_TEXT[again.code]);
        return error(404,'device_unknown','device');
      }
      return reply({v:1,revoked:true});
    }
    // delete-child: the child's records are deleted; a tombstone (encrypted by the requesting phone, so other phones can
    // verify it came from a key holder) takes the next sequence number, and the child id never accepts records again.
    // Every statement carries the same guard (this phone is a member of THIS generation; the child is active in it), so
    // the check and the deletion are one atomic step. The child's status flips LAST, and its changed-row count is the
    // outcome: 1 = this request deleted the child; 0 = it did not (a reset, revocation or another deletion got there first).
    const deleted=async()=>{
      const c=await db.prepare('SELECT c.status AS status, t.gen AS tgen FROM sync_children c LEFT JOIN sync_tombstones t ON t.family_id=c.family_id AND t.child_id=c.child_id WHERE c.family_id=?1 AND c.child_id=?2').bind(fam,b.child).first();
      return c;
    };
    const known=await deleted();
    // Already deleted in this generation (a retry after a lost reply, or the same request twice): done, changes nothing.
    if(known?.status==='deleted'&&known.tgen===m.row.gen)return reply({v:1,deleted:true});
    if(known?.status!=='active')return error(404,'child_unknown','child');
    // Deleted ids are kept for the whole generation (a stale phone's retried base must never revive one), up to a bound; a family
    // at the bound starts a new generation (reset), which clears them safely.
    const guard=`${syncMemberSql('?1','?8','?3')} AND EXISTS (SELECT 1 FROM sync_children g WHERE g.family_id=?1 AND g.child_id=?2 AND g.status='active') AND (SELECT COUNT(*) FROM sync_children dc WHERE dc.family_id=?1 AND dc.status='deleted')<?9`;
    const out=await db.batch([
      db.prepare(`DELETE FROM sync_records WHERE family_id=?1 AND child_id=?2 AND ${guard}`).bind(fam,b.child,m.row.gen,b.record.id,b.record.iv,b.record.ct,now,device.deviceId,SYNC_LIMITS.deletedPerGeneration),
      db.prepare(`INSERT OR REPLACE INTO sync_tombstones (family_id, child_id, gen, record_id, iv, ct, deleted_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${guard}`).bind(fam,b.child,m.row.gen,b.record.id,b.record.iv,b.record.ct,now,device.deviceId,SYNC_LIMITS.deletedPerGeneration),
      db.prepare(`INSERT INTO sync_records (family_id, seq, record_id, child_id, kind, received_at, clock_ok, iv, ct) SELECT ?1, head+1, ?4, ?2, 'tombstone', ?7, 1, ?5, ?6 FROM sync_families WHERE family_id=?1 AND gen=?3 AND ${guard} AND NOT EXISTS (SELECT 1 FROM sync_records WHERE family_id=?1 AND record_id=?4)`).bind(fam,b.child,m.row.gen,b.record.id,b.record.iv,b.record.ct,now,device.deviceId,SYNC_LIMITS.deletedPerGeneration),
      db.prepare(`UPDATE sync_families SET head=MAX(head,COALESCE((SELECT MAX(seq) FROM sync_records WHERE family_id=?1),0)),
          record_count=(SELECT COUNT(*) FROM sync_records WHERE family_id=?1), byte_count=(SELECT COALESCE(SUM(LENGTH(ct)),0) FROM sync_records WHERE family_id=?1) WHERE family_id=?1 AND ${guard}`).bind(fam,b.child,m.row.gen,b.record.id,b.record.iv,b.record.ct,now,device.deviceId,SYNC_LIMITS.deletedPerGeneration),
      db.prepare(`UPDATE sync_children SET status='deleted', deleted_at=?7 WHERE family_id=?1 AND child_id=?2 AND ${guard}`).bind(fam,b.child,m.row.gen,b.record.id,b.record.iv,b.record.ct,now,device.deviceId,SYNC_LIMITS.deletedPerGeneration),
      // Tombstones (what a phone that re-joins after a reset verifies) are bounded across generations: the newest 100 are kept.
      // A phone that missed more than 100 and still holds an older child keeps it as a local copy, never shared automatically.
      db.prepare('DELETE FROM sync_tombstones WHERE family_id=?1 AND child_id NOT IN (SELECT child_id FROM sync_tombstones WHERE family_id=?1 ORDER BY deleted_at DESC, child_id LIMIT 100)').bind(fam)
    ]);
    if(out[4].meta?.changes===1)return reply({v:1,deleted:true});
    // Not applied. Say why: the phone's generation or membership changed, the child was deleted meanwhile, or it is unknown.
    const again=await syncMember(db,fam,device.deviceId,b.gen);if(!again.row)return error(again.status,again.code,SYNC_CODE_TEXT[again.code]);
    const now2=await deleted();
    if(now2?.status==='deleted'&&now2.tgen===again.row.gen)return reply({v:1,deleted:true});
    if(now2?.status==='active'){
      const full=Number((await db.prepare("SELECT COUNT(*) AS n FROM sync_children WHERE family_id=?1 AND status='deleted'").bind(fam).first())?.n||0)>=SYNC_LIMITS.deletedPerGeneration;
      if(full)return error(507,'deleted_full','deletedFull');
    }
    return error(404,'child_unknown','child');
  }catch{
    // Content-free: the route name only. Never a body, SQL, id, key or token.
    try{console.log(JSON.stringify({evt:'sync_failure',route,t:Date.now()}));}catch{}
    return error(503,'unavailable');
  }
}
globalThis.SparkSyncWorker={handle:syncHandle,enabled:syncEnabled,family:syncFamily,LIMITS:SYNC_LIMITS};
