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
//     res = agent-exec role (module API);
//     gated → GATE_PAUSE; failed → 2-strike via unlock-comment counting
//       (locks.countFailures + 1 for the current strike) → needs-human label +
//       SUMMARIZE(failed), else SUMMARIZE(failed_once);
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
//   4. `gh auth status`                      → 30 `gh-auth`
//   5. bot identity (`gh api user`; lookup failure → `gh-auth`);
//      bot login ∈ policy humans (case-insensitive — GitHub logins are)
//                                            → 30 `bot-is-human`
//   6. any OPEN issue labeled verity:circuit-open (or breaker unreadable —
//      fail closed)                          → 30 `circuit-open`
const agentExec = require('../bin/lib/agent-exec.cjs');
const autonomy = require('../bin/lib/autonomy.cjs');
const gh = require('../bin/lib/gh.cjs');
const { LABELS } = require('../bin/lib/labels.cjs');
const locks = require('../bin/lib/locks.cjs');
const next = require('../bin/lib/next.cjs');
const scanner = require('../bin/lib/scanner.cjs');
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

function apiBase(ctx, number) {
  return `repos/${ctx.repo}/issues/${number}`;
}

function addLabel(ctx, number, label) {
  gh.run(['api', '-X', 'POST', `${apiBase(ctx, number)}/labels`, '-f', `labels[]=${label}`], {
    cwd: ctx.cwd,
  });
}

