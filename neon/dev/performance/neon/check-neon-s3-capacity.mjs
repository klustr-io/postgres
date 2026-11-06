import fs from 'node:fs';
import {probeS3WriteCapacity} from './neon-s3-write-capacity.mjs';
import {s3Configuration,localConfiguration} from '../../shared/neon-qualification-config.mjs';
const image=JSON.parse(fs.readFileSync('neon/tests/reports/local/neon-native-commit-guard-image.json','utf8'));
const result=probeS3WriteCapacity({image:image.image_id,config:s3Configuration(localConfiguration()),reportPrefix:'neon-current'});
console.log(JSON.stringify(result,null,2));
