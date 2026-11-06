import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const prefix=process.argv[2];assert(/^[a-z0-9-]+$/.test(prefix||''));
const scenario=process.argv[3]||null;assert([null,'relational-write','jsonb-write'].includes(scenario));
const waits=process.argv[4]==='--waits';assert(process.argv[4]===undefined||waits);
const outputPrefix=scenario?prefix+'-'+scenario:prefix;
const root='neon/tests/reports/local',record=JSON.parse(fs.readFileSync(`${root}/${prefix}.json`));
assert.equal(record.status,'RUNNING');assert(/^neon-pg18-benchmark-[a-f0-9]{8}$/.test(record.container));
const source=fs.readFileSync('neon/tests/neon/performance/role_cpu_probe.py','utf8');
const sourceFile=`${root}/${outputPrefix}-role-cpu-probe.py`;
fs.writeFileSync(sourceFile,source);
const child=spawnSync('docker',['exec','-i',...(scenario?['--env','NEON_CPU_PROBE_SCENARIO='+scenario]:[]),...(waits?['--env','NEON_CPU_PROBE_WAITS=1']:[]),
  ...(record.resource_profile==='compute8-storage8'?['--env','NEON_CPU_PROBE_PIN_COMPUTE=1']:[]),record.container,'python3','-'],{input:source,encoding:'utf8',timeout:190000});
const result={status:child.status===0?'DIAGNOSTIC':'FAILED-NO-ATTRIBUTION',image_id:record.image_id,
  container:record.container,created_at:new Date().toISOString(),source_file:sourceFile,source_sha256:createHash('sha256').update(source).digest('hex'),
  data:child.status===0?JSON.parse(child.stdout):null,error:child.status===0?null:child.stderr};
fs.writeFileSync(`${root}/${outputPrefix}-role-cpu.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
process.exitCode=child.status===0?0:1;
