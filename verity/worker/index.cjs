#!/usr/bin/env node
// verity-worker — the autonomy orchestrator bin (T10, SKETCH §4).
//
//   verity-worker --repo owner/name --once        # cron / Actions driver
//   verity-worker --repo owner/name --watch       # T17 — exits 30 "not-implemented"
//
// One --once run is the §4.4 state machine, exactly:
//   select item (scanner §4.2) → acquire lock (§4.3) → loop {
//     plan = `verity next` (module API — ground truth every iteration);
//     idle → SUMMARIZE(success); gated → GATE_PAUSE;
//     limits (max_chained_roles / max_tokens_per_run / max_wall_clock_min)
//       → SUMMARIZE(limit_hit);
//     no-progress strike (stage 19): the same role at the same GitHub target
//       for the MAX_REPEAT_DISPATCHES'th time — counted ACROSS ticks from the
//       item's own §7 run-summary trail plus within this run — → needs-human
//       label + SUMMARIZE(failed), BEFORE any dispatch, so the refused tick
//       costs zero model runs;
//     res = agent-exec role (module API);
//     gated → GATE_PAUSE; failed → 2-strike via unlock-comment counting
//       (locks.countFailures + 1 for the current strike) → needs-human label +
//       SUMMARIZE(failed), else SUMMARIZE(failed_once) — and when the failed
//       role's cost is UNKNOWN under unknown_cost_behavior 'gate', the run
//       ALSO parks at the unknown-cost gate (stage 25: label + comment +
//       gate-stamped ledger rows, so the next tick's budget refusal stays
//       visible and approvable instead of wedging the day);
//     infra_error → SUMMARIZE(infra), NO needs-human;
//     est_usd null (unknown cost, ADR-0008) → limits.unknown_cost_behavior:
//       gate → GATE_PAUSE; fail → SUMMARIZE(failed); allow_with_token_limit
//       → proceed (token ceilings remain the bound; null NEVER counts as $0);
//     success → loop }
// Stage 9 (ADR-0005/0007): the run resolves ONE immutable agent config from
// the policy's `agent` block (provider claude|codex, model, sandbox/approval
// narrowing overrides) and passes it — plus the REMAINING wall-clock budget
// as --timeout-secs, shrinking monotonically — into every chained dispatch.
// plus the T13 trust ladder (§4.5): when the REVIEW role completes with
// outcome success, its verdict (`artifacts.verdict` in the T05 marker —
// 'approve' | 'request_changes') is applied deterministically HERE:
//   trust 0 → never merge (gate); trust 1 → trust.classify() low-risk →
//   `gh pr merge --squash`, else gate; trust 2 → merge if checks green.
// Merge authority lives in this worker, never in the review agent — the
// review allowlist (T06) has no merge tool, and a success WITHOUT an explicit
// approve verdict gates (fail closed; it never merges and never loops).
// And two deliberate, documented extensions of the frozen sketch:
//   - a P4 request's FIRST iteration dispatches role `plan` on the request
//     issue (the dependency engine knows stages, not requests — without this a
//     fresh request would read as idle and never get planned);
//   - a role result of `gated` (the agent-exec marker outcome) routes to
//     GATE_PAUSE too; the §4.4 listing omits the branch but agent-exec defines
//     gated as "a human gate blocks progress", and looping on it would spin.
//
// Stage 20 (issue #60): `verity next` can also report that it could not READ
// GitHub state at all (gate `state:unverified`). That is NOT a human gate and
// does not take GATE_PAUSE — labeling and commenting would write to the very
// API that just failed. It stops the run as `infra` (exit 30) from the loop, or
// refuses at startup with slug `state-unverified` when the scan found nothing:
// a wasted model run against a state nobody verified is strictly worse than a
// clear stop, and an idle exit 0 would read as "all quiet".
//
// Stage 19 (issue #50): `verity next` now distinguishes a PR whose CI is RED
// from one whose CI is UNVERIFIABLE (no checks reported at all — the repository
// may have no CI). The latter arrives here as a plain `gated` decision at gate
// `ci:unverified`. When a labeled tier (P1–P4) selected the item, the run loop
// routes it through GATE_PAUSE below like any other gate; when ONLY the P5
// dependency engine can see the stage, the scanner yields no item — canary run
// 3 parked there as plain `idle`, invisibly — so runOnce announces the gate
// itself through the same GATE_PAUSE + SUMMARIZE machinery before the empty
// scan can read as idle (stage 22, issue #59). `verity next` marks a
// label-derived gate `announced: true`, so an already-visible pause is never
// re-announced on every cron tick. Either way nothing new is duplicated and
// nothing merges on unverified CI. A P1 item —
// one whose single-use `verity:approved` token this run consumes — passes
// `unverified-ci: allow_without_merge` into that call, because the human
// decision the gate asks for has just been made, for this run only.
//
// Stage 24 (ADR-0013): under containment a role computes; Verity talks to
// GitHub. Two seams, both here because this worker is the dispatcher:
//   - PRE-DISPATCH: `verity next` is asked for the FACTS a contained role's
//     workflow needs (opts.withFacts — stage status, the next list,
//     dependency/PR/CI state), derived from the SAME verified snapshot the
//     dispatch decision came from (stage 20 stays binding), and passed to
//     agent-exec as --state-snapshot for codex dispatches only. Claude
//     dispatches are byte-identical — its harness reads GitHub itself.
//   - POST-DISPATCH: performResultEffects() performs the GitHub writes a
//     role's T05 marker DECLARES (`artifacts.effects`, additive and
//     DEFAULT-CLOSED: absent field = nothing performed). Recognized today:
//     `findings_comment` — the review findings body, posted on the PR with the
//     run id (mirroring ADR-0012's attributable commits). An effect the worker
//     does not recognize is ignored with a logged note — never executed, never
//     guessed at, never fatal. Merge authority is NOT an effect: the trust
//     ladder below stays the only merge path.
//
// GATE_PAUSE: label `verity:awaiting-approval`, comment what's pending + the
// exact approval action + @mentions from notify.mention → SUMMARIZE(gated).
// The label + comment go on the gate's GitHub TARGET (the issue/PR from the
// dispatch decision — for review:merge that is the PR), falling back to the
// run's anchor when the target is a bare stage. This is where the human is
// told to approve, so it is where `verity next` reads the gate from (T03/T14):
// labeling only the anchor (e.g. the originating request issue) left the gate
// invisible to the dependency engine — the worker re-selected the gated PR and
// re-ran review every tick (found by the T14 integration run; fixed there).
//
// Stage 31 (ADR-0014): the unknown-cost gate is a checkpoint, not a toll
// booth. When a role COMPLETES and parks at the unknown-cost gate, its T05
// result already persists under ~/.verity/logs/<run-id>/ — so the gate comment
// records a durable pointer (run id + role + PR + the PR's head SHA at park
// time), and consuming the single-use `verity:approved` RESUMES that exact
// result through the post-role path (trust ladder, §7 summary) with zero
// provider spawns, zero new tokens, and a VERIFIED zero cost on its ledger
// rows. Effects (ADR-0013) are NOT re-performed — they ran before the park.
// Fail-closed both ways: a moved PR head, a missing/unreadable parked file, or
// a non-success parked outcome refuses the resume LOUDLY and falls back to a
// fresh dispatch announced as a repurchase — an approval is never a no-op.
// Pre-completion gates (ci:unverified, review:merge, role-declared) and the
// stage-25 failed-run park record no pointer and keep their semantics
// byte-for-byte; claude never parks here (its costs are real numbers).
//
// SUMMARIZE posts the §7 run-summary comment (exact template, one append-only
// comment per run), calls the T11 recordUsage seam, and the lock is released
// in `finally` (§8.1). P1 items consume `verity:approved` before working (§1
// single-use token); the gate label comes off with it, otherwise `verity next`
// would immediately re-gate the just-approved item.
//
// Items: only kind issue|pr can carry a GitHub lock/labels/comments. A P5
// 'stage' target (no work-item issue yet) proceeds WITHOUT a GitHub lock; the
// summary anchors to the first issue/PR target the loop discovers, or falls
// back to stdout.
//
// Exit codes: success/gated/limit_hit → 0; failed/failed_once → 20; infra → 30.
// idle / locked-by-another-run / mode:manual → 0 (§8.5: a second concurrent
// start exits 0 within one scan). Every nonzero exit prints exactly one
// machine-parsable stderr line: `verity-worker: <code> <slug>: <message>` (§8.2).
//
// Startup (§4.1, T11+T12): the full fail-fast check sequence runs BEFORE
// scanning/locking and is read-only (no labels/comments). Order — local checks
// first so a refused start costs zero gh calls, then the network checks:
//   1. policy loads + validates              → 30 `bad-policy`
//   2. mode manual → "autonomy disabled"     → exit 0
//   3. daily limits (usage.csv, UTC, T11)    → 30 `daily-limit`
//      ...or, when a max_usd_per_day is set and today's ledger holds runs of
//      unknown cost, the budget cannot be VERIFIED (ADR-0008, stage 18)
//                                            → 30 `unknown-cost-budget`
//      ...UNLESS every such run ended parked at the unknown-cost gate
//      (stage 21, #58): then the refusal is deferred past the scan, and a P1
//      item's single-use `verity:approved` — the approval that gate's own
//      comment asked for — lets exactly that one run proceed. No P1 item →
//      the deferred refusal fires unchanged (still before any lock or label).
//   4. `gh auth status`                      → 30 `gh-auth`
//   5. bot identity (`gh api user`; lookup failure → `gh-auth`);
//      bot login ∈ policy humans (case-insensitive — GitHub logins are)
//                                            → 30 `bot-is-human`
//   6. any OPEN issue labeled verity:circuit-open (or breaker unreadable —
//      fail closed)                          → 30 `circuit-open`
// Every gh call the run makes targets the --repo repository (GH_REPO, set in
// runOnce — stage 29), never a cwd-derived remote: a clone with no remotes
// gets PAST the breaker check and refuses later, truthfully, as
// `git-unprovidable` (ADR-0012); `circuit-open` stays reserved for the actual
// kill switch and for genuine breaker-READ failures.
const agentExec = require('../bin/lib/agent-exec.cjs');
const autonomy = require('../bin/lib/autonomy.cjs');
const gates = require('../bin/lib/gates.cjs');
const gh = require('../bin/lib/gh.cjs');
const { LABELS } = require('../bin/lib/labels.cjs');
const ledger = require('../bin/lib/ledger.cjs');
const locks = require('../bin/lib/locks.cjs');
const next = require('../bin/lib/next.cjs');
const scanner = require('../bin/lib/scanner.cjs');
const stage = require('../bin/lib/stage.cjs');
const substrateLocal = require('../bin/lib/substrate-local.cjs');
const trust = require('../bin/lib/trust.cjs');
const usage = require('../bin/lib/usage.cjs');

const USAGE = 'usage: verity-worker --repo owner/name --once';
const APPROVAL_ACTION = 'apply label `verity:approved` or comment `/verity approve`';

function labelName(name) {
  const label = LABELS.find((l) => l.name === name);
  if (!label) {
    throw new Error(`verity-worker: ${name} missing from label vocabulary`);
  }
  return label.name;
}
const GATE_LABEL = labelName('verity:awaiting-approval');
const APPROVED_LABEL = labelName('verity:approved');
const NEEDS_HUMAN_LABEL = labelName('verity:needs-human');
const CIRCUIT_LABEL = labelName('verity:circuit-open');
// Stage 73 (#202): the P4 tier's plan trigger. The worker retires it from a
// request issue after a successful plan produces stages, so later ticks fall to
// P5 instead of re-anchoring P4 and re-planning an already-decomposed project.
const REQUEST_LABEL = labelName('verity:request');

// §7 "<outcome emoji+word>" vocabulary — one badge per SUMMARIZE outcome.
const OUTCOME_BADGES = {
  success: '✅ success',
  gated: '⏸️ gated',
  limit_hit: '🛑 limit_hit',
  failed: '❌ failed',
  failed_once: '⚠️ failed_once',
  infra: '💥 infra',
};

// §4.4 SUMMARIZE exit codes: success/gated/limit → 0; failed → 20; infra → 30.
// failed_once IS a failure (the unlock comment `outcome:failed_once` feeds the
// 2-strike counter), so it shares the failure exit code.
const EXIT_CODES = {
  success: 0,
  gated: 0,
  limit_hit: 0,
  failed: 20,
  failed_once: 20,
  infra: 30,
};

// stderr slugs for the nonzero outcomes (§8.2 single-line error format).
const ERROR_SLUGS = {
  failed: 'role-failed',
  failed_once: 'role-failed-once',
  infra: 'infra-error',
};

class WorkerError extends Error {
  constructor(message, slug) {
    super(message);
    this.name = 'WorkerError';
    this.exitCode = 30;
    this.slug = slug || 'internal';
  }
}

function oneLine(text) {
  return String(text ?? 'unknown error').split('\n')[0];
}

function lockable(item) {
  return item.kind === 'issue' || item.kind === 'pr';
}

