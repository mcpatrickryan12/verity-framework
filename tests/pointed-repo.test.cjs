// Stage 34 — `verity state` and `verity next` must honor --repo and GH_REPO:
// finish the pointed-at-repo threading (canary run 5, defect N5 / target G1,
// tick 11).
//
// Stage 29 threaded GH_REPO into the worker's gh subprocess environment — but
// `verity state` / `verity next` resolve the repository UPSTREAM of gh, from
// the cwd's local git remotes: the ledger's snapshot fetch let `gh` do the
// resolution, and gh's env override does not reach every read. The live proof
// (tick 11): `GH_REPO=owner/name verity state next` in a remoteless clone →
// `no-repo — no git remotes found`, and the worker in the same clone died
// `state-unverified` at the scan, so ADR-0012's `git-unprovidable` refusal —
// implemented and correct one layer down — was unreachable through the worker.
//
// The gh stub here models the LIVE CLI as the canary observed it, not the
// documented ideal stage 29's stub models: -R-capable nouns (`issue`, `pr`)
// resolve --repo/-R argv → GH_REPO env → cwd remotes, but `gh repo view` takes
// its repository as a POSITIONAL argument only — it has no -R flag, so the
// GH_REPO override never applies to it and a remoteless cwd dies 'no git
// remotes found' even with GH_REPO set. That asymmetry IS the defect's
// mechanism, which is why the fix resolves the repository IN VERITY (the
// ledger), upstream of gh, and passes it explicitly. No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stage = require('../verity/bin/lib/stage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// --- (A) the CLI world: three distinguishable repositories --------------------
//
// The clone under test has stages 1 and 2 (2 depends on 1). Each repository's
// GitHub state pins stage 1 differently, so WHICH repository answered is
// readable off the projection: the issue number is unique per repository.
const WORLD = {
  'octo/pointed': {
    name: 'pointed',
    issues: [{ number: 101, title: '[stage 1] One', state: 'CLOSED', labels: [], assignees: [] }],
    prs: [
      {
        number: 102,
        title: '[stage 1] One',
        state: 'MERGED',
        headRefName: 'feat/stage-1-one',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      },
    ],
  },
  'octo/flagged': {
    name: 'flagged',
    issues: [
      {
        number: 201,
        title: '[stage 1] One',
        state: 'OPEN',
        labels: [],
        assignees: [{ login: 'dev' }],
      },
    ],
    prs: [],
  },
  'octo/cwd': {
    name: 'cwd',
    issues: [{ number: 301, title: '[stage 1] One', state: 'OPEN', labels: [], assignees: [] }],
    prs: [],
  },
};

// The live-faithful gh stub for the CLI half. Reads its multi-repo world from
// GH_WORLD_FILE and logs every call (args + the GH_REPO it saw) to GH_CALL_LOG.
const CLI_GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.GH_CALL_LOG) {
  fs.appendFileSync(
    process.env.GH_CALL_LOG,
    JSON.stringify({ args, ghRepo: process.env.GH_REPO || null }) + '\\n',
  );
}
const failSub = process.env.STUB_FAIL_SUBSTR;
if (failSub && args.join(' ').includes(failSub)) {
  process.stderr.write('HTTP 500: injected failure\\n');
  process.exit(1);
}
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
function fromRemotes() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/([^/:]+\\/[^/]+?)(?:\\.git)?$/);
    if (m) return m[1];
  } catch {}
  return null;
}
let repo = null;
if (args[0] === 'issue' || args[0] === 'pr') {
  // -R-capable nouns: argv, then GH_REPO, then the cwd's remotes (real gh).
  for (const f of ['--repo', '-R']) {
    if (args.includes(f)) repo = args[args.indexOf(f) + 1];
  }
  if (repo === null && process.env.GH_REPO) repo = process.env.GH_REPO;
  if (repo === null) repo = fromRemotes();
  if (repo === null) die('no git remotes found');
} else if (args[0] === 'repo' && args[1] === 'view') {
  // THE LIVE QUIRK (canary run 5, tick 11): repo view resolves a POSITIONAL
  // argument or the cwd's remotes — never GH_REPO (it has no -R flag).
  if (args[2] && !args[2].startsWith('-')) repo = args[2];
  else repo = fromRemotes();
  if (repo === null) die('no git remotes found');
} else {
  die('HTTP 404: unhandled gh call: ' + args.join(' '));
}
const world = JSON.parse(fs.readFileSync(process.env.GH_WORLD_FILE, 'utf8'));
const r = world[repo];
if (!r) die("Could not resolve to a Repository with the name '" + repo + "'. (HTTP 404)");
if (args[1] === 'list') {
  process.stdout.write(JSON.stringify(args[0] === 'issue' ? r.issues : r.prs));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ name: r.name }));
