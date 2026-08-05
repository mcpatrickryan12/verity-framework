// Stage 29 — missing git remotes must refuse as `git-unprovidable`, and the
// circuit breaker must honor --repo (canary §4 re-run, defect 6, tick 11).
//
// With `origin` removed the worker refused fail-closed (good: no codex spawn,
// no branch) but via the WRONG check with a MISLEADING message:
//   verity-worker: 30 circuit-open: could not check the circuit breaker
//   (failing closed): no git remotes found
// Two defects hid in that line: (1) the breaker's `gh issue list` resolved the
// repository from the CWD'S GIT REMOTES even though the worker was POINTED at
// one (`--repo owner/name` is required — stage 23's disease in one more
// callsite), and (2) the truthful ADR-0012 refusal — `git-unprovidable`,
// naming the missing remote — was unreachable because the breaker check died
// first on the same missing remote.
//
// The fix threads the pointed-at repository as GH_REPO, gh's documented
// scripting override, which outranks local-remote resolution for every gh
// subprocess this run spawns (breaker, scanner, ledger, locks, git-lifecycle)
// while leaving the pinned §4.1/§4.2 command shapes byte-identical
// (tests/worker.test.cjs asserts the exact breaker argv; it runs green,
// unmodified).
//
// Harness mirrors tests/worker.test.cjs (stateful gh stub on PATH), with one
// upgrade the defect demands: this stub performs REAL repository resolution —
// -R/--repo argv, then GH_REPO, then the cwd's git remotes — and fails exactly
// like the live CLI did in canary tick 11 ('no git remotes found') when none
// exists. Every call is logged WITH the GH_REPO it saw, so the threading is
// asserted stage-23 style over the whole call log. No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stage = require('../verity/bin/lib/stage.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// --- gh stub with real repo-resolution semantics ------------------------------
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.CALLS_FILE) {
  fs.appendFileSync(
    process.env.CALLS_FILE,
    JSON.stringify({ args, ghRepo: process.env.GH_REPO || null }) + '\\n',
  );
}
const failSub = process.env.STUB_FAIL_SUBSTR;
if (failSub && args.join(' ').includes(failSub)) {
  process.stderr.write('HTTP 422: injected failure\\n');
  process.exit(1);
}
// REAL gh repo resolution, for the nouns that operate ON a repository:
// -R/--repo argv wins, then the GH_REPO environment variable, then the cwd's
// git remotes. None of the three -> die exactly like the live CLI (tick 11).
// 'auth' and 'api' (explicit REST paths) never resolve a repo.
if (['issue', 'pr', 'repo'].includes(args[0])) {
  let repo = null;
  for (const f of ['--repo', '-R']) {
    if (args.includes(f)) repo = args[args.indexOf(f) + 1];
  }
  if (repo === null && process.env.GH_REPO) repo = process.env.GH_REPO;
  if (repo === null) {
    let remotes = '';
    try {
      remotes = execFileSync('git', ['remote'], { encoding: 'utf8' }).trim();
    } catch {}
    if (remotes === '') {
      process.stderr.write('no git remotes found\\n');
      process.exit(1);
    }
  }
}
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
if (args[0] === 'auth' && args[1] === 'status') {
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

// --- provider tattletale ------------------------------------------------------
// Every stage-29 scenario is a REFUSAL — the provider must never be invoked on
// any of them. Any spawn (even the --version preflight) records itself and
// fails, so "no refusal path invokes the provider" is a positive assertion.
const PROVIDER_TATTLE = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.CODEX_SPAWNED_FILE) {
  fs.writeFileSync(process.env.CODEX_SPAWNED_FILE, process.argv.slice(2).join(' ') + '\\n');
}
process.stderr.write('stage 29: the provider must never be invoked on a refusal path\\n');
process.exit(1);
`;

// Codex worker policy (the runtime whose git_write grant means "Verity performs
// git", ADR-0012). The network gap must be acknowledged or every dispatch is
// refused `unenforceable-policy` BEFORE the git-lifecycle grant check.
const POLICY_CODEX = [
  'mode: supervised',
  'agent:',
  '  provider: codex',
  '  acknowledged_enforcement_gaps: [network]',
  'notify:',
  '  mention: [seanerama]',
  '',
].join('\n');

// A stage act ready to build: what the canary's §4 negative pointed the worker
// at when it removed `origin`.
const READY_STAGE_ISSUE = {
  number: 41,
  title: '[stage 1] Core',
  state: 'OPEN',
  labels: ['verity:ready'],
  author: { login: 'human' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
};

const CIRCUIT_ISSUE = {
  number: 99,
  title: 'HALT autonomy',
  state: 'OPEN',
  labels: ['verity:circuit-open'],
  author: { login: 'seanerama' },
  createdAt: '2026-06-02T00:00:00Z',
  assignees: [],
  comments: [],
};

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage29-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const providerBin = path.join(dir, 'provider-tattle');
  fs.writeFileSync(providerBin, PROVIDER_TATTLE);
  fs.chmodSync(providerBin, 0o755);
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: opts.issues || [], prs: opts.prs || [] }));
  const callsFile = path.join(dir, 'calls.jsonl');
  const spawnedFile = path.join(dir, 'provider-spawned');
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY_CODEX);
  stage.create(dir, 'Core');
  // A REAL clone with real history and — the point of the stage — NO remotes.
  // `opts.remote` adds a bare `origin` for the scenarios that need one present.
  const git = (a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'verity@example.test']);
  git(['config', 'user.name', 'Verity Test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'baseline']);
  if (opts.remote === true) {
    execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'origin.git')], { stdio: 'pipe' });
    git(['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  }
  return { dir, home, bin, providerBin, stateFile, callsFile, spawnedFile };
}

function runWorker(fx, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    CALLS_FILE: fx.callsFile,
    CODEX_SPAWNED_FILE: fx.spawnedFile,
    VERITY_CODEX_BIN: fx.providerBin,
    VERITY_AGENT_BIN: fx.providerBin,
    ...(extra.env || {}),
  };
  // The WORKER must thread the repo — the harness must never hand it one
  // (an undefined env value is omitted from the child's environment).
  env.GH_REPO = undefined;
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

function readCalls(fx) {
  return fs.existsSync(fx.callsFile)
    ? fs
        .readFileSync(fx.callsFile, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
    : [];
}

function ghState(fx) {
  return JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
}

function comments(fx, number) {
  const s = ghState(fx);
  const item = s.issues.concat(s.prs).find((it) => it.number === number);
  return (item.comments || []).map((c) => c.body);
}

function assertNoProviderSpawn(fx) {
  assert(
    !fs.existsSync(fx.spawnedFile),
    `no refusal path invokes the provider — but it was spawned with: ${
      fs.existsSync(fx.spawnedFile) ? fs.readFileSync(fx.spawnedFile, 'utf8') : ''
    }`,
  );
}

// --- (1) the regression: tick 11, refused for the TRUE reason -----------------

test('REGRESSION (stage 29): --repo with no remotes refuses git-unprovidable naming the missing remote — never circuit-open', () => {
  const fx = fixture({ issues: [READY_STAGE_ISSUE] });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30, `fail-closed refusal exits 30 (stderr: ${stderr})`);
  assert(
    stderr.includes('verity-agent-exec: 30 git-unprovidable:'),
    `ADR-0012's specified refusal line surfaces, got:\n${stderr}`,
  );
  assert(
    stderr.includes("no 'origin' remote"),
    `the refusal names the missing remote, got:\n${stderr}`,
  );
  assert(
    !stderr.includes('circuit-open'),
    `a missing remote must never read as the kill switch, got:\n${stderr}`,
  );
  assertNoProviderSpawn(fx);
  // The refusal precedes any git mutation: no stage branch, checkout untouched.
  const branches = execFileSync('git', ['branch', '--list'], { cwd: fx.dir, encoding: 'utf8' });
  assert(
    !branches.includes('feat/stage-1'),
    `the refusal precedes branch creation, got branches: ${branches}`,
  );
  // And it happened PAST startup, at the git-lifecycle grant check — the run's
  // §7 infra summary landed on the stage issue and says why.
  const summary = comments(fx, 41).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'the run got past startup and posted its §7 summary');
  assert(summary.includes('💥 infra'), `summary reports infra, got: ${summary}`);
  assert(summary.includes("no 'origin' remote"), `summary names the true fault, got: ${summary}`);
});