function makeRunId(now = Date.now()) {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- GitHub item ops (issue AND pr — both are issues to the REST API) -------
//
// Stage 80 (ADR-0029, contract local-work-item v1): each op dispatches on the
// run's resolved substrate (ctx.substrate, stamped from policy.substrate in
// runOnce). 'local' routes to the engine-performed record edits in
// substrate-local.cjs (worker-owned commits, ADR-0026); anything else is the
// gh path, byte-identical to before the seam existed. Live since stage 83:
// assertSubstrateSupported now admits 'local' (the driver is complete).

function apiBase(ctx, number) {
  return `repos/${ctx.repo}/issues/${number}`;
}

function addLabel(ctx, number, label) {
  if (ctx.substrate === 'local') {
    substrateLocal.addLabel(ctx.cwd, number, label);
    return;
  }
  gh.run(['api', '-X', 'POST', `${apiBase(ctx, number)}/labels`, '-f', `labels[]=${label}`], {
    cwd: ctx.cwd,
  });
}

// Tolerates already-absent labels (HTTP 404) so consume/cleanup is idempotent.
// (The local op is idempotent on absence by construction — same end-state rule.)
function removeLabel(ctx, number, label) {
  if (ctx.substrate === 'local') {
    substrateLocal.removeLabel(ctx.cwd, number, label);
    return;
  }
  try {
    gh.run(['api', '-X', 'DELETE', `${apiBase(ctx, number)}/labels/${encodeURIComponent(label)}`], {
      cwd: ctx.cwd,
    });
  } catch (err) {
    if (err?.reason !== 'http-404') {
      throw err;
    }
  }
}

// Stage 85 (ADR-0029; stage-83 review): substrate-aware like the label ops
// above. Contract local-work-item v1 (FROZEN) has NO comment surface and must
// not grow one — so on 'local' the comment body lands on the run's log stream
// (ctx.stderr), headed with the record it addresses, and is NEVER silently
// dropped. The STRUCTURED half of every §7 summary already lands in the usage
// ledger (recordUsage → usage.csv — outcome, roles, tokens, cost, gate), which
// the operator surface reads (`operator runs` / snapshot worker.last_*, stage
// 85); this route carries the free text (findings bodies, gate instructions,
// the summary template) the ledger's columns cannot. github: byte-identical.
function postComment(ctx, number, body) {
  if (ctx.substrate === 'local') {
    ctx.stderr(
      `verity-worker: local comment for work-item #${number} (contract local-work-item v1 has no comment surface — recorded on the run log, structured facts in the usage ledger; stage 85, ADR-0029):\n${body}`,
    );
    return;
  }
  gh.run(['api', '-X', 'POST', `${apiBase(ctx, number)}/comments`, '-f', `body=${body}`], {
    cwd: ctx.cwd,
  });
}

// --- result-declared GitHub effects (stage 24, ADR-0013) ----------------------

// The effect vocabulary this worker recognizes from a role's T05 marker
// (`artifacts.effects`). Everything else is ignored with a logged note —
// Verity never guesses at a write it was not built to perform, and the merge
// levers stay out of the vocabulary on purpose (T13: merge authority is the
// trust ladder's, never a role's request).
const RECOGNIZED_EFFECTS = ['findings_comment'];

// Attribution mirrors the §7 templates: same worker voice, same run-id badge,
// and it says WHO actually performed the write — deterministic Verity code on
// the role's behalf, because the sandbox denies the role GitHub by design.
function formatFindingsComment({ runId, role, body }) {
  return [
    `🔎 **verity-worker** \`${runId}\` — ${role} findings (posted by Verity on the role's behalf, ADR-0013)`,
    '',
    body,
  ].join('\n');
}

// Perform the GitHub writes a role's result DECLARED. Default-closed: an
// absent `artifacts.effects` performs nothing and logs nothing. Best-effort
// like the §7 summary comment — a failed post is a loud warn, never a changed
// run outcome (the verdict/trust path below stays the deterministic spine).
function performResultEffects(ctx, { runId, role, res, pr }) {
  const effects = res.artifacts?.effects;
  if (effects === undefined) {
    return;
  }
  if (effects === null || typeof effects !== 'object' || Array.isArray(effects)) {
    ctx.stderr(
      `verity-worker: note: role ${role} declared a malformed effects block — ignored, never guessed at (ADR-0013)`,
    );
    return;
  }
  for (const [name, value] of Object.entries(effects)) {
    if (!RECOGNIZED_EFFECTS.includes(name)) {
      ctx.stderr(
        `verity-worker: note: ignoring unrecognized GitHub effect '${name}' declared by role ${role} — not in the recognized effect vocabulary (${RECOGNIZED_EFFECTS.join(', ')}), never executed (ADR-0013)`,
      );
      continue;
    }
    // findings_comment: the review findings body, posted on the run's PR.
    if (typeof value !== 'string' || value.trim() === '') {
      ctx.stderr(
        `verity-worker: note: effect findings_comment from role ${role} carries no body — nothing posted`,
      );
      continue;
    }
    if (!Number.isInteger(pr)) {
      ctx.stderr(
        `verity-worker: note: effect findings_comment from role ${role} has no PR to land on (artifacts.pr absent and none known this run) — nothing posted`,
      );
      continue;
    }
    try {
      postComment(ctx, pr, formatFindingsComment({ runId, role, body: value }));
    } catch (err) {
      ctx.stderr(
        `verity-worker: warn: failed to post the ${role} findings comment on #${pr}: ${oneLine(err.message)}`,
      );
    }
  }
}

// --- pure helpers (exported for tests) ---------------------------------------

// Per-run circuit breakers (§4.4). Returns the tripped limit's name or null.
function checkLimits(totals, limits, elapsedMs) {
  if (totals.chained >= limits.max_chained_roles) {
    return `max_chained_roles (${limits.max_chained_roles})`;
  }
  if (totals.tokens >= limits.max_tokens_per_run) {
    return `max_tokens_per_run (${limits.max_tokens_per_run})`;
  }
  if (elapsedMs >= limits.max_wall_clock_min * 60_000) {
    return `max_wall_clock_min (${limits.max_wall_clock_min})`;
  }
  return null;
}

// A role reported gated but the agent-exec result object carries no gate name;
// resolve it from the policy's gates (e.g. review → review:merge), else the role.
function gateNameFor(role, policy) {
  return (policy.gates || []).find((g) => g === role || g.startsWith(`${role}:`)) || role;
}

// The gate a run pauses at when a role's cost is unknown and
// limits.unknown_cost_behavior is 'gate' (ADR-0008 — the default until a
// provider's cost accounting is proven). Single-sourced from the usage ledger
// (stage 21): SUMMARIZE stamps the run's terminal gate onto its usage.csv rows,
// and checkDailyLimits matches those cells against the same constant to tell an
// approvable unknown-cost pause from ungated unknown spend.
const UNKNOWN_COST_GATE = usage.UNKNOWN_COST_GATE;

// Stage 19 (issue #50) — the no-progress stop condition.
//
// `verity next` is ground truth every iteration, which means a state that never
// changes produces the SAME decision forever. Where that state is a PR whose CI
// never goes green, the worker answered it with the same role every tick and
// spent a full model run each time: the 2026-07-31 canary burned two runs on
// `build` for stage 1 and never reached `test` or `review`.
//
// Mechanism: a STRIKE, counted from the item's own comment trail — the same
// shape as the 2-strike failure rule, so the worker stays stateless and GitHub
// keeps holding the state. Backoff was rejected
// (a cron-driven `--once` worker has nowhere to hold a timer, and a slower
// livelock is still a livelock) and so was a plain per-run cap (it bounds one
// tick, not the sequence of ticks, which is where the canary's spend went).
//
// Two identical dispatches are allowed — a role legitimately gets a retry —
// and the third is refused, escalating to a human instead. Consecutive runs
// that dispatched the same single role count toward the ceiling, as do
// consecutive identical dispatches inside one run.
//
// The cross-tick trail is the worker's OWN §7 run-summary comments, already
// posted append-only on the locked item, one per run, with `roles: a → b` as
// part of that exact template (formatRunSummary below). Nothing new is written
// and no frozen format is touched — in particular the §4.3 lock/unlock comment
// bodies are left exactly as they were.
const MAX_REPEAT_DISPATCHES = 2;
const SUMMARY_PREFIX = '🤖 **verity-worker**';
const SUMMARY_ROLES_RE = /^roles: (.+)$/m;

// The roles a past run dispatched, per its §7 summary — or null if this comment
// is not a run summary at all. `(none)` (a run that dispatched nothing) reads
// as the empty list, which breaks a streak rather than extending it.
function summaryRoles(body) {
  if (typeof body !== 'string' || !body.startsWith(SUMMARY_PREFIX)) {
    return null;
  }
  const m = SUMMARY_ROLES_RE.exec(body);
  if (m === null) {
    return null;
  }
  return m[1] === '(none)' ? [] : m[1].split(' → ');
}

// How many of the item's MOST RECENT CONSECUTIVE runs dispatched exactly this
// one role and nothing else. Any run that chained, dispatched something else,
// or dispatched nothing breaks the streak; comments that are not run summaries
// (locks, gate pauses, humans) are skipped without breaking it. Deliberately a
// FLOOR: a summary that failed to post simply is not counted, so the guard this
// feeds can only ever fire late, never early.
function countRepeatedRole(comments, role) {
  let streak = 0;
  for (let i = (comments || []).length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    const roles = summaryRoles(typeof comment === 'string' ? comment : comment?.body);
    if (roles === null) {
      continue;
    }
    if (roles.length !== 1 || roles[0] !== role) {
      break;
    }
    streak += 1;
  }
  return streak;
}

// Monotonic elapsed-time source for the run loop (ADR-0008). Date.now() is
// WALL clock and can step backwards (NTP correction, VM/WSL clock skew) —
// measured elapsed time must never shrink, or a later chained role would be
// handed a LARGER --timeout-secs deadline than an earlier one (seen once in
// CI as 2700 → 2701: a backwards step made elapsedMs negative and
// floor(-1ms/1000) ADDED a second). process.hrtime.bigint() is monotonic by
// contract, so elapsed never decreases and the deadline never increases.
function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

// Stage 9 (ADR-0008): the wall-clock budget becomes a real subprocess
// deadline. Each chained role receives the REMAINING budget as --timeout-secs
// — never a fresh full window — so the deadline shrinks monotonically across
// the chain (the caller measures elapsed on the monotonic clock above).
// checkLimits() trips BEFORE dispatch once the budget is spent, so the floor
// of 1 only guards the sub-second race between check and dispatch. The spent
// clamp at 0 is belt-and-braces: no elapsed input, however broken, may ever
// yield MORE than the full budget.
function remainingTimeoutSecs(limits, elapsedMs) {
  const spentSecs = Math.max(0, Math.floor(elapsedMs / 1000));
  return Math.max(1, limits.max_wall_clock_min * 60 - spentSecs);
}

// Stage 9 (ADR-0005/0007): ONE immutable effective agent config per run,
// resolved from the already-validated policy (loadPolicy rejects an unknown
// provider with bad-policy/exit 30 BEFORE any scan, lock, or label) and passed
// to every chained dispatch — roles never re-read or reinterpret provider
// policy mid-run. sandbox/approval are codex-only overrides that agent-exec's
// driver may only apply by NARROWING the role's .permissions.json projection;
// the transcript destination stays what it has always been — the run-id
// selects ~/.verity/logs/<run-id>/ for every invocation of the run.
// Stage 11 (ADR-0011): `acknowledged_enforcement_gaps` travels here too, and
// defaults to the EMPTY list — acknowledging nothing, so a role declaring a
// restriction Verity cannot enforce refuses the run (fail closed).
// Stage 14 (ADR-0011 tier 2): `containment_tier` likewise defaults to 1 — the
// guarantee every codex run has had since stage 11. Tier 2 (disposable shaped
// workspace + gated merge-back) is OPT-IN, and UNATTENDED codex autonomy is
// refused without it (assertContainmentTier below).
// Stage 54 (ADR-0024): the ONE resolution stays once-per-run and frozen — just
// keyed by role. It returns a frozen resolver that exposes the BASE config (as
// today, spread at the top level so every existing run-wide `.provider`/`.model`
// read keeps working, plus a `.base` handle) AND `agentForRole(role)` = the base
// overridden by `policy.agent.roles[role]`, per role. EVERY per-role config is
// computed and frozen HERE, at run start; `agentForRole` is a pure lookup into
// that frozen cache, so nothing re-reads (or can be made to re-read) policy
// mid-run — the Stage-9 invariant is preserved, only now per-role instead of
// single. Absent `agent.roles` ⇒ agentForRole returns the identical base for
// every role ⇒ byte-identical to today (the feature's kill-switch, default OFF).
function resolveEffectiveAgent(policy) {
  const agent = policy.agent || {};
  const { roles: roleOverrides, ...agentBase } = agent;
  const base = Object.freeze({
    provider: 'claude',
    model: null,
    sandbox: null,
    approval: null,
    acknowledged_enforcement_gaps: [],
    containment_tier: 1,
    reconcile_work_items: false,
    ...agentBase,
  });
  // Snapshot each role's fully-merged config, frozen, at resolution time. A
  // shallow spread over the frozen base — the same discipline the base itself
  // uses — so a later mutation of the policy object cannot reach these.
  const cache = new Map();
  if (roleOverrides !== null && typeof roleOverrides === 'object') {
    for (const [role, override] of Object.entries(roleOverrides)) {
      cache.set(role, Object.freeze({ ...base, ...(override || {}) }));
    }
  }
  const agentForRole = (role) => cache.get(role) || base;
  return Object.freeze({ ...base, base, agentForRole });
}

// ADR-0011 tier gating, checked at startup BEFORE any gh call, label, or lock.
// "Unattended" is `mode: autonomous` — the mode in which no human sees the run
// before its effects land. Tier 1 catches a containment violation after the
// fact and reverts what it safely can; only tier 2 makes the violation
// impossible to propagate, so tier 1 is enough for supervised/trust-0 and not
// enough for autonomy. Claude is unaffected: its write-time restriction is
// enforced by its own harness allowlist, so it has no tiers.
// Stage 54 (ADR-0024): the check is now PER ROLE, and strictly MORE fail-closed
// — a per-role codex override can never bypass tier-2. The base config is
// checked first (so a policy with NO roles map throws the byte-identical error
// it always did), then every role whose RESOLVED provider is codex. `resolved`
// is the resolveEffectiveAgent resolver: `.base` + `agentForRole`.
function assertContainmentTier(policy, resolved) {
  if (policy.mode !== 'autonomous') {
    return;
  }
  const base = resolved.base;
  if (base.provider === 'codex' && base.containment_tier !== 2) {
    throw new WorkerError(
      `fail-closed: mode 'autonomous' with agent.provider codex requires ADR-0011 tier-2 containment (a disposable shaped workspace + gated merge-back), but agent.containment_tier is ${JSON.stringify(base.containment_tier)} — unattended codex autonomy is REFUSED at tier 1, which catches a protected-path write only after it happened. Set agent.containment_tier: 2 in .verity/autonomy.yml, or run in mode 'supervised'`,
      'containment-tier-required',
    );
  }
  for (const role of autonomy.KNOWN_AGENT_ROLES) {
    const cfg = resolved.agentForRole(role);
    if (cfg.provider === 'codex' && cfg.containment_tier !== 2) {
      throw new WorkerError(
        `fail-closed: mode 'autonomous' with a per-role agent.provider codex (role '${role}') requires ADR-0011 tier-2 containment (a disposable shaped workspace + gated merge-back), but this role resolves to agent.containment_tier ${JSON.stringify(cfg.containment_tier)} — a per-role codex override can NEVER bypass tier-2. Set agent.roles.${role}.containment_tier: 2 (or agent.containment_tier: 2) in .verity/autonomy.yml, or run in mode 'supervised'`,
        'containment-tier-required',
      );
    }
  }
}

// Stage 79 (ADR-0029) introduced this delivery-substrate gate as a fail-closed
// placeholder; stage 83 LIFTS it for 'local' — the local driver is complete
// (stage 80 record store + snapshot acquirer, stage 81 bare-origin git
// lifecycle + engine-performed merge, stage 82 gate runner), so 'github' AND
// 'local' both proceed. Anything else still refuses fail-closed, checked at
// startup BEFORE any gh call, scan, label, or lock — exactly like the tier
// gate above. loadPolicy resolves `substrate` ONCE onto the effective policy
// (absent ⇒ 'github', byte-identical; an unknown value is its own bad-policy
// load error), so by the time a run consumes the policy the value is one of
// the two schema enums — this check is the belt for unit callers passing raw
// policy objects: a substrate this engine cannot drive must never proceed
// half-driven, and never silently falls back to github (which would let a
// config the operator believes is GitHub-free touch the real repo).
function assertSubstrateSupported(policy) {
  // Unit callers may pass a raw policy object; absence resolves to 'github',
  // the same resolution loadPolicy performs.
  const substrate = policy.substrate === undefined ? 'github' : policy.substrate;
  if (substrate === 'github' || substrate === 'local') {
    return;
  }
  throw new WorkerError(
    `fail-closed: substrate '${substrate}' is not supported — the ADR-0029 delivery-substrate seam drives 'github' and 'local' (local driver complete as of stage 83); remove \`substrate: ${substrate}\` from .verity/autonomy.yml (absent resolves to github, byte-identical)`,
    'substrate-unimplemented',
  );
}

// Stage 76 guard, made substrate-aware by stage 81 (ADR-0029): did a build
// role that self-reported `gated` actually FINISH its job, so the gate is a
// mis-declared merge handoff? The stage-76 semantics key on the trust/role
// outcome ("the builder's job ends at delivered-for-review"), not on a PR
// object — but the original evidence guard was `artifacts.pr` (a real PR
// number), which only the github substrate can produce. On 'local' there is
// no PR to number; the equivalent delivered-for-review evidence is the
// git-lifecycle report's `pushed: true` (Verity committed and pushed the
// stage branch to the bare origin — agents/git-lifecycle.cjs finish, the
// "branch pushed, PR not opened" path every gh-less role takes). The github
// path is byte-identical: without `substrate === 'local'` the ONLY evidence
// accepted is the original PR number, so a genuine no-PR build failure is
// untouched exactly as before.
// Stage 82 (ADR-0029 §4): the local substrate's verification act. Where the
// github path waits on CI checks to appear on the pushed stage branch, the
// local path has NO CI — so after a build role completes, the ENGINE runs the
// committed single-source gate definition against that branch head and writes
// the SHA-pinned gate-run record (contract local-work-item v1) the stage-80
// snapshot driver reads. Synchronous by design: the record exists BEFORE the
// loop re-consults the dependency engine, so the very next snapshot read turns
// the branch's honest UNKNOWN into a verified green/red.
//
// Branch resolution: the Verity-performed git lifecycle names it directly
// (codex, res.git_lifecycle.branch); a provider whose harness performs its own
// git (claude) reports none, so the branch is DERIVED from the dispatch
// decision's stage number via stage.branchName — the same derivation the
// interactive `verity stage branch` uses, so it is the branch by construction.
//
// EVERY failure path is fail-closed and loud-but-non-fatal: a refused gate run
// (no committed definition, dirty tree, mid-run head move, missing branch)
// writes NO record, the branch stays UNKNOWN, and the existing ci:unverified
// gate fires on the next decision — never green, and never a crashed worker
// over a verification the snapshot honestly reports as unperformed.
function runLocalGates(ctx, plan, res) {
  let branch = typeof res.git_lifecycle?.branch === 'string' ? res.git_lifecycle.branch : null;
  if (branch === null) {
    const n = Number(plan.args?.[0]);
    if (Number.isInteger(n)) {
      try {
        branch = stage.branchName(ctx.cwd, n);
      } catch {
        branch = null;
      }
    }
  }
  if (branch === null) {
    ctx.stderr(
      'verity-worker: warn: local build completed but no stage branch could be resolved for the gate run — the stage stays UNKNOWN (ci:unverified gates, ADR-0029 §4)',
    );
    return;
  }
  try {
    // Stage 86 (ADR-0030): the run's resolved gate_runner travels with the
    // call — 'localhost' executes via the stage-87 act runner and
    // 'remote:<name>' via the stage-89 SSH act runner, both inside the same
    // honesty bracket; a runner the engine cannot serve (an unreachable or
    // unprovisionable remote, a localhost whose Docker/act preflight fails)
    // refuses inside, landing in the catch below: no record, honestly
    // UNKNOWN, loud warn — never a silent fallback to another runner.
    const run = gates.runGatesForBranch(ctx.cwd, { branch, runner: ctx.gateRunner });
    const verdict = run.ok
      ? 'green'
      : `red (${run.gates
          .filter((g) => g.exit_code !== 0)
          .map((g) => `${g.name}=${g.exit_code}`)
          .join(', ')})`;
    ctx.stderr(
      `verity-worker: note: local gates for ${branch} @ ${run.sha.slice(0, 12)}: ${verdict} — record ${run.record} (stage 82, ADR-0029 §4)`,
    );
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: local gate run for ${branch} wrote no record — ${oneLine(err.message)}; the branch stays UNKNOWN and the ci:unverified gate fires (fail closed, ADR-0029 §4)`,
    );
  }
}

function buildMisdeclaredHandoff(res, substrate) {
  if (res.outcome !== 'gated') {
    return false;
  }
  if (Number.isInteger(res.artifacts?.pr)) {
    return true;
  }
  return substrate === 'local' && res.git_lifecycle?.pushed === true;
}

function fmtTokens(n) {
  return `${Math.round(n / 1000)}k`;
}

function fmtWall(secs) {
  return `${Math.floor(secs / 60)}m${secs % 60}s`;
}

// SKETCH §7 — exact template. The approve line appears ONLY when gated, and
// the budget line (stage 21) ONLY when the run consumed a `verity:approved` to
// proceed past an unverifiable daily budget — consent recorded, not implied.
function formatRunSummary(s) {
  const usd = typeof s.est_usd === 'number' ? s.est_usd.toFixed(2) : '?';
  const lines = [
    `🤖 **verity-worker** \`${s.runId}\` — ${OUTCOME_BADGES[s.outcome]}`,
    `roles: ${s.roles.length > 0 ? s.roles.join(' → ') : '(none)'}`,
    `result: ${s.result}`,
    `tokens: ${fmtTokens(s.tokens.in)} in / ${fmtTokens(s.tokens.out)} out · est $${usd} · wall ${fmtWall(s.wall_secs)}`,
  ];
  if (s.unknown_cost_budget_approved === true) {
    lines.push(
      `budget: unverifiable daily budget covered by the operator's single-use \`verity:approved\` — this run only (ADR-0008)`,
    );
  }
  // Stage 31 (ADR-0014): the resumed-from-parked outcome flavor, and its
  // fail-closed opposite — both recorded on GitHub, never stderr-only (a
  // cron-driven worker's operator reads comments, not logs).
  if (s.resumed_from !== null && s.resumed_from !== undefined) {
    lines.push(
      `resumed: consumed the parked ${s.resumed_from.role} result of run \`${s.resumed_from.runId}\` — zero new model runs, verified zero new cost (ADR-0014)`,
    );
  }
  if (typeof s.repurchase === 'string' && s.repurchase !== '') {
    lines.push(
      `repurchase: ${s.repurchase} — the approval bought a FRESH dispatch at full price (ADR-0014)`,
    );
  }
  if (s.outcome === 'gated') {
    lines.push(`approve: ${APPROVAL_ACTION}`);
  }
  return lines.join('\n');
}

// GATE_PAUSE comment: what's pending, the exact approval action, @mentions.
// Stage 31 (ADR-0014): a POST-COMPLETION unknown-cost pause additionally
// records the durable pointer to the PARKED result (`parked`, optional) — the
// line the next tick's resume parses (PARKED_POINTER_RE below). Every other
// gate comment is byte-identical to what it was.
function formatGateComment({ runId, gate, pending, mentions, parked }) {
  const lines = [
    `⏸️ **verity-worker** \`${runId}\` — paused at human gate \`${gate}\``,
    `pending: ${pending}`,
    `approve: ${APPROVAL_ACTION}`,
  ];
  if (parked !== null && parked !== undefined) {
    lines.push(
      `parked: role \`${parked.role}\` result of run \`${runId}\` at PR #${parked.pr} head ${parked.head} — approving RESUMES this exact result (trust ladder + summary, zero new model runs); if the PR head has moved by then, the approval re-dispatches at full price instead (ADR-0014)`,
    );
  }
  if (mentions.length > 0) {
    lines.push(`cc ${mentions.map((m) => `@${m}`).join(' ')}`);
  }
  return lines.join('\n');
}

// Stage 31 (ADR-0014) — where the parked-result pointer LIVES: the gate
// comment the pause already posts on the item. It survives ticks (GitHub holds
// it, like the §7 no-progress trail and the §4.3 lock comments — the worker
// stays stateless), it needs no new contract or file, and its authority level
// is right: the pointer only NAMES a local file under ~/.verity/logs/ that is
// itself the authority (agent-exec re-validates run-id/role as path components
// and re-parses the persisted result fail-closed), and the head SHA recorded
// beside it bounds what a tampered or stale pointer can do — a mismatch is a
// loud repurchase, never a resumed lie.
const GATE_COMMENT_PREFIX = '⏸️ **verity-worker**';
const PARKED_POINTER_RE =
  /^parked: role `([A-Za-z0-9][A-Za-z0-9._-]*)` result of run `([A-Za-z0-9][A-Za-z0-9._-]*)` at PR #(\d+) head ([0-9a-f]{6,40}|unknown) /m;

// The staleness anchor a pointer records: the PR's head SHA at park time, read
// once, best-effort. No PR → no pointer (nothing verifiable to anchor the
// resume to — the fallback dispatch is the honest price); an unreadable head
// records `unknown`, which the resume refuses fail-closed, loudly. Only a
// COMPLETED result's park ever calls this — the stage-25 failed-run park and
// every pre-completion gate (ci:unverified, review:merge, role-declared)
// record no pointer and keep their stages 19/21/22/25/27 semantics untouched.
// Stage 85 (ADR-0029): the head read is substrate-aware — on 'local' the SHA
// comes from the stage-80 snapshot's branch mapping + git itself
// (substrateLocal.localPrHead), never `gh pr view`; a failed local read records
// the same honest 'unknown' the gh path records (approval then repurchases,
// never resumes a lie). github: byte-identical gh argv.
function prHeadSha(ctx, pr) {
  if (ctx.substrate === 'local') {
    const head = substrateLocal.localPrHead(ctx.cwd, pr);
    if (!/^[0-9a-f]{6,40}$/.test(head)) {
      throw new Error(`local head for PR #${pr} is not a SHA: ${JSON.stringify(head)}`);
    }
    return head;
  }
  const view = gh.json(['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd: ctx.cwd });
  if (typeof view.headRefOid === 'string' && /^[0-9a-fA-F]{6,40}$/.test(view.headRefOid)) {
    return view.headRefOid.toLowerCase();
  }
  return null;
}

function parkedResultPointer(ctx, { role, pr }) {
  if (!Number.isInteger(pr)) {
    return null;
  }
  let head = 'unknown';
  try {
    const sha = prHeadSha(ctx, pr);
    if (sha !== null) {
      head = sha;
    }
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not read PR #${pr}'s head SHA to anchor the parked result — recorded 'unknown', so an approval will repurchase rather than resume (${oneLine(err.message)})`,
    );
  }
  return { role, pr, head };
}

// The most recent gate pause's pointer on a P1 item, or null. The LATEST
// ⏸️ comment decides: an older parked pointer must never outlive the pause
// that superseded it (a later review:merge or failed-run park carries no
// pointer line, and that absence is the answer). Best-effort read — a trail we
// cannot read yields null, and the approval buys a fresh dispatch instead of
// wedging (the run-4 lesson: an approval must never be a no-op).
function readParkedPointer(ctx, item) {
  // Stage 85 (ADR-0029): the pointer LIVES in the gate-comment trail, and the
  // local substrate has no comment surface (contract v1, frozen) — the local
  // gate pause landed its text on the run log (postComment above), which is
  // not a machine-readable trail. No pointer ⇒ the approval buys a fresh
  // dispatch — the documented fail-safe direction (an approval is never a
  // no-op, and a resume is never guessed). Said out loud, never silent.
  if (ctx.substrate === 'local') {
    ctx.stderr(
      `verity-worker: note: no parked-result pointer can exist on the local substrate (no comment trail; contract local-work-item v1) — a consumed approval on #${item.number} dispatches fresh (stage 85, ADR-0029)`,
    );
    return null;
  }
  try {
    const trail = locks.readComments(item, { repo: ctx.repo, cwd: ctx.cwd });
    for (let i = (trail || []).length - 1; i >= 0; i -= 1) {
      const body = typeof trail[i] === 'string' ? trail[i] : trail[i]?.body;
      if (typeof body !== 'string' || !body.startsWith(GATE_COMMENT_PREFIX)) {
        continue;
      }
      const m = PARKED_POINTER_RE.exec(body);
      if (m === null) {
        return null;
      }
      return { role: m[1], runId: m[2], pr: Number(m[3]), head: m[4] };
    }
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not read the parked-result pointer on #${item.number}: ${oneLine(err.message)}`,
    );
  }
  return null;
}

// Consume a parked pointer (ADR-0014): verify the parked result's inputs still
// hold, re-read the persisted T05 result, and hand back a zero-cost `res` the
// run loop re-enters the post-role path with. Fail-closed on every doubt —
// each refusal names its reason, and the caller announces the fresh dispatch
// as a repurchase. The returned result carries VERIFIED zeros (tokens, cost,
// wall): this run spawned no provider, so its ledger rows must never say
// unknown and must never re-count the parked run's tokens.
function resumeParkedResult(ctx, { agentCfg, pointer }) {
  const refuse = (reason) => ({ res: null, from: null, reason });
  const who = `parked ${pointer.role} result of run ${pointer.runId}`;
  if (!/^[0-9a-f]{6,40}$/.test(pointer.head)) {
    return refuse(`${who} recorded no verifiable head SHA at park time`);
  }
  let head = null;
  try {
    // Stage 85 (ADR-0029): substrate-aware head verification (prHeadSha above)
    // — local reads git via the stage-80 snapshot; github is byte-identical.
    head = prHeadSha(ctx, pointer.pr);
  } catch (err) {
    return refuse(
      `could not read PR #${pointer.pr}'s current head to verify the ${who} is still fresh (${oneLine(err.message)})`,
    );
  }
  if (head === null || head !== pointer.head) {
    return refuse(
      `PR #${pointer.pr} head moved since the ${pointer.role} result parked (${pointer.head} → ${head ?? 'unreadable'}) — the approved verdict examined a head that no longer exists`,
    );
  }
  let parked = null;
  try {
    parked = agentExec.readParkedResult({
      'run-id': pointer.runId,
      role: pointer.role,
      agent: agentCfg.provider,
    });
  } catch (err) {
    return refuse(`${who} is unreadable (${oneLine(err.message)})`);
  }
  if (parked === null) {
    return refuse(`${who} is missing from ~/.verity/logs — log cleanup must have taken it`);
  }
  // Stage 25 boundary, belt-and-braces (the failed-run park never writes a
  // pointer in the first place): only a COMPLETED result is resumable. A
  // failed park's approval means "let the day proceed", never "replay the
  // failure" — ADR-0014 scopes resume to post-completion parks of successes.
  if (parked.outcome !== 'success') {
    return refuse(`${who} is not a completed success (outcome ${parked.outcome})`);
  }
  return {
    res: {
      outcome: 'success',
      artifacts: parked.artifacts,
      error: null,
      tokens: { in: 0, out: 0 },
      // A VERIFIED zero, not an unknown (the stage-22 distinction): this
      // iteration dispatched no model, so its new cost is genuinely $0.
      est_usd: 0,
      wall_secs: 0,
      tool_calls: 0,
    },
    from: { runId: pointer.runId, role: pointer.role },
    reason: null,
  };
}

// --- T11 / T12 seams ----------------------------------------------------------

// T11 — usage ledger. SUMMARIZE calls this exactly once per run with the
// final run summary ({ runId, repo, outcome, roles, invocations, tokens:{in,out},
// est_usd, wall_secs, ... }): §3.4 usage.csv append — since stage 3 one row PER
// ROLE INVOCATION (summary.invocations, all sharing the run_id; a zero-role run
// still writes its single run-level row) — + one `chore(verity): usage <run-id>`
// commit when policy `commit_usage` is true. Best-effort like the summary
// comment itself — ledger/commit failures are logged and NEVER change the
// run's outcome (the §8.1 lock release is the invariant, not bookkeeping).
function recordUsage(ctx, policy, summary) {
  try {
    const rec = usage.record(ctx.cwd, summary, { commit: policy.commit_usage !== false });
    if (rec.commitError !== null) {
      ctx.stderr(`verity-worker: warn: usage.csv commit failed: ${oneLine(rec.commitError)}`);
    }
  } catch (err) {
    ctx.stderr(`verity-worker: warn: failed to record usage: ${oneLine(err.message)}`);
  }
}

// §4.1 startup checks (T11 daily limits + T12 the rest). Runs AFTER the
// bad-policy / mode:manual checks in runOnce, BEFORE scanning/locking; all
// checks are read-only (no labels/comments — no GitHub side effects). Returns
// { ok:true, botLogin } or the first failing check's { ok:false, slug, message }
// → exit 30 as `verity-worker: 30 <slug>: <message>` (§8.2). Order: local
// checks first (a refused start must not cost gh calls), then auth → identity
// → circuit breaker.
function startupChecks(ctx, policy) {
  // 1 (local). Daily limits not already exceeded — today's usage.csv, UTC (T11).
  const daily = usage.checkDailyLimits(ctx.cwd, policy.limits, {
    warn: (msg) => ctx.stderr(`verity-worker: warn: ${msg}`),
  });
  // Stage 21 (#58, ADR-0008): an unverifiable budget whose every unknown-cost
  // run ended PARKED at the unknown-cost gate is not refused HERE — the gate
  // comment told the operator that `verity:approved` resumes the run, and the
  // startup breaker must not outrank the approval its own gate asked for
  // ("'gate' costs one human approval per run", ADR-0008). The refusal is
  // DEFERRED: runOnce refuses with this exact failure unless the scanner
  // selects a P1 item (one carrying the single-use approval). Every other
  // daily-limit failure — verified overspend, run caps, ungated unknown cost —
  // still refuses right here, before any gh call, exactly as stage 18 built it.
  let deferredDaily = null;
  if (!daily.ok) {
    if (daily.slug !== 'unknown-cost-budget' || daily.approvable !== true) {
      return daily;
    }
    deferredDaily = daily;
  }
  // The start is allowed, but not because the budget was verified: under
  // unknown_cost_behavior 'allow_with_token_limit' the USD breaker is inert by
  // the operator's own consent (ADR-0008). Say so rather than letting a $x.xx
  // total in usage.csv look like the whole day's spend.
  if (daily.note) {
    ctx.stderr(`verity-worker: warn: ${daily.note}`);
  }

  // Stage 85 (ADR-0029; stage-83 review): on the LOCAL substrate checks 2–4
  // get honest local equivalents — never a fabricated pass, never a gh spawn:
  //   2/3. preflight auth + bot identity: there is no GitHub to authenticate
  //        against and no bot account to resolve. botLogin is NULL (the run's
  //        honest marker — the ledger/summary already record the substrate via
  //        the committed policy; a fabricated login is forbidden). Every
  //        downstream consumer tolerates null: the scanner's P4 author filter
  //        is skipped on a null botLogin by its own contract, and the
  //        bot-is-human check has nothing to compare.
  //   4.   circuit breaker: the label vocabulary is unchanged (contract
  //        local-work-item v1 — labels are free strings), so the breaker reads
  //        as "any OPEN work-item record carrying verity:circuit-open" — the
  //        same derivation stage 84's operator snapshot uses for
  //        autonomy.circuit_open, and the read `operator act circuit open`
  //        now arms (stage 85). An unreadable store fails CLOSED (halt), the
  //        gh path's own rule.
  if (ctx.substrate === 'local') {
    ctx.stderr(
      'verity-worker: note: local substrate — no GitHub to authenticate against; preflight auth skipped and bot identity is null, never fabricated (stage 85, ADR-0029)',
    );
    let snap;
    try {
      snap = substrateLocal.fetchLocalSnapshot(ctx.cwd);
    } catch (err) {
      return {
        ok: false,
        slug: 'circuit-open',
        message: `could not check the circuit breaker (failing closed): ${oneLine(err.message)}`,
      };
    }
    if (snap.verified !== true) {
      const detail = (snap.failures || [])
        .map((f) => f.detail)
        .filter(Boolean)
        .join('; ');
      return {
        ok: false,
        slug: 'circuit-open',
        message: `could not check the circuit breaker (failing closed): the local record store could not be honestly read${detail ? ` — ${detail}` : ''}`,
      };
    }
    const open = (snap.issues || []).filter(
      (i) => i.state === 'OPEN' && (i.labels || []).includes(CIRCUIT_LABEL),
    );
    if (open.length > 0) {
      const nums = open.map((i) => `#${i.number}`).join(', ');
      return {
        ok: false,
        slug: 'circuit-open',
        message: `circuit breaker is open: work-item record ${nums} carries label ${CIRCUIT_LABEL} — close it (\`verity operator act circuit close <n>\`) to resume autonomy`,
      };
    }
    return { ok: true, botLogin: null, deferredDaily };
  }

  // 2. `gh auth status` ok — any failure (not logged in, bad token, no gh) is fatal.
  try {
    gh.run(['auth', 'status'], { cwd: ctx.cwd });
  } catch (err) {
    return {
      ok: false,
      slug: 'gh-auth',
      message: `gh auth status failed: ${oneLine(err.message)}`,
    };
  }

  // 3. Resolve the bot identity (the scanner's P4 no-self-feeding rule needs it
  //    too). A failed lookup is an auth/credential problem → same slug.
  let botLogin = null;
  try {
    botLogin = gh.json(['api', 'user'], { cwd: ctx.cwd }).login || null;
  } catch (err) {
    return {
      ok: false,
      slug: 'gh-auth',
      message: `could not resolve bot identity via gh api user: ${oneLine(err.message)}`,
    };
  }
  // Bot login ∉ policy humans. GitHub logins are case-insensitive, so the
  // comparison is too — `Verity-Bot` in humans still blocks token `verity-bot`.
  const human = (policy.humans || []).find(
    (h) => String(h).toLowerCase() === String(botLogin).toLowerCase(),
  );
  if (botLogin !== null && human !== undefined) {
    return {
      ok: false,
      slug: 'bot-is-human',
      message: `bot login '${botLogin}' matches '${human}' in the policy humans list — the worker must run with a dedicated bot account's GH_TOKEN, never a human's; fix .verity/autonomy.yml humans or switch the token`,
    };
  }

  // 4. Circuit breaker: any OPEN issue labeled verity:circuit-open halts the
  //    worker. An unreadable breaker fails closed (halt) — never open. The
  //    query targets the --repo repository (GH_REPO, set in runOnce — stage
  //    29), never the cwd's remotes: a remote-less clone must not die HERE
  //    masquerading as a breaker fault, it refuses later — truthfully — as
  //    `git-unprovidable` (ADR-0012). The read-failure message below names
  //    what could not be READ; only the branch after it may claim the switch
  //    was actually thrown.
  let circuit;
  try {
    circuit = gh.json(
      ['issue', 'list', '--label', CIRCUIT_LABEL, '--state', 'open', '--json', 'number'],
      { cwd: ctx.cwd },
    );
  } catch (err) {
    return {
      ok: false,
      slug: 'circuit-open',
      message: `could not check the circuit breaker (failing closed): ${oneLine(err.message)}`,
    };
  }
  if (circuit.length > 0) {
    const nums = circuit.map((i) => `#${i.number}`).join(', ');
    return {
      ok: false,
      slug: 'circuit-open',
      message: `circuit breaker is open: issue ${nums} carries label ${CIRCUIT_LABEL} — close it to resume autonomy`,
    };
  }

  return { ok: true, botLogin, deferredDaily };
}

// --- the run loop (§4.4) ------------------------------------------------------

// `target` is the gate's GitHub item number (the dispatch decision's issue/PR,
// or the trust ladder's PR) — NOT necessarily the run's locked anchor.
function gatePause(ctx, { runId, policy, target, gate, pending, parked = null }) {
  if (target === null) {
    ctx.stderr('verity-worker: note: gated with no GitHub target — gate label/comment skipped');
    return;
  }
  addLabel(ctx, target, GATE_LABEL);
  postComment(
    ctx,
    target,
    formatGateComment({ runId, gate, pending, mentions: policy.notify?.mention || [], parked }),
  );
}

// The cross-tick half of the no-progress strike: read the item's run-summary
// trail once. BEST-EFFORT — a trail we cannot read yields 0, because "we could
// not prove repetition" must not become "we refuse to work". The within-run
// streak still bounds a single run, and max_runs_per_day still bounds the day;
// the failure is logged, never silent.
function priorRepeats(ctx, item, role) {
  if (!lockable(item)) {
    return 0;
  }
  // Stage 85 (ADR-0029): the cross-tick trail is the §7 comment trail, which
  // the local substrate does not carry (no comment surface, contract v1).
  // 0 is the documented FLOOR ("we could not prove repetition" must not become
  // "we refuse to work"): the within-run streak still bounds a single run and
  // max_runs_per_day still bounds the day — the guard can only fire late,
  // never early. Never a fabricated count.
  if (ctx.substrate === 'local') {
    return 0;
  }
  try {
    return countRepeatedRole(locks.readComments(item, { repo: ctx.repo, cwd: ctx.cwd }), role);
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not read the no-progress trail on #${item.number}: ${oneLine(err.message)}`,
    );
    return 0;
  }
}

