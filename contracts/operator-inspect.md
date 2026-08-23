# Contract: operator-inspect

- **Status:** frozen v1
- **Owner:** operator projection (`verity/bin/lib/operator.cjs`, stage 51) — the
  read-only drill-down seam behind the snapshot: the Console's **Policy**,
  **Usage**, and **Health** views. Three projections that reshape existing
  internal outputs (`autonomy.loadPolicy`, `usage.summarizeUsage`,
  `doctor.runChecks`) into stable, Console-facing shapes, insulating the Console
  from churn in those internal outputs. Governing ADRs: 0008, 0013. Builds on
  `contracts/operator-snapshot.md` (same invariants). Tracking: verity-dev #125-adjacent.

## Exposes

- **`verity operator policy --json`** — the effective (defaults + user) autonomy
  policy, or an honest `valid:false` when it cannot be parsed.
- **`verity operator usage [--days N] [--by-role] --json`** — the usage-ledger
  rollup over a UTC-day window, with verified vs unknown cost kept separate.
- **`verity operator diagnostics --json`** — the `doctor` host-preflight result:
  per-check rows plus an overall pass/fail.

All three RECOMPOSE existing derivations; they add no new state and write nothing.

**Invariants (never weaken) — inherit all six of `operator-snapshot`, plus:**

1. **Read-only, local.** `policy` and `usage` read local files (`.verity/autonomy.yml`,
   `.verity/usage.csv`); `diagnostics` runs read-only host probes (`doctor`). No
   file is written, no GitHub mutation performed.
2. **Cost honesty (ADR-0008).** `usage.verified_cost_usd` is the summed cost of
   runs with a KNOWN cost; `unknown_cost_runs` counts those without. The two are
   ALWAYS reported side by side so a partial (known-only) sum is never mistaken
   for the verified total. Never coerce unknown to 0.
3. **Fail-honest, never fail-open.** An unparseable policy ⇒ `{ valid:false,
   reason }`, NEVER a fabricated default presented as the user's live policy. A
   missing usage ledger ⇒ zeroed totals with `unknown_cost_runs:0` and the honest
   `path`. A failing doctor check ⇒ `ok:false` on that row and `overall:"fail"`.
4. **Provenance (ADR-0013).** Every value is Verity-observed (its own policy file,
   its own ledger, its own host probe) — never an agent's self-report.

## Consumes

1. **Effective policy** — `autonomy.loadPolicy(cwd)` → the merged (DEFAULTS + user)
   policy; throws `PolicyError` on an invalid file (caught → `valid:false`).
2. **Usage rollup** — `usage.summarizeUsage(cwd, { days, byRole })` →
   `{ days, since, timezone, runs, tokens_in, tokens_out, est_usd,
   unknown_cost_runs, unknown_cost_rows, unknown_cost_gated_runs, tool_calls,
   outcomes, skipped_rows, path, by_role? }`.
3. **Host diagnostics** — `doctor.runChecks(opts)` → `[{ name, present, version,
   ok, detail }]`; `doctor.exitCodeFor(checks)` for the overall verdict.

## Schema / wire

`verity operator policy --json` → one compact object:

```json
{
  "schema": 1,
  "valid": true,
  "mode": "supervised",
  "trust": 0,
  "limits": { "max_runs_per_day": 24, "max_usd_per_day": 25, "unknown_cost_behavior": "gate", "unverified_ci_behavior": null },
  "review": { "escalate_routing": false },
  "policy": { "…": "the full effective policy, verbatim from autonomy.loadPolicy" }
}
```
(On an unparseable file: `{ "schema":1, "valid":false, "reason":"…", "policy":null }`.)

`verity operator usage --json` → one compact object:

```json
{
  "schema": 1,
  "days": 7,
  "since": "2026-07-29T00:00:00Z",
  "timezone": "UTC",
  "runs": 12,
  "tokens_in": 210000,
  "tokens_out": 41000,
  "tool_calls": 380,
  "verified_cost_usd": 4.82,
  "unknown_cost_runs": 1,
  "outcomes": { "success": 9, "gated": 2, "failed": 1 },
  "by_role": null,
  "skipped_rows": 0
}
```

`verity operator diagnostics --json` → one compact object:

```json
{
  "schema": 1,
  "overall": "pass",
  "checks": [
    { "name": "git", "present": true, "version": "2.45.1", "ok": true, "detail": "" },
    { "name": "gh",  "present": true, "version": "2.62.0", "ok": true, "detail": "" }
  ]
}
```

- **`policy.valid`** — `false` (with `reason`) when `autonomy.loadPolicy` throws;
  `policy` is then `null`. `mode`/`trust`/`limits`/`review` are convenience
  top-level projections of the full effective `policy` for the Console's common
  case. `limits` surfaces BOTH cost/CI knobs: `unknown_cost_behavior` (the
  ADR-0008 rule, always present, defaults `"gate"`) and `unverified_ci_behavior`
  (a valid but usually-unset key, `null` until set). The complete effective policy
  is always under `policy`.
- **`usage.verified_cost_usd`** — the summed KNOWN cost (ADR-0008); the raw
  `est_usd` from `summarizeUsage` is exposed under this honest name and ALWAYS
  paired with `unknown_cost_runs`. `by_role` is `null` unless `--by-role`.
- **`diagnostics.overall`** — `"pass"` iff `doctor.exitCodeFor === 0`, else
  `"fail"`; `checks` is the `runChecks` array verbatim.
- **Any value not observed is `null`** (or the honest zero for a counted total
  from an empty ledger, paired with `unknown_cost_runs:0`).

## Versioning

Frozen at **v1**. Additive-only; a breaking change is a NEW contract, not an edit
(framework-spec §4.3). Consumers: the Console's Policy / Usage / Health views. This
is the LAST engine seam of the operator surface — with it frozen and green, the
full contract boundary (`operator-snapshot`/`-gate`/`-run`/`-act`/`-inspect`) that
the separate `verity-console` repo consumes is complete.
