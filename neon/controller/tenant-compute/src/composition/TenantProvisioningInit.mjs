import {Kubernetes} from '../infrastructure/kubernetes/Kubernetes.mjs';
import {ConfigurationFile} from '../infrastructure/configuration/ConfigurationFile.mjs';
import {ExecuteProvisioning} from '../infrastructure/provisioning/TenantProvisioning.mjs';

const platform = process.env.NEON_PLATFORM || (process.env.POD_NAMESPACE ? 'kubernetes' : 'compose');
const namespace = process.env.POD_NAMESPACE || 'neon';
await ExecuteProvisioning(process.argv[2], {config: ConfigurationFile(), requireLeader() {}, platform, namespace,
  state: process.env.NEON_STATE || '/state', api: platform === 'kubernetes' ? new Kubernetes({namespace}) : null});
