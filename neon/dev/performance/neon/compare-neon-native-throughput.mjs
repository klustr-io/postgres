// Rank audited, matched closed-loop runs by throughput similarity. Latency is
// diagnostic, following the user's explicit 2026-10-31 reprioritization.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {benchmarkStorageHealth} from '../../shared/neon-benchmark-storage-health.mjs';
const [neonPrefix,rawPrefix,outputPrefix,bestRawPrefix]=process.argv.slice(2);
for(const prefix of [neonPrefix,rawPrefix,outputPrefix])assert(/^[a-z0-9-]+$/.test(prefix||''));
if(bestRawPrefix)assert(/^[a-z0-9-]+$/.test(bestRawPrefix));
const root='neon/tests/reports/local',read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function load(prefix,engine) {
  const file=`${root}/${prefix}-comparison.json`,summary=read(file),raw=read(summary.provenance.benchmark_json);
  assert.equal(summary.raw_sha256,hash(summary.provenance.benchmark_json));
  assert.equal(summary.audit.zero_failed_transactions,true);assert.equal(summary.correctness_smoke_only,false);
  assert(summary.samples.length&&summary.samples.every(row=>row.engine===engine&&row.requested_rate===null),'Peak-throughput cases only');
  assert.equal(raw.status,'PASS');
  return {file,summary,raw};
}
const neon=load(neonPrefix,'neon'),stock=load(rawPrefix,'upstream');
const splitBudget=neon.summary.provenance.resource_profile==='compute8-storage8';
assert.equal(stock.summary.provenance.resource_profile??'total8',neon.summary.provenance.resource_profile??'total8','Resource experiment types differ');
if(splitBudget) {
  assert.equal(neon.summary.provenance.cpu_limit,16);assert.equal(stock.summary.provenance.cpu_limit,8);
  assert.equal(neon.summary.provenance.compute_and_loadgen_cpu_budget,8);
  assert.equal(stock.summary.provenance.compute_and_loadgen_cpu_budget,8);
  assert.equal(neon.summary.provenance.separate_storage_cpu_budget,8);
  assert.equal(stock.summary.provenance.separate_storage_cpu_budget,0);
  assert(neon.summary.cpu_layout_observations.length&&stock.summary.cpu_layout_observations.length);
}
const knownRaw=bestRawPrefix?load(bestRawPrefix,'upstream'):stock;
for(const key of ['cpu_limit','cpu_period_us','memory_limit_bytes','upstream_revision','neon_artifact_image'])
  assert.deepEqual(knownRaw.summary.provenance[key],stock.summary.provenance[key],'Best raw reference resource/source mismatch: '+key);
assert.deepEqual(knownRaw.raw.initial_fixture,stock.raw.initial_fixture,'Best raw reference logical data differs');
for(const key of ['seconds','warmup','restart_before_sample','repeats','clients','scale','json_rows','batch_size','scenarios'])
  assert.deepEqual(knownRaw.raw.parameters[key],stock.raw.parameters[key],'Best raw reference workload differs: '+key);
const storageHealth=benchmarkStorageHealth(neon.raw.samples);
const diagnosticCeiling=neon.raw.parameters.native_guard_diagnostic_off===true;
assert.equal(neon.raw.parameters.prewarm_indexes??false,stock.raw.parameters.prewarm_indexes??false,'Index prewarm policy differs');
if(diagnosticCeiling) {
  assert.equal(neon.summary.status,'MEASURED-ASYNC-CEILING');
  assert.equal(neon.raw.engines.neon.native_guard_disabled_observed,true);
}else {
  assert.equal(neon.summary.status,'NATIVE-COMMIT-GUARD-CANDIDATE');
  assert(neon.summary.native_commit_guard_proofs.length>0&&neon.summary.native_commit_guard_proofs.every(p=>p.status==='PASS'));
}
for(const key of ['seconds','warmup','restart_before_sample','repeats','clients','scale','json_rows','batch_size','wal_compression','latency_sampling','trace_waits','scenarios'])
  assert.deepEqual(neon.raw.parameters[key],stock.raw.parameters[key],'Unmatched parameter: '+key);
for(const key of [...(splitBudget?[]:['cpu_limit']),'cpu_period_us','memory_limit_bytes','upstream_revision','neon_artifact_image'])
  assert.deepEqual(neon.summary.provenance[key],stock.summary.provenance[key],'Unmatched resource/source: '+key);
