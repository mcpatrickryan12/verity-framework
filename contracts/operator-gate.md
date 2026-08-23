# Contract: operator-gate

- **Status:** frozen v1
- **Owner:** operator projection (`verity/bin/lib/operator.cjs`, stage 48) — the
  read-only detail seam for the Console's **Approvals** and **Work** views. A
  gate is a work item paused for a human decision; `operator gates` enumerates
  them with the evidence needed to decide, `operator work` enumerates the live
  queue behind `snapshot.queue`. Governing ADRs: 0008, 0013. Builds on
  `contracts/operator-snapshot.md` (same invariants). Tracking: verity-dev #125-adjacent.

## Exposes

Two read-only list projections, composed from existing derivations exactly as
`operator-snapshot` is:

- **`verity operator gates --json`** — the list of work items currently paused at
  a human gate (`verity:awaiting-approval` / `verity:needs-human`, or a
  `next.decide` gated decision), each enriched with the evidence to approve or
  reject.
- **`verity operator work --json`** — the itemized live queue (the stages behind
  `snapshot.queue`'s counts), each with its status bucket and next action.

**Invariants (never weaken) — inherit all six of `operator-snapshot`, plus:**

1. **Read-only.** Enumerating gates MAY read per-item evidence
   (`trust.classify` does one `gh pr view` per gated PR) but performs NO write,
   applies no label, posts no comment. Bounded: evidence is fetched only for the
   handful of *gated* items, never the whole repo.
2. **Not an approval path.** `gates` surfaces a gate and its `allowed_actions`; it
   NEVER approves. `allowed_actions` is a descriptive list of what an operator
   *could* do (routed later through `operator act`, its own seam), not a grant.
   `merge_authority_granted` is always `false` here — the deterministic worker
   still merges per the trust ladder.
3. **Evidence provenance (ADR-0013).** `risk`, `files_changed`, `protected_paths`,
   `ci` come from `trust.classify` / the GitHub snapshot — Verity/GitHub-observed,
   never an agent's self-report. `verified_cost_usd`/`unknown_cost` follow ADR-0008
   (null = unknown, never 0).
4. **Honest-unknown.** A gate whose PR evidence cannot be read surfaces the fields
   it could not observe as `null` (never a fabricated "low risk / 0 files"). An
   unreachable GitHub yields an empty list under `online:false`, never a
   confident "no gates."

## Consumes

1. **`ledger.project` / `deriveStatus`** — the stage list + status buckets (shared
   with `operator-snapshot`).
2. **Gate membership** — `verity:awaiting-approval` / `verity:needs-human` labels
   in the snapshot (or via `scanner.fetchTargetLabels`), and `next.decide` gated
   decisions (`action:'gated'`, its `gate`/`role`/`reason`).
3. **Gate evidence** — `trust.classify(pr, policy, ghOpts) → { risk:'low'|'high',
   reasons, files, changed_lines, checks_green }` for the gated PR. `reasons`
   carries the protected-path hits.
4. **Cost** — the `usage.csv` rollup for the gated run's cost (ADR-0008 rules).

## Schema / wire

`verity operator gates --json` → a JSON array (compact, pipe-safe) of gate objects:

```json
{
  "schema": 1,
  "gate_id": "gate-42-review",
  "work_item": { "type": "issue", "number": 12, "title": "…" },
  "pull_request": { "number": 42, "url": "https://github.com/owner/project/pull/42" },
  "stage": 12,
  "role": "review",
  "gate": "review:merge",
  "reason": "stage 12 paused at human gate review:merge (verity:awaiting-approval)",
  "risk": "high",
  "evidence": {
    "files_changed": 8,
    "protected_paths": ["contracts/agent-result.md matches protected path contracts/**"],
    "changed_lines": 240,
    "ci": "green",
    "verified_cost_usd": null,
    "unknown_cost": true
  },
  "next_on_approve": { "action": "resume-worker", "merge_authority_granted": false },
  "allowed_actions": ["approve", "reject", "request-changes", "needs-human"]
}
```

`verity operator work --json` → a JSON array of work-item objects:

```json
{
  "schema": 1,
  "stage": 12,
  "title": "…",
  "type": "feature",
  "status": "building",
  "bucket": "waiting_for_ci",
  "issue": 12,
  "pull_request": 42,
  "next": { "role": "build", "reason": "…" }
}
```

- **`risk`** is `trust.classify`'s `low`/`high` verbatim — Verity's real risk
  vocabulary. (It does NOT invent Jim's illustrative `medium`; two honest values,
  not three aspirational ones.)
- **`ci`** ∈ `"green"` / `"unverified"` / `"red"` (mirrors `deriveStatus` /
  `checks_green`; `unverified` when no checks were reported — never silently "green").
- **`gate_id`** is a stable `gate-<pr-or-issue>-<role>` string for the Console to
  key on; it carries no authority.
- **`bucket`** in `work` items is the same vocabulary as `snapshot.queue`
  (`ready`/`in_progress`/`waiting_for_ci`/`awaiting_approval`/`needs_human`/`blocked`).
- **Any field not observed is `null`.** Empty list ⇔ no gates / no work (paired
  with `online` from the snapshot so consumers distinguish "none" from "unknown").

## Versioning

Frozen at **v1**. Additive-only; a breaking change is a NEW contract, not an edit
(framework-spec §4.3). Consumers: the Console's Approvals + Work views. The run
history (`operator runs|run`) is a separate seam (`operator-run`, next stage); the
write surface (`operator act`) is its own seam after that.
