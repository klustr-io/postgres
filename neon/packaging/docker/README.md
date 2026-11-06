# Container builds

`neon/Dockerfile.toolchain` builds pinned C/Rust dependencies. `neon/Dockerfile`
compiles the checked-in engine/runtime and packages six minimal runtime targets.
`neon/runtime/Dockerfile.tenant-controller` builds the seventh image from the
controller source. Run `node neon/build.mjs` at the repository root for the set.

`postgres/` and `test-client/` are optional standalone engine development recipes.
`shared/` contains the pinned Debian repository configuration. Former incremental
overlay recipes are archived outside this checkout.