assert.equal(neon.summary.provenance.volume_storage.provider,'docker-desktop-ext4-vhd');
assert.equal(stock.summary.provenance.volume_storage.provider,'docker-desktop-ext4-vhd');
const drive=value=>path.parse(value.summary.provenance.volume_storage.file).root.toLowerCase();
assert.equal(drive(neon),drive(stock),'Matched cases require the same physical host drive');
assert.equal(drive(knownRaw),drive(stock),'Best reference must use the same physical host drive');
assert.deepEqual(neon.raw.initial_fixture,stock.raw.initial_fixture,'Logical input data differs');
const ephemeralLocalFsync=neon.raw.parameters.compute_local_fsync==='off';
assert.equal(stock.raw.parameters.compute_local_fsync,'on','Raw PostgreSQL retains local authoritative fsync');
if(ephemeralLocalFsync)assert(neon.raw.parameters.verify_recovery&&neon.raw.parameters.verify_compute_storage_loss&&
  neon.raw.parameters.verify_scale_zero&&neon.summary.native_guard_observed_loss.length>0,'Require external authority and immediate-loss/wake controls');
const settings=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='shared_preload_libraries'&&(!ephemeralLocalFsync||key!=='fsync')));
assert.deepEqual(settings(neon.summary.settings_by_engine.neon),settings(stock.summary.settings_by_engine.upstream),'Normalized PostgreSQL settings differ');
const layout=value=>value.map(row=>({table_options:row.table_options,index_options:row.index_options,document_storage:row.document_storage,mean_document_bytes:row.mean_document_bytes}));
assert.deepEqual(layout(neon.summary.json_storage_layouts),layout(stock.summary.json_storage_layouts),'JSON physical-policy settings differ');
const median=values=>{const a=[...values].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
const target=read('neon/docs/neon-production/TARGET-CONTRACT.json'),rows=[];
for(const workload of [...new Set(neon.summary.samples.map(row=>row.workload))]) {
  const n=neon.summary.samples.filter(row=>row.workload===workload),s=stock.summary.samples.filter(row=>row.workload===workload);
  assert.equal(n.length,s.length);assert(n.length>0);
  const metrics=values=>Object.fromEntries(['tps','read_iops','write_iops','cpu_ms_per_transaction','wal_bytes_per_transaction'].map(key=>[key,median(values.map(row=>row[key]))]));
  const a=metrics(n),b=metrics(s),ratio=a.tps/b.tps;
  const known=knownRaw.summary.samples.filter(row=>row.workload===workload);assert(known.length>0);
  const bestRawTps=Math.max(b.tps,median(known.map(row=>row.tps))),bestRawRatio=a.tps/bestRawTps;
  rows.push({workload,repetitions:n.length,neon:a,raw_postgresql:b,throughput_ratio:ratio,
    neon_percentage_of_raw:100*ratio,throughput_delta_percent:100*(ratio-1),
    best_raw_reference_tps:bestRawTps,neon_percentage_of_best_raw:100*bestRawRatio,
    working_target_ratio:target.working_throughput_ratio_target,
    working_target_screen:!storageHealth.healthy_comparison_eligible?'INVALID-STORAGE-ENVIRONMENT':diagnosticCeiling?'DIAGNOSTIC-NO-RPO-ACCEPTANCE':bestRawRatio>=target.working_throughput_ratio_target?(splitBudget?'COMPUTE-SCREEN-PASS-EXTRA-STORAGE-BUDGET':'INITIAL-SCREEN-PASS'):'GAP-REMAINS'});
}
const result={status:!storageHealth.healthy_comparison_eligible?'DEGRADED-STORAGE-DIAGNOSTIC-NOT-HEALTHY-BASELINE':diagnosticCeiling?'DIAGNOSTIC-UNBOUNDED-CEILING-NOT-RPO-CANDIDATE':splitBudget?'COMPUTE-BUDGET-COMPARISON-ADDITIONAL-STORAGE-CPU':'AUDITED-MATCHED-THROUGHPUT-COMPARISON',generated_at:new Date().toISOString(),
  native_bounded_admission_enabled:!diagnosticCeiling,
  pageserver_backpressure_configuration:neon.raw.engines.neon.neon_storage_settings,
  storage_health:storageHealth,
  post_load_replay_drain_checks:neon.summary.post_load_replay_drain_checks||[],
  production_status:'NOT-PRODUCTION-QUALIFIED',target_contract:target,
  evidence:{neon:{file:neon.file,sha256:hash(neon.file)},raw_postgresql:{file:stock.file,sha256:hash(stock.file)}},
  best_raw_reference:{file:knownRaw.file,sha256:hash(knownRaw.file),policy:'Retain the faster raw result; a configuration that slows raw PG cannot manufacture near-native acceptance.'},
  resource_matching:splitBudget?'Compute and load generation are pinned to the same eight CPUs on each side. Neon storage services additionally use CPUs 8-15 (16-CPU total cap versus raw PG 8); total memory stays matched. This is NOT a same-total-CPU/cost comparison.':'Eight CPUs and matched total cgroup memory for each entire fixture; Neon storage services share its budget.',
  resource_profile:splitBudget?'compute8-storage8':'total8',
  acknowledgement_policy:'Foreground synchronous_commit=off on both; authoritative storage fsync stays on. '+(diagnosticCeiling?'Neon admission is explicitly disabled for this diagnostic ceiling; the one-second loss bound is NOT enforced.':'Neon additionally uses native external-frontier admission.')+' Raw PostgreSQL is not Neon-based.',
  local_fsync_policy:ephemeralLocalFsync?'Explicit asymmetry: Neon compute-local files are ephemeral and fsync is off only there; three authoritative safekeepers retain fsync and quorum. Raw PostgreSQL local fsync stays on. Full compute-file-loss/controlled-tail-loss/wake controls passed.':'Local fsync on for both; external Neon safekeepers also retain fsync.',
  limits:['One shared host and physical D: drive, not independent production storage nodes.',
    'Short peak-throughput screens require repeated sustained validation. Passing a working ratio is not production qualification.',
    'Neon retains three fsync-enabled safekeepers, pageserver and real TLS S3; the raw baseline has one local database/WAL copy.',
    'Latency remains in source evidence as diagnostic data and does not determine the current working-target result.'],rows};
fs.writeFileSync(`${root}/${outputPrefix}.json`,JSON.stringify(result,null,2)+'\n');
const lines=['# Matched raw PostgreSQL throughput comparison','',
  ...(diagnosticCeiling?['**Diagnostic ceiling only:** native admission is disabled. This case does not enforce the agreed one-second loss bound and cannot pass the bounded-loss acceptance target.','']:[]),
  ...(!storageHealth.healthy_comparison_eligible?['**Invalid healthy-storage baseline:** Neon recorded '+storageHealth.failed_operations+' failed S3 operations during measurement. The ratios below describe a degraded-storage run; remeasure after restoring S3 writes.','']:[]),
  '| Workload | Raw PG TPS | Neon TPS | Neon / raw | Read IOPS (raw / Neon) | Write IOPS (raw / Neon) |',
  '|---|---:|---:|---:|---:|---:|'];
for(const row of rows)lines.push(`| ${row.workload} | ${row.raw_postgresql.tps.toFixed(0)} | ${row.neon.tps.toFixed(0)} | ${row.neon_percentage_of_raw.toFixed(1)}% | ${row.raw_postgresql.read_iops.toFixed(0)} / ${row.neon.read_iops.toFixed(0)} | ${row.raw_postgresql.write_iops.toFixed(0)} / ${row.neon.write_iops.toFixed(0)} |`);
if(bestRawPrefix)for(const row of rows)lines.push(`\nAgainst the faster retained raw reference, ${row.workload}: ${row.best_raw_reference_tps.toFixed(0)} raw TPS; Neon reaches ${row.neon_percentage_of_best_raw.toFixed(1)}%. The working-target screen uses this ratio.`);
lines.push('',result.resource_matching,'',result.acknowledgement_policy,'',result.local_fsync_policy,'',...result.limits.map(row=>'- '+row),'',
  ...result.post_load_replay_drain_checks.map(row=>`Post-load replay catch-up before integrity/fault probes: ${row.seconds.toFixed(2)} seconds; initial backlog ${(row.initial_replay_lag_bytes/1048576).toFixed(1)} MiB. This is deferred work outside timed TPS; subsequent wake results do not prove immediate wake from the undrained tail.`),
  `Machine-readable evidence: [${outputPrefix}.json](../../tests/reports/local/${outputPrefix}.json).`,'');
fs.writeFileSync(`neon/docs/neon-production/${outputPrefix.toUpperCase()}.md`,lines.join('\n'));
console.log(JSON.stringify({status:result.status,rows},null,2));
