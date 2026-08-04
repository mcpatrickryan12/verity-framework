// T11 — usage ledger + `verity usage` (SKETCH §3.4) + the §4.1 daily-limit
// rollup. Unit tests hit the lib directly; CLI tests spawn the dispatcher.
// Git-commit tests use real throwaway `git init` repos in /tmp — no network.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomy = require('../verity/bin/lib/autonomy.cjs');
const usage = require('../verity/bin/lib/usage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-usage-'));
}

function writeCsv(dir, lines) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'usage.csv'), `${lines.join('\n')}\n`);
}

// spawnSync (not execFileSync) so STDERR is captured on success too — the
// malformed-row test asserts warnings land on stderr while exit stays 0.
function runCli(args, dir) {
  const res = spawnSync('node', [CLI, ...args, '--cwd', dir], { encoding: 'utf8' });
  return { out: res.stdout || '', err: res.stderr || '', code: res.status };
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function gitRepo() {
  const dir = tmpDir();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'bot@example.com']);
  git(dir, ['config', 'user.name', 'verity-bot']);
  return dir;
}

const SUMMARY = {
  runId: 'run-20260610T120000Z-abc123',
  repo: 'octo/fixture',
  outcome: 'gated',
  roles: ['plan', 'build', 'review'],
  tokens: { in: 412034, out: 38112 },
  est_usd: 1.87,
  wall_secs: 702,
};

// --- csv row schema (§3.4 — exact column order, header required) ---------------

test('appendUsage: creates usage.csv with the EXACT §3.4 header + row, byte-exact', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T12:34:56.000Z');
  usage.appendUsage(dir, usage.entryFromSummary(SUMMARY, now));
  const lines = fs.readFileSync(path.join(dir, '.verity', 'usage.csv'), 'utf8').split('\n');
  assertEqual(
    lines[0],
    'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role',
    'header row is exactly the §3.4 column list (stage-3 additive columns last)',
  );
  assertEqual(
    lines[1],
    '2026-06-10T12:34:56.000Z,run-20260610T120000Z-abc123,octo/fixture,plan+build+review,412034,38112,1.87,702,gated,0,',
    'data row matches the column order exactly',
  );
  assertEqual(lines[2], '', 'file ends with a newline');
});

test('appendUsage: append-only — second row appended, header never duplicated', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T12:00:00.000Z');
  usage.appendUsage(dir, usage.entryFromSummary(SUMMARY, now));
  usage.appendUsage(dir, usage.entryFromSummary({ ...SUMMARY, runId: 'run-2' }, now));
  const lines = fs
    .readFileSync(path.join(dir, '.verity', 'usage.csv'), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  assertEqual(lines.length, 3, 'header + 2 rows');
  assertEqual(lines.filter((l) => l === usage.HEADER).length, 1, 'exactly one header');
  assert(lines[2].includes('run-2'), 'second row appended after the first');
});

test('entryFromSummary: null est_usd → empty cell; no roles → empty cell', () => {
  const row = usage.formatRow(
    usage.entryFromSummary(
      {
        ...SUMMARY,
        est_usd: null,
        roles: [],
        tokens: { in: 0, out: 0 },
        wall_secs: 0,
        outcome: 'success',
      },
      new Date('2026-06-10T00:00:00.000Z'),
    ),
  );
  assertEqual(
    row,
    '2026-06-10T00:00:00.000Z,run-20260610T120000Z-abc123,octo/fixture,,0,0,,0,success,0,',
  );
});

test('formatRow: cells with commas/quotes are RFC-4180 escaped and read back intact', () => {
  const entry = usage.entryFromSummary(
    { ...SUMMARY, repo: 'octo/has,comma"x' },
    new Date('2026-06-10T00:00:00.000Z'),
  );
  const row = usage.formatRow(entry);
  assert(row.includes('"octo/has,comma""x"'), 'quoted + doubled quotes');
  const dir = tmpDir();
  usage.appendUsage(dir, entry);
  const { rows } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].repo, 'octo/has,comma"x', 'round-trips through the reader');
});

