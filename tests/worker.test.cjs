// T10 — verity-worker run loop + circuit breakers (SKETCH §4.4, §7, §8).
//
// Stub-driven end-to-end: `gh` is a stateful stub on PATH (labels/comments
// persist in a JSON state file, every call is logged), the agent binary is a
// scripted stub via VERITY_AGENT_BIN (canned stream-json per invocation, may
// append issues/PRs to the gh state to simulate role side effects), $HOME is
// redirected. No network, no live API, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// --- stateful gh stub (PATH) -------------------------------------------------
// Serves `issue list` / `pr list` (with --label / --state filtering for the
// scanner AND the ledger's unfiltered snapshot queries), `repo view`,
// `api user`, and the issues REST surface the worker/locks use:
//   GET  repos/o/r/issues/N            GET  .../comments?per_page&page
//   POST .../labels  -f labels[]=L     DELETE .../labels/<enc>
//   POST .../comments -f body=...
// Also serves `auth status` (T12 startup check); STUB_AUTH_FAIL=1 simulates a
// logged-out gh. STUB_FAIL_SUBSTR injects a fail-fast HTTP 422 on any matching
// call (crash test).
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.CALLS_FILE) fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n');
const failSub = process.env.STUB_FAIL_SUBSTR;
if (failSub && args.join(' ').includes(failSub)) {
  process.stderr.write('HTTP 422: injected failure\\n');
  process.exit(1);
}
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.STUB_AUTH_FAIL) {
    process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\\n');
    process.exit(1);
  }
  out('github.com: Logged in as verity-bot\\n');
  process.exit(0);
}
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  const s = state();
  let items = args[0] === 'issue' ? s.issues : s.prs;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
// T13 trust-ladder surface: pr diff/view/checks/merge against a single PR.
// PR fixtures carry { files, additions, deletions, checksPass } for these.
const prByNumber = (n) => state().prs.find((p) => p.number === Number(n));
if (args[0] === 'pr' && args[1] === 'diff') {
  out((prByNumber(args[2]).files || []).join('\\n') + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const p = prByNumber(args[2]);
  out({ additions: p.additions || 0, deletions: p.deletions || 0 });
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
  out('');
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

// --- scripted agent stub (VERITY_AGENT_BIN) ----------------------------------
// Pops one step per invocation from AGENT_QUEUE (JSON array). A step is
//   { final, overrides?, addIssues?, addPrs? }  — canned stream-json result, or
//   { raw }                                     — verbatim stdout (infra cases).
// addIssues/addPrs simulate the role's GitHub side effects between iterations.
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
if (step.addIssues || step.addPrs) {
  const s = JSON.parse(fs.readFileSync(process.env.GH_STATE_FILE, 'utf8'));
  s.issues = s.issues.concat(step.addIssues || []);
  s.prs = s.prs.concat(step.addPrs || []);
  fs.writeFileSync(process.env.GH_STATE_FILE, JSON.stringify(s));
}
if (step.raw !== undefined) { process.stdout.write(step.raw); process.exit(0); }
const result = Object.assign({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 1.87,
  usage: { input_tokens: 400000, cache_creation_input_tokens: 10000,
           cache_read_input_tokens: 2034, output_tokens: 38112 },
}, step.overrides || {});
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
for (let i = 0; i < (step.toolUses || 0); i += 1) {
  process.stdout.write(JSON.stringify({ type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: {} }] } }) + '\\n');
}
process.stdout.write(JSON.stringify(result) + '\\n');
`;

// --- scripted CODEX stub (VERITY_CODEX_BIN — stage 9) --------------------------
// The codex-flavored twin of AGENT_STUB: answers --version / `login status`,
// pops the same AGENT_QUEUE, applies the same gh side effects, and replays the
// step as a codex JSONL transcript (marker in the final agent message; usage
// with NO cost — codex never reports dollars, ADR-0008). Every exec argv is
// appended to CODEX_ARGV_LOG so tests can assert per-chained-role propagation.
const CODEX_AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.42.0\\n');
  process.exit(0);
}
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
if (process.env.CODEX_ARGV_LOG) fs.appendFileSync(process.env.CODEX_ARGV_LOG, JSON.stringify(args) + '\\n');
fs.readFileSync(0, 'utf8'); // consume the stdin prompt
const queueFile = process.env.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
if (step.addIssues || step.addPrs) {
  const s = JSON.parse(fs.readFileSync(process.env.GH_STATE_FILE, 'utf8'));
  s.issues = s.issues.concat(step.addIssues || []);
  s.prs = s.prs.concat(step.addPrs || []);
  fs.writeFileSync(process.env.GH_STATE_FILE, JSON.stringify(s));
}
if (step.raw !== undefined) { process.stdout.write(step.raw); process.exit(0); }
const lines = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.started', item: { id: 'i0', item_type: 'command_execution', command: 'true' } },
  { type: 'item.completed', item: { id: 'i0', item_type: 'command_execution', exit_code: 0 } },
  { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: step.final } },
  { type: 'turn.completed', usage: { input_tokens: 400000, cached_input_tokens: 2034, output_tokens: 38112 } },
];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
`;

const POLICY_SUPERVISED = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-worker-'));
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
  if (opts.policy !== null) {
    fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY_SUPERVISED);
  }
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  return { dir, home, bin, agent, codexAgent, codexArgvLog, stateFile, queueFile, callsFile };
}

// Env extras that point provider selection at the codex stub for one run.
function codexEnv(fx) {
  return { VERITY_CODEX_BIN: fx.codexAgent, CODEX_ARGV_LOG: fx.codexArgvLog };
}

