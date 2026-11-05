# Architecture work

## Control-plane repair

The audit of fd64cad found divergent API/YAML defaults, namespace-owner conflicts,
missing enclosing-fleet lifecycle checks, incomplete OIDC audit correlation,
independent image authorities, and mixed transport/application/infrastructure code.

Target ownership:

- Database policy resolves inherited defaults and explicit overrides once.
- Fleet policy selects the established namespace owner and protects retirement.
- Application commands own database, branch, backup and fleet transitions.
- HTTP adapters authenticate, validate and translate requests/results. Route
  registries bind named operations; composition constructs concrete collaborators.
- Kubernetes, SQL credentials and deployment provisioning implement narrow ports.
  Provisioning invocations own their configuration; they share no mutable globals.
- The packaged release supplies images for both runtime configuration and pods.

Repair order: policy/lifecycle regressions; identity and release contracts;
transport/application extraction and explicit ports; public contracts and CI gates.
Preserve HTTP paths, status codes, SCRAM access and single-writer semantics.
Omitted database policy fields inherit current fleet defaults. Existing persisted
values remain explicit overrides; this change performs no data migration.
Conflicting newcomers are rejected without stopping the established fleet.

Verification: run `node --test neon/tests/neon/unit/*.test.mjs`, controller lint
and contract checks, deterministic deployment rendering, and a controller image
build after the module and packaging changes are complete. Focused tests must
exercise commands and API/YAML consumer behavior, not only object construction.
Native engine performance and live zone-failure qualification are separate gates.

The repair now uses named domain, application, API, infrastructure and composition
modules under the controller's `src`. Provider file caching belongs to
`ConfigurationSnapshot`; database commands receive its read port. The owned
architecture gate also rejects application imports of concrete provider/file/HTTP
adapters, checks async initializers and enforces public contracts in CI.

Local verification passes the controller suite, lint and architecture gate. A
temporary namespace exercised fleet/database/branch/backup metadata commands via
HTTP against real Kubernetes persistence and resource-version conflicts; it did
not provision native database storage. The rebuilt nonroot controller image
matches the source tree and generated fleet bundle. Native OAuth/JWT/opaque-token
checks passed separately. These are local results; publication, native performance
targets, automatic failover and zone-loss qualification remain separate work.

## Native DOCB storage: implementation and qualification

Updated 2026-11-04. A native prototype now builds and runs in this tree. The
implementation is experimental and unpublished; local performance and correctness
evidence are separate from production storage-format qualification.

### Evidence and the boundary to fix

The warm, RAM-only JSONB screen used 1,000 roughly 3.1KB synthetic documents with
a mostly incompressible hex-string payload, a GIN
`jsonb_path_ops` index, 16 clients and eight total CPUs. Native PG generated
3.95–4.08KB of WAL per small score update; Neon generated 4.02–4.13KB. The
document rewrite amplifies both engines. Neon additionally replicates and ingests
that WAL. Container swap was zero, guest swap counters did not advance, and the
Neon write intervals had zero synchronous getpage waits and zero backpressure.
This isolates a warm write-path cost; it does not characterize cold projections.
The bounded 64KB-document case produced roughly 87–98KB WAL/update on both
engines. It used only 256 measured updates per sample to constrain memory/data
growth; its TPS and CPU measurements are not stable capacity estimates.

Diagnostic inline storage raised Neon throughput about 45%, LZ4 about 15%, and
removing GIN about 16% on this fixture. These are not 2x improvements, and none
was applied as a product default. In particular, diagnostic ALTER TABLE commands
and removing customer indexes are not the proposed application contract.

Current `jsonb_set` materializes a replacement value in
`src/backend/utils/adt/jsonfuncs.c`. `toast_save_datum` in
`src/backend/access/common/toast_internals.c` stores replacement chunks. Existing
heap WAL can omit an unchanged prefix/suffix when its conditions hold; the
`log_heap_update` implementation in `src/backend/access/heap/heapam.c` explicitly
disables that optimization when a complete tuple is needed for logical decoding.
The local screen uses `wal_level=logical` on both engines. Changing that setting
would change the supported replication contract and is not the selected fix.

### Upstream work and its limits

