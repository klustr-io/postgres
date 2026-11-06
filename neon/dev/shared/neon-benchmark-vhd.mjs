// Fresh native ext4 VHD: bypass host-file sharing, preserve every existing disk.
import {spawnSync} from 'node:child_process';
import {mkdirSync,realpathSync,writeFileSync,readFileSync,statfsSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
function run(command,args,options={}) {
  const child=spawnSync(command,args,{encoding:'utf8',...options});
  assert.equal(child.status,0,child.stderr||child.stdout);return child.stdout.replaceAll('\0','').trim();
}
function devices(){return JSON.parse(run('wsl',['-d','docker-desktop','-u','root','--','lsblk','-J','-b','-d','-o','PATH,SIZE,TYPE,FSTYPE,MOUNTPOINTS'])).blockdevices;}
export function reattachBenchmarkVhdVolume(metadata) {
  metadata=realpathSync(metadata);const record=JSON.parse(readFileSync(metadata,'utf8'));
  assert.equal(record.provider,'docker-desktop-ext4-vhd');
  assert.equal(realpathSync(record.file)+'.json',metadata);
  assert(/^[a-f0-9-]{36}$/.test(record.filesystem_uuid));
  assert.equal(record.device,'/dev/neon-qualification/'+record.filesystem_uuid);
  const identity=JSON.parse(run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('neon/dev/operations/docker/new-neon-benchmark-vhd.ps1'),'-VhdPath',record.file,'-InspectOnly',...(record.system_drive_opt_in?['-AllowSystemDrive']:[])]));
  assert.equal(identity.Size,record.virtual_bytes);assert.equal(identity.DiskIdentifier,record.vhd_identity.DiskIdentifier);
  const volume=JSON.parse(run(process.env.DOCKER||'docker',['volume','inspect',record.volume]))[0];
  assert.equal(volume.Labels['io.klustr.filesystem-uuid'],record.filesystem_uuid);
  assert.equal(volume.Options.device,record.device);assert.equal(volume.Options.type,'ext4');
  assert([64,96].some(gib=>record.virtual_bytes===gib*1024**3),'Unreviewed retained VHD size');
  const present=spawnSync('wsl',['-d','docker-desktop','-u','root','--','blkid','-U',record.filesystem_uuid],{encoding:'utf8'});
  if(present.status!==0)run('wsl',['--mount','--vhd',record.file,'--bare']);
  const script=`set -eu
uuid="$1"; alias="$2"
target=$(blkid -U "$uuid")
test -b "$target"
test "$(blockdev --getsize64 "$target")" = "$3"
mkdir -p /dev/neon-qualification
if test -e "$alias" || test -L "$alias"; then
  test "$(readlink "$alias")" = "$target"
else
  ln -s "$target" "$alias"
fi
test "$(blkid -s UUID -o value "$alias")" = "$uuid"
`;
  run('wsl',['-d','docker-desktop','-u','root','--','sh','-s','--',record.filesystem_uuid,record.device,String(record.virtual_bytes)],{input:script});
  console.log(`PASS reattached native VHD ${record.volume}; VHD identity and filesystem UUID verified; no formatting`);
}
export function createBenchmarkVhdVolume({root,volume,image,docker='docker',allowSystemDrive=false}) {
  assert.equal(process.platform,'win32');assert(/^neon-pg18-benchmark-[a-f0-9]{8}-data$/.test(volume));
  assert(path.isAbsolute(root));mkdirSync(root,{recursive:true});root=realpathSync(root);
  const systemDrive=allowSystemDrive&&/^c:\\code-artifacts\\neon-qualified-benchmarks\\benchmark-vhds$/i.test(root);
  assert(/^[d-z]:/i.test(root)||systemDrive);const free=statfsSync(root);assert(free.bavail*free.bsize>40*1024**3,'VHD root needs 40 GiB free');
  const existing=spawnSync(docker,['volume','inspect',volume],{encoding:'utf8'});assert.notEqual(existing.status,0,'Existing volume must not be reused');
  const uid=Number(run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','id',image,'-u']));
  const gid=Number(run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','id',image,'-g']));
  assert(uid>0&&gid>0);
  const file=path.join(root,volume+'.vhdx'),metadata=file+'.json',uuid=randomUUID();assert(!existsSync(file));
  const before=devices();
  const vhd=JSON.parse(run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('neon/dev/operations/docker/new-neon-benchmark-vhd.ps1'),'-VhdPath',file,...(systemDrive?['-AllowSystemDrive']:[])]));
  assert.equal(vhd.Size,64*1024**3);assert.equal(vhd.VhdType,3); // Hyper-V Dynamic enum.
  const record={status:'EXCLUSIVE-NEW-VHD',provider:'docker-desktop-ext4-vhd',volume,file,metadata,
    system_drive_opt_in:Boolean(systemDrive),
    filesystem_uuid:uuid,device:'/dev/neon-qualification/'+uuid,virtual_bytes:vhd.Size,vhd_identity:vhd,
    uid,gid,created_at:new Date().toISOString(),before_devices:before,
    limitation:'Native ext4 on a fresh host VHD; one local host, not independent failure domains.'};
  const save=()=>writeFileSync(metadata,JSON.stringify(record,null,2)+'\n');save();
  record.attach_output=run('wsl',['--mount','--vhd',file,'--bare']);record.after_devices=devices();save();
  const added=record.after_devices.filter(row=>!before.some(old=>old.path===row.path));
  assert.equal(added.length,1,'Require exactly one newly attached block device; otherwise do not format');
  const target=added[0];assert.equal(target.type,'disk');assert.equal(target.size,vhd.Size);
  assert(!target.fstype&&!target.mountpoints.some(Boolean));assert(/^\/dev\/sd[a-z]+$/.test(target.path));
  record.block_device=target.path;save();
  const script=`set -eu
target="$1"; uuid="$2"; uid="$3"; gid="$4"; alias="$5"
test -b "$target"
test "$(blockdev --getsize64 "$target")" = 68719476736
test -z "$(wipefs -n "$target")"
test -z "$(findmnt -rn -S "$target")"
# Only the one newly attached, blank device from the exclusive NEW VHD.
mkfs.ext4 -q -b 4096 -m 0 -U "$uuid" -E "root_owner=$uid:$gid,lazy_itable_init=0,lazy_journal_init=0" "$target"
test "$(blkid -s UUID -o value "$target")" = "$uuid"
mkdir -p /dev/neon-qualification
test ! -e "$alias" && test ! -L "$alias"
ln -s "$target" "$alias"
test "$(blkid -s UUID -o value "$alias")" = "$uuid"
`;
  record.format_output=run('wsl',['-d','docker-desktop','-u','root','--','sh','-s','--',target.path,uuid,String(uid),String(gid),record.device],{input:script,timeout:180000});
  record.status='FORMATTED-ATTACHED';save();
  run(docker,['volume','create','--label','io.klustr.purpose=pg18-performance-comparison','--label',`io.klustr.filesystem-uuid=${uuid}`,
    '--driver','local','--opt','type=ext4','--opt',`device=${record.device}`,'--opt','o=rw',volume]);
  record.probe_output=run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--mount',`type=volume,source=${volume},target=/probe`,'--entrypoint','python3',image,'-c',
    'import os,time; p="/probe/retained-write-probe"; f=open(p,"xb"); t=time.monotonic(); f.write(b"native ext4 VHD probe\\n"); f.flush(); os.fsync(f.fileno()); f.close(); assert open(p,"rb").read()==b"native ext4 VHD probe\\n"; print(time.monotonic()-t)']);
  record.status='PASS';save();console.log(`New retained native VHD filesystem: ${file} (UUID ${uuid})`);return record;
}
