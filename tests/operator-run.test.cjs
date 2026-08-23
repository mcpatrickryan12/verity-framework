// Stage 49 — the operator-run contract (contracts/operator-run.md, frozen v1).
// `verity operator runs --json` and `… run <id> --json` are READ-ONLY
// projections that RECOMPOSE the local `.verity/usage.csv` ledger. These tests
// write a fixture usage.csv in a throwaway cwd (via usage.HEADER) and drive
// runs()/run() directly — ZERO network — proving every contract invariant:
//   - runs is most-recent-first with the exact wire shape + field types;
//   - started_at = completed_at − wall_secs, to the second;
//   - ADR-0008: an EMPTY est_usd cell ⇒ verified_cost_usd null + unknown_cost
//     true; a populated cell ⇒ the number + unknown_cost false; a verified 0
//     stays 0 (never null);
//   - runtime/model are null (ADR-0013 honest unknown);
//   - run <known-id> returns that run; run <unknown-id> ⇒ null (no fabrication);
//   - a multi-row (multi-role) run_id folds to ONE object; cost stays null if
//     ANY folded row is unknown-cost;
//   - a missing/empty usage.csv ⇒ runs is [] (no throw);
//   - --days / --limit bound the list;
//   - a token-shaped string in a ledger field never survives to the output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const operator = require('../verity/bin/lib/operator.cjs');
const usage = require('../verity/bin/lib/usage.cjs');

// A throwaway cwd. Pass rows (arrays of the 12 CSV cells, header order) to also
// write a `.verity/usage.csv`; omit to leave the ledger absent.
function fixtureCwd(rows) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-oprun-'));
  if (rows) {
    const dir = path.join(cwd, '.verity');
    fs.mkdirSync(dir, { recursive: true });
    const body = [usage.HEADER, ...rows.map((cells) => cells.join(','))].join('\n');
    fs.writeFileSync(path.join(dir, 'usage.csv'), `${body}\n`);
  }
  return cwd;
}

// One CSV row (header order): timestamp,run_id,repo,roles,tokens_in,tokens_out,
// est_usd,wall_secs,outcome,tool_calls,role,gate.
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

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

// ---------------------------------------------------------------------------
// (1) runs: exact wire shape, field types, most-recent-first ordering.
// ---------------------------------------------------------------------------

test('runs returns rows most-recent-first with the exact frozen wire shape and types', () => {
  const older = iso(3 * 3600 * 1000);
  const newer = iso(1 * 3600 * 1000);
  const cwd = fixtureCwd([
    row({
      timestamp: older,
      run_id: 'run-old',
      repo: 'owner/project',
      roles: 'build',
      tokens_in: 100,
      tokens_out: 20,
      est_usd: '0.5000',
      wall_secs: 300,
      outcome: 'success',
      tool_calls: 7,
      role: 'build',
    }),
    row({
      timestamp: newer,
      run_id: 'run-new',
      repo: 'owner/project',
      roles: 'review',
      tokens_in: 200,
      tokens_out: 40,
      est_usd: '1.2500',
      wall_secs: 120,
      outcome: 'gated',
      tool_calls: 3,
      role: 'review',
      gate: 'ci-unverified',
    }),
  ]);

  const list = operator.runs(cwd);
  assert(Array.isArray(list), 'runs returns an array');
  assertEqual(list.length, 2, 'both runs present');

  // Most-recent-first by completed_at.
  assertEqual(list[0].run_id, 'run-new', 'newest run first');
  assertEqual(list[1].run_id, 'run-old', 'older run second');

  const r = list[0];
  assertEqual(
    Object.keys(r).sort().join(','),
    'completed_at,gate,model,repository,roles,run_id,runtime,schema,started_at,usage,wall_secs,outcome'
      .split(',')
      .sort()
      .join(','),
    'top-level keys match the contract',
  );
  assertEqual(r.schema, 1, 'schema is integer 1');
  assertEqual(r.repository, 'owner/project', 'repository = repo cell');
  assert(Array.isArray(r.roles), 'roles is an array');
  assertEqual(r.roles.join('+'), 'review', 'roles projected');
  assertEqual(r.wall_secs, 120, 'wall_secs raw');
  assertEqual(r.outcome, 'gated', 'outcome');
  assertEqual(r.gate, 'ci-unverified', 'gate cell');
  assertEqual(r.completed_at, newer, 'completed_at = row timestamp');

  const u = r.usage;
  assertEqual(
    Object.keys(u).sort().join(','),
    'input_tokens,output_tokens,tool_calls,unknown_cost,verified_cost_usd'
      .split(',')
      .sort()
      .join(','),
    'usage keys match the contract',
  );
  assertEqual(u.input_tokens, 200, 'input_tokens = tokens_in');
  assertEqual(u.output_tokens, 40, 'output_tokens = tokens_out');
  assertEqual(u.tool_calls, 3, 'tool_calls');
  assertEqual(u.verified_cost_usd, 1.25, 'verified_cost_usd = populated est_usd');
  assertEqual(u.unknown_cost, false, 'known cost ⇒ unknown_cost false');
});

