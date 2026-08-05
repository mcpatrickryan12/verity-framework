// Stage 19 — "no CI" must not read as "CI red", and the worker must not
// livelock re-dispatching the same role (issue #50; the 2026-07-31 canary).
//
// Two defects, proven separately here:
//   1. `rollupGreen()` returned false for an EMPTY check set, so a repository
//      with no CI configured was indistinguishable from one whose CI fails.
//      A stage could therefore never leave `building`.
//   2. `verity next` answered that never-green PR with `work role=build`
//      every tick, and the worker spent a full model run each time —
//      `test`/`review` were never reached.
//
// The one thing this suite must NEVER let pass is the tempting shortcut:
// reading an empty check set as GREEN would merge on unverified CI, which is
// strictly worse than the bug. The "no call site treats unknown as green"
// test below is the guard against exactly that.
//
// Stub-driven like tests/worker.test.cjs (its own trimmed gh + agent stubs on
// PATH; a JSON state file holds labels/comments). No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomy = require('../verity/bin/lib/autonomy.cjs');
const ledger = require('../verity/bin/lib/ledger.cjs');
const locks = require('../verity/bin/lib/locks.cjs');
const nextLib = require('../verity/bin/lib/next.cjs');
const review = require('../verity/bin/lib/review.cjs');
const stage = require('../verity/bin/lib/stage.cjs');
const trust = require('../verity/bin/lib/trust.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// A ledger projection + raw snapshot for one stage whose PR is in the given
// CI state. `decide()` reads the three-state CI off the snapshot's PR record.
function projWith(status, pr) {
  return {
    stages: [{ number: 1, title: 'Core', type: 'feature', dependsOn: [], status, issue: 41, pr }],
    next: [1],
  };
}
function snapWith(rollup) {
  return {
    issues: [{ number: 41, labels: [] }],
    prs: [{ number: 114, labels: [], statusCheckRollup: rollup }],
  };
}
const unverifiedProj = () => projWith('building', 114);
const unverifiedSnapshot = () => snapWith([]);

// A cwd that makes review's `gh pr view` shell-out fail (no repo there).
function throwingCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-ci-nogh-'));
}

// ---------------------------------------------------------------------------
// (1) The reading itself: green / red / unknown
// ---------------------------------------------------------------------------

test('REGRESSION #50: an empty check set reads UNKNOWN, not red', () => {
  assertEqual(ledger.rollupState([]), 'unknown', 'no checks reported = unverified, not failing');
  assertEqual(ledger.rollupState(null), 'unknown', 'a missing rollup is unverified too');
  assertEqual(ledger.rollupState(undefined), 'unknown');
});

test('rollupState: genuinely-green CI still reads green', () => {
  assertEqual(ledger.rollupState([{ conclusion: 'SUCCESS' }]), 'green');
  assertEqual(
    ledger.rollupState([
      { conclusion: 'SUCCESS' },
      { conclusion: 'SKIPPED' },
      { state: 'NEUTRAL' },
    ]),
    'green',
  );
});

test('rollupState: genuinely-red CI still reads red', () => {
  assertEqual(ledger.rollupState([{ conclusion: 'FAILURE' }]), 'red');
  assertEqual(ledger.rollupState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'red');
  assertEqual(
    ledger.rollupState([{ state: 'PENDING' }]),
    'red',
    'pending is not green (unchanged)',
  );
});

test('ciStateOf: a legacy boolean snapshot can never manufacture "unknown"', () => {
  // Injected snapshots (tests, embedders) predate the third state. `false`
  // stays RED — the new state is claimable only from a rollup we actually saw.
  assertEqual(ledger.ciStateOf({ ciGreen: true }), 'green');
  assertEqual(ledger.ciStateOf({ ciGreen: false }), 'red');
  assertEqual(ledger.ciStateOf({}), 'red');
  assertEqual(ledger.ciStateOf({ statusCheckRollup: [] }), 'unknown');
  assertEqual(ledger.ciStateOf({ ciState: 'unknown' }), 'unknown');
});

