---
name: verity:map
description: Codebase Mapper — generate an on-demand code-structure diagram.
allowed-tools:
  - Bash
  - Read
---
<objective>
Generate a structural map of the codebase (distinct from the Planner's Gantt, which is
plan/schedule). On-demand, generated, never hand-maintained.
</objective>

<process>
1. Generate the map:
   ```bash
   verity map [--depth N]     # writes codebase-map.md (a Mermaid directory/module graph)
   ```
2. Use it for orientation — link it from `docs/handoff/README.md` so a joining agent
   can get its bearings fast. Regenerate anytime it drifts (it's a projection, not a record).
</process>