// ---------------------------------------------------------------------------
// (2) started_at = completed_at − wall_secs, to the second.
// ---------------------------------------------------------------------------

test('started_at is completed_at minus wall_secs, to the second', () => {
  const ts = iso(3600 * 1000);
  const cwd = fixtureCwd([
    row({ timestamp: ts, run_id: 'run-1', wall_secs: 597, est_usd: '0.1000' }),
  ]);
  const [r] = operator.runs(cwd);
  const started = Date.parse(r.started_at);
  const completed = Date.parse(r.completed_at);
  assertEqual(Math.round((completed - started) / 1000), 597, 'started_at = completed − wall_secs');
});

// ---------------------------------------------------------------------------
// (3) ADR-0008 cost honesty: empty ⇒ null/unknown; populated ⇒ number; 0 ⇒ 0.
// ---------------------------------------------------------------------------

test('ADR-0008: empty est_usd ⇒ null + unknown_cost; populated ⇒ number; verified 0 stays 0', () => {
  const cwd = fixtureCwd([
    row({ timestamp: iso(3000), run_id: 'run-unknown', est_usd: '' }),
    row({ timestamp: iso(2000), run_id: 'run-known', est_usd: '0.3300' }),
    row({ timestamp: iso(1000), run_id: 'run-zero', est_usd: '0' }),
  ]);
  const byId = Object.fromEntries(operator.runs(cwd).map((r) => [r.run_id, r]));

  assertEqual(byId['run-unknown'].usage.verified_cost_usd, null, 'empty ⇒ null, NEVER 0');
  assertEqual(byId['run-unknown'].usage.unknown_cost, true, 'empty ⇒ unknown_cost true');

  assertEqual(byId['run-known'].usage.verified_cost_usd, 0.33, 'populated ⇒ the number');
  assertEqual(byId['run-known'].usage.unknown_cost, false, 'populated ⇒ unknown_cost false');

  assertEqual(byId['run-zero'].usage.verified_cost_usd, 0, 'verified 0 stays 0 (not null)');
  assertEqual(byId['run-zero'].usage.unknown_cost, false, 'verified 0 ⇒ unknown_cost false');
});

// ---------------------------------------------------------------------------
// (4) runtime / model are null (ADR-0013 honest unknown).
// ---------------------------------------------------------------------------

test('runtime and model are null — the ledger does not carry them', () => {
  const cwd = fixtureCwd([row({ timestamp: iso(1000), run_id: 'run-1', est_usd: '0.1' })]);
  const [r] = operator.runs(cwd);
  assertEqual(r.runtime, null, 'runtime null');
  assertEqual(r.model, null, 'model null');
});

// ---------------------------------------------------------------------------
// (5) run <known-id> returns that run; run <unknown-id> ⇒ null (no fabrication).
// ---------------------------------------------------------------------------

test('run returns the matching run by id, or null for an unknown id', () => {
  const cwd = fixtureCwd([row({ timestamp: iso(2000), run_id: 'run-known', est_usd: '0.2' })]);
  const found = operator.run(cwd, 'run-known');
  assert(found && found.run_id === 'run-known', 'known id returns the run');
  assertEqual(found.schema, 1, 'projected shape');

  assertEqual(operator.run(cwd, 'run-nope'), null, 'unknown id ⇒ null (never a fabricated row)');
});

// ---------------------------------------------------------------------------
// (6) A multi-row (multi-role) run folds to ONE object; any-unknown ⇒ unknown.
// ---------------------------------------------------------------------------

test('a multi-row run_id folds to one object; cost stays null if any row is unknown-cost', () => {
  const t1 = iso(3000);
  const t2 = iso(2000);
  const cwd = fixtureCwd([
    row({
      timestamp: t1,
      run_id: 'run-multi',
      roles: 'build',
      tokens_in: 100,
      tokens_out: 10,
      est_usd: '0.4000',
      wall_secs: 300,
      outcome: 'success',
      tool_calls: 5,
      role: 'build',
    }),
    row({
      timestamp: t2,
      run_id: 'run-multi',
      roles: 'review',
      tokens_in: 50,
      tokens_out: 5,
      est_usd: '', // unknown-cost row
      wall_secs: 120,
      outcome: 'gated',
      tool_calls: 2,
      role: 'review',
      gate: 'ci-unverified',
    }),
  ]);

  const list = operator.runs(cwd);
  assertEqual(list.length, 1, 'the two rows fold to ONE run');
  const r = list[0];
  assertEqual(r.roles.join('+'), 'build+review', 'roles union across rows');
  assertEqual(r.usage.input_tokens, 150, 'tokens_in summed');
  assertEqual(r.usage.output_tokens, 15, 'tokens_out summed');
  assertEqual(r.usage.tool_calls, 7, 'tool_calls summed');
  assertEqual(r.wall_secs, 300, 'wall_secs = max (honest wall-clock)');
  assertEqual(r.outcome, 'gated', 'outcome from the last row');
  assertEqual(r.gate, 'ci-unverified', 'gate from the last row');
  assertEqual(r.completed_at, t2, 'completed_at = the latest row timestamp');
  assertEqual(r.usage.verified_cost_usd, null, 'any-unknown ⇒ verified_cost_usd null');
  assertEqual(r.usage.unknown_cost, true, 'any-unknown ⇒ unknown_cost true');

  // run <id> folds identically.
  assertEqual(operator.run(cwd, 'run-multi').wall_secs, 300, 'run <id> folds the same');
});