// ---------------------------------------------------------------------------
// (2) The call-site audit — the anti-shortcut guard
// ---------------------------------------------------------------------------

test('NO call site treats unknown CI as green', () => {
  const unknownPr = { number: 7, state: 'OPEN', statusCheckRollup: [] };

  // ledger — the boolean projection and the snapshot stamp.
  assertEqual(ledger.rollupGreen([]), false, 'ledger.rollupGreen: unknown is not green');
  assertEqual(ledger.ciStateOf(unknownPr) === 'green', false, 'ledger.ciStateOf: not green');

  // ledger.deriveStatus — unknown must not reach the CI-green `in-review` state.
  const derived = ledger.deriveStatus(
    { number: 1, title: 'Core', type: 'feature', dependsOn: [] },
    {
      issues: [{ number: 41, title: '[stage 1] Core', state: 'OPEN', assignees: [] }],
      prs: [{ ...unknownPr, number: 114, title: '[stage 1] Core', state: 'OPEN' }],
    },
  );
  assertEqual(derived.status === 'in-review', false, 'deriveStatus: unknown never reads in-review');

  // review — the CLI merge gate.
  assertEqual(review.canMerge(ledger.rollupGreen([])), false, 'review.canMerge: refuses unknown');
  assertEqual(
    review.ciStateFor(7, throwingCwd()) === 'green',
    false,
    'review.ciStateFor: not green',
  );

  // trust — the autonomous merge gate. `gh pr checks` on a PR with no checks
  // exits nonzero, and any error reads as NOT green (fail closed).
  const noChecks = {
    exec: () => {
      throw new Error('no checks reported on this branch');
    },
  };
  assertEqual(trust.checksGreen(7, noChecks), false, 'trust.checksGreen: unknown is not green');
  assertEqual(
    trust.decideMerge('approve', 2, null, trust.checksGreen(7, noChecks)).merge,
    false,
    'trust 2 + unverified CI must not merge',
  );
  assertEqual(
    trust.decideMerge('approve', 1, { risk: 'high', reasons: ['checks are not green'] }, false)
      .merge,
    false,
    'trust 1 + unverified CI must not merge',
  );

  // next — the dispatch decision. Unknown must never produce the `in-review`
  // reading by default; it gates.
  const d = nextLib.decide(unverifiedProj(), unverifiedSnapshot());
  assertEqual(d.action, 'gated', 'next.decide: unknown gates by default');
  assertEqual(d.gate, 'ci:unverified');
});

// ---------------------------------------------------------------------------
// (3) `verity next` — the dispatch decision for each CI state
// ---------------------------------------------------------------------------

test('REGRESSION #50: a PR with NO CI gates instead of re-dispatching build forever', () => {
  const d = nextLib.decide(unverifiedProj(), unverifiedSnapshot());
  assertEqual(d.action, 'gated', 'the never-green PR stops the chain instead of re-dispatching');
  assertEqual(d.gate, 'ci:unverified');
  assertEqual(JSON.stringify(d.target), '{"kind":"pr","number":114}', 'gate lands on the PR');
  assert(/no CI checks/i.test(d.reason), `reason names the missing CI, got: ${d.reason}`);
  assertEqual(nextLib.exitCodeFor(d), 10, 'gated exits 10');
});

test('genuinely-red CI still reads red: work/build, unchanged', () => {
  const d = nextLib.decide(projWith('building', 114), snapWith([{ conclusion: 'FAILURE' }]));
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'build');
  assertEqual(d.gate, null);
  assertEqual(d.reason, 'PR #114 for stage 1 is open with CI not green');
});

test('genuinely-green CI still reads green: work/review, unchanged', () => {
  const d = nextLib.decide(projWith('in-review', 114), snapWith([{ conclusion: 'SUCCESS' }]));
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'review');
  assertEqual(d.reason, 'PR #114 awaiting review for stage 1');
});

