// Stage 8 (ADR-0005/0007/0008) — the Codex headless driver
// (`agent-exec --agent codex`), the fail-closed role capability policy
// (policy.cjs + the packaged .permissions.json corpus), the structured
// role-outcome schema (schemas/agent-result.schema.json), the provider-neutral
// --timeout-secs limit, and the provider-contract suite run against BOTH
// drivers (stage 7's characterization set generalized). Everything runs
// through stub binaries — the real Codex CLI is never invoked in CI; the
// pinned flag spellings are re-verified by the manual canary
// (docs/dev/codex-headless-canary.md).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../verity/bin/lib/agents/claude.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const registry = require('../verity/bin/lib/agents/index.cjs');
const policy = require('../verity/bin/lib/agents/policy.cjs');
const { validateRoleOutcome } = require('../verity/bin/lib/agents/result-contract.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'agents');
const ROLES_DIR = path.join(__dirname, '..', 'commands', 'verity');

const FX = {
  success: path.join(FIXTURES, 'codex-success.jsonl'),
  gated: path.join(FIXTURES, 'codex-gated.jsonl'),
  failed: path.join(FIXTURES, 'codex-failed.jsonl'),
  turnFailed: path.join(FIXTURES, 'codex-turn-failed.jsonl'),
  malformed: path.join(FIXTURES, 'codex-malformed.jsonl'),
  unknownEvents: path.join(FIXTURES, 'codex-unknown-events.jsonl'),
  finalCompleted: path.join(FIXTURES, 'codex-final-completed.json'),
  finalGated: path.join(FIXTURES, 'codex-final-gated.json'),
  finalFailed: path.join(FIXTURES, 'codex-final-failed.json'),
};

// Stub codex binary (codex-support.md §15.4, mirroring the claude stub seam):
// answers --version (STUB_CODEX_VERSION) and `login status`
// (STUB_CODEX_UNAUTH → exit 1); on exec it records argv (STUB_ARGV_FILE) and
// the exact stdin bytes (STUB_STDIN_FILE), replays STUB_TRANSCRIPT on stdout,
// writes the --output-last-message file from STUB_FINAL_FILE, and either
// exits STUB_EXIT or hangs (STUB_HANG — the timeout seam).
const CODEX_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli ' + (process.env.STUB_CODEX_VERSION || '0.42.0') + '\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.STUB_CODEX_UNAUTH) { process.stderr.write('Not logged in\\n'); process.exit(1); }
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args));
if (process.env.STUB_ENV_FILE) fs.writeFileSync(process.env.STUB_ENV_FILE, JSON.stringify(Object.keys(process.env)));
const stdin = fs.readFileSync(0, 'utf8');
if (process.env.STUB_STDIN_FILE) fs.writeFileSync(process.env.STUB_STDIN_FILE, stdin);
if (process.env.STUB_TRANSCRIPT) process.stdout.write(fs.readFileSync(process.env.STUB_TRANSCRIPT, 'utf8'));
const fi = args.indexOf('--output-last-message');
if (fi >= 0 && process.env.STUB_FINAL_FILE) fs.copyFileSync(process.env.STUB_FINAL_FILE, args[fi + 1]);
if (process.env.STUB_HANG) setTimeout(() => {}, 60000);
else process.exit(Number(process.env.STUB_EXIT || 0));
`;

// Stub claude binary — the agents.test.cjs stub plus the STUB_HANG timeout seam.
const CLAUDE_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write((process.env.STUB_VERSION || '2.1.170') + ' (Claude Code)\\n');
  process.exit(0);
}
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args));
if (process.env.STUB_TRANSCRIPT) process.stdout.write(fs.readFileSync(process.env.STUB_TRANSCRIPT, 'utf8'));
if (process.env.STUB_HANG) setTimeout(() => {}, 60000);
else process.exit(Number(process.env.STUB_EXIT || 0));
`;

// A scratch role with BOTH permission surfaces: the Claude .tools.json
// allowlist and the runtime-neutral .permissions.json capability policy.
const ECHO_TOOLS = ['Read', 'Grep', 'Bash(git *)'];
const ECHO_PERMISSIONS = {
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
  codex: {
    sandbox: 'workspace-write',
    approval: 'never',
    ignore_user_config: true,
    ignore_rules: false,
  },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-codex-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const codexStub = path.join(dir, 'codex-stub');
  fs.writeFileSync(codexStub, CODEX_STUB);
  fs.chmodSync(codexStub, 0o755);
  const claudeStub = path.join(dir, 'claude-stub');
  fs.writeFileSync(claudeStub, CLAUDE_STUB);
  fs.chmodSync(claudeStub, 0o755);
  const roleDir = path.join(dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), '---\nname: echo\n---\nEcho $ARGUMENTS\n');
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), JSON.stringify(ECHO_TOOLS));
  fs.writeFileSync(
    path.join(roleDir, 'echo.permissions.json'),
    JSON.stringify(ECHO_PERMISSIONS, null, 2),
  );
  return {
    dir,
    home,
    roleDir,
    codexStub,
    claudeStub,
    argvFile: path.join(dir, 'argv.json'),
    stdinFile: path.join(dir, 'stdin.txt'),
    transcriptFile: path.join(dir, 'canned.jsonl'),
  };
}

