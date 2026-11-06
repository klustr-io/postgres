# PostgreSQL 18 / Neon development

For full-stack Docker Compose or Kubernetes deployment, use the root
[DEPLOY.md](../../../DEPLOY.md). It provisions storage services and optional tenants.
The lower-level controller configuration below remains useful for integration
with separately managed storage.

Use ordinary PostgreSQL SQL, JSONB and application schemas. Performance changes must remain internal to PostgreSQL/Neon; the custom document API experiment has been removed.

## Working layout

- `src/`: PostgreSQL and Neon integration changes.
- `neon/packaging/`: pinned build recipes, OCI packaging, Kubernetes resources and runtime fixes.
- `neon/controller/tenant-compute/`: connection routing, ownership and configurable sleep/wake.
- `neon/dev/`: native/component build tools.
- `neon/tests/neon/`: focused build/runtime checks.
- `neon/tests/reports/local/`: ignored local manifests and cleanup receipts.

## Build from this checkout

Run `node neon/build.mjs` from the repository root. The engine is built from
the root source directories; all Neon runtime sources are checked in under
`neon/runtime/`. No separate application-source checkout, patch application or
historical image overlay is used. See [the build index](../../README.md).

Prior RC archives and measurements remain historical evidence for their exact
recorded digests. The consolidated build has its own source receipt and does not
inherit full production qualification from those records.

## Configurable suspension

Each endpoint ConfigMap has an `endpoint.json` value. The default is five minutes
of SQL inactivity. Set the endpoint default and optional database overrides:

```json
{
  "suspend": {"mode": "idle", "idleSeconds": 300},
  "databasePolicies": {
    "billing": {"mode": "never"},
    "events": {"mode": "idle", "idleSeconds": 300}
  }
}
```

Use `"suspend": {"mode": "never"}` to keep an entire endpoint running. Policy
edits take effect on reconciliation without restarting an active compute.
Databases sharing a compute share its lifecycle: any `never` policy keeps that
compute running; otherwise every database must reach its own idle timeout.
Use separate endpoints for independently sleeping databases.

Active queries, open transactions and background replication work prevent
suspension. Idle pooled connections may close at suspension; the next normal
PostgreSQL connection through the proxy wakes compute. The controller closes
admission, drains WAL to the safekeeper quorum and records the frontier before
scaling to zero. A failed drain keeps compute present and admission closed.
Controller restart conservatively starts a fresh idle observation window.

[`neon/packaging/kubernetes/examples/endpoint.yaml`](../../packaging/kubernetes/examples/endpoint.yaml)
shows the complete public ConfigMap shape; replace its worker, registry and IP
allowlist. It references existing Secrets, never inline credentials.
[`controllerResources`](../../packaging/kubernetes/tenant-controller.mjs) renders
namespace-scoped neon/controller/proxy resources from digest-pinned images.

This component requires provisioned Neon storage and an upstream ComputeSpec;
it does not create storage tenants or a production storage topology. Provision
the compute-spec, admin credentials, SCRAM role verifiers, backend TLS/CA and
proxy/controller TLS/token Secrets first. Secret keys and the working local
assembly are shown in `neon/dev/operations/kubernetes/check-neon-controller.mjs`;
its short-lived test certificates are not production credentials. The current
deployment uses one controller and one proxy and pins each writer to a worker.
Cross-worker failover requires external fencing; scaling replicas alone does
not provide HA or add writers to the same PostgreSQL primary.

Keep validation small: basic correctness, a matched native-PG versus Neon write
comparison, and a scale-to-zero/wake smoke check. The current record includes
focused acknowledgement-policy controls and the requested storage-CPU comparison.
Full historical matrices are not the default workflow.

See [current status](CURRENT-CANDIDATE.md) and [PG18 port notes](PORT-NOTES.md).

## Historical evidence

Retired experiments and local fixture reports are archived outside the checkout.
Release artifacts and registry digests are published by the GitHub workflow;
local credentials and database fixtures are never included.
