import fs from 'node:fs';
import {ConfigurationFile} from './ConfigurationFile.mjs';
/**
 * @typedef {Object} ConfigurationSnapshotDependencies
 * @property {string} file - Provider-owned configuration file path selected by composition.
 */
/** Own the parsed deployment file cache and keep filesystem details outside application policy. */
export class ConfigurationSnapshot {
  #file; #cached;
  /** @param {ConfigurationSnapshotDependencies} dependencies - Explicit provider configuration location. */
  constructor({file}) {this.#file = file;}
  /**
   * Read current validated deployment configuration without exposing the cached authority.
   * Requires internal provider configuration authorization; side effects stat/read the configured file and replace the private cache when metadata changes.
   * @returns {import('../../domain/configuration/ClusterConfiguration.mjs').ClusterConfiguration} Independent validated snapshot for one application invocation.
   * @throws {Error} On absent/unreadable files or invalid configuration.
   */
  Read() {
    const stat = fs.statSync(this.#file), key = stat.mtimeMs + ':' + stat.size;
    if (this.#cached?.key !== key) this.#cached = {key, value: ConfigurationFile(this.#file)};
    return structuredClone(this.#cached.value);
  }
}
