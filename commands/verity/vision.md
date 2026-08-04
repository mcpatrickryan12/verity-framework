---
name: verity:vision
description: Vision — clarify the idea, lock the project identity, and scaffold the repo.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<objective>
Run the Vision role: turn an idea into a LOCKED project identity and a scaffolded
repo with an honest hygiene CI. (Walking-skeleton version: ideation is trimmed to
name + one-line description; the full vision document comes later.)

Produces: `.verity/identity.json` + the governance/hygiene file set, committed.
</objective>

<process>
1. Ask the user for a project **name**, a one-line **description**, and the
   **GitHub owner** (org or user) the repo will live under.

2. Propose a slug, then validate it and check availability:
   ```bash
   verity slug "<name>" --raw
   verity identity check <slug> --owner <owner>
   ```
   Surface any validation issues or name conflicts (npm / GitHub). Iterate with the
   user until the slug is valid and available — or they consciously accept a conflict.

3. Lock the identity (immutable — renaming later is a migration, not an edit):
   ```bash
   verity identity lock "<name>" <slug> --owner <owner>
   ```

4. Scaffold the repo from the locked manifest:
   ```bash
   verity scaffold init --description "<description>"
   ```

5. Initialize git and make the bootstrap commit (this one lands BEFORE any branch
   protection — the only commit that does, per framework-spec §3):
   ```bash
   git init && git add -A && git commit -m "Initial commit — scaffolded by Verity"
   ```

6. Report what happened and tell the user how to bring the pipeline online:
   ```bash
   gh repo create <owner>/<slug> --source=. --push
   ```
   Then watch the hygiene CI run and go green. That green pipeline on a fresh repo
   is the project's foundation — every later stage rides it.
</process>
