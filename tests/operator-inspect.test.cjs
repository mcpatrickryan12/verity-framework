// Stage 51 — the operator-inspect contract (contracts/operator-inspect.md, frozen
// v1). `verity operator policy|usage|diagnostics --json` are READ-ONLY projections
// that RECOMPOSE three existing internal derivations (autonomy.loadPolicy,
// usage.summarizeUsage, doctor.runChecks) into stable, Console-facing shapes.
// These tests drive policy()/usage()/diagnostics() directly against a throwaway
// cwd holding `.verity/autonomy.yml` / `.verity/usage.csv` fixtures — ZERO network
// (all three sources are local files or read-only host probes) — proving:
//   - policy on a VALID file ⇒ valid:true with mode/trust/limits + the full policy;
//     on a MALFORMED file ⇒ valid:false + reason + policy:null (never a fabricated
//     default);
//   - usage over a fixture ledger ⇒ correct runs/tokens/outcomes; ADR-0008 —
//     verified_cost_usd is the KNOWN-cost sum and travels beside unknown_cost_runs;
//     --by-role populates by_role, absent ⇒ by_role:null; a missing ledger ⇒ zeroed
//     totals, no throw;
//   - diagnostics ⇒ a non-empty checks array of {name,present,version,ok,detail}
//     with overall consistent with doctor.exitCodeFor;
//   - a token-shaped string reaching a field is redacted (token assembled from
//     RUNTIME fragments so no literal `ghp_…` sits in this source).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const operator = require('../verity/bin/lib/operator.cjs');
const usage = require('../verity/bin/lib/usage.cjs');
const doctor = require('../verity/bin/lib/doctor.cjs');

// A throwaway cwd. `files` maps a `.verity/<name>` relative path → file body; omit
// to leave `.verity` empty (no policy, no ledger).
function fixtureCwd(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-opinspect-'));
  if (files) {
    const dir = path.join(cwd, '.verity');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
  }
  return cwd;
}

// One usage.csv row (HEADER order): timestamp,run_id,repo,roles,tokens_in,
// tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate.
function row(o) {
  return [
    o.timestamp,
    o.run_id,
    o.repo ?? 'o/r',
    o.roles ?? '',
    String(o.tokens_in ?? 0),
    String(o.tokens_out ?? 0),
    o.est_usd ?? '', // '' = empty cell = unknown cost (ADR-0008)
    String(o.wall_secs ?? 0),
    o.outcome ?? 'success',
    String(o.tool_calls ?? 0),
    o.role ?? '',
    o.gate ?? '',
  ];
}

function usageCsv(rows) {
  return `${[usage.HEADER, ...rows.map((cells) => cells.join(','))].join('\n')}\n`;
}

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

// ---------------------------------------------------------------------------
// (1) policy: a VALID .verity/autonomy.yml ⇒ valid:true with the projections
//     and the full effective policy object.
// ---------------------------------------------------------------------------

test('policy on a valid autonomy.yml ⇒ valid:true with mode/trust/limits and the full policy', () => {
  const cwd = fixtureCwd({
    'autonomy.yml': [
      'mode: supervised',
      'review:',
      '  trust: 2',
      '  escalate_routing: true',
      'limits:',
      '  max_runs_per_day: 10',
      '  max_usd_per_day: 5.0',
      '  unverified_ci_behavior: allow_without_merge',
      '',
    ].join('\n'),
  });

  const p = operator.policy(cwd);
  assertEqual(p.schema, 1, 'schema is integer 1');
  assertEqual(p.valid, true, 'valid policy ⇒ valid:true');
  assertEqual(p.mode, 'supervised', 'mode projected');
  assertEqual(p.trust, 2, 'trust = review.trust');
  assertEqual(p.limits.max_runs_per_day, 10, 'max_runs_per_day projected');
  assertEqual(p.limits.max_usd_per_day, 5, 'max_usd_per_day projected');
  assertEqual(
    p.limits.unverified_ci_behavior,
    'allow_without_merge',
    'unverified_ci_behavior projected',
  );
  // The ADR-0008 knob is always present via the merged default even when the
  // fixture does not set it (defaults to 'gate') — surfaced in the convenience view.
  assertEqual(p.limits.unknown_cost_behavior, 'gate', 'unknown_cost_behavior projected (default)');
  assertEqual(p.review.escalate_routing, true, 'review.escalate_routing projected');
  // The FULL effective policy is carried verbatim (defaults merged in).
  assert(p.policy && typeof p.policy === 'object', 'full effective policy present');
  assertEqual(p.policy.mode, 'supervised', 'policy.mode is the effective mode');
  assertEqual(p.policy.review.trust, 2, 'policy carries the merged review block');
  assert(Array.isArray(p.policy.gates), 'policy carries defaulted-in fields (gates)');
});

