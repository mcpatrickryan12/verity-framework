# Contract: role-capability-policy

- **Status:** frozen v1
- **Owner:** `verity/bin/lib/agents/policy.cjs` (role authors produce it; every
  provider driver consumes its projection; the Reviewer/Security Auditor audit it)
- **Related:** ADR-0007 (fail-closed, runtime-neutral), T06 (deny-by-default)

The runtime-neutral declaration of what a role is ALLOWED to do, projected by
each provider driver into that runtime's native controls. This contract freezes
the capability vocabulary and the fail-closed semantics — not any provider's
enforcement mechanism.

## Exposes

One file per role: `commands/verity/<role>.permissions.json`, validated against
`schemas/role-permissions.schema.json`, installed alongside the role by every
adapter (same travel-together rule as today's `.tools.json`).

## Consumes

Nothing at runtime. It is static declarative input, read by
`agents/policy.cjs` before any provider process is spawned.

## Schema / wire

```json
{
  "schema_version": 1,
  "capabilities": {
    "read_repository": true,
    "write_repository": true,
    "run_tests": true,
    "git_read": true,
    "git_write": true,
    "github_read": true,
    "github_write": true,
    "network": false,
    "deploy": false
  },
  "codex": {
    "sandbox": "read-only | workspace-write",
    "approval": "untrusted | on-request | never",
    "ignore_user_config": true,
    "ignore_rules": false
  }
}
```

Frozen semantics:

- **Every capability key defaults to `false` when absent.** Absence never
  grants anything.
- **A missing or schema-invalid policy file refuses execution** (exit 30) for
  any provider that depends on it — the T06 rule, provider-neutralized. There
  is no fallback to a runtime's default permission surface.
- **`danger-full-access` is not a legal `codex.sandbox` value in v1.** Any
  future unrestricted mode is a new contract with its own explicit opt-in.
- **Overrides narrow, never widen.** A worker/autonomy-policy sandbox or
  approval override may only be more restrictive than the role's projection.
- Provider sections (`codex`, and later others) are projections, not
  authorities: a projection that exceeds what the `capabilities` block grants
  is schema-valid but load-invalid — `policy.cjs` rejects it.
- Claude migration: `<role>.tools.json` remains the operative Claude allowlist
  until the Claude driver consumes this file with zero behavior change; while
  both exist, `.tools.json` governs Claude and this contract governs everyone
  else.

## Versioning

Frozen at **v1**. Changes are **additive only** — new capability keys and new
provider sections may be added (defaulting closed); redefining an existing key
or loosening a default is a NEW contract, not an edit (framework-spec §4.3).
Every consumer depends on this shape.
