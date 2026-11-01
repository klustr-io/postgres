// Reversibly compress redundant generated source exports; never touches DB data.
import {readFileSync,writeFileSync,createReadStream,createWriteStream,readdirSync,
  existsSync,realpathSync,statfsSync,statSync,renameSync,unlinkSync} from 'node:fs';
import {createGzip,createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const build=realpathSync('build'),file='neon/tests/reports/local/neon-source-context-archive.json';
const read=name=>JSON.parse(readFileSync(name,'utf8'));
const manifest=existsSync(file)?read(file):{status:'RUNNING',scope:'Generated source-export tar files only; all bytes retained in verified gzip archives',entries:[]};
const save=()=>writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
const digest=async (name,unzip=false)=>{
  const hash=createHash('sha256');let bytes=0;
  const input=unzip?createReadStream(name).pipe(createGunzip()):createReadStream(name);
  for await(const part of input){hash.update(part);bytes+=part.length;}
  return {sha256:hash.digest('hex'),bytes};
};
function checked(relative) {
  const absolute=path.resolve(relative),parent=realpathSync(path.dirname(absolute));
  assert(parent.startsWith(build+path.sep));
  assert(/^neon-clean-context-[A-Za-z0-9]+$/.test(path.basename(parent)));
  assert(/^(runtime|postgres-v1[4-8])\.tar(?:\.gz)?(?:\.[a-z0-9-]+\.tmp)?$/.test(path.basename(absolute)));
  return path.join(parent,path.basename(absolute));
}
if(process.argv.includes('--restore')) {
  for(const entry of manifest.entries) {
    const original=checked(entry.original),compressed=checked(entry.compressed);
    if(existsSync(original)){assert.equal((await digest(original)).sha256,entry.sha256);continue;}
    assert.equal((await digest(compressed,true)).sha256,entry.sha256);
    const temporary=checked(entry.original+'.'+randomUUID()+'.tmp');
    await pipeline(createReadStream(compressed),createGunzip(),createWriteStream(temporary,{flags:'wx'}));
    assert.deepEqual(await digest(temporary),{sha256:entry.sha256,bytes:entry.original_bytes});
    assert(!existsSync(original));renameSync(temporary,original);entry.status='RESTORED';save();
  }
  manifest.status='RESTORED';save();console.log('PASS exact source archives restored; gzip copies retained');
} else {
  const keep=new Set([realpathSync(readFileSync('build/neon-runtime-context-path','utf8').trim()),
    realpathSync(read('neon/tests/reports/local/neon-independent-source-comparison.json').independent_export.context)]);
  for(const directory of readdirSync(build,{withFileTypes:true}).filter(item=>item.isDirectory()&&/^neon-clean-context-[A-Za-z0-9]+$/.test(item.name))) {
    const folder=realpathSync(path.join(build,directory.name));
    if(keep.has(folder)||!existsSync(path.join(folder,'sources.json')))continue;
    const sources=read(path.join(folder,'sources.json'));
    for(const source of Object.values(sources.sources)) {
      if(statfsSync('.').bavail*statfsSync('.').bsize>=24*1024**3)break;
      if(!/^(runtime|postgres-v1[4-8])\.tar$/.test(source.archive))continue;
      const original=checked(path.join(folder,source.archive));
      if(!existsSync(original))continue;
      const initial=await digest(original);assert.equal(initial.sha256,source.sha256,'Generated archive changed; refusing to replace it');
      const compressed=checked(original+'.gz');
      let entry=manifest.entries.find(item=>path.resolve(item.original)===original);
      if(!existsSync(compressed)) {
        const temporary=checked(original+'.gz.'+randomUUID()+'.tmp');
        await pipeline(createReadStream(original),createGzip({level:1}),createWriteStream(temporary,{flags:'wx'}));
        assert.deepEqual(await digest(temporary,true),initial,'Compression roundtrip changed source bytes');
        renameSync(temporary,compressed);
      } else assert.deepEqual(await digest(compressed,true),initial);
      if(!entry){entry={original:path.relative(process.cwd(),original),compressed:path.relative(process.cwd(),compressed),
        sha256:initial.sha256,original_bytes:initial.bytes,compressed_bytes:statSync(compressed).size};manifest.entries.push(entry);}
      entry.status='VERIFIED-RAW-PRESENT';save();
      // Only a whitelisted, manifest-matched generated TAR is removed, after
      // its exact bytes have been retained and independently decompressed.
      assert(!keep.has(realpathSync(path.dirname(original))));unlinkSync(original);
      entry.status='ARCHIVED';save();console.log(`Archived ${entry.original}`);
    }
  }
  manifest.status='ARCHIVED';manifest.generated_at=new Date().toISOString();save();
  console.log(`PASS ${manifest.entries.length} generated archives retained losslessly; current primary/independent contexts untouched`);
}
