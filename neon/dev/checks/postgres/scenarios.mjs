// Extended local qualification. Every mutable volume/container is created here.
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {sourceProvenance} from '../../shared/source-provenance.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
process.chdir(root);
const version=readFileSync('configure.ac','utf8').match(/AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]/)[1];
const image=process.env.PG_IMAGE || `klustr-postgres:${version}-dev`;
const run=`klustr-pg18-scenarios-${Date.now()}-${randomBytes(3).toString('hex')}`;
const network=`${run}-net`;
const reports=path.resolve(process.env.REPORT_DIR || 'neon/tests/reports/local','scenarios',run);
mkdirSync(reports,{recursive:true});
mkdirSync('build/scenario-secrets',{recursive:true});
const secretDir=mkdtempSync(path.resolve('build/scenario-secrets/run-'));
const secretFile=path.join(secretDir,'password');
const password=randomBytes(24).toString('hex');
const alternative=randomBytes(24).toString('hex');
writeFileSync(secretFile,password+'\n',{mode:0o444});
const user='qualification_admin', database='qualification';
const env={...process.env,PGPASSWORD:password,PGUSER:user,PGDATABASE:database,PGHOST:'127.0.0.1',
  PGCONNECT_TIMEOUT:'5',POSTGRES_PASSWORD:password};
const volumes=new Set(), servers=new Set(), children=new Set();
const names=['password-file initialization','connection admission and recovery','bounded tablespace disk full',
  'three crashes during acknowledged writes','physical backup and manifest verification','logical dump and restore',
  'physical standby replay and read-only behavior','synchronous commit blocks then resumes',
  'fenced asynchronous promotion and pg_rewind rejoin','existing-volume credential preservation','wrong-major startup rejection'];
