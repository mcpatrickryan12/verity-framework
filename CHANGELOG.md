# Changelog

## 1.2.0

### Features
- finalize — prod-side tag and Release from a merged promotion PR (stage 44, refs dev#107) (dev#121)

### Chores
- pre-promotion cleanup — README links only public paths, CONTRIBUTING for the no-code-PRs model (stage 45, refs dev#107) (dev#122)
- Phase 2 executed — record prod_repo in promotion config (refs dev#107)
- record v1.1.0 runtime truth (STATUS.md + .verity/runtime.json)

### Other
- [stage 43] verity promotion propose: the promotion PR into prod with provenance records (dev#120)
- plan(stages 43-45): promotion propose/finalize + pre-promotion doc cleanup — specs, ADR-0023, promotion-records contract v1 (refs dev#107)
- docs(split): O1 resolved — dev repo renamed to verity-dev; baseline tagged and mirrored (refs dev#107)
- [stage 42] verity release prepare: sanitized untagged dev-side release computation and the authoritative-tag guard (dev#116)
- plan(stage-42): release prepare + tag guard + changelog sanitizer — spec, ADR-0022, assessment (refs dev#107)
- [stage 41] verity promotion verify: staging-tree proof and the v1.1.0 npm byte-match (dev#114)
- docs: Verity Console vision & scoping — separate repo + engine-side operator contract
- [stage 40] verity promotion project: the fail-closed projection builder over the classification (dev#113)
- plan(stages 40-41): dev/prod split Phase 1 — projection builder + verify lane; freeze production-projection contract v1 (refs dev#107)
- [stage 39] Dev/prod split Phase 0: cutover inventory, production content classification, and authority ADRs (dev#110)
- docs(adr): record not-adding knowing; rescope the re-entry condition
- plan(stage-39): dev/prod split Phase 0 — cutover inventory, classification, authority ADRs — spec + assessment (refs dev#107)
- [stage 38] The usage-ledger commit must carry its own bot author identity so it succeeds in CI (dev#108)
- plan(stage-38): usage-ledger commit author identity — spec + assessment (fixes dev#3)
- [stage 13] Codex documentation: host matrix, quickstart, preview wording (dev#105)
- docs(canary): run-6b — N1 verified fixed on the live worker (stage 37)
- [stage 37] The unknown-cost gate must announce on the just-opened PR when a stage has no work-item issue (dev#100)
- plan(stage-37): unknown-cost gate PR-target fallback — spec + assessment (fixes N1/dev#98)
- docs(canary): run-6 headless Codex results — run-5 fixes validated on live worker; finding N1
- [stage 36] A review escalate verdict parks for a human, distinct from request_changes (dev#97)
- plan(stage-36): escalate verdict routing — spec, assessment, source proposal
- [stage 35] The copied engine must be self-contained: no package.json reads above the engine root (dev#95)
- [stage 33] A deferred daily refusal must not hang on the search index: the P1 pick needs a non-search fallback (dev#94)
- [stage 32] A refused run must not consume the approval or strip the gate announcement (dev#93)
- [stage 34] verity state and next must honor --repo and GH_REPO: finish the pointed-at-repo threading (dev#90)
- [stage 30] A run that dispatches nothing must record a verified zero cost on every exit path (dev#89)
- [stage 31] The unknown-cost gate must be resumable: approval consumes the parked result, not a fresh dispatch (dev#88)
- docs(adr): ADR-0014 accepted — operator confirmed via stage-31 build invocation
- docs(intake): stages 30-35 — six defects from canary run 5
- [stage 29] Missing git remotes must refuse as git-unprovidable, and the circuit breaker must honor --repo (dev#81)
- [stage 28] the scanner must say when it skips self-authored requests, and single-account operation must be documented (dev#80)
- [stage 27] verity:needs-human must park a stage everywhere, and a parked gate must not starve the queue (dev#79)
- [stage 26] The unenforceable-policy refusal must actually fire on the worker dispatch path (dev#78)
- [stage 25] A failed unknown-cost run must not wedge the day breaker (dev#71) (dev#77)
- [stage 24] Sandboxed roles can complete: Verity performs GitHub outside the sandbox (dev#76)
- docs(adr): ADR-0013 accepted — operator confirmed via stage-24 build invocation
- docs(intake): stages 24-29 — six defects from the canary §4 re-run
- [stage 22] The ci:unverified gate must be visible on GitHub, not only on stdout (dev#69)
- [stage 21] The unknown-cost gate must be approvable — the startup breaker cannot outrank its own approval (dev#68)
- [stage 23] verity state must read the repository it was pointed at (dev#67)
- docs(intake): stage 23 — verity state must read the repository it was pointed at
- [stage 20] Ledger must not fail open: an unreachable GitHub is not an empty one (dev#65)
- docs(intake): stages 20-22 — three defects from canary run 3
- [stage 19] No-CI must not read as CI-red; stop the worker livelock on build (dev#57)
- [stage 18] Unknown cost must never read as $0 — honest aggregation, a breaker that cannot be fooled (dev#56)
- docs(canary): record run 2 — the ADR-0012 git lifecycle, proven and bounded
- docs(intake): stages 18 & 19 — two guardrail defects from the real canary
- [stage 17] Verity-performed stage lifecycle git for the codex path (dev#48)
- docs(intake): stage 17 — Verity-performed stage lifecycle git for the codex path
- docs(adr): ADR-0012 — model edits files, Verity performs git (issue dev#46)
- docs(canary): committed real-CLI canary evidence for codex-cli 0.146.0
- [stage 16] Make the real-CLI canary executable (dev#40, dev#42, dev#43) (dev#45)
- docs(intake): stage 16 — make the real-CLI canary executable
- [stage 15] Unbreak codex headless: drop --output-schema, honest error text, no dangling path (dev#39)
- docs(intake): stage 15 — unbreak the codex headless path (canary P0)
- [stage 12] Feature-derived Codex version pin, doctor features, opt-in real-CLI lane (dev#33)
- [stage 14] Codex containment tier 2 — disposable shaped workspace + gated merge-back (dev#32)
- [stage 11] Codex tier-1 containment: strip credentials, enforce invariants, refuse unenforceable policy (dev#31)
- docs(intake): re-scope stage 11 to containment tier 1; stage 14 = tier 2
- docs(adr): ADR-0011 — Codex enforcement is containment, not restriction
- docs(spike): Codex enforcement spike vs real CLI 0.146.0 — stage-11 hard gate
- [stage 10] Codex CLI contract alignment: real flags, item.type parser, output-schema (dev#24)
- docs(intake): stages 10-13 — Codex real-CLI remediation (ADR-0010 arc)
- docs(adr): ADR-0010 — Codex enforcement layers (external readiness review accepted)

All notable changes to **verity-framework** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions 0.3.x were developed in the `verity-auto` incubator fork (forked at
`0.2.2`, reunified in `0.4.0`). See [docs/whats-different.md](docs/whats-different.md)
for the autonomy layer those versions added.

## [Unreleased]

### Added

- **`verity promotion finalize <version>` — prod-side tag and release from a
  merged promotion PR** (stage 44, dev#107 Phase 3). Completes the
  `promotion-records` v1 lifecycle after the promotion PR merges in prod — the
  only place authoritative `vX.Y.Z` tags are born post-split (ADR-0019).
  Requires a PROM record with status `proposed` (a `released` record refuses;
  finalize is not repeatable) and a **MERGED** promotion PR (an open PR
  refuses naming the review/merge step). **Verifies before tagging** (contract
  rule): the merged tree's `RELEASE-MANIFEST.json` must match the PROM record
  field-for-field (version + every digest) and `npm pack` of the merged tree
  must reproduce the record's `package_shasum` — any mismatch aborts with exit
  20, tags nothing, record untouched. Then: annotated tag `v<version>` on the
  merge commit pushed to prod, GitHub Release with a sanitized body embedding
  the manifest, and the PROM record completed (`released`,
  production.commit/tag, finalized_at) in a `chore(promotion)` dev commit. The
  dev repo is never tagged (test-asserted). **npm publish is deliberately NOT
  executed** (open decision O4: publish auth) — finalize prints the exact
  manual publish instruction with the expected tarball shasum and records
  `published: pending-O4`. `docs/commands.md` now carries the end-to-end
  release runbook (prepare → project → verify → propose → review/merge in
  prod → finalize → manual publish).
- **`verity promotion propose <version> --staging <dir>` — the promotion PR
  into prod with provenance records** (stage 43, dev#107 Phase 3). Turns a
  **verified** projection into an open promotion PR in the production repo:
  the tree is *constructed, never merged* — the new projection verbatim plus
  prod-HEAD files matching the new `prod_owned` globs in
  `.verity/promotion.json` (additive schema field; a projected path matching a
  prod-owned glob fails closed naming the path, and deletions fall out
  naturally). Writes both records of the new frozen `promotion-records` v1
  contract — the public `RELEASE-MANIFEST.json` at the tree root and the
  private `.verity/promotions/PROM-####.yml` (status `proposed`, committed to
  the dev branch) — with every digest/shasum **copied from the projection
  report, never recomputed**. Preconditions fail closed (exit 20): passing
  `verify` block required, semver strictly above prod's latest tag,
  `prod_repo` configured. One sanitized commit `Promote Verity
  v<version> (dev@<sha12>)` on a `promote/v<version>` branch (no shared
  history with dev, no dev names/URLs in manifest, commit, or PR body);
  `--dry-run` stops after tree construction + manifest and pushes nothing. No
  tag, no merge, no npm action anywhere in this verb — those are `finalize`
  and human authority.
- **`verity release prepare` — the dev-side release computation after the
  split** (stage 42, dev#107, ADR-0022). Computes the next version and
  changelog section via the exact derivation `release cut` uses (one shared
  internal, so the two verbs can never disagree), with the section emitted
  **already sanitized** (`#NN` → `dev#NN`, plain text GitHub does not
  autolink) and **no tag, no commit, no push in any mode**. Default is
  report-only (`{version, tag_candidate, previous, changelog, commitCount,
  applied: false}`, repository untouched); `--apply` prepends the sanitized
  section to `CHANGELOG.md` as a working-tree edit only. The sanitizer is its
  own pure module (`verity/bin/lib/changelog-sanitize.cjs`, reused by Phase 2's
  propose/finalize): it rewrites only provably-bare prose refs — URLs,
  markdown link targets, code spans, HTML entities, and existing `dev#NN`
  forms are untouched, and spans it cannot prove safe are left byte-identical
  and reported. A one-time historical pass sanitized the existing CHANGELOG in
  its own mechanically-reviewable commit.
- **The authoritative-tag guard in `release cut`**, driven by the new dev-side
  state file `.verity/promotion.json` (schema 1: `split_active`, `prod_repo` —
  additive growth for Phase 2). With `split_active: true` — committed here,
  because after the split authoritative `vX.Y.Z` tags are minted in prod via
  the promotion flow — `cut` refuses before any side effect (exit 20, message
  pointing at `release prepare`); `release cut --dry-run` still returns the
  computation. Kill-switch shape: absent file = guard inert, `cut`
  byte-identical to before (every existing Verity consumer unaffected); a
  malformed or wrong-schema file is a hard error (exit 20) — the guard is
  never silently off.

### Documentation

- **knowing integration — recorded the decision not to add knowing at this
  time**, and rescoped the re-entry condition. The old trigger (a CommonJS
  extractor upstream) aimed at the wrong target — Verity's own engine being
  `.cjs` says nothing about whether knowing helps a role work in a large
  codebase it did not write. A re-spike is now gated on upstream fixing the
  scale-independent defects (crash recovery, terminating `fsck`, non-silent
  `test_scope`) and must target a genuinely large brownfield repo. Amended
  `docs/adr/0001-*.md`, `docs/dev/knowing-spike-report.md` (new §10), and the
  feature assessment. No code change — the optional `knowing` row in
  `verity doctor` stays as-is.

- **Codex support is now documented end-to-end: host matrix, quickstart, and
  honest autonomy limits** (stage 13, ADR-0009/ADR-0011). A new user can install,
  diagnose, invoke, and understand the *limits* of Codex without reading source:
  - **README** — the opening support statement now names **Codex CLI** (was only
    Claude Code + OpenCode); a new **host matrix** (Claude Code / Codex / OpenCode)
    lists each host's install flag, interactive syntax (`/verity:vision` vs
    `$verity-vision` vs `/verity-vision`), and headless/autonomy status. The stale
    "Interactive use only for now" line is gone — Codex headless
    (`verity agent-exec <role> --agent codex`) and local autonomy exist behind
    explicit opt-in.
  - **QUICKSTART** — a **Codex CLI** section: `verity install --codex` →
    `verity doctor --agent codex` → `$verity-vision`; a supervised
    `.verity/autonomy.yml` example using the shipped schema keys
    (`mode: supervised`, `review.trust: 0`, `agent.provider: codex`,
    `acknowledged_enforcement_gaps: [network]`); a `verity doctor --agent codex`
    troubleshooting table (missing / too-old / unauthenticated / skills / engine);
    and the explicit Actions boundary.
  - **Honest wording (ADR-0011):** the docs describe Verity-owned **containment**
    (absent credentials + post-run invariants + opt-in tier-2 disposable
    workspace), never Codex enforcing role policy — `codex exec` ignores
    permission profiles. Supervised codex autonomy is documented as **supported**;
    unattended (`mode: autonomous`) as **opt-in tier-2, default off** (refused
    below tier 2); GitHub Actions autonomy for Codex as **deferred, local only**
    (ADR-0009 — never reuse local ChatGPT/Codex auth in Actions).

- **Sandboxed roles can complete: Verity performs GitHub reads and verdict
  posting outside the sandbox** (stage 24, ADR-0013 — the canary §4 re-run
  release blocker). Under the tier-1 network-disabled sandbox no codex role
  could complete: review's own `gh pr comment` died on the network (honest
  failure, strike 1) and build's first act — an in-sandbox `verity state`
  read — refused fail-closed (stage 20's correct behavior surfacing the real
  design gap). Per ADR-0013, *a role computes; Verity talks to GitHub* — the
  sandbox is NOT widened (rejected alternative, ADR-0011):
  - **Pre-dispatch state snapshot:** for a contained dispatch the worker asks
    `verity next` to attach the facts the role's workflow needs (stage status,
    the unblocked list, dependency/PR/CI state — additive `facts` field, only
    when asked), derived from the *same verified snapshot* as the decision
    itself, so stage 20 stays binding by construction. They travel to
    `agent-exec` as `--state-snapshot` (rejected for claude — never a silently
    ignored knob) and render as the option-keyed `verityPerformsGitHub`
    preamble + `<github-state-snapshot>` block; `build.md`/`review.md` now tell
    contained runs to read the snapshot instead of running `verity state`/`gh`.
  - **Post-dispatch result effects:** the T05 marker's `artifacts` gains the
    additive, **default-closed** `effects` channel (absent = nothing
    performed). Recognized: `findings_comment` — the review findings body,
    posted on the PR by the worker with the run id (mirroring ADR-0012's
    attributable commits). Unrecognized effect requests are ignored with a
    logged note — never executed, never fatal. Merge authority is not an
    effect: the trust ladder remains the only merge path.
  - Claude/uncontained dispatches are byte-identical; frozen contracts
    (agent-result v1, role-capability-policy v1) untouched — the marker's
    `artifacts` object was always free-form, exactly like `artifacts.verdict`.

- **The `unknown-cost` gate is now actually approvable — the startup breaker no
  longer outranks its own approval** (stage 21, issue dev#58). Two correct
  guardrails deadlocked: a run whose cost came back unknown paused at the
  `unknown-cost` gate and posted the `approve:` instruction, but stage 18's
  daily breaker refused at startup (exit 30 `unknown-cost-budget`) *before* the
  P1 approved-resume path ran — so approving was a no-op, and because
  `max_usd_per_day` defaults to 25.0 this fired on the **default** policy:
  every codex worker wedged permanently after its first run (canary run 3).
  ADR-0008 prices `gate` at *one human approval per run*; the fix makes that
  approval mean what the comment says:
  - **usage.csv records the gate a run ended paused at** (new additive `gate`
    column, run-level, stamped on every row; 9- and 11-column ledgers keep
    parsing with `gate` read as empty). This is what lets the *local, read-only*
    startup check distinguish unknown-cost runs that already asked a human from
    unknown spend that slipped through ungated — without costing a gh call.
  - **`checkDailyLimits` marks the refusal `approvable: true`** only when
    behavior is `gate` and *every* unverifiable run today ended parked at the
    `unknown-cost` gate (fail closed: one unstamped row, or behavior `fail`,
    and nothing changes). It still never answers ok.
  - **The worker defers an approvable refusal past the scan**: a P1 item —
    one carrying the single-use `verity:approved` the gate comment asked for —
    proceeds, consuming the token as any P1 resume does, so the next
    unverifiable run gates again; anything else refuses with stage 18's exact
    failure, still before any lock, label, or comment.
  - **Consent is recorded, not implied**: the approved run's §7 summary carries
    a `budget:` line naming the consumed approval and its single-run scope, and
    startup logs the consumption to stderr.
  - Unchanged, and covered by tests: a *verified* overspend still trips plain
    `daily-limit` (never maskable by approval), `allow_with_token_limit` keeps
    its inert-by-consent note, unknown cost still never aggregates as $0, and
    the claude path — which reports real costs — is untouched.

- **`verity state` now reads the repository it was pointed at** (stage 23,
  issue dev#64). `--cwd` was honoured by the FILE half of the derivation
  (`readStages`) and silently ignored by the GITHUB half: the ledger's `gh`
  shell-out passed no `cwd`, so `gh` resolved the repository from the *process's*
  working directory. Run from anywhere else, `verity state` answered with the
  **current** repository's issues and PRs projected onto the **target**
  repository's stages — confidently, at exit 0, with no warning:

  ```
  $ cd ~/vcc3 && verity state stage 1 --cwd ~/vcc3
    { "status": "building", "issue": 1, "pr": 2 }        # correct
  $ cd ~/projects/verity-framework && verity state stage 1 --cwd ~/vcc3
    { "status": "planned", "issue": null, "pr": null }   # WRONG
  ```

  Same confident-falsehood family as issue dev#60 below, with a far likelier
  trigger — it needs no outage, only the flag — and stage 20 does **not** catch
  it: the read *succeeds*, so the snapshot is stamped `verified` and is
  nevertheless about the wrong repository.
  - **`cwd` is threaded from `fetchSnapshot` through `ghJson` to the shell-out**,
    so issues, PRs and the `online`/repo probe all resolve against the target
    (the `git tag` read already passed `-C <cwd>`). Audited as a single-site
    omission: `gh.cjs` and `review.cjs` always passed one.
  - **An unresolvable target now fails closed** through stage 20's refusal
    instead of answering from the invoking repository — previously a `--cwd` at
    a directory that is not a repository (or does not exist) produced a
    *verified* snapshot of a repository nobody asked about. A missing target
    directory reports the new `no-target-dir` reason rather than
    `gh-not-installed`; the two look identical at the syscall (both `ENOENT`)
    and only one of them means "reinstall gh".
  - **A guard, not a comment**: `tests/ledger-cwd.test.cjs` runs two distinct
    fixture repositories and asserts every `gh` invocation the ledger makes
    resolved from the target directory, so a future read added without a `cwd`
    fails the suite. No existing test could have caught this, because every one
    of them invokes the CLI from the directory it is testing. Same-directory
    invocation is asserted byte-identical.

- **An unreachable GitHub no longer reads as a confident empty state** (stage
  20, issue dev#60 — the root cause of canary run 3's chain stall). The ledger's
  `gh` shell-out did `catch { return null }` with stderr explicitly discarded,
  and every caller turned that null into `[]`. So "could not look" became
  "looked, and there is nothing": `verity state stage 1` reported
  `{"status":"planned","issue":null,"pr":null}` — **at exit 0, with an empty
  stderr** — for a stage that had an open issue and an open PR. A wrong answer
  indistinguishable from a true one is worse than a failure, because every
  consumer believes it: the `review` role was told "no PR or linked issue
  exists" while PR dev#2 was open, could not review, failed twice, and burned a
  no-progress strike.
  - **The snapshot now records whether it was observed.** `fetchSnapshot()`
    stamps `verified` and lists a `{ source, reason, detail }` for each failed
    read; a read that failed is `null`, never `[]`. **A partial answer counts as
    unverified** — issues without PRs derives a stage that has "no PR", which is
    the same falsehood in half.
  - **`verity state` refuses** (exit 30, nothing on stdout, the reason on
    stderr) rather than answer from a snapshot nobody observed. Chosen over an
    explicit `unknown` status because this is the boundary a human and a role
    read, and there is no partial answer here a caller cannot misread.
  - **`verity next` gates at `state:unverified`** (exit 10), checked before
    every other reading — following stage 19's precedent that unknown is its own
    state, never folded into a confident value. Deliberately not `idle`: idle
    asserts Verity looked and found no work. There is no opt-out knob, and
    `limits.unverified_ci_behavior` cannot turn an unread snapshot into work.
  - **The worker never dispatches against unverified state** — it stops as
    `infra` (exit 30) before the model run, and refuses at startup with slug
    `state-unverified` instead of reporting `idle`, because on a cron worker an
    idle exit 0 reads as "all quiet". Not the GATE_PAUSE path: labeling and
    commenting would write to the very API that just failed.
  - **The diagnostic survives; the credential does not.** Failures are
    classified as `auth` / `network` / `rate-limit` / `no-repo` /
    `gh-not-installed` / `http-<code>`, and `gh`'s stderr line travels with them
    with GitHub token shapes and `Authorization`/`Bearer`/`token` values
    redacted before anything is printed, logged, or posted. The full consumer
    audit is in [docs/autonomy.md](docs/autonomy.md#unreadable-state).
  - The one snapshot assertion that pinned the old behavior
    (`tests/next-snapshot.test.cjs`, "offline degrades to all-planned") was
    pinning the *defect*; it now asserts the refusal, and the change is written
    down in the test rather than regenerated in silence. Every online assertion
    in that file is byte-identical.

- **"No CI" no longer reads as "CI red", and the worker no longer livelocks on
  `build`** (stage 19, issue dev#50 — found by the 2026-07-31 canary). A pull
  request's check rollup was collapsed into a boolean, so an EMPTY check set
  returned `false`: a repository with no CI configured was indistinguishable
  from one whose CI is failing. The stage could never leave `building`, every
  tick answered it with `role: build`, and each tick spent a full model run
  getting nowhere — `test` and `review` were unreachable. Two consecutive
  `--once` ticks on the canary both dispatched `build` on stage 1.
  - **CI now has three readings, not two** — `green` (checks reported, all
    acceptable), `red` (checks reported, at least one failing or pending), and
    `unknown` (**no checks reported at all** — Verity cannot verify the PR in
    either direction). `ledger.rollupState()` produces them; the snapshot
    carries `ciState` alongside the legacy `ciGreen` boolean, derived from it so
    the two can never drift.
  - **Unknown is never green.** Reading an empty check set as green would be
    strictly worse than the bug, because the worker would then merge on CI
    nobody ran. Every call site decides explicitly and the audit is written
    down in [docs/autonomy.md](docs/autonomy.md#unverified-ci): the merge gates
    (`trust.checksGreen`/`decideMerge`, `review.canMerge`) stay boolean and
    unchanged — the only question a merge gate may ask is "did Verity *verify*
    this is green?" — while the dispatch decision, where a model run is
    actually spent, is the one place the third state is used.
  - **`verity next` gates at `ci:unverified`** when a PR reports no checks,
    taking the worker's ordinary GATE_PAUSE path: label, comment, `⏸️ gated`
    summary, exit 0. Nothing new is duplicated and nothing merges on unverified
    CI. Approving the gate consents for that one run — the stage advances to
    `review`, and the merge is still gated on a verified-green reading.
  - **`verity review merge` names the real problem** on such a PR ("CI is
    UNVERIFIED — GitHub reports no checks at all for it") instead of sending
    the operator hunting for a failing check that does not exist. It refuses
    exactly as before.
  - **A no-progress stop condition**, because a never-advancing loop that
    spends a model run per tick is a defect in its own right even when CI is
    genuinely red. If the worker is about to dispatch the same role at the same
    GitHub target for the third time in a row — counted across ticks from its
    own append-only §7 run-summary comments on the item, plus within the
    current tick — it refuses BEFORE dispatching, labels `verity:needs-human`,
    and exits 20 with `no progress: …`. Two identical dispatches are still
    allowed, so a role keeps its retry. The §4.3 lock/unlock comment formats
    are untouched.
  - An idle tick that is idle *because* something is gated now says so, instead
    of reporting a bare "no eligible work".

### Added

- **`verity promotion verify <staging-dir>`** (stage 41, dev#107 Phase 1) — proves
  a projection is a working product, not just a filtered tree, extending the
  frozen `production-projection` contract v1 report **additively** (a `verify`
  block; `project` fields untouched). Offline, always: the staged tree's own
  quality gates run from scratch with the staging dir as cwd — `npm ci` from
  the projected lockfile (downgrade to `npm install` only for a structural
  reason, reported explicitly), `npm run lint`, `npm test`, `npm pack` — plus a
  pack-content inspection proving every tarball entry exists in the staging
  tree and none resolves `private`/`generated` under the classification.
  Network, opt-in (`--baseline <version>` + `VERITY_PROMOTION_BASELINE_TEST=1`,
  the house network-lane pattern): byte-compare the packed tarball against the
  published npm artifact; without the env flag the baseline is skipped
  *loudly*, never silently passed. Exit codes: 0 gates pass (and baseline
  matches when run) / 20 gate failure or mismatch / 30 infra. **Phase 1 exit
  criterion closed:** `promotion project v1.1.0` → `promotion verify
  --baseline 1.1.0` reproduces the published `verity-framework@1.1.0` tarball
  byte-for-byte (`dist.shasum 02d01b07…`, transcript in
  `docs/dev/dev-prod-split/stage-41-smoke.md`). Prerequisite folded in: the two
  dev doc-drift gates (`tests/codex-features.test.cjs`,
  `tests/canary-role.test.cjs`) are now classified `private` — they read
  private `docs/dev/` files and prove dev hygiene, not the product; they still
  run in the dev repo. Inert unless invoked.

- **`verity promotion project <ref>`** (stage 40, dev#107 Phase 1) — the
  fail-closed dev→prod projection builder over the production content
  classification, implementing the frozen `production-projection` contract v1
  (`contracts/production-projection.md`). Exports the source *tree* at a ref
  (never the working tree), copies exactly the `public`-classified paths into a
  fresh empty staging dir, counts (never copies) `private`/`generated`, and
  emits a deterministic `staging_digest` plus a projection report JSON (written
  even on failure). Unclassified paths, ambiguous classification ties, a
  missing/unparsable classification, or a secret-scan hit on staged content
  abort the run — under no failure mode is the whole tree copied, no
  half-usable staging tree is left behind, and secret values never appear in
  reports (path + pattern name only). Exit codes: 0 built / 20 contract
  violation / 30 infra. Read-only on the repository, and inert unless invoked.
  The classification matching semantics now live in ONE shared module
  (`verity/bin/lib/classification.cjs`) consumed by both the CI gate test and
  the engine — no second manifest file exists to drift.

- **`limits.unverified_ci_behavior`** (stage 19) — additive and
  **default-closed**, following `agent.acknowledged_enforcement_gaps` /
  `agent.containment_tier`: it has no `default` in the schema and is absent from
  the shipped defaults, so every existing policy behaves identically. Absence
  and `gate` pause at the `ci:unverified` human gate; `allow_without_merge` lets
  a repository that legitimately has no CI advance the stage to `review` instead
  of looping on `build`. Neither value can merge on unverified CI.

- **Verity-performed stage lifecycle git for the codex path** (stage 17,
  ADR-0012 — *the model edits files, Verity performs git*). Under Codex's
  `workspace-write` sandbox git READS work but git WRITES do not (`checkout -b`
  and `commit` both return rc=128 "Read-only file system"), so a codex role
  could not produce a branch, a commit, or a PR at all — the 0.146.0 canary
  failed at exactly that point. Roles never ran raw git; the Verity CLI they
  delegate to was shelling git *inside* the model's execution context, and that
  is the defect this closes. **Codex path only** — claude keeps performing its
  own git, and its rendered prompts, result object and coordinator path are
  byte-identical (the render golden fixtures are unchanged).
  - **Verity creates the stage branch before dispatch**, in its own process, in
    the real checkout. The branch name is derived by the same `stage.cjs` code
    the interactive `verity stage branch` uses, so it is the same branch a human
    would create. A re-dispatch of the same stage re-uses it rather than failing
    on "already exists".
  - **The fork point is resolved explicitly, never "whatever HEAD is".** A new
    branch forks from `refs/remotes/origin/HEAD` (the repository's own record of
    its default branch), else from the ref the checkout was already on provided
    that is not itself a stage branch, else the run is REFUSED. Branching off
    HEAD would make stage N+1 fork off stage N's branch and ship the previous
    stage's commits inside its own PR — green CI, wrong diff. The chosen base
    and how it was decided travel in the result as `git_lifecycle.base` /
    `base_from`.
  - **The operator's checkout is put back.** The ref the run started on is
    restored on every exit path — success, failure, timeout, refusal — so a
    dispatch is not a silent relocation onto a stage branch. Where the role's
    uncommitted work would be overwritten by the switch back, Verity leaves the
    checkout on the stage branch and says so (`git-restore-failed` on stderr)
    rather than forcing it: a failed role's output is exactly what a human needs
    to debug, and it is never discarded to tidy up.
  - **Verity commits, pushes, and opens the PR** after a *successful* run
    (`agents/git-lifecycle.cjs`, provider-neutral — a driver opts in by
    declaring the hooks; only codex does today). The change source follows the
    containment tier: at **tier 2** the gated ACCEPTED set from the merge-back
    (never a wider `git add -A`), at **tier 1** the working-tree paths whose
    status differs from a snapshot taken just before dispatch, so pre-existing
    dirt is excluded by construction. The commit message is deterministic and
    attributable — `[stage N] <role>: role-produced file changes` plus
    `Verity-Role:` / `Verity-Stage:` / `Verity-Run-Id:` trailers.
  - **Never an empty commit.** A run that produced no changes commits nothing,
    pushes nothing, opens no PR, and says so in the result. A
    containment-REJECTED or failed run never reaches the commit at all.
  - **The role is told the truth.** A new OPTION-KEYED preamble block
    (`preamble-verity-git.md.tmpl`, default OFF, set only by the codex driver's
    headless render for runs that really have a branch) states that the branch
    already exists, that git is Verity's job, and that the role should simply
    make its file changes. Every install path and every host's golden render is
    unchanged.
  - **`git_write` projection + capability honesty** (ADR-0011's rule applied to
    a GRANT rather than a restriction, new `PROVIDED_CAPABILITIES` map): under
    codex `git_write` means "Verity performs git on this role's behalf". If that
    cannot be provided — not a repository, unborn HEAD, no committer identity,
    no `origin` to push to — the run is REFUSED before the model is invoked
    (exit 30 `git-unprovidable`) instead of finishing with no history while
    reporting success. A push or PR that Verity promised and could not deliver
    fails the run loudly.
  - New **additive OPTIONAL** result field `git_lifecycle` (branch, whether
    Verity created it, commit, committed paths, pushed, PR, reason, error) plus
    the opened PR in the frozen `artifacts.pr` the worker already reads. No
    contract change: `agent-result` v1 and `role-capability-policy` v1 are
    untouched — only the mechanism by which `git_write` is honoured changes.
  - **We do NOT grant the model `.git` write access.** ADR-0012 records that it
    works and REJECTS it (unreachable from `codex exec`, and it would hand the
    model the ref-mutation authority the trust ladder exists to withhold); a
    test pins the escape hatch shut. `docs/dev/codex-headless-canary.md` §4 is
    rewritten to check that the branch/commit/PR were produced by **Verity** and
    that the model never wrote `.git`.
- **Codex tier-2 containment** (stage 14, ADR-0011 — the containment level
  required before any UNATTENDED codex autonomy). Enforcement moves from write
  time, where `codex exec` gives Verity no hook at all, to **propagation
  time**, which Verity fully owns. **Opt-in and default OFF**; codex remains
  explicit opt-in throughout.
  - **Disposable shaped workspace** (`agents/workspace.cjs`, provider-neutral —
    any driver can opt in by declaring the hooks; only codex does today). Each
    role run gets a throwaway `git worktree --detach` of HEAD, sparse-shaped so
    the paths the role may not touch (`.github/**`, `.verity/**`, unless it
    holds `write_protected_paths`) are **physically absent** — "cannot modify
    `.github/**`" becomes a topological fact rather than a permission check.
    `--cd` points at it, it is sited under the Verity state root
    (`~/.verity/workspaces/<run-id>/<role>`) and never under `/tmp` (which is
    writable from inside the Codex sandbox — spike F5), and it is disposed on
    success AND failure, retained only under the explicit `--keep-workspace`
    debug flag. Where the workspace cannot be materialized (no repository, no
    HEAD) the run is REFUSED (exit 30 `workspace-unavailable`) rather than
    silently degraded to the real checkout.
  - **Gated merge-back (the teeth).** Deterministic Verity code — never the
    model — computes the workspace's changed-path set and accepts only what the
    role's declared writable set covers. Anything else (a protected path, a new
    top-level dotfile, a path escaping the workspace root, any change at all
    from a read-only role) is REJECTED: a loud run failure naming the offending
    paths and their reasons, with `containment_rejected` in the result and
    **nothing propagated** — all-or-nothing, never a silent drop. Accepted
    changes are applied deterministically as file copies/deletions and named in
    the result as `containment_merged`, so the outcome is an ordinary reviewable
    diff attributable to the role that made it.
  - **Tier gating.** The worker REFUSES unattended codex autonomy
    (`mode: autonomous` with `agent.provider: codex`) below tier 2 — exit 30
    `containment-tier-required`, before any `gh` call, scan, label, or lock.
    Supervised/trust-0 still runs at tier 1 per ADR-0011. The active tier is
    visible in every codex result as `containment_tier`.
  - New **additive, default-absent** autonomy knob `agent.containment_tier`
    (absence = tier 1, the fail-closed state) and the matching
    `verity agent-exec --containment-tier 1|2` / `--keep-workspace` flags.
    Claude rejects both — it has no containment tiers, its write-time
    restriction being enforced by its own harness allowlist — and every
    pre-stage-14 policy dispatches byte-identically at tier 1.
  - **Known, documented limitation:** the workspace is derived from HEAD and
    merge-back propagates FILE CHANGES only, so a commit the role makes inside
    the workspace does not propagate and uncommitted work in the real checkout
    is not visible to the role. This is why tier 2 ships dark and why
    `docs/dev/codex-headless-canary.md` §5 must pass on the real binary before
    unattended codex autonomy is enabled.
- **Codex tier-1 containment** (stage 11, ADR-0011 — enforcement that binds,
  replacing a projection that provably bound nothing):
  - **Credential stripping.** The Codex child environment is now CONSTRUCTED
    from an enumerated passlist (`codex.cjs childEnv`) instead of inherited:
    before this stage `execute()` passed no `env` to `spawnSync`, so the model
    received every credential the caller held. `GH_TOKEN`/`GITHUB_TOKEN` are
    present only with the `github_write` capability, cloud/registry
    credentials only with `deploy`; everything else is dropped by
    construction. Claude's child still inherits its environment — unchanged.
  - **Mandatory post-run invariants** (`agents/invariants.cjs`, provider-
    neutral, driven by the existing coordinator seam): a pre-run snapshot of
    the protected roots (`.github/**`, `.verity/**`), the ref list, and the
    worktree status is diffed after every codex role. A protected-path
    mutation, a ref movement without `git_write`, or any write by a role with
    an empty writable set is REVERTED where safe (created files deleted,
    modified files restored byte-for-byte) and turns the run into a loud
    failure with the violations in the result — never a silent pass.
  - **Capability honesty rule, fail closed** (`agents/policy.cjs`): every
    restriction a role declares maps to the mechanism that enforces it. A
    restriction with no mechanism — today `network: false`, which `codex exec`
    cannot enforce — refuses the run with exit 30 `unenforceable-policy`
    unless the operator acknowledges the gap through the new **additive,
    default-absent** `agent.acknowledged_enforcement_gaps` autonomy knob (or
    `verity agent-exec --acknowledge-gaps`). An applied acknowledgement is
    visible in the result as `enforcement_gaps_acknowledged`; claude rejects
    the knob (its restrictions are enforced by its own harness allowlist).
  - Every test that asserts a denial now writes a **liveness marker** in the
    same invocation and treats a missing marker as an INVALID TEST (issue dev#28
    — the spike's false "DENIED ✓" readings came from commands that never ran).

- **Feature-derived Codex version pin** (stage 12). `verity.codexMinVersion`
  moves from the historical, untraceable **0.42.0** to **0.146.0**, and it is
  now *derived* rather than typed.
  - New **required-feature matrix** (`verity/bin/lib/agents/codex-features.cjs`,
    rendered as `docs/dev/codex-feature-matrix.md`): one row per Codex feature
    the headless driver depends on, each either VERIFIED — traceable to a
    command that really ran against a real CLI, cited to the finding that
    recorded it — or UNVERIFIED. Unverified rows contribute nothing to the pin.
    Today's only real-CLI evidence is
    `docs/dev/codex-enforcement-spike-0.146.0.md`, run against codex-cli
    0.146.0 and only that release, so `exec --json`, the coarse `--sandbox`
    workspace-root boundary, `-c approval_policy="never"`,
    `--ignore-user-config`, `codex login status` and `codex --version` are
    verified AT 0.146.0, while `--output-last-message`, `--output-schema` and
    `--ignore-rules` are listed as required-but-unverified rather than assumed.
    (Stage 15 moved `--output-schema` to the new **incompatible** status — the
    real API rejects our schema — so it is no longer a required feature at all;
    see Fixed.)
  - The pin is **conservative by evidence, not a claim that older releases are
    broken**: the spike never bisected backwards, so every row's *first
    supporting release* is recorded as unknown. Lowering one needs a canary run
    on an older release, not a guess. (0.138.0, floated by an external review
    as a managed-permission-profile datum, is explicitly recorded as a
    NON-datum — it is not about the `exec` path and Verity never observed it.)
  - Tests pin the pin: `codexMinVersion` must equal the matrix's highest
    verified row, a verified row must cite the spike, no row may claim a first
    supporting release, and the doc table must list every code row — so the
    number, the evidence and the documentation cannot drift apart.
- **`verity doctor --agent codex` explains the minimum** (stage 12): the
  too-old diagnosis now names the required feature(s) the pin is derived from
  and points at the evidence, instead of quoting a number nobody could audit.
  The distinct diagnoses (missing / too-old / unauthenticated / skills-missing
  / engine-missing / stale-state) and their remediation commands are unchanged,
  and rows without a motivation (claude, knowing, git, gh) stay byte-identical.
  The driver's own `version-too-old` error carries the same rationale.
- **Opt-in real-Codex test lane** (stage 12, `tests/real-codex.test.cjs`):
  `VERITY_REAL_CODEX_TEST=1 node scripts/run-tests.cjs` runs the stage-11
  containment negatives (credential absence, protected-path invariants,
  capability honesty) plus the stage-14 tier-2 negative and a read-only
  positive against a REAL Codex binary. Default CI stays stub-based and the
  lane prints every case as **SKIPPED** — visibly skipped, never silently
  passed, because a stub-verified external contract is not evidence
  (ADR-0011). Every negative carries a liveness marker (issue dev#28).
- **Canary evidence template**
  (`docs/dev/codex-headless-canary-results-TEMPLATE.md`, stage 12): the capture
  set a real-CLI canary run must record — OS/WSL, node/npm/verity/codex
  versions, auth MODE (never credentials), effective policy, sanitized argv,
  per-case pass/fail/INVALID table, limitations and the readiness decision.
  The results file itself is human-produced and is not part of this change.

### Removed

- **The Codex enforcement projection that enforced nothing** (stage 11,
  ADR-0011): `commandRules()`, the per-role denial document written to the run
  log dir, and its `-c` delivery are deleted — the key was not one Codex
  defines (unknown `-c` keys are silently absorbed) and execpolicy cannot match
  the `/bin/bash -lc '<cmd>'` form Codex runs commands as. The capability
  tables survive as policy DATA for the mechanisms that do bind. Codex remains
  explicit opt-in preview; tier 2 (disposable shaped workspace + gated
  merge-back) is still required before any UNATTENDED codex autonomy.

### Changed

- **Pre-promotion doc cleanup: README private-link repair + CONTRIBUTING for
  the no-code-PRs model** (stage 45, dev#107 Phase 3 prep). README no longer
  links any path the classification excludes from the production repo — such
  links 404 there. The rendered HTML guide bullets (overview/usage/flows +
  `.drawio`) are replaced by the authoritative public markdown docs, the
  deploy-kit pointer is repointed at the shipped `/verity:autonomy-setup`
  role, and the friction-kit, explainer-kit, brand, and walking-skeleton
  pointers moved to a dev-only doc. A permanent CI gate
  (`tests/readme-public-links.test.cjs`) now fails any future README edit
  whose relative link target is missing or not public-classified, via the
  shared classification matcher. CONTRIBUTING.md is rewritten for the split
  model: issues are welcome on the production repository (the public front
  door); code contributions do not land there via pull requests — source
  changes travel through the development repository and arrive as promoted
  releases carrying `RELEASE-MANIFEST.json` provenance. Local setup, test,
  and lint instructions stay: they serve anyone running the public tree.

### Fixed

- **Unknown cost was summed as `$0`, so the daily budget breaker could not
  trip** (stage 18, issue dev#51, ADR-0008 — found by the 2026-07-31 canary run,
  not by CI). ADR-0008's rule is that `est_usd` is `number | null` and *`null`
  means unknown — writing `0` for unknown cost is a contract violation, because
  zero means free and the budget breaker believes it*. The ledger honoured it
  (an unknown cost has always been written as an EMPTY cell); the aggregation
  layer did not, coercing that cell back to `0`. Over two real Codex runs
  `verity usage` reported `est_usd=0.00` and `checkDailyLimits` cleared a
  `max_usd_per_day` of `0.01`. **An operator who set a spend ceiling on codex
  autonomy did not have one.** This is a safety fix, not a cosmetic one.
  - **Aggregation no longer conflates unknown with zero.** A row with an empty
    `est_usd` cell now reads as `null`, and rollups keep two separate facts:
    `est_usd` is the **verified** spend (only rows that reported a cost), while
    `unknown_cost_runs` / `unknown_cost_rows` count what could not be verified.
    `--by-role` groups carry `unknown_cost_rows` too. A non-empty unparsable
    cell is still a malformed row — "unknown" was not widened to mean "corrupt".
  - **`verity usage` stops printing a confident `$0.00`.** With unverifiable
    runs in the window the one-liner reads
    `est_usd=0.00+unknown unknown_cost_runs=2`, and `--json` carries the same
    counts. With nothing unknown — every Claude ledger — the output is
    byte-identical to before.
  - **The breaker refuses to be fooled.** When `max_usd_per_day` is set and
    today's window holds unknown-cost runs, `checkDailyLimits` no longer answers
    "ok" on the strength of a total it knows is incomplete. It resolves through
    ADR-0008's existing `limits.unknown_cost_behavior` knob: `gate` (the
    default) and `fail` refuse the start with its own slug —
    `verity-worker: 30 unknown-cost-budget: …`, naming how many runs were
    unverifiable — while `allow_with_token_limit` starts and logs that the USD
    breaker is inert **by consent**, rather than reporting a total that looks
    verified. Genuine overspend still reports plain `daily-limit`: the verified
    portion is checked first.
  - `usage.csv` is unchanged — no new column, existing and pre-stage-3 rows
    parse exactly as before. Proven unaffected on the Claude path by a
    claude-only ledger test asserting byte-identical totals and both limit
    messages.

- **Tier-2 containment was unprovable against the real CLI by any available
  means** (stage 16, issues dev#40/dev#42/dev#43 — found by the canary re-run on
  codex-cli 0.146.0, not by CI). Both paths to proving the guarantee that gates
  unattended codex autonomy were broken: the automated lane could not
  authenticate and the manual path could not drive an adversarial action. This
  adds NO capability — it makes the guarantees Verity already claims
  *checkable*.
  - **The real-Codex lane could never authenticate** (dev#40). It redirected
    `HOME` to a `mkdtemp` dir, and Codex auth lives under the home root, so all
    5 cases failed `agent-unauthenticated` on ANY machine — a check that cannot
    pass reading as safety, for the third time in this arc. The lane is
    explicitly a real-binary lane, so it now passes the developer's real Codex
    auth ROOT (`$CODEX_HOME`, default `$HOME/.codex`) through to the child while
    the repo, workspace, and `HOME` stay temporary and disposable. Credential
    CONTENTS are never read, logged, or copied — a path is passed and Codex's
    own `login status` stays the oracle. When auth is unavailable the lane fails
    with one loud `REAL-CODEX LANE PRECONDITION FAILED` naming the auth root and
    the remedy: distinguishable from both the gate-off skip and a pass, because
    a canary that cannot authenticate proves nothing.
  - **The capability-honesty refusal was masked by the auth probe** (dev#42).
    `checkVersion` (which shells out to `codex login status`) ran BEFORE
    `checkEnforceable`, so codex was invoked ahead of a pure-policy refusal
    specified to precede it and `unenforceable-policy` came back as
    `agent-unauthenticated`. `dispatch` now loads the role policy and runs the
    honesty gate — both filesystem-only — before the binary/auth preflight. A
    restriction Verity cannot enforce is not an auth question, and the refusal
    now holds with no usable binary at all. The preflight is unchanged and still
    runs, just after: a role whose policy is fine fails `agent-missing` /
    `version-too-old` / `agent-unauthenticated` exactly as before. Deliberate
    consequence, newly pinned: when the permission surface AND the binary are
    both broken, the deny-by-default answer wins (`missing-allowlist` for
    claude, `missing-policy`/`unenforceable-policy` for codex).
  - **Adversarial canary paths were not drivable** (dev#43). No packaged role
    executes its arguments — all 15 carry their own governing prompt — so a
    tier-2 adversarial attempt through `build` produced `turn.completed`, 2 tool
    calls, and "the requested stage does not exist… no files were changed": the
    model never ATTEMPTED the writes, so nothing propagated because nothing was
    tried. That is INCONCLUSIVE, not a denial. Verity now ships **one** canary
    role, `commands/canary/canary-exec`, whose prompt is "do exactly what the
    arguments say, then stop". It changes what the model is ASKED to do, never
    what it is ALLOWED to do: its policy grants `read_repository` +
    `write_repository` and nothing else (no `git_write`, no `github_write`, no
    `deploy`, no `write_protected_paths`, `network: false`), uses only the
    frozen v1 capability vocabulary, and stays subject to every ADR-0011
    containment layer. It is a **sibling** of the workflow corpus, not a member
    of it: no adapter installs it, `/skills` still lists exactly the 15
    `verity-*` skills, it appears in no user-facing doc, and it is reachable
    only by naming it explicitly on `verity agent-exec`.
  - `docs/dev/codex-headless-canary.md` §3/§5 are rewritten around the canary
    role with copy-pasteable invocations, and gain the binding **ATTEMPT RULE**:
    a run where the model declined to attempt the adversarial action is
    **INCONCLUSIVE** and must be re-driven — never recorded as a denial. That is
    the issue-dev#28 liveness rule one level up: liveness proves the command ran;
    this proves the action was tried.
  - **Not itself the evidence.** dev#40 and dev#43 are only *proven* by a real canary
    run (the human/quota-gated step on dev#22). This stage restores the ability to
    run it.

- **The codex headless path ran 0% of the time against the real CLI** (stage
  15, issues dev#34/dev#35/dev#36/dev#37 — P0, found by the first real canary run on
  codex-cli 0.146.0 while CI was green on 567 stub-backed tests).
  - **`--output-schema` is no longer emitted** (dev#34, the P0). Stage 10 wired it
    as a "belt" on top of `validateRoleOutcome`; the real API rejects the
    schema behind it — `schemas/agent-result.schema.json` uses `allOf`, and the
    response is HTTP 400 `invalid_json_schema: … 'allOf' is not permitted`,
    which ended every run at `turn.failed` with zero tokens and zero tool
    calls. An A/B on the real binary isolated the flag as the sole cause. The
    schema itself is **kept** as the published contract artifact it always was
    (it documents the structured role-outcome shape and mirrors
    `validateRoleOutcome`); it is simply never handed to the CLI. Result
    handling returns to the proven path — the `--output-last-message` file
    parsed as structured JSON when present, else the RESULT_CONTRACT marker —
    and no validation weakens: Verity's own `validateRoleOutcome` was always
    the trust boundary. A flattened, `allOf`-free CLI-side schema is a deferred
    follow-up.
  - **Provider failures are legible again** (dev#35). `normalizeResult` surfaced
    the first *physical* line of the provider's message, so a pretty-printed
    JSON error emitted `error: "{"` — the defect breaking every run reported
    itself as a lone brace. A JSON failure message now surfaces its meaningful
    field (`.error.message`, else `.message`, unwrapped through a
    message-in-a-message), and anything else collapses to one bounded line. A
    lone punctuation character is never emitted, and messages that were already
    one legible line are unchanged.
  - **No dangling artifact path** (dev#36). `final_message_path` was computed
    before the run could have written the file, so every failed run advertised
    a `<role>.final.json` that did not exist. Codex annotations are now applied
    *after* the run and the field is emitted only when the file is really
    there — explicitly permitted by `contracts/agent-result.md` v1, which lists
    it among the additive OPTIONAL fields whose absence consumers must
    tolerate. `transcript_path` is unchanged (it was always accurate), and
    claude's result stays byte-identical (it declares no annotations).
  - **The canary's read-only liveness check was unsatisfiable** (dev#37).
    `docs/dev/codex-headless-canary.md` §2 demanded the model write a liveness
    marker under `--sandbox read-only`, where it cannot write anywhere — the
    box could never honestly be ticked. For a read-only run the liveness proof
    is now the retained transcript showing the turn executed (`turn.completed`,
    or an `item.completed` `agent_message`): the write must fail AND the
    transcript must prove the run happened, else the case is INVALID. The
    liveness rule's intent (issue dev#28) is unchanged everywhere else.
  - **Feature-matrix truth.** The `--output-schema` row moves from
    *unverified* to **verified INCOMPATIBLE at 0.146.0** — a new status for a
    feature a real CLI/API rejected and the driver therefore does not emit. It
    is no longer a required feature, contributes nothing to the pin (which
    still equals the verified floor, 0.146.0), and the row survives precisely
    so the flag cannot quietly come back.

- **Codex usage detail dropped a field the real CLI actually sends** (issue
  dev#29, stage 12, spike F7). A real `turn.completed` event carries
  `cache_write_input_tokens` and **no** `total_tokens`; `normalizeUsage`'s
  `usage_detail` allowlist carried neither expectation, so the cache-write
  count was silently discarded on every real run. It is now carried, with
  `total_tokens` still accepted where a shape provides it (the allowlist copies
  only what is present, so nothing is zero-filled or invented). The headline
  `tokens.in` / `tokens.out` — and every budget decision built on them — are
  unchanged.

- **Codex CLI contract alignment** (stage 10, ADR-0010, CDX-002/003/004/006 —
  the four confirmed divergences from the documented real Codex CLI):
  - `buildArgv` now emits the documented `--ignore-user-config` flag instead
    of `-c ignore_user_config=true` (a nonexistent config key Codex silently
    absorbed → no user-config isolation); the `-c` spelling is
    regression-pinned to never return.
  - The policy's `ignore_rules` knob is actually delivered as the documented
    `--ignore-rules` flag (previously validated but never emitted — a no-op).
  - Transcript parsing (`parseTranscript`/`countToolCalls`) discriminates
    items by the real `item.type` field, with `item.item_type` kept as an
    explicitly-tested legacy fallback (`itemKind()`); tool counts and the
    last-agent-message fallback now work on real Codex JSONL.
  - `--output-schema` passed the packaged `schemas/agent-result.schema.json`
    (package-root resolved, ships in the npm tarball) so Codex would validate
    its final output shape; Verity's independent `validateRoleOutcome` remained
    the unchanged trust boundary. **Reverted in stage 15 (dev#34, above): the real
    API rejects that schema and the flag broke every run.** Never released —
    both stages land in this same unreleased block.

## [1.1.0] — 2026-07-29

### Added

- **Portable role policy, agent-aware doctor, worker provider selection**
  (stage 9, ADR-0005/0007/0008/0009 — the complete LOCAL-Codex autonomy
  surface; GitHub Actions for Codex stays deferred per ADR-0009 until its
  credential boundary ships):
  - `.verity/autonomy.yml` gains an additive `agent` block — `provider`
    (`claude|codex`, default `claude`: every pre-existing policy stays valid
    and Claude-backed; codex autonomy is an explicit policy edit), `model`,
    codex-only `sandbox`/`approval` overrides that may only NARROW a role's
    `.permissions.json` projection (widening refuses execution, exit 30 —
    `agents/policy.cjs applyOverrides`), `ignore_user_config`,
    `ignore_rules`. No unrestricted-access value is representable anywhere
    in the schema (ADR-0007).
  - `limits.unknown_cost_behavior: gate | allow_with_token_limit | fail`
    (default `gate`, ADR-0008): a role reporting unknown cost (`est_usd`
    null — never $0, and never counted against the daily budget breaker)
    pauses the run at the `unknown-cost` human gate by default, stops it
    under `fail`, or proceeds bounded by token ceilings alone.
  - The worker resolves ONE immutable effective agent config per run and
    passes it into every chained `agent-exec` dispatch: provider, model,
    sandbox/approval overrides, and the REMAINING wall-clock budget as a
    hard `--timeout-secs` subprocess deadline that shrinks monotonically
    across chained roles (also closing the latent hung-Claude gap). All
    existing guardrails are unchanged: manual-mode exit, kill switch, human
    gates, forced golive gate, trust ladder, protected paths,
    chained-role/runs-per-day/token limits, identity checks, deterministic
    merges.
  - `verity doctor --agent claude|codex` — runtime-selective preflight
    (a Codex-only machine can be green). Selection precedence without the
    flag: explicit `--agent` → `.verity/autonomy.yml` `agent.provider` →
    install-state `harness` → the legacy claude default, with the chosen
    runtime and its source printed on stderr. Codex checks: git, gh + auth,
    `codex --version` vs `verity.codexMinVersion`, `codex login status`,
    verity-* skill discovery under `~/.agents/skills`, the engine fallback
    path, and stale install state — every distinct failure diagnosis
    carries a remediation command.
  - ADR-0007 enforcement proof: the codex driver generates a per-invocation
    command-rules document from the role's `.permissions.json`
    (`codex.cjs commandRules` → `<role>.rules.json` in the run log dir,
    delivered as `-c rules_file=…`; the spelling is stub-pinned and
    canary-re-verified) — repo-root-only writable roots, always-denied
    credential reads and `gh pr merge` (merge authority is the worker's,
    never a role's), capability-derived deploy/git/gh denials, and
    protected-path (`.github/**`, `.verity/**`) write denials gated on the
    NEW additive capability key `write_protected_paths` (default false;
    granted to `autonomy-setup` only). The five negative tests
    (tests/enforcement.test.cjs) prove a restricted role cannot write
    outside the repo, read credentials, deploy, touch protected paths, or
    bypass a gate via `gh pr merge`/`verity release` — real-binary
    variants are the canary lane (docs/dev/codex-headless-canary.md).
  - `schemas/role-permissions.schema.json` — the published contract
    artifact for `<role>.permissions.json`, mirroring `agents/policy.cjs`
    exactly (contracts/role-capability-policy.md v1, additive only).
  - Optional additive knobs on `agent-exec`: `--model` (both drivers,
    omitted-in — Claude's argv is byte-identical without it) and
    `--sandbox`/`--approval` (capability-policy providers only; rejected
    with a clear error under `--agent claude`).
  - `autonomy-setup` role now offers the runtime choice (Claude Code /
    Codex CLI) and, for Codex, gathers only what Verity needs: local
    worker (Actions deferred, ADR-0009), model override, auth strategy
    (validated via `verity doctor --agent codex`, never a secret in a
    tracked file), trust level, and unknown-cost behavior.
  - Pipeline exit proof: a supervised trust-0 worker run under
    `agent.provider: codex` in a throwaway repo — plan → build → gated at
    review with no merge — runs in CI against the stub
    (tests/worker.test.cjs) and as the real-Codex supervised canary
    (docs/dev/codex-headless-canary.md §4).

- **Headless Codex executor path** (stage 8, ADR-0005/0007/0008):
  `verity agent-exec <role> [args] --run-id <id> --agent codex` executes a
  role non-interactively through the Codex CLI and emits the same normalized
  `contracts/agent-result.md` v1 object the worker already consumes (additive
  optional fields: `provider`, `timed_out`, `transcript_path`,
  `final_message_path`, `usage_detail`). New pieces:
  `verity/bin/lib/agents/codex.cjs` (driver: `VERITY_CODEX_BIN` →
  `VERITY_AGENT_BIN` → `codex`; version gate against the NEW package.json key
  `verity.codexMinVersion`; auth via `codex login status` — credential files
  are never read; invocation `codex exec --json --sandbox <from policy>
  --output-last-message <file> --cd <repo root> -` with the prompt over
  stdin, approval policy `never` and user-config isolation passed
  explicitly); `verity/bin/lib/agents/policy.cjs` + a
  `commands/verity/<role>.permissions.json` for all 15 roles
  (contracts/role-capability-policy.md v1 — fail closed: missing/invalid
  policy or `danger-full-access` refuses execution with exit 30, no fallback
  sandbox; `map` is `read-only`, everything else `workspace-write`;
  `.tools.json` untouched and still governs Claude);
  `schemas/agent-result.schema.json` (the structured role-outcome shape a
  Codex final message is validated against, hand-rolled zero-dep validator);
  provider-neutral `--timeout-secs N` on `agent-exec` (both drivers: kills
  the child on expiry, keeps the partial transcript, normalizes to a failure
  with `timed_out: true` — never a success). `--max-turns` with
  `--agent codex` is rejected with a usage error (ADR-0008 — never silently
  ignored); Codex `est_usd` is always `null` (unknown ≠ $0). Transcripts land
  at `~/.verity/logs/<run-id>/<role>.codex.jsonl` + `<role>.final.json`.
  **Dark-launched**: the default agent remains `claude`, codex runs only on
  an explicit `--agent codex`, and the worker cannot select it (autonomy
  schema unchanged — worker provider selection is stage 9). Claude headless
  behavior is byte-identical (stage 7 characterization suite green,
  generalized into a both-drivers provider-contract suite). Release canary:
  the documented manual check in `docs/dev/codex-headless-canary.md`
  (flag-spelling verification on the pinned Codex release + `npm pack`
  install + one real `agent-exec plan --agent codex` in a throwaway repo) —
  CI proves the path by stub only.
- **Interactive Codex support** (stage 6, ADR-0005/0006): `verity install
  --codex` renders all 15 canonical roles through the ADR-0002 pipeline into
  user-scoped Codex skills (`~/.agents/skills/verity-<role>/SKILL.md` +
  `agents/openai.yaml` with implicit invocation disabled) and copies the
  engine to `~/.agents/verity`. Roles are invoked explicitly:
  `$verity-vision`, `$verity-plan ISSUE-123`, … Harness flags
  (`--claude`/`--opencode`/`--codex`) are now mutually exclusive, and
  `verity install --codex --dry-run` prints the full install plan without
  writing. **Interactive only** — headless Codex execution
  (`agent-exec --agent codex`), worker selection, and GitHub Actions support
  are staged separately (ADR-0009) and are NOT part of this change. Release
  canary: after install, verify Codex lists the skills with `/skills`.

### Changed

- **Provider-driver seam** (stage 7, ADR-0005, chore — no intended behavior
  change): the entire Claude wire implementation moved out of
  `verity/bin/lib/agent-exec.cjs` into `verity/bin/lib/agents/` (`index.cjs`
  registry with `getProvider`/`listProviders`, `claude.cjs` driver,
  `result-contract.cjs` — the frozen `contracts/agent-result.md` v1 builder).
  `agent-exec` is now a runtime-neutral coordinator containing zero provider
  argv construction or event parsing, protected by a characterization suite
  written against the pre-refactor behavior (`tests/agents.test.cjs`). New:
  `VERITY_CLAUDE_BIN` provider-specific binary override — precedence is
  explicit flag (none yet) → `VERITY_CLAUDE_BIN` → legacy `VERITY_AGENT_BIN`
  (preserved) → `claude`. Cosmetic: the unsupported `--agent` error now names
  the registry's provider list.

## [1.0.1] — 2026-07-28

### Changed

- **Stage Executor lifetime is one stage** (ADR-0004). The role prompt now
  requires a **fresh executor per stage** — born at branch creation, dead at
  merge — and states that contracts are re-read from `contracts/`, never
  recalled. Resuming the executor *within* its own stage stays correct and
  unrestricted (red-CI loop, acceptance kick-back, a Reviewer's
  REQUEST-CHANGES); the boundary it must never cross is the next stage.

  The specs described the executor as "isolated" with its "own context window"
  but never said how long it lives — which a long-lived executor resumed stage
  after stage satisfies. Observed in a real run: one reused executor was
  starting each build with 300k+ tokens of accumulated transcript by stage 27.
  The cost is quadratic in stage count, but the load-bearing reason is
  correctness: a resumed executor recalls contracts as they stood N stages ago,
  and unversioned in-context memory of a contract defeats the frozen-contract
  discipline. Prompt-enforced, not code-enforced.

  Affects `commands/verity/build.md` (ships in the package) plus
  `docs/roles-spec.md` and `docs/framework-spec.md` (repo-only — `docs/` is not
  in `files`, so npm consumers get the rule and the reasoning stays on GitHub).

### Known issues (1.0.x fast-follows)

- Carried from 1.0.0: dev#3 worker usage-ledger commit lacks git author identity in
  Actions; dev#5 gated items re-post identical audit comments every scheduled tick.
- The ADR-0004 detection signature (`build`-role `tokens_in` climbing stage over
  stage in `verity usage --by-role`) exists but has never been read against real
  data — no project has populated `.verity/usage.csv`, which is why this went
  unnoticed for 27 stages.

## [1.0.0] — 2026-07-27

Verity's 1.0 certifies a **demonstrated** system, per the release gates set on
2026-07-25: remote CI green on the published 0.4.0 line, and one real
supervised autonomy cycle run from the published npm package on GitHub
Actions — build → PR → review → trust-0 gate → human approval → merge
(canary: seanerama/verity-skeleton-demo, 2026-07-26/27).

### Fixed

- **scanner: P5 honors `verity:needs-human`** (dev#4, canary finding). The
  dependency-engine fallback re-selected escalated items every wake-up; P5 now
  fetches issue/pr target labels (stage targets are exempt — a stage number is
  not an issue number), drops escalated items, and fails CLOSED with an
  unconditional warn when the fetch errors.

### Changed

- Generated `verity-worker.yml` installs `verity-framework@^1`.

### Known issues (1.0.x fast-follows)

- dev#3 worker usage-ledger commit lacks git author identity in Actions.
- dev#5 gated items re-post identical audit comments every scheduled tick.


## [0.4.0] — 2026-07-25

### Changed

- **Reunified with verity-framework.** The `verity-auto` fork (0.3.x) merged back into
  the canonical repo and npm package `verity-framework`; the incubator repo is archived.
  The package keeps both binaries (`verity`, `verity-worker`); autonomy remains opt-in
  and off by default.
- The generated `verity-worker.yml` Actions workflow now installs the worker from npm
  (`npm i -g verity-framework@^0.4`) instead of the bot-token GitHub URL; the bot token
  no longer needs read access to a second repo.

### Added

- `verity doctor` — host-dependency preflight (git, gh + auth, claude + min version,
  optional deps) with `--quiet` exit-code mode (stage 1).
- Per-role usage telemetry: `usage.csv` gains `tool_calls`/`role` columns, one row per
  role invocation, `verity usage --by-role`; additive, legacy rows still parse (stage 3).
- Install-time role-prompt transform pipeline (ADR-0002): shared preambles rendered at
  install, `verity install --dry-run <role>`, idempotent installs (stage 2).
- knowing Phase 0 spike report (`docs/dev/knowing-spike-report.md`): **NO-GO** at
  Gate 0; ADRs 0001–0003 record the outcome (stage 4).

## [0.3.2] — 2026-06-13

### Added

- **Subscription auth for the headless worker.** `verity install --actions --auth subscription`
  scaffolds the workflow to authenticate the agent with `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) instead of `ANTHROPIC_API_KEY`, so the worker runs on a Claude
  Pro/Max plan's monthly Agent SDK credit rather than pay-per-token. `--auth api-key`
  remains the default. The `/verity:autonomy-setup` interview now asks which to use, and
  `docs/autonomy.md` documents the trade-off (the worker stops when the monthly credit is
  exhausted; never set both secrets — an API key overrides the subscription token).

## [0.3.1] — 2026-06-13

### Added

- **`/verity:deploy-setup`** role — a guided interview that asks where you deploy apps
  (AWS / GCP / Azure / self-hosted / managed PaaS / SSH / Kubernetes) and builds your
  global `~/.verity/deployment-methods.md` catalog (locations, never secrets). Complements
  the Architect, which chooses a target from the catalog per app.
- **`/verity:autonomy-setup`** role — the worker-deployment interview, promoted from a
  copy-paste kit to a first-class command installed by `verity install`. Asks how the
  headless worker should run (cron / Actions / manual, mode, bot identity, trust, budget)
  and generates `.verity/autonomy.yml`, the cron line and/or Actions workflow, bot + secrets
  checklists, and a `DEPLOYMENT.md`. (Previously documented as `/verity-autonomy-setup`, a
  command that was never actually registered.) Brings the role count to 15.

### Fixed

- **Actions driver installed the wrong package.** `verity install --actions` generated a
  workflow that ran `npm i -g verity-framework` — the upstream package, which has no
  `verity-worker`. It now installs verity-auto from GitHub using the bot token
  (`git+https://x-access-token:${VERITY_BOT_TOKEN}@github.com/seanerama/verity-auto.git`);
  the bot account must have read access to the verity-auto repo. (Deviates from the frozen
  SKETCH §6, which predates the fork.)
- **Flaky retry-backoff bound.** `gh` layer backoff used `Math.round`, which could round a
  near-1.0 jitter draw up to the excluded upper bound (e.g. 1500 for retry 2). Now `Math.floor`,
  keeping the result in the documented half-open `[base/2, base·1.5)` interval.

- Docs swept to install verity-auto from source (command reference + HTML guides).

## [0.3.0] — 2026-06-13

The **autonomy release**: the Verity roles can now run headlessly, driven by a worker, and
merge low-risk work under a deterministic trust ladder — all bot-attributed, comment-audited,
and priced. Autonomy ships **off by default** (`mode: manual`), and with it off, behavior is
byte-identical to verity-framework (guarded by a snapshot regression test).

### Added

- **`verity-worker`** — the headless orchestrator (`--repo owner/name --once`): startup
  checks → ranked work scan → GitHub-native lock → run loop (`verity next` → `agent-exec`) →
  human gate or summarize. Stateless and crash-safe between ticks.
- **`verity autonomy show | set | validate`** — policy in `.verity/autonomy.yml`
  (schema `schemas/autonomy.schema.json`); effective policy is defaults merged with the file;
  raising `review.trust` requires `--confirm` and records an ADR.
- **`verity agent-exec <role>`** — the single headless entry point to the AI assistant
  (Claude Code, `--allowed-tools` per role); pins Claude Code ≥ 2.1.170 (fails fast below it).
- **`verity usage [--days N] [--json]`** — rollups from the append-only run ledger
  `.verity/usage.csv`.
- **`verity install --actions`** — scaffolds the GitHub Actions worker driver
  (`.github/workflows/verity-worker.yml`); idempotent, `actionlint`-clean.
- **`verity install`** now also creates the eight `verity:*` GitHub labels (idempotently).
- **Trust ladder** — deterministic merge authority in the worker (trust 0 never merges,
  1 auto-merges only low-risk PRs by path/size/checks, 2 merges any approved + green PR). The
  review role has no merge-capable tool.
- **Per-role tool allowlists** (`commands/verity/<role>.tools.json`) — deny-by-default.
- **Scanner**, **lock protocol**, and a **shared `gh` layer** (retry/backoff, uniform logging).
- **Circuit breakers** — per-run limits (chained roles, tokens, wall clock), daily caps
  (USD, runs), a 2-strike `needs-human` rule, and the `verity:circuit-open` kill switch.
- **Onboarding tooling** — [`QUICKSTART.md`](QUICKSTART.md), the
  [`/verity:autonomy-setup`](docs/dev/deploy-kit/) deployment interview, and the
  [friction kit](docs/dev/friction-kit/) for documenting a first run.
- **Docs** — [Autonomy guide](docs/autonomy.md), [what's different](docs/whats-different.md),
  canary checklist, and the frozen specs under `docs/dev/`.

### Changed

- **Repo identity** — renamed the package to `verity-auto`; `homepage`/`repository`/`bugs`
  now point at `seanerama/verity-auto`; README retitled with a fork banner. The upstream
  public npm package `verity-framework` remains the hand-driven subset.

### Unchanged

- All 13 `/verity:*` roles, the CLI surface, and the deployment-methods catalog carry over
  from verity-framework. `mode: manual` is byte-identical to upstream.

## [0.2.2] — fork point

Baseline inherited from [verity-framework](https://github.com/seanerama/verity-framework)
0.2.2 (restructured README + privacy cleanup). History before the fork lives in that repo.

[1.0.1]: https://github.com/seanerama/verity-framework/releases/tag/v1.0.1
[1.0.0]: https://github.com/seanerama/verity-framework/releases/tag/v1.0.0
[0.4.0]: https://github.com/seanerama/verity-framework/releases/tag/v0.4.0
[0.3.2]: https://github.com/seanerama/verity-auto/releases/tag/v0.3.2
[0.3.1]: https://github.com/seanerama/verity-auto/releases/tag/v0.3.1
[0.3.0]: https://github.com/seanerama/verity-auto/releases/tag/v0.3.0
[0.2.2]: https://github.com/seanerama/verity-framework/releases/tag/v0.2.2
