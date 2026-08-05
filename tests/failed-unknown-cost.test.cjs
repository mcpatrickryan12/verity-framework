// Stage 25 (#71) — a failed unknown-cost run must not wedge the day breaker
// non-approvably or invisibly (canary §4 re-run, defect 2, tick 5).
//
// The defect: stage 21 made the startup breaker's `unknown-cost-budget`
// refusal approvable only when EVERY unverifiable run ended parked at the
// unknown-cost gate — and the gate only fired on role SUCCESS (runLoop's
// failure path returned before the ADR-0008 unknown-cost block). A FAILED
// codex run therefore wrote an UNGATED unknown-cost ledger row, and the next
// tick refused `30 unknown-cost-budget` with approvable:false for the rest of
// the UTC day, on stderr alone: nothing on GitHub to see, nothing to approve.
//
// The fix gives the failure path the same two properties stages 21/22 gave
// the success path, through the SAME machinery (no third mechanism): the
// failed run parks the unknown-cost FACT at the existing unknown-cost gate
// (GATE_PAUSE label + comment on the failed run's item — visible), and its
// usage rows carry the gate stamp (so stage 21's approvable path covers it —
// one single-use `verity:approved`, consumed and recorded exactly as before).
// The run's OUTCOME stays failed/failed_once: the 2-strike rule, exit codes,
// and unlock comments are untouched.
//
// Stub-driven like tests/worker.test.cjs (its stateful gh stub + scripted
// claude/codex agent stubs, $HOME redirected). No network, no live API, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// --- stateful gh stub (PATH) — trimmed twin of tests/worker.test.cjs ---------
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
// Reports a REAL cost (total_cost_usd) on every result, failed ones included —
// exactly what the claude-unaffected test needs to prove.
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
fs.writeFileSync(path.join(logDir, 'liveness.marker'), 'ran\\n');
const lines = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: step.final } },
  { type: 'turn.completed', usage: { input_tokens: 400000, cached_input_tokens: 2034, output_tokens: 38112 } },
];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
`;

const POLICY_SUPERVISED = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');
// Codex worker policy — DEFAULT limits (max_usd_per_day 25.0,
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

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-failed-unknown-'));
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
  fs.writeFileSync(stateFile, JSON.stringify({ issues: opts.issues || [], prs: opts.prs || [] }));
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
const ghState = (fx) => JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
const itemIn = (state, n) => state.issues.concat(state.prs).find((it) => it.number === n);
const comments = (state, n) => (itemIn(state, n).comments || []).map((c) => c.body);
const labelsOf = (state, n) =>
  (itemIn(state, n).labels || []).map((l) => (typeof l === 'string' ? l : l.name));

// usage.csv data rows split into cells. Current 12-column layout:
// timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate
const USAGE_HEADER =
  'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate';
const usageCells = (fx) =>
  fs
    .readFileSync(path.join(fx.dir, '.verity', 'usage.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','));

function seedUsageCsv(fx, rows) {
  fs.writeFileSync(
    path.join(fx.dir, '.verity', 'usage.csv'),
    `${[USAGE_HEADER, ...rows].join('\n')}\n`,
  );
}

// The operator does exactly what the gate comment says: applies the label.
function approve(fx, number) {
  const s = ghState(fx);
  const it = s.issues.concat(s.prs).find((i) => i.number === number);
  it.labels = (it.labels || []).concat(['verity:approved']);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

function assertErrorLine(stderr, code, slug) {
  const lines = stderr.split('\n').filter((l) => l !== '');
  assertEqual(lines.length, 1, `exactly one stderr line, got:\n${stderr}`);
  assert(
    new RegExp(`^verity-worker: ${code} ${slug}: .+$`).test(lines[0]),
    `stderr matches §8.2 'verity-worker: <code> <slug>: <message>', got: ${lines[0]}`,
  );
}

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

// The canary tick-4 shape: a stage in review, whose review role FAILS. The
// stage's PR carries verity:awaiting-review (P2 selects it), CI is green.
const STAGE_ISSUE = {
  number: 41,
  title: '[stage 1] Core',
  state: 'OPEN',
  labels: [],
  author: { login: 'human' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
};

const REVIEW_PR = {
  number: 114,
  title: '[stage 1] Core',
  state: 'OPEN',
  headRefName: 'feat/stage-1-core',
  labels: ['verity:awaiting-review'],
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  comments: [],
};

function failedReviewFixture(opts = {}) {
  return fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    queue: [
      { final: marker('failed', { reason: 'review found blocking defects' }) },
      ...(opts.queue || []),
    ],
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
}

// ---------------------------------------------------------------------------
// (1) Visibility: the failed run parks the unknown-cost fact ON GITHUB
// ---------------------------------------------------------------------------

test('e2e REGRESSION #71: a FAILED codex run parks the unknown-cost fact VISIBLY — gate label + comment on its item, never stderr-only', () => {
  const fx = failedReviewFixture();
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 20, `the failure is still a failure — exit 20 (stderr: ${stderr})`);
  assert(stderr.includes('verity-worker: 20 role-failed-once:'), 'failed_once slug unchanged');

  const state = ghState(fx);
  // The gate machinery stage 22 proved out — label + comment — on the failed
  // run's own item (the PR the review ran against), no parallel channel.
  assert(
    labelsOf(state, 114).includes('verity:awaiting-approval'),
    `gate label lands on the failed run's PR (labels: ${labelsOf(state, 114)})`,
  );
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate !== undefined, 'a GATE_PAUSE comment was posted — the canary saw silence');
  assert(
    gate.includes(`paused at human gate \`${worker.UNKNOWN_COST_GATE}\``),
    `names the unknown-cost gate, got: ${gate}`,
  );
  assert(gate.includes('est_usd null'), 'explains WHY (cost unknown)');
  assert(gate.includes('FAILED'), 'says the role failed, not that it succeeded');
  assert(gate.includes(worker.APPROVAL_ACTION), 'says exactly how to approve');
  assert(gate.includes('@seanerama'), 'mentions notify.mention');

  // The run outcome is untouched: failed_once badge, unlock strike comment.
  const summary = comments(state, 114).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ⚠️ failed_once'), `outcome stays failed_once, got: ${summary}`);
  assert(
    comments(state, 114).some((b) => /^unlock:run-\S+ outcome:failed_once$/.test(b)),
    'the unlock comment still feeds the 2-strike counter',
  );

  // The ledger stamp — stage 21's mechanism, now covering the failure path:
  // unknown cost stays an EMPTY cell (never 0), and the gate cell says a
  // human was asked, so the next tick's refusal is approvable.
  const rows = usageCells(fx);
  assertEqual(rows.length, 1, 'one usage row for the failed invocation');
  assertEqual(rows[0][8], 'failed', 'the row keeps its failed outcome');
  assertEqual(rows[0][6], '', 'unknown cost is an empty cell — never 0 (ADR-0008)');
  assertEqual(
    rows[0][11],
    worker.UNKNOWN_COST_GATE,
    'the failed run’s row carries the unknown-cost gate stamp',
  );
});

