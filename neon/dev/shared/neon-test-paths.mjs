// Resolve uniquely named harness inputs without depending on their category.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const files=new Map();
function visit(directory){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink()||entry.name==='__pycache__')continue;
    const file=directory+'/'+entry.name;
    if(entry.isDirectory())visit(file);
    else if(entry.isFile()){
      files.set(entry.name,[...(files.get(entry.name)??[]),file]);
    }
  }
}
visit('neon/tests/neon');
export function neonTestPath(name){
  assert.equal(path.basename(name),name,'Expected a harness filename');
  assert(files.has(name),'Unknown Neon harness input: '+name);
  const matches=files.get(name);
  assert.equal(matches.length,1,'Ambiguous Neon harness filename: '+name);
  return matches[0];
}
