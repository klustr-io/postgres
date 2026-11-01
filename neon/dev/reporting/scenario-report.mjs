// Produce a reviewable summary from one explicit, completed scenario run.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const input=path.resolve(process.argv[2] || '');
assert(input.endsWith('results.json'),'Pass the explicit completed results.json path');
const raw=readFileSync(input);
const result=JSON.parse(raw);
assert.equal(result.status,'PASS');
assert.equal(result.cases.length,11);
assert(result.cases.every(row=>row.status==='PASS'));
const secret=readFileSync(result.credential_file,'utf8').trim();
for(const name of readdirSync(path.dirname(input)).filter(name=>/\.(log|json|jsonl)$/.test(name))) {
  assert(!readFileSync(path.join(path.dirname(input),name),'utf8').includes(secret),`Secret appeared in ${name}`);
}
function docker(args) {
  const r=spawnSync(process.env.DOCKER || 'docker',args,{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
for(const name of result.retained_containers) {
  assert(name.startsWith(result.run+'-'));
  assert.equal(docker(['inspect','--format','{{.State.Running}}',name]),'false');
}
assert(result.retained_volumes.every(name=>name.startsWith(result.run+'-')));
const main=JSON.parse(docker(['inspect','--format','{{json .State}}','klustr-pg18-dev-postgres-1']));
assert.equal(main.Health.Status,'healthy');
const baseline=JSON.parse(readFileSync('neon/tests/reports/local/container-state.json','utf8'));
assert.equal(main.StartedAt,baseline.StartedAt,'Development service restarted during operational testing');
const source=result.source;
const tracked={...result,source:{base_sha:source.base_sha,sha256:source.sha256},
  credential_file:undefined,credentials_retained_in_ignored_build:true,raw_results:path.relative(process.cwd(),input).replaceAll('\\','/'),
  raw_results_sha256:createHash('sha256').update(raw).digest('hex'),main_service:{status:main.Status,health:main.Health.Status,started_at:main.StartedAt}};
writeFileSync('neon/docs/qualification/operational-results.json',JSON.stringify(tracked,null,2)+'\n');
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(new Date(result.cases[0].started_at));
const rows=result.cases.map(row=>`| ${row.name} | ${row.status} | ${row.duration_seconds.toFixed(3)} |`);
const crash=result.cases.find(row=>row.name==='three crashes during acknowledged writes').evidence;
const cycles=crash.cycles.map(row=>`| ${row.cycle} | ${row.acknowledged} | ${row.recovered.rows} | ${row.recovered.balance} |`);
const relative=path.relative('neon/docs/qualification',path.dirname(input)).replaceAll('\\','/');
writeFileSync('neon/docs/qualification/operational-scenarios.md',`# Extended operational qualification — PASS

Executed ${date} (Asia/Tokyo) against PostgreSQL ${result.postgresql_version}, image
\`${result.image}\`, image ID \`${result.image_id}\`.
Base SHA \`${source.base_sha}\`, local source change SHA-256 \`${source.sha256}\`.
The PostgreSQL binary/source are unchanged from the [baseline qualification](pg18-wsl2-validation.md).

| Scenario | Observed result | Seconds |
|---|---|---:|
${rows.join('\n')}

## Crash durability and backup evidence

Four concurrent writers committed unique ledger entries and updated a balance
in the same transaction. A separate uncommitted row remained open. After at least
24 client acknowledgements, the dedicated container was killed with SIGKILL.
All acknowledged IDs were checked after recovery, the uncommitted sentinel was
absent, payloads matched their expected hashes, the balance equalled the ledger
row count, and amcheck verified the primary index. WAL consistency checking was
enabled in writer sessions. The three cycles used the same persistent volume.

| Crash cycle | Acknowledgements this cycle, all recovered | Total recovered rows | Balance |
|---|---:|---:|---:|
${cycles.join('\n')}

Rows without a received acknowledgement can still have committed; a client must
resolve an uncertain commit by its unique application transaction ID. These
checks establish an acknowledged-write lower bound, not an invented exact-once
network guarantee.

Online physical backup used pg_basebackup with streamed WAL and SHA-256 manifest
checksums, followed by pg_verifybackup. A copy of the retained backup booted as
a real standby and replayed a new write. A separate custom-format pg_dump was
restored into a fresh cluster; row counts, ordered payload hashes, balances and
index integrity matched. Manifest verification alone does not replace restore
testing, as the [PostgreSQL documentation](https://www.postgresql.org/docs/18/app-pgverifybackup.html) explains.

## Failure policy findings

- The 16 MiB temporary tablespace reached ENOSPC. Its insert rolled back, the
  server remained usable and the persistent ledger was unchanged. Host storage
  and the development data volume were not filled.
- A non-superuser role reached its two-connection limit. Admin access remained
  available, terminating the held sessions released capacity and a new login worked.
- With synchronous_commit=remote_apply, a commit waited in SyncRep while its
  standby was disconnected, then acknowledged only after replay resumed.
- During asynchronous failover, an old-primary-only write was deliberately not
  replicated. The original primary was stopped before promotion; that write was
  absent on the promoted server. pg_rewind then rejoined the old primary as a
  standby following the new timeline. This validates the expected data-loss
  window; it does not claim asynchronous RPO=0. See the official
  [replication](https://www.postgresql.org/docs/18/warm-standby.html),
  [fencing](https://www.postgresql.org/docs/18/warm-standby-failover.html) and
  [rewind prerequisites](https://www.postgresql.org/docs/18/app-pgrewind.html).
- Recreating a container with another password environment value preserved the
  original database password, system identifier and data. Rotation requires an
  explicit SQL operation; an environment change is not a rotation mechanism.
- A deliberately wrong PG_VERSION on a dedicated test cluster failed startup
  without reinitialization. Restoring the original marker allowed its original
  data to start again. This is a refusal test, not a cross-major upgrade test.

## Evidence, boundaries and reproduction

[Machine-readable summary](operational-results.json),
[raw run result](${relative}/results.json),
[every Docker command, exit code and output log](${relative}/commands.jsonl).
Secrets were checked absent from the report/log files. Credentials remain in an
ignored build directory and are not included in CI artifacts. All created
containers are stopped; volumes, backups and the isolated network are retained.
No existing volume was accepted by the runner. The main development service's
start timestamp matches its pre-test baseline, and it remains healthy.

Run from the repository root with the built image available:

\`\`\`bash
node neon/dev/checks/postgres/scenarios.mjs
# Linux/WSL with Docker and Node available:
make -f neon/Makefile scenarios
\`\`\`

Every run creates new named resources and a unique report directory. Resource
names and credential-file location are in its ignored raw results.json. The
suite never removes volumes. Review ownership labels and backups before any
explicit manual cleanup. CI now invokes the same suite and uploads its raw
reports; remote CI has not been executed from this session.

Initial runner failures were preserved separately: the WAL consistency setting
needed a quoted SQL value, and docker exec clients correctly exit 137 when their
container is deliberately killed. The runner now distinguishes that induced
exit from OOM and other SQL failures. The final complete run passed all cases.

This remains single-host local qualification. It does not cover machine/power
loss, multi-host routing, automatic failure detection, large-dataset restore
SLOs, remote archive/object-store outages or the distributed Neon runtime.
The ordered [engineering path forward](path-forward.md) sets the remaining gates.
`);
console.log(`Operational report PASS: ${result.cases.length} scenarios; all dedicated servers stopped, secrets absent from logs, development service not restarted.`);