test('unverified_ci_behavior allow_without_merge advances to review (merge still gated)', () => {
  const d = nextLib.decide(unverifiedProj(), unverifiedSnapshot(), {
    unverifiedCi: 'allow_without_merge',
  });
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'review', 'the knob advances the stage rather than looping on build');
  assert(/unverified/i.test(d.reason), `reason still says CI is unverified, got: ${d.reason}`);
  // The knob does NOT lower the merge bar — the ladder still needs verified green.
  assertEqual(trust.decideMerge('approve', 2, null, false).merge, false);
});

test('the knob is default-closed: any value that is not exactly the opt-in gates', () => {
  for (const value of [undefined, null, '', 'gate', 'yes', 'true', 'allow', 0]) {
    const d = nextLib.decide(unverifiedProj(), unverifiedSnapshot(), { unverifiedCi: value });
    assertEqual(d.action, 'gated', `unverifiedCi=${JSON.stringify(value)} must gate`);
  }
});

test('an outstanding gate label on an unverified PR keeps naming the SAME gate', () => {
  // Consecutive ticks must describe one pause one way: tick 1 gates at
  // ci:unverified and labels the item; tick 2 reads the label back and must
  // not rename the pause after the paused role.
  const snap = snapWith([]);
  snap.issues[0].labels = [{ name: 'verity:awaiting-approval' }];
  const d = nextLib.decide(unverifiedProj(), snap);
  assertEqual(d.action, 'gated');
  assertEqual(d.gate, 'ci:unverified');
  // With CI actually red, the label gate still reports the paused role exactly
  // as it always has.
  const red = snapWith([{ conclusion: 'FAILURE' }]);
  red.issues[0].labels = [{ name: 'verity:awaiting-approval' }];
  assertEqual(nextLib.decide(projWith('building', 114), red).gate, 'build', 'unchanged when red');
});

test('a snapshot that carries no PR record is not "unverified CI"', () => {
  // An injected/offline projection with no `prs` array must keep behaving
  // exactly as before — absence of data is not evidence of an empty check set.
  const d = nextLib.decide(projWith('building', 114), { issues: [{ number: 41, labels: [] }] });
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'build');
});

// ---------------------------------------------------------------------------
// (3b) The policy knob is ADDITIVE and DEFAULT-ABSENT
// (same shape as agent.acknowledged_enforcement_gaps / agent.containment_tier)
// ---------------------------------------------------------------------------

function tmpPolicy(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-ci-policy-'));
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), text);
  return dir;
}

test('stage 19 knob: default-ABSENT — no shipped default claims it', () => {
  assertEqual(
    autonomy.DEFAULTS.limits.unverified_ci_behavior,
    undefined,
    'absent from the shipped defaults, so every pre-stage-19 policy is unchanged',
  );
  for (const text of ['', 'mode: supervised\n', 'limits:\n  max_runs_per_day: 3\n']) {
    assertEqual(
      autonomy.loadPolicy(tmpPolicy(text)).limits.unverified_ci_behavior,
      undefined,
      'the knob is absent unless the operator writes it — absence gates',
    );
  }
});

test('stage 19 knob: both values load; anything else is refused with a line', () => {
  assertEqual(
    autonomy.loadPolicy(tmpPolicy('limits:\n  unverified_ci_behavior: allow_without_merge\n'))
      .limits.unverified_ci_behavior,
    'allow_without_merge',
  );
  assertEqual(
    autonomy.loadPolicy(tmpPolicy('limits:\n  unverified_ci_behavior: gate\n')).limits
      .unverified_ci_behavior,
    'gate',
  );
  let message = '';
  try {
    autonomy.loadPolicy(tmpPolicy('limits:\n  unverified_ci_behavior: sure_whatever\n'));
  } catch (err) {
    message = err.message;
  }
  assert(
    message.includes('limits.unverified_ci_behavior'),
    `an unknown value is refused, never silently ignored — got: ${message}`,
  );
});