function runLoop(ctx, { policy, runId, item, budgetApproved = false }) {
  const t0 = monotonicMs(); // monotonic: elapsed never shrinks (ADR-0008)
  // Stage 54 (ADR-0024): the frozen resolver — the base config (run-wide reads
  // still use `agentCfg.provider`/`.model`) plus `agentForRole(role)` for the
  // per-role dispatch below. Resolved ONCE here; nothing re-reads policy mid-run.
  const agentCfg = resolveEffectiveAgent(policy);
  const agentForRole = agentCfg.agentForRole;
  // Stage 86 (ADR-0030): the resolved gate runner rides the run context like
  // ctx.substrate — stamped ONCE from the frozen policy, consumed by
  // runLocalGates below. 'localhost' executes via the stage-87 act runner
  // and 'remote:<name>' via the stage-89 SSH act runner; any runner the
  // engine cannot honestly serve (an unreachable/unprovisionable remote, an
  // unprovisionable localhost) refuses at the gate call site rather than
  // silently executing direct. Absent (unit callers passing raw
  // pre-stage-86 policies) reads as the direct runner — byte-identical.
  ctx.gateRunner = policy.gate_runner;
  const roles = [];
  // Stage 3 telemetry: one entry per agent-exec invocation (role, outcome,
  // tokens, est_usd, wall_secs, tool_calls) — SUMMARIZE writes one usage.csv
  // row per entry, all sharing this run's run_id.
  const invocations = [];
  const tokens = { in: 0, out: 0 };
  let estUsd = null;
  let lastPr = null;
  const mergedPrs = []; // PRs auto-merged by the trust ladder this run (audit)
  // Where labels/comments land: the locked item, else the first issue/PR target.
  let anchor = lockable(item) ? item.number : null;

  // P1 approved-resume: consume the single-use token (§1). The gate label is
  // removed WITH it — leaving `verity:awaiting-approval` behind would make the
  // next `verity next` call re-gate the item the human just approved.
  //
  // Stage 32 (canary run 5, defect N3): consumption is EFFECT-CONDITIONAL — the
  // two labels come off exactly ONCE, and only when the run actually reaches the
  // work the approval authorized (a dispatch that genuinely spawned, or a stage
  // 31 parked-result resume). Consuming at the TOP of the loop (as this did
  // before) burned the approval AND erased the visible pause on a run that then
  // REFUSED before any work: the `state:unverified` pre-dispatch gate below, or
  // a pre-SPAWN infra refusal such as `unenforceable-policy` (agent-exec exit 30,
  // ZERO provider spawns) that comes back FROM the dispatch call itself. Such a
  // refusal must leave BOTH labels exactly as it found them — the approval
  // survives for the next healthy tick and stage 27's announce-once stays quiet.
  // `consumeApproval` is idempotent (the flag) and P1-only, so the chained
  // multi-role healthy path consumes once, at its first real dispatch, exactly
  // as before.
  //
  // Known edge (T14 integration finding), now with two distinct regimes:
  // GitHub's label-FILTERED list queries are search-index backed and eventually
  // consistent, so an approval applied seconds before a tick can be missed by
  // the scanner's P1 query.
  //   • ORDINARY (non-deferred) scan: the miss is COSMETIC. The P5 dependency
  //     engine reads fresh `--json labels` and still treats the approved item
  //     as plain work, so the work proceeds correctly; only the token
  //     consumption is skipped (labels linger on the item). Accepted for v1 —
  //     this normal-path lag is deliberately NOT worked around.
  //   • DEFERRED daily unknown-cost refusal (stage 21): the same miss was a
  //     HARD `30 unknown-cost-budget` exit — the deferred refusal fires unless
  //     the scan yields a P1 pick, so a lagged approval refused a true-but-not-
  //     yet approval (canary run 5, tick 3). Stage 33 covers that regime: before
  //     the deferred refusal fires, runOnce re-checks the awaiting-approval
  //     carriers with a bounded FRESH (non-search) read and proceeds on a
  //     confirmed approval. Under the documented cron cadence the index has long
  //     settled and neither regime is exercised.
  let approvalConsumed = false;
  const consumeApproval = () => {
    if (item.tier !== 'P1' || approvalConsumed) {
      return;
    }
    approvalConsumed = true;
    removeLabel(ctx, item.number, APPROVED_LABEL);
    removeLabel(ctx, item.number, GATE_LABEL);
  };

  // Stage 31 (ADR-0014): the approval this P1 run just consumed may be
  // answering a POST-COMPLETION unknown-cost park — in which case the role's
  // result already exists on disk and was already paid for. Read the parked
  // pointer from the item's own gate-comment trail ONCE; the loop below
  // consumes it (at most once) instead of re-dispatching, or announces the
  // repurchase when the resume must refuse. Non-P1 runs never look: without a
  // consumed approval there is nothing that could legitimately resume.
  let parkedPointer = item.tier === 'P1' && lockable(item) ? readParkedPointer(ctx, item) : null;
  let resumedFrom = null; // { runId, role } once a parked result was consumed
  let repurchase = null; // the loud reason a refused resume dispatched fresh

  // Stage 19: what `verity next` should do with a PR whose CI is UNVERIFIABLE.
  // Normally the policy decides (limits.unverified_ci_behavior, default-closed
  // → the ci:unverified gate). A P1 item is different: a human just applied
  // `verity:approved` to this exact item and this run consumes that token when
  // it reaches real work (stage 32, `consumeApproval` below), so the human
  // decision the gate asks for has already been made — for THIS RUN only, since
  // the token is single-use. Without this the gate would be a dead
  // end: approving it would re-derive the same gate on the next tick forever
  // (cheaply, but forever), and the "approve:" line the gate comment prints
  // would be a lie. It does NOT lower the merge bar — the trust ladder still
  // demands trust.checksGreen(), which an unverified PR can never satisfy.
  const nextFlags = { cwd: ctx.cwd };
  if (item.tier === 'P1') {
    nextFlags['unverified-ci'] = 'allow_without_merge';
  }
  // Stage 24 (ADR-0013): a CONTAINED dispatch cannot read GitHub, so the facts
  // its workflow needs must travel with it — ask `verity next` to attach them
  // (derived from the same verified snapshot as the decision itself). Claude
  // dispatches never ask and never receive: its harness reads GitHub itself,
  // and agent-exec rejects the flag for it outright.
  // Stage 54 (ADR-0024): we don't know which role `verity next` will pick until
  // it answers, so REQUEST facts whenever ANY role this run could dispatch as
  // codex (the base, or a per-role override). Attaching them stays PER ROLE at
  // dispatch (only a codex role's invocation gets --state-snapshot). With no
  // roles map this reduces to `base.provider === 'codex'` — byte-identical.
  const requestFacts =
    agentCfg.provider === 'codex' ||
    autonomy.KNOWN_AGENT_ROLES.some((r) => agentForRole(r).provider === 'codex');

  // No-progress strike state. The cross-tick count is read ONCE, from the
  // item's run-summary trail, on the run's first dispatch decision (it cannot
  // change mid-run); after that only the within-run streak grows.
  let repeats = null;
  let repeatKey = null;

  const summary = (outcome, result, gate = null) => ({
    runId,
    repo: ctx.repo,
    item: { kind: item.kind, number: item.number ?? null, tier: item.tier },
    anchor,
    outcome,
    gate,
    result,
    roles,
    invocations,
    // Stage 53: run-level provenance for the zero-invocation fallback row
    // (entryFromSummary reads these). Worker-wide agentCfg; a null model writes
    // '' at the usage layer, never a fabricated value.
    provider: agentCfg.provider,
    model: agentCfg.model,
    tokens,
    // Stage 30 (the third occurrence of the null-vs-zero class — ended here,
    // structurally): a run whose loop performed ZERO provider dispatches has a
    // VERIFIED cost of $0 — the same truth stage 22's announcement summary in
    // runOnce records. ADR-0008's "null never counts as $0" is about MODEL
    // runs whose provider reported no cost; serializing null for a
    // dispatch-free exit (parked-success idle, the stage-20 infra stop, a
    // pre-dispatch gate) writes an UNGATED unknown-cost ledger row, and the
    // startup breaker then refuses `30 unknown-cost-budget` NON-approvably
    // for the rest of the UTC day (canary run 5, ticks 6/9/11 → the tick-13
    // wedge). Derived from the run's own invocation list so EVERY exit —
    // present and future — inherits the rule; a run with ≥1 invocation keeps
    // the accumulator's semantics exactly: unknown stays unknown, and stage
    // 31's resumed results already report their own verified numeric 0.
    est_usd: invocations.length === 0 ? 0 : estUsd,
    wall_secs: Math.round((monotonicMs() - t0) / 1000),
    // Stage 21: consent is recorded, not implied — a run that proceeded past
    // the unverifiable-budget refusal on a consumed `verity:approved` says so
    // in its own §7 summary (formatRunSummary renders the line).
    ...(budgetApproved ? { unknown_cost_budget_approved: true } : {}),
    // Stage 31 (ADR-0014): likewise for a consumed parked result, and for the
    // announced repurchase when the resume had to refuse.
    ...(resumedFrom !== null ? { resumed_from: resumedFrom } : {}),
    ...(repurchase !== null ? { repurchase } : {}),
  });
  const gatedResult = (gate) =>
    `${lastPr === null ? '' : `PR #${lastPr} opened, `}gated at ${gate}`;

  let first = true;
  for (;;) {
    // Ground truth every iteration — with one extension: a P4 request's first
    // role is `plan` on the request issue (the dependency engine knows stages,
    // not requests; planning is what turns the request INTO stages).
    let plan;
    // Stage 73 (#202): the anti-thrash fix is RETIREMENT, not a stage-count
    // guard here. A P4 selection means the scanner found an OPEN `verity:request`
    // — and a request is only still labeled while it is UN-planned, because a
    // successful plan retires the label below (so the P4 tier never re-selects
    // it). Synthesizing `plan` unconditionally for a P4-first iteration is
    // therefore correct: every P4-selected request genuinely needs planning.
    // This is deliberately NOT keyed on `readStages().length === 0` — a global
    // stage-count guard would block Mode B recurring intake (a NEW pending
    // request must plan into new stages even when prior work's stages exist).
    if (first && item.tier === 'P4') {
      plan = {
        schema: 1,
        action: 'work',
        role: 'plan',
        args: [String(item.number)],
        gate: null,
        target: { kind: 'issue', number: item.number },
        reason: `request #${item.number} needs planning`,
      };
    } else {
      plan = next.dispatch([], nextFlags, requestFacts ? { withFacts: true } : {});
    }
    first = false;
    // Stage 54 (ADR-0024): this iteration's role runs under ITS OWN resolved
    // config — base overridden by agent.roles[plan.role]. A pure lookup into
    // the frozen cache (no policy re-read). For idle/gated iterations plan.role
    // may be absent; agentForRole then returns the base, and those paths return
    // before it is used for dispatch/provenance anyway.
    const roleCfg = agentForRole(plan.role);
    if (anchor === null && plan.target !== null && plan.target.kind !== 'stage') {
      anchor = plan.target.number;
    }
    // Where a gate label/comment would land this iteration: the dispatch
    // decision's GitHub item (issue/PR), else the run's anchor.
    const gateTarget =
      plan.target !== null && plan.target.kind !== 'stage' ? plan.target.number : anchor;

    if (plan.action === 'idle') {
      // A run that reached idle genuinely RAN and found no work remaining (a
      // clean completion, not a refusal) — it consumes exactly as it did when
      // consumption sat at the top of the loop, so the approved item is not
      // re-selected on the next tick to summarize idle again (stage 32).
      consumeApproval();
      const mergedNote =
        mergedPrs.length > 0 ? ` — auto-merged PR ${mergedPrs.map((n) => `#${n}`).join(', ')}` : '';
      return summary('success', `${plan.reason || 'no work remaining'}${mergedNote}`);
    }
    // Stage 20 (issue #60): the dependency engine could not READ GitHub — the
    // decision below it is derived from a snapshot nobody observed. This is
    // deliberately NOT the GATE_PAUSE path: that writes a label and a comment
    // to the very GitHub that just proved unreachable, and the decision carries
    // no target to write them to. Stop as INFRA — exit 30, no needs-human label
    // (an unreadable API is not the item's fault), and the point of the whole
    // stage: zero model runs dispatched against unverified state.
    // Stage 32: this is a PRE-WORK refusal — deliberately NO consumeApproval()
    // here. The approval and the gate announcement survive for the next tick.
    if (plan.action === 'gated' && plan.gate === next.STATE_GATE) {
      return summary('infra', `refusing to dispatch on unverified GitHub state: ${plan.reason}`);
    }
    if (plan.action === 'gated') {
      // A human gate on this decision — a pause, not a refusal: consume as
      // before (the item now carries the gate label and must not be re-picked
      // as a P1 next tick, stage 32).
      consumeApproval();
      gatePause(ctx, { runId, policy, target: gateTarget, gate: plan.gate, pending: plan.reason });
      return summary('gated', gatedResult(plan.gate), plan.gate);
    }

    // Stage 31 (ADR-0014): before paying for a dispatch, check whether the
    // consumed approval was answering a parked COMPLETED result for exactly
    // this decision (same role, same PR). At most one attempt per run — the
    // pointer is cleared whichever way it goes, mirroring the single-use
    // token that authorized it. A refused resume falls through to the normal
    // dispatch below, announced as a repurchase (never a silent re-buy, and
    // never a wedged approval).
    let res = null;
    let resumed = false;
    if (
      parkedPointer !== null &&
      plan.role === parkedPointer.role &&
      plan.target !== null &&
      plan.target.kind === 'pr' &&
      plan.target.number === parkedPointer.pr
    ) {
      const attempt = resumeParkedResult(ctx, { agentCfg: roleCfg, pointer: parkedPointer });
      parkedPointer = null;
      if (attempt.res !== null) {
        res = attempt.res;
        resumed = true;
        resumedFrom = attempt.from;
        // Stage 32: resolving the parked COMPLETED result IS the deferred work
        // the approval authorized (stage 31) — consume here, exactly once.
        consumeApproval();
        ctx.stderr(
          `verity-worker: note: resuming the parked ${attempt.from.role} result of run ${attempt.from.runId} — zero new model runs, verified zero new cost (ADR-0014)`,
        );
      } else {
        repurchase = attempt.reason;
        ctx.stderr(
          `verity-worker: warn: ${attempt.reason} — refusing the resume; the approval buys a FRESH ${plan.role} dispatch at full price (ADR-0014)`,
        );
      }
    }

    if (res === null) {
      const tripped = checkLimits(
        { chained: roles.length, tokens: tokens.in + tokens.out },
        policy.limits,
        monotonicMs() - t0,
      );
      if (tripped !== null) {
        // A per-run limit almost always trips AFTER ≥1 dispatch already consumed
        // (a no-op here). If it ever trips before the run's first dispatch, this
        // keeps consumption byte-identical to the old top-of-loop behavior — it
        // is a run-limit stop, not one of stage 32's protected refusals.
        consumeApproval();
        return summary('limit_hit', `stopped at per-run limit ${tripped}`);
      }

      // Stage 19 no-progress strike, checked BEFORE the dispatch so the refused
      // run costs nothing. The key is role + GitHub target: re-running the same
      // role against the same object with nothing changed is not a retry, it is
      // the livelock. Escalate to a human (the item is then invisible to every
      // scanner tier, §4.2) rather than spending another model run.
      const key = `${plan.role}@${plan.target === null ? 'none' : `${plan.target.kind}:${plan.target.number}`}`;
      if (repeats === null) {
        repeats = priorRepeats(ctx, item, plan.role);
        repeatKey = key;
      } else if (key === repeatKey) {
        repeats += 1;
      } else {
        repeats = 0;
        repeatKey = key;
      }
      if (repeats >= MAX_REPEAT_DISPATCHES) {
        // The no-progress strike ESCALATES to a human (needs-human makes the
        // item scanner-invisible), so it is not one of stage 32's protected
        // pre-work refusals — the human now owns the item. Consume as before
        // (a no-op when a prior dispatch this run already did).
        consumeApproval();
        if (anchor !== null) {
          addLabel(ctx, anchor, NEEDS_HUMAN_LABEL);
        }
        return summary(
          'failed',
          `no progress: role ${plan.role} has already been dispatched ${repeats} times against the same target with nothing changing (${plan.reason}) — refusing to spend another model run, labeled ${NEEDS_HUMAN_LABEL}`,
        );
      }

      // Stage 54 (ADR-0024): each dispatch carries THIS ROLE's resolved config
      // (roleCfg = base overridden by agent.roles[plan.role]) — provider,
      // optional model/sandbox/approval overrides (non-null only — omitted-in
      // keeps the claude path byte-identical), and the REMAINING wall-clock
      // budget as a hard subprocess deadline (ADR-0008). With no roles map
      // roleCfg IS the base, so every flag below is byte-identical to today.
      const dispatchFlags = {
        cwd: ctx.cwd,
        'run-id': runId,
        agent: roleCfg.provider,
        'timeout-secs': remainingTimeoutSecs(policy.limits, monotonicMs() - t0),
      };
      if (roleCfg.model !== null && roleCfg.model !== undefined) {
        dispatchFlags.model = roleCfg.model;
      }
      if (roleCfg.sandbox !== null && roleCfg.sandbox !== undefined) {
        dispatchFlags.sandbox = roleCfg.sandbox;
      }
      if (roleCfg.approval !== null && roleCfg.approval !== undefined) {
        dispatchFlags.approval = roleCfg.approval;
      }
      // ADR-0011: the operator's acknowledged enforcement gaps, omitted-in — an
      // empty/absent list never reaches agent-exec, so the claude path and every
      // pre-stage-11 policy dispatch byte-identically.
      const acked = roleCfg.acknowledged_enforcement_gaps;
      if (Array.isArray(acked) && acked.length > 0) {
        dispatchFlags['acknowledge-gaps'] = acked.join(',');
      }
      // ADR-0011 tier 2, omitted-in the same way: only an explicit `2` travels,
      // so every pre-stage-14 policy dispatches byte-identically at tier 1.
      if (roleCfg.containment_tier === 2) {
        dispatchFlags['containment-tier'] = 2;
      }
      // ADR-0026 (stage 64): worker-owned work-item reconciliation, omitted-in like
      // every other knob — only an explicit true travels, so pre-stage-63 policy
      // dispatches byte-identically (no flag). agent-exec gates the flag to the plan role.
      if (roleCfg.reconcile_work_items === true) {
        dispatchFlags['reconcile-work-items'] = true;
      }
      // Stage 81 (ADR-0029): the resolved delivery substrate, omitted-in like
      // every other knob — only 'local' travels (github/absent dispatches carry
      // no flag, byte-identical), and agent-exec then narrows the role's
      // capability projection: no github_read/github_write/network on the local
      // substrate. Live since stage 83: assertSubstrateSupported admits
      // 'local' (the driver completed across stages 80–82).
      if (ctx.substrate === 'local') {
        dispatchFlags.substrate = 'local';
      }
      // ADR-0013 (stage 24), omitted-in like every other codex-only knob, now
      // PER ROLE (ADR-0024): the Verity-read GitHub facts ride along ONLY for a
      // contained CODEX dispatch that has them (the P4 first-iteration plan is
      // synthesized without consulting the dependency engine, so it carries
      // none). A claude role never gets the flag even if a decision carried
      // facts — provider-checked, so the claude path stays byte-identical.
      if (roleCfg.provider === 'codex' && plan.facts !== undefined) {
        dispatchFlags['state-snapshot'] = plan.facts;
      }
      res = agentExec.dispatch([plan.role, ...plan.args], dispatchFlags);
      // Stage 32 — the consumption point for a FRESH dispatch, and the
      // pre-work-vs-mid-work discriminator. A dispatch that spawned a model
      // (any success/gated/failed, OR an infra_error AFTER the model ran) IS
      // the work the approval authorized → consume, exactly once. A PRE-spawn
      // infra refusal (`unenforceable-policy` and its siblings) comes back FROM
      // this very call with ZERO spawns; agent-exec's stage-30 rule reports it
      // as a VERIFIED est_usd:0 (a genuine mid-run infra crash keeps est_usd
      // null — unknown, ADR-0008, contracts/agent-result.md), so that one
      // shape — and only that shape — leaves both labels intact.
      const preSpawnRefusal = res.outcome === 'infra_error' && res.est_usd === 0;
      if (!preSpawnRefusal) {
        consumeApproval();
      }
    }
    // A resumed role reads `<role> (resumed)` in the §7 roles line: honest
    // about what happened, and deliberately NOT the bare role name — the
    // stage-19 no-progress trail counts consecutive DISPATCHES of one role,
    // and a resume dispatched nothing (countRepeatedRole treats the annotated
    // name as a different entry, breaking the streak rather than inflating it).
    roles.push(resumed ? `${plan.role} (resumed)` : plan.role);
    invocations.push({
      role: plan.role,
      outcome: res.outcome,
      tokens: { in: res.tokens?.in || 0, out: res.tokens?.out || 0 },
      est_usd: typeof res.est_usd === 'number' ? res.est_usd : null,
      wall_secs: res.wall_secs || 0,
      tool_calls: res.tool_calls || 0,
      // Stage 53: provenance of the agent that produced this row. Stage 54
      // (ADR-0024) makes it PER ROLE — this role's resolved provider/model
      // (base overridden by agent.roles[plan.role]). A null model (the claude
      // default) is written as '' by the usage writer.
      provider: roleCfg.provider,
      model: roleCfg.model,
    });
    tokens.in += res.tokens?.in || 0;
    tokens.out += res.tokens?.out || 0;
    if (typeof res.est_usd === 'number') {
      estUsd = (estUsd ?? 0) + res.est_usd;
    }
    if (res.artifacts && Number.isInteger(res.artifacts.pr)) {
      lastPr = res.artifacts.pr;
    }
    // ADR-0013 (stage 24): perform the GitHub writes this result DECLARED,
    // before any outcome branching — a review's findings belong on the PR
    // whether the run then merges, gates, or pauses at the unknown-cost gate
    // (the human deciding at that gate needs them most). Default-closed and
    // best-effort inside; never changes the outcome.
    // Stage 31 (ADR-0014): except on a RESUME — those writes were performed
    // when the result parked (effects run before outcome branching, so they
    // always precede the park). Re-posting would duplicate the findings
    // comment, the exact canary-run-5 noise this stage removes.
    if (resumed) {
      if (res.artifacts?.effects !== undefined) {
        ctx.stderr(
          `verity-worker: note: GitHub effects declared by the resumed ${plan.role} result were already performed when it parked — not re-posted (ADR-0014)`,
        );
      }
    } else {
      performResultEffects(ctx, { runId, role: plan.role, res, pr: lastPr });
    }

    // Stage 37 (canary run 6, finding N1): where a POST-dispatch park announces
    // its gate. `gateTarget` is null when the dispatch was a stage with no
    // work-item issue (a non-lockable anchor) — but a PR may have been opened
    // THIS run (`lastPr`, captured just above), and that PR is exactly the item
    // an operator can approve on. Fall back to it so the label + comment + the
    // stage-31 parked pointer land there instead of being silently skipped
    // (`gatePause`'s null-target path), which wedged the day. Only for the parks
    // BELOW: the pre-dispatch plan-gate keeps `gateTarget` (there `lastPr` is a
    // stale prior iteration's PR, not this decision's), and review:merge already
    // does its own `pr ?? gateTarget`.
    const gateAnchor = gateTarget ?? lastPr;

    // Stage 76: a builder's job ends at "PR open + CI green"; the review:merge gate
    // belongs to the reviewer/worker trust ladder (T13), never the builder. A build
    // role that self-reports `gated` (mis-declaring the merge gate it must hand OFF
    // to) opened its PR and is DONE — coerce to the success handoff so the next tick
    // dispatches review, instead of parking at a human gate that blocks review from
    // EVER running (which wedges build-through under review.trust >= 1). Guarded on a
    // real PR number so a genuine no-PR build failure is untouched. The unknown-cost
    // gate is a SEPARATE post-completion checkpoint (stage 25/31), not this branch,
    // so this never swallows a legitimate cost pause.
    // Stage 81 (ADR-0029): the guard predicate is substrate-aware — on 'local'
    // the delivered-for-review evidence is the pushed stage branch (no PR
    // exists to number); github keeps the original real-PR-number guard,
    // byte-identically (buildMisdeclaredHandoff above).
    if (plan.role === 'build' && buildMisdeclaredHandoff(res, ctx.substrate)) {
      const delivered = Number.isInteger(res.artifacts?.pr)
        ? `PR #${res.artifacts.pr}`
        : `pushed stage branch ${res.git_lifecycle?.branch}`;
      ctx.stderr(
        `verity-worker: note: build role mis-declared a merge gate — treating ${delivered} as a success handoff to review (T13: builders never own the merge gate)`,
      );
      res.outcome = 'success';
      res.gate = null;
    }

    if (res.outcome === 'gated') {
      const gate = gateNameFor(plan.role, policy);
      gatePause(ctx, {
        runId,
        policy,
        target: gateAnchor,
        gate,
        pending: `role ${plan.role} stopped at a human gate — ${plan.reason}`,
      });
      return summary('gated', gatedResult(gate), gate);
    }
    if (res.outcome === 'failed') {
      // Stage 25 (#71): a FAILED role that reported no cost spends the same
      // unverifiable dollars a successful one does, but this branch returns
      // BEFORE the ADR-0008 unknown-cost block below — so the run's ledger
      // rows landed UNGATED, and the next tick's startup breaker refused
      // `30 unknown-cost-budget` with approvable:false for the rest of the
      // UTC day, on stderr alone: nothing on GitHub to see, nothing to
      // approve. Park the unknown-cost FACT at the same gate stage 21 built
      // for the success path — the label + comment make the refusal visible
      // (stage 22's machinery, no parallel channel), and the gate stamp on
      // the run's usage rows makes the deferred refusal approvable: one
      // single-use `verity:approved`, consumed like any other P1 resume and
      // recorded in that run's §7 `budget:` line. The run's OUTCOME stays
      // failed/failed_once (the 2-strike rule below is untouched). 'fail'
      // still has no approval mechanism (stage 21 parity), and under
      // allow_with_token_limit the breaker never wedges, so only the default
      // 'gate' pauses here — claude, whose costs are real numbers, never
      // enters this block at all.
      const behavior = policy.limits.unknown_cost_behavior || 'gate';
      const costGate =
        typeof res.est_usd !== 'number' &&
        behavior !== 'fail' &&
        behavior !== 'allow_with_token_limit'
          ? UNKNOWN_COST_GATE
          : null;
      if (costGate !== null) {
        gatePause(ctx, {
          runId,
          policy,
          target: gateAnchor,
          gate: costGate,
          pending: `role ${plan.role} FAILED with its cost unknown (est_usd null), so today's spend can no longer be verified and the daily breaker will refuse the next start — unknown_cost_behavior 'gate' prices continuing at one single-use approval (ADR-0008)`,
        });
      }
      // 2-strike rule: prior strikes are `unlock:* outcome:failed*` comments on
      // the item (worker stays stateless); the current failure is strike +1.
      // Stage 85 (ADR-0029): the unlock-comment trail has no local surface
      // (contract v1 carries no comments), so prior strikes read the same
      // honest FLOOR of 0 as priorRepeats — a local failure is strike 1 and
      // retries next tick; the failed outcome itself is still recorded in the
      // usage ledger and the run log. Never a fabricated count.
      const prior =
        lockable(item) && ctx.substrate !== 'local'
          ? locks.countFailures(item, { repo: ctx.repo, cwd: ctx.cwd })
          : 0;
      const strikes = prior + 1;
      if (strikes >= 2) {
        if (anchor !== null) {
          addLabel(ctx, anchor, NEEDS_HUMAN_LABEL);
        }
        return summary(
          'failed',
          `role ${plan.role} failed (strike ${strikes} — labeled ${NEEDS_HUMAN_LABEL}): ${oneLine(res.error)}`,
          costGate,
        );
      }
      return summary(
        'failed_once',
        `role ${plan.role} failed (strike 1 — will retry on next wake-up): ${oneLine(res.error)}`,
        costGate,
      );
    }
    if (res.outcome === 'infra_error') {
      // Infra is not the item's fault: NO needs-human label.
      return summary('infra', `infra error in role ${plan.role}: ${oneLine(res.error)}`);
    }

    // ADR-0008 (stage 9): est_usd null means UNKNOWN, never $0 — the
    // accumulator above skipped it, so the daily budget breaker cannot see
    // this spend. limits.unknown_cost_behavior decides what happens next:
    //   gate (default)          → the existing GATE_PAUSE path: human-gated
    //                             until cost accounting is proven
    //   fail                    → stop the run as a failure (loud, exit 20)
    //   allow_with_token_limit  → proceed; token ceilings remain the bound
    // This runs BEFORE the trust ladder so an unknown-cost review can never
    // reach the merge decision (fail closed).
    if (typeof res.est_usd !== 'number') {
      const behavior = policy.limits.unknown_cost_behavior || 'gate';
      if (behavior === 'fail') {
        return summary(
          'failed',
          `role ${plan.role} completed with unknown cost (est_usd null) and limits.unknown_cost_behavior is 'fail' — stopping the run (ADR-0008)`,
        );
      }
      if (behavior !== 'allow_with_token_limit') {
        gatePause(ctx, {
          runId,
          policy,
          target: gateAnchor,
          gate: UNKNOWN_COST_GATE,
          pending: `role ${plan.role} completed but its cost is unknown (est_usd null) — unknown_cost_behavior 'gate' pauses for a human until cost accounting is proven (ADR-0008)`,
          // Stage 31 (ADR-0014): this is a POST-COMPLETION park — the role
          // finished and its T05 result persists under ~/.verity/logs — so
          // the gate records the durable pointer an approval resumes from.
          // The stage-25 failed-run park above records none: a failure's
          // approval lets the day proceed, it never replays the failure.
          parked: parkedResultPointer(ctx, { role: plan.role, pr: lastPr }),
        });
        return summary('gated', gatedResult(UNKNOWN_COST_GATE), UNKNOWN_COST_GATE);
      }
    }

    // T13 — trust ladder (§4.5). The review agent has NO merge tool (T06); a
    // completed review only REPORTS its verdict via the T05 marker
    // (artifacts.verdict). The merge/gate decision is deterministic code here.
    if (plan.role === 'review') {
      const verdict =
        typeof res.artifacts?.verdict === 'string' ? res.artifacts.verdict.toLowerCase() : null;
      const pr = Number.isInteger(res.artifacts?.pr) ? res.artifacts.pr : lastPr;
      const gate = gateNameFor('review', policy);
      // Stage 81 (ADR-0029 §3): the stage-79 substrate travels inside the same
      // injectable ghOpts bag trust already takes — on 'local' checksGreen
      // reads the stage-80 snapshot and trust.merge performs the engine's
      // --no-ff merge; 'github' (and the undefined of a unit-built ctx) leaves
      // every gh call byte-identical. Live since stage 83:
      // assertSubstrateSupported admits 'local' (the driver is complete).
      // Stage 84 (stage-81 review finding 2): the stamp is LOCAL-ONLY — a
      // github run's ghOpts carries no substrate key, so the bag every gh call
      // receives stays exactly what it was before ADR-0029 (no
      // contract-adjacent pollution riding along on github substrates).
      const ghOpts =
        ctx.substrate === 'local' ? { cwd: ctx.cwd, substrate: 'local' } : { cwd: ctx.cwd };
      const trustLevel = policy.review.trust;

      let decision;
      if (verdict !== 'approve') {
        // Fail closed: a review success without an explicit approve verdict
        // gates — it never merges, and never loops back into review.
        decision = trust.decideMerge(verdict, trustLevel, null, null);
      } else if (pr === null) {
        decision = {
          merge: false,
          gate: true,
          reason: 'approve verdict carries no PR number — cannot act deterministically',
        };
      } else if (trustLevel === 1) {
        const classification = trust.classify(pr, policy, ghOpts);
        decision = trust.decideMerge(verdict, 1, classification, classification.checks_green);
      } else if (trustLevel === 2) {
        decision = trust.decideMerge(verdict, 2, null, trust.checksGreen(pr, ghOpts));
      } else {
        // trust 0 (and anything unknown — decideMerge fails closed on those).
        decision = trust.decideMerge(verdict, trustLevel, null, null);
      }

      if (decision.merge) {
        trust.merge(pr, ghOpts);
        mergedPrs.push(pr);
        continue; // success → chain: the merged PR may unblock the next stage.
      }
      // Stage 36 (issue #91): an `escalate` verdict is an architectural /
      // frozen-contract blocker, distinct from a code-rework request. When the
      // review.escalate_routing kill-switch is ON (default OFF), PARK the work
      // item for a human — apply verity:needs-human to the ANCHOR (guarded like
      // the failed-strike path) and name the next role in the gate — reusing
      // stage 27's needs-human mechanism verbatim (no new label, no scanner
      // change). The PR itself stays gated with its findings comment (target
      // remains pr ?? gateTarget). Flag OFF, or any non-escalate gate
      // (request_changes / unknown / absent), routes EXACTLY as today: a plain
      // gate, no needs-human, no next-role naming.
      const escalateRouting = decision.escalate === true && policy.review.escalate_routing === true;
      if (escalateRouting && anchor !== null) {
        addLabel(ctx, anchor, NEEDS_HUMAN_LABEL);
      }
      const gateReason = escalateRouting
        ? `${decision.reason} — parked for a human (labeled ${NEEDS_HUMAN_LABEL}); resolve via /verity:plan (contract/ADR amendment)`
        : decision.reason;
      gatePause(ctx, {
        runId,
        policy,
        target: pr ?? gateTarget,
        gate,
        pending: `review of ${pr === null ? 'the PR' : `PR #${pr}`} completed — ${gateReason}`,
      });
      return summary(
        'gated',
        `${pr === null ? '' : `PR #${pr} reviewed, `}gated at ${gate} — ${gateReason}`,
        gate,
      );
    }
    // Stage 73 (#202): retirement is the SOLE anti-thrash mechanism. A
    // successful plan on a P4 request that produced stages retires the request's
    // `verity:request` trigger, so the P4 scanner tier never re-selects the
    // now-planned request (later ticks fall to P5, the dependency engine, and
    // do the REAL next step). Because retirement is per-request, an un-planned
    // request stays labeled and DOES plan, and a NEW request still plans even
    // when prior work's stages exist (Mode B intake) — a stage-count guard on
    // the synthesis above would have wrongly blocked that. Reaching here means
    // res.outcome === 'success' (gated/failed/infra returned above), so
    // retirement fires ONLY after a successful plan — a failed/limit_hit plan
    // never gets here and can never strand an un-planned request with its
    // trigger removed. Guarded on readStages > 0 (a plan that produced no stages
    // keeps its label). Worker-side gh write (the contained plan role cannot
    // relabel); idempotent via removeLabel's 404 tolerance.
    if (plan.role === 'plan' && item.tier === 'P4' && ledger.readStages(ctx.cwd).length > 0) {
      removeLabel(ctx, item.number, REQUEST_LABEL);
    }
    // Stage 82 (ADR-0029 §4): a completed LOCAL build gets its gates run HERE —
    // engine-performed, synchronously, where the github path would wait on CI —
    // so the re-consulted dependency engine below reads a verified green/red
    // instead of UNKNOWN. Reaching this line means res.outcome === 'success'
    // (gated/failed/infra returned above; the stage-76 handoff coercion has
    // already applied). github/absent substrates never enter (byte-identical).
    if (ctx.substrate === 'local' && plan.role === 'build') {
      runLocalGates(ctx, plan, res);
    }
    // success → chain: re-consult the dependency engine.
  }
}

