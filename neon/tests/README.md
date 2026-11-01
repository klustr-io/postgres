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
