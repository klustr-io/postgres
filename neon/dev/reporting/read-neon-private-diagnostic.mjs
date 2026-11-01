// Read only an owned fixture log/PID file; redact local credential values before
// displaying anything. Never print its environment, private configuration or tar.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {localConfiguration} from '../shared/neon-qualification-config.mjs';
const [container,relative,pattern]=process.argv.slice(2);
assert(pattern===undefined||pattern.length<=200);
assert(/^neon-pg18-benchmark-[a-f0-9]{8}$/.test(container||''));
assert(/^[a-zA-Z0-9_/.-]+\.(log|pid)$/.test(relative||'')&&!relative.includes('..'));
const r=spawnSync('docker',['cp',`${container}:/var/lib/neon/comparison/${relative}`,'-'],{maxBuffer:32*1024**2});
assert.equal(r.status,0,r.stderr.toString());let bytes=Buffer.alloc(0);
for(let offset=0;offset+512<=r.stdout.length;){
  const header=r.stdout.subarray(offset,offset+512);
  if(header.every(byte=>byte===0))break;
  const size=parseInt(header.subarray(124,136).toString().replace(/\0/g,'').trim()||'0',8);
  assert(Number.isSafeInteger(size)&&size>=0);const type=header.subarray(156,157).toString();
  if(type==='0'||type==='\0')bytes=r.stdout.subarray(offset+512,offset+512+size);
  offset+=512+Math.ceil(size/512)*512;
}
if(relative.endsWith('.pid'))console.log(JSON.stringify({bytes:bytes.length,valid_pid:/^[1-9][0-9]*$/.test(bytes.toString()),sha256:createHash('sha256').update(bytes).digest('hex')}));
else{
  let body=bytes.toString();for(const [name,value] of Object.entries(localConfiguration()))
    if(/secret|password|token|access_key/i.test(name)&&value.length>3)body=body.replaceAll(value,'[redacted]');
  body=body.replace(/\b(?:https?|wss?|postgres(?:ql)?|redis):\/\/[^\s"']+/g,'[redacted URL]');
  if(pattern) {
    const match=new RegExp(pattern,'i'),lines=body.split('\n'),selected=new Set();
    for(let i=0;i<lines.length;i++)if(match.test(lines[i]))for(const n of [i-1,i,i+1])if(n>=0&&n<lines.length)selected.add(n);
    body=[...selected].sort((a,b)=>a-b).map(i=>lines[i]).join('\n');
  }
  console.log(body.slice(-8000));
}