function codexArgvs(fx) {
  return fs.existsSync(fx.codexArgvLog)
    ? fs
        .readFileSync(fx.codexArgvLog, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
    : [];
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
  const args = extra.args || ['--repo', 'octo/fixture', '--once'];
  try {
    const out = execFileSync('node', [WORKER, ...args], { cwd: fx.dir, encoding: 'utf8', env });
    return { code: 0, out, stderr: '' };
  } catch (err) {
    return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
  }
}

function ghState(fx) {
  return JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
}

function itemIn(state, number) {
  return state.issues.concat(state.prs).find((it) => it.number === number);
}

function comments(state, number) {
  return (itemIn(state, number).comments || []).map((c) => c.body);
}

function labels(state, number) {
  return (itemIn(state, number).labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

const REQUEST_ISSUE = {
  number: 30,
  title: 'Add widgets',
  state: 'OPEN',
  labels: ['verity:request'],
  author: { login: 'human' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
};

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

// --- (a) the golden path: request → plan → build → gated at review ----------

test('e2e: request → plan → build → gated-at-review posts EXACTLY the §7 summary', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    queue: [
      {
        final: marker('success', { artifacts: { issues: [31] } }),
        addIssues: [
          { number: 31, title: '[stage 1] Core', state: 'OPEN', labels: [], assignees: [] },
        ],
      },
      {
        final: marker('success', { artifacts: { pr: 114 } }),
        addPrs: [
          {
            number: 114,
            title: '[stage 1] Core',
            state: 'OPEN',
            headRefName: 'feat/stage-1-core',
            labels: [],
            statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          },
        ],
      },
      { final: marker('gated', { gate: 'review:merge' }) },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `gated run exits 0 (stderr: ${stderr})`);

  const state = ghState(fx);
  const all = comments(state, 30);
  const summary = all.find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'run-summary comment posted on the request issue');
  const re = new RegExp(
    '^🤖 \\*\\*verity-worker\\*\\* `run-[A-Za-z0-9._-]+` — ⏸️ gated\n' +
      'roles: plan → build → review\n' +
      'result: PR #114 opened, gated at review:merge\n' +
      'tokens: 1236k in / 114k out · est \\$5\\.61 · wall \\d+m\\d+s\n' +
      'approve: apply label `verity:approved` or comment `/verity approve`$',
  );
  assert(re.test(summary), `summary matches the §7 template exactly, got:\n${summary}`);
  assertEqual(all.filter((b) => b.startsWith('🤖')).length, 1, 'exactly one summary per run');

  // GATE_PAUSE: label + pending/approve/mention comment land on the gate's
  // TARGET — the PR under review — not the run's anchor (T14 fix: that is
  // where the human approves and where `verity next` reads the gate from).
  assert(labels(state, 114).includes('verity:awaiting-approval'), 'gate label applied on the PR');
  assert(
    !labels(state, 30).includes('verity:awaiting-approval'),
    'the anchor (request issue) is NOT gate-labeled',
  );
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate !== undefined, 'gate-pause comment posted on the PR');
  assert(gate.includes('paused at human gate `review:merge`'), 'names the gate');
  assert(gate.includes('pending:'), 'says what is pending');
  assert(gate.includes(worker.APPROVAL_ACTION), 'exact approval action');
  assert(gate.includes('@seanerama'), 'mentions notify.mention');

  // Lock lifecycle: lock comment, then unlock with the run outcome; label gone.
  assert(
    all.some((b) => b.startsWith('lock:run-')),
    'lock comment posted',
  );
  assert(
    all.some((b) => /^unlock:run-\S+ outcome:gated$/.test(b)),
    'unlock comment carries outcome gated',
  );
  assert(!labels(state, 30).includes('verity:in-progress'), 'lock label released');
});

// --- (b) token limit breaker -------------------------------------------------

test('e2e: max_tokens_per_run trips SUMMARIZE(limit_hit), exit 0', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_tokens_per_run: 1000\n`,
    queue: [{ final: marker('success') }],
  });
  const { code } = runWorker(fx);
  assertEqual(code, 0, 'limit_hit exits 0');
  const summary = comments(ghState(fx), 30).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— 🛑 limit_hit'), 'outcome badge is limit_hit');
  assert(summary.includes('max_tokens_per_run (1000)'), 'names the tripped limit');
  assert(summary.includes('roles: plan'), 'one role ran before the breaker');
  assert(!summary.includes('approve:'), 'no approve line when not gated');
});

// --- (c)(d) the 2-strike rule ------------------------------------------------

test('e2e: second failure applies verity:needs-human, exit 20', () => {
  const fx = fixture({
    issues: [stageIssue({ comments: [{ body: 'unlock:run-old outcome:failed' }] })],
    stages: [{ title: 'Core' }],
    queue: [{ final: marker('failed', { reason: 'CI would not go green' }) }],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 20, 'failure exits 20');
  assert(stderr.includes('verity-worker: 20 role-failed:'), '§8.2 stderr line');
  const state = ghState(fx);
  assert(labels(state, 41).includes('verity:needs-human'), '2nd strike → needs-human label');
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ❌ failed'), 'outcome badge failed');
  assert(summary.includes('strike 2'), 'summary names the strike');
  assert(
    comments(state, 41).some((b) => /^unlock:run-\S+ outcome:failed$/.test(b)),
    'unlock outcome failed',
  );
});

test('e2e: first failure → failed_once, NO needs-human label, exit 20', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    queue: [{ final: marker('failed', { reason: 'CI would not go green' }) }],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 20);
  assert(stderr.includes('verity-worker: 20 role-failed-once:'), 'failed_once slug');
  const state = ghState(fx);
  assert(!labels(state, 41).includes('verity:needs-human'), 'no needs-human on strike 1');
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ⚠️ failed_once'), 'outcome badge failed_once');
  assert(
    comments(state, 41).some((b) => /^unlock:run-\S+ outcome:failed_once$/.test(b)),
    'unlock outcome failed_once feeds the next run’s strike count',
  );
});

// --- (e) infra errors never escalate to needs-human ---------------------------

test('e2e: infra_error → SUMMARIZE(infra), exit 30, NO needs-human label', () => {
  const fx = fixture({
    issues: [stageIssue({ comments: [{ body: 'unlock:run-old outcome:failed' }] })],
    stages: [{ title: 'Core' }],
    queue: [{ raw: 'not json at all\n' }], // agent emits garbage → malformed-output
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30, 'infra exits 30');
  assert(stderr.includes('verity-worker: 30 infra-error:'), '§8.2 stderr line');
  const state = ghState(fx);
  assert(!labels(state, 41).includes('verity:needs-human'), 'infra is not a strike');
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— 💥 infra'), 'outcome badge infra');
  assert(
    comments(state, 41).some((b) => /^unlock:run-\S+ outcome:infra$/.test(b)),
    'unlock outcome infra (does not match failed*)',
  );
});

// --- (f) mode: manual ----------------------------------------------------------

test('e2e: mode manual → "autonomy disabled", exit 0, zero gh calls', () => {
  const fx = fixture({ policy: null }); // no autonomy.yml → defaults → manual
  const { code, out } = runWorker(fx);
  assertEqual(code, 0, 'manual mode exits 0');
  assert(out.includes('autonomy disabled'), 'prints the exact disabled message');
  assert(!fs.existsSync(fx.callsFile), 'gh was never invoked');
});

// --- (g) lock released on crash ------------------------------------------------

test('e2e: crash mid-loop (gh 422 during GATE_PAUSE) still releases the lock, exit 30', () => {
  const fx = fixture({
    // stage issue already carries the gate label → first `next` says gated.
    issues: [stageIssue({ labels: ['verity:ready', 'verity:awaiting-approval'] })],
    stages: [{ title: 'Core' }],
  });
  const { code, stderr } = runWorker(fx, {
    env: { STUB_FAIL_SUBSTR: 'labels[]=verity:awaiting-approval' },
  });
  assertEqual(code, 30, 'crash exits 30');
  assert(/verity-worker: 30 \S+:/.test(stderr), '§8.2 single-line stderr error');
  const state = ghState(fx);
  assert(!labels(state, 41).includes('verity:in-progress'), 'lock label removed in finally');
  assert(
    comments(state, 41).some((b) => /^unlock:run-\S+ outcome:infra$/.test(b)),
    'unlock comment posted in finally despite the crash',
  );
});

// --- double start ----------------------------------------------------------------

test('e2e: freshly-locked item → second worker finds no work, exit 0 within one scan', () => {
  const fx = fixture({
    issues: [
      stageIssue({
        labels: ['verity:ready', 'verity:in-progress'],
        comments: [{ body: 'lock:run-other expires:2099-01-01T00:00:00.000Z' }],
      }),
    ],
    stages: [{ title: 'Core' }],
  });
  const { code, out } = runWorker(fx);
  assertEqual(code, 0, 'second instance exits 0 (§8.5)');
  assert(out.includes('idle'), 'reports no eligible work');
  const state = ghState(fx);
  assertEqual(
    comments(state, 41).length,
    1,
    'no new lock/unlock comments — the other run’s lock is untouched',
  );
});

// --- P1 approved-resume consumes the token ---------------------------------------

test('e2e: P1 item — verity:approved (and the gate label) are consumed before working', () => {
  const fx = fixture({
    issues: [
      {
        number: 50,
        title: 'gated thing',
        state: 'OPEN',
        labels: ['verity:approved', 'verity:awaiting-approval'],
        author: { login: 'human' },
        createdAt: '2026-06-01T00:00:00Z',
        assignees: [],
        comments: [],
      },
    ],
    // no stages → after consuming, `next` is honestly idle → success.
  });
  const { code } = runWorker(fx);
  assertEqual(code, 0);
  const state = ghState(fx);
  assert(!labels(state, 50).includes('verity:approved'), 'approved consumed (single-use, §1)');
  assert(
    !labels(state, 50).includes('verity:awaiting-approval'),
    'gate label removed with it (no instant re-gate)',
  );
  const summary = comments(state, 50).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ✅ success'), 'idle after resume summarizes success');
  assert(summary.includes('roles: (none)'), 'no roles ran');
});

// --- a gated PR actually pauses the worker (T14 regression) -----------------------

test('e2e: PR carrying the gate label → worker is idle, agent NEVER invoked', () => {
  // Stage in-review whose PR was gate-labeled by a previous run's GATE_PAUSE.
  // Before the T14 fix the gate was invisible to `verity next` (it only read
  // the work-item issue), so every tick re-selected the PR and re-ran review.
  const fx = fixture({
    issues: [stageIssue({ labels: [] })],
    stages: [{ title: 'Core' }],
    prs: [
      {
        number: 114,
        title: '[stage 1] Core',
        state: 'OPEN',
        headRefName: 'feat/stage-1-core',
        labels: ['verity:awaiting-approval'],
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        comments: [],
      },
    ],
    queue: [], // any agent invocation would fail loudly (queue exhausted → infra)
  });
  const { code, out } = runWorker(fx);
  assertEqual(code, 0, 'gated repo is idle, exit 0');
  assert(out.includes('idle'), 'reports no eligible work');
  const state = ghState(fx);
  assertEqual(comments(state, 114).length, 0, 'no new comments while waiting for the human');
  assert(!labels(state, 114).includes('verity:in-progress'), 'the gated PR is never locked');
});

// --- T13: trust ladder on review-approve -------------------------------------------

// A stage whose PR is open + CI-green (status in-review → `next` says review),
// with the T13 classification fields on the PR fixture.
function reviewFixture(prExtra = {}, policy = POLICY_SUPERVISED) {
  return fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    policy,
    prs: [
      {
        number: 114,
        title: '[stage 1] Core',
        state: 'OPEN',
        headRefName: 'feat/stage-1-core',
        labels: [],
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        files: ['docs/guide.md', 'README.md'],
        additions: 10,
        deletions: 5,
        checksPass: true,
        ...prExtra,
      },
    ],
    queue: [{ final: marker('success', { artifacts: { pr: 114, verdict: 'approve' } }) }],
  });
}

function mergeCalls(fx) {
  return readCalls(fx).filter((c) => c[0] === 'pr' && c[1] === 'merge');
}

test('e2e: review-approve at trust 1, low-risk PR → gh pr merge --squash invoked', () => {
  const fx = reviewFixture({}, `${POLICY_SUPERVISED}review:\n  trust: 1\n`);
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `merged run exits 0 (stderr: ${stderr})`);
  assertEqual(
    JSON.stringify(mergeCalls(fx)),
    JSON.stringify([['pr', 'merge', '114', '--squash']]),
    'exactly one squash merge of the reviewed PR',
  );
  const state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'MERGED', 'the PR is merged');
  assert(!labels(state, 41).includes('verity:awaiting-approval'), 'no gate on a merged run');
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ✅ success'), 'run summarizes success');
  assert(summary.includes('auto-merged PR #114'), 'summary audits the auto-merge');
});

test('e2e: review-approve at trust 1, protected-path PR → gates, never merges', () => {
  const fx = reviewFixture(
    { files: ['docs/guide.md', '.github/workflows/ci.yml'] },
    `${POLICY_SUPERVISED}review:\n  trust: 1\n`,
  );
  const { code } = runWorker(fx);
  assertEqual(code, 0, 'gated run exits 0');
  assertEqual(mergeCalls(fx).length, 0, 'NO merge call for a high-risk change');
  const state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'OPEN', 'the PR stays open');
  assert(labels(state, 114).includes('verity:awaiting-approval'), 'gate label applied on the PR');
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate.includes('review:merge'), 'gated at review:merge');
  assert(gate.includes('protected path .github/**'), 'gate reason names the protected hit');
});

test('e2e: review-approve at trust 0 NEVER merges — gates with zero classification calls', () => {
  const fx = reviewFixture(); // POLICY_SUPERVISED → default review.trust 0
  const { code } = runWorker(fx);
  assertEqual(code, 0);
  assertEqual(mergeCalls(fx).length, 0, 'trust 0 never merges, even on approve');
  const trustCalls = readCalls(fx).filter(
    (c) => c[0] === 'pr' && ['diff', 'view', 'checks', 'merge'].includes(c[1]),
  );
  assertEqual(trustCalls.length, 0, 'trust 0 does not even classify');
  const state = ghState(fx);
  assert(labels(state, 114).includes('verity:awaiting-approval'), 'gated for a human (on the PR)');
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate.includes('trust 0'), 'gate reason names the trust level');
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ⏸️ gated'), 'outcome gated');
  assert(summary.includes('PR #114 reviewed'), 'result names the reviewed PR');
});

test('e2e: review success WITHOUT an approve verdict gates (fail closed), never merges', () => {
  const fx = reviewFixture({}, `${POLICY_SUPERVISED}review:\n  trust: 2\n`);
  // Override the queue: success marker with no verdict at all.
  fs.writeFileSync(
    fx.queueFile,
    JSON.stringify([{ final: marker('success', { artifacts: { pr: 114 } }) }]),
  );
  const { code } = runWorker(fx);
  assertEqual(code, 0);
  assertEqual(mergeCalls(fx).length, 0, 'no verdict → no merge, even at trust 2');
  const state = ghState(fx);
  assert(labels(state, 114).includes('verity:awaiting-approval'), 'gated for a human (on the PR)');
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate.includes('not approve'), 'gate reason explains the missing verdict');
});

test('e2e: review-approve at trust 2 merges only when checks are green', () => {
  const green = reviewFixture({}, `${POLICY_SUPERVISED}review:\n  trust: 2\n`);
  const g = runWorker(green);
  assertEqual(g.code, 0, `trust 2 green run exits 0 (stderr: ${g.stderr})`);
  assertEqual(
    JSON.stringify(mergeCalls(green)),
    JSON.stringify([['pr', 'merge', '114', '--squash']]),
    'green checks → squash merge',
  );

  const red = reviewFixture({ checksPass: false }, `${POLICY_SUPERVISED}review:\n  trust: 2\n`);
  const r = runWorker(red);
  assertEqual(r.code, 0, 'trust 2 red run gates, exit 0');
  assertEqual(mergeCalls(red).length, 0, 'red checks → no merge');
  assert(
    labels(ghState(red), 114).includes('verity:awaiting-approval'),
    'red checks gate for a human (on the PR)',
  );
});

// --- CLI surface -------------------------------------------------------------------

test('cli: --watch is politely rejected with exit 30 not-implemented', () => {
  const fx = fixture({ policy: null });
  const { code, stderr } = runWorker(fx, { args: ['--repo', 'octo/fixture', '--watch'] });
  assertEqual(code, 30);
  assert(stderr.includes('verity-worker: 30 not-implemented:'), 'slugged stderr line');
  assert(stderr.includes('T17'), 'points at the future task');
});

test('cli: missing/malformed --repo and missing --once are usage errors, exit 30', () => {
  const fx = fixture({ policy: null });
  for (const args of [['--once'], ['--repo', 'not-a-repo', '--once'], ['--repo', 'octo/fixture']]) {
    const { code, stderr } = runWorker(fx, { args });
    assertEqual(code, 30, `args ${args.join(' ')} exit 30`);
    assert(stderr.includes('verity-worker: 30 usage:'), 'usage slug');
    assert(stderr.includes(worker.USAGE), 'prints usage');
  }
});

test('cli: invalid autonomy.yml is a startup failure → exit 30 bad-policy', () => {
  const fx = fixture({ policy: 'mode: sideways\n' });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30);
  assertErrorLine(stderr, 30, 'bad-policy');
});

// --- unit: §7 formatting, limits, exit codes ----------------------------------------

test('formatRunSummary: gated — byte-exact §7 template incl. approve line', () => {
  const body = worker.formatRunSummary({
    runId: 'run-x',
    outcome: 'gated',
    roles: ['plan', 'build', 'test'],
    result: 'PR #114 opened, gated at review:merge',
    tokens: { in: 412034, out: 38112 },
    est_usd: 1.87,
    wall_secs: 702,
  });
  assertEqual(
    body,
    '🤖 **verity-worker** `run-x` — ⏸️ gated\n' +
      'roles: plan → build → test\n' +
      'result: PR #114 opened, gated at review:merge\n' +
      'tokens: 412k in / 38k out · est $1.87 · wall 11m42s\n' +
      'approve: apply label `verity:approved` or comment `/verity approve`',
  );
});

test('formatRunSummary: success — no approve line; null est_usd renders as $?', () => {
  const body = worker.formatRunSummary({
    runId: 'run-y',
    outcome: 'success',
    roles: [],
    result: 'all stages merged',
    tokens: { in: 0, out: 0 },
    est_usd: null,
    wall_secs: 3,
  });
  assertEqual(
    body,
    '🤖 **verity-worker** `run-y` — ✅ success\n' +
      'roles: (none)\n' +
      'result: all stages merged\n' +
      'tokens: 0k in / 0k out · est $? · wall 0m3s',
  );
});

test('checkLimits: each breaker trips independently, in §4.4 order', () => {
  const limits = { max_chained_roles: 2, max_tokens_per_run: 100, max_wall_clock_min: 1 };
  const ok = { chained: 0, tokens: 0 };
  assertEqual(worker.checkLimits(ok, limits, 0), null);
  assert(worker.checkLimits({ chained: 2, tokens: 0 }, limits, 0).includes('max_chained_roles'));
  assert(worker.checkLimits({ chained: 0, tokens: 100 }, limits, 0).includes('max_tokens_per_run'));
  assert(worker.checkLimits(ok, limits, 60_000).includes('max_wall_clock_min'));
});

test('EXIT_CODES: success/gated/limit → 0, failed* → 20, infra → 30', () => {
  assertEqual(worker.EXIT_CODES.success, 0);
  assertEqual(worker.EXIT_CODES.gated, 0);
  assertEqual(worker.EXIT_CODES.limit_hit, 0);
  assertEqual(worker.EXIT_CODES.failed, 20);
  assertEqual(worker.EXIT_CODES.failed_once, 20);
  assertEqual(worker.EXIT_CODES.infra, 30);
});

test('gateNameFor: resolves the policy gate for a role, falls back to the role', () => {
  const policy = { gates: ['review:merge', 'ship:prod', 'golive'] };
  assertEqual(worker.gateNameFor('review', policy), 'review:merge');
  assertEqual(worker.gateNameFor('ship', policy), 'ship:prod');
  assertEqual(worker.gateNameFor('golive', policy), 'golive');
  assertEqual(worker.gateNameFor('build', policy), 'build');
});

// --- T11: usage ledger wiring + §4.1 daily-limit startup check ---------------------

const USAGE_HEADER =
  'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role';
// Pre-stage-3 header — seeded fixtures use it to prove old ledgers keep working.
const LEGACY_USAGE_HEADER =
  'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome';

function readUsageCsv(fx) {
  const file = path.join(fx.dir, '.verity', 'usage.csv');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : null;
}

function seedUsageCsv(fx, rows) {
  fs.mkdirSync(path.join(fx.dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(fx.dir, '.verity', 'usage.csv'),
    `${[LEGACY_USAGE_HEADER, ...rows].join('\n')}\n`,
  );
}

test('e2e: SUMMARIZE appends exactly one §3.4 usage.csv row for a zero-role run', () => {
  const fx = fixture({
    issues: [stageIssue({ labels: ['verity:ready', 'verity:awaiting-approval'] })],
    stages: [{ title: 'Core' }],
  });
  const { code } = runWorker(fx); // gated immediately — no roles, est_usd null
  assertEqual(code, 0);
  const lines = readUsageCsv(fx);
  assert(lines !== null, '.verity/usage.csv was created');
  assertEqual(lines[0], USAGE_HEADER, 'header row required, exact §3.4 columns');
  assertEqual(lines.length, 2, 'exactly one data row for the run');
  const cells = lines[1].split(',');
  assertEqual(cells.length, 11, '11 columns');
  assert(!Number.isNaN(Date.parse(cells[0])), 'timestamp parses');
  assert(/^run-/.test(cells[1]), 'run_id');
  assertEqual(cells[2], 'octo/fixture', 'repo');
  assertEqual(cells[3], '', 'no roles ran');
  assertEqual(cells[6], '', 'null est_usd → empty cell');
  assertEqual(cells[8], 'gated', 'outcome');
  assertEqual(cells[9], '0', 'no invocations → zero tool_calls');
  assertEqual(cells[10], '', 'fallback row is unattributed (no role)');
});

test('e2e: a run over N roles appends N usage.csv rows sharing ONE run_id (stage 3)', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    queue: [
      {
        final: marker('success', { artifacts: { issues: [31] } }),
        toolUses: 4,
        addIssues: [
          { number: 31, title: '[stage 1] Core', state: 'OPEN', labels: [], assignees: [] },
        ],
      },
      {
        final: marker('success', { artifacts: { pr: 114 } }),
        toolUses: 31,
        addPrs: [
          {
            number: 114,
            title: '[stage 1] Core',
            state: 'OPEN',
            headRefName: 'feat/stage-1-core',
            labels: [],
            statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          },
        ],
      },
      { final: marker('gated', { gate: 'review:merge' }), toolUses: 7 },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `gated run exits 0 (stderr: ${stderr})`);
  const lines = readUsageCsv(fx);
  assertEqual(lines[0], USAGE_HEADER, 'stage-3 header on a fresh ledger');
  assertEqual(lines.length, 4, 'header + one row per role invocation');
  const rows = lines.slice(1).map((l) => l.split(','));
  assertEqual(new Set(rows.map((c) => c[1])).size, 1, 'all three rows share the run_id');
  assertEqual(
    rows.map((c) => c[10]).join('|'),
    'plan|build|review',
    'each row is attributed to its role, in invocation order',
  );
  assertEqual(rows.map((c) => c[9]).join('|'), '4|31|7', 'per-role tool_calls from the transcript');
  assertEqual(
    rows.map((c) => c[8]).join('|'),
    'success|success|gated',
    'each row carries ITS invocation outcome',
  );
  for (const cells of rows) {
    assertEqual(cells[4], '412034', 'per-invocation tokens_in (input+cache from the stub)');
    assertEqual(cells[5], '38112', 'per-invocation tokens_out');
    assertEqual(cells[6], '1.87', 'per-invocation est_usd');
  }
});

test('e2e: usage commit failure (fixture is not a git repo) NEVER fails the run', () => {
  // commit_usage defaults to true and /tmp fixtures are not git repos, so every
  // worker e2e run above already exercises a failing commit; this pins it down.
  const fx = fixture({
    issues: [stageIssue({ labels: ['verity:ready', 'verity:awaiting-approval'] })],
    stages: [{ title: 'Core' }],
  });
  const { code } = runWorker(fx);
  assertEqual(code, 0, 'run outcome unchanged despite the failed commit');
  assertEqual(readUsageCsv(fx).length, 2, 'the row was still appended');
});

test('e2e: today’s est_usd >= max_usd_per_day → startup exit 30 daily-limit, before scanning', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_usd_per_day: 5\n`,
  });
  seedUsageCsv(fx, [
    `${new Date().toISOString()},run-prev,octo/fixture,plan,100,10,6.00,60,success`,
  ]);
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30, 'daily budget trip exits 30');
  assertErrorLine(stderr, 30, 'daily-limit');
  assert(stderr.includes('max_usd_per_day 5'), 'message names the limit');
  assert(!fs.existsSync(fx.callsFile), 'fails BEFORE any gh call (no scan, no lock)');
  assertEqual(readUsageCsv(fx).length, 2, 'no new usage row for a refused start');
});