// Run agent-exec against the codex stub. STUB_TRANSCRIPT defaults to the
// success fixture (marker path); tests opt into a final-message file with
// STUB_FINAL_FILE.
function runCodex(fx, args, env = {}) {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_CODEX_BIN: fx.codexStub,
      VERITY_CLAUDE_BIN: '',
      VERITY_AGENT_BIN: '',
      STUB_ARGV_FILE: fx.argvFile,
      STUB_STDIN_FILE: fx.stdinFile,
      STUB_TRANSCRIPT: FX.success,
      ...env,
    },
  };
  const argv = [CLI, 'agent-exec', ...args, '--agent', 'codex', '--cwd', fx.dir, '--json'];
  try {
    return { out: execFileSync('node', argv, opts), stderr: '', code: 0 };
  } catch (err) {
    return { out: err.stdout || '', stderr: err.stderr || '', code: err.status };
  }
}

function parseSingleObject(out) {
  const lines = out.split('\n').filter(Boolean);
  assertEqual(lines.length, 1, 'exactly one result object on stdout');
  const obj = JSON.parse(lines[0]);
  assertEqual(obj.schema, 1, 'schema must be 1');
  return obj;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// --- registry / dark-launch: codex only on explicit --agent codex ---

test('registry: codex registered beside claude; DEFAULT agent remains claude', () => {
  assertEqual(registry.getProvider('codex'), codex, 'registry hands out codex.cjs itself');
  assertEqual(codex.id, 'codex');
  assertEqual(codex.displayName, 'OpenAI Codex CLI');
  // Kill-switch/dark-launch: no --agent flag → the claude driver runs.
  const fx = fixture();
  fs.writeFileSync(
    fx.transcriptFile,
    `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })}\n`,
  );
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_AGENT_BIN: fx.claudeStub,
      VERITY_CLAUDE_BIN: '',
      STUB_ARGV_FILE: fx.argvFile,
      STUB_TRANSCRIPT: fx.transcriptFile,
    },
  };
  execFileSync(
    'node',
    [CLI, 'agent-exec', 'echo', 'hi', '--run-id', 'd-1', '--cwd', fx.dir, '--json'],
    opts,
  );
  const argv = readJson(fx.argvFile);
  assertEqual(argv[0], '-p', 'without --agent, the CLAUDE headless argv ran');
});

// --- binary selection & preflight (version + auth) ---

test('resolveBinary: VERITY_CODEX_BIN → legacy VERITY_AGENT_BIN → `codex`', () => {
  assertEqual(codex.resolveBinary({ VERITY_CODEX_BIN: '/c', VERITY_AGENT_BIN: '/a' }), '/c');
  assertEqual(codex.resolveBinary({ VERITY_AGENT_BIN: '/a' }), '/a', 'legacy seam preserved');
  assertEqual(codex.resolveBinary({}), 'codex', 'provider default last');
  assertEqual(codex.binaryEnvVar, 'VERITY_CODEX_BIN');
  assertEqual(codex.defaultBinary, 'codex');
});

test('seam: VERITY_CODEX_BIN beats a broken VERITY_AGENT_BIN end-to-end', () => {
  const fx = fixture();
  const { code } = runCodex(fx, ['echo', 'hi', '--run-id', 'b-1'], {
    VERITY_AGENT_BIN: path.join(fx.dir, 'no-such-codex'),
  });
  assertEqual(code, 0, 'the provider-specific override ran');
  assert(fs.existsSync(fx.argvFile), 'stub invoked via VERITY_CODEX_BIN');
});

test('missing codex binary → 30, slug agent-missing', () => {
  const fx = fixture();
  const { out, stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'b-2'], {
    VERITY_CODEX_BIN: path.join(fx.dir, 'no-such-codex'),
  });
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 agent-missing:'), 'stderr slug line');
});

test('codex below verity.codexMinVersion → 30 version-too-old naming the pin', () => {
  const fx = fixture();
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'b-3'], {
    STUB_CODEX_VERSION: '0.1.0',
  });
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 version-too-old:'), 'stderr slug line');
  assert(stderr.includes('0.1.0'), 'names the found version');
  assert(stderr.includes(codex.MIN_CODEX_VERSION), 'names the pinned minimum');
});

