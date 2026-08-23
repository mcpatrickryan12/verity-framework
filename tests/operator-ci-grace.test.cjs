// Stage 69 (ADR-0027) — the CI-registration grace must apply THROUGH the operator
// projection, not only through next.dispatch. Stage 68 added the grace to the pure
// decision (`opts.now`); next.dispatch injects the clock, but operator.cjs's own
// callers of next.decideStage/decide (work ~444, gateDescriptor ~548, gates ~600)
// and the snapshot's next.dispatch omitted `now` — so the guard fail-closed and
// projected a `ci:unverified` gate for a JUST-OPENED empty-CI PR. The benchmark's
// driveStatus reads the operator snapshot, so a fresh (fast-provider) PR looked
// gated and the drive loop stopped before review.
//
// These tests drive operator.snapshot/work/gates with an INJECTED snapshot fixture
// (a just-opened PR, EMPTY statusCheckRollup + a recent createdAt) and an INJECTED
// `now`, so the grace is exercised deterministically with ZERO wall clock:
//   - age < grace  ⇒ the stage/PR defers (waiting_for_ci), `next` is NOT a
//     ci:unverified gate, gates() lists nothing for it;
//   - age > grace  ⇒ the genuine ci:unverified gate fires exactly as before.
// Safety (ADR-0027): the grace only DEFERS the gate — the empty rollup is still
// unknown, still never green, so nothing advances to review/merge either way.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const operator = require('../verity/bin/lib/operator.cjs');

// A throwaway cwd with a stage-instructions/ dir holding the given stage specs.
function fixtureCwd(stages) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cigrace-'));
  const dir = path.join(cwd, 'stage-instructions');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of stages) {
    const deps = s.dependsOn?.length ? s.dependsOn.join(', ') : 'none';
    const body = `# Stage ${s.n}: ${s.title || `Stage ${s.n}`}\n\n- **Type:** feature\n- **Depends on:** ${deps}\n`;
    fs.writeFileSync(path.join(dir, `stage-${s.n}-slug.md`), body);
  }
  return cwd;
}

// A single stage whose OPEN PR reports NO CI checks yet (empty rollup ⇒
// CI_UNKNOWN, exactly the just-opened-PR race) and carries a registration
// timestamp the recency guard reads.
const CREATED_AT = '2026-08-11T17:00:00.000Z';
const CREATED_MS = Date.parse(CREATED_AT);
// Well inside / well past the default 90s CI_REGISTRATION_GRACE.
const RECENT_NOW = CREATED_MS + 10_000;
const AGED_NOW = CREATED_MS + 120_000;
// Stage 70: the local box's clock is ~8s BEHIND GitHub, so `now` is EARLIER than
// the PR's authoritative createdAt → age is negative (~-8s), within the bounded
// clock-skew tolerance. The just-opened PR must still defer, not false-gate.
const SKEWED_NOW = CREATED_MS - 8_000;

