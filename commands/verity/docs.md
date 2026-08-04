---
name: verity:docs
description: Technical Writer — public/dev docs, handoff briefs, and the architecture narrative.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---
<objective>
Run the Technical Writer. Own the human-readable layer: public/developer docs, the
architecture narrative, and handoff briefs that let another agent pick up a feature
cold. (ADRs belong to the Architect; runtime truth/STATUS.md to the Operator; specs
to the Planner.)
</objective>

<process>
1. **Public/developer docs** — keep `README.md` and `docs/` current as stages land.

2. **Architecture narrative** — maintain `docs/ARCHITECTURE.md` (how it works) with a
   "last-verified-against-commit" stamp so it can't silently drift. (Where an agent
   reasons from code, prefer a source snapshot over prose — see the helper-bot pattern.)

3. **Handoff briefs** — when a feature is delegated to another agent:
   ```bash
   verity handoff new <feature-slug> --title "<Feature Name>"
   ```
   Fill in **"Scope decisions already settled (do NOT re-litigate)"** — the highest-
   leverage section — plus the build plan and pointers. `verity handoff` also ensures
   `docs/handoff/README.md` (the reading-order manifest a joining agent reads first).

   ```bash
   verity handoff list
   ```
</process>
