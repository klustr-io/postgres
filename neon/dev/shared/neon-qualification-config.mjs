// Load local qualification connections without executing shell input or logging secrets.
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
export function localConfiguration() {
  return {...parseEnv(readFileSync('.env','utf8').replace(/^\uFEFF/,'')),...process.env};
}
export function s3Configuration(values=localConfiguration()) {
  const names=['ENDPOINT','ACCESS_KEY_ID','SECRET_ACCESS_KEY','REGION','BUCKET'];
  for(const name of names) assert(values[`TEST_DB_SYNC_OBJECT_STORAGE_${name}`],`Missing S3 variable: ${name}`);
  const endpoint=new URL(values.TEST_DB_SYNC_OBJECT_STORAGE_ENDPOINT);
  assert.equal(endpoint.protocol,'https:','External S3 qualification requires TLS-verified HTTPS');
  assert(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'S3 endpoint must not embed credentials or query parameters');
  return {endpoint:endpoint.href,access_key:values.TEST_DB_SYNC_OBJECT_STORAGE_ACCESS_KEY_ID,
    secret_key:values.TEST_DB_SYNC_OBJECT_STORAGE_SECRET_ACCESS_KEY,
    region:values.TEST_DB_SYNC_OBJECT_STORAGE_REGION,bucket:values.TEST_DB_SYNC_OBJECT_STORAGE_BUCKET,
    prefix:`neon-pg18-qualification/${new Date().toISOString().replaceAll(/[^0-9]/g,'')}-${randomUUID()}`};
}