function freshPrSnapshot() {
  return {
    online: true,
    issues: [{ number: 101, title: '[stage 1] Core', state: 'OPEN', labels: [], assignees: [] }],
    prs: [
      {
        number: 201,
        title: '[stage 1] Core',
        state: 'OPEN',
        labels: [],
        // Empty rollup ⇒ CI_UNKNOWN — GitHub has not registered checks yet.
        statusCheckRollup: [],
        createdAt: CREATED_AT,
      },
    ],
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// snapshot: within the grace, `next` defers (not a ci:unverified gate).
// ---------------------------------------------------------------------------

test('snapshot: a just-opened empty-CI PR within the grace defers — next is not a ci:unverified gate', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  const snap = operator.snapshot(cwd, { snapshot: freshPrSnapshot(), now: RECENT_NOW });

  // Deferred (waiting_for_ci) — the decision is idle, so there is no next action.
  assertEqual(snap.next, null, 'within the grace snapshot.next defers (no gate projected)');
  // The stage buckets waiting_for_ci (its PR is building), never awaiting_approval.
  assertEqual(snap.queue.waiting_for_ci, 1, 'the fresh PR buckets waiting_for_ci');
  assertEqual(snap.queue.awaiting_approval, 0, 'the fresh PR is NOT bucketed awaiting_approval');
});

test('snapshot: a future-dated (clock-skew) just-opened PR defers — next is not a ci:unverified gate', () => {
  // Stage 70: the box is behind GitHub, so age is negative. The guard tolerates
  // bounded skew, so the operator projection defers just like the positive case.
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  const snap = operator.snapshot(cwd, { snapshot: freshPrSnapshot(), now: SKEWED_NOW });

  assertEqual(snap.next, null, 'a future-dated PR defers through the operator projection');
  assertEqual(snap.queue.waiting_for_ci, 1, 'the skewed fresh PR buckets waiting_for_ci');
  assertEqual(snap.queue.awaiting_approval, 0, 'it is NOT bucketed awaiting_approval');
});

test('snapshot: the SAME PR aged past the grace gates ci:unverified (no-now behavior, delayed)', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  const snap = operator.snapshot(cwd, { snapshot: freshPrSnapshot(), now: AGED_NOW });

  assert(snap.next !== null, 'past the grace snapshot.next is the ci:unverified gate');
  assert(
    typeof snap.next.reason === 'string' && snap.next.reason.includes('no CI checks at all'),
    'the gate reason is the genuine ci:unverified message',
  );
});

// ---------------------------------------------------------------------------
// work: the per-stage `next` mapping defers within the grace, gates past it.
// ---------------------------------------------------------------------------

test('work: the fresh PR item defers within the grace and gates past it', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);

  const within = operator.work(cwd, { snapshot: freshPrSnapshot(), now: RECENT_NOW });
  assertEqual(within.length, 1, 'one work item');
  assertEqual(within[0].bucket, 'waiting_for_ci', 'the item buckets waiting_for_ci');
  assertEqual(within[0].next, null, 'within the grace the item projects no ci:unverified gate');

  const past = operator.work(cwd, { snapshot: freshPrSnapshot(), now: AGED_NOW });
  assert(past[0].next !== null, 'past the grace the item projects the gate');
  assert(
    past[0].next.reason.includes('no CI checks at all'),
    'the projected gate is ci:unverified',
  );
});

// ---------------------------------------------------------------------------
// gates: no spurious gate within the grace; the real gate appears past it.
// ---------------------------------------------------------------------------

test('gates: no ci:unverified gate for a just-opened PR within the grace', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  // classify is READ-ONLY here and never reached for a deferred stage; stub it
  // so the test is hermetic regardless.
  const classify = () => ({ risk: 'low', files: [], reasons: [], checks_green: null });

  const within = operator.gates(cwd, { snapshot: freshPrSnapshot(), now: RECENT_NOW, classify });
  assertEqual(within.length, 0, 'within the grace the fresh PR is NOT surfaced as a gate');

  const past = operator.gates(cwd, { snapshot: freshPrSnapshot(), now: AGED_NOW, classify });
  assertEqual(past.length, 1, 'past the grace the genuine ci:unverified gate appears');
  assertEqual(past[0].gate, 'ci:unverified', 'the gate is ci:unverified');
});

// ---------------------------------------------------------------------------
// ciGraceMs is injectable end-to-end (a 0-length grace gates immediately).
// ---------------------------------------------------------------------------

test('a zero-length injected grace gates a just-opened PR immediately (ciGraceMs threads through)', () => {
  const cwd = fixtureCwd([{ n: 1, title: 'Core' }]);
  const snap = operator.snapshot(cwd, {
    snapshot: freshPrSnapshot(),
    now: RECENT_NOW,
    ciGraceMs: 0,
  });
  assert(snap.next !== null, 'with a 0ms grace even a 10s-old PR gates');
  assert(snap.next.reason.includes('no CI checks at all'), 'the immediate gate is ci:unverified');
});
