// Cross-platform Docker Desktop / Linux qualification driver. Never logs secrets.
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {sourceProvenance} from '../../shared/source-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
process.chdir(root);
const version = readFileSync('configure.ac','utf8').match(/AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]/)[1];
const revision = spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
const local = Object.fromEntries(readFileSync('neon/dev/.env', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const env = {...process.env, PGPASSWORD: local.POSTGRES_PASSWORD, PGUSER: local.POSTGRES_USER,
  PGDATABASE: local.POSTGRES_DB};
const image = process.env.PG_IMAGE || `klustr-postgres:${version}-dev`;
env.PG_IMAGE = image;
const compose = ['compose', '--env-file','neon/dev/.env','-f', 'neon/dev/operations/docker/compose.yaml'];
const reports = process.env.REPORT_DIR || 'neon/tests/reports/local';
mkdirSync(reports, {recursive: true});

function docker(args, options = {}) {
  const r = spawnSync(process.env.DOCKER || 'docker', args, {env, encoding: 'utf8', maxBuffer: 64*1024*1024, ...options});
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 5).join(' ')}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
function sql(statement, database = env.PGDATABASE) {
  return docker([...compose, 'exec', '-T', '-e', 'PGPASSWORD', '-e', 'PGUSER', '-e', `PGDATABASE=${database}`,
    '-e', 'PGHOST=127.0.0.1', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], {input: statement});
}
function containerId() { return docker([...compose, 'ps', '-q', 'postgres']); }
function healthy() {
  assert.equal(sql('SELECT 1; SELECT pg_is_in_recovery();'), '1\nf');
  assert.equal(JSON.parse(docker(['inspect', '--format', '{{json .State.Health.Status}}', containerId()])), 'healthy');
}
function logs() { return docker([...compose, 'logs', '--no-color', 'postgres']); }
function noCrashes(output) {
  assert(!/PANIC:|Segmentation fault|terminated by signal|database system was interrupted|WAL.*ERROR|storage.*ERROR/i.test(output), output.slice(-6000));
  const unexpectedFatal = output.split('\n').filter(line => line.includes('FATAL:') &&
    !/password authentication failed|terminating connection due to administrator command/.test(line));
  assert.equal(unexpectedFatal.length,0,unexpectedFatal.join('\n'));
}

const action = process.argv[2];
if (action === 'entrypoint-check') {
  const cases = [
    {args:['run','--rm','--network','none',image,'postgres'],message:'POSTGRES_PASSWORD or POSTGRES_PASSWORD_FILE is required'},
    {args:['run','--rm','--network','none','--user','0',image,'postgres'],message:'must run as a non-root user'},
    {args:['run','--rm','--network','none','-e','POSTGRES_PASSWORD=unused-test-value','-e','POSTGRES_PASSWORD_FILE=/absent',image,'postgres'],message:'Set PASSWORD or PASSWORD_FILE, not both'},
    {args:['run','--rm','--network','none','--entrypoint','sh',image,'-c','mkdir /tmp/nonempty; touch /tmp/nonempty/existing; PGDATA=/tmp/nonempty exec /usr/local/bin/pg-entrypoint postgres'],message:'Refusing to initialize a nonempty directory'},
  ];
  for (const item of cases) {
    const result=spawnSync(process.env.DOCKER || 'docker',item.args,{env,encoding:'utf8'});
    assert.equal(result.status,1);
    assert((result.stderr || '').includes(item.message),result.stderr);
    console.log(`Correctly rejected: ${item.message}`);
  }
} else if (action === 'signals') {
  for (const signal of ['SIGTERM','SIGINT']) {
    docker(['stop','--signal',signal,'--time','60',containerId()]);
    assert(logs().includes('database system is shut down'));
    docker([...compose,'up','-d','--wait','--wait-timeout','120']);
    healthy();
    noCrashes(logs());
    console.log(`${signal}: clean shutdown and healthy restart verified.`);
  }
  writeFileSync(path.join(reports,'signal-server.log'),logs());
} else if (action === 'up') {
  docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120']);
  healthy();
  console.log('Compose server healthy.');
} else if (action === 'image-check') {
  const details = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(details.Architecture, 'amd64');
  assert.equal(details.Config.User, '10001:10001');
  assert.equal(details.Config.Labels['org.opencontainers.image.revision'], process.env.SOURCE_REVISION || revision);
  assert.equal(details.Config.Labels['io.klustr.source.patch-sha256'],sourceProvenance().sha256);
  assert.equal(docker(['run', '--rm', image, 'postgres', '--version']), `postgres (PostgreSQL) ${version}`);
  assert.equal(docker(['run', '--rm', image, 'id', '-u']), '10001');
  console.log(docker(['run', '--rm', image, 'sh', '-c', 'sha256sum -c /opt/postgres/share/qualification/postgres.sha256; cat /opt/postgres/share/qualification/source-revision; pg_config --configure; ldd /opt/postgres/bin/postgres']));
  const libs = docker(['run', '--rm', image, 'sh', '-c', 'find /opt/postgres/bin /opt/postgres/lib -type f -exec sh -c \'for f do case "$(head -c 4 "$f")" in *ELF*) ldd "$f";; esac; done\' sh {} +']);
  assert(!libs.includes('not found'));
  writeFileSync(path.join(reports, 'image.json'), JSON.stringify(details, null, 2));
  writeFileSync(path.join(reports, 'image-libraries.log'), libs);
  console.log(`Image ${details.Id}: amd64, non-root, fork revision and libraries verified.`);
} else if (action === 'smoke') {
  console.log(sql(readFileSync('neon/tests/smoke/smoke.sql', 'utf8')));
  const result = docker(['run', '--rm', '--network', 'klustr-pg18-dev_default',
    '-e', 'PGPASSWORD', '-e', 'PGUSER', '-e', 'PGDATABASE', '-e', 'PGHOST=postgres', image,
    'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1;']);
  assert.equal(result, '1');
  healthy();
  console.log('Authenticated in-container and separate network-client SQL passed.');
} else if (action === 'integration') {
  const target = path.resolve(reports);
  console.log(docker(['run','--rm','--network','klustr-pg18-dev_default',
    '-e','PGPASSWORD','-e','PGUSER','-e','PGDATABASE','-e','PGHOST=postgres','-e',`PG_EXPECTED_VERSION=${version}`,
    '--mount',`type=bind,source=${target},target=/reports`,
    process.env.PG_TEST_IMAGE || `klustr-postgres:${version}-test`,
    'python3','-m','pytest','-v','--tb=short','/source/tests/integration','--junitxml=/reports/integration-container.xml']));
} else if (action === 'persistence') {
  const table = `qualification_marker_${Date.now()}`;
  sql(`CREATE TABLE ${table}(id int PRIMARY KEY,value text); INSERT INTO ${table} VALUES (42,'persisted');`);
  const systemId = sql('SELECT system_identifier FROM pg_control_system();');
  const before = (logs().match(/Database initialization complete\./g) || []).length;
  docker([...compose, 'stop', '-t', '60', 'postgres']);
  assert(logs().includes('database system is shut down'));
  docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120']);
  assert.equal(sql(`SELECT id,value FROM ${table};`), '42|persisted');
  assert.equal(sql('SELECT system_identifier FROM pg_control_system();'), systemId);
  assert.equal((logs().match(/Database initialization complete\./g) || []).length, before);
  noCrashes(logs());
  sql(`DROP TABLE ${table};`);
  healthy();
  writeFileSync(path.join(reports, 'persistence-server.log'), logs());
  console.log(`Persistence and graceful shutdown passed; cluster ${systemId} retained, no reinitialization.`);
} else if (action === 'benchmark' || action === 'benchmark-smoke') {
  const runningImage=docker(['inspect','--format','{{.Image}}',containerId()]);
  const taggedImage=docker(['image','inspect','--format','{{.Id}}',image]);
  assert.equal(runningImage,taggedImage,'Recreate the service before benchmarking a rebuilt image.');
  writeFileSync(path.join(reports,'benchmark-environment.json'),JSON.stringify({image,image_id:runningImage,
    container_id:containerId(),source:sourceProvenance(),binary:docker(['exec',containerId(),'sha256sum','/opt/postgres/bin/postgres'])},null,2)+'\n');
  const database = `qualification_bench_${Date.now()}`;
  sql(`CREATE DATABASE ${database};`);
  const exec = ['exec', '-e', 'PGPASSWORD', '-e', 'PGUSER', '-e', `PGDATABASE=${database}`, '-e', 'PGHOST=127.0.0.1', containerId()];
  console.log(docker([...exec, 'pgbench', '--version']));
  console.log(docker([...exec, 'pgbench', '-i', '-s', '10']));
  const scenarios = action === 'benchmark-smoke' ? [['smoke', 4, 2, 10, false]] :
    [['A', 10, 2, 60, false], ['B', 32, 8, 120, true], ['C', 64, 8, 300, false], ['D', 32, 8, 600, false]];
  const results = [];
  const sampler = spawn(process.execPath, ['neon/dev/reporting/sample-resources.mjs',containerId(),path.join(reports,'pgbench-resources.jsonl')], {env,stdio:'ignore'});
  try {
  for (const [name, clients, jobs, duration, readOnly] of scenarios) {
    const started = new Date();
    const startClock = performance.now();
    const before = sql('SELECT row_to_json(s) FROM (SELECT (SELECT row_to_json(w) FROM pg_stat_wal w) wal,(SELECT row_to_json(c) FROM pg_stat_checkpointer c) checkpoints) s;', database);
    // spawnSync permits the pgbench process to finish; an independent sampler
    // records resource usage while it runs, rather than estimating percentiles.
    const logfile = `/tmp/qualification_pgbench_${name}_${Date.now()}`;
    const args = [...exec, 'pgbench', '-c', String(clients), '-j', String(jobs), '-T', String(duration), '-P', '10',
      '-l', '--sampling-rate=0.01', `--log-prefix=${logfile}`, ...(readOnly ? ['-S'] : [])];
    console.log(`Starting scenario ${name}: clients=${clients}, jobs=${jobs}, seconds=${duration}`);
    const r = spawnSync(process.env.DOCKER || 'docker', args, {env, encoding: 'utf8', maxBuffer: 32*1024*1024});
    const output = `${r.stdout || ''}\n${r.stderr || ''}`;
    writeFileSync(path.join(reports, `pgbench-${name}.log`), output);
    assert.equal(r.status, 0, output);
    const failed = output.match(/number of failed transactions:\s*(\d+)/);
    assert(failed && Number(failed[1]) === 0, output);
    const tps = output.match(/tps = ([\d.]+)/);
    const latency = output.match(/latency average = ([\d.]+)/);
    const samples = docker(['exec', containerId(), 'sh', '-c', `cat ${logfile}.*`]);
    const values = samples.split('\n').filter(Boolean).map(line => Number(line.trim().split(/\s+/)[2])/1000).sort((a,b)=>a-b);
    assert(values.length > 0);
    const percentile = p => values[Math.min(values.length-1, Math.ceil(values.length*p)-1)];
    const after = sql('SELECT row_to_json(s) FROM (SELECT (SELECT row_to_json(w) FROM pg_stat_wal w) wal,(SELECT row_to_json(c) FROM pg_stat_checkpointer c) checkpoints) s;', database);
    healthy();
    noCrashes(logs());
    const metrics = {scenario:name, clients,jobs,requested_seconds:duration, started_at:started.toISOString(),
      completed_at:new Date().toISOString(), duration_seconds:(performance.now()-startClock)/1000,
      tps:Number(tps[1]), latency_average_ms:Number(latency[1]), failed_transactions:Number(failed[1]),
      sampled_transactions:values.length, sample_rate:0.01, sampled_p50_ms:percentile(.5),sampled_p95_ms:percentile(.95),sampled_p99_ms:percentile(.99),
      before:JSON.parse(before),after:JSON.parse(after)};
    results.push(metrics);
    writeFileSync(path.join(reports, 'pgbench.json'), JSON.stringify(results,null,2));
    console.log(JSON.stringify(metrics));
  }
  } finally { sampler.kill(); }
  writeFileSync(path.join(reports, 'pgbench-server.log'), logs());
  console.log(`Completed all workloads; dedicated database ${database} retained for inspection.`);
} else if (action === 'down') {
  docker([...compose, 'down']);
  console.log('Stopped; named data volume retained.');
} else {
  throw new Error('Expected up, image-check, entrypoint-check, signals, smoke, persistence, integration, benchmark, benchmark-smoke or down');
}
