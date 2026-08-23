// Stage 48 — the operator-gate contract (contracts/operator-gate.md, frozen v1).
// `verity operator work --json` and `… gates --json` are READ-ONLY list
// projections that RECOMPOSE Verity's externalised state. These tests drive
// work()/gates() with an INJECTED GitHub snapshot fixture (the ledger.project
// seam) and an INJECTED trust.classify stub, so they need ZERO network, and
// prove every contract invariant:
//   - work emits one item per non-merged stage, and its per-bucket tallies
//     EQUAL snapshot.queue's counts for the same fixture (the shared-classifier
//     guarantee — a count can never disagree with its list);
//   - gates lists exactly the gated items, each with merge_authority_granted
//     false and a descriptive allowed_actions;
//   - a gate's risk/evidence project trust.classify verbatim; a gate whose
//     classify throws surfaces those fields null (never a fabricated low-risk/0);
//   - ADR-0008: a gated run with unknown cost ⇒ verified_cost_usd null,
//     unknown_cost true;
//   - an unreachable GitHub (online:false) ⇒ both verbs return [], no throw;
//   - a token-shaped string in a title/reason never survives to the output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const operator = require('../verity/bin/lib/operator.cjs');
const usage = require('../verity/bin/lib/usage.cjs');

// A throwaway cwd with a stage-instructions/ dir holding the given stage specs.
function fixtureCwd(stages) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-opgate-'));
  const dir = path.join(cwd, 'stage-instructions');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of stages) {
    const deps = s.dependsOn?.length ? s.dependsOn.join(', ') : 'none';
    const body = `# Stage ${s.n}: ${s.title || `Stage ${s.n}`}\n\n- **Type:** feature\n- **Depends on:** ${deps}\n`;
    fs.writeFileSync(path.join(dir, `stage-${s.n}-slug.md`), body);
  }
  return cwd;
}

function green() {
  return [{ conclusion: 'SUCCESS' }];
}
function red() {
  return [{ conclusion: 'FAILURE' }];
}

