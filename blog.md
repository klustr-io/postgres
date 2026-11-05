# Faster documents and more than twice the durable write throughput in Neon

We want the economics of a database that sleeps when nobody is using it, together with the performance people expect from PostgreSQL. That means keeping Neon's separation of compute and storage, its branching model and its ability to attach a fresh compute to existing data. It also means taking the performance gap seriously.

Our latest work in [Klustr's open source PostgreSQL and Neon repository](https://github.com/klustr-io/postgres) addresses the cost of repeatedly storing large documents after small edits, the overhead of moving writes through distributed storage, and the ability to choose durability that fits an application.

The latest milestone is **2.29 times the throughput of our existing Neon durable quorum path**, reaching approximately **58,800 transactions per second** in a focused local WAL workload. Local fsync and remote quorum acknowledgement remained enabled. Applications used the same SQL and connection protocol throughout the comparison.

That follows our document storage work, which delivered **5.7 times the write throughput of Neon JSONB with durable quorum commits**, while generating **about 50 times less write ahead log data** in a separate large document fixture. Configurable durability gives applications another choice when losing recent writes is acceptable. Each improvement addresses a different part of the write path, and the measurements below keep them separate.

These results come from experimental source changes. The new document format and WAL execution path have passed the focused checks described here and are being packaged into commit tagged development images. Production storage qualification remains ahead. We are sharing the implementation and measurements so people can examine the work and reproduce it.

## The cost of changing one field

A document can contain a large body of content alongside a handful of frequently changing fields. An application might update a status, increment a counter or change a timestamp while leaving almost everything else untouched.

PostgreSQL's JSONB representation is useful for querying and indexing that document, but changing a field constructs a new JSONB value. For large values stored through TOAST, small logical edits can cause substantial storage and WAL work. In our fixture, a small edit to a document with a 64 KiB payload generated roughly 82 KB of WAL with GIN indexing enabled.

Neon then has to transport and preserve that WAL through its storage architecture. Durable commits wait for a safekeeper quorum. Object storage receives history further downstream; an S3 upload is not the synchronous boundary for each commit. [Neon's architecture documentation](https://neon.com/docs/introduction/architecture-overview) explains that distinction.

Reducing the amount of data produced by an update therefore matters before network tuning or faster object storage enters the picture.

## Keeping the unchanged content

We implemented an opt in PostgreSQL type called `docb`, backed by native storage changes. A document keeps an immutable full base, and a small update stores a compact description of which bytes to reuse and which bytes changed.

Each eligible update is consolidated against that base. Reading the current document does not require walking an ever growing chain of historical patches. Larger changes fall back to a full value, and comparisons verify reused bytes rather than trusting hash matches alone.

The implementation uses ordinary PostgreSQL heap and TOAST WAL. Existing physical replay and Neon's storage path carry those records, so the design does not introduce a separate patch replay service.

Applications continue to use familiar SQL expressions such as `jsonb_set`, document operators and subscript assignment. Adopting DOCB does require installing the extension and explicitly choosing the new column type. Existing JSONB columns keep their existing behavior, and some drivers will need a type mapping. There is no automatic conversion of existing application data.

## Reading a field without fetching the whole document

The same principle applies to reads. Asking for one nested value should avoid reconstructing unrelated content wherever the execution path supports it.

DOCB supports selective range reads and combines supported chains of document operators into one path evaluation. This lets a small projection retrieve the relevant bytes from the stored representation. Full document reads and generic functions can still require materialization, and index maintenance remains real work.

In the durable Neon test with GIN, 2,048 small projections took **16.4 ms with JSONB and 6.0 ms with DOCB**. Reported buffer hits fell from about **25,500 to 6,200**. That is approximately 2.8 times faster execution for this projection, alongside the reduction in write volume.

## What we measured

The fixture used PostgreSQL 18.6, 64 documents with 64 KiB payloads, eight client connections and 1,024 updates per sample. Each configuration ran twice, with the JSONB and DOCB order reversed. The following figures are the arithmetic means of the GIN indexed samples.

| Configuration | Updates per second |
| --- | ---: |
| Unmodified PostgreSQL, JSONB | 3,928 |
| Neon, JSONB, durable quorum | 1,705 |
| Neon, DOCB, durable quorum | 9,680 |
| Neon, JSONB, best effort | 1,760 |
| Neon, DOCB, best effort | 14,872 |
| Our PostgreSQL fork without Neon storage, DOCB, durable local commits | 28,223 |

Each whole system had an eight CPU limit, including Neon's storage services. Data lived in temporary RAM storage, with a six GiB container memory limit and no container swap. There was no S3 endpoint, persistent database volume or simulated cross zone network in this experiment.

The table shows a substantial gain for this document workload. It also shows that durable Neon DOCB remains well behind local DOCB. The roughly 34 percent ratio between those two configurations leaves meaningful work on the distributed commit path. Beating native JSONB with a different document format does not establish parity between the two architectures.

WAL per indexed update fell from approximately **82 KB to 1.6 KB** in the durable Neon comparison. That is a measured reduction in WAL generation, rather than a measurement of S3 traffic, disk IOPS or cloud cost. The small working set and short samples also make these results unsuitable as a production capacity estimate.

## Doubling durable write throughput

After reducing the work generated by a document update, we turned to the cost of getting that work safely through Neon. The gap to local PostgreSQL was still large enough to demand a change in how the system executes writes.

Our investigation found substantial scheduling overhead around the WAL path. Work moved between networking tasks and filesystem workers, while completion notifications could wake transactions whose writes were still waiting. Each handoff carries a cost, and a busy database repeats it many thousands of times a second.

We rebuilt that path around a single elected sender that owns the storage connections and keeps a bounded pipeline of WAL in flight. It can send the next batch while earlier acknowledgements return. A slow storage peer can catch up while a healthy majority continues making progress.

On each storage node, contiguous WAL frames can become one write and one flush. Dedicated ingestion workers own that work, leaving elections, recovery and management on separate runtimes. Backends receive more selective completion notifications as the verified durable position advances. Together, these changes reduce the movement and coordination needed to complete a write.

The result was consistent across the two concurrency levels we tested:

| Concurrent clients | Existing Neon quorum, transactions per second | Refactored Neon quorum, transactions per second | Improvement |
| --- | ---: | ---: | ---: |
| 32 | 21,510 | 47,402 | 2.20 times |
| 64 | 25,718 | 58,767 | 2.29 times |

Both configurations required local fsync and a durable safekeeper quorum. The application submitted the same workload, with no schema changes, new document type or custom function calls required for this improvement. This makes the WAL refactor relevant beyond document databases, although other application workloads still need their own measurements.

Each comparison used the same image and an eight CPU budget shared by clients, compute and storage services. We ran the original, refactored, refactored and original configurations in that order, with five seconds per timed sample after warmup. Both used the same CPU affinity. Data lived in temporary RAM storage, with no S3 access or simulated network between zones. The gain therefore measures execution overhead in this fixture, rather than faster disks or object storage.

We also checked the behavior that gives those acknowledgements meaning. Writes continued with one storage process paused and waited when two were unavailable. Acknowledged rows survived immediate compute and storage process restarts. Authentication, conflicting retries and stale writer rejection passed their focused checks. Persistent media failures and recovery across zones remain part of the qualification ahead.

Native PostgreSQL averaged approximately **118,600 transactions per second** in a separate control with the same total CPU budget. At 64 clients, the refactored Neon path reached **49.5 percent of that reference**. Our goal is to get much closer to native PostgreSQL, with 85 percent as the target we are working toward. The new result is meaningful progress, and it also makes the remaining distance visible.

The document results earlier in this post and the WAL results here come from separate experiments. We have not measured their combined effect, so multiplying their gains would overstate what we know. The [recorded quorum results](neon/tests/neon/performance/quorum-io-results.json) contain the individual samples and checks, and the [architecture notes](neon/docs/neon-production/architecture/RefactorPlan.md#durable-quorum-execution-refactor) explain the implementation.

## Choosing what a successful write means

Some databases hold payments or customer records. Others hold disposable session state, rebuildable projections or telemetry that can tolerate losing recent events. We added database level commit profiles so those decisions can be expressed through configuration.

| Profile | Acknowledgement behavior |
| --- | --- |
| `durable` | Waits for durable safekeeper quorum. This remains the default. |
| `bounded-async` | Can acknowledge ahead of quorum while verified freshness, live quorum and pending WAL checks permit it. Fast acknowledgements stop when those checks fail. |
| `best-effort` | Can acknowledge before remote durability is established, without a fixed maximum loss window. |

The best effort DOCB result was about 54 percent faster than durable DOCB in this run. The JSONB result changed little, which is useful evidence too: relaxing acknowledgement alone did not remove the cost of rewriting large values in this fixture. The document storage change produced the larger gain.

These profiles change write acknowledgement and recovery exposure. They do not relax SQL isolation or introduce a separate stale read mode. A successful best effort write can disappear after compute failure when its WAL has not reached recoverable remote storage. An extended replication outage can expose a much larger tail, and S3 cannot recover data that never arrived. Bounded asynchronous admission is also not an exact one second loss guarantee.

Safekeeper disk flushing stays enabled in all three profiles. Explicit synchronous transactions still wait for quorum in the managed fast profiles, and planned suspension drains pending writes before stopping compute. Enterprise fleets require an administrator to permit asynchronous profiles before a database can select one. The [deployment guide](DEPLOY.md#commit-profiles) describes configuration, while [our failure analysis](BEST_EFFORT_VS_DURABLE.md) covers recovery scenarios in more detail.

## Keeping the Neon model

The storage work preserves the separation that makes compute suspension and branching useful. We checked a fresh compute attaching to a branch and reading the correct document after changes and reclamation on the parent. Warm storage starts in these local checks were around 210 ms. Cold object storage startup, full stack suspension and production connection latency need their own measurements.

The normal engine build passed all 231 PostgreSQL regression tests. Focused DOCB checks covered transactions, snapshots, vacuum, copying, table rewrites, crash recovery, physical replication, logical replication and branch isolation.

We also checked content that compresses extremely well, since large documents are not always expensive to store. On a separate local engine screen with repetitive 64 KiB payloads, JSONB generated roughly 0.7 KB of WAL per update while DOCB generated about 1.4 KB. DOCB averaged around 17,000 updates per second against JSONB's 9,700 in that screen. The 50 times WAL reduction from the main experiment does not apply to this data.

That check led to another storage improvement. DOCB now compresses full bases when they fit in one TOAST chunk and save at least 75 percent of the original size. Other bases retain direct range access. The follow up reduced allocated DOCB relation space from about 3.0 MB to 0.84 MB in the repetitive document fixture, although JSONB still occupied about 0.37 MB. These relation sizes include allocated pages after vacuum, rather than establishing a steady state storage ratio. A late projection from a compressed base can also require prefix decompression. The [compression results](neon/tests/neon/performance/docb-compression-results.json) record that tradeoff separately from the main Neon benchmark.

Any logical replication slot in a database selects full value writes for CDC correctness, which removes the delta write benefit there. Existing files containing DOCB deltas also require a compatible engine; exporting to JSONB provides a path back to an engine without DOCB support.

## Hardening the connections behind those writes

Reworking a database write path also means reviewing how it handles malformed input, authentication and connections that stop making progress. Our security review reproduced defects in the current fork and added regression checks alongside the repairs.

Storage authentication now limits a password frame to 64 KiB before reserving space for its body, checks its terminating byte and keeps unexpected message payloads out of authentication errors. Truncated Describe and Close messages now return parsing errors rather than panicking. These repairs are in the [storage authentication backend](neon/runtime/libs/postgres_backend/src/lib.rs) and [frontend protocol parser](neon/runtime/libs/pq_proto/src/lib.rs).

We also addressed a PostgreSQL client issue where a server could advertise one column count and return a different number of fields. Later access to that row could panic. The [upstream repair](https://github.com/rust-postgres/rust-postgres/commit/7a00ffa9ad4d951ec0a4564b52f1780fa9d353c1) validates those counts when constructing the row. Our normal client now carries that protection on upstream 0.7.18, with Neon's replication and COPY BOTH support retained. We applied the same validation to our renamed client, which needed separate review because its package name differs from the upstream dependency.

A storage peer that stopped reading could also leave native WAL feedback or connection cleanup waiting indefinitely. The [WAL connection repair](neon/runtime/safekeeper/src/wal_service.rs) adds a write deadline when the native API is enabled. The deadline applies to socket progress; accepted disk mutations finish through their existing durability path.

Runtime configuration checks also caught a TLS startup regression during the SDK upgrade. Both Rustls crypto backends could be linked into a service, making automatic provider selection ambiguous. Storage listeners now use an [explicit provider matching their certificate loader](neon/runtime/libs/http-utils/src/tls_certs.rs). A focused test reproduced the configuration panic before the repair and passed afterward with both backends enabled.

The dependency work updated the AWS SDK, TLS, JWT, RSA and database adapter packages. Smithy JSON now resolves to 0.65.1, beyond the patched version identified in [AWS's CVE-2026-18140 bulletin](https://aws.amazon.com/security/security-bulletins/2026-067-aws/). That bulletin describes an attack against generated servers; our inventory match came from the SDK client dependencies. The update also preserves the HTTP/1.1 upload option and compatible request checksum behavior for custom S3 endpoints. The [resolved lockfile](neon/runtime/Cargo.lock) records the versions used.

Across the same three source lockfiles, the November 5 scan changed as follows. These are package and advisory matches, so one advisory can appear against more than one installed version. The [security review](neon/docs/neon-production/architecture/SecurityReview.md) records the comparison and its scope.

| Scanner severity | Before | After |
| --- | ---: | ---: |
| Critical | 0 | 0 |
| High | 6 | 0 |
| Medium | 20 | 2 |
| Low | 25 | 4 |

The two medium findings remain visible. [CVE-2026-48504](https://github.com/open-telemetry/opentelemetry-rust/security/advisories/GHSA-w9wp-h8wv-79jx) concerns memory allocation while processing OpenTelemetry baggage. Our runtime installs the W3C TraceContext propagator, and the review found no baggage propagation or mutation calls. [CVE-2026-43868](https://nvd.nist.gov/vuln/detail/CVE-2026-43868) concerns excessive allocation in Apache Thrift. Our proxy writes Parquet telemetry; the reader calls found during review are inside its test module. Those dependencies remain in the inventory, along with four low findings, and their exposure assessment needs revisiting as the code evolves.

Verification included **34 focused Rust tests**, sanitizer and leak detection checks on the native quorum and libpq ownership fixtures, and **200 reconnect/reset cycles** with balanced descriptor reservations. A separate live screen made **280 connections**, including **128 malformed streams that were rejected**. All three storage processes survived, descriptor counts returned to their baselines and the largest RSS increase was **448 KiB per process**. These short checks passed on isolated temporary storage; long duration memory behavior and failures of persistent storage still need qualification. The [review](neon/docs/neon-production/architecture/SecurityReview.md#verification) documents those limits and the individual checks.

We have added [publication checks](neon/dev/checks/security/scan-release.mjs) that scan the built OCI archives before a push. Critical and high findings block publication, together with selected authentication, TLS, row parsing and SQL construction advisories at medium severity. Scanner failures, missing package inventories and an outdated vulnerability database also stop publication. Both the coordinated release and controller publication workflows use this gate in the updated source.

The [GitHub OCI build](https://github.com/klustr-io/postgres/actions/runs/41985026493) for [commit 7bb4ca0](https://github.com/klustr-io/postgres/commit/7bb4ca09813d4a4a83e0f4d59323fdd1581e2b5e) completed successfully on November 5. All seven AMD64 images passed the configured publication security gates and are publicly pullable with tag `sha-7bb4ca09813d4a4a83e0f4d59323fdd1581e2b5e`. We independently checked each published digest, source revision and platform against the release receipt. Native OAuth login, opaque token introspection and the check that statement telemetry leaves the idle timer intact also passed.

Fresh image scans reported zero critical or high findings across all seven components. Their broader inventories include operating system packages and retain the following matches. These counts are separate from the source lockfile comparison above; operating system findings need their own exposure review. The [publication artifact](https://github.com/klustr-io/postgres/actions/runs/41985026493/artifacts/13397726298) contains the digest manifest and complete scan reports.

| Image group | Critical | High | Medium | Low | Unknown severity |
| --- | ---: | ---: | ---: | ---: | ---: |
| Compute and pageserver, each | 0 | 0 | 50 | 34 | 4 |
| Safekeeper and proxy, each | 0 | 0 | 23 | 21 | 4 |
| Storage controller and storage broker, each | 0 | 0 | 23 | 20 | 4 |
| Tenant controller | 0 | 0 | 26 | 12 | 4 |

For example, the compute image is available as:

```sh
docker pull ghcr.io/klustr-io/neon-compute:sha-7bb4ca09813d4a4a83e0f4d59323fdd1581e2b5e
```

The pageserver, safekeeper, storage controller, storage broker, proxy and tenant controller use the same tag under their `ghcr.io/klustr-io/neon-` image names. These are development candidate images. The build and security gates passed; qualification for persistent media failures, recovery across zones and long duration memory behavior remains ahead.

## Changelog, severity and remaining risk

This changelog covers the work described in this article through November 5, 2026. The published security candidate is [source revision 7bb4ca0](https://github.com/klustr-io/postgres/commit/7bb4ca09813d4a4a83e0f4d59323fdd1581e2b5e). The [release notes](neon/RELEASE-NOTES.md) retain the earlier deployment, fleet and packaging changes. Severity below is our qualitative assessment of the potential impact before a repair, with exposure conditions stated alongside it. It is not a CVSS score or an assertion that an attack occurred. Dependency findings retain the scanner's severity separately.

### Security and stability repairs

| Change | Severity and risk addressed | Evidence and remaining risk |
| --- | --- | --- |
| Bound storage password frames before allocation and require the terminating NUL. | **High availability risk** where an attacker can reach storage authentication: oversized unauthenticated frames could consume memory. Malformed authentication frames also reached token validation. | Authentication regressions exercise valid and invalid frames through the 64 KiB limit. The bound applies to authentication; SQL and COPY have separate policies. [Implementation](neon/runtime/libs/postgres_backend/src/lib.rs). |
| Remove unexpected authentication message payloads from errors. | **Medium confidentiality risk:** errors could expose supplied credential material to logs or error consumers. | Payloads are omitted from these errors. This repair does not erase historical logs or establish that credentials were previously exposed. [Review](neon/docs/neon-production/architecture/SecurityReview.md#reproduced-defects-and-repairs). |
| Reject truncated Describe and Close messages. | **Medium availability risk:** malformed frontend input could panic the parser. | Minimum lengths are checked before fields are consumed; the frontend screen includes 4,096 short frames. [Parser](neon/runtime/libs/pq_proto/src/lib.rs). |
| Validate DataRow field counts in both PostgreSQL clients. | **Medium availability risk** from a malformed or compromised upstream server: inconsistent row metadata could cause a later accessor panic. | Prepared and simple-query regressions cover both client variants. The normal client retains Neon's replication APIs on upstream 0.7.18. [Upstream repair](https://github.com/rust-postgres/rust-postgres/commit/7a00ffa9ad4d951ec0a4564b52f1780fa9d353c1). |
| Add a native WAL socket write deadline. | **Medium availability risk:** a peer that stopped reading could retain feedback or connection cleanup indefinitely. | Focused deadline and reconnect checks passed. The deadline applies when the native API is enabled and does not cancel accepted disk mutations. It is not a general timeout for every storage operation. [Implementation](neon/runtime/safekeeper/src/wal_service.rs). |
| Select the storage TLS crypto provider explicitly. | **High deployment availability risk:** linking both Rustls crypto backends could panic during TLS startup. No authentication bypass was demonstrated. | A regression reproduced the panic before the fix and passed afterward. Pageserver, safekeeper, storage controller and broker share the explicit builder. [Implementation](neon/runtime/libs/http-utils/src/tls_certs.rs). |
| Update SDK, TLS, JWT, RSA, archive and database dependencies; remove the packaged psql Readline dependency. | **High scanner findings addressed:** the same source inventory went from six high matches to zero. A package match alone does not establish runtime exploitability. | Fresh images also report zero critical/high matches. Packaged psql loses interactive line editing and history. The [review](neon/docs/neon-production/architecture/SecurityReview.md#dependencies-and-release-gate) records versions, exposure and compatibility checks. |

### Performance and durability changes

These are operational risks rather than vulnerability severity ratings. The performance experiments remain separate, and their gains must not be multiplied.

| Change | Measured result | Risk and adoption limits |
| --- | --- | --- |
| Immutable DOCB bases, compact updates and selective projections. | Durable indexed updates averaged 9,680/sec versus 1,705/sec for Neon JSONB; WAL fell from about 82 KB to 1.6 KB per update. Small projections took 6.0 ms versus 16.4 ms. | **High compatibility and recovery impact if adopted without qualification.** DOCB is an opt-in type, requires compatible engines and sometimes driver mappings, and does not transparently accelerate existing JSONB. Logical replication slots select full-value writes. [Results](neon/tests/neon/performance/docb-results.json). |
| Compress eligible full DOCB bases. | Allocated relation space fell from about 3.0 MB to 0.84 MB in the repetitive-data fixture; JSONB remained smaller at about 0.37 MB. | **Workload-dependent performance risk.** Late projections can require prefix decompression, and repetitive JSONB generated less WAL than DOCB. [Compression results](neon/tests/neon/performance/docb-compression-results.json). |
| Pipeline WAL through an elected sender, dedicated ingestion workers, batching and selective completion notifications. | Durable throughput rose 2.29 times at 64 clients, to 58,767 TPS; this was 49.5% of the separate native PostgreSQL control. | **High correctness impact for an experimental write-path change.** Fsync and quorum remain required; process-restart and quorum checks passed. Persistent-media and cross-zone recovery remain unqualified. The path is opt-in and disabled by default. [Results](neon/tests/neon/performance/quorum-io-results.json). |
| Offer durable, bounded asynchronous and best-effort commit profiles. | Best-effort DOCB was about 54% faster than durable DOCB in the document fixture; JSONB improved little there. | **High data-loss risk when asynchronous profiles are selected.** Best effort has no fixed loss bound. Bounded admission does not certify an exact one-second RPO. Planned suspension drains pending writes, but unexpected failures can lose acknowledged data. [Failure scenarios](BEST_EFFORT_VS_DURABLE.md). |

All performance figures above came from small RAM-backed local fixtures. They do not establish persistent-disk IOPS, S3 bandwidth, production capacity or multi-zone latency. The 85% native PostgreSQL throughput goal remains unmet.

### Build, identity and release checks

| Change | Risk addressed | Verification and limits |
| --- | --- | --- |
| Scan the exact image archives before publication using a pinned scanner. | **High release integrity risk:** publishing known vulnerable dependencies or treating failed scans as success. | Critical/high matches, selected medium advisories, missing inventories, scanner errors and databases older than 48 hours block publication. Remaining lower-severity findings still require review. [Gate source](neon/dev/checks/security/scan-release.mjs). |
| Correct scanner report ownership and scan a Docker-compatible export of the attested controller image. | **Medium build reliability risk:** permission and archive-format errors prevented successful scans. | The controller workflow passed; publication verifies the pushed digest. The scan remains mandatory. [Review](neon/docs/neon-production/architecture/SecurityReview.md#dependencies-and-release-gate). |
| Cancel superseded branch builds while preserving tagged release runs. | **Low operational risk:** obsolete branch builds consumed build capacity. | Branch builds can be replaced by newer commits; tagged releases retain their protection. [Workflow](.github/workflows/neon-pg18-candidate.yml). |
| Publish and anonymously verify the coordinated seven-image candidate. | **High deployment consistency risk:** mixing source revisions or using images whose provenance was not checked. | All seven digests, AMD64 platforms and source labels matched the publication receipt. Native OAuth, opaque introspection, secret rotation and idle-safe statement telemetry checks passed. This is focused validation, not an identity-system audit. [Build and qualification](https://github.com/klustr-io/postgres/actions/runs/41985026493). |

### Findings that remain open

| Finding | Severity or risk | Current disposition |
| --- | --- | --- |
| OpenTelemetry SDK baggage allocation, CVE-2026-48504. | **Medium scanner severity.** | The review found TraceContext propagation and no runtime baggage propagation or mutation calls. The dependency remains present; enabling that path requires reassessment. [Advisory](https://github.com/open-telemetry/opentelemetry-rust/security/advisories/GHSA-w9wp-h8wv-79jx). |
| Apache Thrift allocation, CVE-2026-43868. | **Medium scanner severity.** | The reviewed proxy writes Parquet telemetry; reader calls found were inside tests. The dependency remains present, and a future untrusted reader would change its exposure. [Finding reference](https://nvd.nist.gov/vuln/detail/CVE-2026-43868). |
| Other source and image inventory matches. | **Four low source matches; image medium, low and unknown counts are listed above.** Unknown severity does not mean low risk. | OS findings have not all received an exposure assessment. Source counts and image counts have different scopes and must not be combined into a claim that only two findings remain. [Complete publication reports](https://github.com/klustr-io/postgres/actions/runs/41985026493/artifacts/13397726298). |
| Long-duration memory behavior. | **Unquantified availability risk.** | Sanitizers, 200 reconnect cycles and the short live screen passed. Those checks did not demonstrate a leak, but cannot rule out slow growth under sustained production traffic. [Verification scope](neon/docs/neon-production/architecture/SecurityReview.md#verification). |
| Persistent-media failure, cross-zone recovery and production HA. | **High potential durability and availability impact; likelihood not measured.** | Process restarts are not power-loss or zone-loss tests. The release manifest retains `production_qualified: false`; successful publication does not close this work. [Qualification record](neon/docs/neon-production/architecture/SecurityReview.md). |

## Run it yourself, or explore it with Klustr

We are building this for teams that want PostgreSQL's ecosystem, document workloads and the ability to stop paying for idle compute. The repository brings the PostgreSQL engine, Neon services, proxy and tenant controller together, with Docker Compose and Kubernetes deployment support. Databases can have their own sizing and suspension policies, including staying active when that is the right choice.

Start with the [source and published releases](https://github.com/klustr-io/postgres), then use [DEPLOY.md](DEPLOY.md) to configure a deployment. For these experimental performance changes, use a matching source build or a completed development image publication that contains them. DOCB, the WAL refactor and the new commit profiles still need further release qualification.

For a hosted route, visit [Klustr](https://klustr.io) to explore running Neon through our platform and discuss trying this work with your own workload. Bring the document sizes, update patterns and durability requirements that matter to your application. Those are the measurements we want to improve next.

The [benchmark runner and reproduction instructions](neon/tests/README.md#native-docb-storage) accompany the implementation, together with the [document results](neon/tests/neon/performance/docb-results.json) and [quorum results](neon/tests/neon/performance/quorum-io-results.json). This post was updated on November 5, 2026. Full local diagnostic logs remain outside the public source checkout.

We are committed to extending Neon further through open source work on document storage, durable writes, security, branching and the economics of a database that can sleep. We will keep publishing the code and the measurements as we close the gap to native PostgreSQL, and bring that work to teams running their own infrastructure and those building on [Klustr](https://klustr.io). The goal remains a PostgreSQL foundation that gives developers the performance they need and lets them stop paying for idle capacity.