test('unauthenticated codex (`login status` nonzero) → 30, remedy named, never invoked', () => {
  const fx = fixture();
  const { out, stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'b-4'], {
    STUB_CODEX_UNAUTH: '1',
  });
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 agent-unauthenticated:'), 'stderr slug line');
  assert(stderr.includes('codex login'), 'names the remedy');
  assert(!fs.existsSync(fx.argvFile), 'exec never ran (argv only recorded on exec)');
});

// --- invocation contract (argv + stdin) ---

test('argv: exec --json --sandbox <policy> --output-last-message --cd, prompt via `-`', () => {
  const fx = fixture();
  const { code } = runCodex(fx, ['echo', 'hi', '--run-id', 'i-1']);
  assertEqual(code, 0);
  const argv = readJson(fx.argvFile);
  assertEqual(argv[0], 'exec', 'subcommand first');
  assert(argv.includes('--json'), 'JSONL event stream requested');
  assertEqual(argv[argv.indexOf('--sandbox') + 1], 'workspace-write', 'sandbox from the policy');
  const finalPath = argv[argv.indexOf('--output-last-message') + 1];
  assertEqual(
    finalPath,
    path.join(fx.home, '.verity', 'logs', 'i-1', 'echo.final.json'),
    'final-message file under the run log dir',
  );
  assertEqual(argv[argv.indexOf('--cd') + 1], fx.dir, 'repo root is explicit');
  assert(argv.includes('approval_policy="never"'), 'approval policy explicit (never)');
  assert(argv.includes('ignore_user_config=true'), 'user-config isolation explicit (ADR-0007)');
  assertEqual(argv[argv.length - 1], '-', 'prompt arrives over stdin, not argv');
});

test('argv: Claude-only flags NEVER sent to codex', () => {
  const fx = fixture();
  runCodex(fx, ['echo', 'hi', '--run-id', 'i-2']);
  const joined = readJson(fx.argvFile).join(' ');
  for (const forbidden of [
    '--allowed-tools',
    '--max-turns',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
  ]) {
    assert(!joined.includes(forbidden), `codex argv must not contain ${forbidden}`);
  }
});

test('stdin: rendered prompt arrives unchanged; $ARGUMENTS resolved via the codex pass', () => {
  const fx = fixture();
  runCodex(fx, ['echo', 'hi', '--run-id', 'i-3']);
  const stdin = fs.readFileSync(fx.stdinFile, 'utf8');
  assertEqual(
    stdin,
    codex.renderPrompt(path.join(fx.roleDir, 'echo.md'), ['hi']),
    'exact prompt bytes',
  );
  assert(stdin.includes('Echo hi'), 'role args substituted');
  assert(!stdin.includes('$ARGUMENTS'), 'no raw placeholder remains');
  assert(!stdin.includes('<invocation arguments>'), 'no codex placeholder remains');
  assert(!stdin.startsWith('---'), 'frontmatter stripped');
  assert(stdin.includes('<headless-result-contract>'), 'shared headless footer appended');
});

test('renderPrompt: packaged role gets codex host-pass transforms + role args', () => {
  // build.md carries $ARGUMENTS (ADR-0005 survey: build + review only)
  const prompt = codex.renderPrompt(path.join(ROLES_DIR, 'build.md'), ['7']);
  assert(!prompt.includes('$ARGUMENTS'), 'role args resolved');
  assert(!prompt.includes('<invocation arguments>'), 'codex placeholder resolved');
  assert(!prompt.includes('/verity:'), 'cross-role handoffs rewritten by the codex pass');
  assert(prompt.includes('$verity-'), 'handoffs use explicit codex skill invocation');
  assert(prompt.includes('<headless-result-contract>'), 'result contract appended');
});

test('env: Verity adds no unexpected variables (secrets seam) to the codex child', () => {
  const fx = fixture();
  const envFile = path.join(fx.dir, 'env.json');
  runCodex(fx, ['echo', 'hi', '--run-id', 'e-1'], { STUB_ENV_FILE: envFile });
  const childKeys = readJson(envFile);
  const parentKeys = new Set([
    ...Object.keys(process.env),
    'HOME',
    'VERITY_CODEX_BIN',
    'VERITY_CLAUDE_BIN',
    'VERITY_AGENT_BIN',
    'STUB_ARGV_FILE',
    'STUB_STDIN_FILE',
    'STUB_TRANSCRIPT',
    'STUB_ENV_FILE',
  ]);
  const added = childKeys.filter((k) => !parentKeys.has(k));
  assertEqual(
    JSON.stringify(added),
    '[]',
    'child env is exactly the caller env — nothing injected',
  );
});

