export function policy(value,fallback=300){
  if(value!==undefined&&value!==null&&(typeof value!=='object'||Array.isArray(value)))throw Error('Suspend policy must be an object');
  const mode=value?.mode||'idle';
  if(mode==='never')return {mode};
  const idleSeconds=value?.idleSeconds??fallback;
  if(mode!=='idle'||!Number.isInteger(idleSeconds)||idleSeconds<1||idleSeconds>604800)throw Error('Invalid suspend policy');
  return {mode,idleSeconds};
}
export function alwaysOn(endpoint){
  return policy(endpoint.suspend,endpoint.idleSeconds).mode==='never'||
    Object.values(endpoint.databasePolicies||{}).some(value=>policy(value).mode==='never');
}
// Monotonic observation times avoid early suspension when a worker clock moves.
// Database sessions/active_time catch work in connections shorter than a poll.
export class Activity {
  constructor(clock=()=>performance.now()){this.clock=clock;this.databases=new Map();}
  observe(sample,endpoint){
    const now=this.clock();let allIdle=!sample.blockers&&!alwaysOn(endpoint);
    for(const database of sample.databases){
      const clients=sample.clients.filter(client=>client.database===database.name);
      const busy=clients.some(client=>client.state!=='idle');
      const fingerprint=JSON.stringify([database.sessions,database.reset,
        database.name==='postgres'?null:database.active_ms,
        clients.map(client=>[client.pid,client.change,client.state]).sort((a,b)=>a[0]-b[0])]);
      let previous=this.databases.get(database.name);
      if(!previous||previous.fingerprint!==fingerprint||busy||sample.blockers)
        previous={fingerprint,lastActive:now};
      this.databases.set(database.name,previous);
      const rule=policy(endpoint.databasePolicies?.[database.name]||endpoint.suspend,endpoint.idleSeconds);
      if(rule.mode==='never'||busy||now-previous.lastActive<rule.idleSeconds*1000)allIdle=false;
    }
    return sample.databases.length>0&&allIdle;
  }
}