test('e2e: today’s runs >= max_runs_per_day → startup exit 30 daily-limit', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_runs_per_day: 1\n`,
  });
  seedUsageCsv(fx, [
    `${new Date().toISOString()},run-prev,octo/fixture,plan,100,10,0.10,60,success`,
  ]);
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30);
  assertErrorLine(stderr, 30, 'daily-limit');
  assert(stderr.includes('max_runs_per_day 1'), 'message names the run cap');
});

test('e2e: yesterday’s usage does NOT trip the daily limits (UTC day window)', () => {
  const fx = fixture({
    issues: [stageIssue({ labels: ['verity:ready', 'verity:awaiting-approval'] })],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_usd_per_day: 5\n  max_runs_per_day: 1\n`,
  });
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  seedUsageCsv(fx, [`${yesterday},run-prev,octo/fixture,plan,100,10,6.00,60,success`]);
  const { code } = runWorker(fx);
  assertEqual(code, 0, 'limits reset at UTC midnight');
  assertEqual(readUsageCsv(fx).length, 3, 'the new run appended its row');
});

// --- T12: §4.1 startup checks (auth, bot identity, circuit breaker) ----------

// §8.2: every nonzero exit prints EXACTLY one machine-parsable stderr line,
// `verity-worker: <code> <slug>: <message>`. Startup failures emit nothing else.
function assertErrorLine(stderr, code, slug) {
  const lines = stderr.split('\n').filter((l) => l !== '');
  assertEqual(lines.length, 1, `exactly one stderr line, got:\n${stderr}`);
  assert(
    new RegExp(`^verity-worker: ${code} ${slug}: .+$`).test(lines[0]),
    `stderr matches §8.2 'verity-worker: <code> <slug>: <message>', got: ${lines[0]}`,
  );
}