test('stage 19 knob: the shipped JSON schema publishes it with NO default', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const knob = schema.properties.limits.properties.unverified_ci_behavior;
  assertEqual(JSON.stringify(knob.enum), '["gate","allow_without_merge"]');
  assert(!('default' in knob), 'no default — absence is the closed state');
  assert(/DEFAULT-ABSENT/.test(knob.description), 'the description says so');
  assert(/NEITHER value can merge/.test(knob.description), 'and that neither value merges');
});

// ---------------------------------------------------------------------------
// (4) The merge gate was NOT weakened
// ---------------------------------------------------------------------------

test('MERGE GATE: review merge refuses unverified CI, with a diagnostic naming it', () => {
  const dir = throwingCwd();
  let message = '';
  try {
    review.merge(dir, 7, {});
  } catch (err) {
    message = err.message;
  }
  assert(message.startsWith('refusing to merge PR #7'), `still refuses, got: ${message}`);
  assert(/UNVERIFIED/.test(message), `names the unverified state, got: ${message}`);
  assert(/no checks/i.test(message), `says the repo reports no checks, got: ${message}`);
});

test('MERGE GATE: canMerge is unchanged — only an explicit true may merge', () => {
  assertEqual(review.canMerge(true), true);
  assertEqual(review.canMerge(false), false);
  assertEqual(review.canMerge('green'), false, 'a truthy non-true value must not merge');
  assertEqual(review.canMerge(undefined), false);
});

// ---------------------------------------------------------------------------
// (5) The stop condition — repeated identical dispatches
// ---------------------------------------------------------------------------

test('the §4.3 lock/unlock comment formats are UNTOUCHED by stage 19', () => {
  // The stop condition reads the worker's own §7 run summaries, so the frozen
  // lock protocol needs no new field and gets none.
  assertEqual(locks.unlockCommentBody('run-1', 'gated'), 'unlock:run-1 outcome:gated');
  assertEqual(
    locks.lockCommentBody('run-1', '2026-07-31T00:00:00.000Z'),
    'lock:run-1 expires:2026-07-31T00:00:00.000Z',
  );
  assertEqual(locks.parseLockEvent('unlock:run-1 outcome:failed').outcome, 'failed');
  assertEqual(locks.countFailures(41, { comments: ['unlock:r outcome:failed_once'] }), 1);
});

test('summaryRoles reads the roles line out of the §7 template, and nothing else', () => {
  const body = worker.formatRunSummary({
    runId: 'run-1',
    outcome: 'success',
    roles: ['plan', 'build'],
    result: 'ok',
    tokens: { in: 1000, out: 500 },
    est_usd: 1,
    wall_secs: 61,
  });
  assertEqual(JSON.stringify(worker.summaryRoles(body)), '["plan","build"]');
  assertEqual(worker.summaryRoles('unlock:r1 outcome:success'), null, 'lock comments are not runs');
  assertEqual(worker.summaryRoles('roles: build'), null, 'only the worker’s own summaries count');
  assertEqual(
    JSON.stringify(
      worker.summaryRoles(
        worker.formatRunSummary({
          runId: 'run-2',
          outcome: 'success',
          roles: [],
          result: 'idle',
          tokens: { in: 0, out: 0 },
          est_usd: null,
          wall_secs: 1,
        }),
      ),
    ),
    '[]',
    'a run that dispatched nothing reads as the empty list',
  );
});

