// Stage 31 (ADR-0014) — the unknown-cost gate must be resumable: an approval
// consumes the PARKED result, never a fresh dispatch.
//
// The defect (canary run 5, defect N2): under codex est_usd is always null, so
// every successful role parks at `unknown-cost` before the trust ladder
// (correct, ADR-0008) — but approving the gate RE-DISPATCHED the same role at
// full price. Review ran 3× on one PR (138k+144k+154k input tokens), posted
// duplicate findings comments, and flipped its verdict between re-runs: the
// human approved result A and the ladder received result B.
//
// The fix (ADR-0014): the success-path unknown-cost pause records a durable
// pointer to the parked result — an additive `parked:` line on the gate
// comment naming the run id, role, PR, and the PR's head SHA at park time (the
// staleness anchor). Consuming `verity:approved` for that item RESUMES from
// the persisted T05 result under ~/.verity/logs/<run-id>/: trust ladder,
// summary, ledger — zero provider spawns, zero new tokens, VERIFIED zero new
// cost, and no re-posted effects (the findings comment already landed when the
// result parked). Staleness and a missing/unreadable parked file fail CLOSED
// into a loudly-announced fresh dispatch — an approval is never a no-op.
// Stage 25's FAILED-run parks are untouched: a failed park's gate comment
// carries no pointer, and its approval still means "let the day proceed".
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
// Extended for this stage: `pr view` serves headRefOid (the staleness anchor
// the parked pointer records and the resume re-checks) plus the T13 trust
// surface (diff/merge) so a resumed approve verdict can reach a real merge.
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
if (args[0] === 'pr' && args[1] === 'diff') {
  out((prByNumber(args[2]).files || []).join('\\n') + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const p = prByNumber(args[2]);
  out({ additions: p.additions || 0, deletions: p.deletions || 0,
        headRefOid: p.headRefOid || null,
        labels: (p.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  if (prByNumber(args[2]).checksPass) { out('all checks pass\\n'); process.exit(0); }
  process.stderr.write('some checks were not successful\\n');
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const s = state();
  s.prs.find((p) => p.number === Number(args[2])).state = 'MERGED';
  save(s);
  process.exit(0);
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
// Reports a REAL cost (total_cost_usd) on every result — the claude-unaffected
// test proves a run whose cost is known never parks and never records a pointer.
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
// tests count how many model runs were actually dispatched — the number this
// whole stage exists to hold at one.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-parked-resume-'));
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
const mergeCalls = (fx) =>
  fs
    .readFileSync(fx.callsFile, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l))
    .filter((c) => c[0] === 'pr' && c[1] === 'merge');

// usage.csv data rows split into cells. Current 12-column layout:
// timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate
const usageCells = (fx) =>
  fs
    .readFileSync(path.join(fx.dir, '.verity', 'usage.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','));

// The operator does exactly what the gate comment says: applies the label.
function approve(fx, number) {
  const s = ghState(fx);
  const it = s.issues.concat(s.prs).find((i) => i.number === number);
  it.labels = (it.labels || []).concat(['verity:approved']);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

function setHead(fx, number, sha) {
  const s = ghState(fx);
  s.prs.find((p) => p.number === number).headRefOid = sha;
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

const FINDINGS = '### Review findings\n- contracts intact\n- tests are real';
const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

// The canary tick shape: a stage in review whose PR carries
// verity:awaiting-review (P2 selects it), CI green, head SHA known.
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
  headRefOid: HEAD_SHA,
  labels: ['verity:awaiting-review'],
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  files: ['docs/guide.md', 'README.md'],
  additions: 10,
  deletions: 5,
  checksPass: true,
  comments: [],
};

// A successful codex review that declares findings + an approve verdict — the
// exact result canary run 5 parked (and then re-bought, twice).
const APPROVE_STEP = {
  final: marker('success', {
    artifacts: { pr: 114, verdict: 'approve', effects: { findings_comment: FINDINGS } },
  }),
};
// The verdict-lottery step: what a RE-dispatch would return. Any test that
// proves zero re-dispatch seeds it and asserts it was never consumed.
const FLIPPED_STEP = {
  final: marker('success', {
    artifacts: { pr: 114, verdict: 'request_changes', effects: { findings_comment: FINDINGS } },
  }),
};

function reviewFixture(opts = {}) {
  return fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    queue: opts.queue || [APPROVE_STEP, FLIPPED_STEP],
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
}

const findingsComments = (state, n) => comments(state, n).filter((b) => b.startsWith('🔎'));
const gateComments = (state, n) => comments(state, n).filter((b) => b.startsWith('⏸️'));
const summariesOf = (state, n) => comments(state, n).filter((b) => b.startsWith('🤖'));
const parkedRunId = (gate) => (gate.match(/result of run `(run-[^`]+)`/) || [])[1];

// ---------------------------------------------------------------------------
// (1) THE REGRESSION: approve a parked review → the verdict reaches the trust
// ladder with ZERO provider dispatches and no duplicate findings comment.
// ---------------------------------------------------------------------------

test('e2e REGRESSION ADR-0014: approving the unknown-cost gate resumes the PARKED review — zero new dispatches, no duplicate findings, the APPROVED verdict reaches the ladder', () => {
  const fx = reviewFixture();

  // Tick 1: the review succeeds, findings land, the run parks at unknown-cost
  // with a durable pointer to the parked result on the gate comment.
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates, exit 0 (stderr: ${tick1.stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'tick 1 paid for exactly one review run');
  let state = ghState(fx);
  assert(labelsOf(state, 114).includes('verity:awaiting-approval'), 'tick 1 parked the gate');
  assertEqual(findingsComments(state, 114).length, 1, 'tick 1 posted the findings once');
  const gate = gateComments(state, 114)[0];
  assert(
    gate.includes(`paused at human gate \`${worker.UNKNOWN_COST_GATE}\``),
    'unknown-cost gate',
  );
  assert(
    /^parked: role `review` result of run `run-[^`]+` at PR #114 head [0-9a-f]{40}/m.test(gate),
    `the gate comment records the parked-result pointer (run id + role + head SHA), got: ${gate}`,
  );
  assert(gate.includes('ADR-0014'), 'the pointer names the decision that authorizes the resume');

  // The operator reads the findings and does exactly what the comment says.
  approve(fx, 114);

  // Tick 2: before the fix this RE-DISPATCHED review at full price (the argv
  // log grew to 2), posted a second findings comment, and the ladder received
  // the flipped request_changes verdict — not the one the human approved.
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 resumes, exit 0 (stderr: ${tick2.stderr})`);
  assertEqual(
    codexArgvs(fx).length,
    1,
    'ZERO new provider dispatches — the parked result was consumed',
  );
  state = ghState(fx);
  assertEqual(findingsComments(state, 114).length, 1, 'no duplicate findings comment');

  // The APPROVED verdict reached the trust ladder: at default trust 0 the
  // deterministic decision is the review:merge gate, never a merge and never
  // the flipped verdict a re-run would have produced.
  assertEqual(mergeCalls(fx).length, 0, 'trust 0 never merges');
  const summaries = summariesOf(state, 114);
  assertEqual(summaries.length, 2, 'each tick posted its §7 summary');
  assert(
    summaries[1].includes('gated at review:merge'),
    `the approved verdict reached the ladder, got: ${summaries[1]}`,
  );
  assert(
    summaries[1].includes('roles: review (resumed)'),
    'the summary says the role was resumed, not dispatched',
  );
  assert(
    summaries[1].includes('resumed:') && summaries[1].includes(parkedRunId(gate)),
    `the resume is recorded and attributes the parked run, got: ${summaries[1]}`,
  );
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the single-use token was consumed');

  // Resumed-run ledger rows: VERIFIED zero new cost and zero new tokens —
  // never an unknown/empty est_usd cell, never the parked run's tokens again.
  const rows = usageCells(fx);
  assertEqual(rows.length, 2, 'one row per tick');
  assertEqual(rows[0][6], '', "tick 1's cost stays unknown (empty cell — ADR-0008)");
  assertEqual(rows[1][4], '0', 'resumed run: zero tokens in');
  assertEqual(rows[1][5], '0', 'resumed run: zero tokens out');
  assertEqual(rows[1][6], '0', 'resumed run: VERIFIED zero new cost, never an unknown cell');

  // Tick 3, no fresh approval: the day still holds tick 1's gated unknown-cost
  // rows, so the startup breaker refuses — stage 21's single-use semantics.
  const tick3 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick3.code, 30, 'tick 3 refuses without a fresh approval');
  assertErrorLine(tick3.stderr, 30, 'unknown-cost-budget');
  assertEqual(codexArgvs(fx).length, 1, 'tick 3 spent no model run');
});

test('e2e ADR-0014: at trust 1 a resumed approve verdict MERGES the PR — the resume re-enters the full trust ladder, zero new dispatches', () => {
  const fx = reviewFixture({
    policy: `${POLICY_CODEX}review:\n  trust: 1\n`,
  });
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 resumes and merges (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'zero new dispatches');
  assertEqual(
    JSON.stringify(mergeCalls(fx).map((c) => c.slice(0, 3))),
    JSON.stringify([['pr', 'merge', '114']]),
    'the resumed low-risk approve verdict merged deterministically',
  );
  assertEqual(itemIn(ghState(fx), 114).state, 'MERGED', 'the PR is merged');
});

// ---------------------------------------------------------------------------
// (2) Staleness fail-closed: the PR head moved between park and approval.
// ---------------------------------------------------------------------------

test('e2e ADR-0014: PR head moves between park and approval → the resume REFUSES loudly and a fresh dispatch is announced as a repurchase', () => {
  const fx = reviewFixture();
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);

  // The branch moves — the parked verdict examined a head that no longer exists.
  setHead(fx, 114, 'ffffffffffffffffffffffffffffffffffffffff');
  approve(fx, 114);

  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 re-dispatches (stderr: ${tick2.stderr})`);
  assertEqual(
    codexArgvs(fx).length,
    2,
    'a FRESH dispatch ran — the stale result was never consumed',
  );
  const state = ghState(fx);
  const summaries = summariesOf(state, 114);
  assert(
    summaries[1].includes('repurchase:') && summaries[1].includes('head moved'),
    `the fresh dispatch is announced as a repurchase with the reason, got: ${summaries[1]}`,
  );
  assert(!summaries[1].includes('roles: review (resumed)'), 'nothing claims a resume happened');
});

// ---------------------------------------------------------------------------
// (3) Missing/unreadable parked result: loud fallback, never a no-op.
// ---------------------------------------------------------------------------

test('e2e ADR-0014: parked result deleted from ~/.verity/logs → loud fallback dispatch, the approval is never a no-op', () => {
  const fx = reviewFixture();
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);

  // Log rotation ate the parked run (the ADR names this exact hazard).
  fs.rmSync(path.join(fx.home, '.verity', 'logs'), { recursive: true, force: true });
  approve(fx, 114);

  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 re-dispatches (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 2, 'the approval still bought a run — a fresh one');
  const summaries = summariesOf(ghState(fx), 114);
  assert(
    summaries[1].includes('repurchase:') && summaries[1].includes('missing'),
    `the fallback is announced with its reason, got: ${summaries[1]}`,
  );
});

// ---------------------------------------------------------------------------
// (4) Stage 25 boundary: a FAILED run's park is NOT resumable — its approval
// still means "let the day proceed", exactly as stage 25 built it.
// ---------------------------------------------------------------------------

test('e2e ADR-0014 × stage 25: a FAILED park carries no pointer; its approval re-dispatches (the retry), never replays the failure', () => {
  const fx = reviewFixture({
    queue: [{ final: marker('failed', { reason: 'review found blocking defects' }) }, APPROVE_STEP],
  });
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 20, `tick 1 fails, exit 20 (stderr: ${tick1.stderr})`);
  const gate = gateComments(ghState(fx), 114)[0];
  assert(gate !== undefined, 'the stage-25 gate park is still posted');
  assert(!gate.includes('parked:'), 'a failed park records NO resumable pointer');

  approve(fx, 114);
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 proceeds — stage 25 semantics (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 2, 'the retry DISPATCHED — a failure is never resumed');
  const summaries = summariesOf(ghState(fx), 114);
  assert(!summaries[1].includes('resumed:'), 'nothing claims a resume');
  assert(
    !summaries[1].includes('repurchase:'),
    'and no repurchase is announced — no pointer existed',
  );
});

// ---------------------------------------------------------------------------
// (5) The neighbors stay exactly what they were.
// ---------------------------------------------------------------------------

test('e2e ADR-0014: allow_with_token_limit unchanged — no park, no pointer, the ladder runs the same tick', () => {
  const fx = reviewFixture({
    policy: `${POLICY_CODEX}limits:\n  max_usd_per_day: 25.0\n  unknown_cost_behavior: allow_with_token_limit\n`,
    queue: [APPROVE_STEP],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0, `run completes (stderr: ${stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'one dispatch');
  const state = ghState(fx);
  const gates = gateComments(state, 114);
  assertEqual(gates.length, 1, 'only the review:merge gate — no unknown-cost park');
  assert(gates[0].includes('review:merge'), 'the ordinary trust-0 merge gate');
  assert(
    comments(state, 114).every((b) => !b.includes('parked:')),
    'no pointer is ever recorded outside the unknown-cost park',
  );
});

test('e2e ADR-0014: claude (real costs) unaffected — never parks at unknown-cost, never records a pointer, approval semantics unchanged', () => {
  const fx = fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_usd_per_day: 25.0\n`,
    queue: [
      { final: marker('success', { artifacts: { pr: 114, verdict: 'approve' } }) },
      { final: marker('success', { artifacts: { pr: 114, verdict: 'approve' } }) },
    ],
  });
  const tick1 = runWorker(fx); // no codex env: the claude stub reports $1.87
  assertEqual(tick1.code, 0, `claude review gates at review:merge (stderr: ${tick1.stderr})`);
  let state = ghState(fx);
  const gates = gateComments(state, 114);
  assertEqual(gates.length, 1, 'only the review:merge gate — cost is KNOWN, no unknown-cost park');
  assert(
    comments(state, 114).every((b) => !b.includes('parked:')),
    'no pointer on a claude run',
  );

  // Approving the review:merge gate keeps its pre-stage-31 meaning: the next
  // tick DISPATCHES (whatever stage 19 built), never a resume.
  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 proceeds (stderr: ${tick2.stderr})`);
  state = ghState(fx);
  const summaries = summariesOf(state, 114);
  assert(!summaries[1].includes('resumed:'), 'no resume on the claude path');
  assert(!summaries[1].includes('repurchase:'), 'no repurchase announcement either');
  assertEqual(
    JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length,
    0,
    'tick 2 dispatched as before',
  );
});
