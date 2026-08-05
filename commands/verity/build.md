---
name: verity:build
description: Stage Manager — build one stage in isolation, open a green PR, hand off to review. Never merges.
argument-hint: "<stage-number>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Task
  - AskUserQuestion
---
<objective>
Run the Stage Manager for stage $ARGUMENTS: orchestrate the build of one stage in an
isolated context, drive its PR to green CI, and hand off to the Reviewer. "Done" = a
green PR — this role NEVER merges (the builder must not merge its own work).
</objective>

<process>
1. Load the stage + confirm it is unblocked. If this prompt carries a
   Verity-rendered GitHub state snapshot (contained runs — ADR-0013), read the
   stage status, dependency state, and unblocked list from it instead of
   running these commands:
   ```bash
   verity state stage $ARGUMENTS      # status + depends-on
   verity state next                  # must include this stage (its deps are merged)
   ```
   If blocked, stop and report which dependency isn't merged yet.

2. Create the stage branch off current `main`:
   ```bash
   verity stage branch $ARGUMENTS
   ```

3. Delegate the implementation to an isolated **Stage Executor** sub-agent (Task tool).
   **Spawn a FRESH executor for this stage — never resume one from a previous stage**
   (ADR-0004). Its lifetime is this stage only: born here, dead at merge. Everything it
   needs is on disk; a resumed executor carries stale memories of contracts that later
   stages have since changed, and its context grows quadratically across the backlog.
   Pass it: the stage instruction file, the relevant frozen `contracts/`, and these rules:
   - implement the code respecting the frozen contracts — **read them from `contracts/`,
     never from memory** of an earlier stage;
   - write unit/integration/contract tests **+ the UI-smoke asset** if user-facing;
   - add the **kill-switch flag (default OFF)** if this is a net-new feature;
   - run the tests to green; work ONLY on the given branch — **no branch creation, no merge**;
   - return ONLY: files changed, test results, deviations, "new contract needed?" (should be none).
   Never paste file contents back.
   - **Runtime fallback:** if the harness has no sub-agent/Task support, implement inline.

4. Verify the executor's return against the stage's acceptance conditions
   (`verity review checklist $ARGUMENTS` shows them): kill-switch present for features,
   UI-smoke asset authored, additive migration only, contracts untouched. Breach → fix
   or re-intake via `/verity:plan`.

5. Push + open the PR (links the work-item; CI runs the full gate):
   ```bash
   verity stage pr $ARGUMENTS --issue <work-item-number>
   ```

6. Drive CI to green (**this stage's** executor fixes on the branch if red — resuming it
   within the stage is correct and unrestricted, including for a Reviewer's
   REQUEST-CHANGES; the boundary it must never cross is the next stage):
   ```bash
   verity state stage $ARGUMENTS      # status -> in-review when CI is green
   ```
   Contained runs cannot watch CI (the state snapshot is point-in-time):
   finish your file changes and report — Verity's own post-run checks are what
   verify CI, and the worker re-dispatches on red. **Done = PR open + CI all-green.**

7. Hand off to **/verity:review** for the merge. Do NOT merge.
</process>