function readCalls(fx) {
  return fs.existsSync(fx.callsFile)
    ? fs
        .readFileSync(fx.callsFile, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
    : [];
}

function mutatingCalls(fx) {
  return readCalls(fx).filter((c) => {
    const x = c.indexOf('-X');
    return x !== -1 && c[x + 1] !== 'GET';
  });
}

test('e2e: gh auth status failure → exit 30 gh-auth, halts before any other gh call', () => {
  const fx = fixture({ issues: [REQUEST_ISSUE], stages: [{ title: 'Core' }] });
  const { code, stderr } = runWorker(fx, { env: { STUB_AUTH_FAIL: '1' } });
  assertEqual(code, 30, 'auth failure exits 30');
  assertErrorLine(stderr, 30, 'gh-auth');
  assert(stderr.includes('gh auth status failed'), 'message names the failing check');
  const calls = readCalls(fx);
  assert(
    calls.every((c) => c[0] === 'auth' && c[1] === 'status'),
    `only 'gh auth status' was attempted (no identity/scan/lock), got: ${JSON.stringify(calls)}`,
  );
  assertEqual(comments(ghState(fx), 30).length, 0, 'no comments — startup checks are read-only');
});

test('e2e: bot login in policy humans (case-insensitive) → exit 30 bot-is-human', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    // stubbed `gh api user` login is `verity-bot`; the list entry differs in
    // case on purpose — GitHub logins are case-insensitive, so the check is too.
    policy: `${POLICY_SUPERVISED}humans: [seanerama, Verity-Bot]\n`,
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30, 'bot-in-humans exits 30');
  assertErrorLine(stderr, 30, 'bot-is-human');
  assert(stderr.includes("'verity-bot'"), 'names the bot login');
  assert(stderr.includes("'Verity-Bot'"), 'names the matching humans entry');
  assert(stderr.includes('bot account'), 'message explains the misconfiguration');
  assertEqual(mutatingCalls(fx).length, 0, 'no gh mutations — never scanned or locked');
});

