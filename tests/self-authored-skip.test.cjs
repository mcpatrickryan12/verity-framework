// Stage 28 — the scanner must say when it skips self-authored requests
// (canary §4 re-run, defect 5, tick 10).
//
// The P4 no-self-feeding rule (`author != botLogin`) is correct and UNTOUCHED
// here — but it filtered silently: in a single-account setup (operator == bot,
// every canary so far) an open `verity:request` read as `idle — no eligible
// work` with no logged reason, and the plan role was never exercised in any
// canary. This stage adds VISIBILITY only: scan() reports the drop through a
// new opts.warn callback (the usage.cjs opts.warn precedent — default silent,
// a library never writes to a stream uninvited), the worker forwards it to
// stderr as a `verity-worker: note:` line and qualifies the idle reason so
// "no eligible work" never hides filtered work. Zero filtered items → zero
// noise, and the filter's SELECTION behavior is byte-identical
// (tests/scanner.test.cjs runs green, unmodified).
//
// E2e harness mirrors tests/needs-human-park.test.cjs (trimmed stateful gh
// stub on PATH; a JSON state file holds the repository). No network, ever.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scanner = require('../verity/bin/lib/scanner.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// ---------------------------------------------------------------------------
// (1) scan() — the drop is reported through opts.warn, unit level
// ---------------------------------------------------------------------------

// fixtures: '<kind> <label>' -> raw gh items, like tests/scanner.test.cjs.
function fakeGh(fixtures) {
  return (args) => {
    const label = args[args.indexOf('--label') + 1];
    return JSON.stringify(fixtures[`${args[0]} ${label}`] || []);
  };
}

const request = (number, login, createdAt = '2026-06-01T00:00:00Z') => ({
  number,
  title: `request ${number}`,
  createdAt,
  labels: [],
  author: { login },
});

function scanWith(fixtures, opts = {}) {
  const warns = [];
  const result = scanner.scan({
    exec: fakeGh(fixtures),
    nextDecision: () => ({ action: 'idle' }),
    warn: (msg) => warns.push(msg),
    ...opts,
  });
  return { result, warns };
}

test('REGRESSION (stage 28): P4 drops a self-authored request -> warn names the count', () => {
  const { result, warns } = scanWith(
    { 'issue verity:request': [request(40, 'verity-bot')] },
    { botLogin: 'verity-bot' },
  );
  assertEqual(result, null, 'the filter itself is untouched — the tier stays empty');
  assertEqual(warns.length, 1, 'the drop is reported exactly once, not per item');
  assert(
    warns[0].includes('skipped 1 self-authored request(s)'),
    `the note names the count, got: ${warns[0]}`,
  );
  assert(warns[0].includes('no self-feeding'), `the note names the rule, got: ${warns[0]}`);
  assert(warns[0].includes('docs/autonomy.md'), `the note points at the docs, got: ${warns[0]}`);
});

test('multiple drops are one note with the real count — and selection is unchanged', () => {
  const { result, warns } = scanWith(
    {
      'issue verity:request': [
        request(40, 'verity-bot', '2026-06-01T00:00:00Z'),
        request(41, 'Verity-Bot', '2026-06-02T00:00:00Z'), // case-insensitive, as ever
        request(42, 'human', '2026-06-03T00:00:00Z'),
      ],
    },
    { botLogin: 'verity-bot' },
  );
  assertEqual(result.tier, 'P4', 'the human request is still selected exactly as before');
  assertEqual(result.number, 42);
  assertEqual(warns.length, 1);
  assert(
    warns[0].includes('skipped 2 self-authored request(s)'),
    `both drops counted, got: ${warns[0]}`,
  );
});

test('zero filtered items -> no note (no noise on healthy repos)', () => {
  const { result, warns } = scanWith(
    { 'issue verity:request': [request(40, 'human')] },
    { botLogin: 'verity-bot' },
  );
  assertEqual(result.number, 40);
  assertEqual(warns.length, 0, 'nothing was dropped, nothing is said');
});

test('empty repository -> no note either', () => {
  const { result, warns } = scanWith({}, { botLogin: 'verity-bot' });
  assertEqual(result, null);
  assertEqual(warns.length, 0);
});

test('no botLogin -> no P4 filtering happens, so no note (behavior unchanged)', () => {
  const { result, warns } = scanWith({ 'issue verity:request': [request(40, 'verity-bot')] });
  assertEqual(result.number, 40, 'without botLogin nothing is filtered — exactly as before');
  assertEqual(warns.length, 0);
});