`;

// A clone with stages 1 and 2. `remote: 'owner/name'` adds an origin URL that
// parses to that repository; default is the canary's shape — NO remotes.
function cliFixture(opts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage34-cli-')));
  stage.create(dir, 'One');
  stage.create(dir, 'Two', { dependsOn: '1' });
  const git = (a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'verity@example.test']);
  git(['config', 'user.name', 'Verity Test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'baseline']);
  if (typeof opts.remote === 'string') {
    git(['remote', 'add', 'origin', `https://github.com/${opts.remote}.git`]);
  }
  const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage34-bin-')));
  const bin = path.join(support, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), CLI_GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const worldFile = path.join(support, 'gh-world.json');
  fs.writeFileSync(worldFile, JSON.stringify(WORLD));
  const log = path.join(support, 'gh-calls.log');
  const run = (args, runOpts = {}) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_WORLD_FILE: worldFile,
      GH_CALL_LOG: log,
      ...(runOpts.env || {}),
    };
    // The default is a clean slate: an ambient GH_REPO in the invoking shell
    // must never leak into a scenario that did not ask for one.
    if (!('GH_REPO' in (runOpts.env || {}))) {
      env.GH_REPO = undefined;
    }
    try {
      const out = execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8', env });
      return { code: 0, out, stderr: '' };
    } catch (err) {
      return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
    }
  };
  const calls = () =>
    (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { dir, run, calls };
}

const stageOne = (out) => JSON.parse(out).stages.find((s) => s.number === 1);

// ---------------------------------------------------------------------------
// (1) The regression: GH_REPO in a remoteless clone answers for the pointed-at
//     repository — today it errors `no-repo — no git remotes found`.
// ---------------------------------------------------------------------------

test('REGRESSION (tick 11): `verity state next` with GH_REPO in a remoteless clone answers for the pointed-at repo', () => {
  const fx = cliFixture(); // no remotes — the canary's clone
  const r = fx.run(['state', 'next', '--raw'], { env: { GH_REPO: 'octo/pointed' } });
  assertEqual(r.code, 0, `the pointed-at repo is perfectly readable (stderr: ${r.stderr})`);
  assertEqual(r.out, '[2]\n', 'stage 1 is merged IN THE POINTED-AT REPO, so next is [2]');
  const view = fx.run(['state', 'view'], { env: { GH_REPO: 'octo/pointed' } });
  assertEqual(view.code, 0, `state view reads the same repo (stderr: ${view.stderr})`);
  const s1 = stageOne(view.out);
  assertEqual(s1.status, 'merged', 'the pointed-at repository status');
  assertEqual(s1.issue, 101, "the pointed-at repository's issue — not no-repo, not the cwd");
});

test('REGRESSION (tick 11): `verity next` with GH_REPO in a remoteless clone dispatches on the pointed-at repo', () => {
  const fx = cliFixture();
  const r = fx.run(['next', '--json'], { env: { GH_REPO: 'octo/pointed' } });
  assertEqual(r.code, 0, `work is exit 0 (stderr: ${r.stderr})`);
  const d = JSON.parse(r.out);
  assertEqual(d.action, 'work', `never state:unverified here, got: ${r.out}`);
  assertEqual(d.role, 'build');
  assertEqual(JSON.stringify(d.args), '["2"]', 'stage 2 — because stage 1 is merged where pointed');
});

// ---------------------------------------------------------------------------
// (2) The precedence ladder, one rung at a time (gh's documented order)
// ---------------------------------------------------------------------------

test('PRECEDENCE: an explicit --repo beats GH_REPO', () => {
  const fx = cliFixture();
  const r = fx.run(['state', 'view', '--repo', 'octo/flagged'], {
    env: { GH_REPO: 'octo/pointed' },
  });
  assertEqual(r.code, 0, `stderr: ${r.stderr}`);
  const s1 = stageOne(r.out);
  assertEqual(s1.issue, 201, 'the --repo repository answered, not the GH_REPO one');
  assertEqual(s1.status, 'claimed', "octo/flagged's stage 1 is claimed");
});

