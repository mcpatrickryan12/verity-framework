# Contract: local-work-item

- **Status:** frozen v1
- **Owner:** engine — the local delivery-substrate driver (ADR-0029). The engine
  is the only writer (worker-owned, ADR-0026); roles never touch these files.

## Exposes

The on-disk records of the **local substrate** (`substrate: "local"`), from which
the driver assembles the same snapshot shape the GitHub substrate reads — so
`ledger.project` / `deriveStatus` / `next.decide` consume either substrate
unchanged. Two record types, both committed to the project repo:

1. **Work-item record** — `.verity/work-items/<number>.json` — the local
   equivalent of a `[stage N]` GitHub issue.
2. **Gate-run record** — `.verity/gate-runs/<branch-slug>.json` — the local
   equivalent of a commit's CI check rollup; the ONLY source of a local
   green/red reading.

Consumers: the local snapshot driver (reads), graduation (replays work-item
records into real GitHub issues via the stage-file→issue machinery the
benchmark's in-flight provision already uses), and later the console's Fresh
surface (reads).

## Consumes

- The committed `stage-instructions/stage-N-*.md` files (ledger matching is
  unchanged: the `[stage N]` title convention is mandatory).
- Git itself: branch existence / merge state supply the PR-shaped half of the
  snapshot; the gate-run record supplies its `statusCheckRollup` equivalent.
- The committed gate definition (ADR-0029 §4): ordered named commands,
  exit-code judged. Its concrete file format is fixed by the builder, but this
  contract fixes what a gate-run record must say about executing it.

## Schema / wire

**Work-item record** (`.verity/work-items/<number>.json`) — field-for-field the
issue snapshot the ledger reads today (`number,title,state,labels,assignees`):

```json
{
  "schema": 1,
  "number": 3,
  "title": "[stage 3] <title exactly as the issue title would be>",
  "state": "OPEN",
  "labels": ["feature"],
  "assignees": [],
  "created_at": "2026-08-19T00:00:00Z",
  "updated_at": "2026-08-19T00:00:00Z"
}
```

- `state`: `"OPEN" | "CLOSED"` — uppercase, matching the `gh --json` casing the
  derive layer already switches on.
- `labels`: flat string array; the FULL T02 vocabulary applies with unchanged
  semantics — `verity:awaiting-approval` (announced gate),
  `verity:approved` (single-use resume token; the worker consumes it),
  `verity:needs-human` (parked; skipped by decide), and the type labels.
- `number` is unique per repo and never reused; the filename must equal
  `<number>.json`.

**Gate-run record** (`.verity/gate-runs/<branch-slug>.json`):

```json
{
  "schema": 1,
  "branch": "stage-3-some-slug",
  "sha": "<full commit SHA the gates ran against>",
  "started_at": "2026-08-19T00:00:00Z",
  "finished_at": "2026-08-19T00:00:00Z",
  "gates": [
    { "name": "test", "command": "npm test", "exit_code": 0 }
  ]
}
```

- **Honesty rule (load-bearing):** the driver reports green for a branch ONLY
  when a gate-run record exists whose `sha` equals the branch's CURRENT head
  and every `gates[].exit_code` is `0`. Any nonzero exit → red. No record, a
  stale `sha`, an empty `gates` array, or no gate definition in the repo →
  UNKNOWN → the existing `ci:unverified` gate fires. Green is never inferred,
  carried forward, or defaulted.
- `exit_code` is the judged truth (never parsed output — gates are judged by
  exit code only).

**Snapshot assembly (normative):** work-item records → the snapshot's
`issues[]`; per stage branch, git state + the matching gate-run record → the
snapshot's `prs[]` equivalent (`state`: OPEN while unmerged / MERGED after the
engine's local `--no-ff` merge; `statusCheckRollup` synthesized from the
gate-run per the honesty rule above). The derive layer must not be able to
tell which substrate produced the snapshot.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
Graduation replay and the console's Fresh surface both read these records;
`schema` is present in every record so a future v2 can coexist file-by-file.

## Additive notes

- **`runner` on the gate-run record** (stage 86, ADR-0030 — additive, optional):
  a string naming WHERE the gates' exit codes came from. Allowed values:
  `"direct" | "localhost" | "remote:<name>" | "github-actions"`. **Absent reads
  as `"direct"`** — every record written before stage 86 was executed by the
  direct (stage-82, engine-spawned) runner, so older records stay valid
  unchanged. Readers MUST accept records with or without the field; it never
  participates in the honesty rule above (`sha` + `exit_code` remain the only
  verdict inputs).
