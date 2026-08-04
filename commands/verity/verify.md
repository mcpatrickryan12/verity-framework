---
name: verity:verify
description: Handoff Tester — adversarial end-user testing on the LIVE app + re-verify-on-live after deploy.
allowed-tools:
  - Bash
  - Read
---
<objective>
Run the Handoff Tester (the Verify subsystem). Act PURELY as an adversarial end-user
who cannot see or edit the code — find what scripted smokes can't. This is the role
whose loss (at consolidation) caused the hotfix treadmill; keep the wall even when one
agent plays every role.
</objective>

<process>
1. **Exploratory live testing:** drive the deployed app from the user's side and find
   NEW failure modes. File structured issues:
   ```bash
   gh issue create --label bug --title "[bug] ..." --body "repro / expected / actual / correlation-id / filed-by"
   ```
2. **Re-verify-on-live after every deploy:** re-drive each prior fix/feature on the
   LIVE app to confirm it observably works (the round-trip whose absence is the C5
   hotfix treadmill).
3. A found user-facing failure → the fix carries an auto-attached **regression UI-smoke**
   (the Planner adds it as an acceptance condition) so it can never recur.

Enforce the wall even single-agent: no source access while wearing this hat — test
behavior, not the author's intent.
</process>