// SUMMARIZE: post the §7 comment (append-only, one per run), write the usage
// ledger row (T11). Posting is best-effort — a comment failure must not change
// the run's outcome (the lock release in runOnce's finally is the §8.1
// invariant, not this).
function summarize(ctx, policy, summary) {
  const body = formatRunSummary(summary);
  if (summary.anchor === null) {
    ctx.stdout(body);
  } else {
    try {
      postComment(ctx, summary.anchor, body);
    } catch (err) {
      ctx.stderr(
        `verity-worker: warn: failed to post run summary on #${summary.anchor}: ${oneLine(err.message)}`,
      );
    }
  }
  recordUsage(ctx, policy, summary);
}

// Stage 33 (canary run 5, defect N4): the deferred-refusal fresh-read fallback.
//
// The scanner's P1 tier finds approved items with a label-FILTERED list query
// (`gh issue|pr list --label verity:approved`), which GitHub serves from a
// SEARCH INDEX that lags label writes by seconds-to-minutes. Pre-stage-21 that
// lag was cosmetic (see the note in runLoop). Stage 21 made it load-bearing:
// under a DEFERRED daily unknown-cost refusal a P1 pick missed to index lag
// becomes a hard `30 unknown-cost-budget` exit — the operator applies
// `verity:approved` exactly as the gate comment instructs, the lagged search
// misses it, and the tick refuses a true-but-not-yet approval indistinguishably
// from the broken-approval bug this series fixed.
//
// This bounded, NON-search re-check runs ONLY when a deferred refusal is about
// to fire (both throw sites in runOnce route through it). The asymmetry that
// makes it reliable and cheap: the carrier's `verity:awaiting-approval` label
// was applied at GATE time on a PRIOR tick, so it has long settled in the
// search index — only the freshly-added `verity:approved` is missing. So:
//   1. enumerate plausible carriers with `list --label verity:awaiting-approval`
//      (open issues AND PRs — mirroring the P1 tier's two-kind coverage); this
//      settled label makes the list reliable.
//   2. for each carrier (bounded — a handful of parked gates; NO pagination),
//      do a FRESH per-item read (`gh <noun> view N --json labels`, via
//      scanner.fetchTargetLabels) that reads the primary DB, not the index, and
//      reflects the just-applied `verity:approved` immediately.
//   3. if a fresh read shows `verity:approved`, normalize the carrier into the
//      P1 item shape and return it — it then flows through the EXISTING P1
//      downstream path (budgetApproved, consumeApproval, the budget line,
//      locking, summary) with semantics identical to a normal P1 pick.
// Cost bound: one `list` per kind (2) + at most one `view` per awaiting-approval
// carrier. Fail CLOSED — a list/read error yields no recovery, so the deferred
// refusal fires byte-identically, exactly as before this fallback existed.
function recheckApprovedCarrier(ctx) {
  // Stage 85 (ADR-0029): on the LOCAL substrate the "fresh non-search read" IS
  // the record store — committed files are strongly consistent, so the primary
  // read and the settled-label enumeration are the same act: OPEN records
  // carrying the awaiting gate, of which any also carrying `verity:approved`
  // is a confirmed P1 carrier. Same FIFO pick, same fail-CLOSED direction (a
  // store the engine cannot read yields no recovery and the deferred refusal
  // fires unchanged). Zero gh spawns; github below is byte-identical.
  if (ctx.substrate === 'local') {
    try {
      const approved = substrateLocal
        .listWorkItems(ctx.cwd)
        .filter(
          (rec) =>
            rec.state === 'OPEN' &&
            rec.labels.includes(GATE_LABEL) &&
            rec.labels.includes(APPROVED_LABEL),
        )
        .map((rec) =>
          scanner.normalize(
            { number: rec.number, title: rec.title, labels: rec.labels, createdAt: rec.created_at },
            'issue',
            'P1',
          ),
        );
      if (approved.length === 0) {
        return null;
      }
      approved.sort(scanner.byCreatedAt);
      return approved[0];
    } catch (err) {
      ctx.stderr(
        `verity-worker: warn: deferred-refusal re-check could not read the local record store (${oneLine(err.message)}) — refusing as usual`,
      );
      return null;
    }
  }
  const ghOpts = { cwd: ctx.cwd };
  const carriers = [];
  for (const kind of ['issue', 'pr']) {
    let raws;
    try {
      raws = gh.json(
        [
          kind,
          'list',
          '--label',
          GATE_LABEL,
          '--state',
          'open',
          '--json',
          'number,labels,title,createdAt',
        ],
        ghOpts,
      );
    } catch (err) {
      // The settled-label enumeration itself failed — fail closed (refuse as
      // today) rather than guess. The freshly-added approval regime is exactly
      // the search whose lag we are working around, so we never widen to it.
      ctx.stderr(
        `verity-worker: warn: deferred-refusal re-check could not list ${kind} carriers (${oneLine(err.message)}) — refusing as usual`,
      );
      return null;
    }
    for (const raw of raws) {
      carriers.push({ raw, kind });
    }
  }
  const approved = [];
  for (const c of carriers) {
    // Fresh per-item read via the shared helper (gh.cjs already retries transient
    // errors before throwing). A no-op `log` makes a per-carrier read failure a
    // SILENT fail-closed SKIP: this path is ABOUT TO refuse (exit 30) or to
    // announce a recovery — the loud signal is that outcome, not a probe miss,
    // and a missed carrier only costs one self-healing re-run. The seam doubles
    // as gh.cjs's per-attempt status logger, so passing it also keeps the
    // re-check from chattering onto the refusal's single §8.2 stderr line.
    const fresh = scanner.fetchTargetLabels(
      { kind: c.kind, number: c.raw.number },
      { ...ghOpts, log: () => {} },
    );
    if (fresh?.includes(APPROVED_LABEL)) {
      const item = scanner.normalize(c.raw, c.kind, 'P1');
      // Use the FRESH labels: the list raw is search-lagged and would omit the
      // just-applied approval, but the item's labels must tell the truth.
      item.labels = fresh;
      approved.push(item);
    }
  }
  if (approved.length === 0) {
    return null;
  }
  // Deterministic pick — the scanner's own FIFO tie-break (oldest first).
  approved.sort(scanner.byCreatedAt);
  return approved[0];
}