test('per-run output paths are unique; transcript + final message retained verbatim', () => {
  const fx = fixture();
  runCodex(fx, ['echo', 'hi', '--run-id', 'u-1'], { STUB_FINAL_FILE: FX.finalCompleted });
  runCodex(fx, ['echo', 'hi', '--run-id', 'u-2'], { STUB_FINAL_FILE: FX.finalCompleted });
  for (const runId of ['u-1', 'u-2']) {
    const dir = path.join(fx.home, '.verity', 'logs', runId);
    assertEqual(
      fs.readFileSync(path.join(dir, 'echo.codex.jsonl'), 'utf8'),
      fs.readFileSync(FX.success, 'utf8'),
      `${runId}: raw JSONL transcript preserved verbatim`,
    );
    assert(fs.existsSync(path.join(dir, 'echo.final.json')), `${runId}: final message retained`);
  }
});

// --- limits (ADR-0008) ---

test('--max-turns with --agent codex → clear usage error, never silently ignored', () => {
  const fx = fixture();
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'l-1', '--max-turns', '5']);
  assertEqual(code, 30);
  assert(stderr.includes('max-turns'), 'error names the rejected flag');
  assert(stderr.includes('timeout-secs'), 'error points at the provider-neutral limit');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

test('--timeout-secs must be a positive integer', () => {
  const fx = fixture();
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'l-2', '--timeout-secs', 'no']);
  assertEqual(code, 30);
  assert(stderr.includes('timeout-secs'), 'error names the flag');
});

// --- policy (fail closed, ADR-0007) ---

test('missing <role>.permissions.json → 30 missing-policy, codex never invoked', () => {
  const fx = fixture();
  fs.unlinkSync(path.join(fx.roleDir, 'echo.permissions.json'));
  const { out, stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'p-1']);
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 missing-policy:'), 'stderr slug line');
  assert(stderr.includes(path.join(fx.roleDir, 'echo.permissions.json')), 'names the file');
  assert(!fs.existsSync(fx.argvFile), 'fail closed: no fallback sandbox, agent never invoked');
});

test('invalid policy JSON → 30 bad-policy, agent never invoked', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.roleDir, 'echo.permissions.json'), '{nope');
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'p-2']);
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 bad-policy:'), 'stderr slug line');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

test('danger-full-access is rejected at load — no role, no configuration, no override', () => {
  const fx = fixture();
  const p = JSON.parse(JSON.stringify(ECHO_PERMISSIONS));
  p.codex.sandbox = 'danger-full-access';
  fs.writeFileSync(path.join(fx.roleDir, 'echo.permissions.json'), JSON.stringify(p));
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'p-3']);
  assertEqual(code, 30);
  assert(stderr.includes('danger-full-access'), 'names the illegal value');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

test('loadPolicy: projection may not exceed capabilities; defaults are closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-policy-'));
  const file = path.join(dir, 'x.permissions.json');
  // workspace-write without write_repository → load-invalid (narrow, never widen)
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      capabilities: { read_repository: true },
      codex: { sandbox: 'workspace-write' },
    }),
  );
  let thrown = null;
  try {
    policy.loadPolicy(file);
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== null && thrown.slug === 'bad-policy', 'widening projection rejected');
  // read-only with an empty capabilities block loads; every key defaults FALSE,
  // approval defaults 'never', ignore_user_config defaults true.
  fs.writeFileSync(
    file,
    JSON.stringify({ schema_version: 1, capabilities: {}, codex: { sandbox: 'read-only' } }),
  );
  const loaded = policy.loadPolicy(file);
  for (const key of policy.CAPABILITY_KEYS) {
    assertEqual(loaded.capabilities[key], false, `${key} defaults to false when absent`);
  }
  assertEqual(loaded.codex.approval, 'never');
  assertEqual(loaded.codex.ignore_user_config, true);
  assertEqual(loaded.codex.ignore_rules, false);
  // non-boolean capability value is malformed, not a soft false
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      capabilities: { network: 'yes' },
      codex: { sandbox: 'read-only' },
    }),
  );
  let bad = null;
  try {
    policy.loadPolicy(file);
  } catch (err) {
    bad = err;
  }
  assert(bad !== null && bad.slug === 'bad-policy', 'non-boolean capability rejected');
  // missing file carries the missing-policy slug and exit 30
  let missing = null;
  try {
    policy.loadPolicy(path.join(dir, 'nope.permissions.json'));
  } catch (err) {
    missing = err;
  }
  assert(missing !== null, 'missing policy throws');
  assertEqual(missing.slug, 'missing-policy');
  assertEqual(missing.exitCode, 30);
});

test('packaged corpus: all 15 roles ship a valid .permissions.json; map is read-only', () => {
  const roles = fs
    .readdirSync(ROLES_DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3));
  assertEqual(roles.length, 15, 'all 15 role files present');
  for (const role of roles) {
    const file = path.join(ROLES_DIR, `${role}.permissions.json`);
    assert(fs.existsSync(file), `${role}.permissions.json exists`);
    const loaded = policy.loadPolicy(file); // throws if invalid
    if (role === 'map') {
      assertEqual(loaded.codex.sandbox, 'read-only', 'pure inspection role');
      assertEqual(loaded.capabilities.write_repository, false, 'map cannot write');
    } else {
      assertEqual(loaded.codex.sandbox, 'workspace-write', `${role}: workspace-write`);
    }
    assertEqual(loaded.codex.approval, 'never', `${role}: headless approval is never`);
    assertEqual(loaded.codex.ignore_user_config, true, `${role}: user config ignored`);
  }
});