test('a multi-row run with all rows known-cost sums the known costs', () => {
  const cwd = fixtureCwd([
    row({
      timestamp: iso(3000),
      run_id: 'run-k',
      roles: 'build',
      est_usd: '0.4000',
      role: 'build',
    }),
    row({
      timestamp: iso(2000),
      run_id: 'run-k',
      roles: 'review',
      est_usd: '0.1000',
      role: 'review',
    }),
  ]);
  const [r] = operator.runs(cwd);
  assertEqual(r.usage.verified_cost_usd, 0.5, 'known costs sum');
  assertEqual(r.usage.unknown_cost, false, 'all-known ⇒ unknown_cost false');
});

// ---------------------------------------------------------------------------
// (7) Missing/empty usage.csv ⇒ runs is [] (no throw); run ⇒ null.
// ---------------------------------------------------------------------------

test('a missing usage.csv ⇒ runs is [] and run is null, no throw', () => {
  const cwd = fixtureCwd(); // no ledger written
  let list;
  assert(
    (() => {
      list = operator.runs(cwd);
      return true;
    })(),
    'runs() must not throw on a missing ledger',
  );
  assert(Array.isArray(list) && list.length === 0, 'runs ⇒ []');
  assertEqual(operator.run(cwd, 'anything'), null, 'run ⇒ null on a missing ledger');
});

test('an empty usage.csv (header only) ⇒ runs is []', () => {
  const cwd = fixtureCwd([]); // header, zero rows
  const list = operator.runs(cwd);
  assert(Array.isArray(list) && list.length === 0, 'runs ⇒ [] on a header-only ledger');
});

// ---------------------------------------------------------------------------
// (8) --limit and --days bound the list.
// ---------------------------------------------------------------------------

test('--limit bounds the list to the most-recent N', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(row({ timestamp: iso((i + 1) * 1000), run_id: `run-${i}`, est_usd: '0.1' }));
  }
  const cwd = fixtureCwd(rows);
  const limited = operator.runs(cwd, { limit: 2 });
  assertEqual(limited.length, 2, '--limit caps the count');
  // Most-recent-first: run-0 (1s ago) then run-1 (2s ago).
  assertEqual(limited[0].run_id, 'run-0', 'newest kept');
  assertEqual(limited[1].run_id, 'run-1', 'second-newest kept');
});

test('--days windows out runs older than the window', () => {
  const today = iso(1000);
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const cwd = fixtureCwd([
    row({ timestamp: eightDaysAgo, run_id: 'run-old', est_usd: '0.1' }),
    row({ timestamp: today, run_id: 'run-today', est_usd: '0.1' }),
  ]);
  // Default window is 7 UTC days → the 8-day-old run is excluded.
  const def = operator.runs(cwd);
  assertEqual(def.length, 1, 'default --days 7 excludes the 8-day-old run');
  assertEqual(def[0].run_id, 'run-today', 'only the recent run remains');
  // A wide window includes both.
  const wide = operator.runs(cwd, { days: 30 });
  assertEqual(wide.length, 2, '--days 30 includes both');
});

// ---------------------------------------------------------------------------
// (9) Redaction: a token-shaped string in a ledger field never survives.
// ---------------------------------------------------------------------------

test('a token-shaped string in a ledger field is redacted in the output', () => {
  // Assembled from RUNTIME fragments so no static `ghp_…` literal exists in this
  // source (else the promotion secret-scan smoke test would flag this file). The
  // runtime value is a valid PAT shape the redactor still catches.
  const token = `ghp_${'A'.repeat(20)}`;
  const cwd = fixtureCwd([
    row({ timestamp: iso(1000), run_id: 'run-1', repo: `o/${token}`, est_usd: '0.1' }),
  ]);
  const [r] = operator.runs(cwd);
  const serialized = JSON.stringify(r);
  assert(!serialized.includes(token), 'no token shape survives anywhere in the output');
  assert(r.repository.includes('[redacted]'), 'the repository field carries the redacted marker');
});
