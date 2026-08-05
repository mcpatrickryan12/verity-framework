// Stage 11 (ADR-0011 — containment, not restriction) — the tier-1 enforcement
// surface for the Codex driver, replacing stage 9's generated denial document
// (which the real-CLI spike proved binds NOTHING —
// docs/dev/codex-enforcement-spike-0.146.0.md F1/F3):
//   1. the theater is DELETED — grep-assertable, and no denial document is
//      written or referenced on any invocation;
//   2. CREDENTIAL STRIPPING — the child environment is constructed from an
//      enumerated passlist, so a credential the role's capabilities do not
//      grant is simply absent;
//   3. POST-RUN INVARIANTS — protected-path mutation, ref movement without
//      git_write, and any write by a role with an empty writable set are
//      detected, reverted where safe, and fail the run loudly;
//   4. the CAPABILITY HONESTY rule — a restriction with no enforcing mechanism
//      (today `network: false`) refuses the run (exit 30
//      `unenforceable-policy`) unless the operator acknowledged the gap, and
//      the acknowledgement is visible in the result.
//
// BINDING TEST RULE (issue #28, spike F4): every test that asserts a DENIAL
// makes the stub write a LIVENESS MARKER in the SAME invocation, after all its
// scripted actions. "Target absent" is a pass ONLY when the marker proves the
// command ran; a missing marker is an INVALID TEST, never a pass. The spike
// produced several false "DENIED ✓" readings before this rule existed.
//
// The real Codex CLI is not available in CI. Everything Verity itself owns
// (env construction, invariants, honesty rule) is EXERCISED FOR REAL here —
// only the model runtime is a stub, and the stub is an ADVERSARY: it performs
// exactly the writes/commands a misbehaving role would.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../verity/bin/lib/agents/claude.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const invariants = require('../verity/bin/lib/agents/invariants.cjs');
const policy = require('../verity/bin/lib/agents/policy.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const AGENTS_DIR = path.join(__dirname, '..', 'verity', 'bin', 'lib', 'agents');
// Read the pin rather than hardcoding it: stage 12 made `codexMinVersion`
// feature-derived, so a future evidence-driven bump must not turn this whole
// adversarial lane into version-too-old preflight failures.
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// Adversarial codex stand-in. Its instructions come from `.verity-stub.json`
// in the WORKSPACE (not the environment — the driver no longer passes one), so
// it is configured exactly like a real model would be: through the workspace it
// was given. It performs each scripted action, then — LAST, so its presence
// proves the whole body ran — writes the liveness marker beside the run's
// final-message file (outside the workspace, so it can never be mistaken for a
// workspace mutation).
const ACTOR_STUB = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli ${MIN_CODEX}\\n'); process.exit(0); }
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
const flag = (n) => args[args.indexOf(n) + 1];
const cwd = flag('--cd');
const logDir = path.dirname(flag('--output-last-message'));
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.verity-stub.json'), 'utf8'));
if (cfg.argvFile) fs.writeFileSync(cfg.argvFile, JSON.stringify(args));
if (cfg.envFile) fs.writeFileSync(cfg.envFile, JSON.stringify(process.env));
fs.readFileSync(0, 'utf8'); // consume the prompt
for (const action of cfg.actions || []) {
  try {
    if (action.write !== undefined) {
      const target = path.isAbsolute(action.write) ? action.write : path.join(cwd, action.write);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, action.text === undefined ? 'pwned\\n' : action.text);
    } else if (action.remove !== undefined) {
      fs.rmSync(path.join(cwd, action.remove), { force: true });
    } else if (action.git !== undefined) {
      execFileSync('git', action.git, { cwd, stdio: 'pipe' });
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

// The restricted test role (the proof subject): repo writes only — NO deploy,
// NO github_write, NO network, NO write_protected_paths.
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

// The permissive control: everything the restricted role lacks — proving each
// denial is DERIVED from the policy, not hardcoded into the mechanism.
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
// path, so every run of a restricted role must acknowledge it (or be refused).
const ACK_NETWORK = ['--acknowledge-gaps', 'network'];

function fixture(permissions = RESTRICTED, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-enforce-'));
  // The repo cwd, $HOME and the test's own scratch files are SIBLINGS — a
  // $HOME write is outside the writable root, exactly like the real layout,
  // and nothing the harness writes lands inside the workspace under test.
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
  // Pre-existing protected content: the invariant checker must notice a
  // MODIFICATION, not just a creation, and must restore the original bytes.
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'mode: manual\n');
  if (opts.git === true) {
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'verity@example.test']);
    git(['config', 'user.name', 'Verity Test']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline']);
  }
  return {
    root,
    dir,
    home,
    stub,
    roleDir,
    argvFile: path.join(root, 'argv.json'),
    envFile: path.join(root, 'env.json'),
  };
}

function logDir(fx, runId) {
  return path.join(fx.home, '.verity', 'logs', runId);
}

// The issue-#28 gate: a denial assertion is only meaningful if the command
// actually ran. Marker absent ⇒ INVALID TEST, never a pass.
function assertLive(fx, runId, label) {
  const marker = path.join(logDir(fx, runId), 'liveness.marker');
  assert(
    fs.existsSync(marker),
    `INVALID TEST (${label}): no liveness marker at ${marker} — the stub never completed its actions, so any "denied" reading is meaningless (spike F4 / issue #28)`,
  );
}

// One agent-exec run against the adversarial stub. `actions` is the script the
// stub performs inside the workspace; `env` seeds the PARENT environment (the
// credential-stripping subject).
function run(fx, opts = {}) {
  const runId = opts.runId || 'enf-1';
  fs.writeFileSync(
    path.join(fx.dir, '.verity-stub.json'),
    JSON.stringify({
      actions: opts.actions || [],
      argvFile: opts.argvFile === undefined ? null : opts.argvFile,
      envFile: opts.envFile === undefined ? null : opts.envFile,
    }),
  );
  const spawnOpts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_CODEX_BIN: fx.stub,
      VERITY_CLAUDE_BIN: '',
      VERITY_AGENT_BIN: '',
      ...(opts.env || {}),
    },
  };
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
    ...(opts.args === undefined ? ACK_NETWORK : opts.args),
  ];
  try {
    return { out: execFileSync('node', argv, spawnOpts), stderr: '', code: 0, runId };
  } catch (err) {
    return { out: err.stdout || '', stderr: err.stderr || '', code: err.status, runId };
  }
}

