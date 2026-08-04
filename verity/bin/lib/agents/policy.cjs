// contracts/role-capability-policy.md v1 (FROZEN) — the minimal loader for the
// runtime-neutral role capability policy (`<role>.permissions.json`). ADR-0007:
// the policy FAILS CLOSED — a missing or invalid file refuses execution
// (exit 30) for any provider that depends on it; there is no fallback to a
// runtime's default permission surface. This module owns loading, validation,
// and the load-time invariants; each provider driver projects the validated
// policy into its runtime's native controls (Codex: sandbox/approval — see
// codex.cjs). `.tools.json` is untouched: it remains the operative Claude
// allowlist until a separate zero-behavior-change migration (contract §Claude
// migration); this file governs everyone else.
const fs = require('node:fs');

const { AgentExecError, isPlainObject } = require('./result-contract.cjs');

// The frozen v1 capability vocabulary. Every key defaults to FALSE when
// absent — absence never grants anything (contract "Frozen semantics").
// Additive v1.x capability keys are tolerated (they default closed too), but
// their values must still be booleans: a non-boolean is a malformed policy,
// not a soft "false".
const CAPABILITY_KEYS = [
  'read_repository',
  'write_repository',
  'run_tests',
  'git_read',
  'git_write',
  'github_read',
  'github_write',
  'network',
  'deploy',
  // Additive v1.x key (stage 9, ADR-0007): may the role's own edits touch the
  // protected config roots (.github/**, .verity/**)? Defaults closed like
  // every capability; the codex driver projects `false` into generated
  // protected-path write-denial rules (codex.cjs commandRules).
  'write_protected_paths',
];

// Legal codex projection values (contract §Schema). `danger-full-access` is
// NOT a legal sandbox value in v1 — any future unrestricted mode is a new
// contract with its own explicit opt-in, so it is rejected by NAME below to
// make the refusal unmistakable in the error message.
const SANDBOXES = ['read-only', 'workspace-write'];
const APPROVALS = ['untrusted', 'on-request', 'never'];

function bad(file, detail) {
  return new AgentExecError(
    `fail-closed: invalid role capability policy ${file}: ${detail} (contracts/role-capability-policy.md v1, ADR-0007)`,
    'bad-policy',
  );
}

// Load + validate one `<role>.permissions.json`. Returns the normalized policy
// { schema_version, capabilities (every v1 key present, defaulted false),
//   codex: { sandbox, approval, ignore_user_config, ignore_rules } }.
// Throws AgentExecError (exit 30) on: missing file (slug missing-policy),
// unparsable JSON / schema violations / danger-full-access / a projection that
// exceeds the capabilities block (slug bad-policy). Never falls back.
function loadPolicy(permissionsFile) {
  if (!fs.existsSync(permissionsFile)) {
    throw new AgentExecError(
      `fail-closed: missing role capability policy ${permissionsFile} — every role needs a <role>.permissions.json next to its command file; execution is refused rather than using broader runtime defaults (contracts/role-capability-policy.md v1, ADR-0007)`,
      'missing-policy',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(permissionsFile, 'utf8'));
  } catch (err) {
    throw bad(permissionsFile, err.message);
  }
  if (!isPlainObject(parsed)) {
    throw bad(permissionsFile, 'must be a JSON object');
  }
  if (parsed.schema_version !== 1) {
    throw bad(
      permissionsFile,
      `schema_version must be 1, got ${JSON.stringify(parsed.schema_version)}`,
    );
  }
  if (!isPlainObject(parsed.capabilities)) {
    throw bad(permissionsFile, 'capabilities must be an object');
  }
  for (const [key, value] of Object.entries(parsed.capabilities)) {
    if (typeof value !== 'boolean') {
      throw bad(permissionsFile, `capabilities.${key} must be a boolean`);
    }
  }
  // Deny-by-default normalization: every frozen key materialized, absent = false.
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = parsed.capabilities[key] === true;
  }

  const codex = parsed.codex;
  if (!isPlainObject(codex)) {
    throw bad(permissionsFile, 'codex projection section must be an object');
  }
  if (codex.sandbox === 'danger-full-access') {
    throw bad(
      permissionsFile,
      "'danger-full-access' is not a legal codex.sandbox value in v1 — no role, no configuration, no override",
    );
  }
  if (!SANDBOXES.includes(codex.sandbox)) {
    throw bad(
      permissionsFile,
      `codex.sandbox must be one of ${SANDBOXES.join(' | ')}, got ${JSON.stringify(codex.sandbox)}`,
    );
  }
  const approval = codex.approval === undefined ? 'never' : codex.approval;
  if (!APPROVALS.includes(approval)) {
    throw bad(
      permissionsFile,
      `codex.approval must be one of ${APPROVALS.join(' | ')}, got ${JSON.stringify(codex.approval)}`,
    );
  }
  // Projections narrow, never widen: a codex sandbox that writes requires the
  // capabilities block to grant repository writes. Schema-valid but
  // load-invalid (contract "Provider sections ... are projections, not
  // authorities").
  if (codex.sandbox === 'workspace-write' && capabilities.write_repository !== true) {
    throw bad(
      permissionsFile,
      'codex.sandbox workspace-write exceeds the capabilities block (write_repository is not granted) — projections narrow, never widen',
    );
  }

  return {
    schema_version: 1,
    capabilities,
    codex: {
      sandbox: codex.sandbox,
      approval,
      // ADR-0007: headless runs default to ignoring the user's global Codex
      // config so it cannot change autonomous behavior; only an explicit
      // `false` in the policy opts out.
      ignore_user_config: codex.ignore_user_config !== false,
      ignore_rules: codex.ignore_rules === true,
    },
  };
}