// --- reader: missing / malformed input is handled gracefully -------------------

test('readUsage: missing file is an empty ledger, not an error', () => {
  const { rows, skipped, exists } = usage.readUsage(tmpDir());
  assertEqual(rows.length, 0);
  assertEqual(skipped, 0);
  assertEqual(exists, false);
});

test('readUsage: malformed rows are SKIPPED with a warning; good rows still count', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,octo/fixture,plan,100,10,0.50,60,success',
    'this,is,not,enough,columns',
    '2026-06-10T02:00:00.000Z,run-2,octo/fixture,plan,not-a-number,10,0.50,60,success',
    'not-a-date,run-3,octo/fixture,plan,100,10,0.50,60,success',
    '2026-06-10T03:00:00.000Z,run-4,octo/fixture,plan+build,200,20,,30,failed',
  ]);
  const warnings = [];
  const { rows, skipped } = usage.readUsage(dir, { warn: (m) => warnings.push(m) });
  assertEqual(rows.length, 2, 'two good rows survive');
  assertEqual(skipped, 3, 'three malformed rows skipped');
  assertEqual(warnings.length, 3, 'one warning per skipped row');
  assert(warnings[0].includes('line 3'), 'warning names the line');
  assertEqual(rows[1].est_usd, 0, 'empty est_usd cell reads as 0');
  assertEqual(rows[1].roles.join('|'), 'plan|build', 'roles split back from +');
});

// --- stage 3: additive CSV evolution (tool_calls, role; one row per invocation) --

test('readUsage: legacy 9-column files (old header + old rows) parse with NO warnings', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    '2026-06-10T01:00:00.000Z,run-1,octo/fixture,plan+build,100,10,0.50,60,success',
  ]);
  const warnings = [];
  const { rows, skipped } = usage.readUsage(dir, { warn: (m) => warnings.push(m) });
  assertEqual(warnings.length, 0, 'legacy header + rows are valid, not warned about');
  assertEqual(skipped, 0);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].tool_calls, 0, 'missing tool_calls column reads as 0');
  assertEqual(rows[0].role, '', 'missing role column reads as empty');
  assertEqual(rows[0].roles.join('|'), 'plan|build', 'legacy roles cell still splits');
});

test('readUsage: current 11-column rows carry tool_calls + role; bad tool_calls is malformed', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,build,100,10,0.50,60,success,17,build',
    '2026-06-10T02:00:00.000Z,run-1,o/r,review,50,5,0.25,30,gated,not-a-number,review',
  ]);
  const { rows, skipped } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(skipped, 1, 'unparsable tool_calls is skipped like any malformed number');
  assertEqual(rows[0].tool_calls, 17);
  assertEqual(rows[0].role, 'build');
});

test('record: summary.invocations → one row PER ROLE INVOCATION sharing the run_id, ONE commit', () => {
  const dir = gitRepo();
  const summary = {
    ...SUMMARY,
    invocations: [
      {
        role: 'plan',
        outcome: 'success',
        tokens: { in: 100, out: 10 },
        est_usd: 0.5,
        wall_secs: 60,
        tool_calls: 4,
      },
      {
        role: 'build',
        outcome: 'success',
        tokens: { in: 200, out: 20 },
        est_usd: 1.0,
        wall_secs: 300,
        tool_calls: 31,
      },
      {
        role: 'review',
        outcome: 'gated',
        tokens: { in: 50, out: 5 },
        est_usd: null,
        wall_secs: 42,
        tool_calls: 7,
      },
    ],
  };
  const res = usage.record(dir, summary, {
    commit: true,
    now: new Date('2026-06-10T12:00:00.000Z'),
  });
  assertEqual(res.rows, 3, 'three rows appended');
  assertEqual(res.committed, true, `single commit succeeded (${res.commitError})`);
  const lines = fs
    .readFileSync(path.join(dir, '.verity', 'usage.csv'), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  assertEqual(lines.length, 4, 'header + one row per invocation');
  assertEqual(
    lines[1],
    `2026-06-10T12:00:00.000Z,${SUMMARY.runId},octo/fixture,plan,100,10,0.5,60,success,4,plan`,
  );
  assertEqual(
    lines[3],
    `2026-06-10T12:00:00.000Z,${SUMMARY.runId},octo/fixture,review,50,5,,42,gated,7,review`,
    'null invocation est_usd → empty cell; invocation outcome recorded',
  );
  const { rows } = usage.readUsage(dir);
  assertEqual(new Set(rows.map((r) => r.run_id)).size, 1, 'all rows share the run_id');
  const commits = git(dir, ['rev-list', '--count', 'HEAD']).trim();
  assertEqual(commits, '1', 'exactly one commit for the whole run');
});

test('record: no invocations → single legacy-shaped run row (zero-role runs still leave a trace)', () => {
  const dir = tmpDir();
  const res = usage.record(dir, { ...SUMMARY, invocations: [] }, { commit: false });
  assertEqual(res.rows, 1);
  const { rows } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].outcome, 'gated', 'run outcome recorded on the fallback row');
  assertEqual(rows[0].role, '', 'fallback row is unattributed');
});

