# Contract: production-projection

- **Status:** frozen v1
- **Owner:** promotion engine (`verity/bin/lib/promotion.cjs`, stage 40) — the seam between the dev repo and the production repo. Governing ADRs: 0016, 0017, 0018. Tracking: #107.

## Exposes

A **projection**: the deterministic transformation of the dev repo at a source
ref into the file tree the production repo receives, plus a machine-readable
projection report. Verbs built on this seam (`verity promotion project`, later
`verify`/`propose`/`finalize`) expose it; consumers cite the report, never
recompute it.

**Invariants (never weaken):**

1. **Empty tree start.** The staging directory is created empty; nothing is
   copied into a non-empty staging root.
2. **Public-only copy.** A source-tree path is copied iff it resolves to bucket
   `public` under the classification. `private`/`generated` paths are omitted
   (counted, not copied).
3. **Fail closed on the unresolvable.** An unclassified path, an ambiguous tie
   at equal specificity, or a missing/unparsable classification file aborts with
   a non-zero exit. **Under no failure mode is the whole tree copied.**
4. **Secret scan.** Staged content is scanned before the projection is declared
   built; a hit aborts. No secret value ever appears in a report or log.
5. **Read-only on the repo.** `project` never mutates the dev working tree,
   index, refs, or remotes, and never commits, tags, or pushes anywhere.
6. **Determinism.** Identical (source ref, classification file content) yields
   an identical staging tree and `staging_digest` — no timestamps, no
   environment-dependent digest input.

## Consumes

1. **Source ref** — a tag or commit in the dev repo. The source *tree* comes
   from this ref (`git archive` semantics), never from the working tree.
2. **Classification** — `.verity/production-content-classification.yml` at
   **current HEAD** (present-day policy applied to historical trees). Matching
   semantics (bucket vocabulary, `**`/`*` globs, longest-literal-prefix
   precedence, ambiguity = error) are defined in that file's header, enforced by
   `tests/production-classification.test.cjs`, and implemented ONCE in a shared
   matcher module used by both the CI gate and the engine.

## Schema / wire

Projection report (JSON, written even on failure):

```json
{
  "schema": 1,
  "source_ref": "v1.1.0",
  "source_commit": "<full sha>",
  "classification_digest": "sha256:<hex>",
  "staging_digest": "sha256:<hex>",
  "files_projected": 0,
  "files_omitted": { "private": 0, "generated": 0 },
  "verdict": "built | failed",
  "failures": []
}
```

- `staging_digest` = sha256 over the sorted `(path, per-file sha256)` pairs of
  the staged tree.
- On failure: `verdict: "failed"`, `failures[]` populated (path + reason, never
  a secret value), non-zero exit, and no half-usable staging tree left behind.
- Phase 2+ records (PROM-####, public RELEASE-MANIFEST — ADR-0021) carry
  `source_commit`, `classification_digest`, and `staging_digest` from this
  report.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
