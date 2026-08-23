# Contract: operator-snapshot

- **Status:** frozen v1
- **Owner:** operator projection (`verity/bin/lib/operator.cjs`, stage 47) — the
  single read-only seam an out-of-process operator surface (the Verity Console,
  cron reports, `jq` scripts) consumes to answer "what is Verity doing, and what
  happens next?" without recomputing lifecycle truth. Governing ADRs: 0008
  (unknown cost ≠ $0), 0013 (model claims don't move state / Verity performs
  effects). Tracking: #92-adjacent Console work; vision `docs/verity-console-vision.md`.

## Exposes

A **projection**: a single deterministic, read-only composition of Verity's
already-externalised state into one operator-facing snapshot. `verity operator
snapshot --json` exposes it; consumers **render** it, they never recompute it.

**Invariants (never weaken):**

1. **Read-only.** `snapshot` never mutates the working tree, index, refs,
   remotes, labels, comments, or any file. It performs no `git`/`gh` write, opens
   no PR, applies no label. It is a pure function of (GitHub snapshot, local
   runtime files). A Console built on this cannot change state through it.
2. **Not a second state machine.** Every lifecycle field is **recomposed** from
   the existing derivations — `ledger.project`/`deriveStatus` for stage status,
   `next.decide` for the next action, the `usage.csv` rollup for cost, the
   effective-autonomy policy for caps/mode. `snapshot` adds no independent
   inference of a stage transition. If `next.decide` and `snapshot` ever
   disagree, `snapshot` is the bug.
3. **Evidence provenance (ADR-0013).** Every value is **Verity-observed** or
   **GitHub-observed**. No **agent-reported** claim (a model's self-declared
   success, cost, or verdict) is ever promoted into a snapshot field. Agent
   claims belong to the run contract's raw channel, flagged as such — never here.
4. **Honest unknown, fail-closed (ADR-0008).** Unreachable GitHub sets
   `online: false` and `health.github: "unavailable"` and omits/nulls the counts
   it could not observe — it never fabricates a queue of zeros that reads as
   "all clear." A cost Verity has not deterministically verified is `null`
   ("unknown"), **never** coerced to `0`. `unknown_cost_runs` counts them.
5. **Secret redaction.** Output passes through the engine redactor
   (`ledger.redact`); no token shape or `Authorization`/`Bearer`/`token` line
   ever appears in a field, a reason string, or an error.
6. **Determinism of source.** Identical (GitHub snapshot, runtime files) yields
   identical output except `generated_at`. No wall-clock-dependent field beyond
   that timestamp; no ordering nondeterminism.

## Consumes

1. **GitHub snapshot** — issues/PRs/CI/tags for the resolved repo
   (`ledger.fetchSnapshot` / `ledger.resolveRepo`, honoring `--repo`/`--gh-repo`).
   Never fails open: an unreachable GitHub is reported (invariant 4), not hidden.
2. **Derived stage status** — `ledger.deriveStatus` over `stage-instructions/`,
   plus the live per-item labels the scanner reads (`scanner.fetchTargetLabels`)
   for the gate buckets (`awaiting_approval`, `needs_human`, `circuit-open`).
3. **Next action** — `next.decide` (same decision the worker/`verity state next`
   uses); `snapshot.next` is a projection of it, not a re-derivation.
4. **Effective autonomy policy** — `autonomy.cjs` (mode, trust, caps
   `max_runs`/`max_cost_usd`, `escalate_routing`, etc.).
5. **Usage rollup** — `usage.csv` (`usage.cjs`): runs-today and
   verified-cost-today, with unknown-cost runs counted separately per ADR-0008.
6. **Runtime + health** — harness/model detection and `doctor` result
   (`doctor.cjs`, `engine-meta.cjs`); worker last-tick/outcome/lock from the
   run-summary trail and `locks.cjs` (GitHub-comment-based locks).

## Schema / wire

`verity operator snapshot --json` (JSON to stdout, the frozen wire; a
human-readable render MAY be the non-`--json` default but is not contractual):

```json
{
  "schema": 1,
  "repository": "owner/project",
  "generated_at": "2026-08-04T22:45:00Z",
  "online": true,
  "autonomy":  { "mode": "supervised", "circuit_open": false, "trust": 0 },
  "runtime":   { "harness": "codex", "profile": "openai-subscription",
                 "provider": "openai", "model": "configured-model",
                 "status": "available" },
  "worker":    { "state": "idle", "last_tick": "2026-08-04T22:41:00Z",
                 "next_tick": null, "last_outcome": "gated", "lock": null },
  "queue":     { "ready": 2, "in_progress": 0, "waiting_for_ci": 1,
                 "awaiting_approval": 1, "needs_human": 1, "blocked": 0 },
  "next":      { "role": "review", "target_type": "pull_request", "target": 42,
                 "reason": "CI passed and review is required" },
  "limits":    { "runs_today": 6, "max_runs": 24, "verified_cost_usd": 4.82,
                 "max_cost_usd": 25, "unknown_cost_runs": 1 },
  "health":    { "doctor": "pass", "github": "available",
                 "runtime": "available", "policy": "valid" }
}
```

- **`schema`** — integer; this contract is `1`. Bump only additively.
- **`online`** — `false` when the GitHub snapshot could not be read; consumers
  MUST treat a `false` snapshot as "state unknown," not "nothing to do."
- **`next`** — `null` when there is no next action; otherwise mirrors
  `next.decide` (`role`, `target_type` ∈ `issue`/`pull_request`, `target`
  number, human `reason`). Never a merge instruction — the worker still merges
  per the trust ladder.
- **`limits.verified_cost_usd`** — dollars Verity deterministically verified
  today; **`null` means unknown, never `0`** (ADR-0008). `unknown_cost_runs` is
  the count of today's runs whose cost is unknown.
- **`worker.lock`** — the current live lock holder (GitHub-comment-based) or
  `null`; a Console "run now" button reads this to disable itself rather than
  launch a conflicting tick.
- **Any field the projection could not observe is `null`**, not a plausible
  default. Nulls are first-class and mean "unknown."

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer (the Console's
Mission Control view first) depends on this shape. The sibling read contracts
(`operator-gate`, `operator-run`) and the write surface (`verity operator act …`)
are separate seams, planned as their own stages once this one is stable.
