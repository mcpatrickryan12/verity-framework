// Verity Autonomy label vocabulary (verity-autonomy-technical-sketch.md §1).
// `verity install` ensures these 12 labels exist on the target repo — the 8
// `verity:*` workflow labels plus the 4 stage work-item labels the worker
// reconcile and the plan agent actually attach (feature/bug/chore/needs-triage,
// stage.issueFor's `[type,'needs-triage']`, #188). Idempotent create-or-update
// of color/description; labels are NEVER deleted. Best-effort, like the rest of
// the CLI's GitHub access — install still succeeds offline or outside a repo,
// and reports the labels step as skipped.
//
// All gh access goes through the shared layer (verity/bin/lib/gh.cjs, T07),
// which owns the retry policy and uniform logging.
const gh = require('./gh.cjs');
// Stage 80 (ADR-0029): substrate resolution for ensureLabels' dispatch below.
const substrateLocal = require('./substrate-local.cjs');

// Colors are gh-style hex (no leading '#'), matching `gh label list --json color`.
const LABELS = [
  {
    name: 'verity:request',
    color: '0e8a16',
    description: 'Human-approved inbound work; worker may plan it',
  },
  {
    name: 'verity:ready',
    color: '1d76db',
    description: 'Stage/work item ready for build',
  },
  {
    name: 'verity:in-progress',
    color: 'fbca04',
    description: 'Locked by a worker run',
  },
  {
    name: 'verity:awaiting-approval',
    color: 'd93f0b',
    description: 'Paused at a human gate',
  },
  {
    name: 'verity:approved',
    color: '5319e7',
    description: 'Human approved; worker resumes',
  },
  {
    name: 'verity:needs-human',
    color: 'b60205',
    description: '2 failures; worker skips until cleared',
  },
  {
    name: 'verity:circuit-open',
    color: '000000',
    description: 'Budget/safety breaker tripped; worker halts',
  },
  {
    name: 'verity:trust-demoted',
    color: 'e99695',
    description: 'Auto-demotion event marker (audit)',
  },
  // Stage work-item labels (#188): stage.issueFor labels each `[stage N]` issue
  // `[<type>, 'needs-triage']` (type ∈ feature|bug|chore). These must EXIST on
  // the repo or `gh issue create` fails closed on the unknown label and the
  // worker reconcile silently creates nothing. Bare names (no `verity:`) so they
  // match stage.issueFor exactly; distinct colors from the `verity:*` set above.
  {
    name: 'feature',
    color: 'a2eeef',
    description: 'Stage work-item type: feature',
  },
  {
    name: 'bug',
    color: 'd73a4a',
    description: 'Stage work-item type: bug',
  },
  {
    name: 'chore',
    color: 'cfd3d7',
    description: 'Stage work-item type: chore',
  },
  {
    name: 'needs-triage',
    color: 'fef2c0',
    description: 'Stage work-item awaiting triage',
  },
];

// The ONLY gh entry point in this module — delegates to the shared layer,
// which retries transient (5xx / secondary-rate-limit) failures.
function ghLabel(args, cwd) {
  return gh.run(['label', ...args], { cwd });
}

function normColor(color) {
  return String(color || '')
    .replace(/^#/, '')
    .toLowerCase();
}

function firstLine(err) {
  return String(err?.message || err).split('\n')[0];
}

// Idempotent: missing labels are created, drifted ones are edited in place,
// matching ones are left alone. No delete verb exists in this module on purpose.
function ensureLabels(cwd, run = ghLabel, opts = {}) {
  // Stage 80 (ADR-0029, contract local-work-item v1): the local substrate has
  // no label REGISTRY to ensure — records carry labels as flat strings with no
  // repo-side pre-creation step (the gh path needs one only because `gh issue
  // create` fails closed on an unknown label). Honest no-op success, zero gh
  // calls; 'github'/unreadable-policy resolves to the unchanged path below.
  const substrate =
    opts.substrate === undefined ? substrateLocal.resolveSubstrate(cwd) : opts.substrate;
  if (substrate === 'local') {
    return { ok: true, skipped: true, substrate: 'local', created: [], updated: [], unchanged: [] };
  }
  let existing;
  try {
    existing = JSON.parse(run(['list', '--limit', '200', '--json', 'name,color,description'], cwd));
  } catch (err) {
    return { ok: false, skipped: true, error: firstLine(err) };
  }
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));

  const created = [];
  const updated = [];
  const unchanged = [];
  const failed = [];
  for (const label of LABELS) {
    const cur = byName.get(label.name.toLowerCase());
    if (
      cur &&
      normColor(cur.color) === label.color &&
      (cur.description || '') === label.description
    ) {
      unchanged.push(label.name);
      continue;
    }
    const verb = cur ? 'edit' : 'create';
    try {
      run([verb, label.name, '--color', label.color, '--description', label.description], cwd);
      (cur ? updated : created).push(label.name);
    } catch (err) {
      failed.push({ name: label.name, error: firstLine(err) });
    }
  }

  const result = { ok: failed.length === 0, created, updated, unchanged };
  if (failed.length > 0) {
    result.failed = failed;
  }
  return result;
}

module.exports = { LABELS, ensureLabels, ghLabel };