// ---------------------------------------------------------------------------
// (2) Consent: approve → the NEXT tick proceeds; single-use; recorded
// ---------------------------------------------------------------------------

test('e2e REGRESSION #71: failed unknown-cost run, then the operator’s approval → the NEXT tick proceeds under the DEFAULT policy', () => {
  const fx = failedReviewFixture({
    queue: [{ final: marker('success', { artifacts: { pr: 114, verdict: 'approve' } }) }],
  });

  // Tick 1: the review fails with unknown cost; the gate is parked (test 1).
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 20, `tick 1 fails, exit 20 (stderr: ${tick1.stderr})`);
  assert(labelsOf(ghState(fx), 114).includes('verity:awaiting-approval'), 'tick 1 parked the gate');

  // The operator answers the gate comment exactly as it instructs.
  approve(fx, 114);

  // Tick 2: before the fix this refused at startup — exit 30
  // unknown-cost-budget, approvable:false, nothing to approve — and the day
  // was wedged until ledger rotation. Now the approval is exactly stage 21's:
  // one single-use `verity:approved`, one run.
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 proceeds on the approval (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 2, 'tick 2 actually dispatched a model run');

  const state = ghState(fx);
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the single-use token was consumed');
  // Consent is RECORDED, not implied — stage 21's `budget:` line pattern.
  const summaries = comments(state, 114).filter((b) => b.startsWith('🤖'));
  assertEqual(summaries.length, 2, 'each tick posted its §7 summary');
  assert(
    summaries[1].includes('budget:') && summaries[1].includes('verity:approved'),
    `tick 2 summary records the consumed budget approval, got: ${summaries[1]}`,
  );
  assert(
    summaries[1].includes('this run only'),
    'the summary states the single-run scope of the consumed approval',
  );

  // Tick 3, no fresh approval: the breaker still refuses — single-use, never
  // a standing waiver. (Tick 2's own unverifiable run re-gated, so the day
  // still contains unknown-cost runs — all of them gate-parked.)
  const tick3 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick3.code, 30, 'tick 3 refuses without a fresh approval');
  assertErrorLine(tick3.stderr, 30, 'unknown-cost-budget');
  assertEqual(codexArgvs(fx).length, 2, 'tick 3 spent no model run');
});