test('rollup: mixed-format files — runs counts DISTINCT run_ids, tool_calls sums', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    // legacy per-run row (its own run_id)
    '2026-06-10T01:00:00.000Z,run-old,o/r,plan+build,300,30,1.50,60,success',
    // stage-3 per-invocation rows: ONE run split across three rows
    '2026-06-10T02:00:00.000Z,run-new,o/r,plan,100,10,0.50,60,success,4,plan',
    '2026-06-10T03:00:00.000Z,run-new,o/r,build,200,20,1.00,300,success,31,build',
    '2026-06-10T04:00:00.000Z,run-new,o/r,review,50,5,0.25,42,gated,7,review',
  ]);
  const { rows } = usage.readUsage(dir);
  const totals = usage.rollup(rows);
  assertEqual(totals.runs, 2, 'run-old + run-new — per-invocation rows do NOT inflate runs');
  assertEqual(totals.tokens_in, 650);
  assertEqual(totals.tokens_out, 65);
  assertEqual(totals.est_usd, 3.25);
  assertEqual(totals.tool_calls, 42, 'legacy rows contribute 0 tool calls');
});

test('rollupByRole: per-role math; legacy rows group under their joined roles string', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-old,o/r,plan+build,300,30,1.50,60,success',
    '2026-06-10T02:00:00.000Z,run-a,o/r,build,200,20,1.00,300,success,31,build',
    '2026-06-10T03:00:00.000Z,run-b,o/r,build,100,10,0.50,120,failed,9,build',
    '2026-06-10T04:00:00.000Z,run-b,o/r,review,50,5,0.25,42,gated,7,review',
  ]);
  const { rows } = usage.readUsage(dir);
  const byRole = usage.rollupByRole(rows);
  assertEqual(
    JSON.stringify(Object.keys(byRole)),
    '["build","plan+build","review"]',
    'roles sorted; the unsplittable legacy attribution is its own honest group',
  );
  assertEqual(byRole.build.rows, 2);
  assertEqual(byRole.build.tokens_in, 300);
  assertEqual(byRole.build.tokens_out, 30);
  assertEqual(byRole.build.est_usd, 1.5);
  assertEqual(byRole.build.tool_calls, 40);
  assertEqual(byRole.review.tool_calls, 7);
  assertEqual(byRole['plan+build'].tool_calls, 0);
});

test('summarizeUsage: --by-role windows the same rows; omitted unless requested', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T15:00:00.000Z');
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-a,o/r,build,100,10,1.00,60,success,5,build',
    '2026-06-01T01:00:00.000Z,run-z,o/r,build,900,90,9.00,60,success,50,build', // outside window
  ]);
  const plain = usage.summarizeUsage(dir, { days: 7, now });
  assertEqual(plain.by_role, undefined, 'by_role only appears with the flag');
  const summary = usage.summarizeUsage(dir, { days: 7, now, byRole: true });
  assertEqual(summary.by_role.build.tool_calls, 5, 'window filter applies to by_role too');
  assertEqual(summary.by_role.build.est_usd, 1);
});

