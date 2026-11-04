# Making Neon faster for documents, with durability you can choose

We want the economics of a database that sleeps when nobody is using it, together with the performance people expect from PostgreSQL. That means keeping Neon's separation of compute and storage, its branching model and its ability to attach a fresh compute to existing data. It also means taking the performance gap seriously.

Our latest work in [Klustr's open source PostgreSQL and Neon repository](https://github.com/klustr-io/postgres) addresses two expensive parts of that gap: repeatedly storing large documents after small edits, and waiting for remote durability on every transaction regardless of what an application needs.

In a focused local test, our new document storage delivered **5.7 times the write throughput of Neon JSONB with durable quorum commits**, while generating **about 50 times less write ahead log data**. A separate durability option raised throughput further by allowing acknowledgements before remote storage had secured those writes.

These results come from experimental source changes. The new document format has passed the checks described here, but it has not been published in our OCI release images or qualified for production storage. We are sharing the implementation and measurements so people can examine the work and reproduce it.

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

## Run it yourself, or explore it with Klustr

We are building this for teams that want PostgreSQL's ecosystem, document workloads and the ability to stop paying for idle compute. The repository brings the PostgreSQL engine, Neon services, proxy and tenant controller together, with Docker Compose and Kubernetes deployment support. Databases can have their own sizing and suspension policies, including staying active when that is the right choice.

Start with the [source and published releases](https://github.com/klustr-io/postgres), then use [DEPLOY.md](DEPLOY.md) to configure a deployment. The published releases and these experimental performance changes have different availability: DOCB and the new commit profile changes still require matching source builds and further release qualification.

For a hosted route, visit [Klustr](https://klustr.io) to explore running Neon through our platform and discuss trying this work with your own workload. Bring the document sizes, update patterns and durability requirements that matter to your application. Those are the measurements we want to improve next.

The [benchmark runner and reproduction instructions](neon/tests/README.md#native-docb-storage) accompany the implementation, together with a [recorded results summary](neon/tests/neon/performance/docb-results.json). The measurements in this post were recorded on November 4, 2026. Full local diagnostic logs remain outside the public source checkout.