test('PRECEDENCE: GH_REPO beats the cwd remotes', () => {
  const fx = cliFixture({ remote: 'octo/cwd' });
  const r = fx.run(['state', 'view'], { env: { GH_REPO: 'octo/pointed' } });
  assertEqual(r.code, 0, `stderr: ${r.stderr}`);
  const s1 = stageOne(r.out);
  assertEqual(s1.issue, 101, 'the GH_REPO repository answered, not the origin remote');
});

test('PRECEDENCE: with no --repo and no GH_REPO, cwd-remote resolution stands — and the gh argv is byte-identical', () => {
  const fx = cliFixture({ remote: 'octo/cwd' });
  const r = fx.run(['state', 'view']);
  assertEqual(r.code, 0, `stderr: ${r.stderr}`);
  assertEqual(stageOne(r.out).issue, 301, "the cwd remote's repository answered (stage 23)");
  // Stage 23's byte-identity: when nothing points elsewhere, the ledger sends
  // exactly the calls it always has — no --repo flag, no positional repo.
  const calls = fx.calls();
  assert(calls.length >= 3, `expected the ledger's gh reads, got ${calls.length}`);
  for (const c of calls) {
    assert(
      !c.args.includes('--repo') && !c.args.includes('-R'),
      `no pointed-at repo, so no repo argv: gh ${c.args.join(' ')}`,
    );
  }
  const repoView = calls.find((c) => c.args[0] === 'repo' && c.args[1] === 'view');
  assert(repoView !== undefined, 'the repo probe was made');
  assertEqual(
    JSON.stringify(repoView.args),
    JSON.stringify(['repo', 'view', '--json', 'name']),
    'the frozen repo-probe argv is byte-identical when nothing is pointed at',
  );
});

// ---------------------------------------------------------------------------
// (3) Fail-closed stays fail-closed (stages 20 and 23 unchanged)
// ---------------------------------------------------------------------------

test('FAIL-CLOSED: no --repo, no GH_REPO, no remotes still refuses no-repo — never a guess', () => {
  const fx = cliFixture();
  const r = fx.run(['state', 'next']);
  assertEqual(r.code, 30, `an unresolvable repository is still an infra refusal, got ${r.code}`);
  assertEqual(r.out, '', 'and it answers nothing');
  assert(/no-repo/.test(r.stderr), `the taxonomy still names no-repo, got: ${r.stderr}`);
  assert(/no git remotes found/.test(r.stderr), `and quotes gh's diagnostic: ${r.stderr}`);
});

test('FAIL-CLOSED: a pointed-at repo whose reads fail still refuses state-unverified (stage 20 binding at the new layer)', () => {
  const fx = cliFixture();
  const r = fx.run(['state', 'view', '--repo', 'octo/pointed'], {
    env: { STUB_FAIL_SUBSTR: 'pr list' },
  });
  assertEqual(r.code, 30, `an unreadable pointed-at repo refuses, got ${r.code}`);
  assertEqual(r.out, '', 'no partial projection');
  assert(
    /could NOT be read/.test(r.stderr),
    `the stage-20 refusal, not a confident empty: ${r.stderr}`,
  );
});

// --- (B) the worker e2e: stage 29's G1 target, closed --------------------------
//
// Harness mirrors tests/remoteless-refusal.test.cjs (stateful gh stub on PATH,
// provider tattletale), with the stub's repo resolution downgraded to the LIVE
// CLI's: `repo view` never honors GH_REPO. Before this stage the worker's scan
// died `state-unverified` on that read; the fix gets it a verified snapshot,
// so the run proceeds to dispatch and refuses at the git-lifecycle grant check
// with ADR-0012's `git-unprovidable`, naming the missing remote.