// --- worker/autonomy-policy overrides (stage 9) --------------------------------
// Contract "Overrides narrow, never widen": a sandbox or approval override
// from `.verity/autonomy.yml` may only be MORE restrictive than the role's
// projection. Restrictiveness ladders:
//   sandbox   read-only (0) < workspace-write (1) — an override may only move
//             down;
//   approval  ranked by ESCALATION surface — 'never' permits zero
//             human-mediated escalation, 'untrusted' allows approval prompts
//             for untrusted commands, 'on-request' lets the model request
//             escalation at will — an override may only move toward 'never'.
const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1 };
const APPROVAL_RANK = { never: 0, untrusted: 1, 'on-request': 2 };

function badOverride(detail) {
  return new AgentExecError(
    `fail-closed: ${detail} (contracts/role-capability-policy.md v1, ADR-0007)`,
    'bad-override',
  );
}

// Apply worker overrides onto a LOADED role policy. Returns a new policy
// object (the input is never mutated); throws AgentExecError (exit 30, slug
// bad-override) on an illegal value or any widening — execution is refused
// rather than run with broader permissions than the role declares.
function applyOverrides(policy, overrides = {}) {
  const codex = { ...policy.codex };
  if (overrides.sandbox !== undefined) {
    if (overrides.sandbox === 'danger-full-access') {
      throw badOverride(
        "'danger-full-access' is not a legal sandbox value in v1 — no role, no configuration, no override",
      );
    }
    if (!SANDBOXES.includes(overrides.sandbox)) {
      throw badOverride(
        `sandbox override must be one of ${SANDBOXES.join(' | ')}, got ${JSON.stringify(overrides.sandbox)}`,
      );
    }
    if (SANDBOX_RANK[overrides.sandbox] > SANDBOX_RANK[codex.sandbox]) {
      throw badOverride(
        `sandbox override '${overrides.sandbox}' would WIDEN the role's projection '${codex.sandbox}' — overrides narrow, never widen`,
      );
    }
    codex.sandbox = overrides.sandbox;
  }
  if (overrides.approval !== undefined) {
    if (!APPROVALS.includes(overrides.approval)) {
      throw badOverride(
        `approval override must be one of ${APPROVALS.join(' | ')}, got ${JSON.stringify(overrides.approval)}`,
      );
    }
    if (APPROVAL_RANK[overrides.approval] > APPROVAL_RANK[codex.approval]) {
      throw badOverride(
        `approval override '${overrides.approval}' would WIDEN the role's projection '${codex.approval}' — overrides narrow, never widen`,
      );
    }
    codex.approval = overrides.approval;
  }
  return { ...policy, codex };
}

module.exports = { APPROVALS, CAPABILITY_KEYS, SANDBOXES, applyOverrides, loadPolicy };
