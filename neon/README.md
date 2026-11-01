# Neon in one repository

This checkout contains the PostgreSQL engine and Neon runtime source. Changes
are ordinary source edits reviewed with Git. The build does not clone another
Neon repository, apply Neon/PostgreSQL patches, or assemble incremental RC overlays.

| Location | Contents |
|---|---|
| `../src/`, `../contrib/` | PostgreSQL 18.6 engine and direct Neon integration fixes |
| `runtime/` | Pageserver, safekeeper, proxy, compute management, broker, storage controller and extensions |
| `controller/tenant-compute/` | Kubernetes lifecycle and configurable idle/never suspension |
| `packaging/` | Dependency toolchain, minimal runtime images and Kubernetes resources |
| `vendor/` | Licensed historical WAL-decoder headers and repaired third-party zlib source |
| `tests/`, `dev/`, `docs/` | Supporting checks, optional operations and documentation |

Run from the repository root with Node 24 and Docker Buildx:

```sh
node neon/build.mjs
```

This builds the pinned dependency toolchain, compiles the checked-in engine,
Neon binaries and extensions, and creates seven local AMD64 images: compute,
pageserver, safekeeper, storage-controller, storage-broker, proxy and tenant-controller.
Library/package downloads are pinned build dependencies; application sources are
in this checkout. GitHub builds and publication are described in the
[root README](../README.md) and [release notes](RELEASE-NOTES.md).

Use `--plan` to inspect inputs without compiling. Default local tags use
`18.6-dev`; set `--version=18.6-source.4` for a named build.
`--toolchain-image=<immutable-image-id>` explicitly reuses
a prebuilt dependency toolchain; application sources are still compiled.
`NEON_BUILDX_BUILDER` selects a builder; `BUILD_JOBS` sets compilation parallelism.
The local builder is reused when its ignored configuration is available.
Build snapshots, logs, image archives and receipts live under ignored
`build/monorepo-*/`. The latest validated build is `18.6-source.3`: all seven
images and their archives pass basic execution/identity checks, with 231 PostgreSQL
regressions, four protocol tests and 15 focused Node checks passing. See the
[local build receipt](tests/reports/local/neon-source-build.json).

Keep the PostgreSQL 18.6 minor-release update, Neon source import, direct runtime
fixes, and packaging/controller changes as separate review units. The publication branch and release tag keep these changes separate from the
repository default branch.

[Policy configuration](docs/neon-production/README.md) and
[candidate limits](docs/neon-production/CURRENT-CANDIDATE.md) describe sleep/wake
and remaining performance/production qualification gaps. Retired scripts and
build attempts are archived outside this checkout and excluded from builds and PRs.
