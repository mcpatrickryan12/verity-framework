// Verity Autonomy label vocabulary (verity-autonomy-technical-sketch.md §1).
// `verity install` ensures these 8 labels exist on the target repo: idempotent
// create-or-update of color/description; labels are NEVER deleted. Best-effort,
// like the rest of the CLI's GitHub access — install still succeeds offline or
// outside a repo, and reports the labels step as skipped.
//
// All gh access goes through the shared layer (verity/bin/lib/gh.cjs, T07),
// which owns the retry policy and uniform logging.
const gh = require('./gh.cjs');

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
function ensureLabels(cwd, run = ghLabel) {
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
