# Best effort versus durable: cloud write-loss risk

Reviewed 2026-11-04. Applies to this repository's PostgreSQL 18 / Neon source
configuration, including the unpublished `best-effort` changeset. This is a
failure-model analysis, not a measured production reliability percentage or SLA.
See [deployment configuration](DEPLOY.md#commit-profiles).

**Best effort can make the normal loss window small, but it puts no fixed limit
on that window. S3 cannot recover a write that never reached durable storage.**
Durable quorum protects acknowledged commits against a compute loss or one
safekeeper failure under the assumptions below. Neither mode protects against
every combination of storage loss, operator error, broken recovery or compromise.

## What we can say in percentages

There is no defensible deployment-specific percentage yet for either failed
write requests or lost acknowledged writes. Our short local tests establish
behavior and performance; they do not measure cloud failure frequency.

Four different percentages must stay separate:

| Quantity | Meaning | What we know |
|---|---|---|
| Failed write-request rate | Requests rejected, aborted or timed out / attempted writes | Must be measured under the actual load, deadlines and failure conditions. A timeout can have an unknown commit outcome. |
| Acknowledged-write loss rate | Successful commits missing after authoritative recovery / successful commits | Depends on acknowledgement-to-durability lag and failures that erase the exposed tail. Illustrative calculations follow. |
| Annual chance of any loss incident | Chance that at least one acknowledged write is lost during a year | Can be substantial even when the percentage of individual writes lost is tiny. |
| Stored-object durability | A provider's design target for preserving uploaded objects | Does not describe writes still in compute, complete database recoverability, or service availability. |

For a **compute-only failure**, durable mode has **0% acknowledged-write loss
in the specified fault model**, provided its durable quorum remains recoverable.
That is a conditional protocol property, not a claim of 100% real-world database
reliability. Best effort can lose **up to 100% of the acknowledged writes that
have not reached a recoverable durable prefix** when that compute is lost.
It does not imply that 100% of the whole database is normally at risk.

## Cloud assumptions and where the acknowledgement occurs

The reference setup is one writer, three safekeepers on durable volumes, one
safekeeper in each of three availability zones, and a multi-zone object store.
The storage stack must honor flushes and recovery must follow the correct
timeline and consensus history. Three pods on one host, shared local disks or
three nominal zones mapped to one failure domain do not meet these assumptions.
The fork's zone-placement configuration alone is not an HA certification.

```text
SQL transaction / compute WAL
        |
        | best-effort can acknowledge here
        | bounded-async can acknowledge here if its admission checks pass
        v
WAL streamed and flushed by a safekeeper quorum
        |
        | durable acknowledges after this boundary
        v
WAL / page history uploaded; complete recoverable object-store frontier advances
```

Object storage is downstream of the synchronous commit boundary. The upstream
[Neon architecture](https://neon.com/docs/introduction/architecture-overview)
describes this separation; the actual acknowledgement rules in this fork are
implemented in [the commit guard](neon/runtime/pgxn/neon/bounded_commit_guard.c)
and [WAL-proposer feedback](neon/runtime/pgxn/neon/walproposer_pg.c).

| Policy | What a success response establishes | Compute WAL | Behavior when replication stalls |
|---|---|---|---|
| `durable` | The commit is covered by durable safekeeper quorum. | Local fsync enabled. | New commits wait for quorum; client deadlines can expire. |
| `bounded-async` | The commit may be ahead of quorum, admitted using verified frontier freshness, live-quorum state and byte limits. | Ephemeral, local fsync disabled. | Fast acknowledgements stop when admission conditions fail; affected commits wait. |
| `best-effort` | PostgreSQL logically committed the transaction; remote durability is not established by the acknowledgement. | Ephemeral, local fsync disabled. | Acknowledgements may continue without quorum until another resource/backpressure limit intervenes. |

All three retain safekeeper disk flushing. In the managed best-effort profile,
explicitly synchronous transactions still require quorum and the planned drain
closes the fast path. The current controller also verifies an available quorum
when waking compute; best effort is not an unconditional ability to start a
database while its storage is unavailable.

PostgreSQL's ordinary asynchronous-commit documentation assumes a local durable
WAL path and distinguishes it from disabling fsync. Our fast profiles instead
rely on the remote Neon storage path: **do not apply these settings to a regular
stateful PostgreSQL data directory or assume that its crash-safety explanation
proves this fork's recovery safety**. Ephemeral compute must recover from valid
remote state. Its local cache is not an authoritative backup.
[PostgreSQL asynchronous commit](https://www.postgresql.org/docs/18/wal-async-commit.html)

## How S3 changes the risk

Amazon publishes **99.999999999% annual object durability** and **99.99% annual
object availability** design targets for S3 Standard, with redundancy across at
least three AZs. The durability complement is **0.000000001%**, or `10^-11` as a
fraction. Those figures concern objects within that service's scope, not
end-to-end database transactions. S3-compatible APIs do not inherit AWS's
architecture or targets. Single-zone classes require a separate assessment.
[AWS S3 data protection](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html)

An object upload is also not automatically a complete database recovery point:
the required WAL, base/page history, manifests, metadata and keys must all be
available and mutually consistent. Use the generation-validated remote frontier,
not a count of successful PUTs, to decide whether storage can be removed.
Our [remote-durability check](neon/controller/tenant-compute/src/domain/storage/WalDurability.mjs)
compares that frontier with the required WAL boundary.

For comparison, AWS describes gp3 volume durability as **99.8–99.9%**, with an
annual failure rate no higher than **0.2%**. This is a volume-level design figure,
not the annual failure probability of a database, a compute pod, or a quorum.
Do not multiply disk probabilities to invent a database durability claim:
correlated failures, copy placement, repair time and surviving WAL matter.
[AWS gp3 documentation](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)

Cloud availability commitments likewise do not reveal how many destructive
compute failures occur. Time spent unavailable, lost disks, lost RAM, and
permanent database loss are different events.

## Illustrative probability model

These are **hypothetical planning calculations**, not observed cloud rates.
They isolate compute-tail loss; they exclude destructive storage failures,
regional disasters, application deletion, software defects and compromised keys.

Assume a continuously active writer and:

- `lambda`: destructive compute events per year, each assumed to erase the
  entire not-yet-quorum tail. This is deliberately conservative about tail
  recovery; some real failures leave recoverable copies elsewhere.
- `d`: seconds between a write's acknowledgement and its durable quorum.
- Failures follow a stationary Poisson process, independent of write timing
  and lag; a year has `31,536,000` seconds.

For one write with a fixed exposure duration:

```text
P(write lost to a modeled compute failure) = 1 - exp(-lambda * d / 31,536,000)
percentage = 100 * P(write lost)
```

| Assumed acknowledgement-to-quorum exposure | Assuming 1 destructive event/year | Assuming 12 destructive events/year |
|---|---:|---:|
| 10 ms | 0.0000000317% | 0.0000003805% |
| 100 ms | 0.0000003171% | 0.0000038052% |
| 750 ms | 0.0000023782% | 0.0000285388% |
| 5 seconds | 0.0000158549% | 0.0001902586% |
| 60 seconds | 0.0001902586% | 0.0022830790% |

**Neither 10ms nor 750ms is a measured maximum replication delay.** The 750ms
row is a mathematical scenario, not a certification of `bounded-async`.
Best effort has no configured remote-age cap. Use actual lag distributions,
including outages, rather than selecting the most attractive row.

For variable exposure `D`, use `E[1 - exp(-lambda * D / seconds_per_year)]`.
Using mean lag in the formula is a small-risk approximation; a p95 or p99 lag
is not a maximum. If host failures and replication stalls share a cause, the
independence assumption can materially understate risk.

### Tiny per-write percentages can still mean recurring loss

At a continuously busy writer, suppose every modeled destructive event finds
an exposed tail containing at least one acknowledged write. Then:

```text
P(at least one modeled loss incident/year) = 1 - exp(-lambda)
```

| Hypothetical destructive-event rate | Annual probability of at least one loss incident |
|---|---:|
| 0.1/year | 9.52% |
| 1/year | 63.21% |
| 12/year | 99.9994% |

If an exposed tail exists only a fraction `q` of the relevant time, independent
of failures, use `1 - exp(-lambda * q)` instead. A mostly sleeping database has
a different exposure pattern from a continuously busy writer. Do not count a
successfully completed managed drain as a destructive event.

At **15,000 writes/s**, a fixed **100ms** exposed tail contains approximately
**1,500 writes**. With the assumed one tail-erasing event/year, expected annual
loss is about 1,500 writes, even though the per-write probability is only
0.0000003171%. Loss arrives in bursts, not as randomly missing isolated rows.

At fleet scale, a hypothetical independent rate of 0.1 such events per active
database-year across 1,000 continuously active databases gives an expected 100
incidents/year. Shared nodes, fleets and regions can also cause many databases
to fail together. A small per-database percentage is not a fleet incident budget.

## Failure scenarios and worst cases

The table assumes the cloud topology above. “No acknowledged loss” is conditional
on valid surviving durable state and correct recovery, not a universal promise.

| Scenario | `durable` | `bounded-async` | `best-effort` |
|---|---|---|---|
| Managed suspend / scale-to-zero completes successfully | Acknowledged WAL is drained before compute stops. | Same drain requirement. | Same drain requirement; new fast acknowledgements are disabled during drain. |
| Compute process/node is abruptly lost; safekeepers survive | Acknowledged commits survive remotely; reconnect/recovery can take time. | The ahead-of-quorum tail can be lost. | The ahead-of-quorum tail can be lost, with no configured time bound. |
| One safekeeper process or disk fails; compute survives | One-failure tolerance for acknowledged commits. Remaining two can form quorum. | Already-quorumed writes remain protected; recent fast acknowledgements still need replication. | Same distinction; losing one safekeeper does not by itself require losing writes while healthy copies/compute survive. |
| Two safekeepers are temporarily unavailable | New strict commits cannot form quorum. Previously durable data is not necessarily lost. | Fast admission eventually fails and waits. | Writes may still acknowledge; exposure can grow. |
| Compute-to-safekeeper partition, then compute is destroyed | New strict commits were not successfully acknowledged without quorum. | An already acknowledged tail can be lost even after later writes were blocked. | All writes acknowledged since the last recoverable remote prefix can be lost. |
| One AZ is lost, including compute and its colocated safekeeper | One-per-AZ storage placement preserves the one-failure guarantee for acknowledged commits. Availability/replacement still depends on the controller and volumes. | Recent writes not yet covered by surviving durable storage may be lost. | Same, potentially with a much larger exposed tail. |
| All safekeeper volumes are permanently lost before their latest WAL reaches S3 | If no other usable WAL copy survives, recovery falls back to the newest complete remote state; acknowledged data after it can be lost. | Same, plus any otherwise unrecoverable compute-only tail. | Same, plus any otherwise unrecoverable compute-only tail. |
| S3 is unavailable, but safekeepers and their durable disks survive | S3 unavailability alone does not erase quorumed commits. Cold reads, uploads and retention pressure may impair service. | Same for quorumed commits; early acknowledgements remain separately exposed. | Same for quorumed commits; early acknowledgements remain separately exposed. |
| Replication or uploads fall behind until capacity fills | Writes can wait/fail. A storage error must not be treated as durable success. | Admission limits can stop fast writes before other capacity limits intervene. | Backpressure or disk exhaustion can stop writes; this is not a promised RPO boundary. |
| Whole region becomes unavailable | Multi-AZ quorum is not independent regional DR. An outage is not automatically permanent loss. | Same, with additional unprotected tail exposure. | Same, with additional unprotected tail exposure. |
| Operator/attacker deletes all usable copies, or essential decryption keys are permanently lost | Potentially 100% unrecoverable data in the affected scope. | Same. | Same. |
| Client loses connection around COMMIT | Outcome can be unknown: the commit may be durable despite the timeout. | Outcome may be unknown, and an acknowledged fast commit can later be lost. | Same, with unrestricted remote exposure. |

A single failed storage node is different from permanent destruction of a quorum
or all copies. Two offline nodes do not automatically mean permanent data loss;
one remaining copy can still hold useful WAL, but cannot alone provide the same
availability/consensus guarantees. Recovery must not blindly select a convenient
stale replica or invent a new writer history.

### Worst case 1: replication outage followed by compute loss

At time `t0`, compute loses its connection to all safekeepers. Best effort keeps
returning success. Compute is then lost before those writes acquire recoverable
remote durability. Every acknowledged write in that tail may disappear.

At 15,000 acknowledged writes/s, illustrative exposure is:

| Continued acknowledgements without recoverable remote progress | Potential exposed writes |
|---|---:|
| 1 second | 15,000 |
| 1 minute | 900,000 |
| 15 minutes | 13,500,000 |

These counts assume the system actually continues at that rate; backpressure,
storage capacity or other failures may stop it sooner. They are not a throughput
prediction during an outage. If a new database has never reached any usable
remote recovery point, its entire acknowledged dataset could be lost.

`bounded-async` reduces continued admission using the current 750ms verified-prefix
age and 64MiB ahead-of-quorum settings. Those are WAL-byte/admission checks, not
a count of JSON documents or a maximum time-to-durability promise. A previously
acknowledged tail can remain exposed throughout a later, prolonged partition.
Blocking subsequent writes does not retroactively make that tail durable.

### Worst case 2: quorum data exists, but S3 is behind

Suppose the newest complete object-store recovery point is five minutes behind
the writer. If every copy of the intervening WAL is permanently destroyed, all
three profiles can lose that interval, including strict-mode acknowledgements.
At an assumed 15,000 writes/s, five minutes represents 4,500,000 writes.

This is a multiple-copy/common-cause disaster, outside the normal one-node fault
model. Making upload lag small reduces the exposed interval; durable quorum does
not establish zero-loss regional recovery or zero-loss restoration from S3 alone.
Finding newer individual S3 objects does not prove a complete recovery chain.

### Worst case 3: an application acted on a write that later vanished

A successful best-effort database response can trigger an email, shipment, webhook
or upstream acknowledgement. Recovery can then discard the database record while
the external action remains. PostgreSQL consistency does not roll back another
service. A queue consumer that deletes its only durable input after a best-effort
commit may lose both replayability and the database effect.

Use durable commits for irreproducible business state. Replayable workloads need
independent durable inputs, idempotency keys and reconciliation. A transient
in-memory queue, including an unpersisted ZeroMQ message, does not establish an
independent durable copy.

## Scale-to-zero, backups and cloud controls

Managed scale-to-zero closes admission, checks active work, drains WAL to quorum,
persists the drain boundary and then removes compute. An uncertain drain retains
the writer. Full storage-fleet shutdown additionally requires its remote-frontier
checks. These are separate operations; sleeping compute does not imply that all
storage can immediately disappear. See [compute lifecycle](neon/controller/tenant-compute/src/infrastructure/compute/Lifecycle.mjs)
and [storage-fleet lifecycle](neon/controller/tenant-compute/src/application/storage/StorageFleet.mjs).

A forced pod deletion, OOM kill, host termination or expired termination grace
period can bypass a completed managed drain. PDBs do not prevent every
involuntary disruption. Planned shutdown must finish the controller protocol;
simply giving a pod a grace period is insufficient.
[Kubernetes disruptions](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)

Keep safekeeper volumes persistent and in distinct failure domains. For example,
EC2 instance-store data does not survive stop/termination; a local cache is not a
durable replacement for the intended storage volumes.
[AWS instance-store persistence](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-lifetime.html)

Back up metadata, credentials/key recovery material and consistent data recovery
points. History and branches in the same failure/credential domain do not provide
independent disaster recovery. Use separately protected copies where required.
Versioning/Object Lock can protect retained object versions, but retention must
be tested with Neon's garbage collection and lifecycle policies before changing
the live storage bucket. [AWS Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)

Cross-region object replication is also asynchronous. AWS S3 RTC describes 99.9%
of new objects being replicated within 15 minutes; that is not a zero-loss
cross-region database commit guarantee or a bound covering every object. Database
upload delay and complete-recovery-chain readiness must also be included.
[AWS replication time control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)

## What to measure before publishing a customer percentage

Record these per database, fleet and physical failure domain:

1. Acknowledged writes, request failures and unknown outcomes separately.
2. Acknowledgement-to-quorum exposure, including stall intervals and tail
   distribution; WAL byte lag alone is not a time measurement.
3. Complete remote recovery-frontier age and cross-region recovery-point age.
4. Ungraceful compute losses, safekeeper/volume failures, common-cause incidents,
   successful drains and failed/forced drains per active compute-year.
5. Actual post-recovery missing write identifiers, plus replay/reconciliation
   success. Count affected tenants and the largest burst, not just the mean.

The current guard exposes quorum/pending-prefix locations and counters, but does
not by itself supply a production per-write loss probability. Our local evidence
verifies selected paths, not cloud incident rates. Zero observed losses in a
short benchmark is not evidence of a zero-percent risk.

Under the same independent Poisson assumptions, zero observed relevant events
over `T` active database-years gives an approximate 95% upper event-rate bound
of `3/T` per year. Even that needs representative exposure and consistent event
definitions; it does not cover untested correlated disasters or software errors.

## Policy selection

| Customer intent | Policy | Practical interpretation |
|---|---|---|
| A successful commit must survive ordinary compute/one-node loss | `durable` | Prefer waiting or an unavailable write over acknowledging an unprotected tail. Maintain independent backups for broader disasters. |
| Some recent loss is acceptable, with a limit on continued risky admission | `bounded-async` | The roughly-good option. Monitor lag and test recovery; do not sell the current settings as a certified one-second RPO. |
| Throughput matters more than retaining every acknowledged update | `best-effort` | Suitable where lost work can be tolerated or replayed. Expect potentially large bursts of loss during replication failures followed by compute loss. |

The short local eight-CPU-total screen measured best effort at about **2x JSONB**
and **3.5x WAL-only** throughput over strict quorum. These performance ratios do
not measure reliability, and normal-case replication lag was not qualified as a
production loss window. Details are in [the source release notes](neon/RELEASE-NOTES.md)
and [commit-profile deployment options](DEPLOY.md#commit-profiles).
