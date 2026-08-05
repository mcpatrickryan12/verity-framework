// Stage 24 (ADR-0013 — the model computes, Verity talks to GitHub): under the
// tier-1 network-disabled sandbox NO codex role could complete (canary §4
// re-run, defect 1). The review role's own `gh pr comment` died on the network
// (tick 4) and the build role's first act — an in-sandbox `verity state` read —
// refused fail-closed (tick 12, stage 20's honest behavior). Extending
// ADR-0012's division of labour one layer up:
//
//   PRE-DISPATCH: Verity gathers the GitHub facts a role's workflow needs
//   (stage status, `verity state next`, dependency/PR/CI state) OUTSIDE the
//   sandbox — from the SAME verified snapshot the dispatch decision derives
//   from, so stage 20 stays binding — and renders them into the role's prompt.
//
//   POST-DISPATCH: Verity performs the GitHub writes the role's result marker
//   DECLARES — concretely the review findings comment, via the additive,
//   default-closed `artifacts.effects.findings_comment` field. Unrecognized
//   effect requests are ignored with a logged note, never executed, never
//   fatal; every Verity-performed write carries the run id (mirroring
//   ADR-0012's attributable commits).
//
// Stub-driven like tests/worker.test.cjs (its stateful gh stub + a codex stub
// that ALSO records the prompt it was handed over stdin). No network, ever.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('../verity/bin/lib/agents/claude.cjs');
const install = require('../verity/bin/lib/install.cjs');
const nextLib = require('../verity/bin/lib/next.cjs');
const snapshotLib = require('../verity/bin/lib/agents/state-snapshot.cjs');
const stage = require('../verity/bin/lib/stage.cjs');
const worker = require('../verity/worker/index.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const ROLES_DIR = path.join(__dirname, '..', 'commands', 'verity');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// --- stateful gh stub (PATH) — the tests/worker.test.cjs stub, unchanged ------
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
if (args[0] === 'auth' && args[1] === 'status') { out('github.com: Logged in as verity-bot\\n'); process.exit(0); }
if ((args[0] === 'issue' || args[1] === 'list') && args[0] === 'issue' && args[1] === 'list') {
  const s = state();
  let items = s.issues;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const s = state();
  let items = s.prs;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  const head = flag('--head');
  if (head) items = items.filter((it) => it.headRefName === head);
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

// --- scripted codex stub (VERITY_CODEX_BIN) -----------------------------------
// The tests/worker.test.cjs codex twin, plus ONE addition this stage needs: it
// records the prompt it was handed over stdin as `<role>.prompt.txt` beside the
// run's transcripts, so a test can assert what a CONTAINED role was actually
// told (the state snapshot in, the `verity state`/`gh` instructions out).
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
const finalPath = args[args.indexOf('--output-last-message') + 1];
const logDir = path.dirname(finalPath);
const role = path.basename(finalPath).replace(/\\.final\\.json$/, '');
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.verity-stub.json'), 'utf8'));
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(logDir, role + '.prompt.txt'), prompt);
const queueFile = cfg.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
if (step.addIssues || step.addPrs) {
  const s = JSON.parse(fs.readFileSync(cfg.GH_STATE_FILE, 'utf8'));
  s.issues = s.issues.concat(step.addIssues || []);
  s.prs = s.prs.concat(step.addPrs || []);
  fs.writeFileSync(cfg.GH_STATE_FILE, JSON.stringify(s));
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

// The codex worker policy: the packaged roles declare `network: false` (which
// no exec-path mechanism enforces → acknowledged), and unknown_cost_behavior
// is loosened to token limits so the chain reaches the trust ladder at all —
// the default 'gate' pauses BEFORE the merge decision (its own tests live in
// tests/worker.test.cjs).
function codexPolicy(extra = []) {
  return [
    'mode: supervised',
    'agent:',
    '  provider: codex',
    '  acknowledged_enforcement_gaps: [network]',
    'limits:',
    '  unknown_cost_behavior: allow_with_token_limit',
    ...extra,
    'notify:',
    '  mention: [seanerama]',
    '',
  ].join('\n');
}

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-ghfx-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const codexAgent = path.join(dir, 'codex-agent-stub');
  fs.writeFileSync(codexAgent, CODEX_AGENT_STUB);
  fs.chmodSync(codexAgent, 0o755);
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: opts.issues || [], prs: opts.prs || [] }));
  const queueFile = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(queueFile, JSON.stringify(opts.queue || []));
  const callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    path.join(dir, '.verity-stub.json'),
    JSON.stringify({ AGENT_QUEUE: queueFile, GH_STATE_FILE: stateFile }),
  );
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || codexPolicy());
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  // A REAL repository + bare origin for dispatches that hold git_write (build):
  // Verity performs their git, and a grant it cannot provide refuses the run.
  if (opts.git === true) {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      [
        'home/',
        'origin.git/',
        'stub-bin/',
        'codex-agent-stub',
        'gh-state.json',
        'agent-queue.json',
        'calls.jsonl',
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
  return { dir, home, bin, codexAgent, stateFile, queueFile, callsFile };
}

function runWorker(fx, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    CALLS_FILE: fx.callsFile,
    VERITY_CODEX_BIN: fx.codexAgent,
    VERITY_AGENT_BIN: '',
    ...(extra.env || {}),
  };
  // spawnSync (not execFileSync): stderr must be readable on SUCCESS too — the
  // ignored-effect note is a stderr line on a run that exits 0.
  const res = spawnSync('node', [WORKER, '--repo', 'octo/fixture', '--once'], {
    cwd: fx.dir,
    encoding: 'utf8',
    env,
  });
  return { code: res.status, out: res.stdout || '', stderr: res.stderr || '' };
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

function readCalls(fx) {
  return fs.existsSync(fx.callsFile)
    ? fs
        .readFileSync(fx.callsFile, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
    : [];
}

function mergeCalls(fx) {
  return readCalls(fx).filter((c) => c[0] === 'pr' && c[1] === 'merge');
}

// The recorded prompt / transcript for a role, from any run under $HOME.
function roleFile(fx, name) {
  const logs = path.join(fx.home, '.verity', 'logs');
  if (!fs.existsSync(logs)) {
    return null;
  }
  for (const run of fs.readdirSync(logs)) {
    const f = path.join(logs, run, name);
    if (fs.existsSync(f)) {
      return fs.readFileSync(f, 'utf8');
    }
  }
  return null;
}

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

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

// A stage-1 PR that is open, CI-green, and low-risk for the trust-1 classifier.
function greenPr(extra = {}) {
  return {
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
    comments: [],
    ...extra,
  };
}

const FINDINGS = '### Review findings\n- contracts intact\n- tests are real';

// ---------------------------------------------------------------------------
// (1) REGRESSION (canary §4 re-run, defect 1): a contained review's declared
// findings + verdict must END UP ON GITHUB — findings posted BY VERITY,
// verdict consumed by the trust ladder. Before this stage the role's own
// `gh pr comment` died on the sandbox network denial and the run was a strike.
// ---------------------------------------------------------------------------

test('REGRESSION: contained review declares findings + verdict → Verity posts the findings comment and the trust ladder consumes the verdict', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [greenPr()],
    policy: codexPolicy(['review:', '  trust: 1']),
    queue: [
      {
        final: marker('success', {
          artifacts: { pr: 114, verdict: 'approve', effects: { findings_comment: FINDINGS } },
        }),
      },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `run completes (stderr: ${stderr})`);

  // The verdict half (already worked before this stage): trust 1 + low-risk
  // approve → deterministic merge by the worker, never by the role.
  assertEqual(
    JSON.stringify(mergeCalls(fx)),
    JSON.stringify([['pr', 'merge', '114', '--squash']]),
    'the approve verdict was consumed by the trust ladder',
  );

  // The findings half (THE regression): the body the role declared is ON the
  // PR, posted by Verity — the role never ran `gh`.
  const state = ghState(fx);
  const findings = comments(state, 114).find((b) => b.includes('contracts intact'));
  assert(
    findings !== undefined,
    `the declared findings body was posted on the PR by Verity (comments: ${JSON.stringify(comments(state, 114))})`,
  );
  assert(findings.startsWith('🔎 **verity-worker**'), 'posted through the worker voice');
  assert(findings.includes('review findings'), 'labeled as the review role findings');
  assert(findings.includes('ADR-0013'), 'names the decision that authorizes the write');
  assert(findings.includes('- tests are real'), 'the full multi-line body traveled');
});

test('attribution: the Verity-posted findings comment carries the SAME run id as the run summary', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [greenPr()],
    policy: codexPolicy(['review:', '  trust: 1']),
    queue: [
      {
        final: marker('success', {
          artifacts: { pr: 114, verdict: 'approve', effects: { findings_comment: FINDINGS } },
        }),
      },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `run completes (stderr: ${stderr})`);
  const state = ghState(fx);
  const findings = comments(state, 114).find((b) => b.includes('contracts intact'));
  assert(findings !== undefined, 'findings posted');
  const runId = (findings.match(/`(run-[^`]+)`/) || [])[1];
  assert(runId !== undefined, `the findings comment names a run id (${findings})`);
  const summary = comments(state, 41).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'run summary posted');
  assert(summary.includes(`\`${runId}\``), 'summary and findings attribute the same run');
});

