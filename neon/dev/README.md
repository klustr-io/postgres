# Optional development and operations tools

The full build is `node neon/build.mjs` from the repository root.
See [the source/build index](../README.md).

These helpers are separate from engine/runtime fixes. `build/postgres/` supports
engine-only development; `checks/tooling/` performs static checks;
`operations/kubernetes/` contains local deployment smoke tools;
`performance/` retains optional native-PG/Neon comparison tools; `shared/` contains
their imports. Historical fixture receipts do not qualify a new source build.

Old source-rewriting scripts and incremental image builders are archived outside
this checkout. They are not inputs to the full build.
Credentials remain in ignored root `.env` or `neon/dev/.env`.