test('opts.warn defaults to silent — a drop without a callback never throws', () => {
  const result = scanner.scan({
    exec: fakeGh({ 'issue verity:request': [request(40, 'verity-bot')] }),
    nextDecision: () => ({ action: 'idle' }),
    botLogin: 'verity-bot',
  });
  assertEqual(result, null);
});

test('needs-human drops in P4 are NOT self-authored drops — they make no note', () => {
  const { result, warns } = scanWith(
    {
      'issue verity:request': [
        request(40, 'human', '2026-06-01T00:00:00Z'),
        {
          ...request(41, 'human', '2026-06-02T00:00:00Z'),
          labels: [{ name: 'verity:needs-human' }],
        },
      ],
    },
    { botLogin: 'verity-bot' },
  );
  assertEqual(result.number, 40);
  assertEqual(warns.length, 0, 'only the no-self-feeding filter is being made visible');
});

// ---------------------------------------------------------------------------
// (2) End-to-end: the worker tick on the canary's exact single-account shape
// ---------------------------------------------------------------------------

// Stateful gh + agent stubs — a twin of tests/needs-human-park.test.cjs's
// harness. The stub's `gh api user` login is verity-bot — the same login the
// request below is authored by, which is precisely the canary's
// single-account setup.
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
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'view') {
  const s = state();
  const pool = args[0] === 'issue' ? s.issues : s.prs;
  const it = pool.find((x) => x.number === Number(args[2]));
  out({ labels: (it.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
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
// never invoked; a consumed one proves a dispatch actually happened.
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

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

// A repository whose ONLY open item is a verity:request authored by the bot
// login itself — tick 10 of the canary re-run, byte for byte.
const botRequest = (extra = {}) => ({
  number: 4,
  title: 'Add widgets',
  state: 'OPEN',
  labels: ['verity:request'],
  author: { login: 'verity-bot' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
  ...extra,
});

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-self-authored-skip-'));
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
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), POLICY);
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
  // spawnSync, not execFileSync: the skip note lands on stderr of a run that
  // EXITS 0, and execFileSync only hands stderr back on failure.
  const r = spawnSync('node', [WORKER, '--repo', 'octo/fixture', '--once'], {
    cwd: fx.dir,
    encoding: 'utf8',
    env,
  });
  return { code: r.status, out: r.stdout || '', stderr: r.stderr || '' };
}

test('e2e REGRESSION (stage 28): a filtered-only tick says so — note on stderr, idle line qualified', () => {
  const fx = fixture({ issues: [botRequest()] });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `the tick is still an honest idle exit 0 (stderr: ${stderr})`);
  assert(
    stderr.includes('verity-worker: note: skipped 1 self-authored request(s) (no self-feeding'),
    `the skip note is on stderr, got: ${stderr}`,
  );
  assert(out.includes('verity-worker: idle'), `the tick still reads idle, got: ${out}`);
  assert(
    /idle — no eligible work — skipped 1 self-authored request\(s\)/.test(out),
    `the idle reason is QUALIFIED, never a bare "no eligible work", got: ${out}`,
  );
  const state = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  assertEqual(
    (state.issues[0].comments || []).length,
    0,
    'stdout/log only — the skipped issue gets NO GitHub comment',
  );
  assertEqual(
    JSON.stringify(state.issues[0].labels),
    JSON.stringify(['verity:request']),
    'no labels were touched either',
  );
});

test('e2e: a genuinely empty repository stays a bare idle — no note, no qualification', () => {
  const fx = fixture({ issues: [] });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `healthy idle (stderr: ${stderr})`);
  assert(out.includes('verity-worker: idle — no eligible work'), `bare idle line, got: ${out}`);
  assert(!out.includes('self-authored'), `nothing was filtered, nothing is claimed: ${out}`);
  assert(!stderr.includes('self-authored'), `no noise on stderr either: ${stderr}`);
});

test('e2e: a HUMAN-authored request is not filtered — plan runs, and no note appears', () => {
  const fx = fixture({
    issues: [botRequest({ author: { login: 'human' } })],
    queue: [{ final: marker('success') }], // the plan role for the request
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `the request run succeeds exactly as before (stderr: ${stderr})`);
  assertEqual(
    JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length,
    0,
    'the request WAS picked — plan dispatched (selection byte-identical)',
  );
  assert(!stderr.includes('self-authored'), `no false note, got: ${stderr}`);
  assert(!out.includes('self-authored'), `no false qualification, got: ${out}`);
});
