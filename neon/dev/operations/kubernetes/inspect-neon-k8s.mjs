// Diagnostics for this repository's isolated qualification namespace only.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {localConfiguration} from '../../shared/neon-qualification-config.mjs';
const values=localConfiguration();
const report=JSON.parse(readFileSync('neon/tests/reports/local/neon-kubernetes-acceptance.json','utf8'));
if(!report.namespace.startsWith('neon-pg18-qualification-')) throw new Error('Unexpected namespace');
const pod=process.argv[2] || 'primary';
const base=['--kubeconfig',values.NEON_K8S_KUBECONFIG,'-n',report.namespace];
const redact=text=>{
  for(const [key,value] of Object.entries(values)) if(/SECRET|PASSWORD|ACCESS_KEY|TOKEN/.test(key)&&value) text=text.split(value).join('[REDACTED]');
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]');
};
const run=args=>{
  const result=spawnSync('kubectl',[...base,'exec',pod,'--',...args],{encoding:'utf8',maxBuffer:8*1024*1024});
  return result.status===0?result.stdout:'';
};
const files=run(['find','/var/lib/neon/acceptance-logs','-maxdepth','1','-type','f']).trim().split('\n');
for(const file of files.filter(name=>/local-start|start-|init-/.test(name)).slice(-4)) {
  console.log(file);console.log(redact(run(['tail','-n','22',file])));
}
const services=run(['find','/var/lib/neon/cluster','-maxdepth','4','-name','*.log']).trim().split('\n');
for(const file of services.filter(name=>/pageserver|safekeeper|storage_broker|storage_controller/.test(name)).slice(0,6)) {
  console.log(file);console.log(redact(run(['tail','-n','14',file])));
}
console.log(redact(run(['python3','-c',
  'import json,socket,urllib.parse; c=json.load(open("/run/secrets/neon-s3/config.json")); u=urllib.parse.urlsplit(c["endpoint"]); print("S3 DNS:",socket.getaddrinfo(u.hostname,u.port or 443))'])));
