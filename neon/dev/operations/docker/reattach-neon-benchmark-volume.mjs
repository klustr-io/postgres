// Reattach a retained test filesystem after Docker Desktop restarts. No mkfs.
import {spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {reattachBenchmarkVhdVolume} from '../../shared/neon-benchmark-vhd.mjs';
const metadata=realpathSync(process.argv[2]||'');
const record=JSON.parse(readFileSync(metadata,'utf8'));
if(record.provider==='docker-desktop-ext4-vhd'){reattachBenchmarkVhdVolume(metadata);process.exit(0);}
assert.equal(record.provider,'docker-desktop-ext4-loop');
assert(/^[a-f0-9-]{36}$/.test(record.filesystem_uuid));
assert.equal(record.device,'/dev/neon-qualification/'+record.filesystem_uuid);
assert.equal(realpathSync(record.file)+'.json',metadata);
assert(statSync(record.file).isFile());assert.equal(statSync(record.file).size,record.bytes);
const linuxFile='/mnt/host/'+record.file[0].toLowerCase()+record.file.slice(2).replaceAll('\\','/');
assert.equal(linuxFile,record.linux_file);assert(/^[d-z]:/i.test(record.file));
const inspect=spawnSync(process.env.DOCKER||'docker',['volume','inspect',record.volume],{encoding:'utf8'});
assert.equal(inspect.status,0,inspect.stderr);const volume=JSON.parse(inspect.stdout)[0];
assert.equal(volume.Labels['io.klustr.filesystem-uuid'],record.filesystem_uuid);
assert.equal(volume.Options.device,record.device);assert.equal(volume.Options.type,'ext4');
const script=`set -eu
file="$1"; uuid="$2"; alias="$3"
test -f "$file" && test ! -L "$file"
test "$(blkid -s UUID -o value "$file")" = "$uuid"
loop=$(losetup --find --show --nooverlap "$file")
test "$(blkid -s UUID -o value "$loop")" = "$uuid"
mkdir -p /dev/neon-qualification
if test -e "$alias" || test -L "$alias"; then
  test "$(readlink "$alias")" = "$loop"
else
  ln -s "$loop" "$alias"
fi
test "$(blkid -s UUID -o value "$alias")" = "$uuid"
printf '%s\\n' "$loop"
`;
const result=spawnSync('wsl',['-d','docker-desktop','-u','root','--','sh','-s','--',linuxFile,
  record.filesystem_uuid,record.device],{input:script,encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
console.log(`PASS reattached ${record.volume} with verified filesystem UUID ${record.filesystem_uuid}; no formatting`);
