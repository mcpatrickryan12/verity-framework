// `verity next` — the autonomy dispatch decision (verity-autonomy-technical-sketch.md §3.1).
// A thin, read-only DERIVE layer over the existing dependency engine (ledger.cjs):
// it answers "what single thing should an agent do now?" as one structured object.
//
// Output contract (frozen, consumed by the worker run loop):
//   { schema: 1, action: work|gated|idle, role?, args?, gate, target, reason }
// Stage 22 (issue #59) adds ONE additive field: a gated decision derived from
// an outstanding `verity:awaiting-approval` label carries `announced: true` —
// the pause is already visible on GitHub. Absence means nobody has told the
// human yet (default-closed: the worker announces), so a freshly-derived gate
// (e.g. ci:unverified read straight off the CI state) never carries it.
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
//
// Stage 19 (issue #50) adds one more mapping, for the CI state the ledger can
// now tell apart (ledger.rollupState → green | red | UNKNOWN):
//   - unblocked, PR open, CI unknown (no checks reported AT ALL)
//                                             → gated; gate = "ci:unverified"
// This is where the third state has to be spent, because this is the decision
// that costs a model run. A never-verifiable PR previously read as plain
// `building`, so every tick answered it with `work role=build` and burned a
// full run getting nowhere. Gating instead hands it to a human — the honest
// answer, since Verity genuinely cannot say whether the stage is green — and
// reuses the machinery that already exists for every other gate.
//
// The operator can opt out with limits.unverified_ci_behavior:
// 'allow_without_merge' (ADDITIVE, DEFAULT-CLOSED — absence and every other
// value gate), for repositories that legitimately have no CI. It advances the
// stage to `review` rather than looping on `build`; it does NOT lower the merge
// bar, because merge still requires a VERIFIED green reading (trust.checksGreen
// for the autonomous ladder, review.canMerge for the CLI), which an unverified
// PR can never produce.
//
// Stage 20 (issue #60) adds the mapping that outranks every other one:
//   - the GitHub snapshot could not be READ at all (or only in half)
//                                             → gated; gate = "state:unverified"
// Same shape, same machinery, one layer earlier: stage 19 taught that a CI
// state Verity cannot verify is its own state, and this is that rule applied to
// the snapshot the CI state is read FROM. It is deliberately `gated` and not
// `idle` — idle asserts "Verity looked and there is no work", which is exactly
// the confident falsehood this stage exists to make impossible. There is no
// opt-out knob: `unverified_ci_behavior` is a judgement about a repository with
// no CI, not a licence to dispatch against a state nobody observed.
//
// Stage 27 (canary re-run defect 4) applies stage 5's parking rule to the one
// tier that missed it, and stops a waiting stage from starving the queue.
// decide() walks the WHOLE unblocked list in dependency order instead of only
// its head, and per candidate:
//   - `verity:needs-human` on the stage's issue OR PR (the same label union as
//     the gate read) PARKS it: skipped entirely — never selected, never
//     announced, never re-announced. The scanner has dropped escalated items
//     from every labeled tier since stage 5; the operator's label is the whole
//     record, so the skip writes nothing. Removing the label restores exactly
//     the behavior below.
//   - a stage waiting at an ANNOUNCED gate (the awaiting-approval label is on
//     GitHub) keeps waiting but stops blocking: the next candidate gets its
//     decision. A visible pause must not starve the work behind it.
//   - a FRESH (unannounced) gate still takes the tick — stage 22's
//     announce-once means the pause becomes visible BEFORE the queue is
//     allowed to drain around it; from the next tick on it no longer blocks.
//   - the first workable stage wins, exactly as before.
// When nothing is workable, an announced gate (if any) is returned unchanged —
// the stage-22 steady state — else idle, with a reason that names any parked
// stages so "no eligible work" never hides an operator's park.
const autonomy = require('./autonomy.cjs');
const { LABELS } = require('./labels.cjs');
const ledger = require('./ledger.cjs');
const stateSnapshot = require('./agents/state-snapshot.cjs');
const substrateLocal = require('./substrate-local.cjs');

