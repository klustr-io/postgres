import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root='neon/tests/reports/local',read=file=>JSON.parse(readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest=read(`${root}/neon-native-commit-experiment.json`);assert.equal(manifest.status,'PASS');
const record=read(manifest.result),data=read(record.benchmark_json),baseline=read(manifest.baseline.benchmark_json);
assert.equal(record.status,'PASS');assert.equal(data.status,'PASS');assert.equal(baseline.status,'PASS');
assert.equal(record.image_id,manifest.baseline.image_id);
assert.equal(hash(manifest.baseline.benchmark_json),manifest.baseline_raw_sha256);
assert.equal(data.engines.neon.settings.fsync,'off');assert.equal(baseline.engines.neon.settings.fsync,'on');
for(const [name,value] of Object.entries(baseline.engines.neon.settings))
  if(name!=='fsync')assert.equal(data.engines.neon.settings[name],value,name);
for(const name of ['seconds','warmup','clients','repeats','scale','json_rows','batch_size','scenarios','wal_compression'])
  assert.equal(data.parameters[name],baseline.parameters[name],name);
assert.equal(data.parameters.batch_size,1);assert.equal(data.parameters.repeats,3);assert.equal(data.parameters.seconds,20);
assert.equal(data.environment.cpu_max,'800000 100000');assert.equal(Number(data.environment.memory_max),8*1024**3);
assert.equal(data.engines.neon.neon_storage_settings.safekeepers,3);
assert.equal(data.engines.neon.neon_storage_settings.safekeeper_sync,true);
assert(data.engines.neon.synchronous_standby_names.includes('walproposer'));
const checks=['integrity_checks','recovery_checks','index_checkpoint_checks','compute_storage_loss_checks','scale_zero_checks'];
for(const name of checks){assert.equal(data[name].length,3);assert(data[name].every(row=>row.status==='PASS'));}
assert(data.compute_storage_loss_checks.every(row=>row.hard_killed_compute_processes>1&&
  row.old_pgdata_retained_outside_restart_path&&row.old_lfc_removed_from_restart_path));
assert(data.scale_zero_checks.every(row=>row.idle_compute_processes===0));
assert.equal(data.samples.length,6);
const directory=record.report_directory,audit={measured_samples:6,transactions:0,latency_samples_verified:0,checks:15,zero_failed_transactions:true};
for(const row of data.samples) {
  assert.equal(row.failed_transactions,0);
  const label=`neon-r${row.repetition}-${row.scenario}`,log=readFileSync(path.join(directory,'logs',label+'.log'),'utf8');
  assert.equal(Number(log.match(/number of transactions actually processed:\s*(\d+)/)[1]),row.transactions);
  assert.equal(Number(log.match(/number of failed transactions:\s*(\d+)/)[1]),0);
  assert.equal(Number(log.match(/tps = ([\d.]+)/)[1]),row.tps);
  const latency=[];
  for(const file of readdirSync(path.join(directory,'logs')).filter(name=>name.startsWith(label+'.')&&name.endsWith('.gz')))
    for(const line of gunzipSync(readFileSync(path.join(directory,'logs',file))).toString().trim().split('\n'))
      if(line.trim())latency.push(Number(line.trim().split(/\s+/)[2])/1000);
  latency.sort((a,b)=>a-b);assert.equal(latency.length,row.latency_ms.sample_count);assert(latency.length>0);
  for(const [name,p] of [['p50',.5],['p95',.95],['p99',.99]])assert.equal(latency[Math.ceil(latency.length*p)-1],row.latency_ms[name]);
  for(const [counter,total,rate] of [['rios','read_operations','read_iops'],['wios','write_operations','write_iops']]) {
    assert.equal(row.block_io.aggregate_devices.reduce((sum,dev)=>sum+(row.block_io.per_device[dev][counter]||0),0),row.block_io[total]);
    assert(Math.abs(row.block_io[total]/row.block_io.interval_seconds-row.block_io[rate])<1e-9);
  }
  audit.transactions+=row.transactions;audit.latency_samples_verified+=latency.length;
}
for(const check of data.integrity_checks) {
  for(const scenario of ['relational-write','jsonb-write'])assert.equal(check.write_transactions[scenario],
    data.samples.filter(row=>row.repetition===check.repetition&&row.scenario===scenario)
      .reduce((sum,row)=>sum+row.transactions+row.warmup_transactions,0));
  assert.equal(check.digest.account_balance,check.write_transactions['relational-write']);
  assert.equal(check.digest.json_score_sum,check.write_transactions['jsonb-write']);
  assert.equal(check.digest.payload_digest,data.initial_fixture.payload_digest);
}
mkdirSync(path.join(directory,'queries'),{recursive:true});mkdirSync(path.join(directory,'harness'),{recursive:true});
for(const name of ['relational-write','jsonb-write']) {
  const destination=path.join(directory,'queries',name+'.sql');
  assert.equal(spawnSync(process.env.DOCKER||'docker',['cp',`${record.container}:/var/lib/neon/comparison/${name}.sql`,destination],{encoding:'utf8'}).status,0);
  assert.equal(hash(destination),hash(path.join(manifest.baseline.report_directory,'queries',name+'.sql')));
}
for(const name of ['compare_postgres.py','s3_client.py'])writeFileSync(path.join(directory,'harness',name),readFileSync(path.join('build',record.container+'-scripts',name)));
assert.equal(hash(path.join(directory,'harness','compare_postgres.py')),record.harness_sha256);
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const range=values=>({median:median(values),min:Math.min(...values),max:Math.max(...values)});
const summarize=rows=>({tps:range(rows.map(row=>row.tps)),p95_ms:range(rows.map(row=>row.latency_ms.p95)),
  mean_latency_ms:range(rows.map(row=>row.latency_ms.mean)),read_iops:range(rows.map(row=>row.block_io.read_iops)),
  write_iops:range(rows.map(row=>row.block_io.write_iops)),cpu_ms_per_update:range(rows.map(row=>row.cpu.usage_usec/1000/row.transactions))});
const result={status:'PASS',generated_at:new Date().toISOString(),provenance:record,baseline:manifest.baseline,
  baseline_raw_sha256:manifest.baseline_raw_sha256,raw_json_sha256:hash(record.benchmark_json),audit,
  settings:data.engines.neon.settings,storage:data.engines.neon.neon_storage_settings,
  synchronous_standby_names:data.engines.neon.synchronous_standby_names,
  checks:Object.fromEntries(checks.map(name=>[name,data[name]])),scenarios:{},
  s3_offload_proofs:data.engines.neon.s3_offload_proofs,
  limits:['Single-host, fixed-order, short-window experiment; not production capacity or multi-zone qualification.',
    'Only compute-local fsync is disabled. Safekeeper fsync, quorum, synchronous commits and full-page writes remain enabled.',
    'SIGKILL and exclusion of local files test compute loss, not an OS/power failure or storage-device flush honesty.',
    'Wake timings use manual process control with shared storage/control plane online. They exclude Kubernetes scheduling, node autoscaling, image pulling, proxy/auth and forced S3-cold storage.',
    'Existing release images need the repaired PostgreSQL build and full requalification. Controller generation fencing and the tenant compute operator remain separate gates.']};
for(const scenario of ['relational-write','jsonb-write']) {
  const before=summarize(baseline.samples.filter(row=>row.scenario===scenario)),after=summarize(data.samples.filter(row=>row.scenario===scenario));
  result.scenarios[scenario]={compute_fsync_on:before,compute_fsync_off:after,tps_ratio:after.tps.median/before.tps.median};
}
assert(data.engines.neon.s3_offload_proofs.length===3&&data.engines.neon.s3_offload_proofs.every(row=>row.tls_verified&&row.pageserver_objects>0&&row.full_wal_objects>0));
writeFileSync(`${root}/neon-native-commit-comparison.json`,JSON.stringify(result,null,2)+'\n');
const files=['benchmark.json',...['logs','queries','harness'].flatMap(folder=>readdirSync(path.join(directory,folder)).map(file=>folder+'/'+file))];
writeFileSync(path.join(directory,'native-commit-evidence.json'),JSON.stringify({image_id:record.image_id,
  harness_sha256:record.harness_sha256,files:Object.fromEntries(files.map(file=>[file,hash(path.join(directory,file))]))},null,2)+'\n');
const lines=['# Native Neon commit and compute-zero qualification','',
  'Same fixed PG18.6 image, one update per transaction, Zstd WAL compression, 8 clients, 1M accounts, 100K JSONB documents, 3 x 20-second samples per workload.',
  'Only compute-local fsync changes. Synchronous commits, full-page writes and three fsync-enabled safekeepers remain enabled. Earlier fsync-on measurements are a separate time block.',
  '', '| Workload | Compute fsync on TPS | Compute fsync off TPS (range) | Ratio | On p95 ms | Off p95 ms | Off read/write IOPS |',
  '|---|---:|---|---:|---:|---:|---|'];
for(const [name,row] of Object.entries(result.scenarios))lines.push(`| ${name} | ${row.compute_fsync_on.tps.median.toFixed(1)} | ${row.compute_fsync_off.tps.median.toFixed(1)} (${row.compute_fsync_off.tps.min.toFixed(1)} - ${row.compute_fsync_off.tps.max.toFixed(1)}) | ${row.tps_ratio.toFixed(2)} | ${row.compute_fsync_on.p95_ms.median.toFixed(2)} | ${row.compute_fsync_off.p95_ms.median.toFixed(2)} | ${row.compute_fsync_off.read_iops.median.toFixed(1)} / ${row.compute_fsync_off.write_iops.median.toFixed(1)} |`);
lines.push('', 'All six new samples passed accounting/raw latency/IOPS audits. Each repetition passed index-build checkpoint, quorum-loss blocking, compute crash recovery, complete compute-local PGDATA/cache exclusion after SIGKILL, and manual compute stop/wake.',
  '', '| Repetition | Remote reconstruction seconds | Zero-compute wake seconds | First relational query ms | First JSON query ms |',
  '|---|---:|---:|---:|---:|');
for(const row of data.scale_zero_checks)lines.push(`| ${row.repetition} | ${data.compute_storage_loss_checks.find(x=>x.repetition===row.repetition).reconstruct_seconds.toFixed(3)} | ${row.wake_to_ready_seconds.toFixed(3)} | ${row.first_relational_query_ms_including_client_connect.toFixed(2)} | ${row.first_json_query_ms_including_client_connect.toFixed(2)} |`);
lines.push('',...result.limits.map(value=>'- '+value),
  '', 'This validates an ephemeral-compute candidate contract, not fsync=off for ordinary PostgreSQL or safekeeper storage. Client success must remain behind the externally durable commit LSN.',
  '', 'See [COMMIT-AND-WAKE.md](COMMIT-AND-WAKE.md) for first-principles analysis and industry papers.',
  'Machine-readable evidence: [neon-native-commit-comparison.json](../../tests/reports/local/neon-native-commit-comparison.json).','');
writeFileSync('neon/docs/neon-production/NATIVE-COMMIT.md',lines.join('\n'));
console.log(JSON.stringify({status:'PASS',audit,scenarios:result.scenarios,wake:data.scale_zero_checks},null,2));
