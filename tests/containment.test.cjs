// Stage 14 (ADR-0011 TIER 2 — containment, not restriction) — the disposable
// shaped workspace + gated merge-back, the containment level required before
// ANY unattended codex autonomy:
//   1. SHAPED WORKSPACE — the role runs against a throwaway worktree in which
//      the paths it may not touch are PHYSICALLY ABSENT, sited under the Verity
//      state root (never TMPDIR — spike F5), disposed on success AND failure;
//   2. GATED MERGE-BACK — deterministic Verity code decides what propagates
//      back; a path outside the role's writable set is a LOUD failure naming
//      the path, and NOTHING propagates on rejection;
//   3. TIER GATING — tier 2 is OPT-IN and default OFF, the active tier is
//      visible in the result, and the worker refuses unattended codex autonomy
//      without it (tests/worker.test.cjs owns that half).
//
// BINDING TEST RULE (issue #28, spike F4): every test that asserts a DENIAL
// makes the stub write a LIVENESS MARKER in the SAME invocation, after all its
// scripted actions. "Nothing propagated" is a pass ONLY when the marker proves
// the command ran; a missing marker is an INVALID TEST, never a pass.
//
// The real Codex CLI is not available in CI, so the model runtime is a stub —
// but the stub is an ADVERSARY performing exactly the writes a misbehaving role
// would, every git operation is REAL (real repos, real worktrees), and
// everything Verity owns runs for real.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../verity/bin/lib/agents/claude.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const workspace = require('../verity/bin/lib/agents/workspace.cjs');
const policyLib = require('../verity/bin/lib/agents/policy.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const LIB_DIR = path.join(__dirname, '..', 'verity', 'bin', 'lib');
// Read the pin rather than hardcoding it (stage 12 — it is feature-derived now).
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// Adversarial codex stand-in, configured the way a real model is: through the
// workspace it was handed (`--cd`). It records where it was actually run and
// which paths it can see, performs each scripted action, and — LAST, so its
// presence proves the whole body ran — writes the liveness marker beside the
// run's final-message file (outside the workspace, where it can never be
// mistaken for a workspace mutation).
const ACTOR_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli ${MIN_CODEX}\\n'); process.exit(0); }
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
const flag = (n) => args[args.indexOf(n) + 1];
const cwd = flag('--cd');
const logDir = path.dirname(flag('--output-last-message'));
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.verity-stub.json'), 'utf8'));
fs.readFileSync(0, 'utf8'); // consume the prompt
const probe = { cd: cwd, spawnedInCd: fs.realpathSync(process.cwd()) === fs.realpathSync(cwd), sees: {} };
for (const p of cfg.probePaths || []) probe.sees[p] = fs.existsSync(path.join(cwd, p));
fs.writeFileSync(path.join(logDir, 'probe.json'), JSON.stringify(probe));
for (const action of cfg.actions || []) {
  try {
    if (action.write !== undefined) {
      const target = path.join(cwd, action.write);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, action.text === undefined ? 'pwned\\n' : action.text);
    } else if (action.remove !== undefined) {
      fs.rmSync(path.join(cwd, action.remove), { force: true });
    }
  } catch (err) {
    fs.appendFileSync(path.join(logDir, 'actor-errors.log'), String(err.message) + '\\n');
  }
}
// LIVENESS MARKER — written last: present ⇒ every action above was attempted.
fs.writeFileSync(path.join(logDir, 'liveness.marker'), 'ran\\n');
const marker = 'Done.\\n{"verity":1,"outcome":"success","gate":null,"artifacts":{},"reason":"ok"}';
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: marker } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`;

// The restricted proof subject: repo writes only — NO write_protected_paths.
const RESTRICTED = {
  schema_version: 1,
  capabilities: {
    read_repository: true,
    write_repository: true,
    run_tests: true,
    git_read: true,
    git_write: true,
    github_read: true,
    github_write: false,
    network: false,
    deploy: false,
  },
  codex: { sandbox: 'workspace-write', approval: 'never' },
};

// The control: everything the restricted role lacks, proving each rejection is
// DERIVED from policy rather than hardcoded into the mechanism.
const PERMISSIVE = {
  schema_version: 1,
  capabilities: {
    ...RESTRICTED.capabilities,
    github_write: true,
    network: true,
    deploy: true,
    write_protected_paths: true,
  },
  codex: { sandbox: 'workspace-write', approval: 'never' },
};

function withCaps(base, caps) {
  const next = JSON.parse(JSON.stringify(base));
  Object.assign(next.capabilities, caps);
  return next;
}

// `network: false` is the one restriction Verity cannot enforce on the exec
// path, so every restricted run acknowledges it (or is refused at tier 1).
const ACK = ['--acknowledge-gaps', 'network'];
const TIER2 = ['--containment-tier', '2'];

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

// A REAL git repository — tier 2 is worktree machinery, so nothing here is
// simulated. $HOME is a sibling of the repo, exactly like the real layout.
function fixture(permissions = RESTRICTED, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-tier2-'));
  const dir = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(root, 'codex-stub');
  fs.writeFileSync(stub, ACTOR_STUB);
  fs.chmodSync(stub, 0o755);
  const roleDir = path.join(dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, 'restricted.md'),
    '---\nname: restricted\n---\nDo restricted things with $ARGUMENTS\n',
  );
  fs.writeFileSync(
    path.join(roleDir, 'restricted.permissions.json'),
    JSON.stringify(permissions, null, 2),
  );
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'mode: manual\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.txt'), 'baseline\n');
  fs.writeFileSync(path.join(dir, '.verity-stub.json'), JSON.stringify({ actions: [] }));
  if (opts.git !== false) {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'verity@example.test']);
    git(dir, ['config', 'user.name', 'Verity Test']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'baseline']);
  }
  return { root, dir, home, stub, roleDir };
}

function logDir(fx, runId) {
  return path.join(fx.home, '.verity', 'logs', runId);
}

function wsDir(fx, runId, role = 'restricted') {
  return path.join(fx.home, '.verity', 'workspaces', runId, role);
}

// The issue-#28 gate: a denial assertion is only meaningful if the command
// actually ran. Marker absent ⇒ INVALID TEST, never a pass.
function assertLive(fx, runId, label) {
  const marker = path.join(logDir(fx, runId), 'liveness.marker');
  assert(
    fs.existsSync(marker),
    `INVALID TEST (${label}): no liveness marker at ${marker} — the stub never completed its actions, so any "nothing propagated" reading is meaningless (spike F4 / issue #28)`,
  );
}