const SCHEMA = 1;
const GATE_LABEL = 'verity:awaiting-approval';
const APPROVED_LABEL = 'verity:approved';
// Stage 27: the operator's parking mark, looked up from the shared T02 label
// vocabulary — the same source the worker's NEEDS_HUMAN_LABEL comes from
// (scanner.cjs can't be required here: it requires this module).
const NEEDS_HUMAN_LABEL = LABELS.find((l) => l.name === 'verity:needs-human').name;
// The gate a stage pauses at when its PR reports no checks at all.
const CI_GATE = 'ci:unverified';
// The gate the WHOLE repository pauses at when its state could not be read.
const STATE_GATE = 'state:unverified';
// The ONE opt-out value. Anything else — including absence, null, and every
// typo — resolves to gating (default-closed, like the rest of the schema).
const ALLOW_WITHOUT_MERGE = 'allow_without_merge';
// Stage 68 (ADR-0027): a just-opened PR whose CI checks GitHub has NOT yet
// registered reads as an empty rollup → CI_UNKNOWN, indistinguishable from a
// repository with no CI. Within this bounded window after the PR was opened the
// ci:unverified gate is DEFERRED: the stage reports `waiting_for_ci` (below)
// instead of gating a healthy PR for a human. Once the PR is OLDER than the
// grace with STILL-empty CI it gates exactly as today (the genuine "no CI"
// case, merely delayed). The grace defers the GATE only — it never advances a
// stage to review/merge (empty ⇒ unknown ⇒ never green; rollupState unchanged).
const CI_REGISTRATION_GRACE = 90_000;
// Stage 70 (ADR-0027): the bounded clock-skew tolerance for the recency guard.
// `createdAt` is GitHub's AUTHORITATIVE timestamp; the local box's clock is not.
// When the local clock runs behind GitHub (ordinary NTP skew — a live box was
// measured ~7.5s behind), a just-opened PR's `createdAt` is slightly FUTURE-
// dated vs `Date.now()`, so `age = now - registeredAt` is negative. A strict
// `age >= 0` lower bound fail-closes those healthy fresh PRs into the gate. We
// therefore tolerate a bounded NEGATIVE age (past OR near-future within skew) as
// "just opened" and defer. The bound stays generous but finite so a wildly-
// future timestamp (`age <= -MAX_CLOCK_SKEW_MS`, implausible for a real GitHub
// PR) still gates — fail-closed on the absurd case.
const MAX_CLOCK_SKEW_MS = 300_000;
// A recency-deferred stage carries this on its (non-gated, non-work) decision:
// it is not a human gate (no awaiting-approval, no announce) and not workable
// yet (no build/review dispatch) — the honest "CI is still registering" answer.
// It maps to the operator snapshot's existing `waiting_for_ci` bucket (the PR's
// stage derives as `building`, which that bucket already counts), so
// benchmark.driveStatus reads it as `working` and keeps driving.
const WAITING_FOR_CI = 'waiting_for_ci';

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

function idle(proj, parked = []) {
  let reason = 'no unblocked stages';
  if (proj.stages.length === 0) {
    reason = 'no stages defined';
  } else if (proj.stages.every((s) => s.status === 'merged')) {
    reason = 'all stages merged';
  } else if (parked.length > 0) {
    // Stage 27: "no eligible work" must never hide an operator's park — say
    // which stage(s) a human took out of the queue and how to put them back.
    reason = `stage${parked.length === 1 ? '' : 's'} ${parked.join(', ')} parked (${NEEDS_HUMAN_LABEL} — remove the label to resume); no other unblocked work`;
  }
  return { schema: SCHEMA, action: 'idle', gate: null, target: null, reason };
}

