// Stage 9 (ADR-0007 — the tested-denial requirement) — command-level policy
// enforcement for the Codex driver:
//   - `codex.commandRules()` generates the per-invocation rules document from
//     the role's `.permissions.json` (deterministic, capability-driven);
//   - the coordinator's --sandbox/--approval/--model override plumbing narrows
//     the loaded projection and never widens it;
//   - the FIVE negative tests: a restricted role demonstrably CANNOT write
//     outside the repo/work roots, read a protected credential file, run a
//     denied deploy command, modify .github/** / .verity/** against policy,
//     or bypass a human gate via a later lifecycle command — plus positive
//     controls proving the denials derive from policy, not hardcoding.
//
// The real Codex CLI is not available in CI, so the negatives run against an
// ENFORCING stub that evaluates the generated sandbox + rules exactly as the
// pinned release is documented to; the real-binary variants are the canary
// lane (docs/dev/codex-headless-canary.md §3) and the stage is not closed for
// real traffic until they have passed there.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const policy = require('../verity/bin/lib/agents/policy.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// Enforcing codex stand-in: parses the driver's argv (--sandbox, --cd, and
// the -c rules_file=<path> delivery), then evaluates every attempted action
// from STUB_ATTEMPTS ([{kind: 'write'|'read'|'command', target}]) against the
// generated rules the way the pinned real CLI is documented to enforce them:
// sandbox confines writes to writable_roots, denied_write_paths protect the
// config roots, denied_read_paths block credential-shaped reads, and
// denied_command_prefixes block command execution. Verdicts land in
// STUB_ENFORCE_FILE; the run then completes as a normal successful role.
const ENFORCING_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli 0.42.0\\n'); process.exit(0); }
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args));
fs.readFileSync(0, 'utf8'); // consume the prompt
const flag = (n) => args[args.indexOf(n) + 1];
const sandbox = flag('--sandbox');
const cd = flag('--cd');
const conf = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-c') { const kv = args[i + 1]; const eq = kv.indexOf('='); conf[kv.slice(0, eq)] = kv.slice(eq + 1); }
}
const rules = JSON.parse(fs.readFileSync(JSON.parse(conf.rules_file), 'utf8'));
const home = process.env.HOME;
const expand = (p) => (p.startsWith('~') ? home + p.slice(1) : p);
const inside = (target, root) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
function evaluate(a) {
  if (a.kind === 'write') {
    if (sandbox === 'read-only') return { allowed: false, rule: 'sandbox read-only' };
    if (!rules.writable_roots.some((r) => inside(a.target, r))) {
      return { allowed: false, rule: 'outside writable_roots' };
    }
    const rel = path.relative(cd, a.target);
    const hit = rules.denied_write_paths.find((p) => rel.startsWith(p));
    return hit ? { allowed: false, rule: 'denied_write_paths ' + hit } : { allowed: true };
  }
  if (a.kind === 'read') {
    const hit = rules.denied_read_paths.find((p) =>
      p.startsWith('~')
        ? a.target.startsWith(expand(p))
        : a.target.split('/').some((seg) => seg === p || seg.startsWith(p + '.')),
    );
    return hit ? { allowed: false, rule: 'denied_read_paths ' + hit } : { allowed: true };
  }
  const hit = rules.denied_command_prefixes.find(
    (p) => a.target === p || a.target.startsWith(p + ' '),
  );
  return hit ? { allowed: false, rule: 'denied_command_prefixes ' + hit } : { allowed: true };
}
const attempts = JSON.parse(process.env.STUB_ATTEMPTS || '[]');
fs.writeFileSync(
  process.env.STUB_ENFORCE_FILE,
  JSON.stringify(attempts.map((a) => ({ ...a, ...evaluate(a) })), null, 2),
);
const marker = 'Done.\\n{"verity":1,"outcome":"success","gate":null,"artifacts":{},"reason":"ok"}';
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: marker } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`;

// The restricted test role (ADR-0007's proof subject): repo writes only —
// NO deploy, NO github_write, NO network, NO write_protected_paths.
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

function fixture(permissions = RESTRICTED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-enforce-'));
  // The repo cwd and $HOME are SIBLINGS — a $HOME write must be outside the
  // writable root, exactly like the real layout.
  const dir = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(root, 'codex-stub');
  fs.writeFileSync(stub, ENFORCING_STUB);
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
  return {
    dir,
    home,
    stub,
    roleDir,
    argvFile: path.join(root, 'argv.json'),
    enforceFile: path.join(root, 'verdicts.json'),
  };
}

// One agent-exec run against the enforcing stub, attempting `attempts`;
// returns the per-attempt verdicts the stub recorded.
function attempt(fx, attempts, extraArgs = [], env = {}) {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_CODEX_BIN: fx.stub,
      VERITY_CLAUDE_BIN: '',
      VERITY_AGENT_BIN: '',
      STUB_ATTEMPTS: JSON.stringify(attempts),
      STUB_ENFORCE_FILE: fx.enforceFile,
      ...env,
    },
  };
  const argv = [
    CLI,
    'agent-exec',
    'restricted',
    'now',
    '--run-id',
    'enf-1',
    '--agent',
    'codex',
    '--cwd',
    fx.dir,
    '--json',
    ...extraArgs,
  ];
  try {
    return { out: execFileSync('node', argv, opts), stderr: '', code: 0, verdicts: verdicts(fx) };
  } catch (err) {
    return { out: err.stdout || '', stderr: err.stderr || '', code: err.status, verdicts: null };
  }
}

function verdicts(fx) {
  return JSON.parse(fs.readFileSync(fx.enforceFile, 'utf8'));
}

function assertDenied(v, ruleNeedle, label) {
  assertEqual(v.allowed, false, `${label} must be DENIED (got ${JSON.stringify(v)})`);
  assert(v.rule.includes(ruleNeedle), `${label}: denial names the rule (${v.rule})`);
}

// --- rules generation (unit) ---------------------------------------------------

test('commandRules: the restricted policy derives every expected denial', () => {
  const loaded = policy.loadPolicy(
    (() => {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-rules-')), 'r.json');
      fs.writeFileSync(f, JSON.stringify(RESTRICTED));
      return f;
    })(),
  );
  const rules = codex.commandRules(loaded, { cwd: '/repo' });
  assertEqual(rules.schema, 1);
  assertEqual(JSON.stringify(rules.writable_roots), '["/repo"]', 'repo root is the only root');
  assertEqual(rules.network, false);
  assert(rules.denied_command_prefixes.includes('gh pr merge'), 'merge authority always denied');
  assert(rules.denied_command_prefixes.includes('scripts/deploy'), 'deploy=false denies deploy');
  assert(rules.denied_command_prefixes.includes('npm publish'), 'deploy=false denies publish');
  assert(rules.denied_command_prefixes.includes('verity release'), 'lifecycle bypass denied');
  assert(rules.denied_command_prefixes.includes('gh pr create'), 'github_write=false denies gh');
  assert(!rules.denied_command_prefixes.includes('git push'), 'git_write=true keeps git mutations');
  assertEqual(
    JSON.stringify(rules.denied_write_paths),
    '[".github/",".verity/"]',
    'protected config roots denied without write_protected_paths',
  );
  assert(rules.denied_read_paths.includes('~/.aws'), 'credential reads always denied');
});

test('commandRules: the permissive policy drops exactly the capability-derived denials', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-rules-')), 'p.json');
  fs.writeFileSync(f, JSON.stringify(PERMISSIVE));
  const rules = codex.commandRules(policy.loadPolicy(f), { cwd: '/repo' });
  assertEqual(
    JSON.stringify(rules.denied_command_prefixes),
    '["gh pr merge"]',
    'merge authority is the ONLY denial left — it is never policy-erasable (T13)',
  );
  assertEqual(JSON.stringify(rules.denied_write_paths), '[]', 'protected paths granted');
  assertEqual(rules.network, true);
  assert(rules.denied_read_paths.includes('~/.codex'), 'credential reads still denied');
});

test('rules document travels with the invocation: written to the log dir, -c rules_file argv', () => {
  const fx = fixture();
  const res = attempt(fx, [], [], { STUB_ARGV_FILE: fx.argvFile });
  assertEqual(res.code, 0, `run completes (stderr: ${res.stderr})`);
  const rulesPath = path.join(fx.home, '.verity', 'logs', 'enf-1', 'restricted.rules.json');
  assert(fs.existsSync(rulesPath), 'rules document retained beside the transcript');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  assertEqual(JSON.stringify(rules.writable_roots), JSON.stringify([fx.dir]), 'cwd pinned');
});

// --- the five negative tests (ADR-0007) — against the enforcing stub -----------

test('negative 1: restricted role CANNOT write outside the repo/work roots', () => {
  const fx = fixture();
  const { code, verdicts: v } = attempt(fx, [
    { kind: 'write', target: '/tmp/evil.txt' },
    { kind: 'write', target: path.join(fx.home, 'escape.txt') },
  ]);
  assertEqual(code, 0);
  assertDenied(v[0], 'outside writable_roots', 'absolute /tmp write');
  assertDenied(v[1], 'outside writable_roots', '$HOME write');
});

test('negative 2: restricted role CANNOT read a protected credential file', () => {
  const fx = fixture();
  const { verdicts: v } = attempt(fx, [
    { kind: 'read', target: path.join(fx.home, '.aws', 'credentials') },
    { kind: 'read', target: path.join(fx.home, '.codex', 'auth.json') },
    { kind: 'read', target: path.join(fx.dir, '.env') },
  ]);
  assertDenied(v[0], 'denied_read_paths', 'aws credentials');
  assertDenied(v[1], 'denied_read_paths', 'codex auth');
  assertDenied(v[2], 'denied_read_paths', 'repo .env');
});

test('negative 3: restricted role CANNOT run a denied deploy command', () => {
  const fx = fixture();
  const { verdicts: v } = attempt(fx, [
    { kind: 'command', target: 'scripts/deploy prod' },
    { kind: 'command', target: 'npm publish' },
  ]);
  assertDenied(v[0], 'scripts/deploy', 'deploy script');
  assertDenied(v[1], 'npm publish', 'npm publish');
});

test('negative 4: restricted role CANNOT modify .github/** or .verity/** against policy', () => {
  const fx = fixture();
  const { verdicts: v } = attempt(fx, [
    { kind: 'write', target: path.join(fx.dir, '.github', 'workflows', 'pwn.yml') },
    { kind: 'write', target: path.join(fx.dir, '.verity', 'autonomy.yml') },
  ]);
  assertDenied(v[0], 'denied_write_paths .github/', 'workflow write');
  assertDenied(v[1], 'denied_write_paths .verity/', 'autonomy policy write');
});

test('negative 5: restricted role CANNOT bypass a gate via a later lifecycle command', () => {
  const fx = fixture();
  const { verdicts: v } = attempt(fx, [
    { kind: 'command', target: 'gh pr merge 7 --squash' }, // review:merge bypass
    { kind: 'command', target: 'verity release patch' }, // ship:prod bypass
    { kind: 'command', target: 'gh release create v1.0.0' },
  ]);
  assertDenied(v[0], 'gh pr merge', 'merge bypass');
  assertDenied(v[1], 'verity release', 'release bypass');
  assertDenied(v[2], 'gh release create', 'gh release bypass');
});

test('positive controls: allowed work still works, and denials derive from POLICY', () => {
  // The restricted role can still do its job inside the repo.
  const fx = fixture();
  const { verdicts: v } = attempt(fx, [
    { kind: 'write', target: path.join(fx.dir, 'src', 'ok.txt') },
    { kind: 'command', target: 'git status' },
    { kind: 'command', target: 'git push origin HEAD' }, // git_write: true
    { kind: 'read', target: path.join(fx.dir, 'README.md') },
  ]);
  for (const [i, label] of [
    'in-repo write',
    'read command',
    'granted git mutation',
    'ordinary read',
  ].entries()) {
    assertEqual(v[i].allowed, true, `${label} must be ALLOWED (${JSON.stringify(v[i])})`);
  }
  // The permissive policy flips the capability-derived denials to allowed —
  // proving the negative tests exercise generated rules, not a hardcoded stub.
  const px = fixture(PERMISSIVE);
  const { verdicts: pv } = attempt(px, [
    { kind: 'command', target: 'scripts/deploy prod' },
    { kind: 'write', target: path.join(px.dir, '.github', 'workflows', 'ok.yml') },
    { kind: 'command', target: 'gh pr merge 7 --squash' },
  ]);
  assertEqual(pv[0].allowed, true, 'deploy allowed when capabilities.deploy is granted');
  assertEqual(pv[1].allowed, true, '.github write allowed with write_protected_paths');
  assertDenied(pv[2], 'gh pr merge', 'merge authority is NEVER policy-erasable');
});

// --- override plumbing (--sandbox/--approval/--model) ---------------------------

test('override: --sandbox may narrow (read-only over workspace-write) — argv shows it', () => {
  const fx = fixture();
  const res = attempt(fx, [], ['--sandbox', 'read-only'], { STUB_ARGV_FILE: fx.argvFile });
  assertEqual(res.code, 0, `narrowing accepted (stderr: ${res.stderr})`);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[argv.indexOf('--sandbox') + 1], 'read-only', 'narrowed sandbox on the argv');
  const rules = JSON.parse(
    fs.readFileSync(
      path.join(fx.home, '.verity', 'logs', 'enf-1', 'restricted.rules.json'),
      'utf8',
    ),
  );
  assertEqual(
    JSON.stringify(rules.writable_roots),
    '[]',
    'rules regenerate from the NARROWED policy — read-only writes nothing',
  );
});

test('override: --sandbox CANNOT widen a read-only role → 30 bad-override, never invoked', () => {
  const readOnly = JSON.parse(JSON.stringify(RESTRICTED));
  readOnly.capabilities.write_repository = false;
  readOnly.codex.sandbox = 'read-only';
  const fx = fixture(readOnly);
  const res = attempt(fx, [], ['--sandbox', 'workspace-write'], { STUB_ARGV_FILE: fx.argvFile });
  assertEqual(res.code, 30);
  assert(res.stderr.includes('verity-agent-exec: 30 bad-override:'), 'stderr slug line');
  assert(res.stderr.includes('never widen'), 'names the rule');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

test('override: --approval CANNOT widen past never; danger-full-access rejected by name', () => {
  const fx = fixture();
  const widen = attempt(fx, [], ['--approval', 'on-request']);
  assertEqual(widen.code, 30);
  assert(widen.stderr.includes('bad-override'), 'approval widening refused');
  const danger = attempt(fx, [], ['--sandbox', 'danger-full-access']);
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
  attempt(fx, [], ['--model', 'gpt-5-codex'], { STUB_ARGV_FILE: fx.argvFile });
  let argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[argv.indexOf('--model') + 1], 'gpt-5-codex', 'model override on the argv');
  attempt(fx, [], [], { STUB_ARGV_FILE: fx.argvFile });
  argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assert(!argv.includes('--model'), 'no flag → no --model (stage-8 argv preserved)');
});

test('claude buildArgv: model is omitted-in — byte-identical without it', () => {
  const claude = require('../verity/bin/lib/agents/claude.cjs');
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
