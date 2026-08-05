// Reviewer/Integrator (framework-spec.md §6, Role 6). The per-PR gate, adversarial
// to the builder. With branch protection often unavailable, the Reviewer's
// approval + confirmed-green CI IS the integration gate — so `merge` REFUSES on red.
const { execFileSync } = require('node:child_process');

const stage = require('./stage.cjs');
const contract = require('./contract.cjs');
const ledger = require('./ledger.cjs');
const security = require('./security.cjs');

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
  const state = flags['assume-green'] ? ledger.CI_GREEN : ciStateFor(pr, cwd);
  if (!canMerge(state === ledger.CI_GREEN)) {
    // Same refusal either way — only the diagnostic differs, so an operator on
    // a repository with no CI is told what is actually wrong instead of hunting
    // for a failing check that does not exist.
    throw new Error(
      state === ledger.CI_UNKNOWN
        ? `refusing to merge PR #${pr}: CI is UNVERIFIED — GitHub reports no checks at all for it (this repository may have no CI configured, or gh could not read it). Unverified is not green (the gate, even when branch protection is unavailable)`
        : `refusing to merge PR #${pr}: CI is not green (the gate, even when branch protection is unavailable)`,
    );
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
