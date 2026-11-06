// Crash only a newly created, dedicated container/volume; retain all evidence.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const reports=process.env.REPORT_DIR || 'neon/tests/reports/local';
const settings=Object.fromEntries(readFileSync('neon/dev/.env','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split('=')));
const version=readFileSync('configure.ac','utf8').match(/AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]/)[1];
const image=process.env.PG_IMAGE || `klustr-postgres:${version}-dev`;
const name=`klustr-pg18-qualification-recovery-${Date.now()}`;
const volume=`${name}-data`;
const env={...process.env,POSTGRES_PASSWORD:settings.POSTGRES_PASSWORD,PGPASSWORD:settings.POSTGRES_PASSWORD};
function docker(args) {
  const r=spawnSync(process.env.DOCKER || 'docker',args,{env,encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(r.status,0,r.stderr);
  return (args[0]==='logs' ? r.stdout+r.stderr : r.stdout).trim();
}
async function ready() {
  for(let i=0;i<45;i++) {
    const state=JSON.parse(docker(['inspect','--format','{{json .State}}',name]));
    assert.equal(state.Running,true,`Isolated server exited: ${docker(['logs',name])}`);
    if(state.Health.Status==='healthy') return;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Isolated server did not reach healthy status within 45 seconds');
}
function sql(query) {
  return docker(['exec','-e','PGPASSWORD',name,'psql','-XAt','-h','127.0.0.1','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',query]);
}
let started=false;
try {
  docker(['volume','create','--label','io.klustr.qualification=recovery',volume]);
  docker(['run','-d','--name',name,'--network','none','--cpus','1','--memory','512m','-e','POSTGRES_PASSWORD',
    '--mount',`type=volume,source=${volume},target=/var/lib/postgresql/data`,image]);
  started=true;
  await ready();
  sql('CREATE TABLE qualification_crash_marker(id int PRIMARY KEY); CHECKPOINT;');
  sql('INSERT INTO qualification_crash_marker VALUES (42);');
  docker(['kill','--signal','SIGKILL',name]);
  docker(['start',name]);
  await ready();
  assert.equal(sql('SELECT id FROM qualification_crash_marker;'),'42');
  docker(['stop','--timeout','60',name]);
  console.log('Isolated OCI crash recovery passed.');
} finally {
  if(started) writeFileSync(`${reports}/oci-crash-recovery-server.log`,docker(['logs',name]));
  writeFileSync(`${reports}/oci-crash-recovery.json`,JSON.stringify({container:name,volume,image,retained:true},null,2)+'\n');
  console.log(`Dedicated recovery container ${name} and volume ${volume} retained; main development volume was not used.`);
}