test('checkDailyLimits: sums unchanged across formats — split rows trip exactly like one run row', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const limits = { max_usd_per_day: 3, max_runs_per_day: 24 };
  // Legacy granularity: the whole run in one row.
  const legacyDir = tmpDir();
  writeCsv(legacyDir, [
    usage.LEGACY_HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan+build,300,30,3.00,60,success',
  ]);
  // Stage-3 granularity: the SAME run split into per-role rows.
  const splitDir = tmpDir();
  writeCsv(splitDir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,100,10,1.00,30,success,4,plan',
    '2026-06-10T01:05:00.000Z,run-1,o/r,build,200,20,2.00,30,success,31,build',
  ]);
  const legacy = usage.checkDailyLimits(legacyDir, limits, { now });
  const split = usage.checkDailyLimits(splitDir, limits, { now });
  assertEqual(legacy.ok, false, 'legacy: $3.00 >= max_usd_per_day 3 trips');
  assertEqual(split.ok, false, 'split rows sum to the same $3.00 and trip identically');
  assertEqual(legacy.totals.est_usd, split.totals.est_usd, 'identical day sums');
  assertEqual(legacy.totals.runs, 1);
  assertEqual(split.totals.runs, 1, 'shared run_id counts as ONE run against max_runs_per_day');
});

// --- rollups: UTC day windows ---------------------------------------------------

test('summarizeUsage: --days window is UTC calendar days including today', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T15:00:00.000Z');
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T00:00:00.000Z,run-a,o/r,plan,100,10,1.00,60,success', // today, at UTC midnight
    '2026-06-09T23:59:59.000Z,run-b,o/r,plan,100,10,2.00,60,failed', // yesterday (UTC)
    '2026-06-04T12:00:00.000Z,run-c,o/r,plan,100,10,4.00,60,success', // 6 days ago — in a 7-day window
    '2026-06-03T12:00:00.000Z,run-d,o/r,plan,100,10,8.00,60,gated', // 7 days ago — OUT of a 7-day window
  ]);
  const today = usage.summarizeUsage(dir, { days: 1, now });
  assertEqual(today.runs, 1, 'days=1 → today (UTC) only');
  assertEqual(today.est_usd, 1, 'yesterday 23:59:59Z excluded at the UTC boundary');
  const week = usage.summarizeUsage(dir, { days: 7, now });
  assertEqual(week.runs, 3, 'days=7 → today + 6 prior UTC days');
  assertEqual(week.est_usd, 7);
  assertEqual(week.since, '2026-06-04T00:00:00.000Z', 'window starts at UTC midnight');
  assertEqual(JSON.stringify(week.outcomes), '{"success":2,"failed":1}');
});

// --- daily-limit check (§4.1, the T11 slice — T12 reuses this) -------------------

test('checkDailyLimits: under both limits → ok', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1,1,1.00,1,success']);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24 },
    { now: new Date('2026-06-10T12:00:00.000Z') },
  );
  assertEqual(res.ok, true);
  assertEqual(res.totals.runs, 1);
});

test('checkDailyLimits: est_usd at/over max_usd_per_day → not ok, slug daily-limit', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1,1,20.00,1,success',
    '2026-06-10T02:00:00.000Z,run-2,o/r,plan,1,1,5.00,1,success',
  ]);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24 },
    { now: new Date('2026-06-10T12:00:00.000Z') },
  );
  assertEqual(res.ok, false, '>= is a trip, not >');
  assertEqual(res.slug, 'daily-limit');
  assert(res.message.includes('max_usd_per_day 25'), 'message names the limit');
});

test('checkDailyLimits: runs at max_runs_per_day → not ok; yesterday does not count', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-09T23:00:00.000Z,run-old,o/r,plan,1,1,0.10,1,success',
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1,1,0.10,1,success',
    '2026-06-10T02:00:00.000Z,run-2,o/r,plan,1,1,0.10,1,failed',
  ]);
  const limits = { max_usd_per_day: 25, max_runs_per_day: 2 };
  const res = usage.checkDailyLimits(dir, limits, { now: new Date('2026-06-10T12:00:00.000Z') });
  assertEqual(res.ok, false);
  assert(res.message.includes('max_runs_per_day 2'), 'message names the run cap');
  assertEqual(res.totals.runs, 2, "yesterday's run is outside today (UTC)");
});

