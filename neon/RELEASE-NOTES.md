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