test('e2e: open verity:circuit-open issue → exit 30 circuit-open naming the issue, no side effects', () => {
  const fx = fixture({
    issues: [
      REQUEST_ISSUE, // eligible work the worker must NOT touch
      {
        number: 99,
        title: 'CIRCUIT OPEN: daily budget exceeded',
        state: 'OPEN',
        labels: ['verity:circuit-open'],
        author: { login: 'seanerama' },
        createdAt: '2026-06-02T00:00:00Z',
        assignees: [],
        comments: [],
      },
    ],
    stages: [{ title: 'Core' }],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30, 'open breaker halts the worker with exit 30');
  assertErrorLine(stderr, 30, 'circuit-open');
  assert(stderr.includes('#99'), 'names the breaker issue number');
  assert(stderr.includes('verity:circuit-open'), 'names the label');
  const state = ghState(fx);
  assertEqual(comments(state, 30).length, 0, 'eligible item untouched (no scan, no lock)');
  assertEqual(comments(state, 99).length, 0, 'breaker issue untouched');
  assertEqual(mutatingCalls(fx).length, 0, 'startup checks post no labels/comments');
});

test('e2e: all §4.1 checks pass → worker proceeds to scan (idle), checks first', () => {
  const fx = fixture({}); // logged-in stub, supervised policy, no breaker, no work
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `happy path exits 0 (stderr: ${stderr})`);
  assert(out.includes('idle'), 'proceeded past the checks to an honest idle scan');
  const calls = readCalls(fx);
  assert(
    calls.some((c) => c[0] === 'auth' && c[1] === 'status'),
    'gh auth status was checked',
  );
  const circuitIdx = calls.findIndex((c) => c.includes('verity:circuit-open'));
  assertEqual(
    JSON.stringify(calls[circuitIdx]),
    JSON.stringify([
      'issue',
      'list',
      '--label',
      'verity:circuit-open',
      '--state',
      'open',
      '--json',
      'number',
    ]),
    'exact §4.1 circuit-breaker query (open issues with the label)',
  );
  const scanIdx = calls.findIndex((c) => c.includes('verity:approved'));
  assert(scanIdx > circuitIdx, 'startup checks completed BEFORE the scanner ran');
});

