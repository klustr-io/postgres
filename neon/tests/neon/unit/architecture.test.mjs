import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('Owned architecture gate rejects undocumented async initialization and accepts named producer contracts', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-architecture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, {recursive: true});
  });
  const directory = path.join(folder, 'src', 'composition'); fs.mkdirSync(directory, {recursive: true});
  const source = path.join(directory, 'TenantBootstrapInit.mjs');
  const gate = fileURLToPath(new URL('../../../dev/quality/ArchitectureCheck.mjs', import.meta.url));
  const inspect = () => spawnSync(process.execPath, [gate], {cwd: folder, encoding: 'utf8'});
  fs.writeFileSync(source, 'export async function TenantBootstrapInit({name}) {return {name};}\n');
  let result = inspect(); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /named-factory-parameter-contract/);
  assert.match(result.stderr, /named-factory-return-contract/);
  assert.match(result.stderr, /exported symbol 'TenantBootstrapInit' requires JSDoc/);
  const contract = `/**
 * @typedef {Object} TenantBootstrapDependencies
 * @property {string} name - Provider-selected namespace bootstrap identity.
 */
/**
 * @typedef {Object} TenantBootstrapReceipt
 * @property {string} name - Namespace identity whose bootstrap was accepted.
 */
/**
 * Initialize a namespace bootstrap receipt without persistence side effects.
 * Authorization belongs to the owning administrative command boundary.
 * @param {TenantBootstrapDependencies} dependencies - Explicit provider namespace identity.
 * @returns {Promise<TenantBootstrapReceipt>} Accepted namespace identity.
 * @throws {Error} If the owning command cannot accept initialization.
 */
export async function TenantBootstrapInit({name}) {return {name};}
`;
  fs.writeFileSync(source, contract); result = inspect(); assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(source, contract.replace(' - Provider-selected namespace bootstrap identity.', ''));
  result = inspect(); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /documented-object-contract-properties/);
  fs.writeFileSync(source, contract);
  const application=path.join(folder,'src','application');fs.mkdirSync(application);
  const query=path.join(application,'TenantQuery.mjs');
  fs.writeFileSync(query,"import {ConfigurationFile} from '../infrastructure/ConfigurationFile.mjs';\n");
  result=inspect();assert.notEqual(result.status,0);assert.match(result.stderr,/application-infrastructure-dependency/);
  fs.writeFileSync(query,"/** @typedef {import('../infrastructure/ConfigurationFile.mjs').ConfigurationFile} TestOnlyType */\n");
  result=inspect();assert.equal(result.status,0,result.stderr);
});