// One agent-exec run. The stub's script is delivered through the repository
// (and COMMITTED, because a shaped workspace is derived from HEAD — the model
// sees the repo as of its last commit, never the caller's uncommitted state).
function run(fx, opts = {}) {
  const runId = opts.runId || 'c2-1';
  fs.writeFileSync(
    path.join(fx.dir, '.verity-stub.json'),
    JSON.stringify({ actions: opts.actions || [], probePaths: opts.probePaths || [] }),
  );
  if (opts.commit !== false) {
    git(fx.dir, ['add', '-A']);
    git(fx.dir, ['commit', '-q', '--allow-empty', '-m', 'stub script']);
  }
  const argv = [
    CLI,
    'agent-exec',
    'restricted',
    'now',
    '--run-id',
    runId,
    '--agent',
    'codex',
    '--cwd',
    fx.dir,
    '--json',
    ...(opts.args === undefined ? [...ACK, ...TIER2] : opts.args),
  ];
  // spawnSync, not execFileSync: stderr matters on the SUCCESS path too (the
  // --keep-workspace note is emitted by a run that exits 0).
  const res = spawnSync('node', argv, {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_CODEX_BIN: fx.stub,
      VERITY_CLAUDE_BIN: '',
      VERITY_AGENT_BIN: '',
    },
  });
  return { out: res.stdout || '', stderr: res.stderr || '', code: res.status, runId };
}