test('map e2e: the read-only policy projects into --sandbox read-only', () => {
  const fx = fixture();
  const { code } = runCodex(fx, ['map', '--run-id', 'p-4']);
  assertEqual(code, 0, 'packaged map role + packaged policy resolve and run');
  const argv = readJson(fx.argvFile);
  assertEqual(argv[argv.indexOf('--sandbox') + 1], 'read-only', 'narrowest workable sandbox');
});

// --- timeout enforcement (ADR-0008) ---

test('timeout: child killed, partial transcript kept, failed + timed_out (never success)', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 't-1', '--timeout-secs', '1'], {
    STUB_HANG: '1',
  });
  assertEqual(code, 20, 'timeout is a role FAILURE, not an infra crash');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.timed_out, true, 'timed_out flag set (agent-result v1.x additive field)');
  assertEqual(obj.provider, 'codex');
  assert(obj.error.includes('timed out after 1s'), 'error names the deadline');
  const transcript = path.join(fx.home, '.verity', 'logs', 't-1', 'echo.codex.jsonl');
  assert(fs.existsSync(transcript), 'partial transcript retained');
  assert(fs.readFileSync(transcript, 'utf8').includes('thread.started'), 'partial content kept');
});

// --- result normalization (structured preferred, marker fallback, fail closed) ---

test('structured final message → success; artifacts paths fold into the v1 object', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-1'], {
    STUB_TRANSCRIPT: FX.unknownEvents, // no marker anywhere — structured file decides
    STUB_FINAL_FILE: FX.finalCompleted,
  });
  assertEqual(code, 0, 'completed maps to success/exit 0');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'success');
  assertEqual(
    JSON.stringify(obj.artifacts),
    '{"paths":["docs/plan.md","stage-instructions/stage-1.md"]}',
    'artifact paths under a paths key',
  );
  assertEqual(obj.error, null);
  assertEqual(obj.provider, 'codex');
  assert(obj.transcript_path.endsWith('echo.codex.jsonl'), 'transcript_path annotated');
  assert(obj.final_message_path.endsWith('echo.final.json'), 'final_message_path annotated');
});

test('structured gated → exit 10, error stays null', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-2'], {
    STUB_TRANSCRIPT: FX.unknownEvents,
    STUB_FINAL_FILE: FX.finalGated,
  });
  assertEqual(code, 10);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'gated');
  assertEqual(obj.error, null);
});

test('structured failed → exit 20, reason becomes error', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-3'], {
    STUB_TRANSCRIPT: FX.unknownEvents,
    STUB_FINAL_FILE: FX.finalFailed,
  });
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.error, 'CI red');
});

test('schema-invalid structured output → 30 invalid-result (fail closed, no guessing)', () => {
  const fx = fixture();
  const badFinal = path.join(fx.dir, 'bad-final.json');
  // gated without a gate name — schema-invalid per the role-outcome contract
  fs.writeFileSync(
    badFinal,
    JSON.stringify({
      verity: 1,
      outcome: 'gated',
      gate: null,
      artifacts: [],
      reason: null,
      summary: 'stuck',
    }),
  );
  const { out, stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-4'], {
    STUB_TRANSCRIPT: FX.unknownEvents,
    STUB_FINAL_FILE: badFinal,
  });
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 invalid-result:'), 'stderr slug line');
  assert(stderr.includes('gate'), 'names the schema violation');
});

test('structured success contradicted by a transcript failure → 30 inconsistent', () => {
  const fx = fixture();
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-5'], {
    STUB_TRANSCRIPT: FX.turnFailed,
    STUB_FINAL_FILE: FX.finalCompleted,
  });
  assertEqual(code, 30, 'a success claim over a failed turn is never trusted');
  assert(stderr.includes('inconsistent'), 'names the contradiction');
});

test('no final file → marker in the last agent message wins (fallback parser)', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-6']); // success fixture, marker path
  assertEqual(code, 0);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'success');
  assertEqual(JSON.stringify(obj.artifacts), '{"pr":7}', 'marker artifacts carried');
});

test('gated / failed markers normalize with the same exit mapping as claude', () => {
  const fx = fixture();
  const gated = runCodex(fx, ['echo', 'hi', '--run-id', 'r-7'], { STUB_TRANSCRIPT: FX.gated });
  assertEqual(gated.code, 10);
  assertEqual(parseSingleObject(gated.out).outcome, 'gated');
  const failed = runCodex(fx, ['echo', 'hi', '--run-id', 'r-8'], { STUB_TRANSCRIPT: FX.failed });
  assertEqual(failed.code, 20);
  assertEqual(parseSingleObject(failed.out).error, 'CI would not go green');
});