// --- (2) the real kill switch is untouched — even alongside the missing remote

test('kill switch still refuses circuit-open naming the issue — it outranks the unprovidable grant (startup precedes dispatch)', () => {
  const fx = fixture({ issues: [READY_STAGE_ISSUE, CIRCUIT_ISSUE] });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 30, 'open breaker halts the worker with exit 30');
  const lines = stderr.split('\n').filter((l) => l !== '');
  assertEqual(lines.length, 1, `§8.2: exactly one stderr line, got:\n${stderr}`);
  assert(
    /^verity-worker: 30 circuit-open: /.test(lines[0]),
    `§8.2 refusal line with the circuit-open slug, got: ${lines[0]}`,
  );
  assert(
    lines[0].includes('circuit breaker is open'),
    `the SWITCH message, not the read-failure one, got: ${lines[0]}`,
  );
  assert(lines[0].includes('#99'), `names the breaker issue, got: ${lines[0]}`);
  assertNoProviderSpawn(fx);
});

// --- (3) a genuine breaker-READ failure: fail closed, name what failed to read

test('a genuine breaker-read failure (gh error, remotes present) refuses fail-closed naming the READ failure — never implying the switch was thrown', () => {
  const fx = fixture({ issues: [READY_STAGE_ISSUE], remote: true });
  const { code, stderr } = runWorker(fx, { env: { STUB_FAIL_SUBSTR: 'verity:circuit-open' } });
  assertEqual(code, 30, 'an unreadable breaker still halts the worker');
  const lines = stderr.split('\n').filter((l) => l !== '');
  assertEqual(lines.length, 1, `§8.2: exactly one stderr line, got:\n${stderr}`);
  assert(
    /^verity-worker: 30 circuit-open: could not check the circuit breaker \(failing closed\): HTTP 422/.test(
      lines[0],
    ),
    `the message names the READ failure, got: ${lines[0]}`,
  );
  assert(
    !lines[0].includes('circuit breaker is open'),
    `a read failure must never claim the switch was thrown, got: ${lines[0]}`,
  );
  assertNoProviderSpawn(fx);
});

