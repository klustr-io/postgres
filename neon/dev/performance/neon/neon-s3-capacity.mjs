// Optional SSH capacity observation for a self-hosted S3 backend. Read only.
import {spawn} from 'node:child_process';
import dns from 'node:dns/promises';
import assert from 'node:assert/strict';
export async function readS3Capacity(local,endpoint){
 const host=local.NEON_S3_CAPACITY_SSH_HOST;if(!host)return null;
 const mount=local.NEON_S3_CAPACITY_MOUNT||'/data';
 assert(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host));
 assert(/^\/[a-zA-Z0-9_/-]+$/.test(mount)&&!mount.includes('..'));
 assert.equal((await dns.lookup(new URL(endpoint).hostname)).address,(await dns.lookup(host)).address,'Capacity host must match the configured S3 endpoint');
 const start=Number(local.NEON_S3_CAPACITY_START_GIB||12),stop=Number(local.NEON_S3_CAPACITY_STOP_GIB||8);
 assert(Number.isFinite(start)&&Number.isFinite(stop)&&start>stop&&stop>=8);
 const output=await new Promise((resolve,reject)=>{
  const p=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes',host,'df -B1 -- '+mount]);
  let out='';p.stdout.on('data',b=>out+=b);p.stderr.resume();p.on('error',reject);
  const timer=setTimeout(()=>{p.kill();reject(Error('S3 capacity observation timed out'));},15000);
  p.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error('S3 capacity observation failed'));});
 });
 const fields=output.trim().split('\n').at(-1).trim().split(/\s+/);
 const available=Number(fields[3]),total=Number(fields[1]);assert(Number.isSafeInteger(available)&&Number.isSafeInteger(total)&&available>=0&&total>0);
 return {observed_at:new Date().toISOString(),host,mount,available_bytes:available,total_bytes:total,start_minimum_bytes:start*1024**3,stop_minimum_bytes:stop*1024**3};
}
