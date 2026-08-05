// Codex required-feature matrix (stage 12) — the EVIDENCE behind
// `verity.codexMinVersion`. Until this stage the pin was 0.42.0, a historical
// number nobody could trace to an observation; the compatibility claim it
// implied ("Verity works on any codex ≥ 0.42.0") had no basis at all.
//
// The rule this table encodes: **a version claim is only as old as the oldest
// release where the feature was actually observed working.** Every row is
// either VERIFIED — traceable to a command that really ran against a real
// Codex CLI — or UNVERIFIED, and an unverified row NEVER contributes to the
// pin. The single source of real-CLI evidence today is
// docs/dev/codex-enforcement-spike-0.146.0.md, which ran against codex-cli
// 0.146.0 and ONLY that release.
//
// Stage 15 added a third status, INCOMPATIBLE: a feature a real CLI or API
// REJECTED, which the driver therefore does not emit. It is the mirror of the
// same rule — "observed not to work" is an observation, cited to its evidence
// like any other — and it contributes nothing to the pin, because a feature
// Verity does not use cannot be a reason to require a release.
//
// Consequence, stated plainly so nobody mistakes it for a compatibility claim:
// the spike established that these features work AT 0.146.0. It did NOT bisect
// backwards, so the FIRST release supporting each of them is unknown
// (`firstSupported: null` on every row). Older releases may well work — Verity
// simply does not claim it without evidence. That makes the derived pin
// CONSERVATIVE BY EVIDENCE, not a statement that 0.145.x is broken. A canary
// run on an older release (docs/dev/codex-headless-canary.md §0) is what would
// lower a row's `firstSupported`, and only then the pin.
//
// Deliberately NOT in this table: 0.138.0. An external review mentioned it as
// a managed-permission-profile datum. That is not Verity's evidence, it is not
// about the `exec` path this driver uses, and a floor may never be set from a
// number we did not observe.
//
// This module is a LEAF: doctor.cjs consumes it (the too-old diagnosis names
// the feature motivating the minimum) and so does the codex driver, so it must
// require nothing from either.

// The one real-CLI evidence artifact. Every `evidence` string below points into
// it; a row citing anything else does not exist yet.
const SPIKE_DOC = 'docs/dev/codex-enforcement-spike-0.146.0.md';
const SPIKE_VERSION = '0.146.0';

// The SECOND real-CLI evidence artifact (stage 15, 2026-07-31): the canary run
// that found the headless path 100% non-functional and recorded, flag by flag,
// what the real CLI and the real API did with our invocation. It is what an
// `incompatible` row cites — a claim that something does NOT work is an
// observation too, and it needs evidence exactly like a claim that it does.
const UNBREAK_DOC = 'feature-assessments/codex-headless-unbreak-assessment.md';

// Why `firstSupported` is null on every row, said once and referenced by each.
const NO_BISECT =
  'unknown — the spike ran against 0.146.0 only and did not bisect earlier releases';

