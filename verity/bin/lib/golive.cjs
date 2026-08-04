// Pre-go-live / first-real-data gate (framework-spec.md §6). A BLOCKING checklist
// before the project accepts real data/users (Security Auditor + SRE jointly). Auto-
// checks what's derivable; lists the manual gates that need human confirmation.
const fs = require('node:fs');
const path = require('node:path');

const security = require('./security.cjs');
const status = require('./status.cjs');

function check(cwd) {
  const runtime = status.read(cwd);
  const items = [
    {
      item: 'Security invariants defined (docs/security-invariants.md)',
      ok: Boolean(security.read(cwd)),
    },
    {
      item: 'Secret locations recorded in STATUS (runtime.json)',
      ok: Array.isArray(runtime.secret_locations) && runtime.secret_locations.length > 0,
    },
    {
      item: 'Recovery plan present (recovery-plan.md)',
      ok: fs.existsSync(path.join(cwd, 'recovery-plan.md')),
    },
  ];
  const manual = [
    'Secrets rotated (no dev/exposed credentials)',
    'Throwaway accounts removed',
    'Cross-user data isolation verified',
    'Backup coverage for ALL persistent state (no silent gaps)',
    'Security deep-audit sign-off',
  ];
  const autoPass = items.every((i) => i.ok);
  return {
    items,
    manual,
    autoPass,
    ready: autoPass,
    raw: autoPass
      ? 'auto-checks pass — now confirm the manual gates before go-live'
      : 'BLOCKED: resolve the failing auto-checks',
  };
}

function dispatch(args, flags) {
  return check(flags.cwd || process.cwd());
}

module.exports = { check, dispatch };
