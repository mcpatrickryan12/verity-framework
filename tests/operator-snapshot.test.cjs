// Stage 47 — the operator-snapshot contract (contracts/operator-snapshot.md,
// frozen v1). `verity operator snapshot --json` is a READ-ONLY projection that
// RECOMPOSES Verity's externalised state; these tests drive snapshot() with an
// INJECTED GitHub snapshot fixture (the ledger.project seam), so they need ZERO
// network, and prove every contract invariant:
//   - exact wire shape + field types of a populated snapshot;
//   - unreachable GitHub ⇒ online:false, health.github "unavailable", queue
//     counts nulled (NOT a zero-filled all-clear);
//   - unverified cost ⇒ verified_cost_usd null (never 0), unknown_cost_runs ≥ 1;
//   - snapshot.next equals next.decide projected for the same input;
//   - a token-shaped string in an input never survives into the output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const operator = require('../verity/bin/lib/operator.cjs');
const ledger = require('../verity/bin/lib/ledger.cjs');
const nextLib = require('../verity/bin/lib/next.cjs');
const usage = require('../verity/bin/lib/usage.cjs');

// A throwaway cwd with a stage-instructions/ dir holding the given stage specs.
// Each spec: { n, title?, dependsOn? }.
function fixtureCwd(stages) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-operator-'));
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

// ---------------------------------------------------------------------------
// (1) Populated snapshot: exact wire shape, field types, queue buckets, next.
// ---------------------------------------------------------------------------

