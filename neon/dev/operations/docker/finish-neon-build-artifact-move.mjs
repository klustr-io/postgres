// Finish the verified, database-free artifact relocation without changing
// unsupported attributes on legacy Windows source copies.
import {readdirSync,readFileSync,writeFileSync,existsSync,mkdirSync,createReadStream,
  createWriteStream,renameSync,symlinkSync,lstatSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const workspace=path.resolve('.');assert.equal(workspace,'C:\\code\\CORE\\postgres');
const source=path.join(workspace,'build');
const destination='D:\\code-artifacts\\postgres-neon-qualification-20261030\\build';
assert(existsSync(destination));assert(!lstatSync(source).isSymbolicLink());
const stamp=new Date().toISOString().replaceAll(/[^0-9]/g,'');
const legacy=path.join(workspace,'build-retained-legacy-'+stamp);
assert.equal(path.dirname(legacy),workspace);assert(!existsSync(legacy));
const hash=async file=>{const value=createHash('sha256');for await(const part of createReadStream(file))value.update(part);return value.digest('hex');};
const proof={status:'VERIFYING',source_path:source,artifact_path:destination,legacy_metadata_copy:legacy,
  docker_volumes_moved:false,database_files_moved:false,remaining_files:[]};
const record='neon/tests/reports/local/neon-build-artifact-storage.json';
const save=()=>writeFileSync(record,JSON.stringify(proof,null,2)+'\n');save();
async function copy(folder) {
  for(const item of readdirSync(folder,{withFileTypes:true})) {
    assert(!item.isSymbolicLink(),'Refuse unexpected nested links');
    const from=path.join(folder,item.name),relative=path.relative(source,from),to=path.join(destination,relative);
    assert(!relative.startsWith('..')&&path.resolve(to).startsWith(destination+path.sep));
    if(item.isDirectory()){mkdirSync(to,{recursive:true});await copy(from);continue;}
    assert(item.isFile());assert(!['PG_VERSION','postmaster.pid','pg_control'].includes(item.name));
    const expected=await hash(from);
    if(!existsSync(to)||await hash(to)!==expected) {
      if(existsSync(to))renameSync(to,to+'.interrupted-copy-'+stamp);
      await pipeline(createReadStream(from),createWriteStream(to,{flags:'wx'}));
    }
    assert.equal(await hash(to),expected,'Artifact copy changed bytes');
    proof.remaining_files.push({relative,sha256:expected});
  }
}
await copy(source);save();
// This same-volume rename keeps every troublesome original attribute intact.
renameSync(source,legacy);
try {symlinkSync(destination,source,'junction');}
catch(error){renameSync(legacy,source);throw error;}
assert.equal(readFileSync(path.join(source,'neon-runtime-context-path'),'utf8').trim(),'build\\neon-clean-context-1AVs99');
proof.status='PASS';proof.completed_at=new Date().toISOString();save();
console.log(`PASS build paths restored through junction; ${proof.remaining_files.length} remaining files byte-verified; legacy originals retained`);
