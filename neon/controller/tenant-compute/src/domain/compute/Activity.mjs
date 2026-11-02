/**
 * @typedef {Object} IdleSuspendPolicy
 * @property {'idle'} mode - Stop only after observed SQL inactivity and a safe drain.
 * @property {number} idleSeconds - Required inactivity interval in seconds.
 */
/**
 * @typedef {Object} NeverSuspendPolicy
 * @property {'never'} mode - Preserve compute demand until an explicit administrative suspension.
 */
/** @typedef {IdleSuspendPolicy | NeverSuspendPolicy} ComputeSuspendPolicy */
/**
 * @typedef {Object} ComputeIdlePolicy
 * @property {import('../database/DatabasePolicy.mjs').DatabaseSuspendOverride} [suspend] - Endpoint default idle policy.
 * @property {number} [idleSeconds] - Legacy fallback idle interval, default 300.
 * @property {Record<string, import('../database/DatabasePolicy.mjs').DatabaseSuspendOverride>} [databasePolicies] - Per-SQL-database overrides sharing this compute.
 */
/**
 * @typedef {Object} DatabaseActivitySample
 * @property {string} name - SQL database observed by the activity monitor.
 * @property {number | string} sessions - Cumulative observed user-session counter.
 * @property {number | string} active_ms - Cumulative active SQL milliseconds.
 * @property {string | null} reset - Statistics reset identity used to detect counter changes.
 */
/**
 * @typedef {Object} ClientActivitySample
 * @property {string} database - SQL database used by the client.
 * @property {number} pid - Backend identity within this compute incarnation.
 * @property {string | Date} change - Last backend state transition timestamp.
 * @property {string} state - PostgreSQL backend activity state; only idle permits suspension.
 */
/**
 * @typedef {Object} ComputeActivitySample
 * @property {number | boolean} blockers - Transactions/maintenance preventing a safe idle transition.
 * @property {DatabaseActivitySample[]} databases - Database-level counters including short-lived sessions.
 * @property {ClientActivitySample[]} clients - Current application backends and state transitions.
 */
/** @typedef {() => number} ActivityClock */
/**
 * Normalize an inherited idle policy without mutating the supplied override.
 * Authorization belongs to the owning policy command; this normalization has no side effects.
 * @param {import('../database/DatabasePolicy.mjs').DatabaseSuspendOverride | null} [value] - Requested idle policy.
 * @param {number} [fallback] - Idle interval used when omitted, default 300 seconds.
 * @returns {ComputeSuspendPolicy} Complete normalized idle or never-suspend policy.
 * @throws {Error} On invalid policy shapes, modes or inactivity intervals.
 */
export function SuspendPolicy(value,fallback=300){
  if(value!==undefined&&value!==null&&(typeof value!=='object'||Array.isArray(value)))throw Error('Suspend policy must be an object');
  const mode=value?.mode||'idle';
  if(mode==='never')return {mode};
  const idleSeconds=value?.idleSeconds??fallback;
  if(mode!=='idle'||!Number.isInteger(idleSeconds)||idleSeconds<1||idleSeconds>604800)throw Error('Invalid suspend policy');
  return {mode,idleSeconds};
}
/**
 * Determine whether any SQL database policy keeps the shared compute active.
 * No authorization is granted and no side effects occur; explicit lifecycle suspension is enforced separately.
 * @param {ComputeIdlePolicy} endpoint - Endpoint default and per-database policies.
 * @returns {boolean} Whether a never-suspend policy requires continuing demand.
 * @throws {Error} On malformed policies.
 */
export function AlwaysOn(endpoint){
  return SuspendPolicy(endpoint.suspend,endpoint.idleSeconds).mode==='never'||
    Object.values(endpoint.databasePolicies||{}).some(value=>SuspendPolicy(value).mode==='never');
}
// Monotonic observation times avoid early suspension when a worker clock moves.
// Database sessions/active_time catch work in connections shorter than a poll.
/** Track monotonic SQL inactivity without losing work from short-lived connections. */
export class Activity {
  #databases=new Map();
  /** @param {ActivityClock} [clock] - Monotonic milliseconds for observed inactivity, default performance.now. */
  constructor(clock=()=>performance.now()){this.clock=clock;}
  /**
   * Decide whether all observed SQL databases satisfy their safe inactivity intervals.
   * The owning lifecycle command retains authorization for drain; side effects update only this monitor's in-memory activity fingerprints.
   * @param {ComputeActivitySample} sample - Consistent SQL counters, blockers and client states.
   * @param {ComputeIdlePolicy} endpoint - Effective endpoint and per-database idle policies.
   * @returns {boolean} Whether an authorized caller may attempt a drain, not permission to kill active work.
   * @throws {Error} On invalid effective policies or malformed monitor samples.
   */
  observe(sample,endpoint){
    const now=this.clock();let allIdle=!sample.blockers&&!AlwaysOn(endpoint);
    for(const database of sample.databases){
      const clients=sample.clients.filter(client=>client.database===database.name);
      const busy=clients.some(client=>client.state!=='idle');
      const fingerprint=JSON.stringify([database.sessions,database.reset,
        database.name==='postgres'?null:database.active_ms,
        clients.map(client=>[client.pid,client.change,client.state]).sort((a,b)=>a[0]-b[0])]);
      let previous=this.#databases.get(database.name);
      if(!previous||previous.fingerprint!==fingerprint||busy||sample.blockers)
        previous={fingerprint,lastActive:now};
      this.#databases.set(database.name,previous);
      const rule=SuspendPolicy(endpoint.databasePolicies?.[database.name]||endpoint.suspend,endpoint.idleSeconds);
      if(rule.mode==='never'||busy||now-previous.lastActive<rule.idleSeconds*1000)allIdle=false;
    }
    return sample.databases.length>0&&allIdle;
  }
}