function resultObject(res) {
  const lines = String(res.out).split('\n').filter(Boolean);
  assertEqual(lines.length, 1, `exactly one result object on stdout (stderr: ${res.stderr})`);
  return JSON.parse(lines[0]);
}

function loaded(permissions) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-pol-')), 'r.permissions.json');
  fs.writeFileSync(f, JSON.stringify(permissions));
  return policy.loadPolicy(f);
}

// --- 1. the theater is deleted (grep-assertable) ---------------------------------

test('deleted: no generated-denial machinery survives anywhere in the driver layer', () => {
  const files = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.cjs'))
    .map((f) => path.join(AGENTS_DIR, f))
    .concat([path.join(__dirname, '..', 'verity', 'bin', 'lib', 'agent-exec.cjs')]);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const banned of ['rules_file', 'commandRules', 'rulesFilename']) {
      assert(
        !src.includes(banned),
        `${path.basename(file)} must not mention ${banned} — it enforced nothing (ADR-0011)`,
      );
    }
  }
  for (const banned of ['commandRules', 'rulesFilename']) {
    assert(!(banned in codex), `codex driver must not export ${banned}`);
  }
});

test('deleted: no denial document is emitted on the argv or written to the run log dir', () => {
  const fx = fixture();
  const res = run(fx, { argvFile: fx.argvFile });
  assertEqual(res.code, 0, `run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'argv/log-dir check');
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assert(
    argv.every((a) => !String(a).includes('rules_file')),
    `no denial-document config key on the argv (${JSON.stringify(argv)})`,
  );
  assertEqual(
    fs
      .readdirSync(logDir(fx, res.runId))
      .filter((f) => f.endsWith('.rules.json'))
      .join(','),
    '',
    'no per-role denial document beside the transcript',
  );
});

// --- 2. credential stripping (ADR-0011 layer 2) ----------------------------------

test('childEnv: the passlist is exactly what a toolchain needs — everything else is dropped', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    CODEX_HOME: '/home/x/.codex',
    HTTPS_PROXY: 'http://proxy:8080',
    OPENAI_API_KEY: 'sk-codex-own-auth',
    GH_TOKEN: 'ghp_secret',
    GITHUB_TOKEN: 'ghs_secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NPM_TOKEN: 'npm-secret',
    STRIPE_SECRET_KEY: 'sk_live_unknown_to_verity',
    RANDOM_INTERNAL_VAR: 'whatever',
  };
  const env = codex.childEnv(loaded(RESTRICTED), parent);
  for (const keep of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'CODEX_HOME', 'HTTPS_PROXY']) {
    assertEqual(env[keep], parent[keep], `${keep} is on the baseline passlist`);
  }
  assertEqual(env.OPENAI_API_KEY, parent.OPENAI_API_KEY, "the runtime's OWN auth survives");
  for (const dropped of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'STRIPE_SECRET_KEY',
    'RANDOM_INTERNAL_VAR',
  ]) {
    assert(!(dropped in env), `${dropped} must not reach the child`);
  }
  assert(
    !('STRIPE_SECRET_KEY' in env),
    'an allowlist drops credentials Verity has never heard of, by construction',
  );
});

test('childEnv: a credential is present ONLY when its capability grants it', () => {
  const parent = {
    PATH: '/usr/bin',
    GH_TOKEN: 'ghp_secret',
    GITHUB_TOKEN: 'ghs_secret',
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NPM_TOKEN: 'npm-secret',
  };
  const restricted = codex.childEnv(loaded(RESTRICTED), parent);
  assert(!('GH_TOKEN' in restricted) && !('NPM_TOKEN' in restricted), 'neither capability granted');

  const ghWrite = codex.childEnv(loaded(withCaps(RESTRICTED, { github_write: true })), parent);
  assertEqual(ghWrite.GH_TOKEN, 'ghp_secret', 'github_write grants the GitHub token');
  assertEqual(ghWrite.GITHUB_TOKEN, 'ghs_secret', 'both spellings travel together');
  assert(!('AWS_SECRET_ACCESS_KEY' in ghWrite), 'github_write grants NOTHING about deploys');

  const deploy = codex.childEnv(loaded(withCaps(RESTRICTED, { deploy: true })), parent);
  assertEqual(deploy.AWS_SECRET_ACCESS_KEY, 'aws-secret', 'deploy grants cloud credentials');
  assertEqual(deploy.NPM_TOKEN, 'npm-secret', 'deploy grants registry credentials');
  assert(!('GH_TOKEN' in deploy), 'deploy grants NOTHING about GitHub');

  // Every group is reachable from the capability table — no orphan credentials.
  for (const [capability, names] of Object.entries(codex.CAPABILITY_CREDENTIALS)) {
    const env = codex.childEnv(loaded(withCaps(RESTRICTED, { [capability]: true })), {
      ...parent,
      ...Object.fromEntries(names.map((n) => [n, `v-${n}`])),
    });
    for (const name of names) {
      assertEqual(env[name], `v-${name}`, `${capability} grants ${name}`);
    }
  }
});

test('credentials: e2e — a poisoned parent env does NOT reach the codex child (liveness-gated)', () => {
  const poison = {
    GH_TOKEN: 'ghp_leaked',
    GITHUB_TOKEN: 'ghs_leaked',
    AWS_SECRET_ACCESS_KEY: 'aws_leaked',
    NPM_TOKEN: 'npm_leaked',
    STRIPE_SECRET_KEY: 'sk_live_leaked',
  };
  const fx = fixture();
  const res = run(fx, { envFile: fx.envFile, env: poison });
  assertEqual(res.code, 0, `run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'credential absence'); // absence means nothing if it never ran
  const childEnv = JSON.parse(fs.readFileSync(fx.envFile, 'utf8'));
  for (const name of Object.keys(poison)) {
    assert(!(name in childEnv), `${name} must be ABSENT from the child environment`);
  }
  assert(!JSON.stringify(childEnv).includes('leaked'), 'no leaked VALUE under any other name');
  assertEqual(childEnv.HOME, fx.home, 'the baseline the toolchain needs is still there');
  assert(typeof childEnv.PATH === 'string' && childEnv.PATH !== '', 'PATH survives');

  // Positive control: the same token IS handed over when the capability grants
  // it — proving absence above is derived from policy, not from a broken spawn.
  const px = fixture(withCaps(RESTRICTED, { github_write: true }));
  const pres = run(px, { envFile: px.envFile, env: poison, runId: 'enf-2' });
  assertLive(px, pres.runId, 'credential presence control');
  const granted = JSON.parse(fs.readFileSync(px.envFile, 'utf8'));
  assertEqual(granted.GH_TOKEN, 'ghp_leaked', 'github_write → the token is present');
  assert(!('AWS_SECRET_ACCESS_KEY' in granted), 'and still nothing else');
});