// One stage per queue bucket (identical to the stage-47 snapshot fixture):
// 1 ready, 2 blocked (dep on 1), 3 awaiting_approval, 4 needs_human,
// 5 waiting_for_ci (red PR), 6 in_progress.
function bucketStages() {
  return [
    { n: 1, title: 'Core' },
    { n: 2, title: 'Follow', dependsOn: [1] },
    { n: 3, title: 'Gate' },
    { n: 4, title: 'Parked' },
    { n: 5, title: 'Failing' },
    { n: 6, title: 'Locked' },
  ];
}
function bucketSnapshot() {
  return {
    online: true,
    issues: [
      { number: 101, title: '[stage 1] Core', state: 'OPEN', labels: [] },
      { number: 103, title: '[stage 3] Gate', state: 'OPEN', labels: ['verity:awaiting-approval'] },
      { number: 104, title: '[stage 4] Parked', state: 'OPEN', labels: ['verity:needs-human'] },
      { number: 105, title: '[stage 5] Failing', state: 'OPEN', labels: [] },
      { number: 106, title: '[stage 6] Locked', state: 'OPEN', labels: ['verity:in-progress'] },
    ],
    prs: [
      {
        number: 201,
        title: '[stage 1] Core',
        state: 'OPEN',
        labels: [],
        statusCheckRollup: green(),
      },
      {
        number: 205,
        title: '[stage 5] Failing',
        state: 'OPEN',
        labels: [],
        statusCheckRollup: red(),
      },
    ],
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// (1) work: one item per non-merged stage; buckets tally EXACTLY to the counts.
// ---------------------------------------------------------------------------

test('work emits one item per non-merged stage and its buckets tally to snapshot.queue', () => {
  const cwd = fixtureCwd(bucketStages());
  const fixture = bucketSnapshot();

  const snap = operator.snapshot(cwd, { snapshot: fixture });
  const items = operator.work(cwd, { snapshot: fixture });

  assertEqual(items.length, 6, 'one work item per non-merged stage (all 6 open)');

  // Every item carries the frozen shape.
  for (const it of items) {
    assertEqual(it.schema, 1, 'item schema');
    assert(typeof it.stage === 'number', 'item stage number');
    assert(typeof it.status === 'string', 'item status');
    assert(
      [
        'ready',
        'in_progress',
        'waiting_for_ci',
        'awaiting_approval',
        'needs_human',
        'blocked',
      ].includes(it.bucket),
      'item bucket is queue vocabulary',
    );
  }

  // THE shared-classifier guarantee: itemized buckets == counts, bucket by bucket.
  const tally = {};
  for (const it of items) {
    tally[it.bucket] = (tally[it.bucket] || 0) + 1;
  }
  for (const b of [
    'ready',
    'in_progress',
    'waiting_for_ci',
    'awaiting_approval',
    'needs_human',
    'blocked',
  ]) {
    assertEqual(tally[b] || 0, snap.queue[b], `work bucket ${b} tallies to snapshot.queue.${b}`);
  }

  // next mirrors decide(): the ready stage has a build/review decision; the
  // blocked and human-parked stages carry null (the worker will not act).
  const byStage = Object.fromEntries(items.map((it) => [it.stage, it]));
  assert(byStage[1].next && typeof byStage[1].next.role === 'string', 'ready stage has a next');
  assertEqual(byStage[2].next, null, 'blocked stage next is null');
  assertEqual(byStage[4].next, null, 'human-parked stage next is null');
});

// ---------------------------------------------------------------------------
// (2) gates: exactly the gated items; risk/evidence project classify verbatim.
// ---------------------------------------------------------------------------

function gateStages() {
  return [
    { n: 1, title: 'Reviewable' },
    { n: 2, title: 'Parked' },
  ];
}
function gateSnapshot() {
  return {
    online: true,
    issues: [
      { number: 101, title: '[stage 1] Reviewable', state: 'OPEN', labels: [] },
      { number: 102, title: '[stage 2] Parked', state: 'OPEN', labels: ['verity:needs-human'] },
    ],
    prs: [
      {
        number: 201,
        title: '[stage 1] Reviewable',
        state: 'OPEN',
        labels: ['verity:awaiting-approval'],
        statusCheckRollup: green(),
      },
    ],
    tags: [],
  };
}

test('gates lists exactly the gated items with classify evidence projected verbatim', () => {
  const cwd = fixtureCwd(gateStages());
  const reasons = ['contracts/agent-result.md matches protected path contracts/**'];
  const calls = [];
  const classify = (pr, _policy, _ghOpts) => {
    calls.push(pr);
    return {
      risk: 'high',
      reasons,
      files: ['a', 'b', 'c'],
      changed_lines: 240,
      checks_green: true,
    };
  };

  const list = operator.gates(cwd, { snapshot: gateSnapshot(), classify });

  assertEqual(list.length, 2, 'exactly the two gated items (awaiting-approval + needs-human)');

  // Every gate: not an approval path; descriptive actions.
  for (const g of list) {
    assertEqual(g.schema, 1, 'gate schema');
    assertEqual(g.next_on_approve.merge_authority_granted, false, 'merge_authority_granted false');
    assertEqual(g.next_on_approve.action, 'resume-worker', 'next_on_approve.action');
    assert(Array.isArray(g.allowed_actions) && g.allowed_actions.length > 0, 'allowed_actions');
    assert(g.allowed_actions.includes('approve'), 'allowed_actions includes approve');
  }

  const prGate = list.find((g) => g.pull_request !== null);
  assert(prGate, 'the awaiting-approval gate carries a pull_request');
  assertEqual(calls.length, 1, 'classify called exactly once — only for the gated PR');
  assertEqual(prGate.pull_request.number, 201, 'gate pull_request number');
  assertEqual(prGate.stage, 1, 'gate stage');
  assertEqual(prGate.gate_id, 'gate-201-review', 'gate_id = gate-<pr>-<role>');

  // risk/evidence are the injected classify projected verbatim.
  assertEqual(prGate.risk, 'high', 'risk verbatim');
  assertEqual(prGate.evidence.files_changed, 3, 'files_changed = files.length');
  assertEqual(prGate.evidence.changed_lines, 240, 'changed_lines verbatim');
  assertEqual(prGate.evidence.ci, 'green', 'ci maps checks_green true → green');
  assertEqual(
    JSON.stringify(prGate.evidence.protected_paths),
    JSON.stringify(reasons),
    'protected_paths = classify.reasons verbatim',
  );

  // The needs-human gate has no PR → no classify, evidence honestly null.
  const parked = list.find((g) => g.pull_request === null);
  assert(parked, 'the needs-human gate is present');
  assertEqual(parked.stage, 2, 'parked gate stage');
  assertEqual(parked.risk, null, 'no PR ⇒ risk null (not fabricated)');
  assertEqual(parked.evidence.files_changed, null, 'no PR ⇒ files_changed null');
  assertEqual(parked.evidence.ci, null, 'no PR ⇒ ci null');
});

// ---------------------------------------------------------------------------
// (3) Honest-unknown: a gate whose classify throws ⇒ evidence fields null.
// ---------------------------------------------------------------------------

test('a gate whose classify cannot be read surfaces null evidence, never a fabricated low-risk/0', () => {
  const cwd = fixtureCwd(gateStages());
  const classify = () => {
    throw new Error('gh unavailable for this PR');
  };

  const list = operator.gates(cwd, { snapshot: gateSnapshot(), classify });
  const prGate = list.find((g) => g.pull_request !== null);
  assert(prGate, 'the awaiting-approval gate is still listed');

  assertEqual(prGate.risk, null, 'unreadable ⇒ risk null (NOT a fabricated low)');
  assertEqual(prGate.evidence.files_changed, null, 'files_changed null');
  assertEqual(prGate.evidence.protected_paths, null, 'protected_paths null');
  assertEqual(prGate.evidence.changed_lines, null, 'changed_lines null');
  assertEqual(prGate.evidence.ci, null, 'ci null (NOT a fabricated green)');
});

// ---------------------------------------------------------------------------
// (4) ADR-0008: a gated run with unknown cost ⇒ verified_cost_usd null / unknown_cost true.
// ---------------------------------------------------------------------------

test('ADR-0008: unknown-cost run ⇒ verified_cost_usd null, unknown_cost true', () => {
  const cwd = fixtureCwd(gateStages());
  // One usage row TODAY with an empty est_usd cell = UNKNOWN cost (ADR-0008).
  const ts = new Date().toISOString();
  const row = [ts, 'run-1', 'o/r', 'build', '100', '200', '', '5', 'gated', '0', 'build', ''].join(
    ',',
  );
  const csvDir = path.join(cwd, '.verity');
  fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(path.join(csvDir, 'usage.csv'), `${usage.HEADER}\n${row}\n`);

  const classify = () => ({
    risk: 'high',
    reasons: [],
    files: [],
    changed_lines: 0,
    checks_green: true,
  });
  const list = operator.gates(cwd, { snapshot: gateSnapshot(), classify });
  const prGate = list.find((g) => g.pull_request !== null);

  assertEqual(prGate.evidence.verified_cost_usd, null, 'verified_cost_usd null, NEVER 0');
  assertEqual(prGate.evidence.unknown_cost, true, 'unknown_cost true');
});

// ---------------------------------------------------------------------------
// (5) Read-only / honest-unknown: online:false ⇒ both verbs [], no throw.
// ---------------------------------------------------------------------------

test('unreachable GitHub ⇒ gates and work both return [] with no throw', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  const offline = {
    online: false,
    verified: false,
    issues: null,
    prs: null,
    tags: [],
    failures: [],
  };

  let g;
  let w;
  assert(
    (() => {
      g = operator.gates(cwd, { snapshot: offline });
      w = operator.work(cwd, { snapshot: offline });
      return true;
    })(),
    'gates()/work() must not throw on an offline snapshot',
  );
  assert(Array.isArray(g) && g.length === 0, 'gates ⇒ [] when offline');
  assert(Array.isArray(w) && w.length === 0, 'work ⇒ [] when offline');
});

// ---------------------------------------------------------------------------
// (6) Redaction: a token-shaped string in a title/reason never survives.
// ---------------------------------------------------------------------------

test('a token-shaped string in a stage title never survives into work output', () => {
  // Assembled from fragments at RUNTIME so no static `ghp_…` literal exists in
  // this source (else the promotion secret-scan smoke test would flag this very
  // file). The runtime value is a valid PAT shape the redactor still catches.
  const token = `ghp_${'A'.repeat(20)}`;
  const cwd = fixtureCwd([{ n: 1, title: `Deploy ${token}` }]);
  const items = operator.work(cwd, { snapshot: { online: true, issues: [], prs: [], tags: [] } });

  const serialized = JSON.stringify(items);
  assert(!serialized.includes(token), 'no token shape survives anywhere in the work output');
  assert(items[0].title.includes('[redacted]'), 'the title carries the redacted marker');
  assert(
    items[0].next.reason.includes('[redacted]'),
    'the next.reason carries the redacted marker',
  );
});
