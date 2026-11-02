# Control-plane repair

The audit of fd64cad found divergent API/YAML defaults, namespace-owner conflicts,
missing enclosing-fleet lifecycle checks, incomplete OIDC audit correlation,
independent image authorities, and mixed transport/application/infrastructure code.

Target ownership:

- Database policy resolves inherited defaults and explicit overrides once.
- Fleet policy selects the established namespace owner and protects retirement.
- Application commands own database, branch, backup and fleet transitions.
- HTTP adapters authenticate, validate and translate requests/results. Route
  registries bind named operations; composition constructs concrete collaborators.
- Kubernetes, SQL credentials and deployment provisioning implement narrow ports.
  Provisioning invocations own their configuration; they share no mutable globals.
- The packaged release supplies images for both runtime configuration and pods.

Repair order: policy/lifecycle regressions; identity and release contracts;
transport/application extraction and explicit ports; public contracts and CI gates.
Preserve HTTP paths, status codes, SCRAM access and single-writer semantics.
Omitted database policy fields inherit current fleet defaults. Existing persisted
values remain explicit overrides; this change performs no data migration.
Conflicting newcomers are rejected without stopping the established fleet.

Verification: run `node --test neon/tests/neon/unit/*.test.mjs`, controller lint
and contract checks, deterministic deployment rendering, and a controller image
build after the module and packaging changes are complete. Focused tests must
exercise commands and API/YAML consumer behavior, not only object construction.
Native engine performance and live zone-failure qualification are separate gates.

The repair now uses named domain, application, API, infrastructure and composition
modules under the controller's `src`. Provider file caching belongs to
`ConfigurationSnapshot`; database commands receive its read port. The owned
architecture gate also rejects application imports of concrete provider/file/HTTP
adapters, checks async initializers and enforces public contracts in CI.

Local verification passes the controller suite, lint and architecture gate. A
temporary namespace exercised fleet/database/branch/backup metadata commands via
HTTP against real Kubernetes persistence and resource-version conflicts; it did
not provision native database storage. The rebuilt nonroot controller image
matches the source tree and generated fleet bundle. Native OAuth/JWT/opaque-token
checks passed separately. These are local results; publication, native performance
targets, automatic failover and zone-loss qualification remain separate work.