test('countRepeatedRole counts only the trailing run of identical single-role runs', () => {
  const summary = (roles) => ({
    body: worker.formatRunSummary({
      runId: 'run-x',
      outcome: 'success',
      roles,
      result: 'r',
      tokens: { in: 0, out: 0 },
      est_usd: 1,
      wall_secs: 1,
    }),
  });
  assertEqual(worker.countRepeatedRole([summary(['build']), summary(['build'])], 'build'), 2);
  assertEqual(
    worker.countRepeatedRole([summary(['build']), summary(['plan', 'build'])], 'build'),
    0,
    'a chained run broke the streak',
  );
  assertEqual(
    worker.countRepeatedRole([summary(['build']), summary([])], 'build'),
    0,
    'a run that dispatched nothing broke the streak',
  );
  assertEqual(
    worker.countRepeatedRole(
      [summary(['build']), { body: 'lock:r1 expires:x' }, summary(['build'])],
      'build',
    ),
    2,
    'lock/gate/human comments between runs are skipped, not counted as a break',
  );
  assertEqual(worker.countRepeatedRole([], 'build'), 0);
});

test('the repeat ceiling is exported and small enough to bound quota', () => {
  assert(worker.MAX_REPEAT_DISPATCHES >= 1, 'at least one dispatch must be allowed');
  assert(worker.MAX_REPEAT_DISPATCHES <= 3, 'the ceiling must actually bound spend');
});

// ---------------------------------------------------------------------------
// (6) End-to-end: the worker on a repository with no CI
// ---------------------------------------------------------------------------

// Trimmed twin of tests/worker.test.cjs's stub: `issue list` / `pr list`,
// `repo view`, `api user`, and the issues REST surface locks/labels/comments use.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
if (args[0] === 'auth' && args[1] === 'status') { out('Logged in as verity-bot\\n'); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  const s = state();
  let items = args[0] === 'issue' ? s.issues : s.prs;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') { out({ name: 'fixture' }); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') {
  const p = state().prs.find((x) => x.number === Number(args[2]));
  out({ labels: (p.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
  process.exit(0);
}
if (args[0] === 'api') {
  const method = flag('-X') || 'GET';
  const url = args.find((a) => a === 'user' || a.startsWith('repos/'));
  if (url === 'user') { out({ login: 'verity-bot' }); process.exit(0); }
  const m = (url || '').match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)(.*)$/);
  if (!m) { process.stderr.write('HTTP 404: no route\\n'); process.exit(1); }
  let rest = m[2] || '';
  let query = '';
  const qi = rest.indexOf('?');
  if (qi !== -1) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const s = state();
  const item = s.issues.concat(s.prs).find((it) => it.number === Number(m[1]));
  if (!item) { process.stderr.write('HTTP 404: not found\\n'); process.exit(1); }
  const fBody = () => args[args.indexOf('-f') + 1];
  if (rest === '' && method === 'GET') {
    out({ number: item.number, title: item.title, labels: (item.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
    process.exit(0);
  }
  if (rest === '/comments' && method === 'GET') {
    const page = Number((query.match(/(?:^|&)page=(\\d+)/) || [])[1] || 1);
    out(page > 1 ? [] : item.comments || []);
    process.exit(0);
  }
  if (rest === '/comments' && method === 'POST') {
    item.comments = item.comments || [];
    item.comments.push({ body: fBody().replace(/^body=/, '') });
    save(s); out({}); process.exit(0);
  }
  if (rest === '/labels' && method === 'POST') {
    item.labels = (item.labels || []).concat([fBody().replace(/^labels\\[\\]=/, '')]);
    save(s); out([]); process.exit(0);
  }
  if (rest.startsWith('/labels/') && method === 'DELETE') {
    const target = decodeURIComponent(rest.slice('/labels/'.length)).toLowerCase();
    item.labels = (item.labels || []).filter((l) => lname(l) !== target);
    save(s); out(''); process.exit(0);
  }
}
process.stderr.write('HTTP 404: unhandled gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`;

// Agent stub that POPS a queue step — an untouched queue proves the model was
// never invoked, which is the whole point of both regressions here.
const AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
const queueFile = process.env.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 1.87,
  usage: { input_tokens: 400000, cache_creation_input_tokens: 10000,
           cache_read_input_tokens: 2034, output_tokens: 38112 },
}) + '\\n');
`;

const POLICY = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-ci-unknown-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: opts.issues || [], prs: opts.prs || [] }));
  const queueFile = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(queueFile, JSON.stringify(opts.queue || []));
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY);
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  return { dir, home, bin, agent, stateFile, queueFile };
}

function runWorker(fx) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    AGENT_QUEUE: fx.queueFile,
    VERITY_AGENT_BIN: fx.agent,
  };
  try {
    const out = execFileSync('node', [WORKER, '--repo', 'octo/fixture', '--once'], {
      cwd: fx.dir,
      encoding: 'utf8',
      env,
    });
    return { code: 0, out, stderr: '' };
  } catch (err) {
    return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
  }
}

const ghState = (fx) => JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
const itemIn = (state, n) => state.issues.concat(state.prs).find((it) => it.number === n);
const comments = (state, n) => (itemIn(state, n).comments || []).map((c) => c.body);
const labelsOf = (state, n) =>
  (itemIn(state, n).labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const queueLeft = (fx) => JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length;

function stageIssue(extra = {}) {
  return {
    number: 41,
    title: '[stage 1] Core',
    state: 'OPEN',
    labels: ['verity:ready'],
    author: { login: 'human' },
    createdAt: '2026-06-01T00:00:00Z',
    assignees: [],
    comments: [],
    ...extra,
  };
}

function noCiPr(extra = {}) {
  return {
    number: 114,
    title: '[stage 1] Core',
    state: 'OPEN',
    headRefName: 'feat/stage-1-core',
    labels: [],
    statusCheckRollup: [], // the canary repo exactly: a PR with no checks at all
    comments: [],
    ...extra,
  };
}

test('e2e REGRESSION #50: a no-CI repo gates at ci:unverified — no model run at all', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [{ final: 'unused' }], // an untouched queue proves the agent never ran
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `the unverified-CI gate exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 1, 'the agent was NEVER invoked — no model run was spent');

  const state = ghState(fx);
  assert(labelsOf(state, 114).includes('verity:awaiting-approval'), 'gate label lands on the PR');
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate !== undefined, 'a GATE_PAUSE comment was posted on the PR');
  assert(gate.includes('paused at human gate `ci:unverified`'), `names the gate, got: ${gate}`);
  assert(gate.includes(worker.APPROVAL_ACTION), 'says exactly how to approve');

  // Visible in the run's OUTCOME, never silent.
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'the §7 run summary was posted');
  assert(summary.includes('⏸️ gated'), `outcome badge is gated, got: ${summary}`);
  assert(summary.includes('gated at ci:unverified'), `result names the gate, got: ${summary}`);
});

