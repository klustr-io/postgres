// Run with the same Node executable as the Docker companion tooling.
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const directory=new URL('../../',import.meta.url);
let count=0;
function visit(directory) {
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    if(entry.isSymbolicLink()||['.venv','__pycache__'].includes(entry.name)) continue;
    const source=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
    if(entry.isDirectory()) visit(source);
    else if(entry.isFile()&&entry.name.endsWith('.mjs')) {
      const result=spawnSync(process.execPath,['--check',fileURLToPath(source)],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      count++;
    }
  }
}
visit(directory);
console.log(`Node syntax checks passed for ${count} files.`);
