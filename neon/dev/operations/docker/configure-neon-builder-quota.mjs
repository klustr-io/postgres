// Limit only our isolated builder's future workers, never existing workloads.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const record=JSON.parse(fs.readFileSync('neon/tests/reports/local/neon-isolated-disk-builder.json','utf8'));
assert(record.status==='PASS'&&/^neon-pg18-disk-[a-f0-9]{8}$/.test(record.name));
const docker=process.env.DOCKER||'docker',container='buildx_buildkit_'+record.node;
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',...options});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const processNames=run(docker,['top',container,'-eo','pid,comm']);
assert(!processNames.split(/\r?\n/).some(s=>s.trim().endsWith(' buildkit-runc')),'Finish all active worker jobs first');
const group='neon-pg18-bench-'+record.name.slice(-8),directory='/sys/fs/cgroup/'+group;
const script=`set -eu
group="$1"
test ! -e "$group"
mkdir "$group"
printf '%s' '80000 10000' > "$group/cpu.max"
printf '%s' '17179869184' > "$group/memory.max"
printf '%s' '0' > "$group/memory.swap.max"
printf '%s' '+cpu +memory +io' > "$group/cgroup.subtree_control"
cat "$group/cpu.max" "$group/memory.max" "$group/memory.swap.max"
`;
const output=run('wsl',['-d','docker-desktop','-u','root','--','sh','-s','--',directory],{input:script});
const config=path.join(record.root,'builder-inputs','quota-buildkitd.toml');
fs.writeFileSync(config,`[worker.oci]\n  defaultCgroupParent = "${group}"\n`);
run(docker,['cp',config,container+':/etc/buildkit/buildkitd.toml']);
run(docker,['restart','--timeout','30',container]);
run(docker,['buildx','inspect',record.name,'--bootstrap']);
const proof={status:'CONFIGURED-NOT-YET-WORKER-VERIFIED',builder:record.name,container,cgroup:directory,
  cpu_max:'80000 10000',memory_max:17179869184,memory_swap_max:0,configuration:config,
  setup_output:output,only_owned_builder_restarted:true,other_containers_stopped:false,created_at:new Date().toISOString()};
fs.writeFileSync('neon/tests/reports/local/neon-builder-quota.json',JSON.stringify(proof,null,2)+'\n');
console.log('Configured only the owned D: builder worker quota; verify it inside a worker before measuring performance');
