import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceProvenance} from '../../shared/source-provenance.mjs';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..'));
function run(program,args) {
  const result=spawnSync(program,args,{stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status !== 0) process.exit(result.status ?? 1);
}
if(process.platform==='win32') run(process.execPath,['neon/dev/build/postgres/image-context.mjs']);
else run('python3',['neon/dev/build/postgres/image-context.py']);
const version=readFileSync('configure.ac','utf8').match(/AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]/)[1];
const provenance=sourceProvenance();
const revision=provenance.base_sha;
const patchHash=provenance.sha256;
const context=readFileSync('build/oci-context-path','utf8').trim();
if(process.argv[2]==='test-client') {
  run(process.env.DOCKER || 'docker',['build','--platform','linux/amd64','-f',`${context}/neon/packaging/docker/test-client/Dockerfile`,
    '-t',process.env.PG_TEST_IMAGE || `klustr-postgres:${version}-test`,context]);
} else {
  run(process.env.DOCKER || 'docker',['build','--platform','linux/amd64','--build-arg',`SOURCE_REVISION=${revision}`,
    '--build-arg',`SOURCE_PATCH_SHA256=${patchHash}`,
    '--build-arg',`PG_VERSION=${version}`,'--build-arg',`BUILD_JOBS=${process.env.BUILD_JOBS || 4}`,
    '-f',`${context}/neon/packaging/docker/postgres/Dockerfile`,'-t',process.env.PG_IMAGE || `klustr-postgres:${version}-dev`,context]);
}
