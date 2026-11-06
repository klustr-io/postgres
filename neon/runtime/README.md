# Neon runtime workspace

This directory contains the Rust/C runtime source and PostgreSQL extensions used
by the single-checkout build. Run `node neon/build.mjs` from the repository root;
that command builds the engine, extensions, runtime services and controller images.
The PostgreSQL engine source is in the repository's root `src/` and `contrib/`.

The source was imported from `klustr-io/neon` at
`fa504217c61bbcaf5c512d75830564541f917f8f`, with the PG18 integration and reviewed
runtime fixes applied directly to these files. See [source provenance](../sources.json),
[build instructions](../README.md), [LICENSE](LICENSE) and [NOTICE](NOTICE).

Direct Cargo development requires the compiled PostgreSQL headers/proposer libraries;
the root container build prepares these prerequisites. No separate Neon checkout,
Git submodule initialization or source-patching step is required.
