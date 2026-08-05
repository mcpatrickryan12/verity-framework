// Stage 33 (canary run 5, defect N4) — a DEFERRED daily unknown-cost refusal
// must not hang on the search index: the P1 pick needs a non-search fallback.
//
// The scanner's P1 tier finds approved items with a label-FILTERED list query
// (`gh issue|pr list --label verity:approved`), which GitHub serves from a
// SEARCH INDEX that lags label writes by seconds-to-minutes. Pre-stage-21 that
// lag was cosmetic. Stage 21 made it load-bearing: under a deferred unknown-cost
// refusal a P1 pick missed to lag becomes a hard `30 unknown-cost-budget` exit —
// the operator applied `verity:approved` exactly as the gate comment said,
// seconds before the tick; the lagged search missed it; the tick refused; the
// same query returned the item ~2 minutes later.
//
// The fix (stage 33): before a deferred refusal fires, runOnce re-checks the
// awaiting-approval carriers with a bounded FRESH (non-search) read — the same
// `--json labels` per-item lookup the P5 engine already uses (scanner
// .fetchTargetLabels), which reads the primary DB, not the index. A confirmed
// `verity:approved` becomes the P1 pick and flows through the ordinary P1 path.
//
// Stub-driven like tests/parked-resume.test.cjs (its stateful gh stub + scripted
// claude/codex agent stubs, $HOME redirected). No network, no live API, ever.
// The ONE addition vs. that harness: a per-run LAG_APPROVED env toggle that makes
// the search-indexed `list --label verity:approved` return EMPTY — the exact
// index lag — while the item's real label is untouched and a FRESH `view` still
// sees it. And `issue view --json labels` support, for issue carriers.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// --- stateful gh stub (PATH) — twin of tests/parked-resume.test.cjs -----------
// Additions: (a) LAG_APPROVED makes the search-indexed `list --label
// verity:approved` return EMPTY (the index lag); (b) `issue view --json labels`
// so a fresh per-item read of an issue carrier reflects the just-applied label.
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
const labelObjs = (it) => (it.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l));
if (args[0] === 'auth' && args[1] === 'status') { out('Logged in as verity-bot\\n'); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  const s = state();
  let items = args[0] === 'issue' ? s.issues : s.prs;
  const label = flag('--label');
  // INDEX LAG: the search-backed approved query has not caught up to the write.
  if (process.env.LAG_APPROVED && label && label.toLowerCase() === 'verity:approved') {
    out([]); process.exit(0);
  }
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
const prByNumber = (n) => state().prs.find((p) => p.number === Number(n));
const issueByNumber = (n) => state().issues.find((i) => i.number === Number(n));
if (args[0] === 'issue' && args[1] === 'view') {
  // FRESH read from the primary DB — never the search index. Reflects the label
  // write immediately, which is the whole point of the fallback.
  const it = issueByNumber(args[2]);
  out({ number: it.number, title: it.title, labels: labelObjs(it) });
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'diff') {
  out((prByNumber(args[2]).files || []).join('\\n') + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const p = prByNumber(args[2]);
  out({ number: p.number, title: p.title, additions: p.additions || 0, deletions: p.deletions || 0,
        headRefOid: p.headRefOid || null, labels: labelObjs(p) });
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
    out({ number: item.number, title: item.title, labels: labelObjs(item) });
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
// Usage with NO cost — codex never reports dollars (ADR-0008), so every success
// parks at unknown-cost. Argv log counts the model runs actually dispatched.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-deferred-lag-'));
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
  // A build dispatch holds git_write, which under codex means VERITY performs
  // the git (ADR-0012) — so a build fixture needs a real repo with an origin,
  // exactly like tests/unenforceable-dispatch.test.cjs.
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
    const git = (as) => execFileSync('git', as, { cwd: dir, stdio: 'pipe' });
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
const lagEnv = (fx) => ({ VERITY_CODEX_BIN: fx.codexAgent, LAG_APPROVED: '1' });
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
const summariesOf = (state, n) => comments(state, n).filter((b) => b.startsWith('🤖'));

const calls = (fx) =>
  fs.existsSync(fx.callsFile)
    ? fs
        .readFileSync(fx.callsFile, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
    : [];
// The fallback's carrier enumeration is the ONLY `list --label
// verity:awaiting-approval` in the whole worker (the scanner tiers never list
// that label) — so its count is an exact witness of whether the fallback ran.
const awaitingListCalls = (cs) =>
  cs.filter(
    (c) =>
      (c[0] === 'issue' || c[0] === 'pr') &&
      c[1] === 'list' &&
      c.includes('--label') &&
      c[c.indexOf('--label') + 1] === 'verity:awaiting-approval',
  );
// The fallback's fresh per-item read is `<noun> view N --json labels` (exactly
// the `labels` field-list) — scanner.fetchTargetLabels. A bounded fallback does
// at most one per awaiting-approval carrier; a pagination sweep would blow past.
const freshLabelViewCalls = (cs) =>
  cs.filter(
    (c) =>
      (c[0] === 'issue' || c[0] === 'pr') &&
      c[1] === 'view' &&
      c.includes('--json') &&
      c[c.indexOf('--json') + 1] === 'labels',
  );

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

const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const FINDINGS = '### Review findings\n- contracts intact\n- tests are real';

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

const APPROVE_STEP = {
  final: marker('success', {
    artifacts: { pr: 114, verdict: 'approve', effects: { findings_comment: FINDINGS } },
  }),
};
// The lottery step a RE-dispatch would consume — seeded so "zero new dispatch"
// is a meaningful reading (it must remain in the queue when the parked result
// is resumed).
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

// ---------------------------------------------------------------------------
// (1) THE REGRESSION: an approval missed by the lagged P1 search still lets a
// deferred-refusal tick PROCEED — the fresh re-check confirms it.
// ---------------------------------------------------------------------------

test('e2e REGRESSION (canary run 5 tick 3): under a DEFERRED refusal a lagged P1 approval is recovered by a fresh read — the tick PROCEEDS, it does not exit 30', () => {
  const fx = reviewFixture();

  // Tick 1: the codex review succeeds and parks at unknown-cost (ADR-0008),
  // labeling the PR awaiting-approval and arming the deferred daily refusal.
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates, exit 0 (stderr: ${tick1.stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'tick 1 paid for exactly one review run');
  assert(
    labelsOf(ghState(fx), 114).includes('verity:awaiting-approval'),
    'tick 1 parked the gate — the carrier now wears the settled awaiting-approval label',
  );

  // The operator does EXACTLY what the gate comment says — seconds before the
  // next tick. The search index has not caught up.
  approve(fx, 114);

  // Tick 2 WITH INDEX LAG: the P1 `list --label verity:approved` returns empty,
  // so the deferred refusal is about to fire. BEFORE the fix this exited 30
  // `unknown-cost-budget` — the true-but-not-yet refusal defect N4.
  const tick2 = runWorker(fx, { env: lagEnv(fx) });
  assertEqual(
    tick2.code,
    0,
    `the lagged approval is recovered by the fresh read and the tick proceeds (stderr: ${tick2.stderr})`,
  );
  assert(
    !tick2.stderr.includes('unknown-cost-budget'),
    `no deferred refusal fired, got:\n${tick2.stderr}`,
  );
  // It proceeded ON the approval: the budget line is recorded and the single-use
  // token was consumed, exactly as a normal P1 pick.
  const summaries = summariesOf(ghState(fx), 114);
  assert(
    summaries.some((b) => b.includes('budget:')),
    `the run records the unverifiable-budget-covered line, got: ${summaries.join('\n---\n')}`,
  );
  assert(
    !labelsOf(ghState(fx), 114).includes('verity:approved'),
    'the single-use approval was consumed — identical downstream semantics to a normal P1 pick',
  );
  // The fallback actually did the fresh, bounded, non-search read.
  const cs = calls(fx).filter((c) => true);
  assert(awaitingListCalls(cs).length >= 1, 'the fallback enumerated awaiting-approval carriers');
  assert(
    freshLabelViewCalls(cs).length >= 1,
    'and confirmed one with a fresh `view --json labels`',
  );
});

// ---------------------------------------------------------------------------
// (2) No lag → byte-identical: the search finds it first, the fallback is
// NEVER queried.
// ---------------------------------------------------------------------------

test('e2e: no lag — the P1 search finds the approval directly and the fallback is never queried (zero awaiting-approval list calls)', () => {
  const fx = reviewFixture();
  runWorker(fx, { env: codexEnv(fx) }); // tick 1 parks
  approve(fx, 114);

  // clear the calls log so we measure only tick 2's gh traffic.
  fs.writeFileSync(fx.callsFile, '');
  const tick2 = runWorker(fx, { env: codexEnv(fx) }); // NO lag
  assertEqual(tick2.code, 0, `tick 2 proceeds normally (stderr: ${tick2.stderr})`);

  const cs = calls(fx);
  assertEqual(
    awaitingListCalls(cs).length,
    0,
    'the fallback was never queried — the P1 search found the approval directly',
  );
  assertEqual(
    freshLabelViewCalls(cs).length,
    0,
    'no fresh fallback read either — behavior is byte-identical to before stage 33',
  );
});

// ---------------------------------------------------------------------------
// (3) No approval anywhere → refusal unchanged, and the fallback reads are
// BOUNDED (no pagination sweep).
// ---------------------------------------------------------------------------

test('e2e: no approval on any carrier — the deferred refusal fires unchanged (exit 30) and the fallback reads are bounded by the carrier count', () => {
  const fx = reviewFixture();
  runWorker(fx, { env: codexEnv(fx) }); // tick 1 parks — arms the deferral
  // The operator has NOT approved anything.

  fs.writeFileSync(fx.callsFile, '');
  const tick2 = runWorker(fx, { env: lagEnv(fx) });
  assertEqual(tick2.code, 30, 'no approval → the deferred refusal still fires');
  assertErrorLine(tick2.stderr, 30, 'unknown-cost-budget');

  const cs = calls(fx);
  // Plausible carriers = open items wearing the settled awaiting-approval label.
  const state = ghState(fx);
  const carriers = state.issues
    .concat(state.prs)
    .filter(
      (it) =>
        it.state === 'OPEN' &&
        (it.labels || []).some((l) => String(l).toLowerCase() === 'verity:awaiting-approval'),
    ).length;
  assertEqual(carriers, 1, 'exactly one awaiting-approval carrier (PR #114) exists this scan');
  assert(
    awaitingListCalls(cs).length >= 1,
    'the fallback ran (it must, to be sure before refusing)',
  );
  const views = freshLabelViewCalls(cs).length;
  assert(
    views <= carriers,
    `fresh reads bounded by the ${carriers} awaiting-approval carrier(s), got ${views} — no pagination sweep`,
  );
});

// ---------------------------------------------------------------------------
// (4) The SECOND throw site: a lagged P1 that fell through to a LOWER tier
// (non-P1 item) under a deferred refusal still recovers via the fallback.
// A fresh BUILD dispatch (not a resume) — and an ISSUE carrier, exercising the
// `issue view` fresh read.
// ---------------------------------------------------------------------------

function armDeferred(fx) {
  // A prior unknown-cost run PARKED at the unknown-cost gate today (UTC): the
  // exact ledger shape that makes startupChecks DEFER (approvable) rather than
  // refuse outright. 12-column row, empty est_usd cell = unknown cost.
  const header =
    'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate';
  const row = [
    new Date().toISOString(),
    'run-seed-000000',
    'octo/fixture',
    'build',
    '400000',
    '38112',
    '', // est_usd unknown
    '5',
    'gated',
    '0',
    'build',
    'unknown-cost',
  ].join(',');
  fs.writeFileSync(path.join(fx.dir, '.verity', 'usage.csv'), `${header}\n${row}\n`);
}

test('e2e (second throw site): a lagged P1 falls through to a lower tier — the fallback still recovers it and the BUILD dispatches (issue carrier, fresh `issue view`)', () => {
  // The carrier issue wears the settled awaiting-approval + a lower-tier
  // verity:ready label, plus the just-applied verity:approved. Under lag P1
  // misses, so the scan falls through to P3 (ready) — a non-P1 item that would
  // hit the SECOND throw site. The fallback's fresh `issue view` reveals the
  // approval and recovers it as P1.
  const carrier = {
    ...structuredClone(STAGE_ISSUE),
    labels: ['verity:ready', 'verity:awaiting-approval', 'verity:approved'],
  };
  const fx = fixture({
    git: true,
    issues: [carrier],
    stages: [{ title: 'Core' }],
    queue: [{ final: marker('success') }],
  });
  armDeferred(fx);

  const { code, stderr } = runWorker(fx, { env: lagEnv(fx) });
  assertEqual(
    code,
    0,
    `the fell-through P1 is recovered and the build proceeds (stderr: ${stderr})`,
  );
  assert(!stderr.includes('unknown-cost-budget'), `no deferred refusal, got:\n${stderr}`);
  assertEqual(codexArgvs(fx).length, 1, 'the build actually dispatched — the tick did real work');
  const summaries = summariesOf(ghState(fx), 41);
  assert(
    summaries.some((b) => b.includes('budget:')),
    `the budget line is recorded on a fell-through recovery too, got: ${summaries.join('\n---\n')}`,
  );
  const cs = calls(fx);
  assert(
    freshLabelViewCalls(cs).some((c) => c[0] === 'issue' && c[2] === '41'),
    'the fresh read was an `issue view 41 --json labels` — the primary-DB lookup, not the search index',
  );
});
