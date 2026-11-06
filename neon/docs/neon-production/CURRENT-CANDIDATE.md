# Current candidate: PostgreSQL 18.6 / AMD64

The candidate also includes the recovery protocol repair for PostgreSQL client
row metadata. Pageserver IDENTIFY_SYSTEM and compute timeline/lease readers no
longer assume that message zero is a data row. Image publication runs three
focused IDENTIFY_SYSTEM wire-protocol tests; deployment restore and public-app
availability must be checked separately after upgrading.

The DOCB 0.2 candidate makes delta-backed storage the default behind ordinary
JSONB columns. Application SQL, JSONB type identity, indexes and driver mappings
remain intact. New inserts establish full bases, eligible updates use deltas,
and reads never silently migrate existing rows. Standard storage is an explicit
opt-out. SQL commands migrate a table or the current database in either direction;
table rewrites take exclusive maintenance locks and database migration commits
per relation with an explicit resume checkpoint. EXPLAIN VERBOSE reports
standard-storage policy hints without inspecting stored documents.

See [migration commands and limits](../../../DEPLOY.md#jsonb-storage-switching-and-sql-migration-experimental-source-candidate)
and the [release notes](../../RELEASE-NOTES.md). The candidate passed
native PostgreSQL compilation and all 231 regression tests, plus ten focused
default/migration/EXPLAIN checks and both existing JSONB regression groups.
[GitHub run 42215882461](https://github.com/klustr-io/postgres/actions/runs/42215882461)
built and published all seven images with tag
`sha-16c31bf0ccbc46870e93b2949d94af037231fd1e`. Native OAuth/introspection,
idle-safe telemetry and all image security gates passed. Independent anonymous
registry checks matched every digest, source revision, non-root user and AMD64
platform to the publication receipt. Scans report zero critical/high matches;
remaining findings are recorded in the [scan reports](https://github.com/klustr-io/postgres/actions/runs/42215882461/artifacts/13502569166).
This remains an experimental candidate with `production_qualified: false`.
Deployment restore and public-app recovery are not established by publication.

## Latest recorded performance

The experimental durable WAL execution refactor measured 58,767 TPS versus
25,718 TPS for the earlier quorum path at 64 clients, a 2.29x improvement with
local fsync and remote quorum still required. This is 49.5% of the separate
118,622 TPS native PostgreSQL control; the 85% goal remains unmet.
Earlier indexed 64 KiB document tests averaged 9,680 updates/sec with the separate
DOCB type versus 1,705 for Neon JSONB, with about 50x less WAL per update.
These were separate, short RAM-backed experiments, not combined speedups,
persistent-media/S3 IOPS measurements or production capacity estimates.
Transparent JSONB integration has no new throughput measurement yet.
The [performance article](../../../blog.md) and
[recorded quorum results](../../tests/neon/performance/quorum-io-results.json)
describe the fixtures and limits.

## Earlier RC5 qualification context

`18.6-rc.5` includes KEDA/database/fleet lifecycle support, explicit suspend and
guarded deletion, native snapshots with retention, and cloning/PITR to new branches.
See [DEPLOY.md](../../../DEPLOY.md) for deployment instructions and scope.

The [GitHub workflow](https://github.com/klustr-io/postgres/actions/workflows/neon-pg18-candidate.yml)
builds all seven images from tag `neon-v18.6-rc.5`. Successful publication produces
[release assets](https://github.com/klustr-io/postgres/releases/tag/neon-v18.6-rc.5),
OCI archives, SHA-256 checksums and digest-pinned GHCR references. Consult the run
and release manifest for build/publication status; preparing the tag alone is not
proof of successful publication.

Basic local recovery integration passed snapshot creation, suspend/resume and
clone readback: the restored JSONB document held version 1 while its source held
version 2. The focused controller suite has 29 checks. These results do not certify
scheduled expiry, production HA/RPO, independent DR or near-native performance.

## Historical RC5 performance limits

Prior single-host, 15-second JSONB/GIN intervals used 10,000 documents and normal
EXTENDED storage. Durable native PG reached about 2,571 writes/sec, durable remote-
quorum Neon 506, bounded/local-fsync Neon 1,180, bounded ephemeral Neon 9,322,
and asynchronous native PG 25,734. With eight additional storage CPUs Neon reached
8,660. These measurements exclude the newly added frontend proxy/controller path.

Fast Neon therefore reached approximately 36% of comparably asynchronous native
PostgreSQL throughput; the 85% goal is not met. Different failure topologies,
flush policies and brief shared-host timing windows limit this comparison.
No new performance claim is made for RC5.

### Local commit-guard optimization (source candidate)

The November 2 source candidate wakes waiting commits directly when quorum or
verified-frontier state changes. The previous guard could wait for its 10 ms
polling timeout even after WAL reached quorum. The predicate, bounded-async
limits and cancellation/unknown-outcome rules remain enforced; no application
SQL changes are required. Synchronous benchmark runs now enable the guard to
match the deployed durable profile.

A short diagnostic used 1,000 JSONB documents, a GIN index, 16 clients and eight
total CPUs, with local storage on temporary in-memory filesystems. Durable Neon
increased from 1,524 updates/sec at 10.50 ms mean latency to 11,722–12,462/sec at
1.28–1.37 ms; the native PG control stayed at 30,261–31,438/sec. Bounded-async
throughput was unchanged (19,817 before, 19,783 after). These five-second screens
isolate CPU/IPC overhead and do not establish sustained disk/S3 throughput,
physical IOPS, production wake latency or the 85% target.

The candidate passed majority-loss blocking, cancellation without false success,
quorum restoration, compute-crash readback and compute stop/wake checks. Its
bounded-async check also excluded all old compute files before reconstruction.
Shared storage stayed online; no OS power-loss, Kubernetes scheduling or
multi-zone claim follows. This screen predates coordinated publication and is
retained as implementation history, separate from the later quorum measurements.

## Remaining production gates

- Controller HA, cross-worker fencing/migration and credential/certificate rotation.
- Production storage failure domains and controller metadata-database recovery.
- Sustained-load qualification of the accepted acknowledged-write loss envelope.
- Near-native performance and production qualification of JSONB delta/projection storage.

The current controller implements configurable idle/never policies, writer
reservations, admission closure, quorum drain and wake routing. It pins writers
to a worker and does not automatically migrate a potentially live writer after a
partition. The Kubernetes deployment provisions storage and continuously reconciles database
resources; provider S3/CSI configuration remains required. Page checksums remain unsupported by Neon page reconstruction.
