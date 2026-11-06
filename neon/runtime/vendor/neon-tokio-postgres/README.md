# Checked-in PostgreSQL client source

Based on upstream tokio-postgres-v0.7.18 (f1cb6ec0d5766b136cbd68f3010d64142a5daa66).
The Tokio client retains Neon physical/logical replication, COPY BOTH and status feedback
from commits 4ad59e8, bd7761f and 62f7889. Upstream row field-count validation is retained.
Dependencies use the checked-in protocol and types packages.

# Rust-Postgres

PostgreSQL support for Rust.

## postgres [![Latest Version](https://img.shields.io/crates/v/postgres.svg)](https://crates.io/crates/postgres)

[Documentation](https://docs.rs/postgres)

A native, synchronous PostgreSQL client.

## tokio-postgres [![Latest Version](https://img.shields.io/crates/v/tokio-postgres.svg)](https://crates.io/crates/tokio-postgres)

[Documentation](https://docs.rs/tokio-postgres)

A native, asynchronous PostgreSQL client.

## postgres-types [![Latest Version](https://img.shields.io/crates/v/postgres-types.svg)](https://crates.io/crates/postgres-types)

[Documentation](https://docs.rs/postgres-types)

Conversions between Rust and Postgres types.

## postgres-native-tls [![Latest Version](https://img.shields.io/crates/v/postgres-native-tls.svg)](https://crates.io/crates/postgres-native-tls)

[Documentation](https://docs.rs/postgres-native-tls)

TLS support for postgres and tokio-postgres via native-tls.

## postgres-openssl [![Latest Version](https://img.shields.io/crates/v/postgres-openssl.svg)](https://crates.io/crates/postgres-openssl)

[Documentation](https://docs.rs/postgres-openssl)

TLS support for postgres and tokio-postgres via openssl.

# Running test suite

The test suite requires postgres to be running in the correct configuration. The easiest way to do this is with docker:

1. Install `docker` and `docker-compose`.
   1. On ubuntu: `sudo apt install docker.io docker-compose`.
1. Make sure your user has permissions for docker.
   1. On ubuntu: ``sudo usermod -aG docker $USER``
1. Change to top-level directory of `rust-postgres` repo.
1. Run `docker-compose up -d`.
1. Run `cargo test`.
1. Run `docker-compose stop`.
