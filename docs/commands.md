# Command Reference

Verity runs a project as a sequence of specialized AI roles. You invoke each role
as a slash command in your AI assistant (Claude Code or OpenCode) after installing:

```bash
npm i -g verity-framework
verity install --claude                  # or: --opencode
```

There are **15 role commands**. The command name is short; the *role* it runs is
named in the table — `/verity:ship` runs the Release/Deploy Operator,
`/verity:verify` runs the Handoff Tester, `/verity:build` runs the Stage Manager,
and so on. Start any new project with [`/verity:vision`](#design).

> The commands are the public surface. Underneath, each one calls the deterministic
> `verity` CLI (run `verity help` to see it) — but you rarely touch the CLI directly.

---

## Design

Lock what you're building before any code is written.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:vision` | Vision | Clarify the idea, lock the project identity, and scaffold the repo with an honest hygiene CI. **Start here.** |
| `/verity:architect` | Architect | Turn the locked identity + vision into a technical design — stack & topology, frozen interface contracts, ADRs, the deployment target (from your `verity deployment` catalog) — and own the walking skeleton. |
| `/verity:deploy-setup` | Deployment Methods | Interview you about where you deploy apps (AWS / GCP / Azure / LAN / PaaS / SSH / k8s…) and build your **global** `~/.verity/deployment-methods.md` catalog — locations, never secrets. A setup helper run once (or when your targets change); the Architect reads what it writes. |

## Plan & Build

Stages are the unit of work. They are born in the Planner, built in isolation, and
merged only through review.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:plan` | Intake / Planner | Assess a request and write the stage spec + work-item. The **only** place stages are born — both the initial backlog and the recurring request stream. |
| `/verity:build <stage-number>` | Stage Manager | Build one stage in isolation, open a green PR, and hand off to review. **Never merges.** |
| `/verity:review <stage-number> [pr-number]` | Reviewer / Integrator | Adversarially review a stage's PR against the source, then merge. The integration gate — you did *not* write this code. |
| `/verity:test` | Project Tester | Guardian of test honesty: real, CI-like tests plus bug fixes, so "done = green" actually means something. |

## Quality Gates

Defined once, enforced on every change.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:security` | Security Auditor | Define the security invariants the Reviewer enforces per-PR, and run periodic deep audits. |
| `/verity:docs` | Technical Writer | Own the human-readable layer: public/developer docs, the architecture narrative, and handoff briefs that let another agent pick up a feature. |

## Release & Operate

Take accrued merges all the way to production — and keep it healthy.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:ship` | Release / Deploy Operator | Cut a release, deploy to staging, UI-smoke verify, promote to prod, and update `STATUS.md`. |
| `/verity:verify` | Handoff Tester | Adversarial end-user testing on the **live** app, and re-verify-on-live after each deploy — finding what scripted smokes can't. |
| `/verity:golive` | Pre-Go-Live Gate | **Blocking** gate before the project accepts real data or users: force-close the "fine for now" list (Security Auditor + SRE jointly). |
| `/verity:sre` | SRE | Steady-state operations: recovery/backup readiness, intermittent-env handling, secret rotation, and monitoring. |
| `/verity:autonomy-setup` | Autonomy Deployment | Interview you about how to run the headless `verity-worker` (cron / Actions / manual), then generate the tailored deployment — `.verity/autonomy.yml`, the cron line and/or Actions workflow, bot + secrets checklists, and a `DEPLOYMENT.md`. A setup helper run once (or when your deployment changes). |

## Any time

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:map` | Codebase Mapper | Generate an on-demand, structural code map (distinct from the Planner's schedule) — generated, never hand-maintained. |

## Promotion (dev→prod projection)

One place the CLI itself is the public surface: `verity promotion project`
builds the **projection** — the deterministic, allowlisted file tree the
production repository receives from the development repository — per the frozen
[`production-projection` contract](../contracts/production-projection.md).

```bash
verity promotion project <ref> [--out <dir>] [--report <path>] [--json]
```

- `<ref>` — the source tag or commit. The source *tree* comes from this ref
  (never the working tree); the content classification is always read at
  current `HEAD`.
- `--out <dir>` — staging directory; must not exist or be an empty directory
  (defaults to a fresh temp dir). Only `public`-classified paths are copied;
  `private`/`generated` paths are counted, never copied.
- `--report <path>` — where to write the projection report JSON (defaults to
  beside the staging dir). Written even on failure.
- `--json` — exactly one compact JSON object on stdout (pipe-safe).

The builder **fails closed**: an unclassified path, an ambiguous classification
tie, a missing/unparsable classification, or a secret-scan hit on staged
content aborts the run (no half-usable staging tree is left behind, and secret
values never appear in the report — path + pattern name only). Exit codes:
`0` built · `20` contract violation · `30` infrastructure failure.

`verity promotion verify` then **proves the projection is a working product**,
not just a filtered tree:

```bash
verity promotion verify <staging-dir> [--report <path>] [--baseline <version>] [--json]
```

- **In-staging gates (offline, always run):** `npm ci` from the projected
  lockfile (a downgrade to `npm install` happens only for a structural reason
  and is reported explicitly), `npm run lint`, `npm test`, and `npm pack` — all
  executed with the *staging dir* as the working directory, never the dev repo.
- **Pack-content inspection:** every entry in the packed tarball must exist in
  the staging tree, and none may resolve to a `private`/`generated` bucket
  under the classification.
- `--baseline <version>` — **network, opt-in:** byte-compare the locally packed
  tarball against the published npm artifact of that version (sha1, plus the
  registry `dist.shasum`). The fetch only runs when
  `VERITY_PROMOTION_BASELINE_TEST=1` is also set; without the flag the baseline
  is *skipped loudly* (a clear message plus `{skipped, reason}` in the report)
  and the exit code reflects only the offline gates.
- `--report <path>` — the projection report to extend (defaults to
  `<staging-dir>.report.json`). `verify` adds a `verify` block
  `{gates, pack_shasum, baseline, verdict}` **additively** — the `project`
  fields are never altered.

Exit codes: `0` all gates pass (and the baseline matches when actually run) ·
`20` gate failure, pack-content violation, or baseline mismatch ·
`30` infrastructure failure.

`verity promotion propose` turns a **verified** projection into the promotion
PR in the production repository, plus both provenance records of the frozen
[`promotion-records` contract](../contracts/promotion-records.md):

```bash
verity promotion propose <version> --staging <dir> [--report <path>] [--dry-run] [--json]
```

- **Preconditions (fail closed, exit `20`):** `.verity/promotion.json` must
  name `prod_repo`; the projection report (`--report`, default
  `<staging-dir>.report.json`) must carry a **passing `verify` block** —
  unverified staging is not proposable; `<version>` must be semver and
  strictly greater than prod's latest tag. PROM numbering derives from the
  existing `.verity/promotions/` records (`PROM-0001` first).
- **The promotion tree is constructed, never merged:** the new projection
  verbatim, plus prod-HEAD files matching the `prod_owned` globs from
  `.verity/promotion.json`. Anything in neither set is absent — deletions fall
  out naturally. A projected path matching a `prod_owned` glob is a
  configuration error and aborts (exit `20`) naming the path.
- **Records:** `RELEASE-MANIFEST.json` is written fresh at the tree root and
  the private `.verity/promotions/PROM-####.yml` (status `proposed`, PR number
  recorded) is committed to the current dev branch. Every digest/shasum in
  both records is **copied from the projection report, never recomputed**.
- **The PR:** branch `promote/v<version>`, one commit
  `Promote Verity v<version> (dev@<sha12>)` on top of prod HEAD (no shared
  history with dev), pushed to prod, PR opened via `gh` (title
  `Promote Verity v<version>`, body = manifest summary + gate table).
  Manifest, commit message, and PR body are sanitized: no dev repo names,
  URLs, or internal paths; issue refs in the `dev#NN` plain-text form.
- `--dry-run` — stop after tree construction + manifest: report the would-be
  tree (projected / prod-owned / deleted counts, kept tree dir) and push
  **nothing** — no branch, no PR, no PROM record, no dev commit.

No tagging, no merging, no npm publish anywhere in this verb — those belong to
`finalize` and human authority. Exit codes: `0` proposed (or dry-run preview) ·
`20` contract violation, failed precondition, or disjointness violation ·
`30` infrastructure failure (network, clone, push, `gh`).

`verity promotion finalize` completes a promotion **after its PR has been
reviewed and merged in prod** — the only place authoritative `vX.Y.Z` tags are
born post-split (ADR-0019):

```bash
verity promotion finalize <version> [--json]
```

- **Preconditions (fail closed, exit `20`):** a `.verity/promotions/`
  PROM record for `<version>` with status `proposed` (a `released` record
  refuses — finalize is not repeatable; a superseding promotion is a *new*
  record), and the promotion PR the record names must be **MERGED** in prod —
  an open PR refuses with a message naming the review/merge step, and the tag
  must not already exist.
- **Verify before tagging (contract rule):** finalize clones prod at the merge
  commit and checks the merged tree's `RELEASE-MANIFEST.json` against the PROM
  record field-for-field (version, promotion id, development commit, staging +
  classification digests, package shasum), then runs `npm pack` on the merged
  tree and compares the result to the record's `package_shasum`. **Any
  mismatch aborts with exit `20`, tags nothing, and leaves the record status
  untouched.**
- **Tag + Release:** an *annotated* tag `v<version>` on the merge commit,
  pushed to prod, and a GitHub Release (title `v<version>`, sanitized body
  embedding the manifest). The dev repo is never tagged — test-asserted.
- **Record completion:** the PROM record moves `proposed → released` with
  `production.commit`, `production.tag`, and `timestamps.finalized_at` filled,
  committed to the dev branch (`chore(promotion)` message). The record is
  immutable afterwards.
- **npm publish is NOT executed** (open decision O4: publish auth). Finalize
  prints the exact manual publish instruction — clone the tag fresh, `npm
  publish`, with the expected tarball shasum to verify against — and records
  `published: pending-O4` in its envelope.

Exit codes: `0` finalized · `20` wrong status, unmerged PR, or verification
mismatch · `30` infrastructure failure (network, clone, tag push, `gh`).

### The end-to-end release runbook (dev → prod)

Once the split is active, a release is this sequence — each step gated by the
one before it:

```bash
# 1. In DEV: compute the release (sanitized changelog; no tag anywhere)
verity release prepare --apply            # commit the CHANGELOG edit via review as usual

# 2. In DEV: build the projection from the release-candidate ref
verity promotion project <ref> --out <staging>

# 3. In DEV: prove the projection is a working product
verity promotion verify <staging>         # add --baseline <ver> + env flag for the byte-match lane

# 4. In DEV: open the promotion PR in prod (both provenance records written)
verity promotion propose <version> --staging <staging>

# 5. In PROD: review and merge the promotion PR (human/reviewer authority —
#    no verity verb does this)

# 6. In DEV: verify the merged tree, then tag + release in PROD, complete the record
verity promotion finalize <version>

# 7. Manually: publish to npm from a fresh clone of the prod tag, comparing
#    the shasum finalize printed (pending O4 — not automated)
```

Steps 1–4 and 6 are deterministic CLI verbs; steps 5 and 7 are deliberate
human gates at the only irreversible moments.

Once the dev/prod split is active, the dev-side release computation is
`verity release prepare`:

```bash
verity release prepare [--bump patch|minor|major] [--apply] [--json]
```

- Computes the next version and changelog section exactly as `release cut`
  would (one shared derivation — the two verbs can never disagree), with the
  section emitted **already sanitized**: `#NN` issue refs become plain-text
  `dev#NN` so the projected CHANGELOG cannot autolink to the production repo's
  unrelated issue numbers (ADR-0022).
- **Never tags, commits, or pushes — in any mode.** Default is report-only
  (`{version, tag_candidate, previous, changelog, commitCount, applied: false}`,
  repository untouched); `--apply` prepends the sanitized section to
  `CHANGELOG.md` as a working-tree edit only (`applied: true`).

**The authoritative-tag guard:** when `.verity/promotion.json` declares
`split_active: true`, `release cut` refuses to mint authoritative `vX.Y.Z`
tags (exit `20`, with a message pointing at `release prepare` and the
promotion flow); `release cut --dry-run` still returns the computation. With
the file absent the guard is inert and `release cut` behaves exactly as
before — existing consumers are unaffected. A malformed `promotion.json` is a
hard error (exit `20`), never a silently disarmed guard.

---

## A typical lifecycle

```
vision → architect → plan → build → review → test → security → docs
       → ship → verify → golive → sre
```

`/verity:map` is available at any point. You don't have to run every role on every
project — Verity tracks dependencies, so `/verity:next` (and each role on completion)
points you at what can run next. `/verity:deploy-setup` (where your apps ship) and
`/verity:autonomy-setup` (how the worker runs) are one-time (or when-things-change)
setup helpers, run independently of any single project's lifecycle.

## See also

- [Overview](verity-overview.html) — what Verity is and the mental model
- [Usage](verity-usage.html) — install + command-by-command recipes
- [Flows](verity-flows.html) — new project vs. existing project, side by side
- [Framework spec](framework-spec.md) · [Roles spec](roles-spec.md) — full architecture and rationale
