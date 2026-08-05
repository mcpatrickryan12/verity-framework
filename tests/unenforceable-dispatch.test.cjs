// Stage 26 — the unenforceable-policy refusal must actually fire on the worker
// dispatch path (canary §4 re-run, defect 3, tick 12).
//
// The defect: with `agent.acknowledged_enforcement_gaps` REMOVED from the
// autonomy policy, `verity autonomy validate` said `valid` AND the worker
// dispatched codex anyway (52,909 tokens in) — ADR-0011's capability-honesty
// refusal (exit 30 `unenforceable-policy`) never fired on the path that
// matters.
//
// Root cause — (b), the gap computation, not the plumbing: the worker forwards
// the acknowledgement into every dispatch (worker/index.cjs) and agent-exec
// always runs the provider's checkEnforceable before spawning anything
// (agent-exec.cjs step 2b) — but `assertEnforceable` computed NO gap for the
// one role the canary tick dispatched. `commands/verity/build.permissions.json`
// GRANTED network (`true`, unchanged since stage 8), and a grant is never a
// gap (policy.cjs enforcementGaps: only a restriction with a null mechanism
// counts). plan and review declare `network: false` and always refused; build
// sailed through the honesty gate whether or not the operator had acknowledged
// anything. The fix declares build's network restriction honestly (`false` —
// under codex the sandbox provides no network and Verity performs the
// git/GitHub work anyway, ADR-0012/0013), so EVERY worker-dispatchable role
// carries the ADR-0011 gap; and `verity autonomy validate` now refuses the
// gap-less codex policy instead of contradicting the worker's refusal with
// `valid`.
//
// Stub-driven like tests/worker.test.cjs (its stateful gh stub + scripted
// claude/codex agent stubs, $HOME redirected). No network, no live API, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rolePolicy = require('../verity/bin/lib/agents/policy.cjs');
const stage = require('../verity/bin/lib/stage.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const ROLES_DIR = path.join(__dirname, '..', 'commands', 'verity');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// The roles the worker can dispatch: P4 synthesizes 'plan' (worker/index.cjs),
// the dependency engine plans 'build'/'review' (next.cjs). The §4 canary rule
// "removing the acknowledgement makes EVERY dispatch refuse" quantifies over
// exactly this set.
const WORKER_DISPATCH_ROLES = ['build', 'plan', 'review'];

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
// Argv log + liveness marker: the argv log counts how many model runs were
// actually dispatched, and the marker (issue #28) proves an invocation RAN —
// so "codex was never spawned" below is a meaningful reading, not an accident.
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
// The canary §4 negative: provider codex with the acknowledgement ABSENT —
// the policy `verity autonomy validate` blessed and the worker dispatched on.
const POLICY_CODEX_NOACK = [
  'mode: supervised',
  'agent:',
  '  provider: codex',
  'notify:',
  '  mention: [seanerama]',
  '',
].join('\n');
// The §4 positive: the operator's explicit, auditable admission (stage 11).
const POLICY_CODEX_ACK = [
  'mode: supervised',
  'agent:',
  '  provider: codex',
  '  acknowledged_enforcement_gaps: [network]',
  'notify:',
  '  mention: [seanerama]',
  '',
].join('\n');

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-unenforceable-'));
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
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY_SUPERVISED);
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  // The build role holds git_write, which under codex means VERITY performs its
  // git (ADR-0012) — so a build-dispatching fixture needs a real repository
  // with a real origin, exactly like tests/worker.test.cjs. The harness's own
  // scratch is gitignored: it is not the role's work.
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
        .map((l) => JSON.parse(l))
    : [];
const ghState = (fx) => JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
const itemIn = (state, n) => state.issues.concat(state.prs).find((it) => it.number === n);
const labelsOf = (state, n) =>
  (itemIn(state, n).labels || []).map((l) => (typeof l === 'string' ? l : l.name));

