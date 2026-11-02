# Enterprise fleet controller — source update

- A namespace-scoped `NeonFleet` operator provisions the checked-in architecture
  from YAML or Kubernetes APIs and exposes fleet updates through management APIs.
- Customer OIDC validates management roles and database tenant/project bindings;
  a short-lived credential exchange supports ordinary PostgreSQL TLS/SCRAM clients.
  A managed data-only role avoids delegating Neon's privileged application owner.
- Three-zone safekeeper affinity and durable profiles enforce the selected WAL
  quorum layout. External HA metadata PostgreSQL is optional and separately managed.
- Basic OIDC-to-PostgreSQL JSONB write/read and expiry passed locally. The operator
  rejects missing physical zones. Real zone-loss recovery and automatic writer
  fencing are not qualified; status does not claim automatic failover readiness.
- Native engine/storage image references advance to the published RC5 digests;
  these new controller features are not part of the immutable RC5 controller tag.

# Neon PostgreSQL 18.6 — 18.6-rc.5

RC5 rebuilds all seven Linux AMD64 images with deployment, lifecycle and recovery
support. The PostgreSQL engine/runtime performance limits remain unchanged.

- Explicit suspend/resume and retain/purge API operations, with sticky wake
  blocking, safe drain and dependent-branch/backup protection.
- Root history-window policies, native copy-on-write cloning/PITR to new branches,
  and `NeonBackup` read-only snapshots with optional schedules and retention.
  Snapshots share primary object storage; independent DR exports remain external.

- Checked-in Docker Compose and Kubernetes/Kustomize YAML provision the broker,
  two pageservers, three safekeepers, metadata PostgreSQL, storage controller and proxy.
- Shared bootstrap accepts S3 configuration and optional tenants; retains generated
  TLS/SCRAM/storage credentials and creates PG18 tenants, timelines and endpoints.
- Compose can drain and stop/start compute through the Docker API. Kubernetes
  retains its drain-before-zero behavior. Both support idle/never policies.
- Declarative `NeonDatabase` resources select provider-owned size/tier presets,
  PostgreSQL memory/connection settings, read admission budgets and secondary placement.
- Kubernetes watches and authenticated management/event webhooks drive continuous
  provisioning. KEDA external-push scaling uses mutual TLS and drain-aware scale
  subresources rather than directly scaling PostgreSQL Deployments.
- Storage placement/sharding and safekeeper membership hooks persist routing and
  reload active compute. Size changes use a guarded, drained restart.
- `NeonStorageFleet` can suspend all database/storage worker Pods after the final
  compute sleeps and S3's generation-validated frontier covers its WAL. Gateway,
  lifecycle control and Kubernetes/KEDA remain available to wake the stack.
- A local full-fleet cold wake/readback passed in about 20 seconds with cached
  images and an already-running worker; this is one integration sample, not an SLA.
- Physical node provisioning/fencing, project HTTP/SNI routing, hard write-I/O
  isolation and production HA/RPO qualification remain open. Existing native-PG
  performance measurements are unchanged; near-native throughput is not certified.

The updated controller is published under source tag
`sha-1d895c7dcc2fb31e9dc480cf8cd9bd385a55532c` and pinned by digest in deployment
YAML. The RC4 controller does not contain these changes. Storage/compute manifests
pin the existing RC4 digests.

# Neon PostgreSQL 18.6 — 18.6-rc.4

This release candidate builds PostgreSQL and the Neon data plane from one
source-controlled checkout and publishes seven Linux AMD64 OCI images.

- PostgreSQL 18.6 engine with the Neon PG18 integration and visibility-map redo fixes.
- Pageserver, safekeeper, storage controller, storage broker, proxy and compute management built directly from checked-in source.
- Native bounded asynchronous commit admission, durable drain/frontier tracking,
  PID-file locking repair, S3-compatible transport handling and startup-cache repair.
- Loopback-only unauthenticated compute management API and a bounded SCRAM
  iteration count in the proxy protocol implementation.
- Minimal non-root images, read-only image smoke checks, pinned dependencies,
  source revision labels, OCI archives, SHA-256 checksums and a registry digest manifest.
- Kubernetes tenant/compute lifecycle controller with a five-minute idle default,
  `never` suspension policy and per-database overrides. A never-suspend database
  keeps its shared compute running. Applications continue to use ordinary PostgreSQL SQL and JSONB.

GitHub Actions runs focused controller checks, the standard PostgreSQL regression
suite, protocol authentication checks and image startup checks before publication.
Pull requests receive read-only checks and never publish packages.

## Qualification limits

This is a release candidate for integration, not a production certification.
Production controller HA, cross-worker fencing/migration, credential rotation,
full storage failure-domain deployment and sustained-load recovery qualification
remain open. Provisioned Neon storage, durable S3 and controller metadata PostgreSQL,
ComputeSpecs and TLS/SCRAM Secrets are required; the images do not provision a
complete managed service by themselves.

The 85% native-PostgreSQL throughput goal has not been met. The prior small JSONB
comparison reached approximately 36% of asynchronous native PostgreSQL throughput
under the matched total CPU budget. No new performance claim is made for this
release. Transparent JSONB delta storage and selective physical projection are
not implemented. The opt-in fast profile's one-second acknowledged-tail recovery
bound has not been certified under sustained load. PostgreSQL page checksums
remain unsupported by the Neon page reconstruction path.

Use digest-pinned image references from `release-manifest.json`. RC tags update
`candidate`; stable tags alone update `latest`. An RC never advances `latest`.
Public OCI archives can be verified with `SHA256SUMS` and loaded using `docker load`.
