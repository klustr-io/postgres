// Online swap discard plus relocation of verified generated build duplicates.
// No Docker volume, database file, image or unrelated workload is removed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const file='neon/tests/reports/local/neon-host-headroom-recovery.json';
const free=()=>{const d=fs.statfsSync('C:/');return d.bavail*d.bsize;};
const record={started_at:new Date().toISOString(),status:'RUNNING',before_c_free_bytes:free(),docker_volumes_changed:false,database_files_changed:false};
const save=()=>fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');save();
function wsl(args,input) {const r=spawnSync('wsl',['-d','docker-desktop','-u','root','--',...args],{encoding:'utf8',input});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const memory=Object.fromEntries(wsl(['cat','/proc/meminfo']).split('\n').map(s=>{const m=s.match(/^(\w+):\s*(\d+)/);return m?[m[1],Number(m[2])*1024]:null;}).filter(Boolean));
const swap=wsl(['cat','/proc/swaps']).split('\n').slice(1).map(s=>s.split(/\s+/)).find(s=>s[0]==='/dev/sdc');
assert(swap&&Number(swap[2])===16777216);
assert(memory.MemAvailable>Number(swap[3])*1024+16*1024**3,'Need swap residency plus 16 GiB memory headroom');
assert.equal(wsl(['blkid','-s','TYPE','-o','value','/dev/sdc']),'swap');
assert.equal(Number(wsl(['blockdev','--getsize64','/dev/sdc'])),17179873280);
assert(Number(wsl(['cat','/sys/block/sdc/queue/discard_max_bytes']))>0);
record.swap={device:'/dev/sdc',type:'swap',used_bytes:Number(swap[3])*1024,available_memory_bytes:memory.MemAvailable};save();
record.swap.output=wsl(['sh','-s'],`set -eu
swapoff /dev/sdc
if ! swapon --discard=once /dev/sdc; then
  swapon /dev/sdc
  exit 1
fi
cat /proc/swaps
`);
record.after_swap_c_free_bytes=free();save();
const source='C:/code/CORE/postgres/build-retained-legacy-20261030121420407';
const destination='D:/code-artifacts/postgres-neon-qualification-20261030/retained-legacy-build-20261030121420407';
assert.equal(fs.realpathSync(source).toLowerCase(),path.resolve(source).toLowerCase());
assert(path.resolve(source).toLowerCase().startsWith('c:\\code\\core\\postgres\\build-retained-legacy-'));
assert(path.resolve(destination).toLowerCase().startsWith('d:\\code-artifacts\\postgres-neon-qualification-20261030\\retained-legacy-build-'));
assert(!fs.existsSync(destination));
const files=[],directories=[];
function walk(p) {directories.push(p);for(const entry of fs.readdirSync(p,{withFileTypes:true})) {
  const f=path.join(p,entry.name);assert(!fs.lstatSync(f).isSymbolicLink());
  assert(!['PG_VERSION','postmaster.pid','pg_control'].includes(entry.name),'Refuse database directories');
  if(entry.isDirectory())walk(f);else{assert(entry.isFile());files.push(f);}
}}
walk(source);fs.mkdirSync(destination);
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let bytes=0;
for(const f of files) {
  const target=path.join(destination,path.relative(source,f));
  assert(path.resolve(target).startsWith(path.resolve(destination)+path.sep));
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(f,target,fs.constants.COPYFILE_EXCL);
  assert.equal(hash(f),hash(target));bytes+=fs.statSync(f).size;fs.unlinkSync(f);
}
for(const d of directories.reverse())fs.rmdirSync(d);
record.legacy={source,destination,files:files.length,bytes,sha256_verified_before_unlink:true};
record.after_c_free_bytes=free();record.status='PASS';record.completed_at=new Date().toISOString();save();
console.log(JSON.stringify({status:record.status,before_c_free_gib:record.before_c_free_bytes/1024**3,
  after_swap_c_free_gib:record.after_swap_c_free_bytes/1024**3,after_c_free_gib:record.after_c_free_bytes/1024**3,
  generated_files_moved:files.length,database_files_changed:false,docker_volumes_changed:false}));
