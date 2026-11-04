// A disposable, tmpfs-only PostgreSQL check; no storage fleet, proxy or S3 data.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {RenderComputeSpec} from '../../../controller/tenant-compute/src/domain/compute/ComputeSpecification.mjs';
import {Activity} from '../../../controller/tenant-compute/src/domain/compute/Activity.mjs';
import {Lifecycle} from '../../../controller/tenant-compute/src/infrastructure/compute/Lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
process.chdir(root);
const {Client} = createRequire(path.join(root, 'neon/controller/tenant-compute/package.json'))('pg');
const docker = args => execFileSync('docker', args, {encoding: 'utf8', maxBuffer: 1024 * 1024});
const image = process.env.NEON_TELEMETRY_IMAGE || 'klustr-neon-compute:18.6-dev';
const container = 'neon-statement-telemetry-' + randomUUID();
const native = {tenant_id: 'fixture', timeline_id: 'fixture', safekeeper_connstrings: ['fixture:5454'],
  storage_auth_token: 'fixture', cluster: {roles: []}};
const settings = RenderComputeSpec(native, {profile: 'durable'}).cluster.settings;
const setting = name => settings.find(option => option.name === name).value;
const create = fs.readFileSync('neon/runtime/compute_tools/src/sql/create_statement_telemetry.sql', 'utf8');
const insights = fs.readFileSync('neon/runtime/compute_tools/src/sql/collect_statement_insights.sql', 'utf8');
const lifecycle = new Lifecycle({}, {}, async () => {throw Error('Observation must never request wake');});
let observer, bootstrap;
try {
  docker(['run', '--detach', '--name', container, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,size=128m,uid=10001,gid=10001', '--publish', '127.0.0.1::5432', '--entrypoint', '/bin/sh', image,
    '-ec', "printf '%s' disposable-telemetry-only >/tmp/password; /opt/postgres/v18/bin/initdb -D /tmp/data -U cloud_admin --pwfile=/tmp/password --auth-host=scram-sha-256 >/tmp/initdb.log 2>&1; printf '\\nhost all all 0.0.0.0/0 scram-sha-256\\n' >>/tmp/data/pg_hba.conf; exec \"$@\"", '--',
    '/opt/postgres/v18/bin/postgres', '-D', '/tmp/data', '-c', 'listen_addresses=*', '-c', 'shared_buffers=16MB',
    '-c', 'shared_preload_libraries=' + setting('shared_preload_libraries'), '-c', 'compute_query_id=' + setting('compute_query_id'),
    '-c', 'pg_stat_statements.track=' + setting('pg_stat_statements.track'), '-c', 'pg_stat_statements.track_utility=' + setting('pg_stat_statements.track_utility')]);
  const inspect = JSON.parse(docker(['inspect', container]))[0];
  const port = Number(inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  const connect = async (user = 'cloud_admin', database = 'postgres', application_name = 'compute_ctl:collect_insights') => {
    const client = new Client({host: '127.0.0.1', port, user, database, password: 'disposable-telemetry-only', ssl: false, application_name, connectionTimeoutMillis: 1000, query_timeout: 3000});
    try {await client.connect(); return client;} catch (error) {await client.end().catch(() => {}); throw error;}
  };
  const deadline = Date.now() + 15000;
  while (!bootstrap) {
    try {bootstrap = await connect();} catch (error) {if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100));}
  }
  await bootstrap.query(create); await bootstrap.query(create);
  await bootstrap.query("CREATE ROLE neon_lifecycle LOGIN SUPERUSER PASSWORD 'disposable-telemetry-only'; CREATE ROLE app_user LOGIN PASSWORD 'disposable-telemetry-only'");
  await bootstrap.query('CREATE DATABASE app OWNER app_user');
  const appAdmin = await connect('cloud_admin', 'app');
  try {await appAdmin.query(create); await appAdmin.query(create);} finally {await appAdmin.end();}
  const statsDeadline = Date.now() + 3000;
  while (BigInt((await bootstrap.query("SELECT sessions::text FROM pg_stat_database WHERE datname='app'")).rows[0].sessions) < 1n) {
    assert(Date.now() < statsDeadline, 'Setup session statistics must flush before idle observation');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  observer = await connect('neon_lifecycle', 'postgres', 'neon-lifecycle-controller');
  await bootstrap.query('SELECT pg_stat_statements_reset()');
  let now = 0;
  const tracker = new Activity(() => now), endpoint = {suspend: {mode: 'idle', idleSeconds: 1}};
  assert.equal(tracker.observe(await lifecycle.activitySample(observer), endpoint), false);
  const sessionsBefore = (await bootstrap.query("SELECT sessions::text FROM pg_stat_database WHERE datname='postgres'")).rows[0].sessions;
  for (now = 250; now <= 1250; now += 250) {
    const scrape = await connect();
    try {await scrape.query(insights);} finally {await scrape.end();}
    const idle = tracker.observe(await lifecycle.activitySample(observer), endpoint);
    assert.equal(idle, now >= 1000, 'Internal telemetry must not refresh application inactivity');
  }
  const sessionsAfter = (await bootstrap.query("SELECT sessions::text FROM pg_stat_database WHERE datname='postgres'")).rows[0].sessions;
  assert(BigInt(sessionsAfter) > BigInt(sessionsBefore), 'The test must exercise real monitoring session churn');
  // A customer cannot become invisible by spoofing the telemetry application name.
  const business = await connect('app_user');
  try {await business.query('SELECT 42 AS customer_work');} finally {await business.end();}
  assert.equal(tracker.observe(await lifecycle.activitySample(observer), endpoint), false, 'Short-lived customer SQL must reset inactivity');
  now += 1000;
  assert.equal(tracker.observe(await lifecycle.activitySample(observer), endpoint), true);
  const row = (await bootstrap.query(insights)).rows[0].row_to_json;
  assert(row && row.calls > 0, 'Application statement telemetry must be available');
  assert.equal(String(row.userid), String((await bootstrap.query("SELECT oid FROM pg_roles WHERE rolname='app_user'")).rows[0].oid));
  const application = await connect('app_user', 'app');
  try {assert.equal((await application.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='pg_stat_statements'")).rows[0].n, 1);}
  finally {await application.end();}
  const result = {passed: true, image, statementMetrics: true, telemetryDoesNotResetIdle: true,
    spoofedApplicationNameStillActive: true, monitoringSessions: String(BigInt(sessionsAfter) - BigInt(sessionsBefore))};
  if (process.env.NEON_TELEMETRY_REPORT_FILE) fs.writeFileSync(process.env.NEON_TELEMETRY_REPORT_FILE, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} catch (error) {
  const logs = spawnSync('docker', ['logs', container], {encoding: 'utf8'});
  process.stderr.write(((logs.stdout || '') + (logs.stderr || '')).split('\n').slice(-35).join('\n'));
  throw error;
} finally {
  await observer?.end().catch(() => {}); await bootstrap?.end().catch(() => {});
  spawnSync('docker', ['rm', '--force', container], {stdio: 'ignore'});
}