test('e2e REGRESSION #50: a second tick does NOT re-dispatch — the loop is bounded', () => {
  // The canary's exact shape: two consecutive `--once` ticks. Before the fix
  // BOTH dispatched `build` on stage 1, each a full model run.
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    // Tick 1 records an unknown-cost row, which stage 18's budget check would
    // otherwise refuse tick 2 over (exit 30 unknown-cost-budget) before the
    // scan ever happens. Loosened here so this test observes the CI livelock
    // and nothing else; the stage-18 guard has its own tests.
    policy: `${POLICY}limits:\n  unknown_cost_behavior: allow_with_token_limit\n`,
    queue: [{ final: 'unused' }, { final: 'unused' }],
  });
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 exits 0 (stderr: ${tick1.stderr})`);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 exits 0 (stderr: ${tick2.stderr})`);
  assertEqual(queueLeft(fx), 2, 'neither tick spent a model run');
  assert(
    /ci:unverified/.test(tick2.out),
    `tick 2 says WHY it stopped, never a silent idle — got: ${tick2.out}`,
  );
});

test('e2e: the human approval is meaningful — it advances to review, and merge stays gated', () => {
  // Approving the ci:unverified gate consents for THAT RUN only. The stage
  // advances to review; trust 0 still gates the merge, so nothing merges on
  // unverified CI.
  const fx = fixture({
    issues: [stageIssue({ labels: [] })],
    stages: [{ title: 'Core' }],
    prs: [noCiPr({ labels: ['verity:approved', 'verity:awaiting-approval'] })],
    queue: [
      {
        final: `Done.\n${JSON.stringify({
          verity: 1,
          outcome: 'success',
          gate: null,
          artifacts: { pr: 114, verdict: 'approve' },
          reason: 'LGTM',
        })}`,
      },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `approved run exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'the review role DID run — the approval unblocked the chain');
  const state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'OPEN', 'the PR was NOT merged on unverified CI');
  const summary = comments(state, 114).find((b) => b.startsWith('🤖'));
  assert(summary.includes('roles: review'), `the review role was dispatched, got: ${summary}`);
  assert(summary.includes('gated at review:merge'), `merge is still gated, got: ${summary}`);
});

test('e2e: the knob travels from .verity/autonomy.yml through the worker, and still cannot merge', () => {
  // Proves the policy-read path (next.dispatch resolves the knob from the same
  // policy the worker loads), not just the injected-opts path above.
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    policy: `${POLICY}limits:\n  unverified_ci_behavior: allow_without_merge\n`,
    queue: [
      {
        final: `Done.\n${JSON.stringify({
          verity: 1,
          outcome: 'success',
          gate: null,
          artifacts: { pr: 114, verdict: 'approve' },
          reason: 'LGTM',
        })}`,
      },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `run exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'the stage advanced to review instead of looping on build');
  const state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'OPEN', 'trust 0 still refuses to merge unverified CI');
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary.includes('roles: review'), `review was dispatched, got: ${summary}`);
  assert(summary.includes('gated at review:merge'), `merge is still gated, got: ${summary}`);
});

