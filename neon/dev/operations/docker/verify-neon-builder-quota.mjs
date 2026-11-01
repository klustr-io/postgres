import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const builder=read('neon/tests/reports/local/neon-isolated-disk-builder.json'),file='neon/tests/reports/local/neon-builder-quota.json',quota=read(file);
assert.equal(quota.builder,builder.name);
const input=fs.mkdtempSync(path.join(builder.root,'quota-probe-')),output=input+'-output';
const probe=`import json,os,time
from pathlib import Path
root=Path(${JSON.stringify(quota.cgroup)})
pid=os.getpid()
members=[str(p.parent) for p in root.rglob('cgroup.procs') if str(pid) in p.read_text().split()]
value={'pid':pid,'proc_cgroup':Path('/proc/self/cgroup').read_text(),'own_membership':members,
       'root_cpu_max':Path('/sys/fs/cgroup/cpu.max').read_text().strip(),
       'scope':str(root),'cpu_max':(root/'cpu.max').read_text().strip(),
       'memory_max':(root/'memory.max').read_text().strip(),
       'memory_swap_max':(root/'memory.swap.max').read_text().strip()}
assert members and value['cpu_max']=='80000 10000' and value['memory_max']=='17179869184' and value['memory_swap_max']=='0'
Path('/tmp/quota.json').write_text(json.dumps(value,indent=2)+'\\n')
print(json.dumps(value))
`;
fs.writeFileSync(path.join(input,'probe.py'),probe);
const frontend=fs.readFileSync('neon/packaging/docker/neon/overlays/Dockerfile.commit-guard','utf8').split(/\r?\n/)[0];
fs.writeFileSync(path.join(input,'Dockerfile'),frontend+'\nFROM guard-benchmark AS probe\nCOPY probe.py /tmp/probe.py\nRUN python3 /tmp/probe.py\nFROM scratch\nCOPY --from=probe /tmp/quota.json /quota.json\n');
const r=spawnSync(process.env.DOCKER||'docker',['buildx','build','--builder',builder.name,'--progress=plain',
  '--build-context',builder.contexts['guard-benchmark'].argument,'--output',`type=local,dest=${output}`,input],{encoding:'utf8'});
assert.equal(r.status,0,r.stderr);
quota.worker=read(path.join(output,'quota.json'));assert(quota.worker.own_membership.length>0);
quota.status='VERIFIED-WORKER-QUOTA';quota.verified_at=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(quota,null,2)+'\n');
console.log(JSON.stringify(quota.worker,null,2));
