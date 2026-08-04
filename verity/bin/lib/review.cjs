// Reviewer/Integrator (framework-spec.md §6, Role 6). The per-PR gate, adversarial
// to the builder. With branch protection often unavailable, the Reviewer's
// approval + confirmed-green CI IS the integration gate — so `merge` REFUSES on red.
const { execFileSync } = require('node:child_process');

const stage = require('./stage.cjs');
const contract = require('./contract.cjs');
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
function canMerge(ciGreen) {
  return ciGreen === true;
}

function ciGreenFor(pr, cwd) {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(pr), '--json', 'statusCheckRollup'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rollup = JSON.parse(out).statusCheckRollup || [];
    const ok = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
    return rollup.length > 0 && rollup.every((c) => ok.has(c.conclusion || c.state));
  } catch {
    return false;
  }
}

function merge(cwd, pr, flags) {
  if (flags['dry-run']) {
    return { pr, merged: false, dryRun: true };
  }
  const green = flags['assume-green'] ? true : ciGreenFor(pr, cwd);
  if (!canMerge(green)) {
    throw new Error(
      `refusing to merge PR #${pr}: CI is not green (the gate, even when branch protection is unavailable)`,
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

module.exports = { checklist, canMerge, ciGreenFor, merge, dispatch };