// Is this stage's PR one whose CI Verity cannot verify? True ONLY when the
// snapshot actually contains the PR record and that record's check set is
// empty. A snapshot with no `prs` array (an injected or offline projection) is
// not evidence of an empty check set — absence of data is not "unknown CI", and
// treating it as such would gate every offline caller.
function ciUnverified(stage, snapshot) {
  if (stage.pr === null || stage.pr === undefined) {
    return false;
  }
  const pr = (snapshot.prs || []).find((p) => p.number === stage.pr);
  return pr !== undefined && ledger.ciStateOf(pr) === ledger.CI_UNKNOWN;
}

// Pure decision over the ledger projection + raw GitHub snapshot (for labels
// and the three-state CI reading) — unit-testable without network, like
// ledger.project(). `opts.unverifiedCi` is the policy knob; fail-closed.
function decide(proj, snapshot = {}, opts = {}) {
  // Stage 20 (issue #60): an unfetched snapshot is not an empty one. Checked
  // before EVERYTHING — before idle, before the label gate, before the CI
  // states — because every reading below (proj.next, the label sets, the check
  // rollups) is derived from a snapshot that was never observed. There is no
  // honest decision to make from it, so the only honest answer is the pause.
  if (!ledger.snapshotVerified(snapshot)) {
    return {
      schema: SCHEMA,
      action: 'gated',
      gate: STATE_GATE,
      target: null,
      reason: ledger.unverifiedMessage(snapshot),
    };
  }
  // Stage 27: walk the whole unblocked list (dependency order unchanged) so a
  // parked or already-announced-gated head of the line cannot starve the
  // stages behind it — the same "drop the waiting item, pick from the rest"
  // rule every scanner tier has applied since stage 5, on P5's own candidates.
  const parked = [];
  let waiting = null;
  for (const n of proj.next) {
    const stage = proj.stages.find((s) => s.number === n);
    // Union of the work-item issue's and the PR's labels — the same read the
    // gate check below uses (T14: the label lives on whichever item carried it).
    const labels = new Set([
      ...issueLabels(stage.issue, snapshot),
      ...prLabels(stage.pr, snapshot),
    ]);
    if (labels.has(NEEDS_HUMAN_LABEL)) {
      // Parked by a human (stage 5 semantics): never selected, never
      // announced. The label itself is the visible record — writing anything
      // here would be the exact re-announcement noise the canary hit.
      parked.push(n);
      continue;
    }
    const decision = decideStage(n, stage, labels, snapshot, opts);
    // Stage 68 (ADR-0027): a stage whose ci:unverified gate is DEFERRED because
    // its PR was just opened (CI still registering) keeps waiting but stops
    // blocking — the same "drop the waiting item, pick from the rest" rule an
    // announced gate uses below. If nothing else is workable it is returned, so
    // the tick reports `waiting_for_ci` rather than a bare idle that would read
    // as "nothing to do". It NEVER takes the tick as work and NEVER gates.
    if (decision.status === WAITING_FOR_CI) {
      if (waiting === null) {
        waiting = decision;
      }
      continue;
    }
    if (decision.action === 'gated' && decision.announced === true) {
      // The pause is already visible on GitHub — keep waiting, stop blocking.
      if (waiting === null) {
        waiting = decision;
      }
      continue;
    }
    // Stage 77: serialize build-through under auto-merge. A FRESH build for a
    // LATER stage (action work, role build, and NO PR yet — target.kind is not
    // 'pr') while an EARLIER stage is still in flight (already stashed as
    // `waiting`: waiting_for_ci or an announced gate) would open a SECOND
    // concurrent PR before the first merges — so this stage forks off a base
    // that does not yet contain its predecessor (the exact conflict this stage
    // fixes). Under review trust >= 1 (auto-merge), skip it so the tick falls
    // through to `return waiting` and each stage forks off a base already
    // containing the ones before it. Gated STRICTLY on trust >= 1: at trust 0 /
    // undefined the run gates after one stage anyway, so behaviour is byte-
    // identical. A re-build of an existing PR (target.kind 'pr') and any
    // review/merge decision are NOT suppressed — they advance the in-flight
    // stage, which is the goal.
    if (
      waiting !== null &&
      typeof opts.reviewTrust === 'number' &&
      opts.reviewTrust >= 1 &&
      decision.action === 'work' &&
      decision.role === 'build' &&
      decision.target?.kind !== 'pr'
    ) {
      continue;
    }
    // Workable, or a FRESH gate that must take the tick (stage 22
    // announce-once: the pause becomes visible before the queue drains on).
    return decision;
  }
  if (waiting !== null) {
    return waiting;
  }
  return idle(proj, parked);
}

