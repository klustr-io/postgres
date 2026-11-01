# Current candidate: PostgreSQL 18.6 / AMD64

The current working branch additionally contains unreleased KEDA/database/fleet
lifecycle support. See [DEPLOY.md](../../../DEPLOY.md) for its scope and build
requirements; these changes are not included in the RC4 controller image below.

`18.6-rc.4` is the first single-checkout GitHub publication candidate. The engine,
Neon runtime, extensions and tenant controller build directly from checked-in
source. Applications retain standard PostgreSQL SQL and JSONB.

[Workflow](https://github.com/klustr-io/postgres/actions/workflows/neon-pg18-candidate.yml)
and [release assets](https://github.com/klustr-io/postgres/releases/tag/neon-v18.6-rc.4)
provide the build result, seven OCI archives, SHA-256 checksums and digest-pinned
GHCR references. Each image includes the source commit revision. GHCR anonymous
pull verification is recorded separately from archive publication.

The preceding local source build passed all 231 standard PostgreSQL regressions,
four protocol authentication tests, 15 focused Node checks and executable smoke
for all seven images. Its compilation used a freshly built dependency toolchain.
That evidence does not substitute for the current GitHub run or certify production HA.

## Measured performance limits

Prior single-host, 15-second JSONB/GIN intervals used 10,000 documents and normal
EXTENDED storage. Durable native PG reached about 2,571 writes/sec, durable remote-
quorum Neon 506, bounded/local-fsync Neon 1,180, bounded ephemeral Neon 9,322,
and asynchronous native PG 25,734. With eight additional storage CPUs Neon reached
8,660. These measurements exclude the newly added frontend proxy/controller path.

Fast Neon therefore reached approximately 36% of comparably asynchronous native
PostgreSQL throughput; the 85% goal is not met. Different failure topologies,
flush policies and brief shared-host timing windows limit this comparison.
No new performance claim is made for RC4.

## Remaining production gates

- Controller HA, cross-worker fencing/migration and credential/certificate rotation.
- Production storage failure domains and controller metadata-database recovery.
- Sustained-load qualification of the accepted acknowledged-write loss envelope.
- Near-native performance and transparent JSONB delta/projection mechanics.

The current controller implements configurable idle/never policies, writer
reservations, admission closure, quorum drain and wake routing. It pins writers
to a worker and does not automatically migrate a potentially live writer after a
partition. Provisioned storage and administrator-provided ComputeSpecs/Secrets
are prerequisites. Page checksums remain unsupported by Neon page reconstruction.