test('checkDailyLimits: missing usage.csv → ok (empty ledger)', () => {
  const res = usage.checkDailyLimits(tmpDir(), { max_usd_per_day: 25, max_runs_per_day: 24 });
  assertEqual(res.ok, true);
});

// --- git commit (policy commit_usage) --------------------------------------------

test('record: commit_usage true → exactly one commit, message + csv-only pathspec', () => {
  const dir = gitRepo();
  const res = usage.record(dir, SUMMARY, { commit: true });
  assertEqual(res.committed, true, `commit succeeded (${res.commitError})`);
  assertEqual(res.commitError, null);
  const subject = git(dir, ['log', '-1', '--format=%s']).trim();
  assertEqual(subject, `chore(verity): usage ${SUMMARY.runId}`, '§3.4 commit message');
  const files = git(dir, ['show', '--name-only', '--format=', 'HEAD'])
    .trim()
    .split('\n')
    .filter((f) => f !== '');
  assertEqual(files.join(','), '.verity/usage.csv', 'ONLY the csv is committed');
});

test('record: commit failure (not a git repo) is reported, never thrown; row still appended', () => {
  const dir = tmpDir(); // /tmp — not inside any git repo
  const res = usage.record(dir, SUMMARY, { commit: true });
  assertEqual(res.committed, false);
  assert(typeof res.commitError === 'string' && res.commitError.length > 0, 'error captured');
  assert(fs.existsSync(path.join(dir, '.verity', 'usage.csv')), 'append happened regardless');
});

test('record: commit:false → no commit attempted, no error', () => {
  const dir = gitRepo();
  const res = usage.record(dir, SUMMARY, { commit: false });
  assertEqual(res.committed, false);
  assertEqual(res.commitError, null);
  let hasCommits = true;
  try {
    git(dir, ['rev-parse', 'HEAD']);
  } catch {
    hasCommits = false;
  }
  assertEqual(hasCommits, false, 'repo still has zero commits');
});

// --- policy: commit_usage key (T11 deviation — added to §2 schema/defaults) ------

test('policy: commit_usage defaults to true and validates as a boolean', () => {
  assertEqual(autonomy.DEFAULTS.commit_usage, true, 'default true per §3.4');
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'commit_usage: false\n');
  assertEqual(autonomy.loadPolicy(dir).commit_usage, false, 'file value merges over default');
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'commit_usage: sometimes\n');
  let threw = false;
  try {
    autonomy.loadPolicy(dir);
  } catch (e) {
    threw = true;
    assertEqual(e.exitCode, 20, 'schema violation is a PolicyError');
  }
  assertEqual(threw, true, 'non-boolean rejected');
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  assertEqual(schema.properties.commit_usage.type, 'boolean', 'shipped JSON schema has the key');
  assertEqual(schema.properties.commit_usage.default, true);
});

// --- CLI: `verity usage [--days 7] [--json]` --------------------------------------

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

test('cli: usage --days 7 --json → exactly one JSON object whose totals match the fixture', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    `${isoDaysAgo(0)},run-1,o/r,plan+build,1000,100,1.25,60,success`,
    `${isoDaysAgo(0)},run-2,o/r,review,2000,200,0.75,30,gated`,
    `${isoDaysAgo(6)},run-3,o/r,plan,4000,400,2.00,90,failed`,
    `${isoDaysAgo(10)},run-old,o/r,plan,8000,800,9.99,10,success`, // outside the window
  ]);
  const { out, code } = runCli(['usage', '--days', '7', '--json'], dir);
  assertEqual(code, 0);
  const lines = out.trim().split('\n');
  assertEqual(lines.length, 1, 'stdout is exactly one line');
  const obj = JSON.parse(lines[0]);
  assertEqual(obj.days, 7);
  assertEqual(obj.timezone, 'UTC');
  assertEqual(obj.runs, 3, 'the 10-day-old row is excluded');
  assertEqual(obj.tokens_in, 7000);
  assertEqual(obj.tokens_out, 700);
  assertEqual(obj.est_usd, 4);
  assertEqual(JSON.stringify(obj.outcomes), '{"success":1,"gated":1,"failed":1}');
  assertEqual(obj.skipped_rows, 0);
});

