# Tests

Tests are grouped by subsystem and purpose. Fast unit checks are separate from
scripts that build images, connect to services, allocate fixtures or benchmark.

| Folder | Purpose |
|---|---|
| `smoke/` | Basic standalone PostgreSQL SQL checks |
| `integration/` | Standalone PostgreSQL behavior checks against a running database |
| `neon/unit/` | Fast, mocked Python and JavaScript tests |
| `neon/postgres/` | PostgreSQL 18 AIO, redo and recovery checks; associated C probes |
| `neon/compute/` | Commit guards, WAL boundaries, restart and compute-failure scenarios |
| `neon/controller/` | Native-proxy and Kubernetes tenant lifecycle fixture helpers |
| `neon/storage/` | S3 connectivity, fault proxies, pageserver cache and manual test-storage administration |
| `neon/services/` | Broker, service lifecycle, distributed-runtime and Kubernetes harnesses |
| `neon/performance/` | Comparisons, codecs and diagnostic probes; explicitly invoked |
| `neon/security/` | Native dependency security regressions |
| `neon/support/` | Shared fixture, CPU-layout, tenant-startup and replay helpers |
| `neon/smoke/` | Minimal packaged PostgreSQL runtime check |
| `reports/` | Local manifests and execution receipts; generated data stays ignored |

Run the fast checks from the repository root:

```sh
make -f neon/Makefile unit
```

Or run Python alone with `python3 -B neon/tests/run_unit.py`. The runner provides the
shared helper import paths and discovers only `neon/unit/test_*.py`. Explicit
container-affinity tests remain opt-in. No database, S3 or Kubernetes access is
required for the default unit checks.

Build/container runners resolve source files through `neon/dev/shared/neon-test-paths.mjs`
when assembling flat, frozen harness inputs. Keep those harness filenames unique.
Use the existing explicit runners for smoke, integration and performance work;
the unit target never starts them automatically.

For a bounded durable-quorum architecture screen, run from the repository root:

```sh
node neon/tests/neon/performance/run-quorum-architecture.mjs IMAGE build/quorum-architecture/baseline baseline
```

`IMAGE` must be a local comparison image containing raw PG18 at `/opt/upstream`,
Neon PG18 at `/opt/postgres`, and `neon_local`. The runner records its immutable
image ID and verifies the commit-guard source against this checkout. Each run
uses an isolated container, eight CPUs total, six GiB RAM without container swap,
and a four-GiB tmpfs database fixture with a three-GiB stop threshold. It never
loads `.env`, contacts S3, mounts existing databases, or creates Docker volumes.
Each cell has one second of warmup and three measured seconds, repeated twice;
`bounded-async`, `best-effort` and `native-reference` use two measured seconds to
keep their higher write volume inside the RAM-data budget.
JSON reports include WAL volume, total CPU, persistent-service CPU, guard waits,
safekeeper flush metrics, context switches, and block-I/O counters. Host activity
and exited PostgreSQL backends limit attribution; these are diagnostic results,
not persistent-media durability or production capacity qualifications.

Run other groups separately in fresh fixtures by replacing the final argument
and output directory: `native-quorum` compares raw PG with three streaming
replicas and `ANY 2` synchronous flush acknowledgements; `controls` isolates
compute fsync and the additional Neon guard while retaining native synchronous
replication; `tokio-one` limits default Tokio worker pools; `safekeeper-nosync`
is an **unsafe diagnostic only**, disabling safekeeper fsync. The last group is
never a production performance recommendation. No production settings change.
`bounded-async` and `best-effort` compare each supported fast profile against
synchronous quorum in an ABBA sequence; the latter also briefly pauses only its
own safekeepers to verify asynchronous acknowledgement, explicit synchronous
waiting, and drain gating. `native-reference` repeats the two main workloads on
unmodified PostgreSQL with local synchronous commit.

The `jsonb-storage` group isolates warm JSONB rewrite cost. Pass one additional
case argument after the group: `default`, `inline`, `lz4`, `external`, `no-gin`,
or `large`. Use a separate output directory per case. Default cases have 1,000
roughly 3.1KB documents and 8,192 measured updates per sample; `large` uses
roughly 64KB documents and only 256 measured updates to cap WAL/data volume.
Both engines are measured twice; Neon uses the explicit best-effort profile and
native PG retains local synchronous commit. These are storage attribution
controls, not equal-acknowledgement durability comparisons. Reports include swap,
memory pressure, page-read waits, backpressure, TOAST sizes and WAL per update.
The inline/storage/compression/index changes affect only the disposable fixture;
none is an application schema requirement or an enabled product optimization.

### Native DOCB storage

Build the normal source image with `contrib/docb` and the matching core storage
changes; the diagnostic image additionally needs unmodified PG18 in `/opt/upstream`
and `neon_local`. Run the bounded groups sequentially:

```sh
node neon/tests/neon/performance/run-quorum-architecture.mjs IMAGE build/docb/native docb-native
node neon/tests/neon/performance/run-quorum-architecture.mjs IMAGE build/docb/quorum docb-quorum
node neon/tests/neon/performance/run-quorum-architecture.mjs IMAGE build/docb/best-effort docb-best-effort
```

The optional `docb-best-effort` group explicitly changes acknowledgement semantics:
compute fsync and synchronous commit are off, safekeeper flushing stays on, and
explicit synchronous barriers protect the fixture's branch/CDC checks. It also
checks three fresh computes. Keep its results separate from durable quorum.

Each uses an automatically removed container, eight total CPUs, six GiB RAM, no
container swap and four GiB of temporary RAM storage. No `.env`, S3 endpoint,
existing database, Docker volume or persistent-media benchmark is involved.
Fixture listeners avoid Linux ephemeral client ports. The Neon groups reserve an
occupied HTTP port to verify startup fails before PostgreSQL starts, then retry
normally. Pageserver disk-pressure eviction is disabled only in this tiny RAM
fixture so the production free-space reserve does not evict the warm working set.
`results.json` records JSONB/DOCB write TPS, WAL per update, projection timing and
buffer accesses, source hashes, settings and container block-I/O counters. The
native group also measures an **unmodified upstream PostgreSQL** JSONB control;
the fork running without Neon storage is labelled separately. Raw block-I/O
counters include executable reads and must not be advertised as database IOPS.

The 64-document fixture uses 64 KiB payloads, eight clients and 1,024 updates per
sample, twice in reverse engine order, with and without GIN. The durable groups keep
fsync, full-page writes, synchronous commit and logical WAL enabled; the Neon
quorum group keeps remote acknowledgement and safekeeper flushing. No logical CDC slot
exists during timing. Separate small correctness checks verify JSON semantics,
operator-chain fusion, copying, MVCC/vacuum, rollback, binary COPY and rewrites.
The native group also checks physical standby replay and immediate crash restart;
both groups verify logical-slot fencing and full-row CDC. The Neon group wakes a
fresh compute on a branch and checks isolation after parent TOAST reclamation.

These are short architecture screens, not capacity or release qualification.
The normal compute-image smoke check also installs the extension and verifies
a small native delta update/projection, so OCI packaging cannot silently omit it.
