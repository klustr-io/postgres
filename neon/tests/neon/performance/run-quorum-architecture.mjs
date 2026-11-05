#!/usr/bin/env node
// Bounded, disposable architecture screen: no Docker volume or S3 connection.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const image = process.argv[2] || 'klustr-neon-perf:guard-candidate';
const output = path.resolve(process.argv[3] || 'build/quorum-architecture');
fs.mkdirSync(output, {recursive: true});
const probe = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const group = process.argv[4] || 'baseline';
assert(['baseline', 'controls', 'safekeeper-nosync', 'tokio-one', 'native-quorum', 'bounded-async', 'best-effort', 'native-reference', 'jsonb-storage', 'docb-native', 'docb-quorum', 'docb-best-effort', 'quorum-io-tokio', 'quorum-io-inline', 'quorum-io-owned', 'quorum-io-direct', 'quorum-io-uring', 'quorum-io-uring-single', 'ordered-wait-ab'].includes(group));
const isDocb = group.startsWith('docb-');
const docbEngine = group === 'docb-native' ? 'native' : 'neon';
const docbProbe = fs.realpathSync(path.join(probe, '../compute'));
const jsonCase = process.argv[5] || 'default';
assert(['default', 'inline', 'lz4', 'external', 'no-gin', 'large'].includes(jsonCase));
const name = `neon-quorum-architecture-${randomUUID().slice(0, 8)}`;
const profile = process.env.NEON_QUORUM_PROFILE === '1';
const kernelProfile = process.env.NEON_QUORUM_KERNEL_PROFILE === '1';
const inspect = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {encoding: 'utf8'});
assert.equal(inspect.status, 0, 'Provide a locally built comparison image containing raw PG18 and Neon tools');
const command = isDocb
  ? `python3 -B /docb-probe/docb_storage.py; status=$?; printf "\\n_QUORUM_REPORT_\\n"; cat /var/lib/neon/docb/docb-storage-${docbEngine}.json; exit "$status"`
  : `python3 -B /probe/quorum_architecture.py; status=$?; printf "\\n_QUORUM_REPORT_\\n"; ${kernelProfile ? 'setpriv --reuid=10002 --regid=10002 --clear-groups ' : ''}cat /var/lib/neon/quorum-architecture.json; exit "$status"`;
const probeSha256 = createHash('sha256').update(fs.readFileSync(isDocb
  ? path.join(docbProbe, 'docb_storage.py') : path.join(probe, 'quorum_architecture.py'))).digest('hex');
