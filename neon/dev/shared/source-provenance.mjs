import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const paths=['src','contrib','configure','configure.ac','meson.build','meson_options.txt'];
function git(args) {
  const result=spawnSync('git',['-c','core.autocrlf=true',...args],{encoding:'utf8',maxBuffer:32*1024*1024});
  assert.equal(result.status,0,result.stderr);
  return result.stdout;
}
export function sourceProvenance() {
  const diff=git(['diff','--binary','HEAD','--',...paths]);
  const added=git(['ls-files','--others','--exclude-standard','--',...paths]).trim().split('\n').filter(Boolean).sort().map(name=>{
    const raw=readFileSync(name);
    const content=raw.includes(0) ? raw : Buffer.from(raw.toString('utf8').replaceAll('\r\n','\n'));
    return {path:name,sha256:createHash('sha256').update(content).digest('hex')};
  });
  const sha256=(!diff && !added.length) ? 'none' : createHash('sha256').update(JSON.stringify({diff,added})).digest('hex');
  return {base_sha:git(['rev-parse','HEAD']).trim(),sha256,diff,added};
}
