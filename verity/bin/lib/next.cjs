// `verity next` — the autonomy dispatch decision (verity-autonomy-technical-sketch.md §3.1).
// A thin, read-only DERIVE layer over the existing dependency engine (ledger.cjs):
// it answers "what single thing should an agent do now?" as one structured object.
//
// Output contract (frozen, consumed by the worker run loop):
//   { schema: 1, action: work|gated|idle, role?, args?, gate, target, reason }
// Exit codes (applied by the dispatcher): 0 = work or idle, 10 = gated.
// Never nonzero for "no work".
//
// State mapping (engine → contract) — the ledger has no native "gated" state, so
// gating is read from the T02 label vocabulary on the stage's work-item issue
// OR its PR (the union of both label sets):
//   - no unblocked stage                      → idle
//   - unblocked, status planned/claimed       → work, role build, target issue/stage
//   - unblocked, status building (CI red PR)  → work, role build, target pr
//   - unblocked, status in-review (green PR)  → work, role review, target pr
//   - issue OR PR labeled `verity:awaiting-approval` (and NOT `verity:approved`)
//                                             → gated; gate = "review:merge" when the
//                                               pause point is the PR merge, else the
//                                               paused role name (e.g. "build")
// The PR's labels count too (T14 integration fix): the worker's GATE_PAUSE
// labels the gate's GitHub TARGET, which for a review:merge gate is the PR —
// possibly with no work-item issue, or a different issue than the run's
// anchor. Reading only the issue made a gated PR look like fresh review work
// on the next tick: the worker re-ran the review role (burning tokens) and
// re-gated, forever, until a human acted.
// `verity:approved` is the single-use resume token (SKETCH §1): its presence
// alongside awaiting-approval reads as "human said go", so the item is work again
// (the worker consumes/removes the label — that is T10's job, not ours).
const ledger = require('./ledger.cjs');

const SCHEMA = 1;
const GATE_LABEL = 'verity:awaiting-approval';
const APPROVED_LABEL = 'verity:approved';

function labelSet(item) {
  const labels = item?.labels || [];
  return new Set(labels.map((l) => String(typeof l === 'string' ? l : l.name || '').toLowerCase()));
}

function issueLabels(issueNumber, snapshot) {
  if (issueNumber === null || issueNumber === undefined) {
    return new Set();
  }
  return labelSet((snapshot.issues || []).find((i) => i.number === issueNumber));
}

function prLabels(prNumber, snapshot) {
  if (prNumber === null || prNumber === undefined) {
    return new Set();
  }
  return labelSet((snapshot.prs || []).find((p) => p.number === prNumber));
}

function idle(proj) {
  let reason = 'no unblocked stages';
  if (proj.stages.length === 0) {
    reason = 'no stages defined';
  } else if (proj.stages.every((s) => s.status === 'merged')) {
    reason = 'all stages merged';
  }
  return { schema: SCHEMA, action: 'idle', gate: null, target: null, reason };
}

// Pure decision over the ledger projection + raw GitHub snapshot (for labels) —
// unit-testable without network, like ledger.project().
function decide(proj, snapshot = {}) {
  const n = proj.next[0];
  if (n === undefined) {
    return idle(proj);
  }
  const stage = proj.stages.find((s) => s.number === n);
  const inReview = stage.status === 'in-review';
  const role = inReview ? 'review' : 'build';
  const args = stage.pr === null ? [String(n)] : [String(n), String(stage.pr)];
  let target = { kind: 'stage', number: n };
  if (stage.pr !== null) {
    target = { kind: 'pr', number: stage.pr };
  } else if (stage.issue !== null) {
    target = { kind: 'issue', number: stage.issue };
  }

  // Union of the work-item issue's and the PR's labels — the gate label lives
  // on whichever item the worker's GATE_PAUSE targeted (PR for review:merge).
  const labels = new Set([...issueLabels(stage.issue, snapshot), ...prLabels(stage.pr, snapshot)]);
  if (labels.has(GATE_LABEL) && !labels.has(APPROVED_LABEL)) {
    const gate = inReview ? 'review:merge' : role;
    return {
      schema: SCHEMA,
      action: 'gated',
      role,
      args,
      gate,
      target,
      reason: `stage ${n} paused at human gate ${gate} (${GATE_LABEL})`,
    };
  }

  let reason = `stage ${n} (${stage.title}) is unblocked for build`;
  if (inReview) {
    reason = `PR #${stage.pr} awaiting review for stage ${n}`;
  } else if (stage.status === 'building') {
    reason = `PR #${stage.pr} for stage ${n} is open with CI not green`;
  }
  return { schema: SCHEMA, action: 'work', role, args, gate: null, target, reason };
}

function exitCodeFor(decision) {
  return decision.action === 'gated' ? 10 : 0;
}

function dispatch(_args, flags, opts = {}) {
  const cwd = flags.cwd || process.cwd();
  const snapshot = opts.snapshot || ledger.fetchSnapshot(cwd);
  return decide(ledger.project(cwd, { snapshot }), snapshot);
}

module.exports = { decide, dispatch, exitCodeFor, SCHEMA, GATE_LABEL, APPROVED_LABEL };
