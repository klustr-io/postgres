# Deploy Neon PostgreSQL 18

This repository provides Docker Compose and Kubernetes YAML for the Neon database
architecture. The Kubernetes KEDA path supports declarative database provisioning,
size/tier changes, demand webhooks, compute suspension and shared-storage suspension.
Applications use normal PostgreSQL connections, SQL and JSONB.

**These changes are newer than RC4.** Deployment YAML pins the updated public
controller image built from commit `1d895c7dcc2fb31e9dc480cf8cd9bd385a55532c`;
other runtime images are pinned to RC4 digests. This is an integration candidate,
not a production HA certification. [Controller build and publication](https://github.com/klustr-io/postgres/actions/runs/41304715810).

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

## Webhooks and event-driven activation

The HTTPS controller accepts requests from a trusted platform backend. Use the
separate `neon-management-auth` Secret, key `token`; proxy authentication does not
grant management access. The default NetworkPolicy permits webhook callers labeled
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

For example, with `NEON_API`, `NEON_CA` and a management token supplied securely:

```sh
curl --fail-with-body --cacert "$NEON_CA" -H "Authorization: Bearer $NEON_MANAGEMENT_TOKEN" -X POST "$NEON_API/v1/databases/events/suspend"
curl --fail-with-body --cacert "$NEON_CA" -H "Authorization: Bearer $NEON_MANAGEMENT_TOKEN" -X POST "$NEON_API/v1/databases/events/resume"
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