test('e2e STOP CONDITION: identical repeat dispatches escalate instead of burning quota', () => {
  // Genuinely-RED CI (not unknown): `verity next` legitimately says `build`
  // every tick. The trail already shows two runs that did nothing but `build`,
  // so the third refuses to spend another model run.
  const priorRun = (runId) => ({
    body: worker.formatRunSummary({
      runId,
      outcome: 'success',
      roles: ['build'],
      result: 'built',
      tokens: { in: 1000, out: 500 },
      est_usd: 1,
      wall_secs: 30,
    }),
  });
  const fx = fixture({
    issues: [stageIssue({ comments: [priorRun('run-a'), priorRun('run-b')] })],
    stages: [{ title: 'Core' }],
    prs: [noCiPr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })],
    queue: [{ final: 'unused' }],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 20, `the no-progress strike is loud (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 1, 'no third model run was spent');
  const state = ghState(fx);
  assert(labelsOf(state, 41).includes('verity:needs-human'), 'the item is escalated to a human');
  const summary = comments(state, 41)
    .filter((b) => b.startsWith('🤖'))
    .pop(); // this run's summary, after the two seeded ones
  assert(summary.includes('no progress'), `the summary explains why, got: ${summary}`);
  assert(summary.includes('build'), 'names the role that would have repeated');
});

test('e2e: genuinely-red CI with a clean trail still dispatches build (no false positive)', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })],
    queue: [
      {
        final: `Done.\n${JSON.stringify({
          verity: 1,
          outcome: 'gated',
          gate: 'build',
          artifacts: {},
          reason: 'needs a human',
        })}`,
      },
    ],
  });
  const { code } = runWorker(fx);
  assertEqual(code, 0, 'gated run exits 0');
  assertEqual(queueLeft(fx), 0, 'red CI still dispatches build on the first strike');
  const state = ghState(fx);
  assert(
    comments(state, 41).some((b) => /^unlock:run-\S+ outcome:gated$/.test(b)),
    'the §4.3 unlock comment is byte-identical to every one written before stage 19',
  );
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assertEqual(
    JSON.stringify(worker.summaryRoles(summary)),
    '["build"]',
    'the §7 summary is the trail the NEXT tick reads its strike count from',
  );
});