// ---------------------------------------------------------------------------
// (2) policy: a MALFORMED file ⇒ valid:false + reason + policy:null (fail-honest,
//     NEVER a fabricated default presented as the live policy).
// ---------------------------------------------------------------------------

test('policy on a malformed autonomy.yml ⇒ valid:false + reason + policy:null (no fabricated default)', () => {
  // An invalid `mode` enum value → autonomy.loadPolicy throws PolicyError.
  const cwd = fixtureCwd({ 'autonomy.yml': 'mode: bogus-not-a-real-mode\n' });

  const p = operator.policy(cwd);
  assertEqual(p.schema, 1, 'schema still present on the honest-failure shape');
  assertEqual(p.valid, false, 'unparseable policy ⇒ valid:false');
  assert(typeof p.reason === 'string' && p.reason.length > 0, 'a reason string is present');
  assertEqual(p.policy, null, 'policy is null — never a fabricated default');
  // Fail-honest: the convenience projections must not appear as a fake live policy.
  assertEqual(p.mode, undefined, 'no fabricated top-level mode on the invalid shape');
});

// ---------------------------------------------------------------------------
// (3) usage: correct runs / tokens / outcomes over a fixture ledger; ADR-0008
//     verified_cost_usd (known-cost sum) travels beside unknown_cost_runs.
// ---------------------------------------------------------------------------

test('usage projects runs/tokens/outcomes and pairs verified_cost_usd with unknown_cost_runs (ADR-0008)', () => {
  const cwd = fixtureCwd({
    'usage.csv': usageCsv([
      row({
        timestamp: iso(3000),
        run_id: 'run-a',
        tokens_in: 100,
        tokens_out: 20,
        est_usd: '0.5000',
        outcome: 'success',
        tool_calls: 5,
      }),
      row({
        timestamp: iso(2000),
        run_id: 'run-b',
        tokens_in: 200,
        tokens_out: 40,
        est_usd: '1.2500',
        outcome: 'gated',
        tool_calls: 3,
      }),
      // An EMPTY est_usd cell ⇒ an unknown-cost run (must not be summed as $0).
      row({
        timestamp: iso(1000),
        run_id: 'run-c',
        tokens_in: 10,
        tokens_out: 2,
        est_usd: '',
        outcome: 'success',
        tool_calls: 1,
      }),
    ]),
  });

  const u = operator.usage(cwd);
  assertEqual(u.schema, 1, 'schema is integer 1');
  assertEqual(u.timezone, 'UTC', 'timezone UTC');
  assertEqual(u.runs, 3, 'runs counts distinct run_ids');
  assertEqual(u.tokens_in, 310, 'tokens_in summed');
  assertEqual(u.tokens_out, 62, 'tokens_out summed');
  assertEqual(u.tool_calls, 9, 'tool_calls summed');
  assertEqual(u.outcomes.success, 2, 'outcomes tallies success rows');
  assertEqual(u.outcomes.gated, 1, 'outcomes tallies gated rows');
  // ADR-0008: both fields present; verified_cost_usd is the KNOWN-cost sum only.
  assertEqual(u.verified_cost_usd, 1.75, 'verified_cost_usd = the KNOWN-cost sum (0.50 + 1.25)');
  assert(u.unknown_cost_runs >= 1, 'the empty-cost row is counted, never summed as $0');
  assertEqual(u.unknown_cost_runs, 1, 'exactly one unknown-cost run');
  assert('verified_cost_usd' in u && 'unknown_cost_runs' in u, 'both fields travel side by side');
  assertEqual(u.by_role, null, 'by_role is null without --by-role');
});

