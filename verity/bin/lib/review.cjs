// Reviewer/Integrator (framework-spec.md §6, Role 6). The per-PR gate, adversarial
// to the builder. With branch protection often unavailable, the Reviewer's
// approval + confirmed-green CI IS the integration gate — so `merge` REFUSES on red.
const { execFileSync } = require('node:child_process');

const stage = require('./stage.cjs');
const contract = require('./contract.cjs');
const ledger = require('./ledger.cjs');
const security = require('./security.cjs');
const substrateLocal = require('./substrate-local.cjs');

// The checklist is PRE-DECLARED (acceptance conditions from the stage spec +
// contracts to verify conformance against). The Reviewer verifies each against the
// actual diff/source — never the PR description (the headline behavior).
function checklist(cwd, n) {
  const invariants = security.read(cwd);
  return {
    stage: n,
    acceptance: stage.acceptanceText(cwd, n),
    contracts: contract.list(cwd).contracts,
    securityInvariants: invariants || '(none defined — run `verity security init`)',
    instructions:
      'Verify each item against the ACTUAL diff/source, not the PR description. Confirm CI is green first.',
  };
}

// The gate, as a pure decision so it is unit-testable without network.
// CALL SITE (stage 19 audit): deliberately UNCHANGED. Only an explicitly
// VERIFIED green reading may merge, so the three-state CI below reaches this as
// `state === green` and nothing else does — `unknown` is not green, and merging
// on it would be strictly worse than the bug stage 19 fixes.
function canMerge(ciGreen) {
  return ciGreen === true;
}

// Three-state CI for one PR (stage 19): green | red | unknown. A failed
// shell-out is 'unknown' — we did not observe a failing check, we observed
// nothing — and unknown never merges, exactly as the old `false` never did.
function ciStateFor(pr, cwd) {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(pr), '--json', 'statusCheckRollup'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return ledger.rollupState(JSON.parse(out).statusCheckRollup || []);
  } catch {
    return ledger.CI_UNKNOWN;
  }
}

// Boolean projection kept for existing callers; unknown collapses to not-green.
function ciGreenFor(pr, cwd) {
  return ciStateFor(pr, cwd) === ledger.CI_GREEN;
}

function merge(cwd, pr, flags) {
  if (flags['dry-run']) {
    return { pr, merged: false, dryRun: true };
  }
  // Stage 81 (ADR-0029 §3): resolve the stage-79 delivery substrate the same
  // way every other seam consumer does (labels/work-items pattern —
  // `flags.substrate` short-circuits for tests/callers holding a loaded
  // policy; anything not exactly 'local', including an unreadable policy,
  // stays the gh path, byte-identical). On 'local' only the READING's source
  // moves — the gate itself (`canMerge`, and both refusal messages' shape) is
  // the same code either substrate; UNKNOWN never merges on either.
  //
  // Stage 84 (stage-81 review finding 1, resolved as documented-not-changed):
  // this resolveSubstrate call IS one policy read the pre-stage-81 github CLI
  // path did not perform, and it cannot be made lazy without a behavior
  // change — the substrate selects the merge ACT itself (mergeLocalPr vs
  // `gh pr merge`), not just the CI reading, so it must be known before
  // anything else happens (including under --assume-green). One local file
  // read on an operator-invoked CLI verb; the worker's autonomous merge path
  // (trust.merge) is untouched.
  const substrate =
    flags.substrate === undefined ? substrateLocal.resolveSubstrate(cwd) : flags.substrate;
  const local = substrate === 'local';
  // Stage 84 (stage-81 review finding 3, resolved as PARITY): --assume-green
  // bypasses the local gate-run reading exactly as it bypasses the GitHub CI
  // reading — one escape hatch, identical semantics on both substrates: an
  // operator explicitly asserts green and owns that assertion. Refusing it
  // only on local would make the local substrate a special case the operator
  // has to learn, without closing the hatch anywhere. Documented in
  // docs/dev/operator-local-audit.md; a test pins the parity.
  const state = flags['assume-green']
    ? ledger.CI_GREEN
    : local
      ? substrateLocal.localCiStateFor(cwd, pr)
      : ciStateFor(pr, cwd);
  if (!canMerge(state === ledger.CI_GREEN)) {
    // Same refusal either way — only the diagnostic differs, so an operator on
    // a repository with no CI is told what is actually wrong instead of hunting
    // for a failing check that does not exist. (The local UNVERIFIED diagnostic
    // names the honest local fact — no fresh gate-run record — instead of a
    // GitHub check query that never happened.)
    throw new Error(
      state === ledger.CI_UNKNOWN
        ? `refusing to merge PR #${pr}: CI is UNVERIFIED — ${
            local
              ? "no gate-run record proves this branch's current head green (contracts/local-work-item.md honesty rule)"
              : 'GitHub reports no checks at all for it (this repository may have no CI configured, or gh could not read it)'
          }. Unverified is not green (the gate, even when branch protection is unavailable)`
        : `refusing to merge PR #${pr}: CI is not green (the gate, even when branch protection is unavailable)`,
    );
  }
  if (local) {
    // Engine-performed local merge (ADR-0012/0013: Verity performs git —
    // `--no-ff` + push to the bare origin + close the stage's work-item
    // record). --no-ff vs the gh path's squash is the stage-81 accepted
    // divergence: local keeps stage commits; graduation may squash later.
    substrateLocal.mergeLocalPr(cwd, pr);
    return { pr, merged: true };
  }
  execFileSync('gh', ['pr', 'merge', String(pr), '--squash', '--delete-branch'], {
    stdio: 'inherit',
    cwd,
  });
  return { pr, merged: true };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'checklist') {
    return checklist(cwd, Number(args[1]));
  }
  if (verb === 'merge') {
    return merge(cwd, Number(args[1]), flags);
  }
  throw new Error(`unknown review verb: ${verb || '(none)'} — use checklist|merge`);
}

module.exports = { checklist, canMerge, ciStateFor, ciGreenFor, merge, dispatch };