function resultObject(res) {
  const lines = String(res.out).split('\n').filter(Boolean);
  assertEqual(lines.length, 1, `exactly one result object on stdout (stderr: ${res.stderr})`);
  return JSON.parse(lines[0]);
}

function probe(fx, runId) {
  return JSON.parse(fs.readFileSync(path.join(logDir(fx, runId), 'probe.json'), 'utf8'));
}

function read(fx, rel) {
  return fs.readFileSync(path.join(fx.dir, rel), 'utf8');
}

function loaded(permissions) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-pol2-')), 'r.permissions.json');
  fs.writeFileSync(f, JSON.stringify(permissions));
  return policyLib.loadPolicy(f);
}

// --- 1. the disposable shaped workspace -----------------------------------------

test('workspace: the role runs in a DISPOSABLE workspace where protected roots are physically ABSENT', () => {
  const fx = fixture();
  const res = run(fx, {
    probePaths: ['.github', '.github/workflows/ci.yml', '.verity', 'src/app.txt', 'commands'],
  });
  assertEqual(res.code, 0, `clean tier-2 run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'workspace shaping');
  const seen = probe(fx, res.runId);

  // `--cd` (and the spawn cwd) point at the disposable workspace, NOT the repo.
  assertEqual(seen.cd, wsDir(fx, res.runId), '--cd points at the shaped workspace');
  assertEqual(seen.spawnedInCd, true, 'and the child process was spawned there too');
  assert(seen.cd !== fx.dir, 'the model never runs in the real checkout');

  // The protected roots are not "denied" — they are NOT THERE.
  assertEqual(seen.sees['.github'], false, '.github is absent from the workspace');
  assertEqual(seen.sees['.github/workflows/ci.yml'], false, 'and so is everything under it');
  assertEqual(seen.sees['.verity'], false, '.verity is absent from the workspace');
  // Everything the role IS allowed to work on is present and complete.
  assertEqual(seen.sees['src/app.txt'], true, 'ordinary source is present');
  assertEqual(seen.sees.commands, true, 'the role can read everywhere it is allowed');

  // The real checkout still has them, untouched.
  assertEqual(read(fx, '.github/workflows/ci.yml'), 'name: ci\n', 'real checkout intact');
  assertEqual(read(fx, '.verity/autonomy.yml'), 'mode: manual\n', 'real checkout intact');
});

test('workspace: sited under the Verity state root, NEVER under TMPDIR (spike F5)', () => {
  const fx = fixture();
  const res = run(fx, { actions: [{ write: 'src/ok.txt', text: 'work\n' }] });
  assertLive(fx, res.runId, 'workspace siting');
  const seen = probe(fx, res.runId);
  const stateRoot = path.join(fx.home, '.verity', 'workspaces');
  assert(seen.cd.startsWith(stateRoot), `workspace lives under ${stateRoot}, got ${seen.cd}`);
  // /tmp is writable from inside the Codex sandbox, so a workspace sited there
  // would be no boundary at all. Neither module may reach for a temp dir.
  for (const file of ['agents/workspace.cjs', 'agent-exec.cjs']) {
    const src = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    assert(!src.includes('tmpdir'), `${file} must never site a workspace under TMPDIR (F5)`);
  }
});

test('workspace: removed on SUCCESS and on FAILURE; the real repo keeps one worktree', () => {
  const fx = fixture();
  const ok = run(fx, { actions: [{ write: 'src/ok.txt', text: 'work\n' }] });
  assertEqual(ok.code, 0, `success path (stderr: ${ok.stderr})`);
  assertLive(fx, ok.runId, 'cleanup on success');
  assert(!fs.existsSync(wsDir(fx, ok.runId)), 'workspace gone after a successful run');

  const bad = run(fx, {
    actions: [{ write: '.github/workflows/pwn.yml' }],
    runId: 'c2-fail',
  });
  assertEqual(bad.code, 20, `failure path (stderr: ${bad.stderr})`);
  assertLive(fx, bad.runId, 'cleanup on failure');
  assert(!fs.existsSync(wsDir(fx, bad.runId)), 'workspace gone after a REJECTED run too');

  const list = git(fx.dir, ['worktree', 'list']).trim().split('\n');
  assertEqual(list.length, 1, `only the real checkout remains registered:\n${list.join('\n')}`);
});

test('workspace: --keep-workspace retains it (the explicit debug flag) and says so', () => {
  const fx = fixture();
  const res = run(fx, {
    actions: [{ write: 'src/ok.txt', text: 'work\n' }],
    args: [...ACK, ...TIER2, '--keep-workspace'],
  });
  assertEqual(res.code, 0, `retained run still completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'workspace retention');
  assert(fs.existsSync(wsDir(fx, res.runId)), 'the workspace survives for inspection');
  assert(res.stderr.includes('workspace retained'), `retention is announced (${res.stderr})`);
  assert(res.stderr.includes(wsDir(fx, res.runId)), 'and names where it is');
});