test('credentials: claude is untouched — its child still inherits the parent environment', () => {
  assert(typeof claude.childEnv !== 'function', 'no env construction on the claude driver');
  const src = fs.readFileSync(path.join(AGENTS_DIR, 'claude.cjs'), 'utf8');
  assert(!/\benv:/.test(src), 'claude execute() passes no env — byte-identical to stage 10');
});

// --- 3. post-run invariants (ADR-0011 layer 5) -----------------------------------

test('invariants: a protected-path WRITE is caught, reverted, and fails the run', () => {
  const fx = fixture();
  const res = run(fx, {
    actions: [
      { write: '.github/workflows/pwn.yml', text: 'on: push\n' },
      { write: '.github/workflows/ci.yml', text: 'name: tampered\n' },
      { write: 'src/legit.txt', text: 'allowed work\n' }, // in-workspace: never a violation
    ],
  });
  assertLive(fx, res.runId, 'protected-path write');
  assertEqual(res.code, 20, `a containment breach fails the run (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'failed', 'the role claimed success — the invariant overrides it');
  assert(obj.error.includes('.github/workflows/pwn.yml'), `error names the path (${obj.error})`);
  assert(obj.error.includes('write_protected_paths'), 'error names the missing capability');
  assert(Array.isArray(obj.enforcement_violations), 'violations surfaced in the result');
  assertEqual(obj.enforcement_violations.length, 2, 'the created file AND the modified file');
  assert(res.stderr.includes('enforcement-violation'), 'loud on stderr too');
  // Hard revert: the created file is gone, the modified file is byte-restored.
  assert(
    !fs.existsSync(path.join(fx.dir, '.github', 'workflows', 'pwn.yml')),
    'created protected file reverted (deleted)',
  );
  assertEqual(
    fs.readFileSync(path.join(fx.dir, '.github', 'workflows', 'ci.yml'), 'utf8'),
    'name: ci\n',
    'modified protected file restored to its pre-run bytes',
  );
  assert(
    fs.existsSync(path.join(fx.dir, 'src', 'legit.txt')),
    'ordinary in-repo work is untouched',
  );
});

test('invariants: a .verity/** write is caught the same way (gitignored paths included)', () => {
  const fx = fixture();
  const res = run(fx, { actions: [{ write: '.verity/autonomy.yml', text: 'mode: autonomous\n' }] });
  assertLive(fx, res.runId, '.verity write');
  assertEqual(res.code, 20);
  const obj = resultObject(res);
  assert(obj.error.includes('.verity/autonomy.yml'), `names the path (${obj.error})`);
  assertEqual(
    fs.readFileSync(path.join(fx.dir, '.verity', 'autonomy.yml'), 'utf8'),
    'mode: manual\n',
    'the policy the worker reads is restored — a role cannot widen its own autonomy',
  );
});

test('invariants: write_protected_paths GRANTS the write — the denial derives from policy', () => {
  const fx = fixture(PERMISSIVE);
  const res = run(fx, {
    actions: [{ write: '.github/workflows/ok.yml', text: 'name: ok\n' }],
    args: [], // PERMISSIVE grants network → no acknowledgement needed
  });
  assertLive(fx, res.runId, 'granted protected write');
  assertEqual(res.code, 0, `granted write completes (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'success');
  assert(!('enforcement_violations' in obj), 'no violations on a permitted write');
  assertEqual(
    fs.readFileSync(path.join(fx.dir, '.github', 'workflows', 'ok.yml'), 'utf8'),
    'name: ok\n',
    'the write SURVIVES — nothing was reverted',
  );
});

test('invariants: ref movement without git_write is caught (real git worktree)', () => {
  const noGitWrite = withCaps(RESTRICTED, { git_write: false });
  const fx = fixture(noGitWrite, { git: true });
  const res = run(fx, {
    actions: [
      {
        git: [
          '-c',
          'user.email=a@b.test',
          '-c',
          'user.name=A',
          'commit',
          '--allow-empty',
          '-m',
          'sneaky',
        ],
      },
    ],
  });
  assertLive(fx, res.runId, 'ref movement');
  assertEqual(res.code, 20, `moving HEAD without git_write fails the run (${res.stderr})`);
  const obj = resultObject(res);
  assert(obj.error.includes('git_write'), `error names the missing capability (${obj.error})`);
  assert(
    obj.enforcement_violations.some((v) => v.kind === 'ref-movement'),
    'classified as ref movement',
  );
  assert(
    obj.error.includes('NOT reverted'),
    'a ref rewind is never attempted automatically — it is reported for manual review',
  );

  // Positive control: the same commit under git_write: true is ordinary work.
  const ok = fixture(RESTRICTED, { git: true });
  const okRes = run(ok, {
    actions: [
      {
        git: [
          '-c',
          'user.email=a@b.test',
          '-c',
          'user.name=A',
          'commit',
          '--allow-empty',
          '-m',
          'fine',
        ],
      },
    ],
    runId: 'enf-3',
  });
  assertLive(ok, okRes.runId, 'granted ref movement');
  assertEqual(okRes.code, 0, `git_write: true permits the commit (${okRes.stderr})`);
});

test('invariants: a read-only role may modify NOTHING (empty writable set)', () => {
  const readOnly = withCaps(RESTRICTED, { write_repository: false });
  readOnly.codex.sandbox = 'read-only';
  const fx = fixture(readOnly, { git: true });
  const res = run(fx, { actions: [{ write: 'src/sneaky.txt', text: 'nope\n' }] });
  assertLive(fx, res.runId, 'read-only write');
  assertEqual(res.code, 20, `read-only role writing anything fails the run (${res.stderr})`);
  const obj = resultObject(res);
  assert(
    obj.enforcement_violations.some(
      (v) => v.kind === 'outside-writable-set' && v.path.includes('sneaky'),
    ),
    `classified as outside the writable set (${JSON.stringify(obj.enforcement_violations)})`,
  );
  assertEqual(
    JSON.stringify(invariants.writableSet(loaded(readOnly), '/repo')),
    '[]',
    'read-only projects to an EMPTY writable set',
  );
  assertEqual(
    JSON.stringify(invariants.writableSet(loaded(RESTRICTED), '/repo')),
    '["/repo"]',
    'workspace-write projects to the workspace root — the boundary codex enforces',
  );
});

test('invariants: a clean run is unaffected — no violations, no extra result fields', () => {
  const fx = fixture();
  const res = run(fx, { actions: [{ write: 'src/ok.txt', text: 'work\n' }] });
  assertLive(fx, res.runId, 'clean run');
  assertEqual(res.code, 0, `clean run stays clean (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'success');
  assertEqual(obj.error, null);
  assert(!('enforcement_violations' in obj), 'nothing added to a clean result');
  assertEqual(res.stderr, '', 'nothing on stderr');
});

test('invariants: unit — snapshot/diff/revert semantics, including a DELETED protected file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-inv-'));
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'CODEOWNERS'), '* @owner\n');
  const before = invariants.capture(dir, { protectedPaths: codex.PROTECTED_WRITE_PATHS });
  fs.rmSync(path.join(dir, '.github', 'CODEOWNERS'));
  const verdict = invariants.enforce(before, loaded(RESTRICTED));
  assertEqual(verdict.violations.length, 1, 'a deletion is a mutation');
  assertEqual(verdict.violations[0].change, 'deleted');
  assertEqual(
    fs.readFileSync(path.join(dir, '.github', 'CODEOWNERS'), 'utf8'),
    '* @owner\n',
    'deleted protected file restored from the pre-run bytes',
  );
  // Second pass: with the file restored, the workspace is clean again.
  const clean = invariants.enforce(
    invariants.capture(dir, { protectedPaths: codex.PROTECTED_WRITE_PATHS }),
    loaded(RESTRICTED),
  );
  assertEqual(clean.violations.length, 0, 'a clean workspace produces no violations');
  assertEqual(clean.error, null);
});

test('invariants: claude opts OUT — no hooks, so its coordinator path is unchanged', () => {
  for (const hook of ['captureInvariants', 'checkInvariants', 'checkEnforceable']) {
    assert(typeof codex[hook] === 'function', `codex declares ${hook}`);
    assert(claude[hook] === undefined, `claude declares no ${hook} (enforced by its allowlist)`);
  }
});

// --- 4. the capability honesty rule (ADR-0011, fail closed) ----------------------

test('honesty: the mechanism table classifies EVERY capability exactly once', () => {
  const mapped = Object.keys(policy.ENFORCEMENT_MECHANISMS);
  for (const key of policy.CAPABILITY_KEYS) {
    const inMechanisms = mapped.includes(key);
    const inAdvisory = policy.ADVISORY_CAPABILITIES.includes(key);
    assert(
      inMechanisms !== inAdvisory,
      `${key} must be classified exactly once (mechanism ${inMechanisms}, advisory ${inAdvisory}) — a new capability may never be silently "enforced"`,
    );
  }
  for (const [cap, mechanism] of Object.entries(policy.ENFORCEMENT_MECHANISMS)) {
    assert(
      mechanism === null || policy.MECHANISMS.includes(mechanism),
      `${cap} names a real mechanism (${mechanism})`,
    );
  }
  assertEqual(policy.ENFORCEMENT_MECHANISMS.network, null, 'network denial has NO mechanism (F1)');
  assertEqual(
    policy.ENFORCEMENT_MECHANISMS.github_write,
    'credential-stripping',
    'github_write is enforced by the absent token, not by a command denial',
  );
  assertEqual(policy.ENFORCEMENT_MECHANISMS.write_protected_paths, 'post-run-invariants');
});

test('honesty: enforcementGaps reports restrictions only — a GRANT is never a gap', () => {
  assertEqual(JSON.stringify(policy.enforcementGaps(loaded(RESTRICTED))), '["network"]');
  assertEqual(
    JSON.stringify(policy.enforcementGaps(loaded(PERMISSIVE))),
    '[]',
    'network: true grants — nothing to enforce, nothing to acknowledge',
  );
});

test('honesty: an unenforceable restriction REFUSES the run — 30 unenforceable-policy', () => {
  const fx = fixture();
  const res = run(fx, { actions: [{ write: 'src/x.txt' }], args: [] }); // no acknowledgement
  assertEqual(res.code, 30);
  assert(
    res.stderr.includes('verity-agent-exec: 30 unenforceable-policy:'),
    `stderr slug line (${res.stderr})`,
  );
  assert(res.stderr.includes('network: false'), 'names the restriction it cannot enforce');
  assert(res.stderr.includes('acknowledged_enforcement_gaps'), 'names the way out');
  assertEqual(resultObject(res).outcome, 'infra_error');
  // The refusal is real, not a broken fixture: the SAME fixture runs (and the
  // stub proves liveness) the moment the gap is acknowledged.
  assert(
    !fs.existsSync(path.join(logDir(fx, res.runId), 'liveness.marker')),
    'agent never invoked',
  );
  const acked = run(fx, { actions: [{ write: 'src/x.txt' }], runId: 'enf-4' });
  assertEqual(acked.code, 0, `acknowledged run proceeds (${acked.stderr})`);
  assertLive(fx, acked.runId, 'acknowledged control');
});

// REGRESSION, issue #42 (stage 16). The honesty gate is a PURE-POLICY decision
// — it reads two files and nothing else — but it used to run AFTER
// resolveBinary/checkVersion, and checkVersion shells out to `codex login
// status`. So the real CLI was invoked before the refusal that is specified to
// precede it, and on the real-CLI lane every `unenforceable-policy` refusal
// came back as `agent-unauthenticated` instead: the gap was masked by an
// auth probe that has nothing to do with it. dispatch() now loads the policy
// and runs checkEnforceable FIRST, so the refusal holds with no usable binary
// at all.
test('honesty: the refusal PRECEDES the binary/auth preflight — issue #42', () => {
  const fx = fixture();
  // (a) no binary whatsoever: the pure-policy refusal still wins.
  const absent = run(fx, {
    args: [],
    runId: 'enf-order-1',
    env: { VERITY_CODEX_BIN: path.join(fx.root, 'no-such-codex') },
  });
  assertEqual(absent.code, 30);
  assert(
    absent.stderr.includes('verity-agent-exec: 30 unenforceable-policy:'),
    `pure-policy refusal, not a preflight failure (${absent.stderr})`,
  );
  assert(
    !absent.stderr.includes('agent-missing'),
    'the binary probe never got to speak for the honesty gate',
  );
  // (b) a present but UNAUTHENTICATED binary — the exact masking the real
  // canary hit: `agent-unauthenticated` reported for a policy problem.
  const unauth = path.join(fx.root, 'codex-unauth');
  fs.writeFileSync(
    unauth,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli ${MIN_CODEX}\\n'); process.exit(0); }
if (args[0] === 'login') { process.stderr.write('Not logged in\\n'); process.exit(1); }
process.exit(0);
`,
  );
  fs.chmodSync(unauth, 0o755);
  const masked = run(fx, { args: [], runId: 'enf-order-2', env: { VERITY_CODEX_BIN: unauth } });
  assertEqual(masked.code, 30);
  assert(
    masked.stderr.includes('verity-agent-exec: 30 unenforceable-policy:'),
    `auth state cannot mask a policy refusal (${masked.stderr})`,
  );
  assert(!masked.stderr.includes('agent-unauthenticated'), 'the auth probe never spoke');
  // LIVENESS (issue #28) for the "never invoked" claim: the SAME fixture, with
  // the gap acknowledged and a working binary, really does invoke codex. And
  // acknowledged + broken binary still reaches the preflight — the check was
  // reordered, not deleted.
  assert(
    !fs.existsSync(path.join(logDir(fx, 'enf-order-1'), 'liveness.marker')),
    'agent never invoked',
  );
  const stillChecked = run(fx, {
    runId: 'enf-order-3',
    env: { VERITY_CODEX_BIN: path.join(fx.root, 'no-such-codex') },
  });
  assert(
    stillChecked.stderr.includes('verity-agent-exec: 30 agent-missing:'),
    `the preflight still runs once the policy passes (${stillChecked.stderr})`,
  );
  const control = run(fx, { actions: [{ write: 'src/x.txt' }], runId: 'enf-order-4' });
  assertEqual(control.code, 0, `acknowledged control proceeds (${control.stderr})`);
  assertLive(fx, control.runId, 'honesty-before-auth control');
});

test('honesty: an acknowledged gap runs and is VISIBLE in the result', () => {
  const fx = fixture();
  const res = run(fx);
  assertEqual(res.code, 0, `acknowledged run completes (${res.stderr})`);
  assertLive(fx, res.runId, 'acknowledgement visibility');
  const obj = resultObject(res);
  assertEqual(
    JSON.stringify(obj.enforcement_gaps_acknowledged),
    '["network"]',
    'the admission travels in the result — never a silent allowance',
  );
});

test('honesty: a role that GRANTS network needs no acknowledgement; the field stays absent', () => {
  const fx = fixture(PERMISSIVE);
  const res = run(fx, { args: [] });
  assertEqual(res.code, 0, `no gap, no acknowledgement needed (${res.stderr})`);
  assertLive(fx, res.runId, 'no-gap run');
  assert(
    !('enforcement_gaps_acknowledged' in resultObject(res)),
    'nothing acknowledged → the field is absent, not an empty array',
  );
});

test('honesty: a typo in the acknowledgement is loud (30 bad-acknowledgement), never silent', () => {
  const fx = fixture();
  const res = run(fx, { args: ['--acknowledge-gaps', 'netwrok'] });
  assertEqual(res.code, 30);
  assert(res.stderr.includes('bad-acknowledgement'), `stderr slug line (${res.stderr})`);
  assert(res.stderr.includes('netwrok'), 'names the unknown capability');
  assert(!fs.existsSync(path.join(logDir(fx, res.runId), 'liveness.marker')), 'never invoked');
});

test('honesty: --acknowledge-gaps with --agent claude is rejected (nothing to acknowledge)', () => {
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
        'enf-claude',
        '--agent',
        'claude',
        '--acknowledge-gaps',
        'network',
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
  assert(stderr.includes('acknowledge-gaps'), 'names the rejected flag');
  assert(stderr.includes('harness allowlist'), 'explains why claude has no gap');
});

test('honesty: assertEnforceable is fail-closed at the unit level too', () => {
  let thrown = null;
  try {
    policy.assertEnforceable(loaded(RESTRICTED), []);
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== null, 'no acknowledgement → throws');
  assertEqual(thrown.slug, 'unenforceable-policy');
  assertEqual(thrown.exitCode, 30);
  assertEqual(
    JSON.stringify(policy.assertEnforceable(loaded(RESTRICTED), ['network'])),
    '["network"]',
    'returns the acknowledgements that actually applied',
  );
  assertEqual(
    JSON.stringify(policy.assertEnforceable(loaded(PERMISSIVE), ['network'])),
    '[]',
    'acknowledging a non-gap applies nothing (and is not an error)',
  );
});

// --- override plumbing (--sandbox/--approval/--model) ---------------------------

test('override: --sandbox may narrow (read-only over workspace-write) — argv shows it', () => {
  const fx = fixture();
  const res = run(fx, { args: [...ACK_NETWORK, '--sandbox', 'read-only'], argvFile: fx.argvFile });
  assertEqual(res.code, 0, `narrowing accepted (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'narrowed sandbox');
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[argv.indexOf('--sandbox') + 1], 'read-only', 'narrowed sandbox on the argv');
});

test('override: --sandbox CANNOT widen a read-only role → 30 bad-override, never invoked', () => {
  const readOnly = withCaps(RESTRICTED, { write_repository: false });
  readOnly.codex.sandbox = 'read-only';
  const fx = fixture(readOnly);
  const res = run(fx, {
    args: [...ACK_NETWORK, '--sandbox', 'workspace-write'],
    argvFile: fx.argvFile,
  });
  assertEqual(res.code, 30);
  assert(res.stderr.includes('verity-agent-exec: 30 bad-override:'), 'stderr slug line');
  assert(res.stderr.includes('never widen'), 'names the rule');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

test('override: --approval CANNOT widen past never; danger-full-access rejected by name', () => {
  const fx = fixture();
  const widen = run(fx, { args: [...ACK_NETWORK, '--approval', 'on-request'] });
  assertEqual(widen.code, 30);
  assert(widen.stderr.includes('bad-override'), 'approval widening refused');
  const danger = run(fx, { args: [...ACK_NETWORK, '--sandbox', 'danger-full-access'] });
  assertEqual(danger.code, 30);
  assert(danger.stderr.includes('danger-full-access'), 'named rejection, no override path');
});

test('override: --sandbox with --agent claude is rejected (allowlist-governed runtime)', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.roleDir, 'restricted.tools.json'), JSON.stringify(['Read']));
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, HOME: fx.home, VERITY_AGENT_BIN: fx.stub, VERITY_CLAUDE_BIN: '' },
  };
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
        'enf-2',
        '--agent',
        'claude',
        '--sandbox',
        'read-only',
        '--cwd',
        fx.dir,
        '--json',
      ],
      opts,
    );
  } catch (err) {
    code = err.status;
    stderr = err.stderr || '';
  }
  assertEqual(code, 30);
  assert(stderr.includes('.tools.json'), 'error explains the claude permission surface');
});