// ---------------------------------------------------------------------------
// (2) Unrecognized effect requests: ignored with a logged note — never
// executed, never guessed at, never fatal (ADR-0013 corollary).
// ---------------------------------------------------------------------------

test('an unrecognized effect request is ignored with a logged note — recognized ones still perform, run unharmed', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [greenPr()],
    policy: codexPolicy(['review:', '  trust: 0']),
    queue: [
      {
        final: marker('success', {
          artifacts: {
            pr: 114,
            verdict: 'approve',
            effects: { close_issue: 41, findings_comment: FINDINGS },
          },
        }),
      },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `never fatal (stderr: ${stderr})`);
  assert(
    stderr.includes("unrecognized GitHub effect 'close_issue'"),
    `the ignored request is a logged note, not silence (stderr: ${stderr})`,
  );
  const state = ghState(fx);
  assertEqual(itemIn(state, 41).state, 'OPEN', 'the unrecognized request was NOT executed');
  assert(
    comments(state, 114).some((b) => b.includes('contracts intact')),
    'the recognized findings effect still performed',
  );
  assertEqual(mergeCalls(fx).length, 0, 'trust 0 still never merges');
});

test('performResultEffects units: default-closed, malformed blocks and missing PRs are notes, never throws', () => {
  const notes = [];
  const ctx = { repo: 'o/r', cwd: '/nowhere', stderr: (l) => notes.push(l), stdout() {} };
  const res = (artifacts) => ({ outcome: 'success', artifacts });

  // Absent → nothing declared, nothing performed, nothing logged.
  worker.performResultEffects(ctx, { runId: 'run-x', role: 'review', res: res({}), pr: 114 });
  worker.performResultEffects(ctx, {
    runId: 'run-x',
    role: 'review',
    res: res(undefined),
    pr: 114,
  });
  assertEqual(notes.length, 0, 'absence is the default-closed no-op');

  // Malformed effects block → one note, no throw.
  worker.performResultEffects(ctx, {
    runId: 'run-x',
    role: 'review',
    res: res({ effects: 'post my findings please' }),
    pr: 114,
  });
  assertEqual(notes.length, 1);
  assert(notes[0].includes('malformed'), `malformed block is named: ${notes[0]}`);

  // findings_comment with no PR anywhere → a note, not a guess at a target.
  worker.performResultEffects(ctx, {
    runId: 'run-x',
    role: 'review',
    res: res({ effects: { findings_comment: 'body' } }),
    pr: null,
  });
  assertEqual(notes.length, 2);
  assert(notes[1].includes('no PR'), `missing target is named: ${notes[1]}`);

  // Empty body → a note, nothing posted.
  worker.performResultEffects(ctx, {
    runId: 'run-x',
    role: 'review',
    res: res({ effects: { findings_comment: '   ' } }),
    pr: 114,
  });
  assertEqual(notes.length, 3);
  assert(notes[2].includes('no body'), `empty body is named: ${notes[2]}`);
});

