// Scan the same immutable archives that publication verifies and uploads.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const scanner = 'aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969';
const authenticationAdvisories = new Set([
  'CVE-2026-25537', 'GHSA-2mjx-qc3c-rqvc', 'GHSA-c8m5-c952-6cm4',
  'GHSA-3gjw-f78c-vvpw', 'GHSA-m9p2-fxp5-v3fp',
]);

export function scanRelease(archives, output) {
  assert(Object.keys(archives).length > 0, 'No image archives provided for security scanning');
  fs.mkdirSync(output, {recursive: true});
  const reports = fs.realpathSync(output);
  const cache = path.join(reports, 'cache');
  fs.mkdirSync(cache, {recursive: true});
  const results = [];
  for (const [role, archive] of Object.entries(archives)) {
    assert(/^[a-z-]+$/.test(role), 'Invalid image role');
    const file = fs.realpathSync(archive.file);
    const result = spawnSync('docker', ['run', '--rm', '--cpus=2', '--memory=3g',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--tmpfs=/tmp:rw,size=1g',
      '--mount', `type=bind,source=${path.dirname(file)},target=/input,readonly`,
      '--mount', `type=bind,source=${reports},target=/reports`,
      scanner, 'image', '--input', `/input/${path.basename(file)}`,
      '--scanners=vuln', '--cache-dir=/reports/cache', '--no-progress',
      '--skip-java-db-update', '--timeout=10m', '--format=json',
      '--output', `/reports/${role}.json`], {stdio: 'inherit', timeout: 12 * 60 * 1000});
    assert.equal(result.status, 0, `Security scanner failed for ${role}: ${result.error || result.signal || result.status}`);
    const report = JSON.parse(fs.readFileSync(path.join(reports, role + '.json'), 'utf8'));
    assert(report.SchemaVersion && Array.isArray(report.Results), 'Incomplete scan report');
    assert(report.Results.some(item => item.Type === 'debian'), 'OS package inventory is missing');
    assert(report.Results.some(item => item.Type === (role === 'tenant-controller' ? 'node-pkg' : 'cargo')), 'Application dependency inventory is missing');
    const findings = report.Results.flatMap(item => (item.Vulnerabilities || []).map(v => ({
      target: item.Target, id: v.VulnerabilityID, package: v.PkgName,
      installed: v.InstalledVersion, fixed: v.FixedVersion || null, severity: v.Severity,
    })));
    const blocking = findings.filter(v => ['CRITICAL', 'HIGH'].includes(v.severity) || authenticationAdvisories.has(v.id));
    results.push({role, archive: path.basename(file), findings, blocking});
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(cache, 'db', 'metadata.json'), 'utf8'));
  const age = Date.now() - Date.parse(metadata.UpdatedAt);
  assert(Number.isFinite(age) && age >= -60 * 60 * 1000 && age <= 48 * 60 * 60 * 1000, 'Vulnerability database must be less than 48 hours old');
  const summary = {schema_version: 1, scanner, database_updated_at: metadata.UpdatedAt,
    scanned_at: new Date().toISOString(), passed: results.every(result => result.blocking.length === 0), results};
  fs.writeFileSync(path.join(reports, 'security.json'), JSON.stringify(summary, null, 2) + '\n');
  assert(summary.passed, `Publication blocked by ${results.reduce((n, r) => n + r.blocking.length, 0)} security findings; see ${reports}`);
  return {passed: true, scanner, database_updated_at: metadata.UpdatedAt, scanned_at: summary.scanned_at};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv.find(value => value.startsWith('--input='))?.slice(8);
  assert(input, 'Usage: node neon/dev/checks/security/scan-release.mjs --input=<build folder>');
  const root = path.resolve(input);
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
  const archives = Object.fromEntries(Object.keys(build.images).map(role => [role, {file: path.join(root, 'images', role + '.oci.tar')}]));
  scanRelease(archives, path.join(root, 'security'));
}