// ---------------------------------------------------------------------------
// (4) usage: --by-role / byRole:true populates by_role; else null.
// ---------------------------------------------------------------------------

test('usage with byRole:true populates by_role; without it by_role is null', () => {
  const cwd = fixtureCwd({
    'usage.csv': usageCsv([
      row({ timestamp: iso(2000), run_id: 'run-a', est_usd: '0.5', role: 'build' }),
      row({ timestamp: iso(1000), run_id: 'run-b', est_usd: '0.5', role: 'review' }),
    ]),
  });

  const withRole = operator.usage(cwd, { byRole: true });
  assert(withRole.by_role && typeof withRole.by_role === 'object', 'by_role populated');
  assert('build' in withRole.by_role, 'by_role keyed by role');
  assert('review' in withRole.by_role, 'by_role keyed by role');

  const withoutRole = operator.usage(cwd);
  assertEqual(withoutRole.by_role, null, 'by_role null when not requested');
});

// ---------------------------------------------------------------------------
// (5) usage: a missing ledger ⇒ zeroed totals, no throw (never fabricated).
// ---------------------------------------------------------------------------

test('usage over a missing ledger ⇒ zeroed totals with no throw', () => {
  const cwd = fixtureCwd(); // no .verity/usage.csv
  let u;
  assert(
    (() => {
      u = operator.usage(cwd);
      return true;
    })(),
    'usage() must not throw on a missing ledger',
  );
  assertEqual(u.runs, 0, 'runs is honest zero');
  assertEqual(u.tokens_in, 0, 'tokens_in zero');
  assertEqual(u.tokens_out, 0, 'tokens_out zero');
  assertEqual(u.tool_calls, 0, 'tool_calls zero');
  assertEqual(u.verified_cost_usd, 0, 'verified_cost_usd is the honest zero sum');
  assertEqual(u.unknown_cost_runs, 0, 'unknown_cost_runs paired even at zero');
});

// ---------------------------------------------------------------------------
// (6) diagnostics: a non-empty checks array with the row shape and a consistent
//     overall pass/fail.
// ---------------------------------------------------------------------------

test('diagnostics ⇒ non-empty checks rows with overall consistent with doctor.exitCodeFor', () => {
  const cwd = fixtureCwd();
  const d = operator.diagnostics(cwd);
  assertEqual(d.schema, 1, 'schema is integer 1');
  assert(Array.isArray(d.checks) && d.checks.length > 0, 'checks is a non-empty array');
  for (const c of d.checks) {
    assert('name' in c, 'row has name');
    assert('present' in c, 'row has present');
    assert('version' in c, 'row has version');
    assert('ok' in c, 'row has ok');
    assert('detail' in c, 'row has detail');
  }
  assert(d.overall === 'pass' || d.overall === 'fail', 'overall ∈ pass/fail');
  // Recompute the verdict independently and assert consistency.
  const expected = doctor.exitCodeFor(doctor.runChecks({})) === 0 ? 'pass' : 'fail';
  assertEqual(d.overall, expected, 'overall matches doctor.exitCodeFor');
});

// ---------------------------------------------------------------------------
// (7) redaction: a token-shaped string reaching a field is redacted. The token
//     is assembled from RUNTIME fragments so no literal `ghp_…` exists in this
//     source (else the promotion secret-scan smoke test would flag this file).
// ---------------------------------------------------------------------------

test('a token-shaped string in a policy value is redacted in the output', () => {
  const token = `ghp_${'A'.repeat(20)}`;
  const cwd = fixtureCwd({
    'autonomy.yml': ['mode: supervised', 'agent:', `  model: ${token}`, ''].join('\n'),
  });

  const p = operator.policy(cwd);
  const serialized = JSON.stringify(p);
  assert(!serialized.includes(token), 'no token shape survives anywhere in the output');
  assert(serialized.includes('[redacted]'), 'the token was replaced with the redacted marker');
});
