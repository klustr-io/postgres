# Release security review

Reviewed on 5 November 2026, starting from `2779e4e1b3923bb38a522390ce82bb2506e2fbb7`.
Source hardening and focused verification are complete; OCI rebuild and scanning
remain pending for this changeset. Published
`sha-2779e4e1b3923bb38a522390ce82bb2506e2fbb7` images do not contain them.

## Reproduced defects and repairs

| Boundary | Finding | Repair |
| --- | --- | --- |
| Storage authentication | A claimed password-frame length reserved memory before authentication. Invalid terminators reached token validation. Unexpected messages could appear in authentication errors with their payload. | Bound authentication payloads to 64 KiB before allocation, require a terminating NUL, and omit unexpected payloads from errors. SQL and COPY retain their separate framing policies. |
| PostgreSQL frontend framing | Empty Describe and Close payloads panicked while parsing. | Check the minimum payload length before consuming fields. |
| Native WAL connections | A peer that stopped reading could retain a feedback or COPY cleanup operation indefinitely. | Apply a socket write deadline when the native WAL API is enabled. Disk mutations are not cancelled by the socket deadline. Ordinary WAL backpressure policy is preserved. |
| Renamed PostgreSQL client | DataRow fields could disagree with the advertised columns and cause a later accessor panic. | Validate field counts at row construction for prepared and simple queries. This also covers the renamed client that package-name scanners miss. |

The field-count repair follows the [upstream PostgreSQL client fix](https://github.com/rust-postgres/rust-postgres/commit/7a00ffa9ad4d951ec0a4564b52f1780fa9d353c1).
The normal client is now checked-in upstream 0.7.18 source with Neon's replication,
COPY BOTH and feedback APIs rebased onto it. Its prepared and simple-query row
validation tests pass. Both client variants are covered by image-build regressions.

## Verification

Thirty-three focused Rust tests passed across frontend framing, authentication,
both PostgreSQL clients, JWT validation, S3 transport and native WAL safety/deadlines.
All eight runtime binary targets type-check with Rust 1.99.1; this does not replace
the pending complete OCI build and link checks.
Authentication tests cover
valid frames through the 64 KiB limit as well as malformed input. The frontend
screen includes 4,096 short frames. Signed JWTs with malformed optional expiration
claims are rejected, while existing internal token compatibility tests pass.

AddressSanitizer, UndefinedBehaviorSanitizer and leak detection passed for the native
quorum policy fixture and 200 libpq reconnect/reset cycles. Descriptor reservations
balanced after each reset. The harness uses non-PIE executables because this local
environment's PIE sanitizer fixture failed inside its signal handler; no production
crash fix is inferred from that harness failure.

The live screen passed against the rebuilt storage binary with matching native WAL
source provenance: 280 connections, including 128 malformed streams rejected. All
three storage processes survived, descriptor counts returned to their baselines,
and maximum RSS growth was 448 KiB per process. The same fixture passed quorum
loss, reconnect, cancellation, configuration-change and immediate process-restart
checks. It produced no throughput samples and used network-isolated tmpfs storage.
An initial diagnostic fixture was rejected by the provenance guard because it
contained an older native WAL source file; that result was excluded and repeated
after rebuilding against current source.

The existing native-library regressions also passed for nonblocking zlib write-state
cleanup and libxml2 ID-table cleanup. They validate the already checked-in library
repairs rather than claiming new fixes in those libraries.

These checks do not establish long-duration memory stability, power-loss durability,
or complete security coverage. No existing database volumes or S3 objects are used.

## Dependencies and release gate

All seven published image roles and the source dependency locks were scanned with
Trivy 0.74.0 and its 5 November vulnerability database. No critical findings were
reported. Findings are package inventory matches, not proof of exploitability;
the runtime packages also retain complete workspace lockfiles for traceability.

Across the same three source lockfiles, package/advisory matches changed from
6 high, 20 medium and 25 low to **0 high, 2 medium and 4 low**. Neither scan reported
critical findings. This is a source inventory comparison, not a claim about new
OCI images.

The runtime now resolves AWS S3 SDK 1.157.0 and Smithy JSON 0.65.1, Diesel 2.3.14
with diesel-async 0.9.2, `jsonwebtoken` 10.4.0, RSA 0.9.10, Rustls 0.23.46,
WebPKI 0.103.16, `tar` 0.4.46, `time` 0.3.47 and `serde_with` 3.21.0. Legacy
Rustls versions are removed. The S3 HTTP/1.1 override uses native trust roots and
TLS 1.2 or later; two tests cover policy selection and eight simultaneous 64 MiB
identity-body uploads to a loopback receiver using the production configuration
function. Custom endpoints use service-required request checksums to preserve S3
compatibility; standard AWS endpoints use the SDK's default checksum policy.

The Rust toolchain is pinned to 1.99.1 for the current SDK. The ORM adapter uses
the new async transaction callback API. A scheduler trait's visibility was narrowed
to match its result type under the newer compiler.

The database image build disables Readline in psql to remove its ncurses dependency.
A psql build and dynamic dependency check passed without Readline, tinfo or ncurses.
This removes interactive line editing/history from the packaged psql client.
Fresh image scans must confirm the resulting runtime inventory before publication.

Two medium inventory findings remain:

* `opentelemetry_sdk` 0.30.0, CVE-2026-48504: the repository installs the W3C
  TraceContext propagator; no Baggage propagator or baggage mutation calls were
  found in runtime source. The vulnerable baggage path is not configured here.
* Thrift 0.17.0, CVE-2026-43868: the proxy uses Parquet for writing telemetry.
  Its Parquet reader calls are inside the test module; no production reader
  for untrusted Thrift metadata was found in this review.

These dependencies remain in the inventory and reports. Activating those paths
would require revisiting this exposure assessment. Low findings are retained
in the raw source scan rather than hidden.

Relevant primary references include the [AWS parser bulletin](https://aws.amazon.com/security/security-bulletins/2026-067-aws/)
and the [PostgreSQL client advisory](https://rustsec.org/advisories/RUSTSEC-2026-0178.html).

`neon/dev/checks/security/scan-release.mjs` scans the exact OCI archives before
publication. Critical and high findings block publication, as do selected known
authentication, TLS, row parser and SQL construction advisories at medium severity.
Scanner errors, missing OS/application inventories and a database older than 48
hours also block publication. No vulnerability waivers are configured.

Both the coordinated release publisher and the controller-only workflow use this
gate. The controller workflow builds an archive, scans it and pushes that same
archive. Reports are retained as workflow artifacts. The gate rejected an existing
compute archive and accepted the controller archive, exercising both outcomes.
The workflow changes have been validated locally; their first complete OCI run is pending.

To scan a completed local build without publishing:

```sh
node neon/dev/checks/security/scan-release.mjs --input=build/monorepo-<build-id>
```

Local raw scan reports, regression logs and sanitizer evidence are under
`build/security-2779e4e/`. The raw evidence and scanner cache remain outside the
source tree's tracked documentation.