// The per-stage mapping (engine state → contract decision), exactly as decide()
// applied it to proj.next[0] before stage 27 taught the caller to iterate.
function decideStage(n, stage, labels, snapshot, opts) {
  const unverified = ciUnverified(stage, snapshot);
  const allowUnverified = opts.unverifiedCi === ALLOW_WITHOUT_MERGE;
  // An unverified PR is not red — it was never checked. Under the opt-out the
  // stage therefore ADVANCES to review instead of looping on build (the merge
  // itself stays gated on a verified-green reading, elsewhere). Under the
  // default this only shapes the gate's reported role; the gate returns below.
  const inReview = stage.status === 'in-review' || (unverified && allowUnverified);
  const role = inReview ? 'review' : 'build';
  const args = stage.pr === null ? [String(n)] : [String(n), String(stage.pr)];
  let target = { kind: 'stage', number: n };
  if (stage.pr !== null) {
    target = { kind: 'pr', number: stage.pr };
  } else if (stage.issue !== null) {
    target = { kind: 'issue', number: stage.issue };
  }

  // The gate label lives on whichever item the worker's GATE_PAUSE targeted
  // (PR for review:merge) — `labels` is the caller's issue∪PR union.
  if (labels.has(GATE_LABEL) && !labels.has(APPROVED_LABEL)) {
    // Name the gate for the reason it is actually there. When the CI is
    // unverifiable, the outstanding label gate IS the ci:unverified gate the
    // previous tick paused at — reporting it as the paused ROLE would make
    // consecutive ticks describe the same pause two different ways.
    const gate = inReview ? 'review:merge' : unverified ? CI_GATE : role;
    return {
      schema: SCHEMA,
      action: 'gated',
      role,
      args,
      gate,
      target,
      reason: `stage ${n} paused at human gate ${gate} (${GATE_LABEL})`,
      // Stage 22: the gate label IS the announcement — a previous GATE_PAUSE
      // (or a human) already made this pause visible on GitHub, so the worker
      // must not announce it again on every tick.
      announced: true,
    };
  }

  // Stage 19: CI Verity cannot verify. Checked AFTER the label gate so an
  // explicit human gate keeps reporting itself exactly as it always has.
  if (unverified && !allowUnverified) {
    // Stage 68 (ADR-0027): the recency guard. An empty rollup on a JUST-OPENED
    // PR is very likely GitHub not having registered its checks yet, not a repo
    // with no CI. When the PR carries a registration timestamp AND is younger
    // than the grace, DEFER the gate: report `waiting_for_ci` (non-terminal — no
    // gate, no awaiting-approval, no review dispatch) so a healthy PR is not
    // parked for a human seconds before its CI reports. `now` and the grace are
    // INJECTED via `opts` so the decision stays PURE (tests never touch the wall
    // clock); the outermost real caller (dispatch) passes Date.now(). FAIL-
    // CLOSED: with NO clock (a pure/legacy caller that passes no `now`) OR NO
    // timestamp (an old/injected snapshot), the guard does nothing and the gate
    // fires exactly as before — "no timestamp" is NEVER read as "recent". The
    // guard defers the gate ONLY; the empty rollup is still unknown, still never
    // green, so no path advances to review/merge on non-green CI.
    const pr =
      stage.pr === null || stage.pr === undefined
        ? undefined
        : (snapshot.prs || []).find((p) => p.number === stage.pr);
    const now = typeof opts.now === 'number' ? opts.now : null;
    const graceMs =
      typeof opts.ciGraceMs === 'number' && opts.ciGraceMs >= 0
        ? opts.ciGraceMs
        : CI_REGISTRATION_GRACE;
    const registeredAt = ledger.prRegisteredAt(pr);
    if (now !== null && registeredAt !== null) {
      const age = now - registeredAt;
      // Stage 70: tolerate bounded clock skew. A negative `age` means the local
      // clock is behind GitHub's authoritative `createdAt`; a PR whose createdAt
      // is within skew-tolerance of now (past OR near-future) is JUST-OPENED →
      // defer. A genuinely old PR (age >= graceMs) still gates; a wildly-future
      // timestamp (age <= -MAX_CLOCK_SKEW_MS) still gates (fail-closed on absurd).
      if (age > -MAX_CLOCK_SKEW_MS && age < graceMs) {
        return {
          schema: SCHEMA,
          // NOT `gated` (no human park) and NOT `work` (no dispatch): the
          // scanner's P5 tier yields nothing for a non-work decision and the
          // worker announces nothing for a non-gated one, so the tick idles
          // cleanly while CI registers — no model run, no awaiting-approval
          // label. The `status` marker is what carries the real state to the
          // operator snapshot / the decide() loop above.
          action: 'idle',
          role,
          args,
          gate: null,
          target,
          status: WAITING_FOR_CI,
          reason: `stage ${n}: PR #${stage.pr} reports no CI checks yet — GitHub may not have registered them (PR opened ${Math.max(0, Math.round(age / 1000))}s ago, within the ${Math.round(graceMs / 1000)}s CI-registration grace). Waiting for CI to register before deciding — not gating, and NOT merging (nothing merges on unverified CI)`,
        };
      }
    }
    return {
      schema: SCHEMA,
      action: 'gated',
      role,
      args,
      gate: CI_GATE,
      target,
      // Stage 22: this reason is what the worker's gate comment shows the
      // operator, so it names the cause, the remedy's exact scope, and the
      // honest limit — approving lets the run proceed, it does NOT verify CI.
      reason: `stage ${n}: PR #${stage.pr} reports no CI checks at all — Verity cannot verify it is green (this repository may have no CI configured), so a human decides. Approving lets the stage proceed WITHOUT merging — approval does not make CI green, and nothing merges on unverified CI`,
    };
  }

  let reason = `stage ${n} (${stage.title}) is unblocked for build`;
  if (unverified) {
    reason = `PR #${stage.pr} for stage ${n} is ready for review with CI UNVERIFIED (no checks reported) — limits.unverified_ci_behavior is ${ALLOW_WITHOUT_MERGE}; the merge gate still requires verified green`;
  } else if (inReview) {
    reason = `PR #${stage.pr} awaiting review for stage ${n}`;
  } else if (stage.status === 'building') {
    reason = `PR #${stage.pr} for stage ${n} is open with CI not green`;
  }
  return { schema: SCHEMA, action: 'work', role, args, gate: null, target, reason };
}

