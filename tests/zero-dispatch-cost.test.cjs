// Stage 30 — a run that dispatches nothing must record a verified zero cost
// on every exit path (canary run 5, defect N1: ticks 6/8/9/11 → the tick-13
// non-approvable day wedge).
//
// The defect (third occurrence of the null-vs-zero class): `runLoop`'s
// summary serialized `est_usd: estUsd`, which is null when no role ran — so a
// parked-success tick (stage 27), a pre-spawn dispatch refusal (`infra_error`)
// and an unverified-state stop (`infra`) each wrote an UNGATED unknown-cost
// ledger row, and the startup breaker then refused `30 unknown-cost-budget`
// with approvable:false for the rest of the UTC day. Stage 22's zero-dispatch
// announcement path already recorded `est_usd: 0` with a comment naming this
// exact failure mode; the fix makes the same truth STRUCTURAL on every
// zero-dispatch exit: zero provider dispatches ⇒ verified $0 (derived from
// the run's invocation list, not patched call-site-by-call-site), and a
// refusal agent-exec makes BEFORE the provider spawns reports the verified $0
// at its source. A run with ≥1 real dispatch keeps ADR-0008's semantics
// exactly: unknown stays unknown, never a fabricated $0 for a model run.
//
// Stub-driven like tests/worker.test.cjs (stateful gh stub + scripted
// claude/codex agent stubs, $HOME redirected). No network, no live API, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../verity/bin/lib/scanner.cjs');
const stage = require('../verity/bin/lib/stage.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;
const NEEDS_HUMAN = scanner.NEEDS_HUMAN_LABEL;

// --- stateful gh stub (PATH) — trimmed twin of tests/worker.test.cjs ---------
// One extra trigger over the shared shape: when the state file carries
// `failStateAll: true`, every `--state all` list query (the §3.4 snapshot
// fetch and nothing else — the scanner's pinned queries use `--state open`)
// fails like an API outage, which is how the canary's tick-11 `infra` stop
// (`state:unverified`) is produced without a network.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.CALLS_FILE) fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n');
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
if (args[0] === 'auth' && args[1] === 'status') { out('Logged in as verity-bot\\n'); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  const s = state();
  if (s.failStateAll && flag('--state') === 'all') {
    process.stderr.write('gh: API rate limit exceeded for user ID 4242. (HTTP 403)\\n');
    process.exit(1);
  }
  let items = args[0] === 'issue' ? s.issues : s.prs;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
const prByNumber = (n) => state().prs.find((p) => p.number === Number(n));
if (args[0] === 'pr' && args[1] === 'view') {
  const p = prByNumber(args[2]);
  out({ additions: p.additions || 0, deletions: p.deletions || 0,
        labels: (p.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  if (prByNumber(args[2]).checksPass) { out('all checks pass\\n'); process.exit(0); }
  process.stderr.write('some checks were not successful\\n');
  process.exit(1);
}
if (args[0] === 'repo' && args[1] === 'view') { out({ name: 'fixture' }); process.exit(0); }
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

// --- scripted CLAUDE agent stub (VERITY_AGENT_BIN) ----------------------------
// Reports a REAL cost (total_cost_usd) on every result — what the
// claude-unaffected assertions need. A queue step { raw } emits the raw text
// instead of a result object (the post-spawn malformed-output shape).
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
if (step.raw !== undefined) { process.stdout.write(step.raw); process.exit(0); }
if (step.floodStderr !== undefined) {
  // Prove the child RAN, then overflow the driver's 16MB piped-stderr cap —
  // spawnSync then reports ENOBUFS, an error the child can only cause by
  // executing (the stage-30 review's ADR-0008 boundary case). Synchronous
  // fd-2 writes: process.stderr.write is async on a pipe and process.exit
  // would drop the flood before the cap is ever reached.
  if (process.env.FLOOD_MARKER) fs.writeFileSync(process.env.FLOOD_MARKER, 'ran\\n');
  const chunk = 'x'.repeat(1024 * 1024);
  try {
    for (let i = 0; i < 17; i += 1) fs.writeSync(2, chunk);
  } catch {}
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 1.87,
  usage: { input_tokens: 400000, cache_creation_input_tokens: 10000,
           cache_read_input_tokens: 2034, output_tokens: 38112 },
}) + '\\n');
`;

// --- scripted CODEX stub (VERITY_CODEX_BIN) -----------------------------------
// Usage with NO cost — codex never reports dollars (ADR-0008). Argv log lets
// tests count how many model runs were actually dispatched.
const CODEX_AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli ${MIN_CODEX}\\n');
  process.exit(0);
}
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
const path = require('node:path');
const cwd = args[args.indexOf('--cd') + 1];
const logDir = path.dirname(args[args.indexOf('--output-last-message') + 1]);
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.verity-stub.json'), 'utf8'));
if (cfg.CODEX_ARGV_LOG) fs.appendFileSync(cfg.CODEX_ARGV_LOG, JSON.stringify(args) + '\\n');
fs.readFileSync(0, 'utf8'); // consume the stdin prompt
const queueFile = cfg.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
const lines = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: step.final } },
  { type: 'turn.completed', usage: { input_tokens: 400000, cached_input_tokens: 2034, output_tokens: 38112 } },
];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
`;

const POLICY_SUPERVISED = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');
// Codex worker policy at DEFAULT limits (max_usd_per_day 25.0,
// unknown_cost_behavior 'gate' from autonomy defaults): the canary's shape.
const POLICY_CODEX = [
  'mode: supervised',
  'agent:',
  '  provider: codex',
  '  acknowledged_enforcement_gaps: [network]',
  'notify:',
  '  mention: [seanerama]',
  '',
].join('\n');
// The canary tick-8/12 shape: codex with the acknowledgement ABSENT — every
// dispatch refuses `unenforceable-policy` BEFORE any provider spawn (stage 26).
const POLICY_CODEX_NOACK = [
  'mode: supervised',
  'agent:',
  '  provider: codex',
  'notify:',
  '  mention: [seanerama]',
  '',
].join('\n');

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-zero-dispatch-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  const codexAgent = path.join(dir, 'codex-agent-stub');
  fs.writeFileSync(codexAgent, CODEX_AGENT_STUB);
  fs.chmodSync(codexAgent, 0o755);
  const codexArgvLog = path.join(dir, 'codex-argv.jsonl');
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      issues: opts.issues || [],
      prs: opts.prs || [],
      ...(opts.failStateAll === true ? { failStateAll: true } : {}),
    }),
  );
  const queueFile = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(queueFile, JSON.stringify(opts.queue || []));
  const callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    path.join(dir, '.verity-stub.json'),
    JSON.stringify({
      CODEX_ARGV_LOG: codexArgvLog,
      AGENT_QUEUE: queueFile,
      GH_STATE_FILE: stateFile,
    }),
  );
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY_CODEX);
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  // The build role holds git_write, which under codex means VERITY performs
  // its git (ADR-0012) — a fixture whose codex build actually DISPATCHES
  // needs a real repository with a real origin (tests/worker.test.cjs shape).
  if (opts.git === true) {
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      [
        'home/',
        'origin.git/',
        'stub-bin/',
        'agent-stub',
        'codex-agent-stub',
        'gh-state.json',
        'agent-queue.json',
        'calls.jsonl',
        'codex-argv.jsonl',
        '',
      ].join('\n'),
    );
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'verity@example.test']);
    git(['config', 'user.name', 'Verity Test']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline']);
    execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'origin.git')], { stdio: 'pipe' });
    git(['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  }
  return { dir, home, bin, agent, codexAgent, codexArgvLog, stateFile, queueFile, callsFile };
}

function runWorker(fx, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    CALLS_FILE: fx.callsFile,
    AGENT_QUEUE: fx.queueFile,
    VERITY_AGENT_BIN: fx.agent,
    ...(extra.env || {}),
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

const codexEnv = (fx) => ({ VERITY_CODEX_BIN: fx.codexAgent });
const codexArgvs = (fx) =>
  fs.existsSync(fx.codexArgvLog)
    ? fs
        .readFileSync(fx.codexArgvLog, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];
const queueLeft = (fx) => JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length;
const ghState = (fx) => JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
const itemIn = (state, n) => state.issues.concat(state.prs).find((it) => it.number === n);
const labelsOf = (state, n) =>
  (itemIn(state, n).labels || []).map((l) => (typeof l === 'string' ? l : l.name));

// usage.csv data rows split into cells. Current 12-column layout:
// timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate
const usageCells = (fx) =>
  fs
    .readFileSync(path.join(fx.dir, '.verity', 'usage.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','));

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

// The canary's repository shape: one stage whose work-item issue the P3 tier
// can see, so the worker SELECTS an item and the zero-dispatch exit happens
// inside runLoop (a scan that finds nothing writes no ledger row at all).
function readyStageIssue(extra = {}) {
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
    statusCheckRollup: [],
    comments: [],
    ...extra,
  };
}

// Canary ticks 6/9: the stage is parked (stage 27's verity:needs-human on its
// PR), the work-item issue still carries verity:ready — the tick selects the
// issue, the dependency engine answers "parked; no other unblocked work", and
// the run ends success having dispatched NOTHING.
function parkedSuccessFixture(opts = {}) {
  return fixture({
    issues: [readyStageIssue()],
    prs: [noCiPr({ labels: [NEEDS_HUMAN] })],
    stages: [{ title: 'Core' }],
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// (1) REGRESSION — the canary shapes wedge the NEXT tick non-approvably
// ---------------------------------------------------------------------------

test('e2e REGRESSION N1 (ticks 6/9): a parked-success tick writes a VERIFIED $0 row and the next same-day tick is NOT refused', () => {
  const fx = parkedSuccessFixture();

  // Tick 1: parked-success — zero provider dispatches, run outcome success.
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `parked tick exits 0 (stderr: ${tick1.stderr})`);
  assert(/success/.test(tick1.out), `run outcome success, got: ${tick1.out}`);
  assert(/parked/.test(tick1.out), `the result names the park, got: ${tick1.out}`);
  assertEqual(codexArgvs(fx).length, 0, 'no model run was spent');
  const rows = usageCells(fx);

  // Tick 2, same UTC day: before the fix the startup breaker read tick 1's
  // row as UNGATED unknown spend and refused `30 unknown-cost-budget` with no
  // approvable suffix — nothing on GitHub to approve, wedged until rotation.
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assert(
    !tick2.stderr.includes('unknown-cost-budget'),
    `a dispatch-free day is not unverifiable spend, got: ${tick2.stderr}`,
  );
  assertEqual(tick2.code, 0, `tick 2 proceeds (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 0, 'still zero model runs');

  assertEqual(rows.length, 1, 'one run-level ledger row for tick 1');
  assertEqual(rows[0][8], 'success', 'row outcome success');
  assertEqual(
    rows[0][6],
    '0',
    'zero provider dispatches ⇒ VERIFIED est_usd 0 — never an unknown-cost cell (stage 30)',
  );
});

test('e2e REGRESSION N1 (tick 8): a pre-spawn dispatch refusal (infra_error) writes a VERIFIED $0 row and does not wedge the day', () => {
  const fx = fixture({
    issues: [readyStageIssue()],
    stages: [{ title: 'Core' }],
    policy: POLICY_CODEX_NOACK,
  });

  // Tick 1: the build dispatch refuses `unenforceable-policy` BEFORE any
  // provider spawn (stage 26) — the run ends infra with one invocation row.
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 30, `the refusal is an infra stop (stderr: ${tick1.stderr})`);
  assert(
    tick1.stderr.includes('verity-agent-exec: 30 unenforceable-policy:'),
    `agent-exec's own refusal fired, got: ${tick1.stderr}`,
  );
  assertEqual(codexArgvs(fx).length, 0, 'codex was never spawned');
  const rows = usageCells(fx);

  // Tick 2, same UTC day: before the fix this was `30 unknown-cost-budget`,
  // approvable:false — the canary's non-approvable wedge. Now the tick gets
  // as far as its own (still-refused) dispatch and reports THAT truthfully.
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assert(
    !tick2.stderr.includes('unknown-cost-budget'),
    `the refused day stays approachable — no budget wedge, got: ${tick2.stderr}`,
  );
  assertEqual(tick2.code, 30, 'the policy is still broken, so the same refusal repeats');
  assert(
    tick2.stderr.includes('unenforceable-policy'),
    `tick 2 names the real problem, got: ${tick2.stderr}`,
  );
  assertEqual(codexArgvs(fx).length, 0, 'no tick ever spawned codex');

  assertEqual(rows.length, 1, 'one per-invocation ledger row for tick 1');
  assertEqual(rows[0][8], 'infra_error', 'row outcome infra_error');
  assertEqual(rows[0][10], 'build', 'attributed to the refused role');
  assertEqual(
    rows[0][6],
    '0',
    'the provider never ran, so the cost is a VERIFIED $0 — never unknown (stage 30)',
  );
});

test('e2e REGRESSION N1 (tick 11): an unverified-state stop (infra) writes a VERIFIED $0 row and does not wedge the day', () => {
  const fx = fixture({
    issues: [readyStageIssue()],
    stages: [{ title: 'Core' }],
    policy: POLICY_SUPERVISED,
    failStateAll: true,
    queue: [{ final: 'unused' }], // an untouched queue proves no dispatch
  });

  // Tick 1: the item is selected, then the dependency engine cannot read
  // GitHub — the stage-20 fail-closed infra stop, zero dispatches.
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 30, `unverified state is an infra stop (stderr: ${tick1.stderr})`);
  assert(
    tick1.stderr.includes('verity-worker: 30 infra-error:'),
    `the §8.2 infra line, got: ${tick1.stderr}`,
  );
  assert(/unverified/i.test(tick1.stderr), 'the stop names the unreadable state');
  assertEqual(queueLeft(fx), 1, 'no model run was spent');
  const rows = usageCells(fx);

  // Tick 2, same UTC day: before the fix the startup breaker refused
  // `30 unknown-cost-budget` before even looking at GitHub. Now the tick
  // reaches the state read again and reports the real (still-broken) problem.
  const tick2 = runWorker(fx);
  assert(
    !tick2.stderr.includes('unknown-cost-budget'),
    `an infra day is not unverifiable spend, got: ${tick2.stderr}`,
  );
  assertEqual(tick2.code, 30, 'GitHub is still unreadable — the infra stop repeats');
  assert(/unverified/i.test(tick2.stderr), `tick 2 names the real problem, got: ${tick2.stderr}`);
  assertEqual(queueLeft(fx), 1, 'still no model run');

  assertEqual(rows.length, 1, 'one run-level ledger row for tick 1');
  assertEqual(rows[0][8], 'infra', 'row outcome infra');
  assertEqual(rows[0][6], '0', 'zero dispatches ⇒ VERIFIED $0 (stage 30)');
});

// ---------------------------------------------------------------------------
// (2) THE SYSTEMIC GUARD — sweep every zero-dispatch outcome the worker can
//     produce; no ledger row from any of them may carry an empty est_usd cell
// ---------------------------------------------------------------------------

// A prior §7 run summary whose roles line reads `roles: build` — two of these
// on the item trip the stage-19 no-progress strike BEFORE the next dispatch.
const priorBuildSummary = (runId) =>
  worker.formatRunSummary({
    runId,
    outcome: 'failed_once',
    roles: ['build'],
    result: 'r',
    tokens: { in: 0, out: 0 },
    est_usd: null,
    wall_secs: 1,
  });

// Every zero-dispatch exit the e2e harness can drive the worker through, by
// run outcome. limit_hit and failed_once are deliberately absent: failed_once
// only exists downstream of a DISPATCHED role's failure, and every per-run
// limit floor is ≥1 role / ≥1 minute, so neither can occur with zero
// dispatches in this harness. The structural rule covers them anyway — this
// sweep pins every shape that CAN be produced, so a future zero-dispatch exit
// path with an unknown-cost row fails here instead of wedging a canary.
const ZERO_DISPATCH_SHAPES = [
  {
    name: 'parked-success (stage 27, canary ticks 6/9)',
    build: () => ({ fx: parkedSuccessFixture(), env: {} }),
    exit: 0,
    queueSeed: 0,
    rowOutcomes: ['success'],
  },
  {
    name: 'gated before any dispatch (fresh ci:unverified inside runLoop)',
    build: () => ({
      fx: fixture({
        issues: [readyStageIssue()],
        prs: [noCiPr()],
        stages: [{ title: 'Core' }],
        policy: POLICY_SUPERVISED,
        queue: [{ final: 'unused' }],
      }),
      env: {},
    }),
    exit: 0,
    queueSeed: 1,
    rowOutcomes: ['gated'],
  },
  {
    name: 'gate announcement with no selectable item (stage 22 path)',
    build: () => ({
      fx: fixture({
        issues: [readyStageIssue({ labels: [] })],
        prs: [noCiPr()],
        stages: [{ title: 'Core' }],
        policy: POLICY_SUPERVISED,
        queue: [{ final: 'unused' }],
      }),
      env: {},
    }),
    exit: 0,
    queueSeed: 1,
    rowOutcomes: ['gated'],
  },
  {
    name: 'no-progress strike refusal (stage 19) — failed with zero dispatches',
    build: () => ({
      fx: fixture({
        issues: [
          readyStageIssue({
            comments: [
              { body: priorBuildSummary('run-old1') },
              { body: priorBuildSummary('run-old2') },
            ],
          }),
        ],
        stages: [{ title: 'Core' }],
        policy: POLICY_SUPERVISED,
        queue: [{ final: 'unused' }],
      }),
      env: {},
    }),
    exit: 20,
    queueSeed: 1,
    rowOutcomes: ['failed'],
  },
  {
    name: 'unverified GitHub state (stage 20, canary tick 11) — infra',
    build: () => ({
      fx: fixture({
        issues: [readyStageIssue()],
        stages: [{ title: 'Core' }],
        policy: POLICY_SUPERVISED,
        failStateAll: true,
        queue: [{ final: 'unused' }],
      }),
      env: {},
    }),
    exit: 30,
    queueSeed: 1,
    rowOutcomes: ['infra'],
  },
  {
    name: 'pre-spawn dispatch refusal (stage 26, canary tick 8) — infra_error',
    build: () => {
      const fx = fixture({
        issues: [readyStageIssue()],
        stages: [{ title: 'Core' }],
        policy: POLICY_CODEX_NOACK,
      });
      return { fx, env: codexEnv(fx) };
    },
    exit: 30,
    queueSeed: 0,
    rowOutcomes: ['infra_error'],
  },
];

test('SYSTEMIC GUARD (stage 30): no zero-dispatch outcome writes a ledger row with an empty est_usd cell', () => {
  const outcomesCovered = new Set();
  for (const shape of ZERO_DISPATCH_SHAPES) {
    const { fx, env } = shape.build();
    const { code, stderr } = runWorker(fx, { env });
    assertEqual(code, shape.exit, `${shape.name}: exit code (stderr: ${stderr})`);
    assertEqual(codexArgvs(fx).length, 0, `${shape.name}: zero provider dispatches (codex)`);
    assertEqual(
      queueLeft(fx),
      shape.queueSeed,
      `${shape.name}: zero provider dispatches (claude queue untouched)`,
    );
    const rows = usageCells(fx);
    assert(rows.length >= 1, `${shape.name}: the run wrote its ledger row(s)`);
    assertEqual(
      rows.map((r) => r[8]).join('|'),
      shape.rowOutcomes.join('|'),
      `${shape.name}: row outcome(s)`,
    );
    for (const row of rows) {
      assert(
        row[6] !== '' && Number.isFinite(Number(row[6])),
        `${shape.name}: est_usd must be a VERIFIED number, got '${row[6]}' on outcome '${row[8]}' — an empty cell here is the canary-run-5 day wedge`,
      );
      outcomesCovered.add(row[8]);
    }
  }
  // The sweep's honesty: it covered every run outcome a zero-dispatch run can
  // reach. If a future stage adds a NEW outcome to the worker, this fails and
  // the new exit path must be swept (or shown to require a dispatch) — the
  // suite breaks instead of a canary wedging.
  assertEqual(
    JSON.stringify([...outcomesCovered].sort()),
    JSON.stringify(['failed', 'gated', 'infra', 'infra_error', 'success']),
    'every producible zero-dispatch outcome was swept',
  );
  assertEqual(
    JSON.stringify(Object.keys(worker.EXIT_CODES).sort()),
    JSON.stringify(['failed', 'failed_once', 'gated', 'infra', 'limit_hit', 'success']),
    'the worker grew a new run outcome — add it to this sweep (or prove it requires a dispatch) before shipping it',
  );
});

// ---------------------------------------------------------------------------
// (3) THE ADR-0008 BOUNDARY — a run that DID dispatch keeps unknown unknown
// ---------------------------------------------------------------------------

test('e2e: a run WITH a codex dispatch still writes an EMPTY est_usd cell — unknown is never $0 (stage 18 invariant)', () => {
  const fx = fixture({
    git: true,
    issues: [readyStageIssue()],
    stages: [{ title: 'Core' }],
    policy: POLICY_CODEX,
    queue: [{ final: marker('success') }],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  // The build succeeds with unknown codex cost → parks at the unknown-cost
  // gate (ADR-0008 default) — a pause, exit 0, after one REAL dispatch.
  assertEqual(code, 0, `the gated run exits 0 (stderr: ${stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'exactly one real codex dispatch');
  const rows = usageCells(fx);
  assertEqual(rows.length, 1, 'one per-invocation row');
  assertEqual(rows[0][10], 'build', 'attributed to the dispatched role');
  assertEqual(
    rows[0][6],
    '',
    'a MODEL run with no reported cost stays unknown — never a fabricated $0',
  );
  assertEqual(rows[0][11], worker.UNKNOWN_COST_GATE, 'and it is gate-stamped (stage 21)');
  assert(
    labelsOf(ghState(fx), 41).includes('verity:awaiting-approval'),
    'the unknown-cost gate parked visibly',
  );
});

test('e2e: claude (real costs) unaffected — a run that dispatches then idles keeps its real dollar figure', () => {
  const fx = fixture({
    issues: [
      readyStageIssue({ labels: [NEEDS_HUMAN] }),
      {
        number: 30,
        title: 'Add widgets',
        state: 'OPEN',
        labels: ['verity:request'],
        author: { login: 'human' },
        createdAt: '2026-06-01T00:00:00Z',
        assignees: [],
        comments: [],
      },
    ],
    prs: [noCiPr()],
    stages: [{ title: 'Core' }],
    policy: POLICY_SUPERVISED,
    queue: [{ final: marker('success') }],
  });
  // The request's plan role runs ($1.87), then the parked stage idles the run
  // out — a MIXED run: one dispatch, then a zero-dispatch exit reason.
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `the run succeeds (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'the plan role really dispatched');
  const rows = usageCells(fx);
  assertEqual(rows.length, 1, 'one per-invocation row');
  assertEqual(rows[0][10], 'plan', 'attributed to the plan role');
  assertEqual(
    rows[0][6],
    '1.87',
    'the real claude cost is on the row — the structural rule never touches it',
  );
  assertEqual(rows[0][8], 'success', 'row outcome success');
});

// ---------------------------------------------------------------------------
// (4) agent-exec source-of-truth: pre-spawn refusals are a VERIFIED $0;
//     post-spawn infra stays unknown (the model ran and spent)
// ---------------------------------------------------------------------------

function runAgentExec(fx, args, env = {}) {
  const full = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    AGENT_QUEUE: fx.queueFile,
    VERITY_AGENT_BIN: fx.agent,
    ...env,
  };
  try {
    const out = execFileSync('node', [CLI, 'agent-exec', ...args], {
      cwd: fx.dir,
      encoding: 'utf8',
      env: full,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: err.stdout || '' };
  }
}

test('agent-exec: a refusal BEFORE the provider spawns reports est_usd 0 — a verified zero, never unknown', () => {
  const fx = fixture({ stages: [{ title: 'Core' }] });
  const res = runAgentExec(fx, ['no-such-role', '--run-id', 'zd-pre']);
  assertEqual(res.code, 30, 'unknown-role refusal exits 30');
  const obj = JSON.parse(res.out);
  assertEqual(obj.outcome, 'infra_error');
  assertEqual(obj.est_usd, 0, 'nothing spawned, so the cost is a VERIFIED $0 (stage 30)');
});

test('agent-exec: malformed output AFTER the model ran keeps est_usd null — real spend is never rewritten to $0 (ADR-0008)', () => {
  const fx = fixture({
    stages: [{ title: 'Core' }],
    queue: [{ raw: 'plain prose\nstill not json\n' }],
  });
  const res = runAgentExec(fx, ['review', '114', '--run-id', 'zd-post']);
  assertEqual(res.code, 30, 'malformed output exits 30');
  const obj = JSON.parse(res.out);
  assertEqual(obj.outcome, 'infra_error');
  assertEqual(
    obj.est_usd,
    null,
    'the model RAN and its spend is unknown — the stage-30 zero applies only before the spawn',
  );
});

test('agent-exec: an ENOBUFS overflow keeps est_usd null — spawnSync errors are not all pre-execution, and the predicate must fail toward UNKNOWN', () => {
  // spawnSync sets run.error for more than failures to start the child:
  // ENOBUFS means the child ran long enough to overflow the driver's 16MB
  // piped-stderr cap — after potentially real provider spend. A predicate
  // that reads "any non-timeout run.error" as "never executed" fabricates a
  // verified $0 for a model run that executed (the ADR-0008 violation) AND
  // slips it past the unknown-cost gate, undercounting the daily breaker.
  const fx = fixture({
    stages: [{ title: 'Core' }],
    queue: [{ floodStderr: true }],
  });
  const floodMarker = path.join(fx.dir, 'flood.marker');
  const res = runAgentExec(fx, ['review', '114', '--run-id', 'zd-enobufs'], {
    FLOOD_MARKER: floodMarker,
  });
  assertEqual(res.code, 30, 'the overflowed run is an infra stop');
  assert(fs.existsSync(floodMarker), 'the child provably RAN (marker written) before the overflow');
  const obj = JSON.parse(res.out);
  assertEqual(obj.outcome, 'infra_error');
  assertEqual(
    obj.est_usd,
    null,
    'ENOBUFS happens AFTER the model executed — its cost is UNKNOWN, never a fabricated $0 (ADR-0008)',
  );
});
