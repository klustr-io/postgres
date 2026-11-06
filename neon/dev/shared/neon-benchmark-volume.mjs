// Optional, retained benchmark filesystems outside Docker Desktop's C: data VHD.
// Never formats an existing file, device, volume, or database.
import {spawnSync} from 'node:child_process';
import {mkdirSync,realpathSync,openSync,ftruncateSync,closeSync,writeFileSync,statfsSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export function createBenchmarkVolume({root,volume,image,docker='docker'}) {
  assert.equal(process.platform,'win32','External loopback benchmark storage currently supports Windows Docker Desktop only');
  assert(/^neon-pg18-benchmark-[a-f0-9]{8}-data$/.test(volume));
  const existing=spawnSync(docker,['volume','inspect',volume],{encoding:'utf8'});
  assert.notEqual(existing.status,0,'Refuse to reuse an existing Docker volume');
  assert(path.isAbsolute(root),'Benchmark volume root must be absolute');
  mkdirSync(root,{recursive:true});root=realpathSync(root);
  const drive=root.slice(0,1).toLowerCase();
  assert(/^[d-z]$/.test(drive),'Use a secondary drive for this optional provider');
  const free=statfsSync(root);assert(free.bavail*free.bsize>40*1024**3,'External volume root needs 40 GiB free');
  const identity=spawnSync(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--entrypoint','id',image,'-u'],{encoding:'utf8'});
  assert.equal(identity.status,0,identity.stderr);const uid=Number(identity.stdout.trim());assert(uid>0);
  const gidResult=spawnSync(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--entrypoint','id',image,'-g'],{encoding:'utf8'});
  assert.equal(gidResult.status,0,gidResult.stderr);const gid=Number(gidResult.stdout.trim());assert(gid>0);
  const uuid=randomUUID(),file=path.join(root,volume+'.ext4'),bytes=32*1024**3;
  const linuxFile='/mnt/host/'+drive+file.slice(2).replaceAll('\\','/');
  const device='/dev/neon-qualification/'+uuid;
  const record={status:'EXCLUSIVE-NEW-FILE',provider:'docker-desktop-ext4-loop',volume,file,linux_file:linuxFile,
    filesystem_uuid:uuid,device,bytes,uid,gid,created_at:new Date().toISOString(),
    limitation:'Host-shared backing file; not production storage or an independent failure domain. Retain the backing file and volume.'};
  const metadata=file+'.json',save=()=>writeFileSync(metadata,JSON.stringify(record,null,2)+'\n');
  // wx is essential: formatting is authorized ONLY after exclusive file creation.
  const fd=openSync(file,'wx');try{ftruncateSync(fd,bytes);}finally{closeSync(fd);}save();
  const script=`set -eu
file="$1"; uuid="$2"; uid="$3"; gid="$4"; alias="$5"
test -f "$file" && test ! -L "$file"
test "$(stat -c %s "$file")" = 34359738368
# Exclusive newly-created file only; never mkfs a loop device or existing volume.
mkfs.ext4 -q -F -b 4096 -m 0 -U "$uuid" -E "root_owner=$uid:$gid,lazy_itable_init=0,lazy_journal_init=0" "$file"
test "$(blkid -s UUID -o value "$file")" = "$uuid"
loop=$(losetup --find --show --nooverlap "$file")
test "$(blkid -s UUID -o value "$loop")" = "$uuid"
mkdir -p /dev/neon-qualification
test ! -e "$alias" && test ! -L "$alias"
ln -s "$loop" "$alias"
test "$(blkid -s UUID -o value "$alias")" = "$uuid"
printf '%s\\n' "$loop"
`;
  const setup=spawnSync('wsl',['-d','docker-desktop','-u','root','--','sh','-s','--',linuxFile,uuid,String(uid),String(gid),device],
    {input:script,encoding:'utf8',timeout:180000});
  record.setup_stdout=setup.stdout;record.setup_stderr=setup.stderr;record.status=setup.status===0?'FORMATTED-ATTACHED':'SETUP-FAILED';save();
  assert.equal(setup.status,0,setup.stderr);
  const create=spawnSync(docker,['volume','create','--label','io.klustr.purpose=pg18-performance-comparison',
    '--label',`io.klustr.filesystem-uuid=${uuid}`,'--driver','local','--opt','type=ext4','--opt',`device=${device}`,'--opt','o=rw',volume],{encoding:'utf8'});
  assert.equal(create.status,0,create.stderr);
  const probe=spawnSync(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--mount',`type=volume,source=${volume},target=/probe`,'--entrypoint','python3',image,
    '-c','import os; p="/probe/volume-write-probe"; f=open(p,"xb"); f.write(b"retained benchmark volume probe\\n"); f.flush(); os.fsync(f.fileno()); f.close(); assert open(p,"rb").read()==b"retained benchmark volume probe\\n"; print(os.statvfs("/probe").f_bsize)'],{encoding:'utf8'});
  record.probe_stdout=probe.stdout;record.probe_stderr=probe.stderr;record.status=probe.status===0?'PASS':'PROBE-FAILED';save();
  assert.equal(probe.status,0,probe.stderr);
  console.log(`New retained benchmark filesystem: ${file} (UUID ${uuid})`);
  return {...record,metadata};
}
