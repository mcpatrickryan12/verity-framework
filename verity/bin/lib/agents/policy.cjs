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
  // every capability; stage 11 (ADR-0011) enforces `false` with the post-run
  // invariant checker (agents/invariants.cjs) instead of a Codex rules file.
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

// --- capability honesty rule (stage 11, ADR-0011 + ADR-0007) -------------------
// "Codex must never appear to enforce something it does not." Every restriction
// a role DECLARES (a capability that is false) maps here to the mechanism that
// actually enforces it. A restriction whose mechanism is null is UNENFORCEABLE:
// the run is refused (exit 30, slug `unenforceable-policy`) unless the operator
// explicitly acknowledges the gap — the additive, default-absent autonomy knob
// `agent.acknowledged_enforcement_gaps` (fail closed: absence acknowledges
// nothing).
//
// The three mechanisms that exist today, and what each one is PROVEN to do
// (docs/dev/codex-enforcement-spike-0.146.0.md):
//   codex-sandbox        `--sandbox {read-only|workspace-write}` on `codex
//                        exec`. Proven (F6): writes are confined to the
//                        workspace root. Nothing finer — per-path permission
//                        profiles are ignored by `exec` (F1).
//   credential-stripping the child environment is built from an enumerated
//                        passlist (codex.cjs childEnv), so a credential the
//                        capabilities do not grant is simply ABSENT. Absent
//                        credentials cannot be misused by any command, wrapped
//                        or not (ADR-0011 layer 2).
//   post-run-invariants  agents/invariants.cjs: pre-run snapshot vs post-run
//                        state, hard revert where safe, loud failure
//                        (ADR-0011 layer 5 — mandatory, not a backstop).
//   verity-performed-git the PROVISION side of the rule (stage 17, ADR-0012):
//                        the model cannot write under `.git` at all, so
//                        deterministic Verity code performs the branch, the
//                        commit, the push and the PR outside its execution
//                        context (agents/git-lifecycle.cjs).
const MECHANISMS = [
  'codex-sandbox',
  'credential-stripping',
  'post-run-invariants',
  'verity-performed-git',
];

const ENFORCEMENT_MECHANISMS = {
  // The role may not write the repository at all → `--sandbox read-only`
  // (loadPolicy already refuses a workspace-write projection without it).
  write_repository: 'codex-sandbox',
  // .github/** and .verity/** are snapshotted before the run and diffed after;
  // a mutation is reverted from the snapshot and fails the run.
  write_protected_paths: 'post-run-invariants',
  // Branch/tag/HEAD movement is detected by the ref snapshot diff.
  git_write: 'post-run-invariants',
  // No GH_TOKEN/GITHUB_TOKEN in the child environment → `gh` cannot mutate
  // anything on GitHub, whatever the model types.
  github_write: 'credential-stripping',
  // No cloud/registry credentials in the child environment.
  deploy: 'credential-stripping',
  // UNENFORCEABLE on the exec path. `codex exec` ignores permission profiles
  // (F1), so the profile-only network switch proven under `codex sandbox` (F6)
  // does not bind here, and no `-c` key is proven to. Until network denial is
  // enforced at the OS boundary this restriction fails closed.
  network: null,
};

// Capabilities Verity makes NO enforcement claim about. Listing them here is
// deliberate and auditable: restricting them is prompt-level guidance only, so
// they are neither "enforced" (a lie) nor a refusal (noise on every role).
//   read_repository / git_read   the workspace physically contains the repo and
//                                its history; only tier 2's shaped disposable
//                                workspace (stage 14) can make this a fact.
//   run_tests                    running the suite is an ordinary in-workspace
//                                command; nothing distinguishes it.
//   github_read                  the GitHub credential is ONE token whose
//                                presence is governed by github_write, so a
//                                role that holds github_write keeps read access
//                                regardless of this key.
const ADVISORY_CAPABILITIES = ['read_repository', 'run_tests', 'git_read', 'github_read'];

// --- the PROVISION half of the honesty rule (stage 17, ADR-0012) ---------------
// ENFORCEMENT_MECHANISMS above answers "does a declared RESTRICTION bind?".
// This table answers the mirror-image question: "can a declared GRANT be
// honoured at all?" — and it exists because one capability cannot be honoured
// the obvious way on every runtime.
//
// `git_write` is that capability. Where the model's sandbox makes `.git`
// read-only, granting git_write to the ROLE grants it nothing: `checkout -b`
// and `commit` fail rc=128 whatever the policy says. Under ADR-0012 the grant
// therefore projects to "Verity performs git on this role's behalf", performed
// by deterministic code outside the model's execution context. Same fail-closed
// discipline as the restriction side: if Verity cannot provide it for a given
// run (no repository, unborn HEAD, no committer identity, no remote to push
// to), the run is REFUSED (exit 30, slug `git-unprovidable`) rather than
// finishing with no branch, no commit and no PR while reporting success.
//
// A runtime whose harness performs its own git (the reference driver) never
// consults this table — it exports none of the lifecycle hooks, so its
// coordinator path is unchanged.
const PROVIDED_CAPABILITIES = { git_write: 'verity-performed-git' };

// Every restriction a role declares that has NO enforcing mechanism, sorted.
// Grants (capability true) are never gaps — nothing needs enforcing.
function enforcementGaps(policy) {
  return Object.keys(ENFORCEMENT_MECHANISMS)
    .filter((cap) => ENFORCEMENT_MECHANISMS[cap] === null && policy.capabilities[cap] !== true)
    .sort();
}

// Fail-closed gate called before any provider process is spawned. Returns the
// acknowledgements that ACTUALLY applied (so the caller can surface them in the
// result — an invisible acknowledgement would be its own kind of theater).
// Throws AgentExecError (exit 30) when a gap is unacknowledged
// (`unenforceable-policy`) or an acknowledgement names something that is not a
// capability (`bad-acknowledgement` — a typo must never fail silently open OR
// silently closed).
function assertEnforceable(policy, acknowledged = []) {
  const unknown = acknowledged.filter((cap) => !CAPABILITY_KEYS.includes(cap));
  if (unknown.length > 0) {
    throw new AgentExecError(
      `fail-closed: acknowledged_enforcement_gaps names ${unknown.map((c) => `'${c}'`).join(', ')}, which is not a capability in contracts/role-capability-policy.md v1 (known: ${CAPABILITY_KEYS.join(', ')})`,
      'bad-acknowledgement',
    );
  }
  const gaps = enforcementGaps(policy);
  const unacknowledged = gaps.filter((cap) => !acknowledged.includes(cap));
  if (unacknowledged.length > 0) {
    throw new AgentExecError(
      `fail-closed: the role declares ${unacknowledged.map((c) => `${c}: false`).join(', ')}, but Verity has NO mechanism that enforces it on this provider — refusing the run rather than appearing to enforce it (ADR-0011). Acknowledge the gap explicitly with agent.acknowledged_enforcement_gaps: [${unacknowledged.join(', ')}] in .verity/autonomy.yml (or --acknowledge-gaps ${unacknowledged.join(',')}) to run anyway, with the gap recorded in the result`,
      'unenforceable-policy',
    );
  }
  return gaps;
}

module.exports = {
  ADVISORY_CAPABILITIES,
  APPROVALS,
  CAPABILITY_KEYS,
  ENFORCEMENT_MECHANISMS,
  MECHANISMS,
  PROVIDED_CAPABILITIES,
  SANDBOXES,
  applyOverrides,
  assertEnforceable,
  enforcementGaps,
  loadPolicy,
};