test('workspace: tier 2 FAILS CLOSED where it cannot be provided (no repository)', () => {
  const fx = fixture(RESTRICTED, { git: false });
  const res = run(fx, { actions: [{ write: 'src/ok.txt' }], commit: false });
  assertEqual(res.code, 30, `refused, never degraded to the real checkout (${res.stderr})`);
  assert(
    res.stderr.includes('verity-agent-exec: 30 workspace-unavailable:'),
    `stderr slug line (${res.stderr})`,
  );
  assert(res.stderr.includes('not a git repository'), 'names why');
  assertEqual(resultObject(res).outcome, 'infra_error');
  assert(
    !fs.existsSync(path.join(logDir(fx, res.runId), 'liveness.marker')),
    'the agent was never invoked — the refusal is real, not a broken stub',
  );
});

// --- 2. the gated merge-back (the teeth) ----------------------------------------

test('merge-back: an ALLOWED-path change propagates, and is named in the result', () => {
  const fx = fixture();
  const res = run(fx, {
    actions: [
      { write: 'src/app.txt', text: 'edited by the role\n' },
      { write: 'src/new/deep.txt', text: 'brand new\n' },
    ],
  });
  assertEqual(res.code, 0, `allowed work succeeds (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'allowed propagation');
  assertEqual(read(fx, 'src/app.txt'), 'edited by the role\n', 'modification propagated');
  assertEqual(read(fx, 'src/new/deep.txt'), 'brand new\n', 'a new file propagated');
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'success');
  assertEqual(
    JSON.stringify(obj.containment_merged),
    '["src/app.txt","src/new/deep.txt"]',
    'exactly what deterministic Verity code propagated — attributable, sorted',
  );
  assert(!('containment_rejected' in obj), 'nothing rejected on an in-policy run');
});

test('merge-back: a protected-path write inside the workspace REACHES NOTHING (adversarial)', () => {
  const fx = fixture();
  const res = run(fx, {
    actions: [
      // Possible inside the workspace precisely because the role created the
      // directory there — and irrelevant, because propagation is gated.
      { write: '.github/workflows/pwn.yml', text: 'on: push\n' },
      { write: '.github/workflows/ci.yml', text: 'name: tampered\n' },
      { write: 'src/app.txt', text: 'legitimate work in the same run\n' },
    ],
  });
  assertLive(fx, res.runId, 'protected-path rejection');
  assertEqual(res.code, 20, `a rejected path fails the run (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'failed', 'the role claimed success — the gate overrides it');
  assert(obj.error.includes('.github/workflows/pwn.yml'), `error names the path (${obj.error})`);
  assert(obj.error.includes('protected-path'), 'and why it was rejected');
  assert(obj.error.includes('NOTHING was propagated'), 'and that nothing crossed');
  assert(res.stderr.includes('containment-rejected'), 'loud on stderr too');
  assertEqual(
    JSON.stringify(obj.containment_rejected.map((r) => `${r.path}:${r.reason}`).sort()),
    '[".github/workflows/ci.yml:protected-path",".github/workflows/pwn.yml:protected-path"]',
    'both offending paths named — never a silent drop',
  );

  // The real repository is exactly as it was.
  assert(
    !fs.existsSync(path.join(fx.dir, '.github', 'workflows', 'pwn.yml')),
    'the created protected file never reached the real repo',
  );
  assertEqual(read(fx, '.github/workflows/ci.yml'), 'name: ci\n', 'nor did the tampering');
  assertEqual(
    read(fx, 'src/app.txt'),
    'baseline\n',
    "ALL-OR-NOTHING: the same run's legitimate edit did not propagate either",
  );
  assertEqual(git(fx.dir, ['status', '--porcelain']).trim(), '', 'real checkout wholly untouched');
});

test('merge-back: a NEW top-level dotfile is rejected — unless the policy allows it', () => {
  const fx = fixture();
  const res = run(fx, { actions: [{ write: '.npmrc', text: '//registry/:_authToken=x\n' }] });
  assertLive(fx, res.runId, 'new dotfile rejection');
  assertEqual(res.code, 20, `a new dotfile fails the run (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(
    JSON.stringify(obj.containment_rejected),
    JSON.stringify([{ path: '.npmrc', change: 'added', reason: 'new-dotfile' }]),
    'classified as a new dotfile, not as ordinary work',
  );
  assert(!fs.existsSync(path.join(fx.dir, '.npmrc')), 'it never reached the real repo');

  // Control: write_protected_paths permits config-shaped writes, so the SAME
  // change propagates — the rejection derives from policy, not the mechanism.
  const ok = fixture(PERMISSIVE);
  const okRes = run(ok, {
    actions: [{ write: '.npmrc', text: 'registry=https://example.test\n' }],
    args: [...TIER2], // PERMISSIVE grants network → no acknowledgement needed
    runId: 'c2-dotok',
  });
  assertLive(ok, okRes.runId, 'granted dotfile control');
  assertEqual(okRes.code, 0, `granted write completes (stderr: ${okRes.stderr})`);
  assertEqual(read(ok, '.npmrc'), 'registry=https://example.test\n', 'the write SURVIVES');
});

test('merge-back: write_protected_paths GRANTS the .github write — shaping derives from policy', () => {
  const fx = fixture(PERMISSIVE);
  const res = run(fx, {
    actions: [{ write: '.github/workflows/ok.yml', text: 'name: ok\n' }],
    probePaths: ['.github/workflows/ci.yml'],
    args: [...TIER2],
  });
  assertLive(fx, res.runId, 'granted protected write');
  assertEqual(res.code, 0, `granted write completes (stderr: ${res.stderr})`);
  assertEqual(
    probe(fx, res.runId).sees['.github/workflows/ci.yml'],
    true,
    'nothing is withheld from a role that may write the protected roots',
  );
  assertEqual(read(fx, '.github/workflows/ok.yml'), 'name: ok\n', 'and the write propagates');
});

test('merge-back: a READ-ONLY role may propagate nothing at all (empty writable set)', () => {
  const readOnly = withCaps(RESTRICTED, { write_repository: false });
  readOnly.codex.sandbox = 'read-only';
  const fx = fixture(readOnly);
  const res = run(fx, { actions: [{ write: 'src/sneaky.txt', text: 'nope\n' }] });
  assertLive(fx, res.runId, 'read-only rejection');
  assertEqual(res.code, 20, `a read-only role writing anything fails (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(
    JSON.stringify(obj.containment_rejected.map((r) => r.reason)),
    '["read-only-role"]',
    'rejected because the writable set is EMPTY, not because of the path',
  );
  assert(!fs.existsSync(path.join(fx.dir, 'src', 'sneaky.txt')), 'nothing reached the real repo');
});

test('merge-back: a DELETION of an allowed path propagates as a deletion', () => {
  const fx = fixture();
  const res = run(fx, { actions: [{ remove: 'src/app.txt' }] });
  assertEqual(res.code, 0, `deleting allowed work succeeds (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'deletion propagation');
  assert(!fs.existsSync(path.join(fx.dir, 'src', 'app.txt')), 'the deletion propagated');
  assertEqual(JSON.stringify(resultObject(res).containment_merged), '["src/app.txt"]');
});

test('gate: unit — classification, including a path that escapes the workspace root', () => {
  const ws = {
    path: '/ws',
    root: '/repo',
    withheld: ['.github', '.verity'],
    protectedRoots: ['.github', '.verity'],
    allowProtected: false,
    writable: true,
  };
  const verdict = workspace.gate(ws, [
    { path: 'src/ok.txt', change: 'added' },
    { path: 'docs/readme.md', change: 'modified' },
    { path: '.github/workflows/x.yml', change: 'added' },
    { path: '.verity/autonomy.yml', change: 'modified' },
    { path: '.env', change: 'added' },
    { path: '.gitignore', change: 'modified' }, // already tracked — ordinary work
    { path: '../outside.txt', change: 'added' },
  ]);
  assertEqual(
    JSON.stringify(verdict.accepted.map((c) => c.path)),
    '["src/ok.txt","docs/readme.md",".gitignore"]',
    'only what the writable set covers',
  );
  assertEqual(
    JSON.stringify(verdict.rejected.map((r) => `${r.path}:${r.reason}`)),
    '[".github/workflows/x.yml:protected-path",".verity/autonomy.yml:protected-path",".env:new-dotfile","../outside.txt:out-of-root"]',
    'every rejection names its reason',
  );
  for (const r of verdict.rejected) {
    assert(workspace.REJECTION_REASONS.includes(r.reason), `${r.reason} is a published reason`);
  }
  assertEqual(workspace.inside('/ws', 'a/b'), true, 'inside');
  assertEqual(workspace.inside('/ws', '/etc/passwd'), false, 'an absolute path is out-of-root');
  assertEqual(workspace.inside('/ws', 'a/../..'), false, 'a `..` escape is out-of-root');
});

// --- 3. tier gating + the kill switch -------------------------------------------

test('kill switch: tier 2 is OPT-IN — without the flag nothing about the run changes', () => {
  const fx = fixture();
  const res = run(fx, {
    actions: [{ write: 'src/ok.txt', text: 'work\n' }],
    probePaths: ['.github/workflows/ci.yml'],
    args: [...ACK], // no --containment-tier
  });
  assertEqual(res.code, 0, `tier-1 run is unchanged (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'tier-1 default');
  const seen = probe(fx, res.runId);
  assertEqual(seen.cd, fx.dir, 'the role runs in the real checkout, exactly as at tier 1');
  assertEqual(seen.sees['.github/workflows/ci.yml'], true, 'nothing is withheld at tier 1');
  assert(!fs.existsSync(path.join(fx.home, '.verity', 'workspaces')), 'no workspace was created');
  const obj = resultObject(res);
  assertEqual(obj.containment_tier, 1, 'the DEFAULT tier is the one already proven');
  assert(!('containment_merged' in obj), 'no merge-back happened');
  assertEqual(read(fx, 'src/ok.txt'), 'work\n', 'tier-1 writes land directly, as before');
});

test('tier: the ACTIVE tier is visible in the result on every codex run', () => {
  const fx = fixture();
  const one = run(fx, { actions: [], args: [...ACK] });
  assertEqual(resultObject(one).containment_tier, 1, 'tier 1 reported');
  const two = run(fx, { actions: [], runId: 'c2-tier2' });
  assertEqual(resultObject(two).containment_tier, 2, 'tier 2 reported');
  assertLive(fx, two.runId, 'tier visibility');
});

test('tier: an unparsable --containment-tier is a usage error, never a silent tier 1', () => {
  const fx = fixture();
  for (const bad of ['3', '0', 'two']) {
    const res = run(fx, { args: [...ACK, '--containment-tier', bad] });
    assertEqual(res.code, 30, `--containment-tier ${bad} refused`);
    assert(res.stderr.includes('--containment-tier must be one of 1 | 2'), 'names the rule');
  }
  const keep = run(fx, { args: [...ACK, '--keep-workspace'] });
  assertEqual(keep.code, 30, '--keep-workspace without tier 2 is refused');
  assert(keep.stderr.includes('there is none without --containment-tier 2'), 'explains why');
});

test('tier: --containment-tier 2 with --agent claude is rejected (no shaped-workspace hooks)', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.roleDir, 'restricted.tools.json'), JSON.stringify(['Read']));
  let code = 0;
  let stderr = '';
  try {
    execFileSync(
      'node',
      [
        CLI,
        'agent-exec',
        'restricted',
        '--run-id',
        'c2-claude',
        '--agent',
        'claude',
        '--containment-tier',
        '2',
        '--cwd',
        fx.dir,
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, HOME: fx.home, VERITY_AGENT_BIN: fx.stub } },
    );
  } catch (err) {
    code = err.status;
    stderr = err.stderr || '';
  }
  assertEqual(code, 30);
  assert(stderr.includes('--containment-tier 2'), 'names the rejected flag');
  assert(stderr.includes('harness allowlist'), 'explains why claude has no tiers');
  assert(!fs.existsSync(path.join(fx.home, '.verity', 'workspaces')), 'nothing was materialized');
});