function exitCodeFor(decision) {
  return decision.action === 'gated' ? 10 : 0;
}

// Resolve the unverified-CI knob. An explicit flag wins (the worker passes one
// when a human has just approved this very item); otherwise it comes from the
// same policy the worker loads, so `verity next` and the worker can never give
// different answers. Any problem reading the policy — missing file, invalid
// YAML, no `.verity` at all — resolves to the closed default: a policy Verity
// cannot read never opens a gate.
function resolveUnverifiedCi(flags, cwd) {
  if (typeof flags['unverified-ci'] === 'string') {
    return flags['unverified-ci'];
  }
  try {
    return autonomy.loadPolicy(cwd).limits.unverified_ci_behavior;
  } catch {
    return undefined;
  }
}

// Stage 77: resolve the review trust for the build-through serialization guard,
// the SAME way resolveUnverifiedCi resolves its knob — off the policy the worker
// loads, so `verity next` and the worker never disagree. Any problem reading it
// (missing file, invalid YAML, no `.verity`) fails CLOSED to undefined, which is
// trust < 1: the guard stays off and trust-0 behaviour is byte-identical.
function resolveReviewTrust(cwd) {
  try {
    return autonomy.loadPolicy(cwd).review.trust;
  } catch {
    return undefined;
  }
}