const sourceHash = createHash('sha256').update(fs.readFileSync('neon/runtime/pgxn/neon/bounded_commit_guard.c')).digest('hex');
const nativeApiProvenance = process.env.NEON_NATIVE_WAL_API_CHECK === '1' ? {
  helperSha256: createHash('sha256').update(fs.readFileSync(path.join(probe, 'native_wal_api.py'))).digest('hex'),
  implementationSha256: createHash('sha256').update(fs.readFileSync('neon/runtime/safekeeper/src/native_wal.rs')).digest('hex'),
} : null;
const result = spawnSync('docker', ['run', '--rm', '--init', '--name', name, '--network', 'none',
  '--env', `QUORUM_TEST_GROUP=${group}`,
  '--env', `QUORUM_FIXTURE_ID=${name}`,
  '--env', `QUORUM_CASE_FILTER=${process.env.NEON_QUORUM_CASE_FILTER || 'all'}`,
  '--env', `QUORUM_LOCAL_COMMIT_DELAY_US=${process.env.NEON_QUORUM_LOCAL_COMMIT_DELAY_US || '0'}`,
  '--env', `QUORUM_STORAGE_BATCH_DELAY_US=${process.env.NEON_QUORUM_STORAGE_BATCH_DELAY_US || '0'}`,
  '--env', `QUORUM_ORDERED_WAIT_CHECK=${process.env.NEON_QUORUM_ORDERED_WAIT_CHECK || '0'}`,
  '--env', `QUORUM_NATIVE_WAL_API_CHECK=${process.env.NEON_NATIVE_WAL_API_CHECK || '0'}`,
  '--env', `QUORUM_NATIVE_PROVIDER=${process.env.NEON_QUORUM_NATIVE_PROVIDER || '0'}`,
  '--env', `QUORUM_NATIVE_WINDOW=${process.env.NEON_QUORUM_NATIVE_WINDOW || '1'}`,
  '--env', `QUORUM_NATIVE_TRANSPORT=${process.env.NEON_QUORUM_NATIVE_TRANSPORT || 'http'}`,
  '--env', `QUORUM_NATIVE_GROUP_DELAY_US=${process.env.NEON_QUORUM_NATIVE_GROUP_DELAY_US || '0'}`,
  '--env', `QUORUM_NATIVE_RECONNECT_CHECK=${process.env.NEON_QUORUM_NATIVE_RECONNECT_CHECK || '0'}`,
  '--env', `QUORUM_NATIVE_SENDER_OWNED=${process.env.NEON_QUORUM_NATIVE_SENDER_OWNED || '0'}`,
  '--env', `QUORUM_NATIVE_SHARED_COMPLETION=${process.env.NEON_QUORUM_NATIVE_SHARED_COMPLETION || '0'}`,
  '--env', `QUORUM_NATIVE_SPIN_US=${process.env.NEON_QUORUM_NATIVE_SPIN_US || '0'}`,
  '--env', `QUORUM_SK_RUNTIME_THREADS=${process.env.NEON_QUORUM_SK_RUNTIME_THREADS || '0'}`,
  '--env', `QUORUM_NATIVE_STREAM_WINDOW=${process.env.NEON_QUORUM_NATIVE_STREAM_WINDOW || '0'}`,
  '--env', `QUORUM_PREFLIGHT_NEGATIVE=${process.env.NEON_QUORUM_PREFLIGHT_NEGATIVE || '0'}`,
  '--env', `QUORUM_CANDIDATE_IO=${process.env.NEON_QUORUM_CANDIDATE_IO || 'tokio'}`,
  '--env', `QUORUM_NATIVE_DEDICATED=${process.env.NEON_QUORUM_NATIVE_DEDICATED || '0'}`,
  '--env', `QUORUM_PROTOCOL_ONLY=${process.env.NEON_QUORUM_PROTOCOL_ONLY || '0'}`,
  ...(process.env.NEON_QUORUM_COMMIT_PUBLICATION_MS !== undefined
    ? ['--env', `QUORUM_COMMIT_PUBLICATION_MS=${process.env.NEON_QUORUM_COMMIT_PUBLICATION_MS}`] : []),
  '--env', `QUORUM_CPU_PROFILE=${profile ? '1' : '0'}`,
  '--env', `QUORUM_KERNEL_PROFILE=${kernelProfile ? '1' : '0'}`,
  '--env', `QUORUM_KERNEL_SCOPE=${process.env.NEON_QUORUM_KERNEL_SCOPE || 'storage'}`,
  '--env', `JSON_STORAGE_CASE=${jsonCase}`,
  '--env', `DOCB_ENGINE=${docbEngine}`,
  '--env', `DOCB_COMMIT_PROFILE=${group === 'docb-best-effort' ? 'best-effort' : 'durable'}`,
  '--cpus', '8', '--memory', '6g', '--memory-swap', '6g', '--read-only', '--cap-drop', 'ALL',
  ...(process.env.NEON_QUORUM_CPUSET ? ['--cpuset-cpus', process.env.NEON_QUORUM_CPUSET] : []),
  '--security-opt', 'no-new-privileges', '--shm-size', '512m',
  // io_uring is filtered by Docker's default seccomp profile. Keep all I/O
  // controls under the same syscall filter, only in these private fixtures.
  ...(group.startsWith('quorum-io-') ? ['--security-opt', 'seccomp=unconfined'] : []),
  ...(kernelProfile ? ['--user', '0', '--cap-add', 'PERFMON', '--cap-add', 'SYS_PTRACE', '--cap-add', 'SYSLOG', '--cap-add', 'SETUID', '--cap-add', 'SETGID'] : []),
  '--tmpfs', '/var/lib/neon:rw,nosuid,nodev,size=4g,uid=10002,gid=10002,mode=0700',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
  ...(process.env.NEON_QUORUM_SK_RUNTIME_THREADS && process.env.NEON_QUORUM_SK_RUNTIME_THREADS !== '0'
    ? ['--tmpfs','/opt/fixture-bin:rw,nosuid,nodev,exec,size=1m,uid=10002,gid=10002,mode=0700'] : []),
  ...(group === 'ordered-wait-ab' ? ['--tmpfs', '/opt/pgcomparison:rw,nosuid,nodev,exec,size=192m,uid=10002,gid=10002,mode=0700'] : []),
  '--mount', `type=bind,source=${probe},target=/probe,readonly`,
  ...(profile || kernelProfile ? ['--mount', `type=bind,source=${output},target=/profile-output`] : []),
  ...(isDocb ? ['--mount', `type=bind,source=${docbProbe},target=/docb-probe,readonly`] : []),
  '--entrypoint', '/bin/sh', image, '-c', command],
{encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 300000});
fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout || '');
fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
const marker = '\n_QUORUM_REPORT_\n';
const index = result.stdout?.lastIndexOf(marker);
if (index >= 0 && result.stdout.slice(index + marker.length).trim()) {
  const report = JSON.parse(result.stdout.slice(index + marker.length));
  if (report.core_comparison?.original_implementation_sha256) {
    // Pin the pre-refactor source so committing the candidate cannot move the control.
    const baselineCommit = '2da748e0e24f70b9937c5f11241b1a4702248af4';
    const original = spawnSync('git',['show',baselineCommit+':src/backend/replication/syncrep.c'],{encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(original.status,0,'Cannot read reference synchronous replication source');
    assert.equal(report.core_comparison.original_implementation_sha256,
      createHash('sha256').update(original.stdout.replace(/\r\n/g,'\n')).digest('hex'),
      'Baseline contains changes beyond the inert ABI export');
    report.core_comparison.original_implementation_commit = baselineCommit;
  }
  if (process.env.NEON_QUORUM_ORDERED_WAIT_CHECK === '1') {
    assert.equal(report.syncrep_source_sha256,
      createHash('sha256').update(fs.readFileSync('src/backend/replication/syncrep.c')).digest('hex'),
      'Ordered-wait native core must match the working tree');
  }
  report.caseFilter = process.env.NEON_QUORUM_CASE_FILTER || 'all';
  report.localCommitDelayUs = Number(process.env.NEON_QUORUM_LOCAL_COMMIT_DELAY_US || '0');
  report.storageBatchDelayUs = Number(process.env.NEON_QUORUM_STORAGE_BATCH_DELAY_US || '0');
  report.cpuSet = process.env.NEON_QUORUM_CPUSET || null;
  report.commitPublicationIntervalMs = process.env.NEON_QUORUM_COMMIT_PUBLICATION_MS === undefined
    ? null : Number(process.env.NEON_QUORUM_COMMIT_PUBLICATION_MS);
  report.fixture = {image, imageId: inspect.stdout.trim(), container: name,
    probeSha256,
    currentGuardSourceSha256: sourceHash, guardMatchesWorkingTree: report.guard_source_sha256 === sourceHash,
    note: 'Existing diagnostic image; this is attribution testing, not qualification of current release packaging.'};
  if (nativeApiProvenance) {
    report.fixture.nativeApi = nativeApiProvenance;
    assert.equal(report.native_wal_api_source_sha256, nativeApiProvenance.implementationSha256,
      'Native append implementation must match the diagnostic image');
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  if (isDocb) {
    report.fixture.currentDocbSourceSha256 = createHash('sha256').update(fs.readFileSync('src/backend/utils/adt/docb.c')).digest('hex');
    assert.equal(report.docb_source_sha256, report.fixture.currentDocbSourceSha256, 'DOCB core source must match the diagnostic image');
    assert.equal(report.docb_module_sha256, createHash('sha256').update(fs.readFileSync('contrib/docb/docb.c')).digest('hex'), 'DOCB module must match the diagnostic image');
    assert.equal(report.docb_sql_sha256, createHash('sha256').update(fs.readFileSync('contrib/docb/docb--0.1.sql')).digest('hex'), 'DOCB extension registration must match the diagnostic image');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({status: report.status, samples: (report.samples || report.results).length, output, error: report.error}));
  assert.equal(report.fixture.guardMatchesWorkingTree, true, 'Diagnostic guard source must match current source');
}
// A timeout must not leave the private fixture running.
if (result.error) spawnSync('docker', ['stop', '--time', '5', name], {encoding: 'utf8', timeout: 15000});
assert.equal(result.status, 0, `${result.error || result.stderr}\n${result.stdout?.slice(-3000)}`);