// --- stage 9: worker provider selection (ADR-0005/0007/0008/0009) -------------

const POLICY_CODEX = ['mode: supervised', 'agent:', '  provider: codex', ''].join('\n');

// The PR fixture the codex pipeline test's build step opens (green checks).
const CODEX_PR = {
  number: 114,
  title: '[stage 1] Core',
  state: 'OPEN',
  headRefName: 'feat/stage-1-core',
  labels: [],
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
};

// Pipeline test (spec: the stage's exit proof) — one supervised trust-0 worker
// run in a throwaway repo under `agent.provider: codex`: a full plan → build →
// review chain (the worker's supervised chain — review is where the trust-0
// gate lives) with every gate observed and no merge, mirroring the claude
// golden path byte-for-byte on the gate side. unknown_cost_behavior is
// explicitly loosened to token limits so the chain can run; the default-gate
// behavior has its own test below.
test('pipeline: supervised trust-0 codex run — plan → build → gated at review, gates observed', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_CODEX}limits:\n  unknown_cost_behavior: allow_with_token_limit\nnotify:\n  mention: [seanerama]\n`,
    queue: [
      {
        final: marker('success', { artifacts: { issues: [31] } }),
        addIssues: [
          { number: 31, title: '[stage 1] Core', state: 'OPEN', labels: [], assignees: [] },
        ],
      },
      { final: marker('success', { artifacts: { pr: 114 } }), addPrs: [CODEX_PR] },
      { final: marker('gated', { gate: 'review:merge' }) },
    ],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0, `gated codex run exits 0 (stderr: ${stderr})`);

  const state = ghState(fx);
  const summary = comments(state, 30).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'run summary posted');
  assert(summary.includes('— ⏸️ gated'), 'run gated, never autonomous past the gate');
  assert(summary.includes('roles: plan → build → review'), 'the full chain ran');
  assert(summary.includes('est $?'), 'unknown codex cost renders as $?, never $0');
  assert(labels(state, 114).includes('verity:awaiting-approval'), 'gate observed on the PR');
  assertEqual(mergeCalls(fx).length, 0, 'trust 0 never merges');

  // Provider propagation: every chained dispatch ran through the CODEX driver
  // with the role policy's sandbox — one immutable config for the whole run.
  const argvs = codexArgvs(fx);
  assertEqual(argvs.length, 3, 'three codex exec invocations, one per chained role');
  for (const argv of argvs) {
    assertEqual(argv[0], 'exec', 'codex exec argv');
    assertEqual(argv[argv.indexOf('--sandbox') + 1], 'workspace-write', 'role-policy sandbox');
    assertEqual(argv[argv.length - 1], '-', 'prompt over stdin');
  }

  // Ledger: codex tokens are real, codex cost is UNKNOWN (empty cell, not 0).
  const lines = readUsageCsv(fx);
  assertEqual(lines.length, 4, 'one usage row per invocation');
  for (const cells of lines.slice(1).map((l) => l.split(','))) {
    assertEqual(cells[4], '400000', 'codex tokens_in recorded');
    assertEqual(cells[5], '38112', 'codex tokens_out recorded');
    assertEqual(cells[6], '', 'unknown cost is an empty cell — never 0 (ADR-0008)');
  }
});

test('e2e: default unknown_cost_behavior (gate) pauses a codex run at the unknown-cost gate', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_CODEX}notify:\n  mention: [seanerama]\n`, // no limits override → gate
    queue: [
      {
        final: marker('success', { artifacts: { issues: [31] } }),
        addIssues: [
          { number: 31, title: '[stage 1] Core', state: 'OPEN', labels: [], assignees: [] },
        ],
      },
    ],
  });
  const { code } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0, 'gated exits 0');
  assertEqual(codexArgvs(fx).length, 1, 'ONE role ran — the gate stops the chain');
  const state = ghState(fx);
  const summary = comments(state, 30).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ⏸️ gated'), 'outcome gated');
  assert(summary.includes(worker.UNKNOWN_COST_GATE), 'gate name is unknown-cost');
  assert(labels(state, 30).includes('verity:awaiting-approval'), 'gate label applied');
  const gate = comments(state, 30).find((b) => b.startsWith('⏸️'));
  assert(gate.includes('unknown-cost'), 'gate comment names the gate');
  assert(gate.includes('est_usd null'), 'explains WHY (cost unknown)');
  assert(gate.includes('@seanerama'), 'mentions notify.mention');
});

