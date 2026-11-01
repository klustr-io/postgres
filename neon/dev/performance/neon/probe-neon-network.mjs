import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [prefix,scenario]=process.argv.slice(2);assert(/^[a-z0-9-]+$/.test(prefix||''));
assert(['relational-write','jsonb-write'].includes(scenario));
const root='neon/tests/reports/local',record=JSON.parse(fs.readFileSync(`${root}/${prefix}.json`));
assert.equal(record.status,'RUNNING');assert(/^neon-pg18-benchmark-[a-f0-9]{8}$/.test(record.container));
const source=fs.readFileSync('neon/tests/neon/performance/network_probe.py','utf8'),sourceFile=`${root}/${prefix}-${scenario}-network-probe.py`;
fs.writeFileSync(sourceFile,source);
const result=spawnSync('docker',['exec','-i','--env','NEON_NETWORK_PROBE_SCENARIO='+scenario,
  ...(record.resource_profile==='compute8-storage8'?['--env','NEON_CPU_PROBE_PIN_COMPUTE=1']:[]),
  record.container,'python3','-B','-'],{input:source,encoding:'utf8',timeout:365000});
const report={status:result.status===0?'DIAGNOSTIC':'FAILED-NO-ATTRIBUTION',container:record.container,image_id:record.image_id,
  created_at:new Date().toISOString(),source_file:sourceFile,source_sha256:createHash('sha256').update(source).digest('hex'),
  data:result.status===0?JSON.parse(result.stdout):null,error:result.status===0?null:result.stderr};
fs.writeFileSync(`${root}/${prefix}-${scenario}-network.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));process.exitCode=result.status===0?0:1;
