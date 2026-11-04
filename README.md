# Klustr Neon for PostgreSQL 18

One repository builds the PostgreSQL engine, Neon storage services, proxy and
Kubernetes tenant/compute controller. The current release candidate is
**PostgreSQL 18.6 / Linux AMD64**. Applications use ordinary PostgreSQL SQL and JSONB.

[Build and publishing workflow](https://github.com/klustr-io/postgres/actions/workflows/neon-pg18-candidate.yml)
· [Releases and public OCI downloads](https://github.com/klustr-io/postgres/releases)
· [Release notes](neon/RELEASE-NOTES.md)
· [Source/build guide](neon/README.md)
· [Kubernetes tenant deployment and scaling](DEPLOY.md)

[Database lifecycle, backup retention and branching](DEPLOY.md#history-backups-and-branches)
are configured through the management API and Kubernetes resources.
Customer-owned [enterprise fleets and OIDC](DEPLOY.md#enterprise-fleets-and-oidc)
add namespace-scoped provisioning, short-lived database logins and zone placement.
Source builds also package [Anonymizer, DataSketches, vectors, TimescaleDB and BM25](DEPLOY.md#packaged-postgresql-extensions),
alongside PostgreSQL's built-in full-text search.
The source update also supports configurable [native PG18 OAuth login](DEPLOY.md#native-postgresql-18-oauth-login)
through the proxy and an installed token validator. It requires matching rebuilt
compute, proxy and controller images; the older RC5 digests do not include it.

## Published images

GitHub Actions builds these images from release-branch pushes and tagged source,
then publishes the coordinated seven-image set to GHCR as `sha-<commit>`.
The [controller workflow](https://github.com/klustr-io/postgres/actions/workflows/neon-controller.yml)
also publishes independent `controller-sha-<commit>` development updates; deployment YAML pins
the newer KEDA controller described in [DEPLOY.md](DEPLOY.md).

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
docker pull ghcr.io/klustr-io/neon-compute:18.6-rc.5
```

GitHub creates new GHCR packages private initially. An organization administrator
must set each package's visibility to Public once to enable anonymous registry
pulls. See [GitHub's package visibility rules](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
The release manifest records verification at publication time; package visibility
can change afterward. Public release
archives provide an independent download path:

```sh
base=https://github.com/klustr-io/postgres/releases/download/neon-v18.6-rc.5
curl -fLO "$base/compute.oci.tar"
curl -fLO "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
docker load --input compute.oci.tar
```

If organization policy keeps GHCR private, authenticate with `docker login ghcr.io`
using an organization-authorized `read:packages` credential. Kubernetes deployments
need a registry pull Secret on the `default` and `neon-tenant-controller` service
accounts in their namespace. Keep credentials in Secrets, outside source control.
An organization owner can review the Public package-creation setting under
[organization package settings](https://github.com/organizations/klustr-io/settings/packages).

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
GitHub's manual-dispatch UI requires the workflow on the repository's default
branch; tagged releases work from the release branch before that merge.
Build jobs have read-only repository permissions; registry/release credentials
are limited to the separate publication job.

## Kubernetes and qualification

[Tenant setup, Kubernetes options, scaling and performance comparison](DEPLOY.md)
covers the [Docker Compose stack](neon/packaging/compose/compose.yaml) and
[Kubernetes/KEDA YAML](neon/packaging/kubernetes/keda/kustomization.yaml). Configure
S3 and durable volumes, then declare a `NeonDatabase` with a size, tier and sleep
policy. Authenticated webhooks and normal PostgreSQL connections signal demand.
KEDA targets database/fleet resources; the controller drains WAL before stopping
compute and verifies S3 durability before stopping the shared storage fleet.
The proxy/controller and Kubernetes/KEDA control services remain available.
Physical node-to-zero and the future `{project}.{tenant}.klustr.io` HTTP/SNI
front door are separate platform integrations described in the deployment guide.
This deployment support is newer than RC4 and requires the updated controller
image built from this checkout; see the deployment guide for build/install commands.

This RC is ready for integration and review. Production HA/fencing/recovery and
near-native performance qualification remain open; see the
[release notes](neon/RELEASE-NOTES.md) for measured limits. The images are not a
production HA storage operator. JSONB delta storage is not implemented.

## PostgreSQL documentation and licenses

This distribution includes PostgreSQL. See [COPYRIGHT](COPYRIGHT), the component
licenses retained under `neon/`, and the
[PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/).