const cases=names.map(name=>({name,status:'SKIP',reason:'Not reached'}));
const metadata={run,image,network,credential_file:secretFile,postgresql_version:version,source:sourceProvenance(),cases};
let completed=false, cleanupFailed=false, commandId=0;
const scrub=text=>String(text ?? '').replaceAll(password,'[REDACTED]').replaceAll(alternative,'[REDACTED]');
function save() {
  writeFileSync(path.join(reports,'results.json'),JSON.stringify({...metadata,status:completed?'PASS':cleanupFailed||cases.some(row=>row.status==='FAIL')?'FAIL':'INCOMPLETE',
    retained_volumes:[...volumes],retained_containers:[...servers]},null,2)+'\n');
}
function record(args,result) {
  const id=String(++commandId).padStart(4,'0');
  writeFileSync(path.join(reports,`${id}.log`),scrub((result.stdout || '')+'\n'+(result.stderr || '')));
  appendFileSync(path.join(reports,'commands.jsonl'),JSON.stringify({id,args,exit_code:result.status,log:`${id}.log`})+'\n');
}
function raw(args,options={}) {
  const r=spawnSync(process.env.DOCKER || 'docker',args,{env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:180000,...options});
  record(args,r);
  if(r.error) throw r.error;
  return r;
}
function docker(args,options={}) {
  const r=raw(args,options);
  assert.equal(r.status,0,scrub(r.stderr+'\n'+r.stdout));
  return (args[0]==='logs' ? r.stdout+r.stderr : r.stdout).trim();
}
function sqlArgs(server,db=database,login=user) {
  return ['exec','-i','-e','PGPASSWORD','-e','PGCONNECT_TIMEOUT',server,'psql','-XAt','-h','127.0.0.1',
    '-U',login,'-d',db,'-v','ON_ERROR_STOP=1','-f','-'];
}
function sql(server,text,db=database) {return docker(sqlArgs(server,db),{input:text});}
function sqlFailure(server,text,pattern,login=user,options={}) {
  const r=raw(sqlArgs(server,database,login),{input:text,...options});
  assert.notEqual(r.status,0,'Expected SQL/connection failure');
  assert(pattern.test(r.stderr),scrub(r.stderr));
  return {exit_code:r.status,message:scrub(r.stderr.trim())};
}
function task(server,text,application,login=user) {
  const args=sqlArgs(server,database,login);
  args.splice(2,0,'-e',`PGAPPNAME=${application}`);
  const child=spawn(process.env.DOCKER || 'docker',args,{env,stdio:['pipe','pipe','pipe']});
  children.add(child);
  const state={stdout:'',stderr:'',acknowledged:[]};
  child.stdout.on('data',chunk=>{
    state.stdout+=chunk;
    state.acknowledged=[...state.stdout.matchAll(/^ACK (\d+)\r?$/gm)].map(match=>Number(match[1]));
  });
  child.stderr.on('data',chunk=>{state.stderr+=chunk;});
  state.done=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',status=>{state.status=status;children.delete(child);record(args,{...state,status});resolve({...state,status});});
  });
  child.stdin.on('error',error=>{if(error.code!=='EPIPE') state.stderr+=String(error);});
  child.stdin.end(text);
  return state;
}
async function until(predicate,message,seconds=45) {
  const end=performance.now()+seconds*1000;
  while(performance.now()<end) {
    if(predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error(message);
}
function volume(suffix) {
  const name=`${run}-${suffix}`;
  docker(['volume','create','--label',`io.klustr.qualification=${run}`,name]);volumes.add(name);return name;
}
function mount(name,target='/var/lib/postgresql/data',readonly=false) {
  assert(volumes.has(name),'Only volumes created by this run may be used');
  return ['--mount',`type=volume,source=${name},target=${target}${readonly?',readonly':''}`];
}
const serverFlags=['postgres','-c','wal_level=logical','-c','wal_log_hints=on','-c','shared_buffers=64MB',
  '-c','max_connections=30','-c','wal_keep_size=64MB','-c','max_wal_size=256MB','-c','min_wal_size=32MB',
  '-c','wal_sender_timeout=5s','-c','wal_receiver_timeout=5s','-c','wal_retrieve_retry_interval=500ms'];
function server(suffix,data,{file=false,changedPassword=false}={}) {
  const name=`${run}-${suffix}`;
  const credentials=file ? ['-e','POSTGRES_PASSWORD_FILE=/run/qualification-password',
    '--mount',`type=bind,source=${secretFile},target=/run/qualification-password,readonly`] : ['-e','POSTGRES_PASSWORD'];
  docker(['run','-d','--name',name,'--label',`io.klustr.qualification=${run}`,'--network',network,
    '--cpus','2','--memory','768m','--shm-size','128m',
    '--tmpfs','/qualification-tablespace:rw,size=16m,uid=10001,gid=10001,mode=0700',
    '-e',`POSTGRES_USER=${user}`,'-e',`POSTGRES_DB=${database}`,...credentials,...mount(data),image,...serverFlags],
    changedPassword?{env:{...env,POSTGRES_PASSWORD:alternative}}:{});
  servers.add(name);return name;
}
async function ready(name) {
  await until(()=>{
    const state=JSON.parse(docker(['inspect','--format','{{json .State}}',name]));
    assert(state.Running,`${name} exited: ${scrub(docker(['logs',name]))}`);
    return state.Health?.Status==='healthy';
  },`${name} not healthy`,90);
  assert.equal(sql(name,'SELECT 1;'),'1');
}
function stop(name) {
  assert(servers.has(name));
  docker(['stop','--timeout','60',name]);
  assert.equal(docker(['inspect','--format','{{.State.Running}}',name]),'false');
}
async function scenario(name,body) {
  const row=cases.find(row=>row.name===name);assert(row);
  const started=performance.now();row.started_at=new Date().toISOString();delete row.reason;
  try {row.evidence=await body();row.status='PASS';}
  catch(error) {row.status='FAIL';row.error=scrub(error.stack);throw error;}
  finally {row.duration_seconds=(performance.now()-started)/1000;save();console.log(`${row.status}: ${name}`);}
}
function marker(id) {
  assert(Number.isSafeInteger(id));
  return `BEGIN; INSERT INTO ledger VALUES (${id},repeat(md5('${id}'),300)); UPDATE balance SET value=value+1; COMMIT;`;
}
function fingerprint(name,db=database) {
  return JSON.parse(sql(name,"SELECT json_build_object('rows',count(*),'payload_hash',md5(string_agg(id::text||md5(payload),',' ORDER BY id)),'balance',(SELECT value FROM balance)) FROM ledger;",db));
}
function integrity(name,db=database) {
  assert.equal(sql(name,"SELECT count(*) FROM ledger WHERE payload<>repeat(md5(id::text),300);",db),'0');
  const f=fingerprint(name,db);assert.equal(f.rows,f.balance);
  sql(name,"SELECT public.bt_index_check('ledger_pkey'::regclass,true);",db);
  return f;
}
function client(args,host,attachments=[],options={}) {
  return docker(['run','--rm','--network',network,'-e','PGPASSWORD','-e',`PGUSER=${user}`,
    '-e',`PGHOST=${host}`,'-e',`PGDATABASE=${database}`,...attachments,image,...args],options);
}
let primary,standby,logical;
try {
  const details=JSON.parse(docker(['image','inspect',image]))[0];
  assert.equal(details.Config.Labels['io.klustr.source.patch-sha256'],metadata.source.sha256);
  metadata.image_id=details.Id;
  docker(['network','create','--internal','--label',`io.klustr.qualification=${run}`,network]);save();
  const primaryData=volume('primary-data');
  await scenario(names[0],async()=>{
    primary=server('primary',primaryData,{file:true});await ready(primary);
    assert.equal(sql(primary,'SELECT current_user; SELECT current_database();'),`${user}\n${database}`);
    assert.equal(sql(primary,"SELECT rm_name FROM pg_get_wal_resource_managers() WHERE rm_id=134;"),'neon');
    const bad=sqlFailure(primary,'SELECT 1;',/password authentication failed/,user,{env:{...env,PGPASSWORD:alternative}});
    sql(primary,'CREATE EXTENSION amcheck; CREATE TABLE ledger(id bigint PRIMARY KEY,payload text NOT NULL); ALTER TABLE ledger ALTER payload SET STORAGE EXTERNAL; CREATE TABLE balance(value bigint NOT NULL); INSERT INTO balance VALUES(0);');
    sql(primary,marker(1));return {wrong_password:bad,system_identifier:sql(primary,'SELECT system_identifier FROM pg_control_system();')};
  });
  await scenario(names[1],async()=>{
    sql(primary,`CREATE ROLE qualification_limited LOGIN CONNECTION LIMIT 2 PASSWORD '${password}';`);
    const sessions=[0,1].map(i=>task(primary,'SELECT pg_sleep(90);',`qualification-limited-${i}`,'qualification_limited'));
    await until(()=>sql(primary,"SELECT count(*) FROM pg_stat_activity WHERE usename='qualification_limited';")==='2','limited sessions did not connect');
    const rejected=sqlFailure(primary,'SELECT 1;',/too many connections for role/, 'qualification_limited');
    sql(primary,"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='qualification_limited';");
    await Promise.all(sessions.map(s=>s.done));
    assert.equal(docker(sqlArgs(primary,database,'qualification_limited'),{input:'SELECT 1;'}),'1');
    sql(primary,'DROP ROLE qualification_limited;');return rejected;
  });
  await scenario(names[2],async()=>{
    const before=integrity(primary);
    sql(primary,"CREATE TABLESPACE qualification_bounded LOCATION '/qualification-tablespace'; CREATE TABLE disk_pressure(id int,payload text) TABLESPACE qualification_bounded; ALTER TABLE disk_pressure ALTER payload SET STORAGE EXTERNAL;");
    const rejected=sqlFailure(primary,"INSERT INTO disk_pressure SELECT i,repeat(md5(i::text),300) FROM generate_series(1,10000) i;",/No space left on device/);
    assert.equal(sql(primary,'SELECT count(*) FROM disk_pressure;'),'0');
    assert.deepEqual(integrity(primary),before);
    sql(primary,'DROP TABLE disk_pressure; DROP TABLESPACE qualification_bounded;');
    return {bounded_tmpfs_bytes:16*1024*1024,expected_error:rejected,unaffected_data:before};
  });
  await scenario(names[3],async()=>{
    const cycles=[];
    for(let cycle=1;cycle<=3;cycle++) {
      sql(primary,'CHECKPOINT;');
      const pending=task(primary,'BEGIN; INSERT INTO ledger VALUES(-1,\'uncommitted\'); SELECT pg_sleep(90);','qualification-uncommitted');
      await until(()=>sql(primary,"SELECT count(*) FROM pg_stat_activity WHERE application_name='qualification-uncommitted' AND wait_event='PgSleep';")==='1','uncommitted transaction did not reach barrier');
      const writers=Array.from({length:4},(_,worker)=>task(primary,
        "SET wal_consistency_checking='all';\n"+Array.from({length:100},(_,n)=>{
          const id=cycle*100000+worker*1000+n+1;
          return marker(id)+`\n\\echo ACK ${id}\nSELECT pg_sleep(0.02);\n`;
        }).join(''),'qualification-writer'));
      await until(()=>{
        for(const writer of writers) assert.equal(writer.status,undefined,scrub(writer.stderr));
        return writers.reduce((n,w)=>n+w.acknowledged.length,0)>=24;
      },'writers did not acknowledge enough commits');
      docker(['kill','--signal','SIGKILL',primary]);
      const killed=JSON.parse(docker(['inspect','--format','{{json .State}}',primary]));
      assert.equal(killed.ExitCode,137);assert.equal(killed.OOMKilled,false);
      const results=await Promise.all(writers.map(w=>w.done));await pending.done;
      const acknowledged=results.flatMap(w=>w.acknowledged);
      assert(acknowledged.length>=24);
      for(const writer of results) {
        // docker exec clients live in the container and are killed with it.
        if(writer.status!==0 && writer.status!==137) assert(/server closed the connection|connection to server was lost|SSL SYSCALL|could not receive data|terminating connection/i.test(writer.stderr),scrub(writer.stderr));
      }
      docker(['start',primary]);await ready(primary);
      assert.equal(Number(sql(primary,`SELECT count(*) FROM ledger WHERE id=ANY(ARRAY[${acknowledged.join(',')}]::bigint[]);`)),acknowledged.length);
      assert.equal(sql(primary,'SELECT count(*) FROM ledger WHERE id=-1;'),'0');
      cycles.push({cycle,acknowledged:acknowledged.length,recovered:integrity(primary)});
    }
    return {cycles,rule:'All acknowledged commits present; unacknowledged commits may also have reached WAL. Uncommitted sentinel absent.'};
  });
  const backupData=volume('physical-backup'),standbyData=volume('standby-data'),archiveData=volume('logical-archive'),logicalData=volume('logical-data');
  let backedUp;
  await scenario(names[4],async()=>{
    backedUp=integrity(primary);
    client(['pg_basebackup','--pgdata=/var/lib/postgresql/data/pgdata','--wal-method=stream','--checkpoint=fast','--write-recovery-conf','--manifest-checksums=SHA256'],primary,mount(backupData));
    client(['pg_verifybackup','/var/lib/postgresql/data/pgdata'],primary,mount(backupData,'/var/lib/postgresql/data',true));
    return {backup_volume:backupData,manifest_verified:true,data:backedUp};
  });
  await scenario(names[5],async()=>{
    client(['pg_dump','--format=custom','--file=/var/lib/postgresql/data/qualification.dump',`--dbname=${database}`],primary,mount(archiveData));
    logical=server('logical',logicalData);await ready(logical);
    client(['pg_restore','--exit-on-error','--no-owner','--no-privileges',`--dbname=${database}`,'/var/lib/postgresql/data/qualification.dump'],logical,mount(archiveData,'/var/lib/postgresql/data',true));
    assert.deepEqual(integrity(logical),backedUp);return {archive_volume:archiveData,restored_data:backedUp};
  });
  await scenario(names[6],async()=>{
    docker(['run','--rm','--network','none','--entrypoint','sh',...mount(backupData,'/backup',true),...mount(standbyData),image,'-c','cp -a /backup/pgdata /var/lib/postgresql/data/pgdata']);
    standby=server('standby',standbyData);await ready(standby);
    assert.equal(sql(standby,'SELECT pg_is_in_recovery();'),'t');
    assert.deepEqual(integrity(standby),backedUp);
    const rejected=sqlFailure(standby,'INSERT INTO balance VALUES(99);',/read-only transaction/);
    sql(primary,marker(9000000));
    await until(()=>sql(standby,'SELECT count(*) FROM ledger WHERE id=9000000;')==='1','standby failed to replay marker');
    return {read_only_error:rejected,replayed:integrity(standby)};
  });
  await scenario(names[7],async()=>{
    sql(primary,"ALTER SYSTEM SET synchronous_standby_names='*'; SELECT pg_reload_conf();");
    await until(()=>sql(primary,"SELECT count(*) FROM pg_stat_replication WHERE sync_state='sync';")==='1','standby did not become synchronous');
    sql(primary,'SET synchronous_commit=remote_apply; '+marker(9100000));
    assert.equal(sql(standby,'SELECT count(*) FROM ledger WHERE id=9100000;'),'1');
    docker(['network','disconnect',network,standby]);
    const writer=task(primary,'SET synchronous_commit=remote_apply; '+marker(9100001)+'\n\\echo ACK 9100001\n','qualification-sync-blocked');
    await until(()=>sql(primary,"SELECT count(*) FROM pg_stat_activity WHERE application_name='qualification-sync-blocked' AND wait_event='SyncRep';")==='1','commit did not wait for synchronous replication');
    assert.equal(writer.acknowledged.length,0);
    docker(['network','connect',network,standby]);
    await until(()=>writer.acknowledged.length===1,'synchronous writer did not resume after reconnect',60);
    assert.equal((await writer.done).status,0);
    assert.equal(sql(standby,'SELECT count(*) FROM ledger WHERE id=9100001;'),'1');
    sql(primary,"ALTER SYSTEM RESET synchronous_standby_names; SELECT pg_reload_conf();");
    await until(()=>sql(primary,'SHOW synchronous_standby_names;')==='','synchronous mode not reset');
    return {blocked_without_ack:true,ack_after_remote_apply:true};
  });
  await scenario(names[8],async()=>{
    assert.deepEqual(integrity(primary),integrity(standby));
    docker(['network','disconnect',network,standby]);
    sql(primary,marker(9200000));sql(primary,'CHECKPOINT;');stop(primary);
    docker(['exec',standby,'pg_ctl','-D','/var/lib/postgresql/data/pgdata','-w','promote']);
    assert.equal(sql(standby,'SELECT pg_is_in_recovery();'),'f');
    assert.equal(sql(standby,'SELECT count(*) FROM ledger WHERE id=9200000;'),'0','asynchronous partition must leave the old-only marker absent');
    sql(standby,marker(9200001));sql(standby,'CHECKPOINT;');docker(['network','connect',network,standby]);
    client(['pg_rewind','--target-pgdata=/var/lib/postgresql/data/pgdata',`--source-server=host=${standby} user=${user} dbname=${database}`,'--write-recovery-conf'],standby,mount(primaryData));
    docker(['start',primary]);await ready(primary);
    assert.equal(sql(primary,'SELECT pg_is_in_recovery();'),'t');
    await until(()=>sql(primary,'SELECT count(*) FROM ledger WHERE id=9200001;')==='1','rewound standby failed to catch up');
    assert.equal(sql(primary,'SELECT count(*) FROM ledger WHERE id=9200000;'),'0');
    assert.deepEqual(integrity(primary),integrity(standby));
    return {old_primary_fenced_before_promotion:true,old_only_marker_lost_as_expected:true,new_marker_replayed:true,
      implication:'Asynchronous promotion can lose acknowledged but unreplicated writes. Synchronous policy and fencing are required for an RPO=0 design.'};
  });
  await scenario(names[9],async()=>{
    const before=integrity(logical),id=sql(logical,'SELECT system_identifier FROM pg_control_system();');stop(logical);
    const reused=server('reused',logicalData,{changedPassword:true});await ready(reused);
    assert.deepEqual(integrity(reused),before);assert.equal(sql(reused,'SELECT system_identifier FROM pg_control_system();'),id);
    const rejected=sqlFailure(reused,'SELECT 1;',/password authentication failed/,user,{env:{...env,PGPASSWORD:alternative}});
    assert(!docker(['logs',reused]).includes('Database initialization complete.'));stop(reused);
    return {system_identifier:id,original_password_preserved:true,environment_change_did_not_rotate_credentials:rejected};
  });
  await scenario(names[10],async()=>{
    docker(['run','--rm','--network','none','--entrypoint','sh',...mount(logicalData),image,'-c',"cp /var/lib/postgresql/data/pgdata/PG_VERSION /var/lib/postgresql/data/pgdata/PG_VERSION.scenario-original; printf '17\\n' > /var/lib/postgresql/data/pgdata/PG_VERSION"]);
    const wrong=server('wrong-major',logicalData);
    await until(()=>docker(['inspect','--format','{{.State.Running}}',wrong])==='false','wrong-major server did not reject startup');
    const log=docker(['logs',wrong]);assert(/database files are incompatible with server/.test(log),scrub(log));
    assert(!log.includes('Database initialization complete.'));
    docker(['run','--rm','--network','none','--entrypoint','sh',...mount(logicalData),image,'-c','cp /var/lib/postgresql/data/pgdata/PG_VERSION.scenario-original /var/lib/postgresql/data/pgdata/PG_VERSION']);
    docker(['start',logical]);await ready(logical);assert.deepEqual(integrity(logical),backedUp);
    return {rejected_without_reinitialization:true,original_data_restored_and_verified:true};
  });
  completed=true;
} catch(error) {
  console.error(scrub(error.stack));process.exitCode=1;
} finally {
  for(const name of servers) {
    try {
      if(docker(['inspect','--format','{{.State.Running}}',name])==='true') stop(name);
      const logs=docker(['logs',name]);
      writeFileSync(path.join(reports,`${name}.log`),scrub(logs));
      assert(!/PANIC:|Segmentation fault/i.test(logs),`Unexpected crash in ${name}`);
    } catch(error) {completed=false;cleanupFailed=true;process.exitCode=1;console.error(scrub(error.stack));}
  }
  for(const child of children) child.kill();
  save();console.log(`Reports: ${reports}. Dedicated data volumes and stopped containers retained; main development service was not used.`);
}