// One row per Codex feature the headless driver DEPENDS ON — plus any feature
// it deliberately does NOT use because a real CLI proved it unusable:
//   feature        the flag/behavior, spelled as the driver emits it
//   neededFor      what breaks without it (why it is required, not nice-to-have)
//   status         'verified'     — an observation in SPIKE_DOC; sets the pin
//                  'unverified'   — the driver emits it, nobody watched it
//                  'incompatible' — a real CLI/API REJECTED it (UNBREAK_DOC);
//                                   the driver no longer emits it, and the row
//                                   survives only so it cannot creep back. An
//                                   incompatible row is not a required feature
//                                   and contributes NOTHING to the pin.
//   verifiedAt     the release the observation was made on, or null
//   firstSupported the OLDEST release known to support it — null = unknown
//   evidence       where the observation lives, or why there is none
const CODEX_FEATURES = [
  {
    feature: 'codex exec --json',
    neededFor: 'the JSONL event stream the driver parses into a run digest',
    status: 'verified',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${SPIKE_DOC} F1 (real \`exec\` run transcript) + F7 (real item.type/usage shapes)`,
  },
  {
    feature: 'codex exec --sandbox <read-only|workspace-write>',
    neededFor:
      'the ONE filesystem boundary Codex itself enforces for exec — writes outside the workspace root fail (ADR-0011 layer 4)',
    status: 'verified',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${SPIKE_DOC} F1 (exec exposes only the coarse modes) + F6 (workspace-root write boundary observed)`,
  },
  {
    feature: '-c approval_policy="never"',
    neededFor: 'headless runs — no human is present to answer an approval prompt',
    status: 'verified',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${SPIKE_DOC} F6 — accepted and honored; the real run executed commands with no prompt`,
  },
  {
    feature: 'codex exec --ignore-user-config',
    neededFor:
      "ADR-0007's explicit-config rule — the run must not inherit whatever the operator left in $CODEX_HOME/config.toml",
    status: 'verified',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${SPIKE_DOC} F5 — observed to drop $CODEX_HOME/config.toml`,
  },
  {
    feature: 'codex login status',
    neededFor: 'the auth preflight oracle — Verity never reads credential files (§9.1)',
    status: 'verified',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${SPIKE_DOC} header (Auth) — \`codex login status\` → "Logged in using ChatGPT"`,
  },
  {
    feature: 'codex --version',
    neededFor:
      'the version preflight in doctor.cjs checkBinary()/parseVersion() — the real CLI prints `codex-cli <x.y.z>`, prefix and all',
    status: 'verified',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${SPIKE_DOC} header — the observed output form carries a \`codex-cli \` prefix`,
  },
  // --- required, but NOT verified by anything we have run ------------------------
  // These rows are why the matrix exists rather than a single number: the driver
  // emits them on every invocation, and nobody has yet watched a real CLI accept
  // them. They contribute NOTHING to the pin, and the canary (§0/§2) is what
  // moves them to 'verified'.
  {
    feature: 'codex exec --output-last-message <file>',
    neededFor: 'the preferred structured-result channel (marker parsing is the fallback)',
    status: 'unverified',
    verifiedAt: null,
    firstSupported: null,
    evidence:
      'no observation — the spike ran `exec --json` but did not record this flag; canary §2 covers it',
  },
  {
    feature: 'codex exec --ignore-rules',
    neededFor: 'suppressing project-level Codex rules the role never agreed to',
    status: 'unverified',
    verifiedAt: null,
    firstSupported: null,
    evidence: 'no observation — the spike never exercised this flag; canary §0 covers it',
  },
  // --- verified INCOMPATIBLE: observed to break, and no longer emitted -----------
  // The one row the driver does NOT depend on. Stage 10 added --output-schema as
  // a "belt" and stage 12 listed it as required-but-unverified; the stage-15
  // canary watched the real CLI accept the flag and the real API reject the
  // schema behind it, which killed 100% of runs. Keeping the row (rather than
  // deleting it with the flag) is the guard: the next reader sees an observation
  // saying "tried, rejected, here is where", not a gap inviting a re-add.
  {
    feature: 'codex exec --output-schema <file>',
    neededFor:
      'nothing — REMOVED in stage 15 (#34). Verity-side validateRoleOutcome was always the trust boundary, so dropping it costs no validation at all',
    status: 'incompatible',
    verifiedAt: SPIKE_VERSION,
    firstSupported: null,
    evidence: `${UNBREAK_DOC} — the CLI accepts the flag, the API rejects our schema: HTTP 400 invalid_json_schema "'allOf' is not permitted" → turn.failed, 0 tokens, 0 tool calls; A/B on the real binary isolated the flag as the sole cause`,
  },
];

// Ordering helper for THIS TABLE ONLY. doctor.cjs's compareVersions is the one
// comparator for probe OUTPUT, but doctor consumes this module, so requiring it
// back would be an import cycle. This never sees CLI output — it orders literal
// values written above by hand. (The matrix-consistency test cross-checks the
// derived floor with doctor.compareVersions, so the two can never disagree.)
function rank(version) {
  const [major, minor, patch] = String(version).split('.').map(Number);
  return major * 1e12 + minor * 1e6 + patch;
}

function verifiedRows(rows = CODEX_FEATURES) {
  return rows.filter((r) => r.status === 'verified' && r.verifiedAt !== null);
}

// Features a real CLI/API REJECTED. Deliberately NOT part of verifiedRows(): an
// incompatibility carries a version because it was observed on one, but it is
// evidence about what Verity must not do, never about what a release supports —
// so it can no more raise the pin than an unverified row can.
function incompatibleRows(rows = CODEX_FEATURES) {
  return rows.filter((r) => r.status === 'incompatible');
}

// The pin: the HIGHEST verified row. Highest, not lowest — a feature verified
// only at 0.146.0 is not evidence about 0.145.x, so claiming support below the
// newest verified row would be claiming something nobody observed. Unverified
// rows are ignored entirely: they can only ever RAISE a future floor. So are
// incompatible rows — permanently, since the driver does not depend on them.
function verifiedFloor(rows = CODEX_FEATURES) {
  const verified = verifiedRows(rows);
  if (verified.length === 0) {
    return null; // no evidence at all → no defensible pin
  }
  return verified.reduce((a, r) => (rank(r.verifiedAt) > rank(a) ? r.verifiedAt : a), '0.0.0');
}

// The features that actually MOTIVATE the pin: the verified rows sitting at the
// floor. This is what `verity doctor --agent codex` names in its too-old
// diagnosis, so an operator reading "upgrade" also reads WHY.
function motivatingFeatures(rows = CODEX_FEATURES) {
  const floor = verifiedFloor(rows);
  return verifiedRows(rows)
    .filter((r) => r.verifiedAt === floor)
    .map((r) => r.feature);
}

// One-line rationale for a diagnosis message. Names the floor, the features
// that set it, and where the evidence lives.
function pinMotivation(rows = CODEX_FEATURES) {
  const floor = verifiedFloor(rows);
  if (floor === null) {
    return `no Codex feature is verified against a real CLI — see ${SPIKE_DOC}`;
  }
  return `required feature(s) VERIFIED only at ${floor}: ${motivatingFeatures(rows).join(', ')} (evidence: ${SPIKE_DOC})`;
}

module.exports = {
  CODEX_FEATURES,
  NO_BISECT,
  SPIKE_DOC,
  SPIKE_VERSION,
  UNBREAK_DOC,
  incompatibleRows,
  motivatingFeatures,
  pinMotivation,
  verifiedFloor,
  verifiedRows,
};
