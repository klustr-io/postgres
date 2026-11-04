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
assert(['baseline', 'controls', 'safekeeper-nosync', 'tokio-one', 'native-quorum', 'bounded-async', 'best-effort', 'native-reference', 'jsonb-storage', 'docb-native', 'docb-quorum', 'docb-best-effort'].includes(group));
const isDocb = group.startsWith('docb-');
const docbEngine = group === 'docb-native' ? 'native' : 'neon';
const docbProbe = fs.realpathSync(path.join(probe, '../compute'));
const jsonCase = process.argv[5] || 'default';
assert(['default', 'inline', 'lz4', 'external', 'no-gin', 'large'].includes(jsonCase));
const name = `neon-quorum-architecture-${randomUUID().slice(0, 8)}`;
const inspect = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {encoding: 'utf8'});
assert.equal(inspect.status, 0, 'Provide a locally built comparison image containing raw PG18 and Neon tools');
const command = isDocb
  ? `python3 -B /docb-probe/docb_storage.py; status=$?; printf "\\n_QUORUM_REPORT_\\n"; cat /var/lib/neon/docb/docb-storage-${docbEngine}.json; exit "$status"`
  : 'python3 -B /probe/quorum_architecture.py; status=$?; printf "\\n_QUORUM_REPORT_\\n"; cat /var/lib/neon/quorum-architecture.json; exit "$status"';
const result = spawnSync('docker', ['run', '--rm', '--init', '--name', name, '--network', 'none',
  '--env', `QUORUM_TEST_GROUP=${group}`,
  '--env', `JSON_STORAGE_CASE=${jsonCase}`,
  '--env', `DOCB_ENGINE=${docbEngine}`,
  '--env', `DOCB_COMMIT_PROFILE=${group === 'docb-best-effort' ? 'best-effort' : 'durable'}`,
  '--cpus', '8', '--memory', '6g', '--memory-swap', '6g', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--shm-size', '512m',
  '--tmpfs', '/var/lib/neon:rw,nosuid,nodev,size=4g,uid=10002,gid=10002,mode=0700',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
  '--mount', `type=bind,source=${probe},target=/probe,readonly`,
  ...(isDocb ? ['--mount', `type=bind,source=${docbProbe},target=/docb-probe,readonly`] : []),
  '--entrypoint', '/bin/sh', image, '-c', command],
{encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 300000});
fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout || '');
fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
const marker = '\n_QUORUM_REPORT_\n';
const index = result.stdout?.lastIndexOf(marker);
if (index >= 0 && result.stdout.slice(index + marker.length).trim()) {
  const report = JSON.parse(result.stdout.slice(index + marker.length));
  const sourceHash = createHash('sha256').update(fs.readFileSync('neon/runtime/pgxn/neon/bounded_commit_guard.c')).digest('hex');
  report.fixture = {image, imageId: inspect.stdout.trim(), container: name,
    probeSha256: createHash('sha256').update(fs.readFileSync(isDocb ? path.join(docbProbe, 'docb_storage.py') : path.join(probe, 'quorum_architecture.py'))).digest('hex'),
    currentGuardSourceSha256: sourceHash, guardMatchesWorkingTree: report.guard_source_sha256 === sourceHash,
    note: 'Existing diagnostic image; this is attribution testing, not qualification of current release packaging.'};
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
