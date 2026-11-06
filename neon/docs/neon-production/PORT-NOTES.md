# PG18 port review notes

The checked-in patches are the build inputs. The Python port helpers reconstruct
those changes in an isolated checkout and refuse unrelated edits; builds do not
depend on that checkout or on WSL. The lock records both patch SHA-256 values and
the resulting Git tree IDs.

## PostgreSQL 18.6 fork

The production delta applies the Neon fork to the official PG18.6 commit. It
retains upstream minor/security fixes, including visibility-map locking and WAL
block references, alongside Neon's custom resource manager and remote-redo
guards. Debug and release check-world runs are recorded separately from runtime
acceptance.

The fork exports a completion API for non-file SMGR reads. The Neon communicator
performs a read before normal AIO completion transfers buffer pins and performs
page validation. A remote relation never supplies a fabricated file descriptor
to a worker. Completion is currently synchronous in the issuing backend;
performance at scale needs measurement. Buffer lifecycle, failure and checksum
corruption cases exercise the actual core completion callbacks.

PG18 SMGR registration compares complete implementations correctly when
deduplicating registrations. The port also restores the last-written-LSN hooks
used by Neon, including sorted GiST root-page writes.

## Neon runtime

- Version dispatch, generated headers and control/checkpoint serialization use
  genuine PG18 layouts. The initdb import path chooses the requested version;
  the former generic PG14 control-file alias is invalid for PG18.
- PG18 transaction-statistics records use 16-byte items. Appended visibility-map
  block references must not be mistaken for an old heap page during WAL decode.
  PG18.6's physical VM references also must not produce a second page value at
  the same key/LSN as Neon's logical visibility clear. The logical clear owns
  those VM updates; the original WAL, including FPIs, remains on the heap
  records and in the safekeeper WAL stream. Independent VM records are retained.
- The PG18 storage-manager adapter preserves local temporary/unlogged handling,
  registers remote reads with AIO, and supports PG18's SLRU callback. Downloaded
  SLRU segments are fsynced and published exclusively without replacing a
  segment another backend may already have modified.
- The redo helper initializes PG18 buffer/AIO/backend state with `io_method=sync`;
  it has no postmaster-managed I/O workers. Vector reads/writes advance the block
  number for each buffer. Per-record reset clears only in-memory overflow pages;
  rerunning core `smgrinit()` would leak exit callbacks. A protocol test applies
  256 WAL records in one helper process to guard that lifecycle.
- PG18 initializes the corruption-feedback counter in the generic Neon profile.
  Receiving a pageserver corruption signal must not dereference the optional
  commercial-profile counter before its shared memory exists.
- The communicator's dropped-log count retains its previous value when Rust
  returns an empty queue without updating the out-parameter.

## Archive security

The candidate replaces the unmaintained `tokio-tar` 0.3.1 dependency with the
maintained `astral-tokio-tar` 0.7.0 parser, retaining the local crate name to avoid
unrelated import changes. The exact registry checksum and resolved dependency
versions are captured in the port's Cargo.lock. The updated libc bindings also
require xattr 1.6.1; the old xattr 1.0.0 references a removed Linux errno alias.
The subsequent SCRAM hardening vendors the actual upstream postgres-protocol
0.6.12 implementation, preserving Neon's replication extensions through a
reviewed merge. Its excessive-iteration rejection regression runs alongside
the protocol unit suite; the version is not merely relabelled.

The inherited Hakari helper unconditionally selected `fail/failpoints`, even
when service `testing` features were absent. The port removes that edge and
excludes `fail` from Hakari's generated unification. Explicit testing features
can still enable fault injection in dedicated test builds. Artifact and runtime
image checks require pageserver and safekeeper to report `failpoints: false`.

Manual safekeeper extraction validates relative paths before joining them to
its fresh destination. Pageserver imports use PAX-aware entry names and effective
lengths instead of raw header fields. Tests exercise parent-directory escape
attempts, a PAX size override containing an embedded TAR header, and normal path
normalization. These are runtime import/extraction changes and require the same
distributed qualification as the PG18 port.

Scanner inventories include the workspace Cargo.lock, including test and
non-linked dependencies. Applicability must be assessed per component. The
hardened native set pins libxml2 2.15.4, libxslt 1.1.45, curl 8.23.0 and zlib
1.3.2 with upstream commit df84af25dc1942490e1d1c899a07619152a46148 applied.
Security regressions exercise nonblocking gzip writes and ID-table cleanup
after attribute-type corruption. Minimal production images retain package
metadata and explicit native source SBOMs. Raw scans remain unchanged; a
separate source-checked applicability gate emits image-bound VEX. Primary sources:

- [Astral TAR releases and security fixes](https://github.com/astral-sh/tokio-tar/releases)
- [Debian libxml2 CVE-2026-6653 status](https://security-tracker.debian.org/tracker/CVE-2026-6653)
- [Debian zlib CVE-2023-45853 applicability](https://security-tracker.debian.org/tracker/CVE-2023-45853)
- [AWS Smithy JSON advisory](https://aws.amazon.com/security/security-bulletins/2026-067-aws/)
- [Rust PostgreSQL SCRAM iteration advisory](https://github.com/advisories/GHSA-5x78-73v4-xg6w)
- [Rustls WebPKI CRL advisory](https://github.com/rustls/webpki/security/advisories/GHSA-82j2-j2ch-gfr8)
- [Diesel SQLite advisory](https://rustsec.org/advisories/RUSTSEC-2026-0111.html)
- [Zlib upstream overflow fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)
- [libxslt issue and libxml2 mitigation](https://security-tracker.debian.org/tracker/CVE-2025-7425)

## Storage profile and remaining scope

PG18 changed initdb's default to enable PostgreSQL disk-page checksums. Neon's
existing WAL reconstruction changes page bytes without updating that checksum.
New Neon tenants therefore explicitly use the inherited `data_checksums=off`
profile. Checksummed PG18 imports fail explicitly; the port does not overwrite
page checksums or bypass compute validation. Checksum-enabled standalone and
AIO corruption tests remain enabled. Remote checksum support needs a separate
integrity design and acceptance decision.

The generic S3 pgdata importer, Kubernetes tenant/compute controller, object-store
multi-zone recovery, fencing/migration, security review and at-scale cluster qualification
remain separate gates. Passing an image build or the local distributed test does
not close those gates. See [README.md](README.md) and [readiness.json](readiness.json).

## Index-build checkpoint regression discovered during write tuning

The original candidate can PANIC when a background writer or checkpointer
flushes a permanent GIN index page before the index builder performs its final
bulk WAL logging. A controlled pause in a GIN index expression followed by a
checkpoint reproduces the zero-LSN PANIC with WAL compression **off**. The
compression experiment exposed this issue; compression was not its cause.

The repair restores the pinned PG17 contract for buffer flushes without a
relation handle: pass unknown persistence to `smgropen`. `BM_PERMANENT` controls
checkpoint/WAL requirements; it does not establish that an index page is already
stored remotely. The Neon storage manager can then detect the builder's local
file. The protection against discarding genuinely unlogged remote pages stays
enabled.

The isolated repaired image passes the reproducer, all 231 PostgreSQL core
regression tests, and local quorum-loss/compute-crash checks. See
`neon/tests/reports/local/neon-index-build-regression.json`. The production source
source files contain this fix. Historical patch/overlay inputs are archived locally. The current RC component images include the
repaired PostgreSQL binary; see CURRENT-CANDIDATE.md for its bound evidence and
remaining production limits. Historical tuning images are diagnostic artifacts.
