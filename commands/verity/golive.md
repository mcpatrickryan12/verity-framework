---
name: verity:golive
description: Pre-go-live / first-real-data gate — force-close the "fine for now" list before real data.
allowed-tools:
  - Bash
  - Read
---
<objective>
Run the BLOCKING pre-go-live gate before the project accepts real data or users
(Security Auditor + SRE jointly). The real build accumulated a "fine until real data"
list that never got closed — this gate forces it.
</objective>

<process>
1. Run the checklist:
   ```bash
   verity golive
   ```
   It auto-checks what's derivable (security invariants defined, secret locations
   recorded in STATUS, recovery plan present) and lists the manual gates.

2. Resolve EVERY manual gate before go-live:
   - Secrets rotated (no dev/exposed credentials).
   - Throwaway accounts removed.
   - Cross-user data isolation verified.
   - Backup coverage for ALL persistent state.
   - Security deep-audit sign-off (/verity:security).

3. Any unresolved blocker STOPS go-live.
</process>