test('override: --model reaches the codex argv; absent flag leaves the argv model-free', () => {
  const fx = fixture();
  run(fx, { args: [...ACK_NETWORK, '--model', 'gpt-5-codex'], argvFile: fx.argvFile });
  let argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[argv.indexOf('--model') + 1], 'gpt-5-codex', 'model override on the argv');
  run(fx, { argvFile: fx.argvFile });
  argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assert(!argv.includes('--model'), 'no flag → no --model (stage-8 argv preserved)');
});

test('claude buildArgv: model is omitted-in — byte-identical without it', () => {
  const base = claude.buildArgv({ prompt: 'p', maxTurns: 5, allowlist: ['Read'] });
  assert(!base.includes('--model'), 'no model → no flag');
  const withModel = claude.buildArgv({
    prompt: 'p',
    maxTurns: 5,
    allowlist: ['Read'],
    model: 'claude-opus-4',
  });
  assertEqual(withModel[withModel.indexOf('--model') + 1], 'claude-opus-4');
  assertEqual(
    JSON.stringify(withModel.filter((a, i) => a !== '--model' && withModel[i - 1] !== '--model')),
    JSON.stringify(base),
    'everything else unchanged',
  );
});

// --- schema artifact matches policy.cjs (contract requirement) ------------------

test('schemas/role-permissions.schema.json mirrors policy.cjs exactly', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'role-permissions.schema.json'), 'utf8'),
  );
  assertEqual(
    JSON.stringify(schema.required),
    '["schema_version","capabilities","codex"]',
    'required top-level fields',
  );
  assertEqual(schema.properties.schema_version.const, 1, 'schema_version pinned to 1');
  for (const key of policy.CAPABILITY_KEYS) {
    assert(key in schema.properties.capabilities.properties, `capability ${key} published`);
    assertEqual(
      schema.properties.capabilities.properties[key].default,
      false,
      `${key} defaults closed`,
    );
  }
  assertEqual(
    JSON.stringify(schema.properties.codex.properties.sandbox.enum),
    JSON.stringify(policy.SANDBOXES),
    'sandbox enum matches — danger-full-access is NOT representable',
  );
  assertEqual(
    JSON.stringify(schema.properties.codex.properties.approval.enum),
    JSON.stringify(policy.APPROVALS),
    'approval enum matches',
  );
  assertEqual(
    JSON.stringify(schema.properties.codex.required),
    '["sandbox"]',
    'sandbox is the only required projection field (approval defaults never)',
  );
});