// --- (4) the breaker's gh call targets the --repo repository ------------------

test('the breaker query targets the --repo repository — frozen §4.1 argv with the repo threaded beside it (stage-23 style, whole log)', () => {
  const fx = fixture({ issues: [READY_STAGE_ISSUE] });
  runWorker(fx);
  const calls = readCalls(fx);
  const breaker = calls.find((c) => c.args.includes('verity:circuit-open'));
  assert(breaker !== undefined, 'the §4.1 breaker query was issued');
  assertEqual(
    JSON.stringify(breaker.args),
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
    'the frozen §4.1 query shape is byte-identical — the repo travels as GH_REPO, not argv',
  );
  assertEqual(breaker.ghRepo, 'octo/fixture', 'the breaker call carries the --repo repository');
  // Stage-23 style: over the WHOLE call log, every repo-operating gh call is
  // targeted at the pointed-at repository — a future call added without the
  // threading fails here, not in the next canary.
  const repoOps = calls.filter((c) => ['issue', 'pr', 'repo'].includes(c.args[0]));
  assert(
    repoOps.length >= 5,
    `the run issued repo-operating calls (breaker + scan + ledger), got ${repoOps.length}`,
  );
  for (const c of repoOps) {
    assertEqual(
      c.ghRepo,
      'octo/fixture',
      `every repo-operating call targets --repo: gh ${c.args.join(' ')}`,
    );
  }
});