// ---------------------------------------------------------------------------
// (3) Pre-dispatch state snapshot: a contained build receives the GitHub facts
// in its rendered input and is told NOT to run `verity state`/`gh` itself.
// ---------------------------------------------------------------------------

test('contained build receives the state snapshot in its rendered input; transcript shows no verity state/gh calls', () => {
  const fx = fixture({
    git: true,
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    queue: [
      { final: marker('success', { artifacts: { pr: 114 } }), addPrs: [greenPr()] },
      { final: marker('gated', { gate: 'review:merge' }) },
    ],
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `chain runs to the review gate (stderr: ${stderr})`);

  const prompt = roleFile(fx, 'build.prompt.txt');
  assert(prompt !== null, 'the build dispatch prompt was recorded');
  // The countermand, in the stage-17 voice: GitHub I/O is Verity's job.
  assert(
    prompt.includes("GitHub is Verity's job on this run"),
    'the prompt tells the role GitHub is not its job',
  );
  assert(prompt.includes('ADR-0013'), 'and names the decision');
  // The facts its workflow steps need, gathered OUTSIDE the sandbox.
  assert(prompt.includes('<github-state-snapshot>'), 'the snapshot block is rendered in');
  assert(prompt.includes('`verity state next`'), 'the snapshot answers the state-next read');
  assert(/stage 1 \(Core\)/.test(prompt), 'the snapshot names the dispatched stage');
  assert(prompt.includes('status: planned'), "and the stage's GitHub-derived status");

  // The role's own transcript performed no GitHub read: no `verity state`, no
  // `gh` invocation anywhere in the run it produced.
  const transcript = roleFile(fx, 'build.codex.jsonl');
  assert(transcript !== null, 'transcript retained');
  assert(!transcript.includes('verity state'), 'no in-sandbox verity state call');
  assert(!/"gh /.test(transcript), 'no in-sandbox gh call');

  // The review dispatch (second link of the chain) got the refreshed facts.
  const reviewPrompt = roleFile(fx, 'review.prompt.txt');
  assert(reviewPrompt !== null, 'the review dispatch prompt was recorded');
  assert(reviewPrompt.includes('<github-state-snapshot>'), 'review gets the snapshot too');
  assert(reviewPrompt.includes('status: in-review'), 'refreshed per-iteration facts (PR now open)');
  assert(reviewPrompt.includes('CI: green'), "with the PR's CI state");
});

// ---------------------------------------------------------------------------
// (4) The facts channel: `verity next` attaches them additively, ONLY when the
// worker asks — CLI output and every existing consumer unchanged.
// ---------------------------------------------------------------------------

function factsFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-facts-'));
  stage.create(dir, 'First');
  stage.create(dir, 'Second', { dependsOn: '1' });
  return dir;
}

const FACTS_SNAPSHOT = {
  issues: [
    { number: 11, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
    { number: 12, title: '[stage 2] Second', state: 'OPEN', labels: [], assignees: [] },
  ],
  prs: [
    {
      number: 21,
      title: '[stage 1] First',
      state: 'MERGED',
      headRefName: 'feat/stage-1-first',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
    {
      number: 22,
      title: '[stage 2] Second',
      state: 'OPEN',
      headRefName: 'feat/stage-2-second',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
  ],
};

test('next.dispatch withFacts: a work decision carries the facts the dispatched role needs', () => {
  const dir = factsFixtureDir();
  const d = nextLib.dispatch([], { cwd: dir }, { snapshot: FACTS_SNAPSHOT, withFacts: true });
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'review');
  const f = d.facts;
  assert(f !== undefined, 'facts attached when asked');
  assertEqual(JSON.stringify(f.next), '[2]', 'the verity-state-next answer');
  assertEqual(f.stage.number, 2);
  assertEqual(f.stage.status, 'in-review');
  assertEqual(f.stage.issue, 12);
  assertEqual(f.stage.pr, 22);
  assertEqual(f.stage.ci, 'green', 'three-state CI travels, never a boolean');
  assertEqual(
    JSON.stringify(f.stage.depends_on),
    JSON.stringify([{ number: 1, status: 'merged' }]),
    'dependency statuses resolved',
  );
  assertEqual(f.stages.length, 2, 'the whole-stage summary travels');
});

test('next.dispatch: facts are DEFAULT-CLOSED — absent without withFacts, absent on gated/idle decisions', () => {
  const dir = factsFixtureDir();
  const plain = nextLib.dispatch([], { cwd: dir }, { snapshot: FACTS_SNAPSHOT });
  assertEqual(plain.action, 'work');
  assert(!('facts' in plain), 'no facts unless the caller asks');

  // Stage 20 stays binding: an unverified snapshot gates, and gates carry no
  // facts — there is nothing observed to render.
  const gated = nextLib.dispatch(
    [],
    { cwd: dir },
    {
      snapshot: {
        verified: false,
        failures: [{ source: 'issues', reason: 'network', detail: 'x' }],
      },
      withFacts: true,
    },
  );
  assertEqual(gated.action, 'gated');
  assertEqual(gated.gate, nextLib.STATE_GATE, 'fail-closed state read unchanged');
  assert(!('facts' in gated), 'an unobserved snapshot yields no facts');
});

test('state-snapshot renderFacts: deterministic text naming the reads it replaces', () => {
  const dir = factsFixtureDir();
  const d = nextLib.dispatch([], { cwd: dir }, { snapshot: FACTS_SNAPSHOT, withFacts: true });
  const text = snapshotLib.renderFacts(d.facts);
  assert(text.includes('`verity state next`'), 'names the read it replaces');
  assert(text.includes('[2]'), 'the unblocked list');
  assert(text.includes('stage 2 (Second)'), 'the dispatched stage');
  assert(text.includes('status: in-review'), 'its status');
  assert(text.includes('depends on: stage 1 (merged)'), 'its dependency state');
  assert(text.includes('#22 (CI: green)'), 'its PR + CI state');
  assert(text.includes('outside this sandbox'), 'says who read GitHub, and where');
});

// ---------------------------------------------------------------------------
// (5) The claude/uncontained path is unaffected (ADR-0013 binds CONTAINED
// dispatches only).
// ---------------------------------------------------------------------------

test('claude: renderPrompt is byte-identical whatever state context it is handed — no snapshot preamble leaks', () => {
  for (const name of ['build.md', 'review.md']) {
    const file = path.join(ROLES_DIR, name);
    const plain = claude.renderPrompt(file, ['7']);
    assertEqual(
      claude.renderPrompt(file, ['7'], { policy: {}, state: { schema: 1, next: [7] } }),
      plain,
      `${name}: the render context cannot change claude's prompt`,
    );
    assert(
      !plain.includes("GitHub is Verity's job"),
      `${name}: no snapshot preamble leaks into claude`,
    );
  }
});

test('agent-exec: --state-snapshot is REJECTED for claude — never a silently-ignored knob', () => {
  const res = spawnSync(
    'node',
    [
      CLI,
      'agent-exec',
      'build',
      '1',
      '--run-id',
      'r1',
      '--agent',
      'claude',
      '--state-snapshot',
      '{}',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assertEqual(res.status, 30, `usage error exits 30 (stderr: ${res.stderr})`);
  assert(res.stderr.includes('--state-snapshot'), 'names the flag');
  assert(res.stderr.includes('ADR-0013'), 'and the decision behind it');
});

test('agent-exec: a --state-snapshot that is not a JSON object is a usage error, exit 30', () => {
  for (const bad of ['not-json', '[1,2]']) {
    const res = spawnSync(
      'node',
      [
        CLI,
        'agent-exec',
        'build',
        '1',
        '--run-id',
        'r1',
        '--agent',
        'codex',
        '--state-snapshot',
        bad,
        '--json',
      ],
      { encoding: 'utf8' },
    );
    assertEqual(res.status, 30, `'${bad}' refused (stderr: ${res.stderr})`);
    assert(res.stderr.includes('--state-snapshot'), 'names the flag');
  }
});

test('runLoop: the facts flag travels to CODEX dispatches only — claude dispatches carry no snapshot', () => {
  const agentExecMod = require('../verity/bin/lib/agent-exec.cjs');
  const nextMod = require('../verity/bin/lib/next.cjs');
  const autonomyMod = require('../verity/bin/lib/autonomy.cjs');
  const FACTS = { schema: 1, as_of: 't', next: [1], stages: [], stage: null, reason: 'r' };
  const origDispatch = agentExecMod.dispatch;
  const origNext = nextMod.dispatch;
  const runFor = (provider) => {
    const policy = JSON.parse(JSON.stringify(autonomyMod.DEFAULTS));
    policy.mode = 'supervised';
    policy.limits.unknown_cost_behavior = 'allow_with_token_limit';
    if (provider === 'codex') {
      policy.agent = { ...policy.agent, provider: 'codex' };
    }
    const calls = [];
    const nextOpts = [];
    agentExecMod.dispatch = (args, flags) => {
      calls.push({ role: args[0], flags: { ...flags } });
      return {
        schema: 1,
        role: args[0],
        outcome: 'success',
        tokens: { in: 1, out: 1 },
        est_usd: provider === 'codex' ? null : 0.01,
        wall_secs: 1,
        tool_calls: 0,
        artifacts: {},
        error: null,
      };
    };
    let n = 0;
    nextMod.dispatch = (_args, _flags, opts) => {
      nextOpts.push(opts);
      n += 1;
      return n === 1
        ? {
            schema: 1,
            action: 'work',
            role: 'build',
            args: ['1'],
            gate: null,
            target: { kind: 'stage', number: 1 },
            reason: 'stage ready',
            // ADVERSARIAL: facts present even when nobody asked — the worker
            // must still not hand them to a claude dispatch.
            facts: FACTS,
          }
        : {
            schema: 1,
            action: 'idle',
            role: null,
            args: [],
            gate: null,
            target: null,
            reason: 'done',
          };
    };
    worker.runLoop(
      { repo: 'o/r', cwd: '/tmp', stdout() {}, stderr() {} },
      { policy, runId: 'run-facts', item: { kind: 'stage', number: null, tier: 'P5' } },
    );
    return { calls, nextOpts };
  };
  try {
    const codexRun = runFor('codex');
    assertEqual(codexRun.calls.length, 1);
    assertEqual(
      JSON.stringify(codexRun.calls[0].flags['state-snapshot']),
      JSON.stringify(FACTS),
      'codex dispatch carries the facts the decision derived',
    );
    assertEqual(codexRun.nextOpts[0]?.withFacts, true, 'the worker ASKED for facts (codex)');

    const claudeRun = runFor('claude');
    assertEqual(claudeRun.calls.length, 1);
    assert(
      !('state-snapshot' in claudeRun.calls[0].flags),
      'claude dispatch carries NO snapshot flag, even when facts exist',
    );
    assert(claudeRun.nextOpts[0]?.withFacts !== true, 'and the worker never asked for facts');
  } finally {
    agentExecMod.dispatch = origDispatch;
    nextMod.dispatch = origNext;
  }
});

// ---------------------------------------------------------------------------
// (6) Render pipeline: the GitHub preamble is OPTION-KEYED and off by default
// for every host — installs and claude renders are byte-identical to before.
// ---------------------------------------------------------------------------

test('the GitHub preamble is option-keyed, off by default for every host, and interpolates the snapshot when on', () => {
  const block = install.PREAMBLES.find((b) => b.option === 'verityPerformsGitHub');
  assert(block !== undefined, 'registered as a conditional preamble');
  for (const host of ['claude', 'opencode', 'codex']) {
    const rendered = install.renderRole(path.join(ROLES_DIR, 'review.md'), {}, host);
    assert(!rendered.includes("GitHub is Verity's job"), `${host}: absent with the option off`);
  }
  const on = install.renderRole(path.join(ROLES_DIR, 'review.md'), {
    verityPerformsGitHub: true,
    stateSnapshot: 'SNAPSHOT-FACTS-HERE',
  });
  assert(on.includes("GitHub is Verity's job"), 'present with the option on');
  assert(on.includes('SNAPSHOT-FACTS-HERE'), 'the facts text is interpolated');
});

test('contained role prompts route GitHub effects through the marker — review no longer instructs its own gh comment', () => {
  const source = fs.readFileSync(path.join(ROLES_DIR, 'review.md'), 'utf8');
  const headless = source.slice(source.indexOf('Headless mode'));
  assert(headless.length > 0, 'the headless section exists');
  assert(
    !headless.includes('post your findings as a PR comment (`gh pr comment`)'),
    'the old self-serve gh instruction is gone',
  );
  assert(headless.includes('findings_comment'), 'findings travel through the declared effect');
  assert(headless.includes('"verdict"'), 'the verdict channel is unchanged');
});