test('e2e: unknown_cost_behavior fail stops the run as a failure (exit 20), no needs-human', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_CODEX}limits:\n  unknown_cost_behavior: fail\n`,
    queue: [{ final: marker('success') }],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 20, 'failed exits 20');
  assert(stderr.includes('verity-worker: 20 role-failed:'), '§8.2 stderr line');
  const state = ghState(fx);
  const summary = comments(state, 30).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— ❌ failed'), 'outcome failed');
  assert(summary.includes('unknown cost'), 'names the cause');
  assert(summary.includes("'fail'"), 'names the configured behavior');
  assert(!labels(state, 30).includes('verity:needs-human'), 'a config stop is not a strike label');
});

test('e2e: allow_with_token_limit proceeds — codex tokens count toward max_tokens_per_run', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_CODEX}limits:\n  unknown_cost_behavior: allow_with_token_limit\n  max_tokens_per_run: 1000\n`,
    queue: [{ final: marker('success') }],
  });
  const { code } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0, 'limit_hit exits 0');
  const summary = comments(ghState(fx), 30).find((b) => b.startsWith('🤖'));
  assert(summary.includes('— 🛑 limit_hit'), 'codex tokens tripped the run breaker');
  assert(summary.includes('max_tokens_per_run (1000)'), 'names the tripped limit');
  assert(summary.includes('roles: plan'), 'one role ran before the breaker');
});

