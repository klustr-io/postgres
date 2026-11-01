import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const phase=process.argv[2]||'screen';assert(['screen','qualify','wake','arrival','diagnose','checkpoint','release','ram','slo'].includes(phase));
const root='neon/tests/reports/local',read=file=>JSON.parse(readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest=read(`${root}/neon-throughput-${phase}-experiments.json`);assert.equal(manifest.status,'PASS');
const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const range=values=>({median:quantile(values,.5),min:Math.min(...values),max:Math.max(...values)});
const summarize=rows=>Object.fromEntries(Object.entries({tps:r=>r.tps,mean_ms:r=>r.latency_ms.mean,
  p50_ms:r=>r.latency_ms.p50,p95_ms:r=>r.latency_ms.p95,p99_ms:r=>r.latency_ms.p99,
  read_iops:r=>r.block_io.read_iops,write_iops:r=>r.block_io.write_iops,
  wal_bytes_per_tx:r=>r.wal_bytes/r.transactions,cpu_ms_per_tx:r=>r.cpu.usage_usec/1000/r.transactions,
  observed_memory_mib:r=>r.memory_peak_observed_bytes/1024**2})
  .map(([name,get])=>[name,range(rows.map(get))]));
const output={status:'PASS',generated_at:new Date().toISOString(),phase,image_id:manifest.image_id,profiles:[],
  status_scope:'Measurement accounting and fixture correctness audit',latency_slo_status:'NOT-QUALIFIED',
  limits:['Single host and shared virtual disk; this measures local sensitivity, not production or multi-zone capacity.',
    'Closed-loop client concurrency can hide request queues. Arrival-rate tests are required to qualify latency under offered load.',
    'Sampling is recorded per profile; diagnostic runs log every transaction. Short windows and separate time blocks limit comparisons.',
    'Fixed-time warmup performs different numbers of updates at different throughputs; checkpoint/full-page-image amortization also changes. Concurrency results do not isolate group commit alone.',
    'Compute-local fsync is off only for Neon; external durable quorum, safekeeper fsync, synchronous commit and full-page writes remain on.',
    'Raw PostgreSQL has one durable local WAL copy; Neon has a majority among three collocated safekeepers. This is not a comparison of equivalent high-availability deployments.',
    'Manual process wake includes first committed write, but excludes Kubernetes scheduling, proxy/auth, image pulls and forced S3-cold storage.',
    'Post-wake acknowledged probes survive SIGKILL and exclusion of local compute files. This is not a power-failure test.',
    'Image provenance identifies the tested artifact; local performance checks do not establish production qualification.']};
let measured=0,transactions=0,latencyCount=0;
for(const profile of manifest.profiles){
  assert.equal(profile.status,'PASS');
  const record=read(profile.result),data=read(record.benchmark_json),directory=record.report_directory;
  assert.equal(record.status,'PASS');assert.equal(data.status,'PASS');assert.equal(record.image_id,manifest.image_id);
  assert.equal(hash(record.benchmark_json),profile.raw_sha256);
  if(output.harness_sha256)assert.equal(record.harness_sha256,output.harness_sha256,'Profiles use different harnesses');
  else output.harness_sha256=record.harness_sha256;
  if(manifest.harness_sha256)assert.equal(record.harness_sha256,manifest.harness_sha256,'Harness changed inside the experiment');
  const inspected=spawnSync(process.env.DOCKER||'docker',['inspect',record.container,'--format','{{.Image}}'],{encoding:'utf8'});
  assert.equal(inspected.status,0);assert.equal(inspected.stdout.trim(),record.image_id);
  assert.equal(data.parameters.clients,profile.clients);assert.equal(data.parameters.batch_size,1);
  assert.equal(data.parameters.repeats,profile.repeats);assert.equal(data.parameters.seconds,profile.seconds);
  assert.equal(data.parameters.wal_compression,'zstd');assert.equal(data.environment.cpu_max,'800000 100000');
  assert.equal(Number(data.environment.memory_max),8*1024**3);
  const settings=data.engines[profile.engine].settings;
  assert.equal(settings.fsync,profile.engine==='neon'?'off':'on');
  for(const name of ['synchronous_commit','full_page_writes'])assert.equal(settings[name],'on');
  assert.equal(data.integrity_checks.length,profile.repeats);
  assert(data.integrity_checks.every(check=>check.status==='PASS'));
  if(profile.engine==='neon'){
    if(profile.compute_storage){
      assert.equal(data.engines.neon.neon_storage_settings.compute_data_storage,profile.compute_storage);
      if(profile.compute_storage==='tmpfs'){
        assert.equal(data.engines.neon.neon_storage_settings.compute_tmpfs_limit_bytes,2*1024**3);
        assert(data.compute_memory_archives.length>=profile.repeats*3);
        assert(data.compute_memory_archives.every(row=>row.bytes>0&&row.sha256.length===64&&row.excluded_from_restart));
        assert(data.compute_endpoint_memory_archive.bytes>0&&data.compute_endpoint_memory_archive.sha256.length===64);
      }
    }
    if(profile.verify_pageserver_crash){
      assert.equal(data.pageserver_crash_checks.length,profile.repeats);
      assert(data.pageserver_crash_checks.every(row=>row.status==='PASS'&&row.hard_killed_compute_processes>1));
      assert(data.engines.neon.neon_storage_settings.pageserver_checkpoint_configuration_observed);
      assert.equal(data.engines.neon.neon_storage_settings.pageserver_checkpoint_distance_bytes,profile.pageserver_checkpoint_mib*1048576);
      assert.equal(data.engines.neon.neon_storage_settings.pageserver_checkpoint_timeout_seconds,profile.pageserver_checkpoint_seconds);
    }
    assert.equal(data.engines.neon.neon_storage_settings.safekeepers,3);
    assert.equal(data.engines.neon.neon_storage_settings.safekeeper_sync,true);
    assert(data.engines.neon.synchronous_standby_names.includes('walproposer'));
    for(const name of ['recovery_checks','index_checkpoint_checks','compute_storage_loss_checks']){
      assert.equal(data[name].length,profile.repeats);assert(data[name].every(row=>row.status==='PASS'));
    }
    for(const name of ['scale_zero_checks','post_wake_storage_loss_checks']){
      assert.equal(data[name].length,profile.repeats*profile.wake_cycles);assert(data[name].every(row=>row.status==='PASS'));
    }
    for(const wake of data.scale_zero_checks){
      assert.equal(wake.idle_compute_processes,0);
      if(profile.empty_compute_on_wake)assert.equal(wake.old_compute_files_excluded_before_wake,true);
      assert(wake.wake_to_first_durable_write_seconds>=wake.wake_to_ready_seconds);
      const recovery=data.post_wake_storage_loss_checks.find(row=>row.repetition===wake.repetition&&row.additional_acknowledged_probe_id===wake.acknowledged_probe_id);
      assert(recovery&&recovery.hard_killed_compute_processes>1&&recovery.old_pgdata_retained_outside_restart_path&&recovery.old_lfc_removed_from_restart_path);
    }
    assert.equal(data.engines.neon.s3_offload_proofs.length,profile.repeats);
    assert(data.engines.neon.s3_offload_proofs.every(row=>row.tls_verified&&row.pageserver_objects>0&&row.full_wal_objects>0));
  }
  assert.equal(data.samples.length,profile.repeats*(profile.scenarios?.length||2)*(profile.rates?.length||1));
  for(const row of data.samples){
    assert.equal(row.failed_transactions,0);measured++;transactions+=row.transactions;
    const label=row.sample_label||`${profile.engine}-r${row.repetition}-${row.scenario}`;
    const log=readFileSync(path.join(directory,'logs',label+'.log'),'utf8');
    assert.equal(Number(log.match(/number of transactions actually processed:\s*(\d+)/)[1]),row.transactions);
    assert.equal(Number(log.match(/number of failed transactions:\s*(\d+)/)[1]),0);
    assert.equal(Number(log.match(/tps = ([\d.]+)/)[1]),row.tps);
    const latencies=[],lags=[],execution=[];
    for(const file of readdirSync(path.join(directory,'logs')).filter(name=>name.startsWith(label+'.')&&name.endsWith('.gz')))
      for(const line of gunzipSync(readFileSync(path.join(directory,'logs',file))).toString().trim().split('\n'))
        if(line.trim()){
          const fields=line.trim().split(/\s+/),latency=Number(fields[2])/1000;latencies.push(latency);
          if(row.requested_rate!=null){assert.equal(fields.length,7);const lag=Number(fields[6])/1000;
            assert(lag>=0&&lag<=latency);lags.push(lag);execution.push(latency-lag);}
        }
    assert.equal(latencies.length,row.latency_ms.sample_count);assert(latencies.length>0);latencyCount+=latencies.length;
    if(data.parameters.latency_sampling===1)assert.equal(latencies.length,row.transactions,'Incomplete full transaction log');
    for(const [name,p] of [['p50',.5],['p95',.95],['p99',.99]])assert.equal(quantile(latencies,p),row.latency_ms[name]);
    if(row.latency_ms.p999!==undefined)assert.equal(quantile(latencies,.999),row.latency_ms.p999);
    if(row.latency_ms.max!==undefined)assert.equal(latencies.reduce((maximum,value)=>Math.max(maximum,value),0),row.latency_ms.max);
    if(row.requested_rate!=null){
      assert(profile.rates.includes(row.requested_rate));
      assert.equal(row.latency_origin,'Scheduled arrival including queue delay');
      assert.equal(row.schedule_lag_ms.reported_mean,Number(log.match(/schedule lag: avg ([\d.]+)/)[1]));
      for(const [name,p] of [['p50',.5],['p95',.95],['p99',.99]]){
        assert.equal(quantile(lags,p),row.schedule_lag_ms[name]);assert.equal(quantile(execution,p),row.execution_latency_ms[name]);
      }
    }
    for(const [counter,total,rate] of [['rios','read_operations','read_iops'],['wios','write_operations','write_iops']]){
      assert.equal(row.block_io.aggregate_devices.reduce((sum,dev)=>sum+(row.block_io.per_device[dev][counter]||0),0),row.block_io[total]);
      assert(Math.abs(row.block_io[total]/row.block_io.interval_seconds-row.block_io[rate])<1e-9);
    }
  }
  for(const check of data.integrity_checks){
    for(const scenario of ['relational-write','jsonb-write'])assert.equal(check.write_transactions[scenario],
      data.samples.filter(row=>row.repetition===check.repetition&&row.scenario===scenario).reduce((sum,row)=>sum+row.transactions+row.warmup_transactions,0));
    assert.equal(check.digest.account_balance,check.write_transactions['relational-write']);
    assert.equal(check.digest.json_score_sum,check.write_transactions['jsonb-write']);
    assert.equal(check.digest.payload_digest,data.initial_fixture.payload_digest);
  }
  for(const folder of ['harness','queries'])mkdirSync(path.join(directory,folder),{recursive:true});
  for(const file of ['compare_postgres.py','s3_client.py'])writeFileSync(path.join(directory,'harness',file),readFileSync(path.join('build',record.container+'-scripts',file)));
  assert.equal(hash(path.join(directory,'harness/compare_postgres.py')),record.harness_sha256);
  for(const name of ['relational-write','jsonb-write'])assert.equal(spawnSync(process.env.DOCKER||'docker',
    ['cp',`${record.container}:/var/lib/neon/comparison/${name}.sql`,path.join(directory,'queries',name+'.sql')],{encoding:'utf8'}).status,0);
  const queryHashes=Object.fromEntries(['relational-write','jsonb-write'].map(name=>[name,hash(path.join(directory,'queries',name+'.sql'))]));
  if(output.query_sha256)assert.deepEqual(queryHashes,output.query_sha256,'SQL transaction boundaries differ');
  else output.query_sha256=queryHashes;
  const files=['benchmark.json',...['logs','queries','harness'].flatMap(folder=>readdirSync(path.join(directory,folder)).map(file=>folder+'/'+file))];
  writeFileSync(path.join(directory,'throughput-evidence.json'),JSON.stringify({image_id:record.image_id,harness_sha256:record.harness_sha256,
    files:Object.fromEntries(files.map(file=>[file,hash(path.join(directory,file))]))},null,2)+'\n');
  const wake=data.scale_zero_checks||[];
  const cases=(profile.scenarios||['relational-write','jsonb-write']).flatMap(name=>(profile.rates||[null]).map(rate=>({name,rate})));
  output.profiles.push({...profile,provenance:record,settings,latency_sampling:data.parameters.latency_sampling,
    storage:data.engines[profile.engine].neon_storage_settings,
    pageserver_crash_checks:data.pageserver_crash_checks||[],scenarios:Object.fromEntries(cases
    .map(({name,rate})=>{
      const rows=data.samples.filter(row=>row.scenario===name&&(row.requested_rate??null)===rate);
      const summary=summarize(rows);
      if(rate!==null){summary.requested_rate=rate;summary.schedule_lag_p95_ms=range(rows.map(row=>row.schedule_lag_ms.p95));
        summary.execution_p95_ms=range(rows.map(row=>row.execution_latency_ms.p95));}
      return [name+(rate===null?'':`@${rate}`),summary];
    })),
    safekeeper_flush_profiles:data.samples.filter(row=>row.durability_metrics&&profile.engine==='neon').map(row=>({
      sample:row.sample_label,per_safekeeper:Object.fromEntries([7676,7677,7678].map(port=>{
        const delta=row.durability_metrics.delta,count=delta[port+':safekeeper_flush_wal_seconds_count'];
        assert(count>0,'Missing safekeeper flush histogram');
        return [port,{flushes:count,mean_flush_ms:1000*delta[port+':safekeeper_flush_wal_seconds_sum']/count,
          commits_per_flush:row.transactions/count}];
      }))})),
    diagnostic_cases:profile.trace_waits?data.samples.map(row=>{
      const resources=read(path.join(directory,'logs',row.sample_label+'-resources.json'));
      const observations=resources.filter(point=>point.diagnostic);
      assert(observations.length>=Math.floor(profile.seconds*.8),'Insufficient diagnostic observations');
      const waits={};
      for(const point of observations)for(const wait of point.diagnostic.waits||[]){
        const key=[wait.state,wait.wait_event_type,wait.wait_event].map(value=>value??'none').join(':');
        waits[key]=(waits[key]||0)+wait.sessions;
      }
      const slowFlushes=Object.fromEntries([7676,7677,7678].map(port=>{
        const delta=row.durability_metrics.delta;
        return [port,delta[port+':safekeeper_flush_wal_seconds_count']-delta[port+':safekeeper_flush_wal_seconds_bucket{le="0.5"}']];
      }));
      const pressure=row.pg_stats_after.neon_backpressure.throttling_us-row.pg_stats_before.neon_backpressure.throttling_us;
      assert(pressure>=0);assert(Object.values(slowFlushes).every(value=>Number.isFinite(value)&&value>=0));
      return {sample:row.sample_label,seconds:profile.seconds,all_transactions_logged:data.parameters.latency_sampling===1,
        observed_memory_mib:row.memory_peak_observed_bytes/1024**2,cpu_ms_per_tx:row.cpu.usage_usec/1000/row.transactions,
        sampling_metadata_note:data.parameters.latency_sampling===1&&data.methodology.latency.includes('10%')?
          'Legacy methodology text says 10%; explicit parameter is 1.0 and the raw-log audit verifies one record per measured transaction. Later harness text is corrected.':null,
        latency_ms:row.latency_ms,schedule_lag_ms:row.schedule_lag_ms,execution_latency_ms:row.execution_latency_ms,
        diagnostic_observations:observations.length,wait_session_observations:waits,backpressure_throttling_us:pressure,
        safekeeper_flushes_over_500ms:slowFlushes,
        scope:'Once-per-second wait/backpressure/LSN/flush observations with observer overhead; histograms do not prove per-commit causation.'};
    }):[],
    wake:wake.length?{cycles:wake.length,ready_seconds:range(wake.map(row=>row.wake_to_ready_seconds)),
      first_durable_write_seconds:range(wake.map(row=>row.wake_to_first_durable_write_seconds)),
      p95_first_durable_write_seconds:quantile(wake.map(row=>row.wake_to_first_durable_write_seconds),.95),
      post_wake_local_storage_loss_passes:data.post_wake_storage_loss_checks.length}:null});
}
output.audit={samples:measured,transactions,raw_latency_samples:latencyCount,zero_failed_transactions:true};
if(phase==='slo') {
  const cases=output.profiles.flatMap(profile=>Object.entries(profile.scenarios).map(([name,row])=>({
    engine:profile.engine,workload:name.split('@')[0],requested_tps:row.requested_rate,
    achieved_tps:row.tps.median,p99_ms:row.p99_ms.max,
    local_screen_pass:row.p99_ms.max<50&&row.tps.min>=row.requested_rate*.98
  })));
  output.local_slo_screen={target:{end_to_end_write_p99_ms_strictly_less_than:50,minimum_delivered_rate_fraction:.98},
    cases,highest_passing_tested_tps:Object.fromEntries(['relational-write','jsonb-write'].map(workload=>[
      workload,cases.filter(row=>row.workload===workload&&row.local_screen_pass)
        .reduce((maximum,row)=>Math.max(maximum,row.requested_tps),0)||null])),
    scope:'One fixed-order 120-second sample per case with every transaction logged. Highest passing tested rate is not sustained capacity, an interpolated limit, or target-cluster qualification.'};
}
writeFileSync(`${root}/neon-throughput-${phase}-comparison.json`,JSON.stringify(output,null,2)+'\n');
const lines=[`# Throughput and latency: ${phase}`,'',
  'PASS means the measurements and fixture correctness checks audited successfully. No production latency SLO or sustained capacity is qualified.',
  '',
  'One update per independent transaction. Zstd WAL compression. All profiles retain synchronous durable commits. Neon has three fsync-enabled safekeepers and ephemeral compute; raw PostgreSQL fsyncs its local WAL.',
  '', '| Engine / compute storage | Clients | Workload | TPS median (range) | Mean ms | p95 ms | p99 ms | Read / write IOPS |',
  '|---|---:|---|---|---:|---:|---:|---|'];
for(const profile of output.profiles)for(const [name,row] of Object.entries(profile.scenarios))lines.push(
  `| ${profile.engine}${profile.compute_storage?' / '+profile.compute_storage:''} | ${profile.clients} | ${name} | ${row.tps.median.toFixed(1)} (${row.tps.min.toFixed(1)}–${row.tps.max.toFixed(1)}) | ${row.mean_ms.median.toFixed(2)} | ${row.p95_ms.median.toFixed(2)} | ${row.p99_ms.median.toFixed(2)} | ${row.read_iops.median.toFixed(1)} / ${row.write_iops.median.toFixed(1)} |`);
if(output.profiles.some(profile=>profile.diagnostic_cases.length)) {
  lines.push('', '| Compute storage | p99.9 ms | Maximum ms | Queue p95 ms | Execution p95 ms | Observed peak MiB | CPU ms / transaction |',
    '|---|---:|---:|---:|---:|---:|---:|');
  for(const profile of output.profiles)for(const diagnostic of profile.diagnostic_cases) {
    lines.push(`| ${profile.compute_storage||'disk'} | ${diagnostic.latency_ms.p999.toFixed(2)} | ${diagnostic.latency_ms.max.toFixed(2)} | ${diagnostic.schedule_lag_ms.p95.toFixed(2)} | ${diagnostic.execution_latency_ms.p95.toFixed(2)} | ${diagnostic.observed_memory_mib.toFixed(1)} | ${diagnostic.cpu_ms_per_tx.toFixed(3)} |`);
  }
}
if(output.local_slo_screen) {
  lines.push('', 'Agreed production objective: end-to-end write p99 strictly below 50 ms, including schedule/queue delay. This local screen also requires delivery of at least 98% of the requested rate; no latency-limit skipping is enabled.',
    '', '| Workload | Offered TPS | Delivered TPS | p99 ms | Local screen |','|---|---:|---:|---:|---|');
  for(const row of output.local_slo_screen.cases)lines.push(`| ${row.workload} | ${row.requested_tps} | ${row.achieved_tps.toFixed(1)} | ${row.p99_ms.toFixed(2)} | ${row.local_screen_pass?'PASS':'FAIL'} |`);
  lines.push('',output.local_slo_screen.scope);
}
lines.push('',...output.profiles.filter(row=>row.wake).map(row=>`${row.engine}, ${row.clients} clients: ${row.wake.cycles} manual wake cycles; p95 to first durable write ${row.wake.p95_first_durable_write_seconds.toFixed(3)} seconds. All ${row.wake.post_wake_local_storage_loss_passes} first-write probes survived subsequent compute-local storage loss.`),
  '',...output.profiles.map(profile=>`${profile.engine}${profile.compute_storage?' / '+profile.compute_storage:''}: ${(profile.latency_sampling*100).toFixed(0)}% transaction latency logging.`),
  '',...(phase==='arrival'?['Offered-rate latency includes schedule lag. The @ suffix gives target transactions/sec. See JSON for schedule-lag and execution percentiles; subtracting marginal percentiles would be incorrect.']:[]),
  '',...output.limits.map(value=>'- '+value),'',
  `Audited ${measured} samples, ${transactions} measured transactions and ${latencyCount} raw latency samples.`,
  `Machine-readable evidence: [neon-throughput-${phase}-comparison.json](../../tests/reports/local/neon-throughput-${phase}-comparison.json).`,'');
writeFileSync(`neon/docs/neon-production/THROUGHPUT-${phase.toUpperCase()}.md`,lines.join('\n'));
console.log(JSON.stringify({status:'PASS',audit:output.audit,profiles:output.profiles.map(({engine,clients,scenarios,wake})=>({engine,clients,scenarios,wake}))},null,2));
