import fs from 'node:fs';
import {parse} from 'yaml';
import {NormalizeClusterConfiguration as normalizeConfiguration} from '../../domain/configuration/ClusterConfiguration.mjs';
/**
 * Load and validate deployment configuration without sharing mutable authority.
 * @param {string} [file] - Provider-owned configuration path.
 * @returns {ReturnType<typeof normalizeConfiguration>} Validated deployment configuration.
 * @throws {Error} On unreadable, malformed or invalid configuration.
 */
export function ConfigurationFile(file = process.env.NEON_CONFIG || '/etc/neon/cluster.yaml') {
  return normalizeConfiguration(parse(fs.readFileSync(file, 'utf8'), {uniqueKeys: true, maxAliasCount: 0}));
}