test('cli: usage defaults to --days 7; human mode carries a raw one-liner', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, `${isoDaysAgo(0)},run-1,o/r,plan,1000,100,1.25,60,success`]);
  const { out, code } = runCli(['usage'], dir);
  assertEqual(code, 0);
  const obj = JSON.parse(out);
  assertEqual(obj.days, 7);
  assertEqual(obj.runs, 1);
  assertEqual(obj.raw, 'runs=1 tokens_in=1000 tokens_out=100 est_usd=1.25 days=7');
});

test('cli: usage with no usage.csv → zero totals, exit 0', () => {
  const { out, code } = runCli(['usage', '--json'], tmpDir());
  assertEqual(code, 0);
  const obj = JSON.parse(out);
  assertEqual(obj.runs, 0);
  assertEqual(obj.est_usd, 0);
  assertEqual(JSON.stringify(obj.outcomes), '{}');
});

test('cli: malformed rows → warning on STDERR, --json stdout stays one clean object', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    'garbage line',
    `${isoDaysAgo(0)},run-1,o/r,plan,1000,100,1.25,60,success`,
  ]);
  const { out, err, code } = runCli(['usage', '--json'], dir);
  assertEqual(code, 0, 'a corrupt line never bricks the command');
  const obj = JSON.parse(out.trim());
  assertEqual(obj.runs, 1);
  assertEqual(obj.skipped_rows, 1);
  assert(err.includes('verity usage: warn:'), 'warning went to stderr');
});

test('cli: usage --by-role --json → per-role totals over the window, mixed formats', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    `${isoDaysAgo(0)},run-old,o/r,plan+build,1000,100,1.25,60,success`, // legacy row
    `${isoDaysAgo(0)},run-1,o/r,build,2000,200,0.75,30,success,12,build`,
    `${isoDaysAgo(0)},run-1,o/r,review,500,50,0.25,15,gated,3,review`,
    `${isoDaysAgo(10)},run-out,o/r,build,9000,900,9.99,10,success,99,build`, // outside window
  ]);
  const { out, code } = runCli(['usage', '--days', '7', '--by-role', '--json'], dir);
  assertEqual(code, 0);
  const obj = JSON.parse(out.trim());
  assertEqual(obj.runs, 2, 'run-old + run-1 (two rows, one run)');
  assertEqual(obj.tool_calls, 15, 'window totals include tool_calls');
  assertEqual(JSON.stringify(Object.keys(obj.by_role)), '["build","plan+build","review"]');
  assertEqual(obj.by_role.build.tokens_in, 2000, 'the 10-day-old build row is excluded');
  assertEqual(obj.by_role.build.tool_calls, 12);
  assertEqual(obj.by_role.review.est_usd, 0.25);
  const plain = JSON.parse(runCli(['usage', '--days', '7', '--json'], dir).out.trim());
  assertEqual(plain.by_role, undefined, 'no by_role without the flag');
});

test('cli: --by-role with a value is a usage error, exit 1', () => {
  const { code, err } = runCli(['usage', '--by-role', 'yes'], tmpDir());
  assertEqual(code, 1);
  assert(err.includes('--by-role'), 'error names the flag');
});

test('cli: bad --days values are usage errors, exit 1', () => {
  const dir = tmpDir();
  for (const bad of ['0', '-3', 'week', '1.5']) {
    const { code, err } = runCli(['usage', '--days', bad], dir);
    assertEqual(code, 1, `--days ${bad} rejected`);
    assert(err.includes('--days'), 'error names the flag');
  }
  const { code } = runCli(['usage', 'extra-arg'], dir);
  assertEqual(code, 1, 'positional args rejected');
});
