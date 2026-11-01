# Qualification evidence

Raw executed command logs, exit codes, timings, JUnit XML, upstream diagnostics,
image metadata, sampled pgbench transactions and metrics are written under
`local/`. This directory is ignored to keep generated artifacts and environment
details out of version control.

The reviewable assessment and machine-readable result summary are in
[`docs/qualification/`](../../docs/qualification/). GitHub Actions uploads raw
reports even when a required test fails. A missing or skipped test is never a
passing result.
