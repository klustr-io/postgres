import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const [container, output] = process.argv.slice(2);
function sample() {
  const result = spawnSync(process.env.DOCKER || 'docker', ['stats','--no-stream','--format','{{json .}}',container], {encoding:'utf8'});
  appendFileSync(output, JSON.stringify({timestamp:new Date().toISOString(),exit_code:result.status,
    stats:result.status === 0 ? JSON.parse(result.stdout) : result.stderr})+'\n');
}
sample();
setInterval(sample,5000);
