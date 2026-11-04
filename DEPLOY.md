# Deploy Neon PostgreSQL 18

This repository provides Docker Compose and Kubernetes YAML for the Neon database
architecture. The Kubernetes KEDA path supports declarative database provisioning,
size/tier changes, demand webhooks, compute suspension and shared-storage suspension.
Applications use normal PostgreSQL connections, SQL and JSONB.

**Check release compatibility before installing.** Checked-in manifests still
select earlier public images: RC5 runtime images and a later controller image.
The native OAuth and introspection source update requires matching rebuilt
compute, proxy and controller images; those capabilities are not added by changing
YAML against the older pins. Local source/image checks are not production HA
certification. See [release preparation](#release-and-image-selection) and
[HA and replication](#ha-and-replication-options).

## Deployment map

| Goal | Start here |
|---|---|
| Customer-owned fleet with OIDC, native OAuth or opaque tokens | [Install a customer fleet](#install-a-customer-fleet), then the [OIDC option reference](#oidc-configuration-reference). |
| Shared platform installation with KEDA and manually managed provider configuration | [Platform installation](#platform-installation-kubernetes-with-keda). |
| Single-host integration with static PostgreSQL credentials | [Docker Compose](#docker-compose); enterprise OIDC and fleet APIs are Kubernetes capabilities. |
| Automate provisioning and lifecycle changes | [Management API reference](#management-api-reference) and [Kubernetes resource inventory](#kubernetes-resource-inventory). |
| Choose failure domains, metadata availability and durability | [HA and replication options](#ha-and-replication-options). |
| Diagnose setup without creating benchmark data | [Small setup verification](#small-setup-verification-and-troubleshooting). |

Shell examples use a POSIX shell. Supply your own Kubernetes context, namespace,
DNS domain, registry digests, CSI class, S3 endpoint and identity provider. No
cloud account, identity server or external metadata cluster is provisioned by
the examples. Kubernetes API authentication is configured separately from Neon
management/database authentication.

### Release and image selection

Use a coordinated source release for PostgreSQL 18, proxy, storage services and
the tenant controller/operator. Public image names, source build commands and
publication workflows are in the [README](README.md), [build guide](neon/README.md)
and [release notes](neon/RELEASE-NOTES.md).

For the native OAuth source update, install the controller's locked development
dependencies, then build with the native authentication check enabled:

```sh
npm ci --prefix neon/controller/tenant-compute --ignore-scripts --no-audit --no-fund
node neon/build.mjs --verify-native-oauth --version=YOUR_NEW_VERSION
```

The [GitHub source build workflow](.github/workflows/neon-pg18-candidate.yml)
performs that check before publication. It exercises PG18 libpq, proxy/backend
`OAUTHBEARER`, the installed validator, JWT and opaque introspection, and normal
JSONB SQL. It does not certify zone-loss recovery or your identity provider.

The coordinated source build binds the controller's packaged `fleet-stack.json`
to the six native runtime image digests built in the same run. The publication
gate checks that registry digests match those embedded references, and the release
manifest records that authority under `fleet_release`. The packaged cluster
compute image and metadata StatefulSet image agree. Independent controller-only
development builds retain the checked-in runtime defaults and are not a native
runtime upgrade.

Checked-in standalone Compose/Kustomize examples retain explicitly reviewed
release defaults. For a registry mirror or updated standalone defaults, maintainers
update [`render.mjs`](neon/packaging/deploy/render.mjs) and render that deployment
bundle. Changing only an external Kustomize image entry does not replace the
bundle inside an already built operator image.

Set the operator Deployment image and its `FLEET_CONTROLLER_IMAGE` environment
value to the same qualified controller digest. A Kustomize `images` transform
does not rewrite that environment value. `NeonFleet.spec` deliberately has no
tenant-controlled image field. Keep the GitOps manifests, packaged runtime
digests and release receipt together; do not invent digests or treat a
controller-only update as a native proxy/compute upgrade.

## Idle boundary and cost

The intended Klustr boundary is a project reached through
`{project}.{tenant}.klustr.io`. **PostgreSQL SNI-based wake already exists in the
Neon proxy.** It extracts the endpoint, authenticates the client and calls the
controller's `/wake_compute` API; the controller starts storage/compute and the
proxy forwards the connection. No additional PostgreSQL wake gateway is required.

The supported address in this deployment is `ep-<database>.<domain>`. Supporting
the nested project/tenant address requires extending that hostname-to-endpoint
mapping and certificate configuration: the current proxy extracts only the first
label and passes it as `endpointish`. The mapping must preserve tenant identity
so identical project names in different tenants cannot share an endpoint/cache key.
Generic application HTTP routing/wake is a separate future integration; the
PostgreSQL wake path does not start arbitrary project HTTP servers.

| Layer | Idle behavior in the Kubernetes KEDA deployment |
|---|---|
| Database compute | Each database independently drains WAL and scales to zero. |
| Shared storage fleet | After the last database sleeps, verify remote durability, then stop both pageservers, all three safekeepers, broker, storage controller and metadata PostgreSQL. |
| Wake proxy and database controller/scaler | Remain available to authenticate connections, accept events and restart dependencies. |
| Kubernetes control plane and KEDA | Must remain available, either shared with the platform or externally hosted. |
| S3 and PVC data | Retained and still billed for storage. No database data is deleted to suspend a project. |

This implements **database/storage Pod-to-zero**, not cloud VM provisioning.
Physical database node pools can only reach zero with a provider node autoscaler,
appropriate workload placement and durable volumes that survive node removal.
The current compute placement pins writers to configured nodes; automatic safe
rebinding to replacement nodes remains a production integration gate. Local-path
volumes and a single local Kubernetes worker do not qualify node-loss recovery.

Shared storage remains up while any database needs it. An always-on database keeps
its shared fleet up. A project hostname does not allocate a separate fleet;
independent project or tenant storage shutdown requires separate deployments/fleets.
The default fleet cooldown adds 30 seconds after database
demand ceases, and shutdown waits for S3 durability. Cold fleet startup is slower
than compute-only wake; there is no certified subsecond wake SLA.
One local integration wake from fully stopped database/storage workers to JSONB
readback took approximately **20 seconds**, with images cached and the Kubernetes
node already running. This is one sample, not a latency guarantee or a physical
node-provisioning measurement.

For TLS routing, `*.klustr.io` does not cover `project.tenant.klustr.io`; use
appropriate per-tenant wildcards or individual certificates. Ordinary PostgreSQL
clients negotiate SSL before TLS, so a generic TLS/SNI router needs direct TLS
clients or a PostgreSQL-aware front door. Authenticate/rate-limit before an
expensive wake; SNI alone is not authorization.

## Enterprise fleets and OIDC

The enterprise operator reconciles a namespaced `NeonFleet` into the storage,
bootstrap, proxy, database controller and KEDA resources. It configures OIDC for
management, native database OAuth and a database credential-exchange API, with
placement across three physical availability zones. Use the matching source
release described above for native OAuth and introspection.
`NeonStorageFleet` remains the separate drain-aware suspension target.

Use one fleet in each fresh customer namespace. The fleet shape is:

```yaml
apiVersion: neon.klustr.io/v1alpha1
kind: NeonFleet
metadata:
  name: enterprise-a
  namespace: customer-a
spec:
  domain: db.customer.example
  clientCIDRs: [10.0.0.0/8]
  identity:
    issuer: https://identity.customer.example
    management:
      audience: klustr-fleet-api
      roleBindings:
        - group: database-admins
          role: fleet-admin
    database:
      audience: klustr-postgres
      roleBindings:
        - group: application-writers
          postgresRole: app_runtime
      requireTenantProjectBinding: true
  storage:
    objectStoreSecretRef: customer-s3
    storageClass: durable-csi
  replication:
    scope: availability-zones       # One Kubernetes cluster initially
    zones: [zone-a, zone-b, zone-c]
    mode: synchronous-quorum
    safekeepers: 3                 # One per physical zone; majority acknowledgement
  defaults:
    suspend: {mode: idle, idleSeconds: 300}
    backup: {historySeconds: 604800, scheduleSeconds: 86400, retentionSeconds: 2592000}
```

Database policy fields omitted from YAML or the API inherit the current fleet
defaults, including size, tier, idle timeout and backup settings. Partial backup
and suspend overrides inherit their omitted fields. Set `scheduleSeconds: 0`
explicitly to disable scheduled backups. Existing stored values remain explicit
overrides; changing fleet defaults does not overwrite them. Branches inherit
their source database's storage history policy.

Each namespace has one established fleet owner. Additional fleet resources are
marked `Rejected` while the owner continues reconciling. Retiring a fleet blocks
new database creation, resume and wake requests while preserving retained data.

Management identity maps customer groups to fleet-scoped permissions, including
separate authorization for database creation, backup access and destructive purge.
Database identity maps approved users/workloads to explicitly granted PostgreSQL
roles and the correct tenant/project/branch. Database access must not imply fleet
administration. Clients obtain short-lived tokens from the customer's identity
provider; no customer signing keys belong in the fleet. Browser login uses OIDC;
API/database token acceptance needs the intended resource audience, issuer,
expiry and claim bindings, verified by the selected JWT or introspection mode.
An OIDC ID token is not a generic API access
token. See [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html).

Management APIs validate issuer, audience, mandatory expiry and group bindings.
JWT mode verifies signatures. Signing keys are cached for five minutes; an unknown key ID can refresh
after a five-second minimum interval. HTTPS discovery verifies the issuer exactly.
Set optional `jwksUrl` to a fixed HTTPS JWKS endpoint, or `caSecretRef` to a Secret
containing `ca.crt` for a private issuer. Supported signing algorithms are RS256
(default), ES256 and EdDSA when explicitly selected in `algorithms`.

Management roles are `fleet-admin`, `database-operator`, `backup-operator` and
`viewer`. Fleet updates and database deletion require fleet-admin; backup mutation
requires backup-operator or fleet-admin. Database operators manage databases,
branches and wake events. GET operations permit all four roles. A provider may
use `groupsClaim`, `tenantClaim` and `projectClaim` to select claim names.
Static management tokens are disabled when OIDC is configured unless
`identity.management.allowStaticToken: true` explicitly enables break-glass access.

Zone replication uses Neon's safekeeper WAL quorum and pageserver placement, with
one writable compute primary per branch. This is not multiple independent writable
Postgres instances. Physical scheduling must enforce zone separation using node
affinity and [topology constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/),
with matching CSI volume topology. Metadata PostgreSQL, routing/control services
and object storage must also meet the selected failure policy. Merely assigning
different availability-zone strings to three Pods on one node provides no zone
resilience. Zone-loss durability and safe compute failover need qualification
before the fleet can report those guarantees as ready.

The API and YAML must reconcile the same desired state and expose desired versus
observed placement, quorum health, replication lag and failover readiness. Separate
cross-region replication, asynchronous loss policies and read replicas need explicit
policies rather than inheriting a zone-quorum guarantee. The earlier one-second
compute-loss allowance is not automatically a zone/region-loss guarantee.

Idle fleets may stop database/storage workers after the existing durability drain.
An always-on database keeps its fleet active; shared wake/control services remain
available. Whole-fleet suspension trades warm failover/startup speed for idle cost.

### Install a customer fleet

Prepare AMD64 Linux workers, a network-policy-capable CNI, durable CSI storage
with the required zone topology, an HTTPS S3-compatible bucket, and a reachable
IdP. The fleet operator requires at least one Ready, untainted, schedulable node
in each of its three zones. Storage placement uses the real
`topology.kubernetes.io/zone` labels; labeling a single local worker three ways
does not provide three failure domains. Cluster DNS currently assumes
`cluster.local`, and the shared KEDA namespace defaults to `keda`.

Use a namespace dedicated to this fleet. The enterprise operator and the
standalone KEDA installer are alternative owners of the namespace's Neon stack;
do not install both into it.

```sh
export NEON_KUBE_CONTEXT=YOUR_CONTEXT
export NEON_NAMESPACE=customer-a
export NEON_FLEET=enterprise-a
kubectl --context "$NEON_KUBE_CONTEXT" get nodes -L topology.kubernetes.io/zone
kubectl --context "$NEON_KUBE_CONTEXT" get storageclass
```

Install KEDA as described below. A cluster administrator installs the shared CRDs
and the read-only node role once; these commands do not create customer databases:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" apply -f neon/packaging/kubernetes/keda/database-crd.yaml -f neon/packaging/kubernetes/keda/backup-crd.yaml -f neon/packaging/kubernetes/keda/fleet-crd.yaml
kubectl --context "$NEON_KUBE_CONTEXT" apply -f neon/packaging/kubernetes/enterprise/fleet-crd.yaml -f neon/packaging/kubernetes/enterprise/node-reader.yaml
kubectl --context "$NEON_KUBE_CONTEXT" wait --for=condition=Established crd/neonfleets.neon.klustr.io crd/neondatabases.neon.klustr.io crd/neonbackups.neon.klustr.io crd/neonstoragefleets.neon.klustr.io --timeout=60s
kubectl --context "$NEON_KUBE_CONTEXT" create namespace "$NEON_NAMESPACE"
```

Copy [`enterprise/`](neon/packaging/kubernetes/enterprise) into the customer's
GitOps repository. In its `kustomization.yaml`, set `namespace: enterprise-a` and
`namePrefix: enterprise-a-`; use a unique prefix for each installation so the node
reader binding is distinct. Use the namespace created above, then `kubectl apply -k`
the copied directory. The operator has namespace-scoped provisioning authority and
cluster-wide read-only node access; its leadership lease is separate from the
database controller. It refuses to adopt an existing deployment or migrate its
storage identity implicitly.

For example, the copied `customer-a/operator/kustomization.yaml` can contain:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: customer-a
namePrefix: customer-a-
resources:
  - operator.yaml
```

Before applying it, select the release's operator image and matching
`FLEET_CONTROLLER_IMAGE` in the copied `operator.yaml`. Review the rendered
ServiceAccount/RoleBinding/ClusterRoleBinding subjects and namespace:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" kustomize customer-a/operator
kubectl --context "$NEON_KUBE_CONTEXT" apply -k customer-a/operator
```

Create the object-store Secret in the customer namespace from a protected file:

```text
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=...
NEON_S3_ENDPOINT=https://s3.example.com
NEON_S3_BUCKET=...
NEON_S3_PREFIX=customer-fleets
```

Store that file outside source control with restricted filesystem permissions,
then create the referenced Secret:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" create secret generic customer-s3 --from-env-file=/secure/customer-s3.env
```

Create any private IdP CA and introspection Secrets **before** applying the fleet:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" create secret generic customer-idp-ca --from-file=ca.crt=/secure/idp-ca.crt
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" create secret generic neon-database-introspection --from-file=clientSecret=/secure/database-introspection-secret
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" create secret generic neon-management-introspection --from-file=clientSecret=/secure/management-introspection-secret
```

Only create and reference the optional Secrets selected by your configuration.
`identity.caSecretRef` applies to IdP HTTPS trust, not the S3 service, PostgreSQL
client trust or external metadata TLS. The native runtimes must separately trust
your S3 endpoint's certificate chain.

An optional `AWS_SESSION_TOKEN` is supported. The actual prefix appends namespace
and fleet UID to isolate deployments. Apply the edited
[`examples/fleet.yaml`](neon/packaging/kubernetes/examples/fleet.yaml) into that
namespace. Three Ready, schedulable nodes carrying the actual configured
`topology.kubernetes.io/zone` labels must be available for initial provisioning.
PVCs use the selected CSI class; changing storage endpoints/classes or zone
topology requires an explicit migration. Operator status reports Pending if a
zone is missing or a resource belongs to another deployment.

Save the fleet example above as `customer-fleet.yaml`, select your identity mode
and native OAuth policy below, and apply it. Reconciliation is asynchronous:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" apply -f customer-fleet.yaml
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" get neonfleet "$NEON_FLEET" -o yaml
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" get pods,pvc,scaledobject
```

Inspect `status.phase`, `observedGeneration`, `reason` and placement observations.
`Provisioned` means resources were applied; it is not a healthy-database or HA
certification. Storage workers may subsequently be asleep by policy. Create the
first database with explicit OIDC resource bindings:

```yaml
apiVersion: neon.klustr.io/v1alpha1
kind: NeonDatabase
metadata:
  name: events
  namespace: customer-a
spec:
  database: app
  identity: {tenant: acme, project: billing}
  size: small
  tier: standard
  profile: durable
  suspend: {mode: idle, idleSeconds: 300}
```

Apply that resource in the same namespace. Change `suspend` to `{mode: never}`
for an always-on database. Tenant/project labels alone do not authorize tokens;
the `spec.identity` binding above must match the verified token metadata. Configure
DNS and the L4 proxy endpoint before connecting. The current database address is
`ep-events.db.customer.example`, not `{project}.{tenant}.klustr.io`.

Set optional `storage.metadataDatabaseSecretRef` to use an externally managed HA
PostgreSQL database. That Secret's `url` must be a dedicated metadata DSN with
`sslmode=verify-full`; optional CA files can live in the same mounted Secret.
The local metadata StatefulSet is then omitted and excluded from suspension.
Availability and idle cost of that external metadata service remain its provider's
responsibility. Without it, metadata remains a single PostgreSQL instance.

After bootstrap, OIDC-authorized `GET /v1/fleet` returns spec/status and
`PUT /v1/fleet` replaces the desired spec. Initial creation uses Kubernetes YAML
or the Kubernetes API, since the fleet's management runtime does not exist yet.
This configures Neon OIDC; it does not change the Kubernetes API server's own
identity-provider configuration. Deleting a fleet requests suspension and retains
data behind a finalizer. Do not remove that finalizer to bypass data review.

### OIDC configuration reference

These paths are relative to `NeonFleet.spec.identity`. The same identity object
is persisted through the fleet management API. Unsupported fields are rejected;
use these names rather than adding provider-specific runtime environment values.

| Setting | Required/default | Purpose |
|---|---|---|
| `issuer` | Required HTTPS issuer identifier | Exact token issuer; use the issuer identifier, not its discovery-document URL. |
| `jwksUrl` | Optional | Fixed HTTPS JWKS endpoint; otherwise discover it from the issuer. Used by JWT mode. |
| `caSecretRef` | Optional | Same-namespace Secret containing `ca.crt` for private IdP trust. |
| `algorithms` | `['RS256']` | JWT allowlist; supported values are `RS256`, `ES256`, `EdDSA`. |
| `groupsClaim` | `groups` | Array-valued claim used for explicit group bindings. |
| `tenantClaim`, `projectClaim` | `tenant`, `project` | Claims checked against each database's `spec.identity`. |
| `management.audience` | Required | Resource audience for fleet/database management APIs. |
| `management.roleBindings` | Required | `{group, role}` entries; configure a reachable `fleet-admin` principal during bootstrap. |
| `management.allowStaticToken` | Disabled | Explicitly permit the separate management Secret as a shared break-glass principal. |
| `database.audience` | Required; different from management | Resource audience for native login and credential exchange. |
| `database.roleBindings` | Required | `{group, postgresRole}` entries; native OAuth requires a nonempty list. |
| `database.requireTenantProjectBinding` | Must be `true` | Enforce database resource ownership on every token authorization. |
| `database.managedRole` | `app_runtime` | Automatically managed restricted data role. |
| `database.allowPasswordAuth` | Disabled | Permit other static PostgreSQL password roles through the proxy; native-mapped roles still require OAuth when enabled. |
| `database.oauth.enabled` | Disabled when `oauth` is omitted | Explicit native PG18 OAuth opt-in. An `oauth` object requires a boolean `enabled`. |
| `database.oauth.scope` | Required when enabled | Space-separated scopes, all of which must be present in the access token metadata. |
| `database.oauth.scopeClaim` | `scope` | String-valued claim containing the granted scopes. |
| `management.tokenValidation`, `database.tokenValidation` | `{mode: jwt}` | Independent token validation policies, detailed below. |

Claim selectors name top-level claims, not JSONPath expressions. Configure IdP
token mappers to emit groups as an array and native scopes as a space-separated
string. Audience metadata may be a string or array containing the configured
resource audience. A `client_id` is not a substitute for `aud`; an OIDC ID token
is not a database access token.

| `tokenValidation` setting | JWT mode | Introspection mode |
|---|---|---|
| `mode` | `jwt`; only this field is accepted | `introspection`; accepts opaque tokens or JWTs through the remote endpoint |
| `endpoint` | Not applicable | Required fixed HTTPS URL; credentials, query and fragment are prohibited in this URL |
| `clientId` | Not applicable | Required resource-server client identity |
| `clientSecretRef` | Not applicable | Required same-namespace Secret name |
| `clientSecretKey` | Not applicable | Secret data key; default `clientSecret` |
| `authMethod` | Not applicable | `client_secret_basic` (default) or `client_secret_post` |
| `cacheSeconds` | Not applicable | Successful-result cache lifetime: `30` by default, `60` for one minute, `0` to disable; integer range `0`–`60` |

Register separate management and database audiences at your IdP. For native libpq
device login, register the client and device authorization grant supported by
your provider. For workload access, obtain access tokens through your provider's
supported workload flow and supply them using the driver's OAuth facility.
The introspection resource-server credential is separate from the application's
token-acquisition client credential. Neon does not create these IdP registrations
or issue customer access tokens.

The IdP's signing keys stay at the IdP. JWT validation uses its public JWKS;
introspection uses the referenced resource-server Secret. Both modes enforce
expiry, subject, audience, groups and applicable database ownership/scopes.
Introspection additionally requires `active: true`; [its claim requirements and
failure behavior](#opaque-tokens-and-token-introspection) apply even when the
submitted token happens to look like a JWT.

### Native PostgreSQL 18 OAuth login

Native OAuth and the credential-exchange API below are separate connection modes.
The native mode uses PostgreSQL's `OAUTHBEARER` SASL mechanism and preserves the
requested SQL role. It does not issue a replacement username or password.
PostgreSQL requires an installed validator; this source build installs
`klustr_oauth` and builds libpq with `--with-libcurl` for native OAuth clients.
See [PostgreSQL OAuth authentication](https://www.postgresql.org/docs/18/auth-oauth.html).

Enable it in `NeonFleet.spec.identity.database`, or the equivalent fleet API
`spec.identity.database` settings. Keep the management audience separate:

```yaml
identity:
  issuer: https://identity.customer.example
  management:
    audience: klustr-fleet-api
    roleBindings:
      - {group: database-admins, role: fleet-admin}
  database:
    audience: klustr-postgres
    requireTenantProjectBinding: true
    allowPasswordAuth: false
    oauth:
      enabled: true
      scope: postgres:connect
      scopeClaim: scope
    roleBindings:
      - {group: application-writers, postgresRole: app_runtime}
```

The database still needs its tenant/project `identity` binding. Configure the IdP
to issue access tokens with the database audience, matching tenant/project,
authorized groups and every required scope. `scope` is a space-separated list;
`scopeClaim` selects a string-valued token claim and defaults to `scope`.
Issuer/JWKS, signing algorithms and private issuer CA settings are shared with
management authentication. JWT mode requires a valid signature and expiry;
introspection mode requires an active response and the same authorization claims.
Native authorization currently targets the primary SQL database selected by
`NeonDatabase.spec.database`; creating additional SQL databases on that compute
does not automatically add native OAuth authorization for them.

The provider generates the HBA, selects the validator library and mounts an
endpoint-specific client certificate. The proxy authorizes the token before
waking storage/compute and prepares the restricted SQL login. It then forwards
the same bearer token over verified TLS to PostgreSQL, which validates it again
through endpoint-bound mTLS. PostgreSQL independently rejects privileged roles
and privileged role memberships. Validator outages deny new native logins;
there is no fallback to password or trust authentication for native roles.
The controller remains a dependency for new connections. The IdP must be
available for introspection and for signing-key/discovery refreshes in JWT mode.

Use a PG18 OAuth-capable client/driver with `sslmode=verify-full`, the proxy
hostname and the explicitly mapped SQL role, for example:

```sh
psql "host=ep-example.db.customer.example dbname=app user=app_runtime sslmode=verify-full sslrootcert=/path/to/fleet-ca.crt require_auth=oauth oauth_issuer=https://identity.customer.example oauth_client_id=postgres-client"
```

Register the client and its allowed grants at your IdP. Stock libpq can use its
device authorization flow when the IdP supports it; applications can provide
tokens through libpq's public OAuth token hook or an equivalent driver facility.
A token placed in the password field is not native OAuth negotiation. No
application schema or SQL function changes are required. Token claims authorize
the role; they are not automatically exposed as SQL JWT/session variables.
`system_user` records the authenticated OAuth issuer/subject identity.

The default `app_runtime` role is provider-managed and receives LOGIN with no
password in native mode, retaining its data-only grants. Other mapped roles must
already be restricted LOGIN roles. `allowPasswordAuth: true` permits SCRAM for
other roles; mapped native roles continue to require OAuth. Lifecycle credentials
and existing expiring `oidc_*` broker logins keep their narrow SCRAM HBA rules.
Expiry or policy changes reject new logins; existing sessions are not terminated.

Changes to the native issuer, required scopes, role list or password policy need
a completed suspend/resume to replace an active compute's HBA configuration. The controller does not restart
an active writer implicitly. An always-on database needs an explicit maintenance
suspend for that change. Idle and never-suspend policies otherwise work unchanged.
Native OAuth is currently a Kubernetes fleet capability; Compose rejects OIDC
configuration rather than silently exposing a password-only deployment.

Deploy matching compute, proxy and controller images from the OAuth source build.
The previously published RC5 digests do not contain this feature; changing YAML
alone cannot add it to those images. Build with
`node neon/build.mjs --verify-native-oauth` (after installing the controller's
locked npm dependencies) and publish
through the repository's release workflow before selecting new immutable digests.
The focused native check is
`node neon/tests/neon/identity/native-oauth.mjs`, using
`NEON_OAUTH_ARTIFACT_IMAGE` to select the compiled artifacts image.

### Opaque tokens and token introspection

Each of `identity.management` and `identity.database` accepts `tokenValidation`.
Omitting it selects local JWT verification. Select `mode: introspection` to
validate opaque tokens, or to validate JWTs remotely for revocation checks,
through [RFC 7662 token introspection](https://www.rfc-editor.org/rfc/rfc7662.html).
The mode is explicit: failed introspection never falls back to JWT verification.
Native `OAUTHBEARER` carries either format unchanged to PostgreSQL; the existing
credential-exchange API also accepts introspected database tokens.

For example, add this under `spec.identity.database`:

```yaml
tokenValidation:
  mode: introspection
  endpoint: https://identity.customer.example/oauth2/introspect
  clientId: neon-database-resource
  clientSecretRef: neon-database-introspection
  clientSecretKey: clientSecret
  authMethod: client_secret_basic
  cacheSeconds: 30
```

Create that Secret in the fleet's namespace without putting the credential in
the fleet YAML, API payload, repository or command-line arguments:

```sh
kubectl -n customer-a create secret generic neon-database-introspection --from-file=clientSecret=/secure/path/introspection-client-secret
```

For opaque management tokens, configure the same fields under
`spec.identity.management.tokenValidation`, preferably with a separate resource
client and Secret. The operator mounts each credential only in the controller.
`clientSecretKey` defaults to `clientSecret`. `client_secret_basic` is the default;
`client_secret_post` is available when the IdP requires form-body client
authentication. HTTPS verification uses system trust plus the optional shared
`identity.caSecretRef` private issuer CA. Redirects are rejected.

Configure the IdP's introspection response to include `active: true`, `sub`,
`aud`, integer `exp`, the configured groups/tenant/project claims and, for native
database OAuth, the configured scope claim. This deployment deliberately
requires subject, resource audience and expiry even though RFC 7662 makes those
metadata fields optional. If `iss` is returned, it must match the configured
issuer exactly; otherwise the fixed trusted introspection endpoint supplies that
issuer authority. A returned `token_type` must be Bearer. Inactive, expired,
wrong-audience or wrongly bound tokens are rejected.

Successful active introspection metadata is cached in each controller process for
30 seconds by default. Set `cacheSeconds: 60` for one minute or `cacheSeconds: 0`
to disable reuse, independently for management and database validation. Entries
never outlive token expiry; simultaneous checks of the same token share one
provider call. Inactive results, errors and expired entries are not reused, and
there is no stale-result fallback during an IdP outage. A still-valid cached
result can authorize a new login during an outage until its cache lifetime ends.

Cache keys isolate the token, audience, complete identity policy and current
credential/trust material without retaining raw bearer tokens as keys. Credentials
and private CA contents are read on each lookup, so rotation bypasses old entries
when Kubernetes updates the mount. The cache is bounded to 1,024 entries and
16 MiB of serialized metadata per process. Current group, scope and database
resource authorization still runs for every request; the cache stores metadata,
not an authorization decision.

Revocation can take up to the configured cache lifetime to affect new native
logins or management requests; it does not terminate established sessions.
Previously exchanged SCRAM
credentials remain usable until their issued expiry unless separately revoked;
use native OAuth with `cacheSeconds: 0` when each new database login must consult
introspection. Cache-miss calls have a
three-second deadline and a bounded response size. TLS, timeout, malformed
response, HTTP error or IdP outage rejects the new login. Remote validation adds
connection setup work, including backend verification; pooled SQL queries do not
perform introspection on every statement.

### Connect through the OIDC credential-exchange API

Give each database an explicit identity binding when provisioning:

```yaml
identity:
  tenant: acme
  project: billing
```

The application obtains an access token for the configured database audience from
the customer's IdP, containing matching tenant/project claims and an authorized
group. Exchange it over the same verified management TLS endpoint:

```text
POST /v1/databases/events/credentials
Authorization: Bearer <database access token>
{"role":"app_runtime"}
```

The 201 response contains `user`, `password`, `expiresAt`, `database`, `host`, `port`
and `sslmode`. Use those values with an ordinary PostgreSQL client. Retry a 503
while provisioning/wake is pending. Authentication is checked before wake and
again before issuance. Credentials expire at the earlier of token expiry and 15
minutes. They grant membership in the configured SQL role and cannot
target superuser/replication/role-administration roles. No application SQL
functions or proxy protocol extensions are required.

The default managed role `app_runtime` is created automatically with no login or
administrative attributes. It receives CONNECT, public-schema USAGE, table CRUD
and sequence usage, including default privileges for tables created by the
managed application owner. It does not receive schema CREATE or RLS bypass.
Use optional `database.managedRole` to rename it; other role mappings must refer
to existing restricted PostgreSQL roles. Neon's default `app_user` has privileged
attributes and is deliberately not delegated by this exchange.

OIDC-enabled fleets disable static proxy database passwords by default; optional
`identity.database.allowPasswordAuth: true` explicitly permits both. Enterprise
proxy auth caching is disabled so fresh connections consult current policy.
Policy changes invalidate exchanged credentials for new proxy authentications.
Expiry prevents new connections; it does not terminate already authenticated
sessions. Applications must refresh credentials when opening new pool connections.
There is a limit of 128 unexpired exchanged logins per database.
OIDC claims authorize the exchange; they are not installed as SQL session claims.
The SQL session uses the generated login and inherits the mapped data role. RLS
policies that depend on JWT claims need a separate, explicit integration.

Cleanup does not wake sleeping compute. Expired login roles with no dependencies
are removed when compute is running; roles owning customer objects are retained
with NOLOGIN. Their object ownership is never reassigned automatically. Prefer
existing application tables and restricted data roles for high-frequency exchanges;
ownership cleanup for DDL-capable identities remains an administrative operation.

`Provisioned` means resources were reconciled, not that HA is certified. Status
records observed generation, physical placement observations and
`automaticFailoverReady: false`. Cross-worker writer fencing, control-plane HA and
actual zone-loss recovery still require qualification. Node labels in local
single-worker tests cannot substitute for that evidence.

## HA and replication options

The available policy is a three-zone storage quorum in one Kubernetes cluster.
It provides replication building blocks; this repository does not yet claim
automatic end-to-end HA. Upstream [Neon architecture](https://neon.com/docs/introduction/architecture-overview)
explains the separate compute, WAL and page-storage layers. Self-hosted routing,
fencing, metadata and recovery still need their own availability design.

| Layer / option | Configuration available here | Availability implications |
|---|---|---|
| WAL replication | `replication: {scope: availability-zones, mode: synchronous-quorum, safekeepers: 3, zones: [zone-a, zone-b, zone-c]}` | Exactly one safekeeper in each selected zone. The majority-quorum design depends on two reachable, durable voters; actual zone-loss recovery remains unqualified in this deployment. |
| PostgreSQL commit policy | `NeonDatabase.spec.profile: durable` | Required for enterprise synchronous-quorum fleets. Attempts to use `bounded-async` are rejected rather than creating an asynchronous fleet policy. |
| Page placement | `tier: shared`, `standard`, or `performance` | `shared` requests no secondary; `standard` and `performance` request one. The packaged fleet has two pageservers, assigned to the first two configured zones. Secondary pageservers are page-storage copies, not SQL read replicas. |
| Metadata availability | `storage.metadataDatabaseSecretRef` | Use your externally operated HA PostgreSQL service. Without this field, metadata is one local PostgreSQL StatefulSet. |
| Local durable state | `storage.storageClass` | CSI volumes must survive worker loss and have suitable zone attachment behavior. Local-path or node-local storage does not provide this guarantee. |
| Compute availability | One writer per database/branch, `replicas` limited to 0 or 1 | Existing placement stays pinned to its worker. Safe cross-worker replacement/fencing is not automatically implemented. |
| Proxy, controllers and KEDA | Default manifests have a single proxy/operator/controller instance and lease-based controller authority | Multi-zone placement and additional replicas are infrastructure work requiring readiness, routing and takeover qualification; there is no `NeonFleet` HA-replica-count setting. Never increase the compute writer count to obtain HA. |
| Long-term durability | HTTPS object storage plus planned remote-durability drain | Object-store availability, regional durability and backup policies are supplied by the storage provider. S3 availability does not make metadata or the wake/control path HA. |
| Idle cost | `suspend: {mode: never}` or `{mode: idle, idleSeconds: 300}` | Warm workers favor readiness; worker-to-zero trades idle cost for recovery/startup time. Proxy, controller/scaler, KEDA and required IdP services still need an available home. |

Only the displayed replication scope, mode and safekeeper count are accepted by
`NeonFleet`; two-zone, five-voter, cross-region, cross-cluster, asynchronous fleet
replication, SQL read replicas and multi-writer modes are not exposed options.
`bounded-async` remains an explicit non-enterprise deployment profile, with the
limitations in [durability and qualification](#durability-retention-and-qualification).
It must not be represented as a cross-zone one-second-loss guarantee.

More independent database computes can distribute independent workloads. Adding
compute replicas does not increase one database's write throughput. Storage
sharding distributes storage work and is separate from SQL writer replication;
maintain sufficient physical pageserver capacity before increasing shards.

### External HA metadata PostgreSQL

Provision a dedicated database and credentials at your metadata provider. Its
Secret contains `url`; use a verified TLS DSN. If a private CA is needed, include
`ca.crt` and refer to its container path in the DSN, for example
`sslrootcert=/run/external-metadata/ca.crt`. Store the complete credential-bearing
DSN in a protected file, then create the Secret:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" create secret generic customer-metadata-ha --from-file=url=/secure/metadata-url --from-file=ca.crt=/secure/metadata-ca.crt
```

Add this field to the existing fleet's `storage` object **before initial
provisioning**, alongside its object-store reference and CSI class:

```yaml
storage:
  objectStoreSecretRef: customer-s3
  storageClass: durable-csi
  metadataDatabaseSecretRef: customer-metadata-ha
```

Omit the CA file when system trust is sufficient. The local metadata StatefulSet
and Service are omitted; the external database is not stopped by fleet suspension.
Its HA, failover endpoint, backups, credential rotation and cost are your
provider's responsibility. This setting is not a migration command for existing
local metadata. Storage identity/topology changes are rejected after provisioning
and require a separately planned migration.

### Failure and recovery boundaries

| Situation | Expected operational boundary |
|---|---|
| Planned compute suspension | Close admission, wait for safe SQL/WAL drain, retain storage identity, then stop compute. |
| Planned whole-storage suspension | Stop only after every managed frontier is verified remotely durable; failed verification leaves storage running. |
| One safekeeper or zone unavailable | Quorum is intended to preserve durable operation when the remaining majority and required storage/control services are healthy. Inspect actual placement, quorum and recovery; the local acceptance test does not establish a zone SLA. |
| Compute worker lost or partitioned | Positively fence the old writer before any replacement. No public force-promote or automatic cross-worker failover API is provided. |
| Metadata service unavailable | Storage/control operations can be unavailable even with healthy S3 and safekeepers. External HA metadata must be qualified separately. |
| Introspection/validator unavailable | Validator unavailability rejects new native authentications. An IdP introspection outage rejects cache misses and expired entries; valid cached metadata remains usable within `cacheSeconds`. Existing sessions are not automatically terminated; JWT mode separately depends on discovery/key refreshes. |
| Regional loss or bucket loss | A native snapshot in the same bucket is not independent DR. Keep tested external exports/copies and restore the metadata, Secrets and resource definitions together. |

Inspect `NeonFleet.status.automaticFailoverReady`; the current implementation
reports `false`. `zonePlacementConfigured` or `Provisioned` must not be promoted
to an HA claim. Before offering a production availability/RPO/RTO commitment,
qualify real zone failures, single-writer fencing, PVC reattachment, metadata and
control-path takeover, object-store failure, and restoration from independent
backups. Keep those qualification exercises separate from the small setup smoke
check below.

## Platform installation: Kubernetes with KEDA

Use AMD64 Linux workers, a working StorageClass, `kubectl`, an S3-compatible HTTPS
bucket and registry access. No host Node install is needed for these commands.
The package installs two pageservers, three safekeepers, a broker, metadata
PostgreSQL, storage controller, proxy, lifecycle controller and bootstrap credentials.

1. Edit [`base/cluster.yaml`](neon/packaging/kubernetes/base/cluster.yaml): cluster
   name/domain, S3 endpoint/region/bucket/isolated prefix, client CIDRs and compute
   worker placement. Leave `tenants: []` to provision databases through the API/YAML.
2. Set PVC storage class/sizes and physical failure-domain placement in an overlay
   of [`base/storage.yaml`](neon/packaging/kubernetes/base/storage.yaml). Default
   volumes request 10Gi each. Production node removal requires durable CSI volumes;
   S3 alone does not preserve the separate controller metadata PostgreSQL database.
3. The controller and runtime images are public and digest-pinned in the YAML.
   Use a Kustomize `images` entry if mirroring them into your own registry.

Install KEDA once per platform, using your approved installation or the pinned
release below. This installs cluster-scoped CRDs/RBAC and needs cluster-admin:

```sh
kubectl --context YOUR_CONTEXT apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.21.0/keda-2.21.0.yaml
kubectl --context YOUR_CONTEXT apply -f neon/packaging/kubernetes/keda/database-crd.yaml
kubectl --context YOUR_CONTEXT apply -f neon/packaging/kubernetes/keda/backup-crd.yaml
kubectl --context YOUR_CONTEXT apply -f neon/packaging/kubernetes/keda/fleet-crd.yaml
kubectl --context YOUR_CONTEXT wait --for=condition=Established crd/neondatabases.neon.klustr.io crd/neonbackups.neon.klustr.io crd/neonstoragefleets.neon.klustr.io --timeout=60s
```

Create a private env file containing `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
and optionally `AWS_SESSION_TOKEN`, then install the namespace-local architecture:

```sh
kubectl --context YOUR_CONTEXT apply -f neon/packaging/kubernetes/base/namespace.yaml
kubectl --context YOUR_CONTEXT -n neon create secret generic neon-s3 --from-env-file=/secure/neon-s3.env
kubectl --context YOUR_CONTEXT apply -k neon/packaging/kubernetes/keda
kubectl --context YOUR_CONTEXT -n neon wait --for=condition=complete job/neon-init --timeout=300s
```

Bootstrap retains signing keys, TLS certificates and administrative credentials.
The controller continuously reconciles `NeonDatabase` resources; creating a tenant
requires no bootstrap Job reruns or manually constructed ComputeSpecs.

Default namespace is `neon`, KEDA namespace is `keda`, and cluster DNS suffix is
`cluster.local`. When changing namespaces, also adjust the fleet ScaledObject's
scaler address and KEDA RoleBinding/NetworkPolicy references. Use a network-policy
capable CNI. External database access uses an L4 LoadBalancer with TLS passthrough
and DNS pointing to Service `neon-proxy`. Internal storage management uses
JWT-authenticated HTTP; production transport hardening and certificate rotation
remain qualification work.

Apply the KEDA overlay consistently. It omits worker replica counts so routine
manifest updates do not overwrite the lifecycle controller's scale decisions.
Initial installation may initialize storage once before reaching its idle state.
Upgrade from the legacy base by retiring its old `neon-provision` Job; KEDA mode
uses continuous reconciliation instead.

## Provision or change a database

A namespace-scoped resource is the tenant-facing database contract:

```yaml
apiVersion: neon.klustr.io/v1alpha1
kind: NeonDatabase
metadata:
  name: events
  namespace: neon
  labels:
    klustr.io/tenant: acme
    klustr.io/project: analytics
spec:
  database: app
  identity: {tenant: acme, project: analytics}
  size: small
  tier: standard
  suspend:
    mode: idle
    idleSeconds: 300
```

```sh
kubectl --context YOUR_CONTEXT apply -f your-database.yaml
kubectl --context YOUR_CONTEXT -n neon get neondb,scaledobject,neonstoragefleet
```

The tenant/project labels are routing metadata for the future Klustr front door;
they do not change current proxy hostname parsing. Status reports the endpoint,
credentials Secret, requested size/tier and lifecycle phase. Credentials live in
`<database resource name>-client`, with keys `user`, `database` and `password`.

| Size | CPU | Memory | PostgreSQL shared buffers | Connection limit |
|---|---:|---:|---:|---:|
| `micro` | 250m | 512Mi | 128MB | 50 |
| `small` | 1 | 2Gi | 512MB | 100 |
| `medium` | 2 | 4Gi | 1GB | 200 |
| `large` | 4 | 8Gi | 2GB | 300 |

Provider-owned `sizes` and `tiers` in cluster configuration can override defaults.
Tenants select these names; they cannot supply storage credentials, worker names
or arbitrary PostgreSQL settings through the webhook API.

| Tier | Page-request budget per shard/second | Burst per shard | Secondary pageserver copies |
|---|---:|---:|---:|
| `shared` | 2,000 | 4,000 | 0 |
| `standard` | 10,000 | 20,000 | 1 |
| `performance` | 40,000 | 80,000 | 1 |

These are read admission limits, **not guaranteed IOPS or reserved WAL bandwidth**.
Storage CPU/disks/network and safekeepers remain shared. Production noisy-neighbor
and latency guarantees need further qualification. Secondary copies require enough
registered pageservers and real failure-domain placement.

Edit `size` or `tier` and reapply. Tier policies update storage configuration;
compute size/settings changes use a drained restart and retain the database.
Active work delays resizing. Pools must reconnect after a resize or idle suspension.
KEDA controls zero/one writer; this is not automatic in-place CPU/memory resizing
or multi-writer horizontal scaling. `suspend: {mode: never}` keeps compute and its
shared storage fleet up. Optional per-database policies apply to the whole compute;
in KEDA mode the longest configured idle timeout is used conservatively.

Storage controller sharding/migration notifications update active compute through
normal PostgreSQL configuration reloads and persist routing for future wakes.
Default provider split settings begin at 16GiB and allow subsequent splits up to
16 shards. Advanced `shards` requests can increase a database's shard count;
shrinking shard count is not implemented. Sharding does not provision physical
pageservers or cloud nodes: providers must maintain sufficient fleet capacity.

## Management API reference

The fleet controller serves verified HTTPS on Service `neon-controller:8080`.
It is an internal API by default. For an operator session, port-forward it while
retaining the service hostname for TLS verification:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" port-forward service/neon-controller 18443:8080
```

In another terminal, set these values for that session. Obtain a management
access token from your IdP for `management.audience` and store a protected header
file containing `Authorization: Bearer <access-token>`. Do not commit the header
file or print its contents in agent logs. Export only the public service CA:

```sh
umask 077
export NEON_KUBE_CONTEXT=YOUR_CONTEXT
export NEON_NAMESPACE=customer-a
export NEON_CA=/secure/customer-a-ca.crt
export NEON_MANAGEMENT_HEADERS=/secure/customer-a-management.headers
export NEON_API=https://neon-controller.customer-a.svc.cluster.local:18443
export NEON_API_RESOLVE=neon-controller.customer-a.svc.cluster.local:18443:127.0.0.1
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" get secret neon-service-ca -o jsonpath='{.data.ca\.crt}' | base64 --decode > "$NEON_CA"
neon_api() {
  curl --fail-with-body --cacert "$NEON_CA" --resolve "$NEON_API_RESOLVE" --header @"$NEON_MANAGEMENT_HEADERS" "$@"
}
neon_api "$NEON_API/v1/fleet"
```

Replace `customer-a` consistently when using a different namespace. These
port-forward examples need `kubectl`, `curl`, `base64`, and `jq` for the JSON
editing example below. An approved in-cluster backend can call the Service
directly using verified TLS and the appropriate network-policy caller label.
Do not expose the internal proxy/compute authorization callbacks as a customer
management API. Management RBAC is fleet/namespace-scoped: a database operator
can manage databases across that fleet. Database tenant/project claims protect
SQL access; they do not narrow a management role to one project. Use a dedicated
customer fleet/namespace, or an additional platform authorization boundary, when
untrusted customers need isolated management access.

This repository's `/v1/...` endpoints are its own control-plane
contract, not the hosted Neon Cloud management API.

### API methods and authorization

`admin` below means `fleet-admin`; `operator` means `database-operator`;
`backup` means `backup-operator`. All four management roles, including `viewer`,
can use the listed GET methods. Database tokens do not grant management access.

| Method and path | Authorization | Request / result |
|---|---|---|
| `GET /v1/fleet` | Any management role | `200` with `{name, spec, status}` for the established namespace owner. |
| `PUT /v1/fleet` | admin | Bare complete fleet spec; `202` with `{name, generation}`. No Kubernetes resource envelope. |
| `GET /v1/databases/{name}` | Any management role | `200` with `{name, spec, status}`. |
| `PUT /v1/databases/{name}` | admin or operator | Bare database spec/overrides; create or revise, `202` with `{name, generation}`. |
| `POST /v1/databases/{name}/events` | admin or operator | `{id, holdSeconds}` activity hold; `202`. |
| `POST /v1/databases/{name}/suspend` | admin or operator | No body required; `202`. |
| `POST /v1/databases/{name}/resume` | admin or operator | No body required; `202`. |
| `DELETE /v1/databases/{name}` | admin | `{}` retains data; `{mode: "purge", confirm: "name"}` requests permanent purge; `202`. |
| `POST /v1/databases/{name}/branches` | admin or operator | `{name, backup? OR lsn? OR timestamp?, size?, suspend?, profile?, allowedIps?}`; `202`. Omit the recovery selector to clone the current frontier. |
| `GET /v1/databases/{name}/history` | Any management role | `200` retained-history/frontier view; can wake storage. |
| `GET /v1/databases/{name}/backups` | Any management role | `200` with `{backups: [...]}`. |
| `POST /v1/databases/{name}/backups` | admin or backup | `{name, retentionSeconds?}`; `202`. |
| `GET /v1/backups/{backup}` | Any management role | `200` recovery-point view. |
| `DELETE /v1/backups/{backup}` | admin or backup | Requests recovery-point deletion; `202`, subject to dependencies. |
| `POST /v1/databases/{name}/credentials` | Database audience, resource and mapped SQL role | `{role}`; `201` secret-bearing credential response. Use a database token, not the management header file above. |

There is no REST fleet-creation/deletion endpoint or collection-list endpoint for
all databases. Bootstrap/create/delete a `NeonFleet` and list resources through
the Kubernetes API. Fleet deletion retains data behind a finalizer. Native
`GET /get_endpoint_access_control`, `GET /wake_compute`, `POST /authorize_oauth`
and `POST /v1/databases/{name}/oauth/validate` are internal service protocols,
protected by proxy service credentials or endpoint-bound mTLS. Applications
should connect through PostgreSQL rather than call those protocols themselves.

### Request bodies and reconciliation

Fleet PUT replaces the complete desired spec. Read its current view, extract
`.spec`, edit the identity/defaults fields, then submit only that object:

```sh
neon_api "$NEON_API/v1/fleet" --output /secure/fleet-view.json
jq '.spec' /secure/fleet-view.json > /secure/fleet-spec.json
# Edit /secure/fleet-spec.json, retaining required storage and replication fields.
neon_api -X PUT -H 'Content-Type: application/json' --data-binary @/secure/fleet-spec.json "$NEON_API/v1/fleet"
```

Keep one authoritative policy writer, such as GitOps or a management backend.
The API uses Kubernetes resource versions internally but has no client-facing
ETag/If-Match contract. After a conflict, re-read rather than blindly replaying
a stale complete fleet policy. Domain, storage identity, zone topology and
metadata-provider changes require migration; a successful PUT acceptance does
not mean those changes can be reconciled in place.

For database provisioning, save this **JSON spec**, not a Kubernetes resource,
to `/secure/events-spec.json` and submit it:

```json
{
  "database": "app",
  "identity": {"tenant": "acme", "project": "billing"},
  "size": "small",
  "tier": "standard",
  "profile": "durable",
  "suspend": {"mode": "idle", "idleSeconds": 300}
}
```

```sh
neon_api -X PUT -H 'Content-Type: application/json' --data-binary @/secure/events-spec.json "$NEON_API/v1/databases/events"
neon_api "$NEON_API/v1/databases/events"
```

Database PUT merges supplied top-level fields with an existing definition;
omitted existing overrides stay explicit. New omitted policy fields inherit
fleet defaults. Changing database/user identity or branch ancestry in place is
restricted; use a new database/branch for a new SQL identity. Use the dedicated
suspend/resume/delete methods for lifecycle commands; those command fields are
not accepted through database PUT. See [lifecycle and retention](#suspend-resume-and-delete)
and [recovery methods](#history-backups-and-branches) before retiring data.

`202` means accepted, not complete. Poll the resource's `status`, observed
generation where exposed, and phase/reason. Do not infer successful provisioning,
backup readiness, safe shutdown or HA from the HTTP code alone. Common responses
are `401` for invalid authentication, `403` for authorization failure, `404` for
missing resources/routes, `409` for lifecycle/ownership conflicts, `422` for
invalid input, and `503` for unavailable leadership, storage, IdP or dependencies.
Retry bounded transient failures; correct policy or credentials for permanent
rejections. The emitted management audit operation ID correlates request outcome
with the verified issuer/subject; accepted commands still need status tracking.

## Webhooks and event-driven activation

The HTTPS controller accepts requests from a trusted platform backend. Enterprise
callers use the configured management audience and RBAC, with JWT or opaque
introspection as selected. The separate `neon-management-auth` Secret, key `token`,
is used for standalone static authentication or explicitly enabled enterprise
break-glass access. Proxy authentication does not grant management access.
The default NetworkPolicy permits webhook callers labeled
`neon.klustr.io/webhook-client: "true"` in the namespace. This is not a public
end-user identity/authorization service.

```text
PUT /v1/databases/events
{"size":"small","tier":"standard","suspend":{"mode":"idle","idleSeconds":300}}

POST /v1/databases/events/events
{"id":"job-123","holdSeconds":30}

GET /v1/databases/events
```

Send `Authorization: Bearer <management token>` over verified TLS to
`https://neon-controller.neon.svc.cluster.local:8080`. PUT creates or updates a
resource and returns 202. GET returns its spec/status. Events hold demand for a
bounded period; refresh while external work is queued. They are capacity signals,
not a durable job queue. Repeating the latest event ID does not extend its lease.

KEDA uses a mutually authenticated TLS external-push scaler. It scales the
`NeonDatabase` custom resource, whose controller drains before changing compute
replicas. A second target, `NeonStorageFleet`, governs shared storage. Do not point
HPA/KEDA directly at the generated compute or storage Deployments/StatefulSets.
The proxy can authenticate a normal PostgreSQL connection while storage sleeps,
then signal demand and await the full dependency chain.

## Suspend, resume and delete

These management operations use the same authenticated HTTPS API above. They are
asynchronous: 202 means accepted; poll `GET /v1/databases/<name>` for completion.

For example, using the verified TLS/API helper defined above:

```sh
neon_api -X POST "$NEON_API/v1/databases/events/suspend"
neon_api -X POST "$NEON_API/v1/databases/events/resume"
```

| Request | Behavior |
|---|---|
| `POST /v1/databases/events/suspend` | Drain safely and enter `Suspended`; block connection/event wake, including for an always-on database. |
| `POST /v1/databases/events/resume` | Permit wake again, preserving the configured idle/never policy. |
| `DELETE /v1/databases/events` with `{}` | Retire the endpoint and retain its timeline, credentials and history within configured retention. Completion is `Retained`. |
| `DELETE /v1/databases/events` with `{"mode":"purge","confirm":"events"}` | Retire, drain and permanently delete its native storage. Completion is `Deleted`. |

Active queries and transactions defer stopping; there is no unsafe force-kill
option. Purge requires the exact resource name and refuses dependent branches or
backups. Purge dependent branches, then delete their backups first; retiring a
child with the default retain mode still preserves that dependency. A retired name remains a tombstone and
cannot be resumed or reused through PUT; clone retained data to a new name instead.
Deployment credentials/PVCs are retained; purge deletes the tenant or branch
through the storage controller, never a shared bucket or another database.

The YAML equivalents are `spec.lifecycle: suspended` or `active`; retirement is
`lifecycle: retired`, `replicas: 0`, `deletionPolicy: Retain` (or explicitly `Delete`).
Ordinary `kubectl delete neondb` retains data behind a finalizer; do not remove it
to bypass recovery/dependency safeguards. Inspect status before final cleanup.

## History, backups and branches

This follows Neon's distinction between [retained history](https://neon.com/docs/postgres/backup-restore/history-window)
and [backup strategies](https://neon.com/docs/postgres/backup-restore/backups).
Native timelines provide copy-on-write branches and snapshots without application
SQL changes. A snapshot shares the primary S3 storage and ancestry; it is not an
independent `pg_dump` export or disaster-recovery copy.

Configure a root database through PUT or its Kubernetes spec:

```yaml
backup:
  historySeconds: 604800     # Seven-day PITR window; default, maximum 30 days
  scheduleSeconds: 86400    # Daily native snapshot; default 0 disables scheduling
  retentionSeconds: 2592000 # Keep each scheduled snapshot for 30 days
```

`historySeconds` sets the native tenant `pitr_interval`. Increasing it cannot
recover already collected history; decreasing it makes older unpinned history
eligible for garbage collection. Zero disables the time-based history guarantee.
GC and snapshot expiry run when services/controller are available, so actual
deletion can lag the policy. Inspect `GET /v1/databases/events/history` for the
current shard frontiers and oldest readable LSNs; this request can wake storage.

Schedules have a minimum five-minute interval, use UTC time slots and coalesce
missed slots into a current snapshot. Enabling schedules can periodically wake the
storage fleet even without application traffic. Retention starts at snapshot
creation; changing the policy affects future snapshots. Expired snapshots with
dependent branches remain pinned and report `DEPENDENT_BRANCHES`.

```text
POST /v1/databases/events/backups
{"name":"before-migration","retentionSeconds":604800}

GET /v1/databases/events/backups
GET /v1/backups/before-migration

POST /v1/databases/events/branches
{"name":"preview","size":"micro"}

POST /v1/databases/events/branches
{"name":"restored","backup":"before-migration","size":"small"}

POST /v1/databases/events/branches
{"name":"at-time","timestamp":"2026-11-01T10:00:00Z"}

DELETE /v1/backups/before-migration
```

Snapshot creation returns 202; wait for `NeonBackup.status.phase: Ready` before
restoring. Completion verifies the snapshot's generation-validated remote frontier.
Clone defaults to the current WAL frontier and waits for storage catch-up. An
explicit `lsn` can replace `timestamp`; specify only one of `backup`, `lsn`, or
`timestamp`. Missing/pruned history fails rather than substituting another point.
Native all-shard leases protect the selected point during branch creation.

Clone/restore creates a **new writable database resource and endpoint**, leaving
the source unchanged. Use `GET /v1/databases/restored` for its endpoint and client
Secret. Existing schema, data and SQL roles are copied; the managed client and
lifecycle role get distinct credentials for the new endpoint. Audit inherited
roles before exposing a production clone. Branching copies the entire PostgreSQL
timeline, including any additional SQL databases, rather than selected tables.

Branches can choose their compute size and suspend policy. They share the root's
storage tenant, tier, shard count and history policy; configure these on the root.
A declarative branch uses `spec.branchFrom: {database: events, backup: before-migration}`
with the normal size/tier fields. Branch source is immutable. Inspect resources
with `kubectl -n neon get neondb,neonbackups`.

These APIs are available in the Kubernetes KEDA deployment. Compose currently
supports the native history configuration but does not run the branch/snapshot
management controller. Independent exports with `pg_dump`/`pg_restore`, off-site
copies, and backup of the metadata database and Kubernetes Secrets remain operator
responsibilities. No destructive in-place rewind/reset or branch merge is exposed.

## Connect

For resource `events`, direct PostgreSQL SNI is `ep-events.<configured domain>`.
It resolves to the proxy. The default domain is `db.local` for local integration.
Export the CA from Secret `neon-service-ca`, key `ca.crt`, to a protected local file:

```sh
psql 'host=ep-events.db.local hostaddr=127.0.0.1 port=55432 dbname=app user=app_user sslmode=verify-full sslrootcert=/secure/neon-ca.crt connect_timeout=180'
```

The example assumes a local port forward to Service `neon-proxy`. Supply the
password through a protected `.pgpass` or secret manager. No application-specific
SQL functions or document APIs are required.

### pgAdmin and public runtime aliases

In pgAdmin's server dialog, set **Host name/address** to the published database
hostname, **Port** to the actual PostgreSQL listener port (443 is valid when
the platform publishes PostgreSQL there), **Maintenance database** to the SQL
database, and **Username** and **Password** to the separate SQL credentials.
In **Parameters**, set `sslmode` to `verify-full` with the appropriate trusted CA,
or `require` when only encrypted transport is configured. Avoid `prefer`, which
can retry without TLS and obscure the first error on a shared port 443 listener.

The published hostname and TLS SNI must identify the database without a separate
client endpoint parameter. A runtime gateway maps its registered public alias
to the native endpoint and sends that endpoint as upstream SNI. This proxy
source reads certificate DNS SANs, including certificates with a generic common
name; older proxy images that only read the common name must be upgraded.
Use an appropriate `connect_timeout` for a suspended database's wake, for
example 90 seconds.

The explicit libpq `options='endpoint=ep-events'` selector remains a fallback
for clients without SNI. It is not required by the intended public hostname
contract. Do not change SQL passwords to carry routing information.

TLS termination is a separate integration constraint. If a gateway presents
a different certificate and re-establishes TLS to the proxy, SCRAM channel
binding cannot span those two certificate identities. The current offloaded
public route can fail with `secure channel data mismatch`; this image changeset
does not resolve that gateway authentication integration. Use an end-to-end
TLS route when deploying clients that require channel binding. Do not treat
client-side endpoint overrides or disabling channel binding as the permanent
fix, and do not disable channel binding globally in the proxy.

The public gateway must forward the PostgreSQL wire protocol to `neon-proxy`;
an ordinary HTTP ingress cannot serve PostgreSQL. A generic TLS passthrough
router may require libpq 17+ `sslnegotiation=direct` with `sslmode=require` or
stronger; a PostgreSQL-aware listener supports normal SSL negotiation. Choose
this from the deployed gateway's behavior, rather than enabling it blindly.
`expected authentication request ... received H` often indicates an HTTP response;
inspect the listener and TLS/fallback settings rather than treating it as a bad
database password. See [pgAdmin parameters](https://www.pgadmin.org/docs/pgadmin4/latest/server_dialog.html)
and [libpq TLS options](https://www.postgresql.org/docs/18/libpq-connect.html).

Proxy client errors use Klustr-owned help links under
`https://klustr.io/docs/neon/`, including `/sni` and
`/connection-errors#unsupported-startup-parameter`. Those website routes must
be published by the Klustr documentation site; changing the proxy does not
publish the site. This deployment guide contains the setup instructions even
when a public help page has not yet been published.

## Packaged PostgreSQL extensions

### Statement metrics and idle-safe telemetry

Managed compute always preloads `neon,pg_stat_statements`, with query identifiers
enabled and top-level/utility statement tracking. Native compute startup runs
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public` in each
connectable database declared in its compute specification and in the internal
`postgres` database. No application bootstrap SQL is required for those databases.
Changing optional `preloadLibraries`, including `[]`, retains this mandatory
baseline. Existing deployments need the matching updated compute and controller
images and a normal managed compute restart; the controller never wakes a dormant
database merely to install telemetry. SQL-created databases outside the managed
specification follow normal PostgreSQL per-database extension activation.

Collect through the private compute-control HTTP listener on port 3080:

- `GET /metrics` exports the compute process's Prometheus metrics.
- `GET /insights` exports up to 100 statement records, ordered by mean execution
  plus planning time, and excludes the reserved internal roles. Use the configured
  compute-control authorization and keep this SQL-text-bearing endpoint private.
  The handler requires running PostgreSQL; it cannot wake or start compute.

Discover only existing running compute Pods/containers. When a database is
suspended, stop SQL collection and serve previously exported history from your
external metrics store. Keep the compute-control listener behind the existing
private-network policy; grant only the chosen collector access. Do not scrape
through the customer PostgreSQL proxy, call `/wake_compute`, or send synthetic
customer SQL to collect metrics: those paths represent application demand and
can wake or retain compute.

Internal insights connections use the reserved role in `postgres`. Idle detection
excludes their sessions and statement counters while preserving real application
activity, including short-lived customer queries in `postgres`. Ignoring telemetry
is bound to internal SQL identity; an application cannot opt out of idle detection
by changing `application_name`. Customer database session/activity counters remain
part of idle detection. Missing statistics fail closed, retaining running compute
rather than guessing that it is safe to suspend.

Statement counters can reset on compute replacement, statistics reset or entry
eviction. Retain exported telemetry outside the sleeping database. Ordinary SQL
reads of `pg_stat_statements` through a customer's database connection remain
normal application work and affect its idle timer.

### Optional extension capabilities

The source build installs the following into compute and pageserver images;
no extension download service or package manager is needed at runtime. Older
published RC5 and `fa67859` images do not contain these additions. Build a new
coordinated image set before selecting these libraries, and update the packaged
runtime digest authority as described in [image selection](#release-and-image-selection).
Apply the updated database CRD as well; an older CRD can prune `preloadLibraries`.

| Capability | Extension / version | Startup library |
|---|---|---|
| Data masking | [PostgreSQL Anonymizer](https://postgresql-anonymizer.readthedocs.io/en/stable/) `anon` 3.3.2 | `anon` |
| Approximate distinct counts, quantiles and sketches | [Apache DataSketches](https://github.com/apache/datasketches-postgresql) `datasketches` 1.7.0, C++ core 5.2.0 | None |
| Exact, HNSW and IVFFlat vector search | [pgvector](https://github.com/pgvector/pgvector) `vector` 0.8.7 | None |
| Time-series hypertables and time bucketing | [TimescaleDB](https://github.com/timescale/timescaledb) `timescaledb` 2.31.0, Apache-only | `timescaledb` |
| BM25 ranked full-text search | [pg_textsearch](https://github.com/timescale/pg_textsearch) 1.5.1 | `pg_textsearch` |
| PostgreSQL full-text search | Built-in `tsvector`, `tsquery`, GIN and ranking | None |

DataSketches and pgvector do not need startup preloading. Their binaries are
already installed; `CREATE EXTENSION` enables their SQL objects in each target
database, and PostgreSQL loads the library when used. Leaving them out of
`preloadLibraries` does not omit them from the image or disable their features.

TimescaleDB is built with `APACHE_ONLY=ON` and telemetry disabled. Its
Timescale-Licensed components are excluded: columnstore/compression, continuous
aggregates and TSL policy APIs are unavailable. The upstream
[license split](https://github.com/timescale/timescaledb/blob/2.31.0/LICENSE) and
[Timescale License](https://github.com/timescale/timescaledb/blob/2.31.0/tsl/LICENSE-TIMESCALE)
describe the separate terms for those components, including database-service
restrictions. This build does not grant rights to those features.

Select startup libraries through `NeonDatabase.spec.preloadLibraries`, or the
same `preloadLibraries` field in a database `PUT /v1/databases/<name>` body:

```yaml
apiVersion: neon.klustr.io/v1alpha1
kind: NeonDatabase
metadata:
  name: documents
  namespace: neon
spec:
  database: app
  size: small
  preloadLibraries: [timescaledb, anon, pg_textsearch]
  suspend: {mode: idle, idleSeconds: 300}
```

Only these three optional packaged libraries are accepted; arbitrary library paths are
rejected. Neon and `pg_stat_statements` remain loaded. Omission keeps the existing configuration;
`[]` selects none of the optional libraries. Branches inherit the source's
selection when omitted. A changed selection is a compute configuration revision
and requires a restart/reconciliation. For Compose, put the same field on the
tenant entry in `compose/config/cluster.yaml`. Libraries do not automatically
create database extensions or masking rules. Avoid removing a library while
its database objects or policies still require it.

After the compute has restarted, a trusted database administrator enables the
desired extensions once in each SQL database:

```sql
CREATE EXTENSION anon;
SELECT anon.init();  -- initialize the packaged faking datasets
CREATE EXTENSION datasketches;
CREATE EXTENSION vector;
CREATE EXTENSION timescaledb;
CREATE EXTENSION pg_textsearch;
```

Keep superuser authority with the operator; application roles do not receive it
by selecting a library. Anonymizer requires explicit masking policies and masked
roles; merely installing it does not anonymize data. Use its upstream
[loading instructions](https://postgresql-anonymizer.readthedocs.io/en/stable/load/)
and [masking documentation](https://postgresql-anonymizer.readthedocs.io/en/stable/dynamic_masking/).
Static masking changes stored data and should only run on the intended database
or branch. For transparent dynamic masking, configure
`anon.transparent_dynamic_masking=on` for the target database and reconnect.

Ordinary SQL then uses these capabilities directly:

```sql
CREATE TABLE documents (id bigint PRIMARY KEY, body text, embedding vector(3));
CREATE INDEX documents_fts ON documents USING gin (to_tsvector('english', body));
CREATE INDEX documents_bm25 ON documents USING bm25 (body) WITH (text_config='english');
CREATE INDEX documents_vectors ON documents USING hnsw (embedding vector_cosine_ops);
SELECT id FROM documents WHERE to_tsvector('english', body) @@ websearch_to_tsquery('english', 'database');
SELECT id FROM documents ORDER BY body <@> 'database search' LIMIT 10;
SELECT id FROM documents ORDER BY embedding <=> '[0.1,0.2,0.3]' LIMIT 10;
SELECT hll_sketch_get_estimate(hll_sketch_build(id)) FROM documents;

CREATE TABLE measurements (time timestamptz NOT NULL, value double precision);
SELECT create_hypertable('measurements', by_range('time'));
SELECT time_bucket(INTERVAL '1 hour', time), avg(value)
FROM measurements GROUP BY 1;
```

These extensions run inside compute and do not keep a separate search/vector
service alive. Stored objects follow the database's WAL, history and branches.
Background maintenance stops while compute is suspended; choose `mode: never`
when scheduled database work must run continuously. Budget memory and worker
slots for the selected workload, including index builds. Selecting TimescaleDB
defaults `max_worker_processes` to 32 to leave slots for Neon and TimescaleDB;
an explicit provider setting can override that budget. Basic image checks
cover operations and restart; production load, multi-zone recovery and each
extension's interaction with your policies still need workload qualification.

## Docker Compose

Compose remains a single-host integration path with compute-only suspension.
KEDA and whole-storage-fleet suspension are implemented in the Kubernetes path.
Configure S3 and optional tenants in
[`compose/config/cluster.yaml`](neon/packaging/compose/config/cluster.yaml), then:

```yaml
tenants:
  - name: events
    size: small
    tier: standard
    suspend: {mode: idle, idleSeconds: 300}
```

Client CIDRs inherit the provider's `clientCIDRs` unless explicitly overridden.

```sh
cp neon/packaging/compose/.env.example neon/packaging/compose/.env
# Edit .env with S3 credentials and config/cluster.yaml with storage/tenant settings.
docker compose --env-file neon/packaging/compose/.env -f neon/packaging/compose/compose.yaml --profile pull pull
docker compose --env-file neon/packaging/compose/.env -f neon/packaging/compose/compose.yaml up -d
```

The controller and PostgreSQL/Rust services use digest-pinned public
images. Compose needs Docker 29/Compose v2 on AMD64. `name` in cluster configuration
must match `COMPOSE_PROJECT_NAME` (default `neon`). Port defaults to loopback 55432.
Set `DOCKER_GID` to the Docker socket group on Linux. The controller's socket access
grants host-level Docker authority; use a trusted host. Never use `down -v` to sleep
an environment. Credentials/CA live in its retained state volume.

## Kubernetes resource inventory

| Resource | Owner / purpose |
|---|---|
| `NeonFleet` / `neonfleets.neon.klustr.io` | Customer/provider policy in one namespace; one established owner. [Enterprise CRD](neon/packaging/kubernetes/enterprise/fleet-crd.yaml). |
| `NeonDatabase` / `neondatabases.neon.klustr.io` | Database sizing, tier, OIDC ownership binding and lifecycle; exposes the drain-aware scale subresource. [Database CRD](neon/packaging/kubernetes/keda/database-crd.yaml). |
| `NeonBackup` / `neonbackups.neon.klustr.io` | Retained native recovery point and status. [Backup CRD](neon/packaging/kubernetes/keda/backup-crd.yaml). |
| `NeonStorageFleet` / `neonstoragefleets.neon.klustr.io` | Shared storage demand and safe zero/one scale target, normally named `storage`. [Storage-fleet CRD](neon/packaging/kubernetes/keda/fleet-crd.yaml). |
| KEDA `ScaledObject` and `TriggerAuthentication` | External-push demand over mTLS gRPC; scale the custom resources, not raw writer Deployments. |
| Enterprise operator Deployment, ServiceAccount and RBAC | Reconcile the namespace stack; the shared `neon-fleet-node-reader` ClusterRole grants read-only node discovery. [Operator resources](neon/packaging/kubernetes/enterprise/operator.yaml). |
| `neon-cluster` ConfigMap | Provider configuration derived from the fleet; not an independently edited authority in enterprise mode. |
| `neon-ep-*` ConfigMaps and compute Deployments/Services | Generated endpoint definitions, placement, revisions and runtime state. Do not manually raise writer replicas or edit routing as a scaling shortcut. |
| Pageservers, safekeepers, broker, storage controller and optional local metadata | Shared storage architecture; the operator/controller manage placement and safe suspension. [Base workloads](neon/packaging/kubernetes/base/storage.yaml). |
| `neon-proxy` Service | Internal PostgreSQL front door on port 5432; attach a provider-managed L4 LoadBalancer/DNS endpoint. |
| `neon-controller` Service | HTTPS API on 8080; health/storage hooks on 9090; KEDA scaler on 9091. Health ports are not management API endpoints. |

### Secret and trust inventory

| Secret | Contents / handling |
|---|---|
| `spec.storage.objectStoreSecretRef` | Customer-created AWS-compatible access keys, region, S3 endpoint, bucket and prefix. |
| `spec.identity.caSecretRef` | Optional customer-created IdP `ca.crt`. |
| Each `tokenValidation.clientSecretRef` | Customer-created introspection credential under the selected key; mounted only into the controller. |
| `spec.storage.metadataDatabaseSecretRef` | Optional customer-created metadata `url` and CA files. |
| `neon-service-ca` | Public internal CA certificate; export this certificate for client trust when using bootstrap-issued proxy certificates. |
| `neon-proxy-tls`, `neon-controller-tls`, `<database>-compute-tls` | Generated service certificates/private keys. Preserve the trust chain and plan certificate renewal; full service-CA/certificate rotation remains qualification work. |
| `<database>-oauth` | Generated native HBA, endpoint-specific validator client certificate/key and CA. Not an application credential. |
| `neon-keda-client-tls` | Generated client identity for KEDA scaler authentication. |
| `neon-management-auth`, `neon-controller-auth` | Separate management break-glass and internal proxy service credentials. Neither replaces customer database authorization. |
| `<database>-client`, `<database>-admin`, `<database>-roles`, `<database>-compute-spec` | Provider bootstrap/administrative credentials and native runtime inputs. Give customer applications mapped native roles or issued expiring credentials, not the privileged bootstrap owner. |
| `neon-bootstrap-state` and service/storage configuration Secrets | Retained signing keys, CA authority and storage/bootstrap state. Include them in protected recovery procedures; do not dump them into agent output. |

For external PostgreSQL access, create a provider-owned L4 Service selecting the
proxy, for example:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: neon-proxy-public
  namespace: customer-a
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local
  selector:
    app.kubernetes.io/name: neon-proxy
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
```

Point your configured wildcard DNS at the resulting front door. Keep PostgreSQL
TLS/SNI intact; bootstrap certificates use the configured wildcard domain and
need client trust in the exported CA. Confirm the load balancer's source-IP
preservation and routing behavior before relying on `clientCIDRs`: after SNAT,
the proxy otherwise sees the intermediary's address. Provider-specific load
balancer annotations, public certificate automation and ingress HA remain
deployment infrastructure, not additional `NeonFleet.spec` fields.

## Small setup verification and troubleshooting

For an agent handoff, record the selected context/namespace, fleet/database names,
qualified image digests, CSI class, physical zones, S3 location, IdP issuer and
audiences, Secret **names**, desired idle policy and required recovery objectives.
Record reconciliation status and unresolved gates. Keep access tokens, keys,
passwords and credential-bearing DSNs out of the handoff.

Start with read-only observations:

```sh
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" get neonfleet,neondb,neonbackups,neonstoragefleet
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" get pods,pvc,scaledobject,triggerauthentication
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" get events --sort-by=.lastTimestamp
kubectl --context "$NEON_KUBE_CONTEXT" -n "$NEON_NAMESPACE" logs deployment/neon-tenant-controller --tail=100
```

Then use one owned test database with a five-minute idle policy. Authenticate
with the intended client/role and check:

```sql
SELECT current_database(), current_user, system_user,
       '{"probe":"connected"}'::jsonb ->> 'probe';
```

This verifies authentication and ordinary JSONB SQL, not durable writes. For the
full setup smoke check, commit one small JSONB row through an existing application
table/migration, record its key, let compute reach zero, reconnect and read it
back. If the last database is idle, separately observe the storage fleet drain
and wake. Check one rejected token for scope/audience/ownership and confirm it
does not cause wake demand. Use resource status to distinguish `Provisioned`,
actual replicas, dormancy and an explicitly `Suspended` endpoint. No large data
load or benchmark matrix is needed for installation verification.

| Symptom | Check |
|---|---|
| Fleet stays `Pending` | `status.reason/message`, real Ready zone-labeled nodes, taints, CSI topology/capacity, image pulls, S3 Secret keys and ownership conflicts. |
| Fleet is `Provisioned`, but not serving | Deployment/Pod readiness, database status, leadership and intentionally zero worker counts; provisioning is not a serving-state assertion. |
| Controller Pod cannot mount a Secret | Namespace, Secret reference/key, optional IdP CA and separate management/database introspection mounts. Create referenced Secrets before enabling their policy. |
| `OIDC_TOKEN_INVALID` / `OIDC_ACCESS_DENIED` | Correct token type, issuer, audience, expiry, allowed JWT algorithm, array-valued groups, role bindings and exact database tenant/project claims. |
| `OIDC_INTROSPECTION_UNAVAILABLE` | HTTPS chain, private CA mount, resource-server credential/key, authentication method, fixed endpoint, provider HTTP errors and three-second deadline. Do not switch to permissive authentication to bypass an outage. |
| Native OAuth requests cleartext password or SCRAM | Matching rebuilt proxy/compute/controller release, SNI hostname/domain mapping, compatible certificate SANs and explicit `oauth.enabled: true`. Keep `require_auth=oauth` in client verification. |
| Client has no OAuth flow | PG18 OAuth-capable libpq/driver, its installed OAuth client library, IdP grant/client registration or application token hook. Supplying a token as a password does not implement native OAuth. |
| Database refuses wake | Manual suspension/retirement, retiring fleet, policy rejection, missing dependencies or failed durability checks. An activity event cannot override explicit suspension; use resume. |
| Active authentication configuration will not change | Complete a safe suspend/resume for HBA-affecting policy changes; quiesce active work rather than force-killing a writer. |
| Storage remains running after compute sleeps | Other active/always-on databases, pending recovery work, unknown tenants/timelines, or an unverified remote frontier. Preserve the drain guard and inspect its reason. |
| Changed S3/domain/metadata/zone policy does not apply | Established storage identity is protected. Plan a migration rather than deleting finalizers or replacing stateful resources. |

### Source and upstream resources

Use the versioned source contracts when writing automation:

- [Fleet validation](neon/controller/tenant-compute/src/domain/fleet/FleetSpecification.mjs)
  and [fleet resource generation](neon/controller/tenant-compute/src/infrastructure/provisioning/FleetResources.mjs).
- [Identity policy](neon/controller/tenant-compute/src/domain/identity/IdentityPolicy.mjs),
  [validation modes](neon/controller/tenant-compute/src/domain/identity/TokenValidationPolicy.mjs)
  and [native OAuth policy](neon/controller/tenant-compute/src/domain/identity/NativeOAuthPolicy.mjs).
- [Database API routes](neon/controller/tenant-compute/src/api/database/DatabaseRoutes.mjs),
  [fleet API routes](neon/controller/tenant-compute/src/api/fleet/FleetRoutes.mjs)
  and [database specification](neon/controller/tenant-compute/src/domain/database/DatabaseContracts.mjs).
- [PG18 OAuth](https://www.postgresql.org/docs/18/auth-oauth.html),
  [libpq connection options](https://www.postgresql.org/docs/18/libpq-connect.html),
  [OIDC discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)
  and [RFC 7662 introspection](https://www.rfc-editor.org/rfc/rfc7662.html).
- [KEDA external scalers](https://keda.sh/docs/2.21/concepts/external-scalers/),
  [ScaledObject contract](https://keda.sh/docs/2.21/reference/scaledobject-spec/)
  and the [checked-in KEDA resources](neon/packaging/kubernetes/keda).
- [Neon architecture](https://neon.com/docs/introduction/architecture-overview),
  [history window](https://neon.com/docs/postgres/backup-restore/history-window)
  and [backups](https://neon.com/docs/postgres/backup-restore/backups). Hosted
  product guarantees and API options do not automatically apply to this fork.

## Durability, retention and qualification

`durable` is the default profile, with fsync and synchronous commit enabled.
Opt-in `bounded-async` acknowledges earlier and risks an acknowledged tail. Its
750ms/64MB guard settings do not constitute a sustained-load one-second RPO
certification. Both profiles drain on planned suspension. Fleet shutdown additionally
checks the generation-validated remote frontier for every managed storage shard.
A failed S3 durability check leaves storage running.

Back up controller metadata PostgreSQL, Kubernetes Secrets/resources and S3 data.
Deleting a `NeonDatabase` drains and retains it behind a retention finalizer; it
does not delete database files, PVCs or S3 objects. Administrative retirement must
explicitly handle retained state. Unmanaged storage tenants/timelines prevent fleet
shutdown rather than allowing an unsafe stop.

Historical 15-second, single-host JSONB/GIN measurements used 10,000 documents:

| Mode | Writes/sec | Relative to relevant native baseline |
|---|---:|---:|
| Native PostgreSQL, durable | 2,571 | 100% |
| Neon, durable quorum | 506 | 19.7% |
| Neon, bounded/local fsync benchmark variant | 1,180 | 45.9%; different acknowledgement policy |
| Native PostgreSQL, asynchronous | 25,734 | 100% |
| Neon, bounded ephemeral, matched total CPU | 9,322 | 36.2% |
| Neon, 8 compute + 8 storage CPUs | 8,660 | 33.7%; native had 8 CPUs |

These predate the frontend/controller path and do not establish current Kubernetes
throughput, latency or read/write IOPS. The 85% native throughput goal is not met;
transparent JSONB/TOAST deltas remain unimplemented. Full HA/fencing, physical
node-to-zero, rotation and sustained-load recovery remain production gates.
See [current qualification](neon/docs/neon-production/CURRENT-CANDIDATE.md).

Keep deployment checks small: one normal SQL write, idle-to-zero, wake/readback,
and a size/tier change. Lifecycle status is available even while the database fleet
is asleep. KEDA behavior follows its [custom resource scale contract](https://keda.sh/docs/2.21/reference/scaledobject-spec/)
and [external-push protocol](https://keda.sh/docs/2.21/concepts/external-scalers/).