- [Detoast once per row, CF 7423](https://commitfest.postgresql.org/patch/7423/)
  is under review for the PG20 cycle. It targets repeated fetch/decompression
  when expressions reference the same value multiple times. It does not itself
  make a changed document's WAL proportional to its patch. Its proposed slot
  state and planner decisions are absent from this PG18 tree.
- [Direct TOAST, CF 7267](https://commitfest.postgresql.org/patch/7267/)
  is a PG20 proposal under review, with v15 listed and a rebase required at review
  time. It bypasses the TOAST B-tree using physical chunk references and trees.
  Its topology and slice traversal are useful research, not proof of unchanged
  JSONB subtree sharing. The current branch has no `VARTAG_DIRECT`. Direct
  physical references also require careful relocation, vacuum and upgrade rules.
- The earlier [pluggable toaster proposal](https://commitfest.postgresql.org/patch/3490/)
  was rejected in 2023; it must not be presented as an available PG18 extension API.
- [Neon's full-page-image pushdown](https://neon.com/blog/turning-off-fpw-for-faster-writes)
  addresses redundant page images with storage-side image generation. It is
  separate from changing JSONB/TOAST value replacement. Do not infer parity from
  an existing image-compaction threshold, or disable full-page writes here
  without the corresponding reconstruction and bounded-replay support.

The approach is established in other engines:
[MongoDB's damage-vector update path](https://github.com/mongodb/mongo/blob/master/src/mongo/db/storage/wiredtiger/wiredtiger_record_store.cpp)
passes changed byte ranges to WiredTiger, while
[WiredTiger's history implementation](https://raw.githubusercontent.com/wiredtiger/wiredtiger/develop/src/reconcile/rec_hs.c)
uses modify records with bounded chains and full-value fallbacks. These are
architectural references, not code to copy into PostgreSQL.

### Implemented native behavior

Use a new, opt-in PostgreSQL base type named `docb`. Existing `jsonb` columns,
on-disk values and operator behavior remain unchanged. A domain, alias or wrapper
over ordinary JSONB would retain the same storage/rewrite costs and is not the
implementation. `docb` requires an independently versioned native storage format.

The application-facing choice is the column type, for example
`CREATE TABLE documents (id bigint PRIMARY KEY, body docb)`. Preserve familiar
JSON syntax through type-specific operators, subscripting and calls such as
`jsonb_set(body, '{status}', '"ready"'::jsonb)`. A constructor such as `docb(jsonb)`
and casts support interchange. Existing JSON functions use a materializing native
cast; adding overloaded `jsonb_set` signatures would make untyped-literal queries
ambiguous, so the extension deliberately leaves those signatures unchanged.
The examples run on the rebuilt engine after `CREATE EXTENSION docb`.

Changing a stored column from `jsonb` to `docb` requires an explicit, reviewed data
conversion, never a binary-compatible cast or automatic startup rewrite. Converting
back materializes ordinary JSONB. Existing PostgreSQL clients can use canonical
JSON text, but drivers may need a mapping for the new type OID. Do not promise
JSONB binary-protocol compatibility, arbitrary extension compatibility or existing
GIN operator-class reuse. The extension supplies matching DOCB GIN, B-tree and
hash classes. No custom SQL patch procedure or application codec is required.

The core stores immutable delta roots referencing the full base owned by the
same row/column. Copy/literal spans retain unchanged byte ranges, including ranges
shifted by length changes. New roots store only their spans, replacement bytes and
a 512-byte current-value head. Each new root consolidates edits against the same
full base; superseded delta metadata is deleted without deleting that base.
Snapshot-visible versions keep their dependencies until vacuum's horizon permits
reclamation. Full rebases/deletes retire the current root and its owned base.
Cross-row,
array, held-cursor and export boundaries materialize independent full values.

Cheap single-region edits use prefix/suffix comparison. For wider edits, verified
64-byte anchors and a rolling hash locate unchanged runs at shifted offsets.
Unlike assigning fixed chunk numbers to a new serialization, this can reuse an
intervening large payload when both an early entry length and a late field change.
The bounded matcher handles values up to 16 MiB; other cases retain a full-value
fallback. This is byte-range reuse, not a structure-aware subtree store.

Roots have at most 64 spans and one full-base dependency, with each delta below
one quarter of the value. Repeated edits do not form delta chains. Full bases
use standard pglz/LZ4 only when the result fits one TOAST chunk and saves at least
75%; other bases remain uncompressed to preserve seekable reads. Column storage
EXTERNAL disables compression. Late reads from compressed bases can require
prefix decompression. A projection reads metadata
and selected ranges; a planner support function fuses ordinary `->`/`->>` chains
while retaining each step's object/array semantics. Results remain self-contained
instead of exposing unsafe lazy pointers across transaction lifetimes.

Ordinary heap/TOAST WAL persists the roots and bytes. Existing physical redo
reconstructs their pages; native reads interpret the versioned record with base,
range, coverage, size and depth checks. This path already produces substantial
write gains without an added replay service. A separate WAL interpreter remains
an option if measurement establishes a further bottleneck.

A transport codec that reconstructs byte-identical PostgreSQL WAL is a separate
optimization. It can reduce wire/disk bytes but leaves PostgreSQL's logical
`wal_bytes`, document rebuilding, compression attempts and TOAST churn intact.
Built-in `wal_compression` compresses full-page images, not every arbitrary row
payload. [PostgreSQL WAL compression](https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-WAL-COMPRESSION)

### Ownership and correctness conditions

| Boundary | Required responsibility |
|---|---|
| DOCB type, operators and executor | Preserve JSON semantics and lazy access through expression evaluation and tuple formation; materialize self-contained values for unsupported consumers, arrays, held cursors and export. Existing JSONB remains unchanged. |
| Heap/TOAST and format definitions | Version DOCB roots and chunks; retain immutable dependencies transactionally. Do not mutate content shared by visible old versions, or expose dependent roots as self-contained ordinary datums. |
| WAL and redo | Preserve atomic commit, crash restart, record validation and idempotent replay. Reject unavailable or wrong bases rather than silently applying a patch. |
| Safekeepers/pageservers | Preserve durable-prefix acknowledgement and page reconstruction. Encoding cannot weaken `durable` or silently change `best-effort` admission semantics. |
| Vacuum, compaction and PITR | Retain bases reachable from live tuples, snapshots, branch/history leases and logical slots. Materialize or compact before reclaiming a dependency. |
| Logical decoding | Keep logical WAL enabled. A database with any logical slot, including an inactive one, uses full-value writes. Slot creation fences pre-existing writers before its consistent point. Ordinary CDC receives independent rows; delta-write gains do not apply while that slot exists. |
| GIN and other indexes | Keep results and MVCC visibility unchanged. A storage win is insufficient if index extraction still forces full materialization; measure that fallback and optimize extraction separately. |
| Lifecycle and packaging | Bound dependencies needed after empty-compute wake. New-format capability must be coordinated across engine, redo, tools and controller. An older image cannot safely read an unknown format. |

Prefer stable, versioned chunk identities until relocation safety is established.
Bound delta-chain depth, cumulative delta bytes and read reconstruction work;
periodically materialize full values/roots. Avoid a chain that eventually requires
replaying a database's entire lifetime on wake. Limits are design decisions to
measure, not promises that arbitrary JSON queries become constant-time.

### Evidence and remaining qualification

1. The bounded 64 KiB screen uses 64 documents, eight clients and eight total
   CPUs, retaining fsync, synchronous commit, full-page writes and logical WAL.
   Neon results show roughly 5x faster small writes than JSONB and about
   50x less WAL with GIN. Projections improve after replacing repeated chain walks
   with current-value metadata caching. These are short RAM-only measurements.
2. The native group includes a separate unmodified upstream PostgreSQL control;
   the fork without storage services is labelled separately. Source/image hashes,
   settings, samples and buffer accesses are recorded in ignored JSON reports.
3. Focused real-engine checks cover wide metadata, length-changing edits, arrays,
   Unicode, no-op root reuse, snapshots/vacuum, rollback, cross-row/array copying,
   held cursors, binary COPY, rewrites, physical standby replay and crash restart.
   Logical-slot creation and full-row CDC are exercised with `pgoutput`.
4. The Neon group checks a new compute on a branch after parent value replacement
   and TOAST reclamation, plus divergent parent/branch updates. This uses local
   disposable storage, not S3 or multi-zone failure qualification.
5. Production promotion still needs broader workload/size and persistent-storage
   qualification, a frozen format/upgrade contract, and coordinated images.
   Independent compression and delta-efficient CDC remain further optimizations.
   Full-value fallbacks and quorum-RTT bounds must remain visible in results.

Feature enablement, existing-table conversion, downgrade/export behavior and
format compatibility require a concrete release plan. Do not add startup SQL
migrations or distribute a patch-applier as the product. Any accepted port is
normal source-controlled code in this repository, initially opt-in until its
correctness and performance gates are satisfied.

Implementation lives in `src/backend/utils/adt/docb.c` and `contrib/docb`, with
small native detoast/TOAST/executor integration changes. No new storage marker,
catalog-version bump, patch-applier or automatic conversion of existing tables is
used. The normal source build installs the extension and the compute image smoke
check verifies native delta storage. Existing published OCI tags lack this work.

## Durable quorum execution refactor

The implemented candidate replaces the WAL data path and its completion scheduling.
It retains the existing elected term, membership rules and complete-record durable
quorum. Application SQL, document types and connection behavior do not change.
The candidate remains experimental, disabled by default and unpublished.

### Current measurements

The controlled comparisons use one image, the same clients and storage data,
eight total CPUs, and original/candidate/candidate/original order. Each sample has
a one-second warmup and five timed seconds. Compute and storage-engine changes
happen outside the timed intervals. The harness verifies the running PostgreSQL
binary, storage arguments, native-path counters and absence of fast acknowledgements.
The baseline compiles the pre-refactor synchronous-replication implementation
from commit `2da748e` with an
unused ABI pointer so the same extension can load; it does not invoke the native
commit provider. Baseline source and executable hashes are retained in the JSON.

| Concurrent clients | Existing quorum mean TPS | Isolated native ingestion mean TPS | Improvement |
|---|---:|---:|---:|
| 32 | 21510 | 47402 | 2.204x |
| 64 | 25718 | 58767 | 2.285x |

A separate native PostgreSQL 18 control on the same image, affinity and eight-CPU
budget averaged 118622 TPS at 64 clients. It uses local durability without
Neon storage services. The candidate reaches 49.5% of that reference; the desired
85% native-PG throughput has not been reached. These short RAM-only tests isolate
software costs. They do not measure S3, disk IOPS, sustained production capacity
or zone latency. The selected CPUs are distinct guest-reported SMT cores, not
exclusive physical hardware. Affinity also improves native PG and is not counted
as a software optimization.

Complete sample values, hashes, counters and fault-check outcomes are in
[quorum-io-results.json](../../../tests/neon/performance/quorum-io-results.json),
under `latestNativeStream`. Earlier sections in that file retain historical
experiments rather than current capability claims. Failed or incomplete runs
are excluded from the comparisons.

### What changed

One elected sender owns the native data connections. Each peer has a bounded
pipeline of up to eight authenticated COPY frames. New WAL can be submitted
before prior replies arrive, while slow minorities cannot hold up a healthy
majority. Queue positions and write positions remain separate from durable proof.
The sender reads locally flushed WAL from PostgreSQL buffers where available,
with the WAL file as fallback.

A safekeeper drains up to eight already available frames without waiting to fill
a batch. Contiguous same-epoch frames combine into one append and fsync. Other
batches retain ordered validation and one final flush; rejected frames cannot
contribute a commit candidate. Feedback contains the final complete-record
flushed prefix, and a flush failure produces no success feedback.

The dedicated native listener moves each accepted socket once onto an isolated
ingest runtime. Its task-scoped I/O capability permits the owned positional write
and fsync to execute there without a filesystem-worker handoff for every batch.
Child tasks do not inherit that capability. Legacy elections, control traffic,
HTTP and recovery retain their separate runtimes and ordinary asynchronous I/O.
This is why the faster diagnostic direct-I/O engine is not the shipping design:
it performs blocking filesystem work on ordinary WAL networking workers.

Backends consume a versioned durable-prefix cache. Completion notifications target
64 buckets of 512-byte WAL ranges instead of waking every waiter for every
advancement. Reset and poison invalidate the cache before publishing a new epoch.
Timed waits provide cancellation and postmaster-liveness checks, never permission
to acknowledge an unreplicated transaction.

### Durability and handoff boundaries

Local fsync remains enabled. Durable commits require a complete-record flushed
prefix from the applicable majority, with independent old and new majorities for
joint membership. Node IDs must be distinct and belong to the elected membership;
missing configured nodes stay in the quorum denominator. Remote-apply waits and
the final cancellation/configuration guard remain in place.

Before taking data ownership, the native sender completes authenticated COPY
negotiation with the configured peers. If the API is disabled or negotiation
fails, the original elected writer continues before ownership transfers. Once
native ownership transfers, failure does not silently switch writers. This fixed
a real bootstrap stall found when the A/B fixture omitted the native API flag.

Retries verify overlapping bytes. Stale generations and terms, conflicting data,
gaps and oversized frames are rejected. Accepted mutations finish even if a client
disconnects. Idle asynchronous tails continue draining without another write.
These properties preserve scale-to-zero drain semantics; this screen does not
qualify the tenant controller's full sleep/wake lifecycle.

### Validation and limits

The isolated candidate passed authenticated new-WAL appends to all three storage
processes, multiple frames queued before feedback, unauthorized and wrong-tenant
rejection, duplicate/conflict verification, fencing, frame limits and rejection
of election commands on the native-only listener. Acknowledged rows survived
immediate compute and storage-process restarts. One paused node allowed commits;
two paused nodes blocked acknowledgement until quorum returned. Cancellation,
configuration fallback, idle-tail draining and valid control feedback after a
forced reconnect also passed.

Four focused Rust checks cover batch flush proof and injected flush failure,
same-term control reconnects, exact frame parsing and task-scoped I/O isolation.
Seventeen C checks cover membership reduction, cache invalidation and notification
boundaries. Every fixture uses temporary RAM storage, no S3 and no persistent
Docker volumes. This is not power-loss, persistent-media or multi-zone recovery
qualification. The native provider and native listener remain opt-in; deployment
wiring and removal of unsuccessful diagnostic paths precede release promotion.

The architectural attribution is substantial: coalescing with ordinary asynchronous
owned I/O measured 1.734x, while diagnostic direct I/O measured 2.473x. Isolating
that I/O retained 2.204x at 32 clients and 2.285x at 64 clients. Earlier io_uring,
thread-count, spin and single-cohort experiments did not establish a comparable
gain. Short DWARF samples located expensive worker/futex wakeups; those samples
cover selected processes, contain host instrumentation and are not throughput
measurements or whole-system CPU percentages.

### Research and applicability

The papers informed the ownership and pipelining changes. Their reported speedups
are not measurements of this PostgreSQL implementation.

| Design | Relevant mechanism | Application to this implementation |
|---|---|---|
| [AlloyDB storage](https://cloud.google.com/blog/products/databases/alloydb-for-postgresql-intelligent-scalable-storage) | Synchronous regional log persistence followed by asynchronous log processing and block materialization. | Preserve the separation already present in Neon; isolate the log append/ack path from page work. This is not evidence that synchronous log durability can be omitted. |
| [Aurora, SIGMOD 2017](https://www.amazon.science/publications/amazon-aurora-design-considerations-for-high-throughput-cloud-native-relational-databases) | Storage-side redo, reduced network amplification and efficient durable-state agreement. | Optimize bytes and hot-path messages before changing consensus. Its replication topology cannot be transplanted without rechecking quorum intersections and correlated failures. |
| [CockroachDB transactional pipelining](https://www.cockroachlabs.com/blog/transaction-pipelining/) | Overlap replication of statement intents and prove persistence at commit. | Overlap independent work while keeping the final durability proof. Neon already avoids a separate distributed consensus operation for each ordinary SQL statement, so the advertised gain does not directly transfer. |
| [SAP HANA ATR, VLDB 2017](https://www.vldb.org/pvldb/vol10/p1598-han.pdf) | Early log shipping and parallel replay with ordered visibility. | Move nonessential replay work away from commit. ATR's asynchronous analytical replica recovery is not a substitute for safekeeper quorum durability. |
| [Socrates, SIGMOD 2019](https://www.microsoft.com/en-us/research/uploads/prod/2019/05/socrates.pdf) | Parallel log submission, durable landing zone and downstream dissemination of hardened blocks. | Evaluate overlap of local WAL staging and remote append, while preserving the boundary between speculative and recoverable data. |
| [Taurus database](https://arxiv.org/html/2412.02792v1) | Separate append-only log/page stores and replicated PLogs; replace an unhealthy PLog through reconfiguration. | Useful for storage placement and straggler handling. Its all-replica PLog writes and metadata recovery scheme differ from Neon's majority log. |
| [PolarFS, VLDB 2018](https://www.vldb.org/pvldb/vol11/p1849-cao.pdf) | User-space I/O loops, RDMA/SPDK and ParallelRaft reduce scheduling and serialization overhead. | Test scheduling overhead on ordinary TCP first; RDMA/SPDK remain optional deployment-dependent directions. Ordered PostgreSQL WAL cannot acknowledge a hole merely because a later write completed. |
| [PALF, VLDB 2024](https://www.vldb.org/pvldb/vol17/p3745-xu.pdf) | Pipelined log replication and adaptive group replication. | Evaluate bounded batching and concurrent submission independently of record parsing and ack semantics. Batch deadlines must not strand low-rate writers. |
| [BtrLog, VLDB 2026](https://arxiv.org/html/2606.27051v2) | One-round-trip durable appends with per-core io_uring loops and symmetric networking. | Strong motivation to remove channel/worker handoffs. Its failure-free prototype and modeled recovery do not establish production recovery qualification for our implementation. |

[Autonomous Commit](https://www.cs.cit.tum.de/fileadmin/w00cfj/dis/papers/latency.pdf)
explores separating durability work from transaction execution in LeanStore.
Applying that design to PostgreSQL would require preserving its page and WAL
recovery dependencies; it is not a drop-in justification for acknowledging before
our required quorum. The current gain comes from changing execution ownership,
batching and completion scheduling while retaining that proof.