test('e2e: a policy without an agent block stays Claude-backed — codex never invoked', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_SUPERVISED}limits:\n  max_chained_roles: 1\n`,
    queue: [{ final: marker('success') }],
  });
  // The codex stub is AVAILABLE — selection, not availability, must decide.
  const { code } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0);
  assertEqual(codexArgvs(fx).length, 0, 'codex never invoked without agent.provider: codex');
  assertEqual(
    JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length,
    0,
    'the CLAUDE stub consumed the queue',
  );
});

test('e2e: unknown agent.provider fails at startup (bad-policy) BEFORE any gh call', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: 'mode: supervised\nagent:\n  provider: gemini\n',
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 30, 'invalid provider exits 30');
  assertErrorLine(stderr, 30, 'bad-policy');
  assert(stderr.includes('agent.provider'), 'names the offending key');
  assert(!fs.existsSync(fx.callsFile), 'no gh call — refused before ANY mutation or scan');
});

test('e2e: policy sandbox override cannot exceed the role projection — refused, exit 30', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: 'mode: supervised\nagent:\n  provider: codex\n  sandbox: workspace-write\n',
  });
  // Fixture-local plan role whose projection is READ-ONLY: the policy's
  // workspace-write override would widen it → dispatch refuses (bad-override).
  const roleDir = path.join(fx.dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'plan.md'), '---\nname: verity:plan\n---\nPlan $ARGUMENTS\n');
  fs.writeFileSync(path.join(roleDir, 'plan.tools.json'), JSON.stringify(['Read']));
  fs.writeFileSync(
    path.join(roleDir, 'plan.permissions.json'),
    JSON.stringify({
      schema_version: 1,
      capabilities: { read_repository: true },
      codex: { sandbox: 'read-only', approval: 'never' },
    }),
  );
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 30, 'widening override is an infra refusal');
  assert(stderr.includes('verity-worker: 30 infra-error:'), '§8.2 stderr line');
  assert(stderr.includes('never widen'), 'names the narrowing rule');
  assertEqual(codexArgvs(fx).length, 0, 'agent never invoked with widened permissions');
});

test('e2e: policy sandbox override MAY narrow — read-only reaches the codex argv', () => {
  const fx = fixture({
    issues: [REQUEST_ISSUE],
    stages: [{ title: 'Core' }],
    policy: [
      'mode: supervised',
      'agent:',
      '  provider: codex',
      '  sandbox: read-only',
      'limits:',
      '  unknown_cost_behavior: allow_with_token_limit',
      '  max_chained_roles: 1',
      '',
    ].join('\n'),
    queue: [{ final: marker('success') }],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0, `narrowed run exits 0 (stderr: ${stderr})`);
  const argvs = codexArgvs(fx);
  assertEqual(argvs.length, 1, 'the role ran');
  assertEqual(
    argvs[0][argvs[0].indexOf('--sandbox') + 1],
    'read-only',
    'the NARROWED sandbox reached the provider (plan role ships workspace-write)',
  );
});

// One immutable effective config per run (in-process, agentExec/next patched):
// provider/model/sandbox/approval reach EVERY chained dispatch and the
// remaining wall-clock deadline shrinks monotonically across the chain.
test('runLoop: one immutable agent config per run; --timeout-secs shrinks across roles', () => {
  const agentExecMod = require('../verity/bin/lib/agent-exec.cjs');
  const nextMod = require('../verity/bin/lib/next.cjs');
  const autonomyMod = require('../verity/bin/lib/autonomy.cjs');
  const policy = JSON.parse(JSON.stringify(autonomyMod.DEFAULTS));
  policy.mode = 'supervised';
  policy.agent = {
    ...policy.agent,
    provider: 'codex',
    model: 'gpt-5-codex',
    sandbox: 'read-only',
    approval: 'never',
  };
  policy.limits.unknown_cost_behavior = 'allow_with_token_limit';
  const calls = [];
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const origDispatch = agentExecMod.dispatch;
  const origNext = nextMod.dispatch;
  agentExecMod.dispatch = (args, flags) => {
    calls.push({ role: args[0], flags: { ...flags } });
    sleep(1100); // > 1s so the whole-second deadline strictly decreases
    return {
      schema: 1,
      role: args[0],
      outcome: 'success',
      tokens: { in: 10, out: 5 },
      est_usd: null,
      wall_secs: 1,
      tool_calls: 0,
      artifacts: {},
      error: null,
    };
  };
  let nextCalls = 0;
  nextMod.dispatch = () => {
    nextCalls += 1;
    return nextCalls === 1
      ? {
          schema: 1,
          action: 'work',
          role: 'build',
          args: ['31'],
          gate: null,
          target: { kind: 'issue', number: 31 },
          reason: 'stage ready',
        }
      : {
          schema: 1,
          action: 'idle',
          role: null,
          args: [],
          gate: null,
          target: null,
          reason: 'no work',
        };
  };
  try {
    const summary = worker.runLoop(
      { repo: 'o/r', cwd: '/tmp', stdout() {}, stderr() {} },
      { policy, runId: 'run-immutable', item: { kind: 'issue', number: 30, tier: 'P4' } },
    );
    assertEqual(summary.outcome, 'success', 'chained to idle');
    assertEqual(calls.length, 2, 'two chained dispatches (P4 plan, then build)');
    for (const c of calls) {
      assertEqual(c.flags.agent, 'codex', `${c.role}: provider propagated`);
      assertEqual(c.flags.model, 'gpt-5-codex', `${c.role}: model propagated`);
      assertEqual(c.flags.sandbox, 'read-only', `${c.role}: sandbox override propagated`);
      assertEqual(c.flags.approval, 'never', `${c.role}: approval propagated`);
      assertEqual(c.flags['run-id'], 'run-immutable', `${c.role}: one transcript destination`);
      assert(Number.isInteger(c.flags['timeout-secs']), `${c.role}: integer deadline`);
    }
    assert(
      calls[0].flags['timeout-secs'] <= policy.limits.max_wall_clock_min * 60,
      'first deadline is at most the full budget',
    );
    assert(
      calls[1].flags['timeout-secs'] < calls[0].flags['timeout-secs'],
      `deadline shrinks monotonically (${calls[0].flags['timeout-secs']} → ${calls[1].flags['timeout-secs']})`,
    );
  } finally {
    agentExecMod.dispatch = origDispatch;
    nextMod.dispatch = origNext;
  }
});

test('runLoop: a claude-default policy dispatches agent claude with NO codex knobs', () => {
  const agentExecMod = require('../verity/bin/lib/agent-exec.cjs');
  const nextMod = require('../verity/bin/lib/next.cjs');
  const autonomyMod = require('../verity/bin/lib/autonomy.cjs');
  const policy = JSON.parse(JSON.stringify(autonomyMod.DEFAULTS));
  policy.mode = 'supervised';
  const calls = [];
  const origDispatch = agentExecMod.dispatch;
  const origNext = nextMod.dispatch;
  agentExecMod.dispatch = (args, flags) => {
    calls.push({ role: args[0], flags: { ...flags } });
    return {
      schema: 1,
      role: args[0],
      outcome: 'gated',
      tokens: { in: 1, out: 1 },
      est_usd: 0.01,
      wall_secs: 1,
      tool_calls: 0,
      artifacts: {},
      error: null,
    };
  };
  nextMod.dispatch = () => ({
    schema: 1,
    action: 'work',
    role: 'build',
    args: ['31'],
    gate: null,
    target: { kind: 'stage', number: null }, // bare stage: gatePause stays gh-free
    reason: 'stage ready',
  });
  try {
    const summary = worker.runLoop(
      { repo: 'o/r', cwd: '/tmp', stdout() {}, stderr() {} },
      { policy, runId: 'run-claude', item: { kind: 'stage', number: null, tier: 'P5' } },
    );
    assertEqual(summary.outcome, 'gated');
    assertEqual(calls.length, 1);
    assertEqual(calls[0].flags.agent, 'claude', 'legacy default provider');
    assert(!('model' in calls[0].flags), 'null model is omitted, not passed');
    assert(!('sandbox' in calls[0].flags), 'null sandbox is omitted');
    assert(!('approval' in calls[0].flags), 'null approval is omitted');
    assert(Number.isInteger(calls[0].flags['timeout-secs']), 'deadline still enforced (ADR-0008)');
  } finally {
    agentExecMod.dispatch = origDispatch;
    nextMod.dispatch = origNext;
  }
});

test('remainingTimeoutSecs: monotonically non-increasing, floored at 1', () => {
  const limits = { max_wall_clock_min: 45 };
  assertEqual(worker.remainingTimeoutSecs(limits, 0), 2700, 'full budget at t0');
  assertEqual(worker.remainingTimeoutSecs(limits, 60_000), 2640, 'one minute gone');
  let prev = Number.POSITIVE_INFINITY;
  for (const elapsed of [0, 1000, 2000, 30_000, 2_699_000, 2_700_000, 9_999_999]) {
    const secs = worker.remainingTimeoutSecs(limits, elapsed);
    assert(secs <= prev, `never grows (elapsed ${elapsed})`);
    assert(secs >= 1, 'never reaches zero — the limit check trips first');
    prev = secs;
  }
  assertEqual(worker.remainingTimeoutSecs(limits, 2_700_000), 1, 'exhausted budget floors at 1');
  // Regression (the 2700 → 2701 CI flake): a NEGATIVE elapsed — a backwards
  // wall-clock step reaching this function — must clamp to the full budget,
  // never add to it. The loop itself now measures on a monotonic clock; this
  // pins the belt-and-braces clamp.
  for (const elapsed of [-1, -999, -1000, -60_000]) {
    assertEqual(
      worker.remainingTimeoutSecs(limits, elapsed),
      2700,
      `negative elapsed (${elapsed}ms) never exceeds the full budget`,
    );
  }
});

test('resolveEffectiveAgent: frozen — the run config cannot drift mid-run', () => {
  const cfg = worker.resolveEffectiveAgent({
    agent: { provider: 'codex', model: null, sandbox: null, approval: null },
  });
  assert(Object.isFrozen(cfg), 'config is immutable');
  assertEqual(cfg.provider, 'codex');
  const legacy = worker.resolveEffectiveAgent({}); // pre-stage-9 policy object
  assertEqual(legacy.provider, 'claude', 'missing agent block defaults to claude');
});

test('recordUsage: ledger errors are logged, never thrown (run outcome unchanged)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-worker-usage-'));
  fs.writeFileSync(path.join(dir, '.verity'), 'a FILE blocking the directory'); // mkdir will fail
  const warnings = [];
  const ctx = { cwd: dir, stderr: (l) => warnings.push(l), stdout: () => {} };
  const summary = {
    runId: 'run-z',
    repo: 'o/r',
    outcome: 'success',
    roles: [],
    tokens: { in: 0, out: 0 },
    est_usd: null,
    wall_secs: 1,
  };
  assertEqual(worker.recordUsage(ctx, { commit_usage: true }, summary), undefined);
  assert(
    warnings.some((l) => l.includes('failed to record usage')),
    'append failure logged as a warning',
  );
});
