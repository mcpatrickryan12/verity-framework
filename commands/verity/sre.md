---
name: verity:sre
description: SRE — steady-state ops: recovery/backup readiness, intermittent-env, secret rotation, monitoring.
allowed-tools:
  - Bash
  - Read
  - Write
---
<objective>
Run the SRE: keep the system healthy over time and ready to recover. The deploy ACT
is the Release/Deploy Operator's; this is continuous steady-state + a periodic
ops-health pass.
</objective>

<process>
1. Recovery readiness:
   ```bash
   verity recovery init     # scaffolds recovery-plan.md
   ```
   Drill rollback (re-pin previous digests + redeploy) and restore (PITR) so neither is scary.
2. **Backup contract:** every persistent store is backed up OR explicitly marked
   acceptable-loss — no silent gaps.
3. **Intermittent env:** maintain the "asleep vs incident" runbook; the Operator's
   env-precheck consumes it.
4. **Secret lifecycle:** track rotation; flag stale/exposed credentials (feeds /verity:golive).
5. Monitoring/alerting + SLOs beyond `/health`. Incident response → mitigate (often an
   Operator rollback) → file an issue → post-incident note.
Run a periodic ops-health pass on a cadence (rotation + backup audit + a drill).
</process>