const WORKER_GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.CALLS_FILE) {
  fs.appendFileSync(
    process.env.CALLS_FILE,
    JSON.stringify({ args, ghRepo: process.env.GH_REPO || null }) + '\\n',
  );
}
// LIVE gh repo resolution (canary run 5, tick 11): issue/pr honor -R/--repo
// argv, then GH_REPO, then the cwd's remotes. \`repo view\` honors a POSITIONAL
// repo or the cwd's remotes ONLY — no -R flag, so GH_REPO never reaches it.
if (['issue', 'pr', 'repo'].includes(args[0])) {
  let repo = null;
  for (const f of ['--repo', '-R']) {
    if (args.includes(f)) repo = args[args.indexOf(f) + 1];
  }
  if (repo === null && args[0] === 'repo' && args[2] && !args[2].startsWith('-')) {
    repo = args[2];
  }
  if (repo === null && args[0] !== 'repo' && process.env.GH_REPO) repo = process.env.GH_REPO;
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

// Any provider spawn on this refusal path records itself and fails — "the
// refusal precedes the model run" is a positive assertion.
const PROVIDER_TATTLE = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.CODEX_SPAWNED_FILE) {
  fs.writeFileSync(process.env.CODEX_SPAWNED_FILE, process.argv.slice(2).join(' ') + '\\n');
}
process.stderr.write('stage 34: the provider must never be invoked on a refusal path\\n');
process.exit(1);
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

function workerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage34-wrk-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), WORKER_GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const providerBin = path.join(dir, 'provider-tattle');
  fs.writeFileSync(providerBin, PROVIDER_TATTLE);
  fs.chmodSync(providerBin, 0o755);
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: [READY_STAGE_ISSUE], prs: [] }));
  const callsFile = path.join(dir, 'calls.jsonl');
  const spawnedFile = path.join(dir, 'provider-spawned');
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), POLICY_CODEX);
  stage.create(dir, 'Core');
  // A REAL clone with real history and — the canary's shape — NO remotes.
  const git = (a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'verity@example.test']);
  git(['config', 'user.name', 'Verity Test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'baseline']);
  return { dir, home, bin, providerBin, stateFile, callsFile, spawnedFile };
}

function runPointedWorker(fx) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    CALLS_FILE: fx.callsFile,
    CODEX_SPAWNED_FILE: fx.spawnedFile,
    VERITY_CODEX_BIN: fx.providerBin,
    VERITY_AGENT_BIN: fx.providerBin,
  };
  // The WORKER must thread the repo — the harness never hands it one.
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

test('REGRESSION (G1): the worker in a remoteless clone with --repo refuses git-unprovidable — never state-unverified', () => {
  const fx = workerFixture();
  const { code, stderr } = runPointedWorker(fx);
  assertEqual(code, 30, `fail-closed refusal exits 30 (stderr: ${stderr})`);
  assert(
    !stderr.includes('state-unverified') && !stderr.includes('unverified GitHub state'),
    `the scan gets a VERIFIED snapshot for the pointed-at repo, got:\n${stderr}`,
  );
  assert(
    stderr.includes('verity-agent-exec: 30 git-unprovidable:'),
    `ADR-0012's refusal is reachable through the worker, got:\n${stderr}`,
  );
  assert(
    stderr.includes("no 'origin' remote"),
    `the refusal names the missing remote, got:\n${stderr}`,
  );
  assert(
    !fs.existsSync(fx.spawnedFile),
    'the refusal precedes any provider spawn — zero model runs',
  );
  // The refusal happened PAST the scan, at the git-lifecycle grant check: the
  // run's §7 infra summary landed on the stage issue and names the true fault.
  const state = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  const item = state.issues.find((it) => it.number === 41);
  const summary = (item.comments || []).map((c) => c.body).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'the run got past the scan and posted its §7 summary');
  assert(summary.includes('💥 infra'), `summary reports infra, got: ${summary}`);
  assert(summary.includes("no 'origin' remote"), `summary names the true fault, got: ${summary}`);
});

test("MECHANISM (G1): the ledger's repo probe carries the pointed-at repository explicitly — gh's env-deaf `repo view` included", () => {
  const fx = workerFixture();
  runPointedWorker(fx);
  const calls = fs
    .readFileSync(fx.callsFile, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
  const probes = calls.filter((c) => c.args[0] === 'repo' && c.args[1] === 'view');
  assert(probes.length >= 1, 'the ledger made its repo probe');
  for (const p of probes) {
    assertEqual(
      p.args[2],
      'octo/fixture',
      `the probe names the repository positionally (GH_REPO alone cannot reach it): gh ${p.args.join(' ')}`,
    );
  }
});
