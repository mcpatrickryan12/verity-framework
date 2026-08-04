---
name: verity:security
description: Security Auditor — define the invariants the Reviewer enforces, and run periodic deep audits.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Write
---
<objective>
Run the Security Auditor. DEFINE the security invariants (the Reviewer enforces them
per-PR; the Planner bakes them into acceptance conditions) and run periodic deep,
whole-system audits. Per-PR enforcement is the Reviewer's job — not this role's.
</objective>

<process>
1. Establish/maintain the canonical invariants:
   ```bash
   verity security init     # scaffolds docs/security-invariants.md (idempotent)
   verity security show
   ```
   Edit the list as the threat surface grows. These flow to `verity review checklist`.

2. Per-feature consult (when /verity:plan flags a new security surface): add
   feature-specific invariants to the brief / acceptance conditions.

3. Periodic deep audit (and at the pre-go-live gate):
   - Threat model the system's trust boundaries.
   - Dependency CVEs (complement the release Trivy image scan with app-dep scanning).
   - AuthN/AuthZ surface; secret handling (locations only, never values — see STATUS.md).
   - Write findings to `docs/security-report.md`; record security decisions as ADRs.

4. Feed the **pre-go-live gate** (`/verity:golive`) with a sign-off.
</process>
