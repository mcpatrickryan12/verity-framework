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

7. Register the work-item for traceability (issue ↔ stage ↔ future PR). Use the
   suggested title/labels from `stage new`:
   ```bash
   gh issue create --title "[stage N] <title>" --label <type> --body "...refs stage N..."
   ```
   Attach a Milestone-per-release; apply an intake claim if multiple agents are active.

8. Hand the stage instruction + contracts to the Stage Manager (/verity:build).

Mode A (initial decomposition): run steps 3–7 as a batch over the architecture to
emit a THIN initial backlog (not a giant upfront plan), dependency-ordered.

Note: `verity state`/Gantt views arrive with the state-derivation engine (Ledger);
until then, `verity stage list` + GitHub (issues/PRs/tags) are the source of progress.
</process>