test('tier: claude opts OUT of the tier-2 hooks — its coordinator path is unchanged', () => {
  for (const hook of ['prepareWorkspace', 'mergeWorkspace', 'disposeWorkspace']) {
    assert(typeof codex[hook] === 'function', `codex declares ${hook}`);
    assert(claude[hook] === undefined, `claude declares no ${hook}`);
  }
});

test('workspace: the module is provider-NEUTRAL — it names no runtime', () => {
  const src = fs.readFileSync(path.join(LIB_DIR, 'agents', 'workspace.cjs'), 'utf8');
  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('//')) {
      continue; // the header explains WHY codex needs this; the code must not know
    }
    assert(
      !/\bcodex\b/i.test(line) && !/\bclaude\b/i.test(line),
      `agents/workspace.cjs must stay runtime-neutral, found: ${line.trim()}`,
    );
  }
  // The protected roots are the CALLER's data, never this module's.
  assertEqual(
    JSON.stringify(codex.PROTECTED_WRITE_PATHS),
    '[".github/",".verity/"]',
    'the driver owns the protected-root list it hands over',
  );
});

test('workspace: prepare/merge/cleanup unit cycle against a real repository', () => {
  const fx = fixture();
  const dir = path.join(fx.home, 'unit-ws');
  const ws = workspace.prepare({
    cwd: fx.dir,
    dir,
    policy: loaded(RESTRICTED),
    protectedPaths: codex.PROTECTED_WRITE_PATHS,
  });
  assertEqual(ws.path, dir);
  assertEqual(JSON.stringify(ws.withheld), '[".github",".verity"]', 'trailing slashes normalized');
  assert(!fs.existsSync(path.join(dir, '.github')), 'shaped: the root is absent');
  assertEqual(JSON.stringify(workspace.changes(ws)), '[]', 'a fresh workspace is clean');

  fs.writeFileSync(path.join(dir, 'src', 'app.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'src', 'added.txt'), 'new\n');
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'sneak.yml'), 'x\n');
  assertEqual(
    JSON.stringify(workspace.changes(ws)),
    '[{"path":".github/sneak.yml","change":"added"},{"path":"src/added.txt","change":"added"},{"path":"src/app.txt","change":"modified"}]',
    'the withheld-root scan sees what a SKIP_WORKTREE index entry could hide',
  );
  const verdict = workspace.merge(ws, loaded(RESTRICTED));
  assertEqual(verdict.merged.length, 0, 'nothing propagates when anything is rejected');
  assert(verdict.error.includes('.github/sneak.yml'), 'the error names the path');
  assertEqual(read(fx, 'src/app.txt'), 'baseline\n', 'the real repo is untouched');

  const disposal = workspace.cleanup(ws);
  assertEqual(disposal.removed, true, 'cleanup removes the workspace');
  assert(!fs.existsSync(dir), 'and it is really gone');
  assertEqual(
    JSON.stringify(workspace.cleanup(null)),
    '{"removed":false,"retained":false}',
    'cleanup of nothing is not an error',
  );
});