test('turn.failed with no marker → failed/20 with the provider error message', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-9'], {
    STUB_TRANSCRIPT: FX.turnFailed,
  });
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.error, 'stream disconnected before completion');
});

test('clean completion but NO valid result → 30, never success (fail-closed rule)', () => {
  const fx = fixture();
  const { out, stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-10'], {
    STUB_TRANSCRIPT: FX.unknownEvents, // completes cleanly, agent message has no marker
  });
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('no valid role result'), 'refuses to guess');
});

test('malformed JSONL mid-transcript → 30 naming the line number, content not echoed', () => {
  const fx = fixture();
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'r-11'], {
    STUB_TRANSCRIPT: FX.malformed,
  });
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 malformed-output:'), 'stderr slug line');
  assert(stderr.includes('line 2'), 'names the offending line');
  assert(!stderr.includes('not json at all'), 'never prints line content (may carry secrets)');
});

// --- usage normalization (est_usd null — ADR-0008) ---

test('usage: tokens folded, est_usd is NULL (unknown ≠ 0), usage_detail additive', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'n-1']);
  assertEqual(code, 0);
  const obj = parseSingleObject(out);
  assertEqual(obj.tokens.in, 1234, 'input_tokens (cached is a subset, not re-added)');
  assertEqual(obj.tokens.out, 450, 'output_tokens');
  assertEqual(obj.est_usd, null, 'codex reports no exact cost — null, NEVER 0');
  assertEqual(obj.usage_detail.total_tokens, 1884, 'raw detail travels additively');
  assertEqual(obj.usage_detail.cached_input_tokens, 500);
  assertEqual(obj.usage_detail.reasoning_output_tokens, 200);
  assertEqual(obj.tool_calls, 2, 'two tool item STARTS (agent_message completion not counted)');
});

test('normalizeUsage: no usage event → zero tokens, null cost, no usage_detail key', () => {
  const normalized = codex.normalizeUsage({ usage: null });
  assertEqual(normalized.tokens.in, 0);
  assertEqual(normalized.tokens.out, 0);
  assertEqual(normalized.est_usd, null);
  assert(!('usage_detail' in normalized), 'detail omitted when nothing was reported');
});

// --- parser edge cases (unit level) ---

function writeTranscript(fx, name, lines) {
  const file = path.join(fx.dir, name);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

test('parser: blank lines and a truncated FINAL line are tolerated (timeout debris)', () => {
  const fx = fixture();
  const file = writeTranscript(fx, 'partial.codex.jsonl', [
    '{"type":"thread.started","thread_id":"t"}',
    '',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    '',
    '{"type":"item.compl', // killed mid-write
  ]);
  const digest = codex.parseTranscript(file);
  assertEqual(digest.truncated, true, 'truncation noted, not fatal');
  assertEqual(digest.usage.input_tokens, 10, 'events before the cut still collected');
});

test('parser: malformed line that is NOT final throws with its line number', () => {
  const fx = fixture();
  const file = writeTranscript(fx, 'broken.codex.jsonl', [
    '{"type":"thread.started"}',
    '{{{nope',
    '{"type":"turn.completed"}',
    '',
  ]);
  let thrown = null;
  try {
    codex.parseTranscript(file);
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== null, 'malformed mid-transcript line throws');
  assertEqual(thrown.name, 'AgentExecError');
  assertEqual(thrown.slug, 'malformed-output');
  assert(thrown.message.includes('line 2'), 'names the line');
  assert(!thrown.message.includes('nope'), 'never echoes line content');
});

test('parser: duplicated completion events never double-count (last usage wins)', () => {
  const fx = fixture();
  const file = writeTranscript(fx, 'dupes.codex.jsonl', [
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    '',
  ]);
  const usage = codex.normalizeUsage(codex.parseTranscript(file));
  assertEqual(usage.tokens.in, 100, 'not 200 — duplicates replace, never accumulate');
  assertEqual(usage.tokens.out, 10);
});

test('parser: unknown events and extra fields never crash; digest still built', () => {
  const digest = codex.parseTranscript(FX.unknownEvents);
  assertEqual(digest.failure, null, 'unknown events are not failures');
  assertEqual(digest.sawCompletion, true);
  assertEqual(digest.lastAgentMessage, 'All wrapped up, nothing structured to report.');
  assertEqual(codex.countToolCalls(FX.unknownEvents), 1, 'only the known tool item counts');
});

test('parser: large transcript — item STARTS counted once each, deterministic', () => {
  const fx = fixture();
  const lines = [];
  for (let i = 0; i < 5000; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'item.started',
        item: { id: `item_${i}`, item_type: 'command_execution', command: 'true' },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: `item_${i}`, item_type: 'command_execution', exit_code: 0 },
      }),
    );
  }
  lines.push('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}', '');
  const file = writeTranscript(fx, 'large.codex.jsonl', lines);
  assertEqual(codex.countToolCalls(file), 5000, 'starts only — completions never add a second');
  assertEqual(codex.parseTranscript(file).sawCompletion, true, 'large transcript parses');
});

