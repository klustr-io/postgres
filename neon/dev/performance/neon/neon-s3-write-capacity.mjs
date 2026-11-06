import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export function probeS3WriteCapacity({docker='docker',image,config,reportPrefix='neon-benchmark'}) {
  const directory=fs.realpathSync(path.resolve('neon/tests/neon/storage'));
  const stamp=new Date().toISOString().replaceAll(/[^0-9]/g,'');
  const file=`neon/tests/reports/local/${stamp}-${reportPrefix}-s3-capacity-preflight.json`;
  const probe=spawnSync(docker,['run','--rm','-i','--read-only','--cpus','1','--memory','256m','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--mount',`type=bind,source=${directory},target=/probe,readonly`,
    '--workdir','/probe','--entrypoint','python3',image,'-B','/probe/s3_write_capacity.py'],
    {input:JSON.stringify({config})+'\n',encoding:'utf8',timeout:150000,maxBuffer:1024**2});
  let result;
  try {result=JSON.parse(probe.stdout);}catch {result={status:'FAIL',error:'Capacity probe did not return a structured result'};}
  if(probe.status!==0)result.status='FAIL';
  Object.assign(result,{generated_at:new Date().toISOString(),exit_code:probe.status,fixture_allocated:false,
    connection_fingerprint:createHash('sha256').update(JSON.stringify({endpoint:config.endpoint,bucket:config.bucket,region:config.region})).digest('hex'),
    source_sha256:Object.fromEntries(['s3_client.py','s3_write_capacity.py'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')]))});
  fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');
  if(result.status!=='PASS')throw Error(`S3 write capacity preflight failed (${result.service_error_code||result.http_status||result.error||'probe failure'}); no new benchmark volume allocated. Evidence: ${file}`);
  return {file,...result};
}
