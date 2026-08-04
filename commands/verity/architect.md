---
name: verity:architect
description: Architect — design the stack & topology, freeze contracts, write ADRs, offer drop-in features, own the walking skeleton.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<objective>
Run the Architect role: turn the locked identity + vision into a technical design —
tech stack, service topology, frozen interface contracts, and the walking-skeleton
plan — recording every major decision as an ADR and offering the drop-in feature
catalog. Treat design guides as RECOMMENDATIONS, not mandates.

Produces: ADRs (docs/adr/), frozen contracts (contracts/), accepted feature list,
and the walking-skeleton definition handed to /verity:plan.
</objective>

<process>
1. Load context: `verity identity get`. Review the relevant design guides —
   ```bash
   verity guides list
   verity guides show <id>
   ```
   Use them to inform, not dictate. Propose viable alternatives where they fit.

2. Decide the **tech stack** and **service topology** (monolith / modular-monolith /
   multi-service). Remember: each service multiplies the CI matrix, image set, and
   deploy surface; the slug extends per-service (`<image_prefix>-<service>`).
   Record each significant choice as an ADR (guide said X → alternatives → chose Y, why):
   ```bash
   verity adr new "Choose <stack/topology decision>"
   ```
   Then fill in Context / Decision / Alternatives considered / Consequences.

3. **Choose the deployment target.** Read the user's global catalog of where they can
   deploy, and pick a target for THIS app — never assume one (don't reach for a host
   just because its MCP/CLI happens to be installed):
   ```bash
   verity deployment list      # ~/.verity/deployment-methods.md (locations, not secrets)
   ```
   - Work with the user to choose a method; record the choice as an ADR.
   - If `hasConfigured` is false (only the shipped examples remain), ASK how they want
     to deploy and offer suggestions (managed PaaS, a VM over SSH, a local/LAN server…),
     then help them add it — either inline with `verity deployment edit`, or by pointing
     them at **`/verity:deploy-setup`**, the dedicated interview that builds the catalog.
   - Set up the per-app access file (committed pointer + gitignore — no secrets in git):
     ```bash
     verity deployment init-access
     ```
     Then WRITE `.verity/deploy-access.md` with how to reach this app's host —
     credential **locations** only (key files, SSO profiles, secret-store entries),
     never raw secrets. That file is gitignored and shared out-of-band; teammates who
     lack it are pointed at the project admin. The Release/Deploy Operator (`/verity:ship`)
     consumes this target when it builds `deploy.sh`.

4. **Freeze the core contracts** (wire/JWT/schema between components) — additive-only
   thereafter; a breaking change is a NEW contract, never an edit:
   ```bash
   verity contract new <seam-name>
   ```

5. Offer the **drop-in feature catalog**. For each feature the user wants, note that
   its stages will fold into the plan:
   ```bash
   verity feature list
   verity feature show <id>
   ```

6. Define the **walking skeleton** (Stage 0): the thinnest end-to-end slice that
   compiles, runs, passes one real test, goes green in CI, and deploys. This blocks
   all feature stages and proves the spine.

7. Hand off to **/verity:plan** (Intake/Planner) to decompose the design + accepted
   features into the initial thin backlog of stages.
</process>