// One full --once run. Returns { exitCode, outcome, result }.
function runOnce(ctx) {
  // Stage 29 (canary §4 re-run, defect 6): the worker is POINTED at a
  // repository (--repo owner/name is required), yet every gh subcommand that
  // "operates on a local repository" — the §4.1 circuit-breaker query, the
  // §4.2 scanner queries, the ledger reads behind `verity next`, the trust
  // ladder's pr calls — resolved its target from the CWD's git remotes:
  // stage 23's disease (trusting the cwd over the pointed-at repo) surviving
  // past the `verity state` fix. A clone with NO remotes then died inside the
  // breaker CHECK and refused `circuit-open` for a fault that has nothing to
  // do with the kill switch, making ADR-0012's truthful `git-unprovidable`
  // refusal unreachable. Thread the pointed-at repository the way gh
  // documents for scripts: GH_REPO outranks local-remote resolution for every
  // gh subprocess this run spawns (one site finishes stage 23's threading —
  // scanner, locks, ledger, git-lifecycle included) while leaving the pinned
  // §4.1/§4.2 command shapes byte-identical. Repo-agnostic calls
  // (`auth status`, `api user`, explicit `api repos/...` paths) ignore it by
  // construction.
  //
  // Stage 34 (canary run 5, defect N5): this ONE export is also how the scan
  // path's ledger reads target the pointed-at repository — the ledger's own
  // repo resolution (resolveRepo, ledger.cjs) consumes the same GH_REPO as its
  // middle precedence rung and re-emits it EXPLICITLY on each read's argv,
  // because gh's env override never reaches `repo view` (no -R flag). So a
  // remoteless clone with --repo now gets a VERIFIED snapshot, proceeds to
  // dispatch, and refuses at the git-lifecycle grant check with ADR-0012's
  // `git-unprovidable` naming the missing remote — instead of dying
  // `state-unverified` at the scan with the truthful refusal unreachable.
  if (typeof ctx.repo === 'string' && ctx.repo !== '') {
    process.env.GH_REPO = ctx.repo;
  }
  let policy;
  try {
    policy = autonomy.loadPolicy(ctx.cwd);
  } catch (err) {
    // Startup checks fail fast with exit 30 (§4.1) — even though `verity
    // autonomy validate` itself exits 20 for the same problem.
    throw new WorkerError(oneLine(err.message), 'bad-policy');
  }
  if (policy.mode === 'manual') {
    ctx.stdout(autonomy.WORKER_DISABLED_MESSAGE);
    return { exitCode: 0, outcome: 'disabled', result: autonomy.WORKER_DISABLED_MESSAGE };
  }
  // Stage 80 (ADR-0029): stamp the resolved substrate on the run context so
  // the item ops above dispatch without re-reading the policy. Stamped BEFORE
  // the check below on purpose — the check is the flow control, the stamp is
  // bookkeeping.
  ctx.substrate = policy.substrate;
  // Stage 85 (operator-smoke runs 4/5): export the run's FROZEN substrate to
  // every child this run spawns — the GH_REPO export's exact pattern, one
  // line below it in spirit. A dispatched role shells engine commands from a
  // stage-branch checkout whose tree can PREDATE the substrate policy (the
  // smoke's skew: stage branches fork off origin/<default>), and a cwd
  // re-derivation there flipped `verity state`/`verity stage pr`/`verity
  // operator snapshot` onto the github paths mid-local-run. The pin is the
  // run's own resolution traveling with the run (substrate-local
  // pinnedSubstrate honors ONLY the value 'local'); github runs export
  // nothing — byte-identical.
  // Stage 90: non-local runs also CLEAR an inherited pin. An operator shell
  // that still carries VERITY_SUBSTRATE=local after a local run (or a wrapper
  // script that exported it) would otherwise leak the stale pin to every
  // child of a github run — and pinnedSubstrate honors it: the stage-85
  // cwd-flip hazard in reverse. Deleting an absent var is a no-op, so a
  // clean environment stays byte-identical.
  if (ctx.substrate === 'local') {
    process.env.VERITY_SUBSTRATE = 'local';
  } else {
    // biome-ignore lint/performance/noDelete: assigning undefined would set the env var to the string "undefined"
    delete process.env.VERITY_SUBSTRATE;
  }
  // Stage 79 (ADR-0029): a policy selecting a substrate this engine cannot
  // drive is refused ONCE, here at policy resolution — before any gh call,
  // scan, label, or lock, exactly like the bad-policy refusal above and the
  // tier gate below. Stage 83 lifted the refusal for 'local' (drivers landed
  // in stages 80–82); unknown values still refuse fail-closed.
  assertSubstrateSupported(policy);
  // ADR-0011: unattended codex autonomy is refused below tier 2 — before any
  // gh call, scan, label, or lock, exactly like the bad-policy refusal above.
  assertContainmentTier(policy, resolveEffectiveAgent(policy));
  const checks = startupChecks(ctx, policy); // the rest of §4.1: daily limits, auth, identity, breaker
  if (!checks.ok) {
    throw new WorkerError(checks.message, checks.slug);
  }

  const runId = makeRunId();
  // The scanner's P5 tier yields nothing for a GATED decision, so a repository
  // parked at a gate would read as plain idle. Capture the decision it computed
  // (the seam already exists; this costs no extra gh call) so the gate can be
  // ANNOUNCED on GitHub when nobody has been told yet (stage 22 below), and so
  // the steady-state idle line can say WHY — a stage stopped at the stage-19
  // ci:unverified gate must never look like "nothing to do".
  let p5Decision = null;
  // Stage 28: the scanner's P4 no-self-feeding rule is by design, but its
  // silence was not — in a single-account setup (operator == bot) an open
  // `verity:request` read as plain "no eligible work" and the operator could
  // not tell "no work exists" from "your request was filtered". The scanner
  // reports the drop through its warn seam; it surfaces HERE, as a stderr
  // note on every tick that filtered something, and below as a qualified
  // idle reason. Stdout/log only — never a comment on the skipped issues.
  let selfSkipNote = null;
  let item = scanner.scan({
    cwd: ctx.cwd,
    botLogin: checks.botLogin,
    // Stage 85 (ADR-0029): the resolved substrate rides into the scanner so
    // its tier queries read the local record store instead of gh on 'local'
    // (github: byte-identical queries). The lock predicate is likewise
    // substrate-aware — the §4.3 lock protocol is a GitHub-comment protocol
    // with NO local surface (contract v1 carries no comments), so on local
    // nothing reads as locked and the run proceeds locklessly (announced at
    // the acquire site below; single-operator store, sequential --once ticks).
    substrate: ctx.substrate,
    isLocked: (it) =>
      lockable(it) &&
      ctx.substrate !== 'local' &&
      locks.isFreshlyLocked(it, { repo: ctx.repo, cwd: ctx.cwd }),
    warn: (msg) => {
      selfSkipNote = msg;
      ctx.stderr(`verity-worker: note: ${msg}`);
    },
    nextDecision: () => {
      p5Decision = next.dispatch([], { cwd: ctx.cwd });
      return p5Decision;
    },
  });

  // Stage 33: before a DEFERRED daily unknown-cost refusal fires — at either
  // throw site below, the empty-scan (`item === null`) path or the non-P1
  // fell-through path — do the bounded non-search re-check for a P1 approval the
  // search index missed to lag. A recovery REPLACES `item` with the P1 carrier
  // and flows through the ordinary P1 path unchanged (budgetApproved,
  // consumeApproval, the budget line, locking, summary); no recovery leaves
  // `item` exactly as the scan returned it, so every existing refusal / idle /
  // gate-announcement branch below stays byte-identical. Skipped when `verity
  // next` could not verify state at all (a state-unverified gate on an empty
  // scan): that is a read-failure refusal of its own (thrown below), not the
  // deferred budget refusal, and the re-check's reads would fail there too.
  const deferredArmed = checks.deferredDaily !== null && checks.deferredDaily !== undefined;
  const stateGatePending =
    item === null && p5Decision !== null && p5Decision.gate === next.STATE_GATE;
  if (deferredArmed && !stateGatePending && (item === null || item.tier !== 'P1')) {
    const recovered = recheckApprovedCarrier(ctx);
    if (recovered !== null) {
      ctx.stderr(
        `verity-worker: note: a P1 ${APPROVED_LABEL} on ${recovered.kind} #${recovered.number} was missed by the search-indexed scan (index lag) but confirmed by a fresh read — proceeding on it rather than refusing the deferred budget (stage 33)`,
      );
      item = recovered;
    }
  }

  if (item === null) {
    // Stage 20 (issue #60): the P5 tier could not read GitHub state at all, so
    // "no eligible work" would be the same confident falsehood one layer up —
    // and an idle exit 0 is precisely what a cron-driven worker's operator
    // reads as "all quiet". Refuse instead, before any lock or label.
    if (p5Decision !== null && p5Decision.gate === next.STATE_GATE) {
      throw new WorkerError(p5Decision.reason, 'state-unverified');
    }
    // Stage 21: the scan found no approved item, so the deferred unverifiable-
    // budget refusal fires now — an idle exit 0 would read as "all quiet" on a
    // day whose spend nobody can verify. Deliberately BEFORE the gate
    // announcement below: this refusal is read-only (no lock, label, or
    // comment), exactly as stage 21 built it.
    if (checks.deferredDaily !== null && checks.deferredDaily !== undefined) {
      throw new WorkerError(checks.deferredDaily.message, checks.deferredDaily.slug);
    }
    // Stage 22 (issue #59): a gated P5 decision the human has never been told
    // about. The scanner yields no item for a gated decision, so before this
    // branch a repository whose ONLY finding was e.g. the stage-19
    // ci:unverified gate parked as plain `idle` — correct refusal, visible
    // nowhere but stdout, which a cron-driven worker's operator never reads.
    // Announce it ONCE through the machinery every other gate already uses —
    // GATE_PAUSE (label + comment + approval instruction on the decision's
    // GitHub target) and the §7 SUMMARIZE — and report the run as GATED, not
    // idle: "idle" means no work exists, and that is not what happened.
    // `announced` is the dependency engine saying the gate label is already on
    // the target (this very announcement on a previous tick, or a human's own
    // label), so the steady state below stays quiet: no re-label, no comment
    // spam while the run waits for the approval its comment asked for. The
    // approval then flows exactly as for any other gate — `verity:approved`
    // makes the item a P1 pick on the next tick, which consumes the token.
    if (p5Decision !== null && p5Decision.action === 'gated' && p5Decision.announced !== true) {
      const target =
        p5Decision.target !== null && p5Decision.target.kind !== 'stage'
          ? p5Decision.target.number
          : null;
      gatePause(ctx, { runId, policy, target, gate: p5Decision.gate, pending: p5Decision.reason });
      const summary = {
        runId,
        repo: ctx.repo,
        item: { kind: p5Decision.target?.kind ?? 'stage', number: target, tier: 'P5' },
        anchor: target,
        outcome: 'gated',
        gate: p5Decision.gate,
        result: `gated at ${p5Decision.gate} — ${p5Decision.reason}`,
        roles: [],
        invocations: [],
        // Stage 53: record the run's configured provenance even on this
        // zero-dispatch gate announcement — the run HAD an agent config; a null
        // model writes '' at the usage layer, never a fabricated value.
        provider: resolveEffectiveAgent(policy).provider,
        model: resolveEffectiveAgent(policy).model,
        tokens: { in: 0, out: 0 },
        // A VERIFIED zero, not an unknown: this run dispatched no model, so
        // its cost is genuinely $0. Recording null here would serialize to an
        // unknown-cost ledger row stamped with THIS gate (not 'unknown-cost'),
        // which stage 21's rollup reads as UNGATED unknown spend — and the
        // next tick's startup breaker would then exit 30 unknown-cost-budget,
        // unapprovable, wedging the very operator the gate comment just asked
        // to approve. ADR-0008's "null never counts as $0" is about model runs
        // whose provider reported no cost; a run with zero dispatches is not
        // one of those.
        est_usd: 0,
        wall_secs: 0,
      };
      summarize(ctx, policy, summary);
      ctx.stdout(`verity-worker: ${runId} gated — ${summary.result}`);
      return { exitCode: EXIT_CODES.gated, outcome: 'gated', result: summary.result };
    }
    // Stage 28: a bare "no eligible work" is a half-truth when the P4 filter
    // dropped the operator's own request this very scan — qualify it.
    let why = 'no eligible work';
    if (p5Decision !== null && p5Decision.action === 'gated') {
      why = `no eligible work — gated at ${p5Decision.gate}: ${p5Decision.reason}`;
    } else if (p5Decision !== null && p5Decision.status === next.WAITING_FOR_CI) {
      // Stage 68 (ADR-0027): the ci:unverified gate is DEFERRED — the PR is
      // fresh and CI is still registering. This is NOT "nothing to do" and NOT a
      // gate: no label, no comment, no model run — the next tick re-reads the
      // (by then registered) checks. Say so on stdout, exit 0.
      why = p5Decision.reason;
    } else if (selfSkipNote !== null) {
      why = `no eligible work — ${selfSkipNote}`;
    }
    ctx.stdout(`verity-worker: idle — ${why}`);
    return { exitCode: 0, outcome: 'idle', result: why };
  }

  // Stage 21 (#58, ADR-0008): the deferred unverifiable-budget refusal is
  // resolved by the scan itself. A P1 item means a human applied the single-use
  // `verity:approved` the unknown-cost gate comment asked for — exactly the
  // per-run decision ADR-0008 prices 'gate' at — so THIS run proceeds and says
  // so out loud (the token is consumed in runLoop as for any P1 resume, so the
  // next unverifiable run gates again). Anything else refuses with stage 18's
  // failure, unchanged and still read-only (no lock, label, or comment yet).
  let budgetApproved = false;
  if (checks.deferredDaily !== null && checks.deferredDaily !== undefined) {
    if (item.tier !== 'P1') {
      throw new WorkerError(checks.deferredDaily.message, checks.deferredDaily.slug);
    }
    budgetApproved = true;
    ctx.stderr(
      `verity-worker: warn: daily budget cannot be verified (${checks.deferredDaily.totals.unknown_cost_runs} unknown-cost run(s) today, UTC) — proceeding on the operator's single-use ${APPROVED_LABEL} on ${item.kind} #${item.number}; the approval covers this run only (ADR-0008)`,
    );
  }

  let acquired = false;
  if (lockable(item) && ctx.substrate === 'local') {
    // Stage 85 (ADR-0029): the §4.3 lock is a GitHub-comment protocol —
    // contract local-work-item v1 (frozen) carries no comments, so there is no
    // local lock surface to write. Proceed WITHOUT a lock, out loud (the same
    // honest shape the non-lockable stage path takes): a single-operator local
    // store runs `--once` ticks sequentially, and stage 84's operator snapshot
    // reports worker.lock as honestly absent for the same reason.
    ctx.stderr(
      'verity-worker: note: local substrate has no lock surface (the §4.3 lock is a GitHub-comment protocol; contract local-work-item v1 carries no comments) — proceeding without a lock (stage 85, ADR-0029)',
    );
  } else if (lockable(item)) {
    const lock = locks.acquire(item, {
      runId,
      ttlMinutes: policy.limits.max_wall_clock_min, // ×1.5 headroom applied in locks
      repo: ctx.repo,
      cwd: ctx.cwd,
    });
    if (!lock.acquired) {
      // §8.5: accidental double-start — the second instance exits 0 "locked".
      ctx.stdout(
        `verity-worker: locked — ${item.kind} #${item.number} held by ${lock.holder.runId} (expires ${lock.holder.expires})`,
      );
      return { exitCode: 0, outcome: 'locked', result: 'item locked by another run' };
    }
    acquired = true;
  } else {
    ctx.stderr(
      `verity-worker: note: ${item.kind} target has no work-item issue — proceeding without a GitHub lock`,
    );
  }

  let outcome = 'infra'; // what the unlock comment says if we crash mid-loop
  try {
    const summary = runLoop(ctx, { policy, runId, item, budgetApproved });
    outcome = summary.outcome;
    summarize(ctx, policy, summary);
    ctx.stdout(`verity-worker: ${runId} ${outcome} — ${summary.result}`);
    return { exitCode: EXIT_CODES[outcome], outcome, result: summary.result };
  } finally {
    if (acquired) {
      locks.release(item, { runId, outcome, repo: ctx.repo, cwd: ctx.cwd }); // never throws (§8.1)
    }
  }
}