// --- role-outcome schema (schemas/agent-result.schema.json) ---

test('role-outcome schema: every packaged final fixture validates; no-op is valid', () => {
  for (const file of [FX.finalCompleted, FX.finalGated, FX.finalFailed]) {
    const check = validateRoleOutcome(readJson(file));
    assert(check.ok, `${path.basename(file)} validates: ${check.error || ''}`);
  }
  const noop = {
    verity: 1,
    outcome: 'no-op',
    gate: null,
    artifacts: [],
    reason: null,
    summary: 'Nothing to do.',
  };
  assert(validateRoleOutcome(noop).ok, 'no-op with empty artifacts is valid');
});

test('role-outcome schema: invalid shapes are rejected, each with a named reason', () => {
  const valid = readJson(FX.finalCompleted);
  const cases = [
    [{ ...valid, outcome: 'gated', gate: null }, 'gate', 'gated without a gate name'],
    [{ ...valid, outcome: 'sideways' }, 'unknown outcome', 'unknown outcome'],
    [{ ...valid, extra: true }, "unexpected property 'extra'", 'extra property'],
    [{ ...valid, verity: 2 }, 'verity must be 1', 'wrong verity version'],
    [{ ...valid, outcome: 'failed', reason: null }, 'reason', 'failed without a reason'],
    [{ ...valid, artifacts: '../x' }, 'array', 'artifacts must be an array'],
    [{ ...valid, artifacts: ['../secrets.env'] }, 'artifacts[0]', 'path traversal'],
    [{ ...valid, artifacts: ['/etc/passwd'] }, 'artifacts[0]', 'absolute path'],
    [{ ...valid, artifacts: ['C:\\windows\\x'] }, 'artifacts[0]', 'windows absolute path'],
    [{ ...valid, artifacts: ['docs/../../up'] }, 'artifacts[0]', 'embedded traversal'],
    [{ ...valid, summary: null }, 'summary', 'summary required'],
  ];
  for (const [obj, needle, label] of cases) {
    const check = validateRoleOutcome(obj);
    assert(!check.ok, `${label} must be invalid`);
    assert(check.error.includes(needle), `${label}: error names the problem (${check.error})`);
  }
  // required-property omission
  const { summary: _dropped, ...missing } = valid;
  assert(!validateRoleOutcome(missing).ok, 'missing required property invalid');
  const schema = readJson(path.join(__dirname, '..', 'schemas', 'agent-result.schema.json'));
  assertEqual(
    JSON.stringify(schema.required),
    '["verity","outcome","gate","artifacts","reason","summary"]',
    'published schema artifact pins the role-outcome field set',
  );
});

// --- provider-contract suite: the SAME abstract checks against BOTH drivers ---

const MARKER = {
  success: 'Done.\n{"verity":1,"outcome":"success","gate":null,"artifacts":{"pr":7},"reason":"ok"}',
  gated:
    'Waiting.\n{"verity":1,"outcome":"gated","gate":"review:merge","artifacts":{},"reason":"needs human"}',
  failed: 'Stuck.\n{"verity":1,"outcome":"failed","gate":null,"artifacts":{},"reason":"CI red"}',
};