// How many role invocations proved they actually ran (issue #28): a "codex was
// never spawned" assertion is only meaningful next to this counter.
function livenessMarkers(fx) {
  const logs = path.join(fx.home, '.verity', 'logs');
  if (!fs.existsSync(logs)) {
    return 0;
  }
  return fs
    .readdirSync(logs)
    .filter((run) => fs.existsSync(path.join(logs, run, 'liveness.marker'))).length;
}

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

// A planned stage ready to build — the canary tick-12 shape: the very next
// dispatch is the BUILD role, the one whose policy hid the gap.
const STAGE_ISSUE = {
  number: 41,
  title: '[stage 1] Core',
  state: 'OPEN',
  labels: ['verity:ready'],
  author: { login: 'human' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
};

function buildFixture(opts = {}) {
  return fixture({
    git: true,
    issues: [structuredClone(STAGE_ISSUE)],
    stages: [{ title: 'Core' }],
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// (0) The gap itself — the root-cause unit reading (fails before the fix)
// ---------------------------------------------------------------------------

test('regression: the build role declares network RESTRICTED — the worker dispatch carries the ADR-0011 gap', () => {
  // Before the fix build.permissions.json granted network (true, unchanged
  // since stage 8), so enforcementGaps computed [] and the honesty gate had
  // nothing to refuse — the exact hole canary tick 12 dispatched through.
  const loaded = rolePolicy.loadPolicy(path.join(ROLES_DIR, 'build.permissions.json'));
  assertEqual(
    loaded.capabilities.network,
    false,
    'build must not GRANT network: under codex the sandbox provides none and Verity performs the git/GitHub work (ADR-0012/0013) — a true here silently disarms the ADR-0011 refusal',
  );
  assertEqual(
    JSON.stringify(rolePolicy.enforcementGaps(loaded)),
    '["network"]',
    'the one unenforceable restriction, computed as a gap',
  );
});

test('every worker-dispatchable role carries the gap: unacknowledged refuses (exit 30, names gap + remedy), acknowledged returns the admission', () => {
  for (const role of WORKER_DISPATCH_ROLES) {
    const loaded = rolePolicy.loadPolicy(path.join(ROLES_DIR, `${role}.permissions.json`));
    assertEqual(
      JSON.stringify(rolePolicy.enforcementGaps(loaded)),
      '["network"]',
      `${role}: the §4 rule "removing the acknowledgement makes EVERY dispatch refuse" needs every dispatchable role to carry the gap`,
    );
    let err = null;
    try {
      rolePolicy.assertEnforceable(loaded, []);
    } catch (e) {
      err = e;
    }
    assert(err !== null, `${role}: unacknowledged gap refuses`);
    assertEqual(err.slug, 'unenforceable-policy', `${role}: the existing slug`);
    assertEqual(err.exitCode, 30, `${role}: exit 30`);
    assert(err.message.includes('network: false'), `${role}: names the gap`);
    assert(
      err.message.includes('acknowledged_enforcement_gaps: [network]'),
      `${role}: names the remedy`,
    );
    // The acknowledged path returns the gaps that APPLIED — the value
    // agent-exec surfaces in the result as enforcement_gaps_acknowledged
    // (stage 11; the plumbing is proven in tests/enforcement.test.cjs).
    assertEqual(
      JSON.stringify(rolePolicy.assertEnforceable(loaded, ['network'])),
      '["network"]',
      `${role}: acknowledged proceeds with the admission returned`,
    );
  }
});

// ---------------------------------------------------------------------------
// (1) The worker dispatch path — the canary tick-12 reproduction
// ---------------------------------------------------------------------------

test('e2e REGRESSION (canary §4 tick 12): a worker codex BUILD dispatch with the acknowledgement absent refuses exit 30 unenforceable-policy BEFORE any provider spawn', () => {
  const fx = buildFixture({ policy: POLICY_CODEX_NOACK });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });

  // Before the fix: codex was invoked (an argv row, a liveness marker, a
  // transcript, 52,909 canary tokens) and the run proceeded. Now: exit 30.
  assertEqual(code, 30, `unacknowledged gap is an infra refusal, exit 30 (stderr: ${stderr})`);
  assert(
    stderr.includes('verity-agent-exec: 30 unenforceable-policy:'),
    `agent-exec's own slug line, from the existing assertEnforceable refusal, got:\n${stderr}`,
  );
  assert(
    stderr.includes('verity-worker: 30 infra-error:'),
    `the worker surfaces the refusal as its §8.2 infra line, got:\n${stderr}`,
  );
  assert(stderr.includes('network: false'), 'the refusal names the gap');
  assert(
    stderr.includes('acknowledged_enforcement_gaps: [network]'),
    'the refusal names the remedy',
  );

  // BEFORE the provider process spawns: no codex argv was logged, no liveness
  // marker written — and agent-exec refused before even creating the run's
  // transcript directory.
  assertEqual(codexArgvs(fx).length, 0, 'codex was never invoked');
  assertEqual(livenessMarkers(fx), 0, 'no invocation proved itself alive');
  assert(
    !fs.existsSync(path.join(fx.home, '.verity', 'logs')),
    'refused before the transcript directory was created',
  );
});

test('e2e REGRESSION (stage 32): a P1 unenforceable-policy refusal preserves verity:approved + verity:awaiting-approval and re-announces no gate', () => {
  // The exact canary-run-5 tick-8 shape carried on an APPROVED item: a human
  // applied verity:approved (P1) to a stage that then dispatches codex build —
  // which refuses unenforceable-policy BEFORE spawning anything. Before stage
  // 32 the top-of-loop consumption had already stripped BOTH labels, so PR #7
  // ended gated with no labels: the approval burned, the pause invisible, and
  // stage 27's announce-once primed to re-announce on the next healthy tick.
  const approvedIssue = {
    ...structuredClone(STAGE_ISSUE),
    labels: ['verity:ready', 'verity:approved', 'verity:awaiting-approval'],
  };
  const fx = fixture({
    git: true,
    issues: [approvedIssue],
    stages: [{ title: 'Core' }],
    policy: POLICY_CODEX_NOACK,
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });

  assertEqual(code, 30, `the pre-spawn refusal is still an infra exit (stderr: ${stderr})`);
  assert(stderr.includes('unenforceable-policy'), 'it really was the honesty refusal');
  assertEqual(codexArgvs(fx).length, 0, 'nothing spawned — a pre-work refusal');

  const state = ghState(fx);
  const labels = labelsOf(state, 41);
  assert(labels.includes('verity:approved'), 'the single-use approval SURVIVES the refusal');
  assert(
    labels.includes('verity:awaiting-approval'),
    'the gate announcement survives — the operator can still see the pause',
  );
  const gateComments = (itemIn(state, 41).comments || []).filter((c) =>
    (c.body || '').includes('paused at human gate'),
  );
  assertEqual(gateComments.length, 0, 'no new gate comment — announce-once stays quiet (stage 27)');
});

test('e2e: with the gap ACKNOWLEDGED the same build dispatch proceeds (stage 11 behavior, untouched)', () => {
  const fx = buildFixture({
    policy: POLICY_CODEX_ACK,
    queue: [{ final: marker('success') }],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  // The build succeeds with unknown codex cost, so the run parks at the
  // default unknown-cost gate (ADR-0008) — a PAUSE, exit 0, after a real
  // dispatch. The point here is the honesty gate LET IT THROUGH.
  assertEqual(code, 0, `acknowledged run proceeds (stderr: ${stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'exactly one codex dispatch — the build role');
  assertEqual(livenessMarkers(fx), 1, 'and it provably ran');
  assert(!stderr.includes('unenforceable-policy'), 'no refusal anywhere');
  assert(
    labelsOf(ghState(fx), 41).includes('verity:awaiting-approval'),
    'the run got far enough to park at the unknown-cost gate',
  );
});

test('agent-exec: an acknowledged codex build dispatch records the admission in the result', () => {
  const fx = buildFixture({ queue: [{ final: marker('success') }] });
  const out = execFileSync(
    'node',
    [
      CLI,
      'agent-exec',
      'build',
      '1',
      '--run-id',
      'adm-1',
      '--agent',
      'codex',
      '--acknowledge-gaps',
      'network',
    ],
    {
      cwd: fx.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
        HOME: fx.home,
        VERITY_CODEX_BIN: fx.codexAgent,
        VERITY_AGENT_BIN: '',
        VERITY_CLAUDE_BIN: '',
      },
    },
  );
  const res = JSON.parse(out);
  assertEqual(res.outcome, 'success', 'the acknowledged dispatch ran to success');
  assertEqual(
    JSON.stringify(res.enforcement_gaps_acknowledged),
    '["network"]',
    'the admission is recorded in the result — never a silent allowance (stage 11)',
  );
});

test('e2e: a CLAUDE build dispatch is unaffected — no gap, no acknowledgement, no refusal', () => {
  // Claude's write-time restriction is its own harness allowlist
  // (.tools.json); it never consumes .permissions.json, so build's now-honest
  // `network: false` changes nothing on this path.
  const fx = fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    stages: [{ title: 'Core' }],
    queue: [{ final: marker('failed', { reason: 'build hit a wall' }) }],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 20, `the claude build ran and failed on its own terms (stderr: ${stderr})`);
  assert(stderr.includes('verity-worker: 20 role-failed-once:'), 'ordinary strike-1 failure');
  assert(!stderr.includes('unenforceable-policy'), 'no honesty refusal on the claude path');
  assertEqual(
    JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length,
    0,
    'the claude agent stub was actually invoked (queue consumed)',
  );
  assertEqual(codexArgvs(fx).length, 0, 'codex never entered the picture');
});

// ---------------------------------------------------------------------------
// (2) `verity autonomy validate` must not contradict the worker's refusal
// ---------------------------------------------------------------------------

function writePolicyDir(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-unenforceable-val-'));
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), text);
  return dir;
}

function runCli(args, dir) {
  try {
    const out = execFileSync('node', [CLI, ...args, '--cwd', dir], { encoding: 'utf8' });
    return { out, err: '', code: 0 };
  } catch (e) {
    return { out: e.stdout || '', err: e.stderr || '', code: e.status };
  }
}

test('regression: `autonomy validate` refuses the gap-less codex policy instead of blessing what every dispatch will refuse', () => {
  // The canary reproduction: this exact validate said `valid` (exit 0) while
  // the worker's dispatches carried an unacknowledged enforcement gap.
  const dir = writePolicyDir(POLICY_CODEX_NOACK);
  const res = runCli(['autonomy', 'validate'], dir);
  assertEqual(res.code, 20, `validate must flag the gap-less codex policy, got exit ${res.code}`);
  assert(res.err.includes('network'), `names the gap, got: ${res.err}`);
  assert(res.err.includes('unenforceable-policy'), 'says what every dispatch would exit with');
  assert(
    res.err.includes('acknowledged_enforcement_gaps: [network]'),
    "names the remedy in the operator's own vocabulary",
  );
});

test('validate: the acknowledged codex policy and claude policies stay valid (exit 0)', () => {
  const acked = writePolicyDir(POLICY_CODEX_ACK);
  assertEqual(runCli(['autonomy', 'validate'], acked).code, 0, 'acknowledged codex policy valid');
  const claude = writePolicyDir(POLICY_SUPERVISED);
  assertEqual(runCli(['autonomy', 'validate'], claude).code, 0, 'claude policy untouched');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-unenforceable-val-'));
  assertEqual(runCli(['autonomy', 'validate'], empty).code, 0, 'missing file (defaults) untouched');
});
