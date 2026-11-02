/**
 * Parse a PostgreSQL WAL location without floating-point loss.
 * @param {string} value - PostgreSQL hexadecimal WAL location.
 * @returns {bigint} Exact byte position.
 * @throws {Error} On missing or malformed durability frontier.
 */
export function WalLsn(value) {
  if (typeof value !== 'string' || !/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i.test(value)) throw Error('Missing durability frontier');
  const [high, low] = value.split('/'); return (BigInt('0x' + high) << 32n) + BigInt('0x' + low);
}
/**
 * @typedef {Object} ShardDurability
 * @property {string} last_record_lsn - Latest observed WAL record.
 * @property {string} remote_consistent_lsn_visible - Generation-validated remote durable frontier.
 */
/**
 * Require generation-validated S3 durability of acknowledged and final WAL.
 * @param {ShardDurability} shard - Current shard durability observation.
 * @param {string} frontier - Required drained compute frontier.
 * @returns {boolean} Whether remote storage covers both required boundaries.
 * @throws {Error} If an observation is missing or malformed.
 */
export function RemoteDurable(shard, frontier) {
  const required = WalLsn(frontier) > WalLsn(shard.last_record_lsn) ? WalLsn(frontier) : WalLsn(shard.last_record_lsn);
  return WalLsn(shard.remote_consistent_lsn_visible) >= required;
}