// Claude canned stream-json transcript (one tool_use + final result line).
function claudeTranscript(fx, finalText) {
  const lines = [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: finalText,
      total_cost_usd: 1.87,
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  ];
  fs.writeFileSync(fx.transcriptFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return fx.transcriptFile;
}

// Codex canned transcript: lifecycle + one tool item + a marker agent message.
function codexTranscript(fx, finalText) {
  const lines = [
    { type: 'thread.started', thread_id: 'th_x' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i0', item_type: 'command_execution', command: 'true' } },
    { type: 'item.completed', item: { id: 'i0', item_type: 'command_execution', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: finalText } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    },
  ];
  fs.writeFileSync(fx.transcriptFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return fx.transcriptFile;
}

const PROVIDER_CASES = [
  {
    agent: 'claude',
    driver: claude,
    binEnv: (fx) => ({ VERITY_CLAUDE_BIN: fx.claudeStub, VERITY_CODEX_BIN: '' }),
    stub: (fx) => fx.claudeStub,
    canned: claudeTranscript,
    transcriptName: 'echo.jsonl',
  },
  {
    agent: 'codex',
    driver: codex,
    binEnv: (fx) => ({ VERITY_CODEX_BIN: fx.codexStub, VERITY_CLAUDE_BIN: '' }),
    stub: (fx) => fx.codexStub,
    canned: codexTranscript,
    transcriptName: 'echo.codex.jsonl',
  },
];

function runContract(P, fx, args, env = {}) {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_AGENT_BIN: '',
      ...P.binEnv(fx),
      STUB_ARGV_FILE: fx.argvFile,
      STUB_TRANSCRIPT: fx.transcriptFile,
      ...env,
    },
  };
  const argv = [CLI, 'agent-exec', ...args, '--agent', P.agent, '--cwd', fx.dir, '--json'];
  try {
    return { out: execFileSync('node', argv, opts), stderr: '', code: 0 };
  } catch (err) {
    return { out: err.stdout || '', stderr: err.stderr || '', code: err.status };
  }
}

for (const P of PROVIDER_CASES) {
  test(`contract [${P.agent}]: success/gated/failed normalize to exits 0/10/20`, () => {
    for (const [kind, code] of [
      ['success', 0],
      ['gated', 10],
      ['failed', 20],
    ]) {
      const fx = fixture();
      P.canned(fx, MARKER[kind]);
      const res = runContract(P, fx, ['echo', 'hi', '--run-id', `pc-${kind}`]);
      assertEqual(res.code, code, `${P.agent} ${kind} exit`);
      const obj = parseSingleObject(res.out);
      assertEqual(obj.outcome, kind);
      assertEqual(obj.role, 'echo');
      assertEqual(obj.error, kind === 'failed' ? 'CI red' : null);
    }
  });

  test(`contract [${P.agent}]: usage normalized — tokens numeric, unknown cost stays null`, () => {
    const fx = fixture();
    P.canned(fx, MARKER.success);
    const res = runContract(P, fx, ['echo', 'hi', '--run-id', 'pc-usage']);
    const obj = parseSingleObject(res.out);
    assertEqual(obj.tokens.in, 100);
    assertEqual(obj.tokens.out, 20);
    assert(obj.est_usd === null || typeof obj.est_usd === 'number', 'est_usd number|null');
    if (P.agent === 'codex') {
      assertEqual(obj.est_usd, null, 'codex never fabricates a dollar figure');
    }
    assertEqual(obj.tool_calls, 1, 'one tool call in the canned transcript');
  });

  test(`contract [${P.agent}]: transcript retained verbatim at the provider path`, () => {
    const fx = fixture();
    P.canned(fx, MARKER.success);
    runContract(P, fx, ['echo', 'hi', '--run-id', 'pc-log']);
    const transcript = path.join(fx.home, '.verity', 'logs', 'pc-log', P.transcriptName);
    assertEqual(
      fs.readFileSync(transcript, 'utf8'),
      fs.readFileSync(fx.transcriptFile, 'utf8'),
      'raw provider stream preserved',
    );
  });

  test(`contract [${P.agent}]: availability + version errors → 30 with slugs`, () => {
    const fx = fixture();
    P.canned(fx, MARKER.success);
    const missing = runContract(P, fx, ['echo', 'hi', '--run-id', 'pc-miss'], {
      [P.driver.binaryEnvVar]: path.join(fx.dir, 'no-such-binary'),
    });
    assertEqual(missing.code, 30);
    assert(missing.stderr.includes('agent-missing'), `${P.agent}: missing-binary slug`);
    const tooOld = runContract(P, fx, ['echo', 'hi', '--run-id', 'pc-old'], {
      STUB_VERSION: '0.0.1',
      STUB_CODEX_VERSION: '0.0.1',
    });
    assertEqual(tooOld.code, 30);
    assert(tooOld.stderr.includes('version-too-old'), `${P.agent}: version slug`);
  });

  test(`contract [${P.agent}]: malformed provider output → 30, never a fake outcome`, () => {
    const fx = fixture();
    fs.writeFileSync(fx.transcriptFile, 'plain prose\nstill not json\n');
    const res = runContract(P, fx, ['echo', 'hi', '--run-id', 'pc-mal']);
    assertEqual(res.code, 30);
    assertEqual(parseSingleObject(res.out).outcome, 'infra_error');
  });

  test(`contract [${P.agent}]: --timeout-secs kills the child → failed + timed_out`, () => {
    const fx = fixture();
    P.canned(fx, MARKER.success);
    const res = runContract(
      P,
      fx,
      ['echo', 'hi', '--run-id', 'pc-timeout', '--timeout-secs', '1'],
      { STUB_HANG: '1' },
    );
    assertEqual(res.code, 20, `${P.agent}: timeout is a failure, never success`);
    const obj = parseSingleObject(res.out);
    assertEqual(obj.outcome, 'failed');
    assertEqual(obj.timed_out, true);
    const transcript = path.join(fx.home, '.verity', 'logs', 'pc-timeout', P.transcriptName);
    assert(fs.existsSync(transcript), 'partial transcript retained');
  });
}