// Tolerates already-absent labels (HTTP 404) so consume/cleanup is idempotent.
function removeLabel(ctx, number, label) {
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

function postComment(ctx, number, body) {
  gh.run(['api', '-X', 'POST', `${apiBase(ctx, number)}/comments`, '-f', `body=${body}`], {
    cwd: ctx.cwd,
  });
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
// provider's cost accounting is proven).
const UNKNOWN_COST_GATE = 'unknown-cost';

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
function resolveEffectiveAgent(policy) {
  return Object.freeze({
    provider: 'claude',
    model: null,
    sandbox: null,
    approval: null,
    ...(policy.agent || {}),
  });
}

function fmtTokens(n) {
  return `${Math.round(n / 1000)}k`;
}

function fmtWall(secs) {
  return `${Math.floor(secs / 60)}m${secs % 60}s`;
}

// SKETCH §7 — exact template. The approve line appears ONLY when gated.
function formatRunSummary(s) {
  const usd = typeof s.est_usd === 'number' ? s.est_usd.toFixed(2) : '?';
  const lines = [
    `🤖 **verity-worker** \`${s.runId}\` — ${OUTCOME_BADGES[s.outcome]}`,
    `roles: ${s.roles.length > 0 ? s.roles.join(' → ') : '(none)'}`,
    `result: ${s.result}`,
    `tokens: ${fmtTokens(s.tokens.in)} in / ${fmtTokens(s.tokens.out)} out · est $${usd} · wall ${fmtWall(s.wall_secs)}`,
  ];
  if (s.outcome === 'gated') {
    lines.push(`approve: ${APPROVAL_ACTION}`);
  }
  return lines.join('\n');
}

// GATE_PAUSE comment: what's pending, the exact approval action, @mentions.
function formatGateComment({ runId, gate, pending, mentions }) {
  const lines = [
    `⏸️ **verity-worker** \`${runId}\` — paused at human gate \`${gate}\``,
    `pending: ${pending}`,
    `approve: ${APPROVAL_ACTION}`,
  ];
  if (mentions.length > 0) {
    lines.push(`cc ${mentions.map((m) => `@${m}`).join(' ')}`);
  }
  return lines.join('\n');
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
  if (!daily.ok) {
    return daily;
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
  //    worker. An unreadable breaker fails closed (halt) — never open.
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

  return { ok: true, botLogin };
}

// --- the run loop (§4.4) ------------------------------------------------------

// `target` is the gate's GitHub item number (the dispatch decision's issue/PR,
// or the trust ladder's PR) — NOT necessarily the run's locked anchor.
function gatePause(ctx, { runId, policy, target, gate, pending }) {
  if (target === null) {
    ctx.stderr('verity-worker: note: gated with no GitHub target — gate label/comment skipped');
    return;
  }
  addLabel(ctx, target, GATE_LABEL);
  postComment(
    ctx,
    target,
    formatGateComment({ runId, gate, pending, mentions: policy.notify?.mention || [] }),
  );
}

function runLoop(ctx, { policy, runId, item }) {
  const t0 = monotonicMs(); // monotonic: elapsed never shrinks (ADR-0008)
  const agentCfg = resolveEffectiveAgent(policy); // frozen — one config per run
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

  // P1 approved-resume: consume the single-use token (§1) BEFORE working. The
  // gate label is removed with it — leaving `verity:awaiting-approval` behind
  // would make the next `verity next` call re-gate the item the human just
  // approved.
  // Known edge (T14 integration finding): GitHub's label-FILTERED list queries
  // are search-index backed and eventually consistent, so an approval applied
  // seconds before a tick can be missed by the scanner's P1 query while the
  // P5 dependency engine (which reads fresh `--json labels`) still treats the
  // approved item as plain work. The work proceeds correctly; only the token
  // consumption is skipped (labels linger on the item — cosmetic). Under the
  // documented cron cadence the index has long settled; accepted for v1.
  if (item.tier === 'P1') {
    removeLabel(ctx, item.number, APPROVED_LABEL);
    removeLabel(ctx, item.number, GATE_LABEL);
  }

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
    tokens,
    est_usd: estUsd,
    wall_secs: Math.round((monotonicMs() - t0) / 1000),
  });
  const gatedResult = (gate) =>
    `${lastPr === null ? '' : `PR #${lastPr} opened, `}gated at ${gate}`;

  let first = true;
  for (;;) {
    // Ground truth every iteration — with one extension: a P4 request's first
    // role is `plan` on the request issue (the dependency engine knows stages,
    // not requests; planning is what turns the request INTO stages).
    let plan;
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
      plan = next.dispatch([], { cwd: ctx.cwd });
    }
    first = false;
    if (anchor === null && plan.target !== null && plan.target.kind !== 'stage') {
      anchor = plan.target.number;
    }
    // Where a gate label/comment would land this iteration: the dispatch
    // decision's GitHub item (issue/PR), else the run's anchor.
    const gateTarget =
      plan.target !== null && plan.target.kind !== 'stage' ? plan.target.number : anchor;

    if (plan.action === 'idle') {
      const mergedNote =
        mergedPrs.length > 0 ? ` — auto-merged PR ${mergedPrs.map((n) => `#${n}`).join(', ')}` : '';
      return summary('success', `${plan.reason || 'no work remaining'}${mergedNote}`);
    }
    if (plan.action === 'gated') {
      gatePause(ctx, { runId, policy, target: gateTarget, gate: plan.gate, pending: plan.reason });
      return summary('gated', gatedResult(plan.gate), plan.gate);
    }

    const tripped = checkLimits(
      { chained: roles.length, tokens: tokens.in + tokens.out },
      policy.limits,
      monotonicMs() - t0,
    );
    if (tripped !== null) {
      return summary('limit_hit', `stopped at per-run limit ${tripped}`);
    }

    // Every dispatch carries the run's immutable agent config: provider,
    // optional model/sandbox/approval overrides (non-null only — omitted-in
    // keeps the claude path byte-identical), and the REMAINING wall-clock
    // budget as a hard subprocess deadline (ADR-0008).
    const dispatchFlags = {
      cwd: ctx.cwd,
      'run-id': runId,
      agent: agentCfg.provider,
      'timeout-secs': remainingTimeoutSecs(policy.limits, monotonicMs() - t0),
    };
    if (agentCfg.model !== null && agentCfg.model !== undefined) {
      dispatchFlags.model = agentCfg.model;
    }
    if (agentCfg.sandbox !== null && agentCfg.sandbox !== undefined) {
      dispatchFlags.sandbox = agentCfg.sandbox;
    }
    if (agentCfg.approval !== null && agentCfg.approval !== undefined) {
      dispatchFlags.approval = agentCfg.approval;
    }
    const res = agentExec.dispatch([plan.role, ...plan.args], dispatchFlags);
    roles.push(plan.role);
    invocations.push({
      role: plan.role,
      outcome: res.outcome,
      tokens: { in: res.tokens?.in || 0, out: res.tokens?.out || 0 },
      est_usd: typeof res.est_usd === 'number' ? res.est_usd : null,
      wall_secs: res.wall_secs || 0,
      tool_calls: res.tool_calls || 0,
    });
    tokens.in += res.tokens?.in || 0;
    tokens.out += res.tokens?.out || 0;
    if (typeof res.est_usd === 'number') {
      estUsd = (estUsd ?? 0) + res.est_usd;
    }
    if (res.artifacts && Number.isInteger(res.artifacts.pr)) {
      lastPr = res.artifacts.pr;
    }

    if (res.outcome === 'gated') {
      const gate = gateNameFor(plan.role, policy);
      gatePause(ctx, {
        runId,
        policy,
        target: gateTarget,
        gate,
        pending: `role ${plan.role} stopped at a human gate — ${plan.reason}`,
      });
      return summary('gated', gatedResult(gate), gate);
    }
    if (res.outcome === 'failed') {
      // 2-strike rule: prior strikes are `unlock:* outcome:failed*` comments on
      // the item (worker stays stateless); the current failure is strike +1.
      const prior = lockable(item)
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
        );
      }
      return summary(
        'failed_once',
        `role ${plan.role} failed (strike 1 — will retry on next wake-up): ${oneLine(res.error)}`,
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
          target: gateTarget,
          gate: UNKNOWN_COST_GATE,
          pending: `role ${plan.role} completed but its cost is unknown (est_usd null) — unknown_cost_behavior 'gate' pauses for a human until cost accounting is proven (ADR-0008)`,
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
      const ghOpts = { cwd: ctx.cwd };
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
      gatePause(ctx, {
        runId,
        policy,
        target: pr ?? gateTarget,
        gate,
        pending: `review of ${pr === null ? 'the PR' : `PR #${pr}`} completed — ${decision.reason}`,
      });
      return summary(
        'gated',
        `${pr === null ? '' : `PR #${pr} reviewed, `}gated at ${gate} — ${decision.reason}`,
        gate,
      );
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

// One full --once run. Returns { exitCode, outcome, result }.
function runOnce(ctx) {
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
  const checks = startupChecks(ctx, policy); // the rest of §4.1: daily limits, auth, identity, breaker
  if (!checks.ok) {
    throw new WorkerError(checks.message, checks.slug);
  }

  const runId = makeRunId();
  const item = scanner.scan({
    cwd: ctx.cwd,
    botLogin: checks.botLogin,
    isLocked: (it) => lockable(it) && locks.isFreshlyLocked(it, { repo: ctx.repo, cwd: ctx.cwd }),
  });
  if (item === null) {
    ctx.stdout('verity-worker: idle — no eligible work');
    return { exitCode: 0, outcome: 'idle', result: 'no eligible work' };
  }

  let acquired = false;
  if (lockable(item)) {
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
    const summary = runLoop(ctx, { policy, runId, item });
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
    if (typeof opts.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
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
  NEEDS_HUMAN_LABEL,
  OUTCOME_BADGES,
  UNKNOWN_COST_GATE,
  USAGE,
  WorkerError,
  checkLimits,
  formatGateComment,
  formatRunSummary,
  gateNameFor,
  main,
  makeRunId,
  parseWorkerArgs,
  recordUsage,
  remainingTimeoutSecs,
  resolveEffectiveAgent,
  runLoop,
  runOnce,
  startupChecks,
};