// --- CLI ----------------------------------------------------------------------

function parseWorkerArgs(argv) {
  const opts = { repo: null, once: false, watch: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') {
      i += 1;
      opts.repo = argv[i];
    } else if (a === '--cwd') {
      i += 1;
      opts.cwd = argv[i];
    } else if (a === '--once') {
      opts.once = true;
    } else if (a === '--watch') {
      opts.watch = true;
    } else {
      throw new WorkerError(`unknown argument '${a}' — ${USAGE}`, 'usage');
    }
  }
  return opts;
}

function main(argv) {
  const stdout = (line) => process.stdout.write(`${line}\n`);
  const stderr = (line) => process.stderr.write(`${line}\n`);
  try {
    const opts = parseWorkerArgs(argv);
    if (opts.watch) {
      throw new WorkerError('--watch is not implemented yet (T17) — use --once', 'not-implemented');
    }
    // Stage 52 (#135): the shared slug check. The old inline
    // /^[^/\s]+\/[^/\s]+$/ accepted 'acme/widget?' and 'acme/widget#', which
    // `gh api` truncates — retargeting apiBase (index.cjs) and locks.cjs.
    if (!gh.isRepoSlug(opts.repo)) {
      throw new WorkerError(`--repo owner/name is required — ${USAGE}`, 'usage');
    }
    if (!opts.once) {
      throw new WorkerError(`--once is required (the only implemented mode) — ${USAGE}`, 'usage');
    }
    const { exitCode, outcome, result } = runOnce({
      repo: opts.repo,
      cwd: opts.cwd,
      stdout,
      stderr,
    });
    if (exitCode !== 0) {
      stderr(`verity-worker: ${exitCode} ${ERROR_SLUGS[outcome] || 'error'}: ${oneLine(result)}`);
    }
    process.exitCode = exitCode;
  } catch (err) {
    const code = err instanceof WorkerError ? err.exitCode : 30;
    const slug = err instanceof WorkerError ? err.slug : 'internal';
    stderr(`verity-worker: ${code} ${slug}: ${oneLine(err.message)}`);
    process.exitCode = code;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  APPROVAL_ACTION,
  CIRCUIT_LABEL,
  ERROR_SLUGS,
  EXIT_CODES,
  GATE_LABEL,
  MAX_REPEAT_DISPATCHES,
  NEEDS_HUMAN_LABEL,
  OUTCOME_BADGES,
  PARKED_POINTER_RE,
  RECOGNIZED_EFFECTS,
  UNKNOWN_COST_GATE,
  USAGE,
  WorkerError,
  assertContainmentTier,
  assertSubstrateSupported,
  buildMisdeclaredHandoff,
  checkLimits,
  countRepeatedRole,
  formatFindingsComment,
  formatGateComment,
  formatRunSummary,
  performResultEffects,
  gateNameFor,
  main,
  makeRunId,
  parkedResultPointer,
  parseWorkerArgs,
  prHeadSha,
  readParkedPointer,
  recheckApprovedCarrier,
  recordUsage,
  resumeParkedResult,
  remainingTimeoutSecs,
  resolveEffectiveAgent,
  runLocalGates,
  runLoop,
  summaryRoles,
  runOnce,
  startupChecks,
};
