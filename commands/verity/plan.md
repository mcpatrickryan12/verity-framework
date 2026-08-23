---
name: verity:plan
description: Intake/Planner — the only place stages are born. Assess a request, write the stage spec + work-item, hand to the builder.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<objective>
Run the Intake/Planner: turn the architecture (Mode A — initial thin backlog) or a
single request (Mode B — the recurring stream front door) into stage specs. This is
the ONLY place stages are born. Reads intent; writes intent (specs/contracts/
assessments) — never mutable progress.

Produces: stage-instructions/stage-N-*.md, a new contract if a seam is introduced,
a feature-assessment, and a linked GitHub work-item.
</objective>

<process>
1. Load context:
   ```bash
   verity identity get
   verity stage list        # existing stages
   verity contract list     # frozen contracts (must not break)
   verity feature list      # drop-in catalog
   ```
   Read the architecture/ADRs (`docs/adr/`) and any vision doc.

2. Capture the request: a GitHub feature-issue, a `docs/handoff/` brief, a user ask,
   or a catalog feature (`verity feature show <id>`).

3. **VERIFY AGAINST THE LIVE CODEBASE** (mandatory anti-hallucination step). Build a
   claim/reality table — confirm the request's assumptions hold against actual source
   before planning. Do not build on false premises.

4. Impact + contract-safety analysis. Does it need a NEW contract, or threaten a
   frozen one? Default additive.
   - New seam → `verity contract new <name>`.
   - Architecture-affecting → `verity adr new "<decision>"` + confirm-gate with the user.

5. Decide: ACCEPT as a stage / SPLIT into several / DEFER / REJECT.

6. Write the stage spec (acceptance conditions are pre-filled by type — kill-switch +
   UI-smoke for features, regression test for bugs, exit-state for chores):
   ```bash
   verity stage new "<title>" --type feature|bug|chore [--depends-on N,M]
   ```
   Fill Objectives / What to build / Interface contracts. Record the reasoning in
   `feature-assessments/<slug>-assessment.md` (and an ADR if the decision is architectural).

7. Register the work-item for traceability (issue ↔ stage ↔ future PR) **if you have GitHub
   access** — use the suggested title/labels from `stage new`:
   ```bash
   gh issue create --title "[stage N] <title>" --label <type> --body "...refs stage N..."
   ```
   Attach a Milestone-per-release; apply an intake claim if multiple agents are active.

   > IMPORTANT (ADR-0026, #176/#185): work-item registration is WORKER-OWNED and NON-FATAL.
   > If `gh` is unavailable — e.g. under Codex containment, where `gh issue create` is denied
   > by design — that is EXPECTED, not an error: DO NOT retry it, DO NOT treat it as a failure,
   > and DO NOT fail the plan over it. Report the plan as SUCCESS once your stage
   > specs/contract/assessment exist on disk; the worker deterministically and idempotently
   > reconciles your `stage-instructions/` files into `[stage N]` issues after the plan role
   > returns. When you DO have `gh` access (e.g. Claude), running the command above is fine —
   > the worker reconcile is idempotent and will not duplicate.

8. Hand the stage instruction + contracts to the Stage Manager (/verity:build).

**Mode A (initial decomposition) — plan ONLY the first buildable slice, not the
whole architecture.** Run steps 3–7 as a batch over the architecture, but bound
the output: emit the **first buildable slice — typically 3–5 dependency-ordered
stages, skeleton-first** (a bootable app skeleton as an early stage). Do this **even
when the spec or architecture implies many stages (e.g. an "8–12 stage build")** —
that sizing is the *eventual* backlog, NOT the *first* plan. Do not decompose the
entire architecture in one run.

> Do NOT plan a stage whose build writes CI workflows (`.github/workflows/`). That
> path is containment-protected — a contained build role (Codex tier-2) cannot write
> it, so the merge-back gate REJECTS the whole build and the stage strikes to
> needs-human (ADR-0011). The CI test gate is **scaffold-provided infrastructure, not
> a build stage** (issue #203); the walking-skeleton stage boots the app and adds
> app-level tests, but never `.github/`.

Why (internalize this, don't just obey it): decomposing everything upfront (a)
exhausts this run's turn/token budget and front-loads decisions that later,
already-built stages will inform, and (b) is unnecessary — after the current slice
merges you re-plan the next slice via **Mode B** (the recurring intake), reading the
now-real codebase. Incremental decomposition is the framework's decided model
(ADR-0025: "a THIN initial backlog, not a giant upfront plan"), not a shortcut: a
thin first slice keeps every plan run well within budget, so it never thrashes and
retries. Read the full architecture + ADRs to *choose* the first slice; only the
*output* is bounded.

Note: `verity state`/Gantt views arrive with the state-derivation engine (Ledger);
until then, `verity stage list` + GitHub (issues/PRs/tags) are the source of progress.
</process>