function dispatch(_args, flags, opts = {}) {
  const cwd = flags.cwd || process.cwd();
  // Stage 34: `--repo` (additive) aims the snapshot at a named repository;
  // fetchSnapshot resolves flag → GH_REPO → cwd remotes, so the worker's scan
  // path is covered by the GH_REPO its runOnce already exports (stage 29).
  // Stage 80 (ADR-0029): the snapshot ACQUIRER is the delivery-substrate seam —
  // the stage-79 `policy.substrate` selects the local driver
  // (substrate-local.fetchLocalSnapshot) when 'local'; 'github'/absent routes to
  // ledger.fetchSnapshot with identical args (byte-identical). decide() below is
  // substrate-blind: it consumes whichever snapshot arrives, unchanged.
  const snapshot =
    opts.snapshot || substrateLocal.fetchSubstrateSnapshot(cwd, { repo: flags.repo });
  const proj = ledger.project(cwd, { snapshot });
  const decision = decide(proj, snapshot, {
    unverifiedCi: resolveUnverifiedCi(flags, cwd),
    // Stage 77: the review trust gates build-through serialization. Resolved
    // here (never inside decide/decideStage — they stay pure and read `opts`)
    // from the same policy the worker loads. Fail-closed to undefined (< 1), so
    // the guard is off and trust-0 behaviour is byte-identical.
    reviewTrust: resolveReviewTrust(cwd),
    // Stage 68 (ADR-0027): the outermost real caller stamps the clock for the
    // ci:unverified recency guard. `decide`/`decideStage` stay pure — they read
    // `opts.now`, never Date.now(). Injectable (opts.now / opts.ciGraceMs) so
    // tests drive the guard deterministically without the wall clock.
    now: typeof opts.now === 'number' ? opts.now : Date.now(),
    ciGraceMs: opts.ciGraceMs,
  });
  // Stage 24 (ADR-0013): a contained role cannot read GitHub, so the facts its
  // workflow needs (stage status, the `next` list, dependency/PR/CI state)
  // travel WITH the work decision — derived from the SAME verified snapshot
  // the decision itself came from, so stage 20 stays binding by construction:
  // an unverified snapshot never reaches this branch (it gated above), and a
  // gated/idle decision dispatches nobody, so it carries nothing. Additive and
  // DEFAULT-CLOSED: only a caller that asks (the worker, for a contained
  // dispatch) gets the field — the CLI output and every existing consumer are
  // byte-identical without it.
  if (opts.withFacts === true && decision.action === 'work') {
    decision.facts = stateSnapshot.build(proj, snapshot, decision);
  }
  return decision;
}

module.exports = {
  decide,
  // Stage 48: the per-stage mapping and the knob resolver are exported (pure,
  // read-only) so the operator projection (operator.cjs) reuses the REAL next
  // derivation for its `work` items' `next` field instead of forking a second
  // copy of the engine→contract mapping.
  decideStage,
  resolveUnverifiedCi,
  resolveReviewTrust,
  dispatch,
  exitCodeFor,
  SCHEMA,
  GATE_LABEL,
  APPROVED_LABEL,
  CI_GATE,
  STATE_GATE,
  ALLOW_WITHOUT_MERGE,
  CI_REGISTRATION_GRACE,
  MAX_CLOCK_SKEW_MS,
  WAITING_FOR_CI,
};
