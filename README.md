# Klustr Neon for PostgreSQL 18

One repository builds the PostgreSQL engine, Neon storage services, proxy and
Kubernetes tenant/compute controller. The current release candidate is
**PostgreSQL 18.6 / Linux AMD64**. Applications use ordinary PostgreSQL SQL and JSONB.

[Build and publishing workflow](https://github.com/klustr-io/postgres/actions/workflows/neon-pg18-candidate.yml)
· [Releases and public OCI downloads](https://github.com/klustr-io/postgres/releases)
· [Release notes](neon/RELEASE-NOTES.md)
· [Source/build guide](neon/README.md)

## Published images

GitHub Actions builds these images from the tagged source and publishes them to GHCR:

| Component | Registry repository |
|---|---|
| Compute | `ghcr.io/klustr-io/neon-compute` |
| Pageserver | `ghcr.io/klustr-io/neon-pageserver` |
| Safekeeper | `ghcr.io/klustr-io/neon-safekeeper` |
| Storage controller | `ghcr.io/klustr-io/neon-storage-controller` |
| Storage broker | `ghcr.io/klustr-io/neon-storage-broker` |
| PostgreSQL proxy | `ghcr.io/klustr-io/neon-proxy` |
| Tenant/compute controller | `ghcr.io/klustr-io/neon-tenant-controller` |

Each release includes `release-manifest.json`, `SHA256SUMS` and all seven
OCI-compatible archives. Pin production deployment references to the manifest's
registry digests. Version tags identify releases; `sha-<commit>` identifies source.
`candidate` tracks release candidates; only a stable release updates `latest`.

```sh
docker pull ghcr.io/klustr-io/neon-compute:18.6-rc.4
```

GitHub creates new GHCR packages private initially. An organization administrator
must set each package's visibility to Public once to enable anonymous registry
pulls. See [GitHub's package visibility rules](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
The release manifest records anonymous-pull verification. Public release
archives provide an independent download path:

```sh
base=https://github.com/klustr-io/postgres/releases/download/neon-v18.6-rc.4
curl -fLO "$base/compute.oci.tar"
curl -fLO "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
docker load --input compute.oci.tar
```

## Build and update

Node 24.19+, Docker 29 with its containerd image store, and Docker Buildx are required.
Use an AMD64 Linux builder with 16 GiB RAM and at least 32 GiB free disk:

```sh
node neon/build.mjs
```

The engine source is in `src/` and `contrib/`; Neon runtime source is in
`neon/runtime/`. The build does not fetch a separate Neon checkout or replay
source patches. Build, deployment and test support lives under `neon/`.

Pull requests run focused checks without publishing. Pushes to `REL_18_STABLE_neon`
and `main` build and publish commit-tagged images. A tag such as
`neon-v18.6-rc.4` also creates a GitHub prerelease with public OCI assets and notes.
Manual runs build without publishing unless the publishing input is selected.
Build jobs have read-only repository permissions; registry/release credentials
are limited to the separate publication job.

## Kubernetes and qualification

[Deployment prerequisites and suspend policies](neon/docs/neon-production/README.md)
cover provisioned storage, S3, independent controller metadata PostgreSQL,
ComputeSpecs, TLS/SCRAM Secrets and connection routing. The default idle timeout
is five minutes; selected databases can be configured never to suspend.
Databases sharing a compute share its lifecycle.

This RC is ready for integration and review. Production HA/fencing/recovery and
near-native performance qualification remain open; see the
[release notes](neon/RELEASE-NOTES.md) for measured limits. The images are not a
complete storage provisioning operator. JSONB delta storage is not implemented.

## PostgreSQL documentation and licenses

This distribution includes PostgreSQL. See [COPYRIGHT](COPYRIGHT), the component
licenses retained under `neon/`, and the
[PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/).
