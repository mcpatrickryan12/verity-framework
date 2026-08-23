# Contract: operator-run

- **Status:** frozen v1
- **Owner:** operator projection (`verity/bin/lib/operator.cjs`, stage 49) — the
  read-only run-history seam for the Console's **Runs** view. `operator runs`
  lists recent worker runs; `operator run <id>` returns one. Governing ADRs: 0008
  (unknown cost ≠ 0), 0013. Builds on `contracts/operator-snapshot.md` (same
  invariants). Tracking: verity-dev #125-adjacent.

## Exposes

- **`verity operator runs [--days N] [--limit N] --json`** — recent worker runs,
  most-recent-first, projected from the local usage ledger.
- **`verity operator run <run-id> --json`** — a single run by `run_id`, or an
  honest not-found (empty/`null`), never a fabricated row.

Both RECOMPOSE the existing `usage.csv` ledger; they add no new state and write nothing.

**Invariants (never weaken) — inherit all six of `operator-snapshot`, plus:**

1. **Read-only, local.** The runs list is a pure read of `.verity/usage.csv`
   (`usage.readUsage`). No network is required and none is performed for the list;
   no file is written.
2. **Cost honesty (ADR-0008).** A run's `usage.verified_cost_usd` is the ledger's
   `est_usd` **only when that cell was populated** (a verified figure); an empty
   `est_usd` cell is `null` ("unknown") with `unknown_cost: true` — NEVER coerced
   to `0`. A verified `0` stays `0`.
3. **Evidence provenance (ADR-0013).** Every field is projected from the ledger
   Verity itself wrote — never an agent's self-reported success or cost. Fields
   the ledger does not carry (`runtime`, `model`) are `null` (honest unknown),
   not guessed from a model's claim.
4. **No fabricated history.** `operator run <id>` for an unknown id returns a
   not-found result (empty), never a synthesized run. A missing/empty `usage.csv`
   yields an empty list, not an error.

## Consumes

1. **Usage ledger** — `usage.readUsage(cwd) → { path, exists, rows[], skipped }`,
   each row `{ timestamp, run_id, repo, roles[], tokens_in, tokens_out, est_usd
   (null=unknown), wall_secs, outcome, tool_calls, role, gate }`. This is the sole
   required source.
2. **Window** — `--days N` (UTC calendar days, the `usage` rollup convention) and
   `--limit N` bound the list; defaults are documented in the stage spec.

## Schema / wire

`verity operator runs --json` → a JSON array (compact, pipe-safe), most-recent-first:

```json
{
  "schema": 1,
  "run_id": "run-20260804-0012",
  "repository": "owner/project",
  "roles": ["build"],
  "started_at": "2026-08-04T22:02:01Z",
  "completed_at": "2026-08-04T22:11:58Z",
  "wall_secs": 597,
  "outcome": "gated",
  "gate": "ci-unverified",
  "usage": {
    "input_tokens": 18500,
    "output_tokens": 3200,
    "tool_calls": 42,
    "verified_cost_usd": null,
    "unknown_cost": true
  },
  "runtime": null,
  "model": null
}
```

`verity operator run <run-id> --json` → one such object, or `null` when the id is
not in the ledger.

- **`completed_at`** = the ledger row's `timestamp` (when the run was recorded);
  **`started_at`** = `completed_at − wall_secs` (deterministic from the row). Both
  ISO-8601. `wall_secs` is exposed raw so a consumer never has to reverse the math.
- **`roles`** is the array form (`build`, or `build+review` split on `+`); a run
  with no role recorded is `[]`.
- **`gate`** is the ledger's gate cell or `null`.
- **`usage.verified_cost_usd`** — `null` when the `est_usd` cell was empty
  (unknown), the number when populated; `unknown_cost` is the boolean companion.
- **`runtime` / `model`** — `null`: the usage ledger does not record them. (A
  future enrichment MAY read them from the `🤖 verity-worker <run-id>` summary
  trail; until then they are honestly null, never inferred.)
- **Ordering:** strictly most-recent-first by `completed_at`. **Bounded:** by
  `--days`/`--limit`; the stage spec states the defaults and the projection
  `log()`s nothing it silently truncated beyond the stated window.

## Versioning

Frozen at **v1**. Additive-only; a breaking change is a NEW contract, not an edit
(framework-spec §4.3). Consumers: the Console's Runs view. The write surface
(`operator act`) and the policy/usage/diagnostics projections are separate seams,
each their own stage.
