---
name: verity:review
description: Reviewer/Integrator — adversarially review a stage's PR against source, then merge. The integration gate.
argument-hint: "<stage-number> [pr-number]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - AskUserQuestion
---
<objective>
Run the Reviewer/Integrator for stage $ARGUMENTS. You did NOT write this code — adopt
a skeptical stance. With branch protection often unavailable, your approval +
confirmed-green CI IS the integration gate. Verify against SOURCE, then merge.
</objective>

<process>
1. Load the pre-declared checklist (acceptance conditions + frozen contracts):
   ```bash
   verity review checklist $ARGUMENTS
   ```

2. Confirm CI is actually green for the PR (the floor — do not proceed on red):
   ```bash
   verity state stage $ARGUMENTS      # status should be in-review (CI green)
   ```

3. **Review against the ACTUAL diff/source — never the PR description.** For each
   acceptance condition, security invariant, and touched contract, verify it in the
   real code (Read/Grep the diff). Build a claim → checked → pass/fail verdict.

4. Scope/quality: stayed within the stage, no contract drift, no secrets committed,
   additive migration, kill-switch default-off, UI-smoke asset present.

5. Verdict:
   - **APPROVE** → merge (squash + delete-branch; the issue auto-closes via `Closes #N`):
     ```bash
     verity review merge <pr-number>
     ```
     `merge` refuses if CI is not green. Use `--assume-green` only if you have
     independently confirmed the checks.
   - **REQUEST CHANGES** → hand back to /verity:build with specifics.
   - **ESCALATE** (contract/architecture concern) → round-trip through /verity:plan
     (new/amended contract + ADR); never edit a frozen contract from here.

6. After merge, merges accrue on `main`. Do NOT deploy — the Release/Deploy Operator
   decides when to cut a release.

Headless mode (running under `verity agent-exec`, no human present): you have NO
merge tool — merge authority belongs to the worker's deterministic trust ladder,
never to you. Do NOT attempt `verity review merge` or `gh pr merge`. Instead:
post your findings as a PR comment (`gh pr comment`), then report your verdict in
the result marker's artifacts as `"verdict": "approve"` or
`"verdict": "request_changes"`, with the PR number, e.g.:
`{"verity":1,"outcome":"success","gate":null,"artifacts":{"pr":114,"verdict":"approve"},"reason":"checklist green"}`
The worker merges (or gates for a human) based on that verdict and the trust policy.
</process>