// stage 1: green PR open (in-review) → the next action (review)
// stage 2: depends on 1 (not merged) → blocked
// stage 3: awaiting-approval label → awaiting_approval
// stage 4: needs-human label → needs_human
// stage 5: red PR open (building) → waiting_for_ci
// stage 6: in-progress label → in_progress
function populatedStages() {
  return [
    { n: 1, title: 'Core' },
    { n: 2, title: 'Follow', dependsOn: [1] },
    { n: 3, title: 'Gate' },
    { n: 4, title: 'Parked' },
    { n: 5, title: 'Failing' },
    { n: 6, title: 'Locked' },
  ];
}
function populatedSnapshot() {
  return {
    online: true,
    issues: [
      { number: 101, title: '[stage 1] Core', state: 'OPEN', labels: [], assignees: [] },
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

test('populated snapshot has the exact frozen wire shape and field types', () => {
  const cwd = fixtureCwd(populatedStages());
  const snap = operator.snapshot(cwd, { snapshot: populatedSnapshot() });

  assertEqual(snap.schema, 1, 'schema is integer 1');
  assertEqual(snap.online, true, 'online');
  assert(
    typeof snap.generated_at === 'string' && snap.generated_at.includes('T'),
    'generated_at ISO',
  );
  assert(!Number.isNaN(Date.parse(snap.generated_at)), 'generated_at parses');

  // Top-level keys are exactly the contract's set.
  assertEqual(
    Object.keys(snap).sort().join(','),
    'autonomy,generated_at,health,limits,next,online,queue,repository,runtime,schema,worker',
    'top-level keys',
  );

  // autonomy: defaults (no .verity) → manual mode, trust 0, circuit_open true
  // (manual halts the worker).
  assertEqual(snap.autonomy.mode, 'manual', 'autonomy.mode');
  assertEqual(snap.autonomy.circuit_open, true, 'autonomy.circuit_open (manual)');
  assertEqual(snap.autonomy.trust, 0, 'autonomy.trust');

  // runtime honest fields.
  assert(['available', 'unavailable', 'unknown'].includes(snap.runtime.status), 'runtime.status');
  assertEqual(snap.runtime.profile, null, 'runtime.profile honest null');

  // worker: best-effort idle, everything else null (no cheap observation).
  assertEqual(snap.worker.state, 'idle', 'worker.state');
  assertEqual(snap.worker.last_tick, null, 'worker.last_tick');
  assertEqual(snap.worker.lock, null, 'worker.lock');

  // queue buckets — one stage per bucket, non-overlapping.
  assertEqual(snap.queue.ready, 1, 'queue.ready');
  assertEqual(snap.queue.in_progress, 1, 'queue.in_progress');
  assertEqual(snap.queue.waiting_for_ci, 1, 'queue.waiting_for_ci');
  assertEqual(snap.queue.awaiting_approval, 1, 'queue.awaiting_approval');
  assertEqual(snap.queue.needs_human, 1, 'queue.needs_human');
  assertEqual(snap.queue.blocked, 1, 'queue.blocked');

  // next: stage 1's green PR is the review action.
  assertEqual(snap.next.role, 'review', 'next.role');
  assertEqual(snap.next.target_type, 'pull_request', 'next.target_type');
  assertEqual(snap.next.target, 201, 'next.target');
  assert(typeof snap.next.reason === 'string' && snap.next.reason.length > 0, 'next.reason');

  // limits: defaults for caps, honest cost fields.
  assertEqual(snap.limits.max_runs, 24, 'limits.max_runs default');
  assertEqual(snap.limits.max_cost_usd, 25, 'limits.max_cost_usd default');
  assertEqual(snap.limits.runs_today, 0, 'limits.runs_today (no usage.csv)');
  assertEqual(snap.limits.verified_cost_usd, null, 'verified_cost_usd null when nothing verified');
  assertEqual(snap.limits.unknown_cost_runs, 0, 'unknown_cost_runs');

  // health.
  assertEqual(snap.health.github, 'available', 'health.github');
  assertEqual(snap.health.policy, 'valid', 'health.policy');
  assert(['pass', 'fail', null].includes(snap.health.doctor), 'health.doctor');
  assertEqual(snap.health.runtime, snap.runtime.status, 'health.runtime mirrors runtime.status');
});

// ---------------------------------------------------------------------------
// (2) Invariant 2: snapshot.next never disagrees with next.decide.
// ---------------------------------------------------------------------------

test('snapshot.next is a verbatim projection of next.decide for the same input', () => {
  const cwd = fixtureCwd(populatedStages());
  const fixture = populatedSnapshot();
  const proj = ledger.project(cwd, { snapshot: fixture });
  const decision = nextLib.decide(proj, fixture);

  const snap = operator.snapshot(cwd, { snapshot: fixture });

  assertEqual(snap.next.role, decision.role, 'role agrees with next.decide');
  assertEqual(snap.next.target, decision.target.number, 'target agrees with next.decide');
  const expectType =
    decision.target.kind === 'pr'
      ? 'pull_request'
      : decision.target.kind === 'issue'
        ? 'issue'
        : 'stage';
  assertEqual(snap.next.target_type, expectType, 'target_type agrees with next.decide');
});

// ---------------------------------------------------------------------------
// (3) Invariant 4: unreachable GitHub — honest unknown, no zero-queue fabrication.
// ---------------------------------------------------------------------------

test('unreachable GitHub ⇒ online:false, github unavailable, queue counts nulled', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  // fetchSnapshot returns exactly this shape when GitHub can't be read.
  const offline = {
    online: false,
    verified: false,
    issues: null,
    prs: null,
    tags: [],
    failures: [],
  };

  let snap;
  // Read-only assertion: this must not throw even with a fully offline snapshot.
  assert(
    (() => {
      snap = operator.snapshot(cwd, { snapshot: offline });
      return true;
    })(),
    'snapshot() must not throw on an offline snapshot',
  );

  assertEqual(snap.online, false, 'online:false');
  assertEqual(snap.health.github, 'unavailable', 'health.github unavailable');

  // NO fabricated all-zero queue — every count the projection could not observe
  // is null.
  for (const bucket of [
    'ready',
    'in_progress',
    'waiting_for_ci',
    'awaiting_approval',
    'needs_human',
    'blocked',
  ]) {
    assertEqual(snap.queue[bucket], null, `queue.${bucket} nulled (not a fabricated 0)`);
  }
});

// ---------------------------------------------------------------------------
// (4) Invariant 4 / ADR-0008: unverified cost is null, never 0.
// ---------------------------------------------------------------------------

test('a run with unknown cost ⇒ verified_cost_usd null (never 0), unknown_cost_runs ≥ 1', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  // One usage row TODAY with an empty est_usd cell = UNKNOWN cost (ADR-0008).
  const ts = new Date().toISOString();
  const row = [
    ts,
    'run-1',
    'o/r',
    'build',
    '100',
    '200',
    '',
    '5',
    'success',
    '0',
    'build',
    '',
  ].join(',');
  const csvDir = path.join(cwd, '.verity');
  fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(path.join(csvDir, 'usage.csv'), `${usage.HEADER}\n${row}\n`);

  const snap = operator.snapshot(cwd, {
    snapshot: { online: true, issues: [], prs: [], tags: [] },
  });

  assertEqual(snap.limits.runs_today, 1, 'runs_today counts the run');
  assertEqual(snap.limits.verified_cost_usd, null, 'verified_cost_usd is null, NEVER 0');
  assert(snap.limits.unknown_cost_runs >= 1, 'unknown_cost_runs counts the unknown-cost run');
});

// ---------------------------------------------------------------------------
// (5) Invariant 5: redaction — a token-shaped string never survives to output.
// ---------------------------------------------------------------------------

test('a token-shaped string in an input reason never appears in the output', () => {
  // Assembled from fragments at RUNTIME so no static `ghp_…` literal exists in
  // this source file — otherwise the repo's own secret scanner (the promotion
  // projection's real-repo smoke test, production-projection contract inv. 4)
  // would flag this very test as leaking a github-token. The runtime value is a
  // valid PAT shape (ghp_ + 20 chars) that the redactor's pattern still catches.
  const token = `ghp_${'A'.repeat(20)}`;
  // The token rides in the stage TITLE, which next.decide folds into its build
  // reason, which the projection surfaces as next.reason.
  const cwd = fixtureCwd([{ n: 1, title: `Deploy ${token}` }]);
  const snap = operator.snapshot(cwd, {
    snapshot: { online: true, issues: [], prs: [], tags: [] },
  });

  const serialized = JSON.stringify(snap);
  assert(!serialized.includes(token), 'no token shape survives anywhere in the output');
  assert(snap.next.reason.includes('[redacted]'), 'the reason carries the redacted marker');
});