// ---------------------------------------------------------------------------
// (3) Fail-closed: no consent → the refusal stands
// ---------------------------------------------------------------------------

test('e2e: an UNCONSENTED failed-unknown-cost day still refuses — fail-closed stands', () => {
  const fx = failedReviewFixture();
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 20, `tick 1 fails (stderr: ${tick1.stderr})`);

  // Nobody approves anything.
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 30, 'tick 2 refuses: the budget is still unverifiable');
  assertErrorLine(tick2.stderr, 30, 'unknown-cost-budget');
  assertEqual(codexArgvs(fx).length, 1, 'no further model run was spent');
});

test("e2e: unknown_cost_behavior 'fail' keeps stage 21 parity — no gate pause, no approval mechanism", () => {
  const fx = failedReviewFixture({
    policy: `${POLICY_CODEX}limits:\n  max_usd_per_day: 25.0\n  unknown_cost_behavior: fail\n`,
  });
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 20, `tick 1 fails (stderr: ${tick1.stderr})`);
  const state = ghState(fx);
  assert(
    !labelsOf(state, 114).includes('verity:awaiting-approval'),
    "'fail' never parks a gate — it has no approval mechanism (stage 21)",
  );
  assert(
    comments(state, 114).every((b) => !b.startsWith('⏸️')),
    'no gate comment either',
  );
  assertEqual(usageCells(fx)[0][11], '', 'no gate stamp on the ledger row');

  // Even an approval cannot buy past 'fail': the refusal is not approvable.
  approve(fx, 114);
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 30, "'fail' refuses regardless of labels");
  assertErrorLine(tick2.stderr, 30, 'unknown-cost-budget');
});

// ---------------------------------------------------------------------------
// (4) The neighbors stay exactly what they were
// ---------------------------------------------------------------------------

test('e2e: a VERIFIED overspend still reports daily-limit — a gate-stamped failed run never masks real spend', () => {
  const fx = failedReviewFixture();
  approve(fx, 114); // an approval is present and must not matter
  // Today already holds a verified overspend AND a gate-parked failed
  // unknown-cost run: the known-spend trip is checked FIRST (stage 18).
  seedUsageCsv(fx, [
    `${new Date().toISOString()},run-a,octo/fixture,build,193745,2436,30.00,93,success,7,build,`,
    `${new Date().toISOString()},run-b,octo/fixture,review,400000,38112,,60,failed,0,review,${worker.UNKNOWN_COST_GATE}`,
  ]);
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 30, 'verified overspend refuses the start, approval or not');
  assertErrorLine(stderr, 30, 'daily-limit');
  assert(!fs.existsSync(fx.callsFile), 'still refused BEFORE any gh call');
});

test('e2e: claude (real costs) unaffected — a failed claude run gates nothing and stamps nothing', () => {
  const fx = fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_usd_per_day: 25.0\n`,
    queue: [
      { final: marker('failed', { reason: 'review found blocking defects' }) },
      { final: marker('success', { artifacts: { pr: 114, verdict: 'approve' } }) },
    ],
  });
  const tick1 = runWorker(fx); // no codex env: the claude stub reports $1.87
  assertEqual(tick1.code, 20, `claude failure exits 20 as always (stderr: ${tick1.stderr})`);
  const state = ghState(fx);
  assert(
    !labelsOf(state, 114).includes('verity:awaiting-approval'),
    'no gate label on a run whose cost is KNOWN',
  );
  assert(
    comments(state, 114).every((b) => !b.startsWith('⏸️')),
    'no gate comment',
  );
  const rows = usageCells(fx);
  assertEqual(rows[0][6], '1.87', 'the real cost is on the row');
  assertEqual(rows[0][11], '', 'no gate stamp — nothing to approve');

  // And the next tick starts normally: the budget is fully verified, so the
  // retry dispatches and ends at the ordinary trust-0 review:merge gate.
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 proceeds on a verified ledger (stderr: ${tick2.stderr})`);
  assert(
    !tick2.stderr.includes('unknown-cost-budget'),
    `no unverifiable-budget refusal on a claude ledger (stderr: ${tick2.stderr})`,
  );
});
