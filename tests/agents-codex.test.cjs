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

// Every stub answers `--version` at the CURRENT pin (stage 12 raised it from
// the historical 0.42.0 to the feature-derived 0.146.0). Reading it from
// package.json rather than hardcoding means a future evidence-driven bump does
// not silently turn the whole suite into a version-too-old lane.
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

const FX = {
  success: path.join(FIXTURES, 'codex-success.jsonl'),
  gated: path.join(FIXTURES, 'codex-gated.jsonl'),
  failed: path.join(FIXTURES, 'codex-failed.jsonl'),
  turnFailed: path.join(FIXTURES, 'codex-turn-failed.jsonl'),
  malformed: path.join(FIXTURES, 'codex-malformed.jsonl'),
  unknownEvents: path.join(FIXTURES, 'codex-unknown-events.jsonl'),
  legacyItemType: path.join(FIXTURES, 'codex-legacy-item-type.jsonl'),
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
const path = require('node:path');
const args = process.argv.slice(2);
// The version/auth probes are ordinary child processes and still inherit the
// caller's environment, so they stay env-driven.
if (args.includes('--version')) {
  process.stdout.write('codex-cli ' + (process.env.STUB_CODEX_VERSION || '${MIN_CODEX}') + '\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.STUB_CODEX_UNAUTH) { process.stderr.write('Not logged in\\n'); process.exit(1); }
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
// The EXEC child does not: stage 11 (ADR-0011) constructs its environment from
// a passlist, so the stub's instructions travel through the workspace instead
// (STUB_CONFIG_FILE, written by runCodex before every invocation).
const cfg = JSON.parse(fs.readFileSync(path.join(args[args.indexOf('--cd') + 1], '.verity-stub.json'), 'utf8'));
if (cfg.STUB_ARGV_FILE) fs.writeFileSync(cfg.STUB_ARGV_FILE, JSON.stringify(args));
if (cfg.STUB_ENV_FILE) fs.writeFileSync(cfg.STUB_ENV_FILE, JSON.stringify(Object.keys(process.env)));
const stdin = fs.readFileSync(0, 'utf8');
if (cfg.STUB_STDIN_FILE) fs.writeFileSync(cfg.STUB_STDIN_FILE, stdin);
if (cfg.STUB_TRANSCRIPT) process.stdout.write(fs.readFileSync(cfg.STUB_TRANSCRIPT, 'utf8'));
const fi = args.indexOf('--output-last-message');
if (fi >= 0 && cfg.STUB_FINAL_FILE) fs.copyFileSync(cfg.STUB_FINAL_FILE, args[fi + 1]);
if (cfg.STUB_HANG) setTimeout(() => {}, 60000);
else process.exit(Number(cfg.STUB_EXIT || 0));
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
  // `dir` is the harness's scratch root; `repo` is the WORKSPACE the role runs
  // in. They are separate since stage 11: the post-run invariants watch the
  // workspace, so nothing the harness writes may land inside it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-codex-'));
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const codexStub = path.join(dir, 'codex-stub');
  fs.writeFileSync(codexStub, CODEX_STUB);
  fs.chmodSync(codexStub, 0o755);
  const claudeStub = path.join(dir, 'claude-stub');
  fs.writeFileSync(claudeStub, CLAUDE_STUB);
  fs.chmodSync(claudeStub, 0o755);
  const roleDir = path.join(repo, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), '---\nname: echo\n---\nEcho $ARGUMENTS\n');
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), JSON.stringify(ECHO_TOOLS));
  fs.writeFileSync(
    path.join(roleDir, 'echo.permissions.json'),
    JSON.stringify(ECHO_PERMISSIONS, null, 2),
  );
  return {
    dir,
    repo,
    home,
    roleDir,
    codexStub,
    claudeStub,
    stubConfig: path.join(repo, '.verity-stub.json'),
    argvFile: path.join(dir, 'argv.json'),
    stdinFile: path.join(dir, 'stdin.txt'),
    transcriptFile: path.join(dir, 'canned.jsonl'),
  };
}

// Run agent-exec against the codex stub. STUB_TRANSCRIPT defaults to the
// success fixture (marker path); tests opt into a final-message file with
// STUB_FINAL_FILE.
function runCodex(fx, args, env = {}) {
  // The STUB_* keys keep their names but travel in the workspace config file
  // (the exec child's environment is constructed now, ADR-0011); the probe-path
  // keys stay in the real environment.
  const cfg = {
    STUB_ARGV_FILE: fx.argvFile,
    STUB_STDIN_FILE: fx.stdinFile,
    STUB_TRANSCRIPT: FX.success,
    ...env,
  };
  fs.writeFileSync(fx.stubConfig, JSON.stringify(cfg));
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_CODEX_BIN: fx.codexStub,
      VERITY_CLAUDE_BIN: '',
      VERITY_AGENT_BIN: '',
      ...env,
    },
  };
  // ECHO_PERMISSIONS declares network: false, which no exec-path mechanism
  // enforces — every codex run acknowledges that gap explicitly (ADR-0011
  // capability honesty rule; the refusal itself is proven in enforcement.test).
  const argv = [
    CLI,
    'agent-exec',
    ...args,
    '--agent',
    'codex',
    '--acknowledge-gaps',
    'network',
    '--cwd',
    fx.repo,
    '--json',
  ];
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
    [CLI, 'agent-exec', 'echo', 'hi', '--run-id', 'd-1', '--cwd', fx.repo, '--json'],
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
  assertEqual(argv[argv.indexOf('--cd') + 1], fx.repo, 'repo root is explicit');
  assert(argv.includes('approval_policy="never"'), 'approval policy explicit (never)');
  assert(argv.includes('--ignore-user-config'), 'user-config isolation via the documented FLAG');
  assertEqual(argv[argv.length - 1], '-', 'prompt arrives over stdin, not argv');
});

test('argv: Claude-only flags NEVER sent to codex', () => {
  const fx = fixture();
  runCodex(fx, ['echo', 'hi', '--run-id', 'i-2']);
  const argv = readJson(fx.argvFile);
  for (const forbidden of [
    '--allowed-tools',
    '--max-turns',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
  ]) {
    // Element-anchored, not a substring scan of the joined argv: path values
    // (random tmpdir names) once made `-p` match by accident (flake).
    assert(
      argv.every((a) => a !== forbidden && !a.startsWith(`${forbidden}=`)),
      `codex argv must not contain ${forbidden}`,
    );
  }
});

// --- stage-10 argv regressions (CDX-002/003/006): documented flags, not -c keys ---

// buildArgv against a real loaded policy (the same loader the driver uses).
function argvFor(codexBlock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-argv-'));
  const file = path.join(dir, 'x.permissions.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      capabilities: { read_repository: true, write_repository: true },
      codex: { sandbox: 'workspace-write', ...codexBlock },
    }),
  );
  return codex.buildArgv({
    policy: policy.loadPolicy(file),
    finalMessagePath: path.join(dir, 'r.final.json'),
    cwd: dir,
  });
}

test('argv regression (CDX-002): --ignore-user-config flag by policy; -c form NEVER emitted', () => {
  const on = argvFor({ ignore_user_config: true });
  assert(on.includes('--ignore-user-config'), 'true policy → the documented flag');
  const off = argvFor({ ignore_user_config: false });
  assert(!off.includes('--ignore-user-config'), 'false policy → flag absent');
  for (const argv of [on, off]) {
    // The old spelling set a nonexistent config key Codex silently absorbed —
    // zero isolation. No argv element may ever carry it again.
    assert(
      argv.every((a) => !a.includes('ignore_user_config')),
      `-c ignore_user_config form must never be emitted (got ${JSON.stringify(argv)})`,
    );
  }
});

test('argv regression (CDX-003): --ignore-rules emitted when the policy asks, absent otherwise', () => {
  const on = argvFor({ ignore_rules: true });
  assert(on.includes('--ignore-rules'), 'true policy → the documented flag');
  const off = argvFor({ ignore_rules: false });
  assert(!off.includes('--ignore-rules'), 'false policy → flag absent');
  assert(
    off.every((a) => !a.includes('ignore_rules')),
    'no -c spelling for ignore_rules either',
  );
});

// Stage 15 (#34, P0) INVERTS the stage-10 CDX-006 assertion above this line.
// That test pinned `--output-schema <packaged schema>` as present on every
// invocation; the real canary run (codex-cli 0.146.0, 2026-07-31) proved the
// flag kills EVERY run — our schema contains `allOf`, the API answers HTTP 400
// `invalid_json_schema: … 'allOf' is not permitted`, and the turn fails with
// zero tokens and zero tool calls. A/B on the real binary isolated the flag as
// the sole cause. A stub could never have caught it: a schema is only wrong at
// the far end of the wire.
test('argv regression (#34): --output-schema is NEVER emitted — the API rejects our schema', () => {
  const argv = argvFor({});
  assert(
    !argv.includes('--output-schema'),
    `--output-schema must never be emitted again (got ${JSON.stringify(argv)})`,
  );
  // Grep-assertable: no argv element may reference the schema by any spelling
  // (a `--output-schema=<path>` form or a bare path would break runs just the
  // same).
  assert(
    argv.every((a) => !a.includes('output-schema') && !a.includes('agent-result.schema.json')),
    'no argv element references the packaged schema at all',
  );
  assertEqual(codex.RESULT_SCHEMA_PATH, undefined, 'the driver constant went with the flag');
  // The schema itself STAYS: it is the published contract artifact that
  // documents the structured role-outcome shape and mirrors validateRoleOutcome
  // (contracts/agent-result.md §Consumes). It is simply never handed to the CLI.
  assert(
    fs.existsSync(path.join(__dirname, '..', 'schemas', 'agent-result.schema.json')),
    'schemas/agent-result.schema.json remains published (it is the contract, not a CLI input)',
  );
});

test('argv regression (#34): the LIVE end-to-end argv carries no schema flag either', () => {
  const fx = fixture();
  const { code } = runCodex(fx, ['echo', 'hi', '--run-id', 'i-4']);
  assertEqual(code, 0);
  const argv = readJson(fx.argvFile);
  assert(
    argv.every((a) => !a.includes('output-schema') && !a.includes('agent-result.schema.json')),
    `the argv the binary actually received (${JSON.stringify(argv)})`,
  );
  // The proven result channel is untouched: the --output-last-message file
  // (parsed as structured JSON when present) with the marker as the fallback.
  assert(argv.includes('--output-last-message'), 'the result channel that WORKS still travels');
});

test('argv regression: claude argv untouched by the stage-10 codex flags', () => {
  const argv = claude.buildArgv({ prompt: 'p', maxTurns: 5, allowlist: ['Read'] });
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--output-schema']) {
    assert(!argv.includes(flag), `claude argv must not contain ${flag}`);
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

// Stage 11 (ADR-0011) replaced the stage-8 assertion here ("the child env is
// exactly the caller env — nothing injected"), which described the LEAK: the
// child inherited every credential the caller held. The seam is now an
// allowlist, and this is its contract test; the adversarial end-to-end proof
// (a poisoned parent environment, liveness-gated) lives in enforcement.test.
test('env: the codex child gets the constructed passlist — not the caller environment', () => {
  const fx = fixture();
  const envFile = path.join(fx.dir, 'env.json');
  runCodex(fx, ['echo', 'hi', '--run-id', 'e-1'], {
    STUB_ENV_FILE: envFile,
    // A caller variable that is neither on the passlist nor granted by any
    // capability: it must not survive into the child.
    UNRELATED_CALLER_VAR: 'present-in-the-parent',
  });
  const childKeys = new Set(readJson(envFile));
  assert(!childKeys.has('UNRELATED_CALLER_VAR'), 'an unlisted caller variable is dropped');
  assert(!childKeys.has('VERITY_CODEX_BIN'), "Verity's own seam variables never travel either");
  for (const key of childKeys) {
    assert(
      codex.BASELINE_ENV_PASSLIST.includes(key) ||
        Object.values(codex.CAPABILITY_CREDENTIALS).some((names) => names.includes(key)),
      `${key} reached the child without being on the passlist or granted by a capability`,
    );
  }
  assert(
    childKeys.has('PATH') && childKeys.has('HOME'),
    'the baseline the toolchain needs is there',
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

// --- provider-error legibility (#35) --------------------------------------------

// Transcribed VERBATIM from the real canary run (issue #34, codex-cli 0.146.0,
// 2026-07-31): the pretty-printed HTTP 400 the API returned for our `allOf`
// schema, exactly as it appeared in `error.message` / the `error` event. Like
// the REAL_USAGE_F7 constant above it lives INLINE rather than as a fixture
// file, so a real observation can never be mistaken for one of the doc-derived
// transcripts (tests/fixtures/agents/README.md).
//
// Its first physical line is `{` — which is precisely what the old
// firstLine(final.failure) emitted as the entire error of every broken run.
const REAL_400_PAYLOAD = `{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_json_schema",
    "message": "Invalid schema for response_format 'codex_output_schema': In context=(), 'allOf' is not permitted.",
    "param": "text.format.schema"
  },
  "status": 400
}`;

// The real event sequence the canary recorded: an `error` event carrying the
// payload as a STRING, then `turn.failed` carrying the same payload again.
function write400Transcript(file) {
  fs.writeFileSync(
    file,
    `${[
      JSON.stringify({ type: 'thread.started', thread_id: 'th_400' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: REAL_400_PAYLOAD }),
      JSON.stringify({ type: 'turn.failed', error: { message: REAL_400_PAYLOAD } }),
    ].join('\n')}\n`,
  );
}

test('error legibility (#35): a pretty-printed JSON failure surfaces its message, not `{`', () => {
  const fx = fixture();
  write400Transcript(fx.transcriptFile);
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'x-1'], {
    STUB_TRANSCRIPT: fx.transcriptFile,
  });
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assert(
    obj.error.includes("'allOf' is not permitted"),
    `the underlying message must travel (got ${JSON.stringify(obj.error)})`,
  );
  assert(obj.error.length > 1, 'NEVER a lone punctuation character');
  assert(!obj.error.includes('\n'), 'one line — the result object stays single-line');
});

test('error legibility (#35): both provider-failure paths, and non-JSON text, stay legible', () => {
  const fx = fixture();
  const digestFor = (lines) => {
    const file = path.join(fx.dir, 'legible.codex.jsonl');
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return codex.parseTranscript(file);
  };
  // 1. the `error` event path (message is the JSON blob as a string)
  const fromError = codex.normalizeResult(
    digestFor([{ type: 'error', message: REAL_400_PAYLOAD }]),
  );
  assertEqual(fromError.outcome, 'failed');
  assert(fromError.error.includes("'allOf' is not permitted"), 'error event: message extracted');
  // 2. the `turn.failed` path (error.message is the JSON blob)
  const fromTurn = codex.normalizeResult(
    digestFor([{ type: 'turn.failed', error: { message: REAL_400_PAYLOAD } }]),
  );
  assertEqual(fromTurn.error, fromError.error, 'both paths normalize identically');
  // 3. ordinary one-line provider text is unchanged — the fix must not rewrite
  //    failures that were already legible.
  const plain = codex.normalizeResult(
    digestFor([
      { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
    ]),
  );
  assertEqual(plain.error, 'stream disconnected before completion');
  // 4. multi-line non-JSON text collapses to one bounded line, never to `{`
  const multi = codex.normalizeResult(
    digestFor([
      { type: 'turn.failed', error: { message: '\n\n  usage:\n  codex exec [OPTIONS]\n' } },
    ]),
  );
  assertEqual(multi.error, 'usage: codex exec [OPTIONS]');
});

test('error legibility (#35): the inconsistent-result diagnosis names the real failure too', () => {
  const fx = fixture();
  write400Transcript(fx.transcriptFile);
  const { stderr, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'x-2'], {
    STUB_TRANSCRIPT: fx.transcriptFile,
    STUB_FINAL_FILE: FX.finalCompleted,
  });
  assertEqual(code, 30, 'a success claim over a failed turn is still never trusted');
  assert(stderr.includes('inconsistent'), 'names the contradiction');
  assert(
    stderr.includes("'allOf' is not permitted"),
    `and the failure it contradicts (got ${JSON.stringify(stderr)})`,
  );
});

// --- additive annotations must never dangle (#36) --------------------------------

test('annotation (#36): a run with no final message OMITS final_message_path', () => {
  const fx = fixture();
  // The real defect: a failed run advertised <role>.final.json when only
  // <role>.codex.jsonl existed, because annotate() computed the path up front —
  // before the run could possibly have written it.
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'd-2'], {
    STUB_TRANSCRIPT: FX.turnFailed,
  });
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  const dir = path.join(fx.home, '.verity', 'logs', 'd-2');
  assert(
    !fs.existsSync(path.join(dir, 'echo.final.json')),
    'control: the final-message file really is absent on disk',
  );
  assert(
    !('final_message_path' in obj),
    `an absent artifact is never advertised (got ${JSON.stringify(obj.final_message_path)})`,
  );
  // transcript_path was always accurate and stays unconditional.
  assertEqual(obj.transcript_path, path.join(dir, 'echo.codex.jsonl'), 'transcript_path unchanged');
  assertEqual(obj.provider, 'codex');
});

test('annotation (#36): a run that DOES write one still advertises it', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'd-3'], {
    STUB_TRANSCRIPT: FX.unknownEvents,
    STUB_FINAL_FILE: FX.finalCompleted,
  });
  assertEqual(code, 0);
  const obj = parseSingleObject(out);
  const expected = path.join(fx.home, '.verity', 'logs', 'd-3', 'echo.final.json');
  assertEqual(obj.final_message_path, expected, 'present iff the file exists');
  assert(fs.existsSync(expected), 'and it really does');
});

test('annotation (#36): a timed-out run advertises no final message either', () => {
  const fx = fixture();
  const { out, code } = runCodex(fx, ['echo', 'hi', '--run-id', 'd-4', '--timeout-secs', '1'], {
    STUB_HANG: '1',
  });
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  assertEqual(obj.timed_out, true, 'the timeout annotation still wins over the driver default');
  assert(!('final_message_path' in obj), 'a killed run wrote no final message');
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

// Issue #29 (stage 12, spike F7): the usage event a REAL turn.completed carries
// is not the shape the doc-derived fixtures use. It has cache_write_input_tokens
// — which the pre-stage-12 allowlist silently dropped — and it has NO
// total_tokens at all. Transcribed here verbatim from the spike report, which
// is the observation itself, not a fixture we invented.
const REAL_USAGE_F7 = {
  input_tokens: 47180,
  cached_input_tokens: 43264,
  cache_write_input_tokens: 0,
  output_tokens: 165,
  reasoning_output_tokens: 0,
};

test('usage (#29): the REAL event shape — cache_write carried, absent total_tokens tolerated', () => {
  const normalized = codex.normalizeUsage({ usage: { ...REAL_USAGE_F7 } });
  // Headline fields are the contract, and this fix must not touch them.
  assertEqual(normalized.tokens.in, 47180, 'input_tokens (cached is a SUBSET, never re-added)');
  assertEqual(normalized.tokens.out, 165, 'output_tokens');
  assertEqual(normalized.est_usd, null, 'still no fabricated dollar figure (ADR-0008)');
  assertEqual(
    normalized.usage_detail.cache_write_input_tokens,
    0,
    'the field the allowlist used to drop now travels — including its ZERO value',
  );
  assertEqual(normalized.usage_detail.cached_input_tokens, 43264);
  assertEqual(normalized.usage_detail.reasoning_output_tokens, 0, 'zero is data, not absence');
  assert(
    !('total_tokens' in normalized.usage_detail),
    'a field the real event does not send is never invented',
  );
  assertEqual(
    JSON.stringify(Object.keys(normalized.usage_detail).sort()),
    JSON.stringify(Object.keys(REAL_USAGE_F7).sort()),
    'every field the real event sends is carried, and nothing else',
  );
});

test('usage (#29): a shape that DOES carry total_tokens still carries it (allowlist, not swap)', () => {
  const detail = codex.normalizeUsage({
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  }).usage_detail;
  assertEqual(detail.total_tokens, 12, 'the older/documented field was added to, not replaced');
  assert(!('cache_write_input_tokens' in detail), 'absent stays absent — no zero-filling');
});

test('usage (#29): the real event travels end-to-end through a transcript', () => {
  const fx = fixture();
  const file = path.join(fx.dir, 'real-usage.codex.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'turn.completed', usage: REAL_USAGE_F7 })}\n`);
  const usage = codex.normalizeUsage(codex.parseTranscript(file));
  assertEqual(usage.tokens.in, 47180);
  assertEqual(usage.usage_detail.cache_write_input_tokens, 0, 'survives the parser too');
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

// --- stage-10 parser regressions (CDX-004): item.type is the real discriminator ---

test('parser regression (CDX-004): documented item.type shape → message found, tools counted', () => {
  // The real CLI carries the item kind at item.type; the pre-stage-10 parser
  // read only item.item_type → tool_calls 0 and no last-agent-message on
  // every real transcript.
  const digest = codex.parseTranscript(FX.success);
  assert(
    typeof digest.lastAgentMessage === 'string' && digest.lastAgentMessage.length > 0,
    'agent_message extracted from an item.type transcript',
  );
  assert(digest.lastAgentMessage.includes('"outcome":"success"'), 'the marker text came through');
  assertEqual(codex.countToolCalls(FX.success), 2, 'both tool item STARTS counted');
});

test('parser regression (CDX-004): legacy item_type fixture still parses via the fallback', () => {
  const digest = codex.parseTranscript(FX.legacyItemType);
  assert(
    typeof digest.lastAgentMessage === 'string' && digest.lastAgentMessage.length > 0,
    'legacy-shape agent_message still extracted',
  );
  assertEqual(codex.countToolCalls(FX.legacyItemType), 2, 'legacy-shape tool starts still count');
  assertEqual(codex.itemKind({ item_type: 'file_change' }), 'file_change', 'fallback order');
  assertEqual(codex.itemKind({ type: 'a', item_type: 'b' }), 'a', 'item.type wins when both exist');
  assertEqual(codex.itemKind({}), null, 'neither key → null, never undefined behavior');
});

test('parser regression (CDX-004): event-level type is never confused with the item kind', () => {
  const fx = fixture();
  const file = writeTranscript(fx, 'levels.codex.jsonl', [
    // Event-level type says agent_message but there is NO item — must be
    // ignored, not read as a message.
    '{"type":"agent_message","text":"event-level impostor"}',
    '{"type":"command_execution","item":{"id":"i0","type":"agent_message","text":"wrong event"}}',
    // Item present but carrying neither kind key — tolerated, never counted.
    '{"type":"item.started","item":{"id":"i1"}}',
    '{"type":"item.completed","item":{"id":"i1","text":"kindless"}}',
    // The one real message and one real tool start.
    '{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"ls"}}',
    '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"the real one"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    '',
  ]);
  const digest = codex.parseTranscript(file);
  assertEqual(digest.lastAgentMessage, 'the real one', 'only the nested item kind is read');
  assertEqual(codex.countToolCalls(file), 1, 'impostor/kindless lines never count');
});

test('parser: large transcript — item STARTS counted once each, deterministic', () => {
  const fx = fixture();
  const lines = [];
  for (let i = 0; i < 5000; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'item.started',
        item: { id: `item_${i}`, type: 'command_execution', command: 'true' },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: `item_${i}`, type: 'command_execution', exit_code: 0 },
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
    { type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'true' } },
    { type: 'item.completed', item: { id: 'i0', type: 'command_execution', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: finalText } },
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
    // Claude has no unenforceable restriction to acknowledge (ADR-0011) and
    // REJECTS the flag — the asymmetry is deliberate and tested.
    extraArgs: [],
    stub: (fx) => fx.claudeStub,
    canned: claudeTranscript,
    transcriptName: 'echo.jsonl',
  },
  {
    agent: 'codex',
    driver: codex,
    binEnv: (fx) => ({ VERITY_CODEX_BIN: fx.codexStub, VERITY_CLAUDE_BIN: '' }),
    extraArgs: ['--acknowledge-gaps', 'network'],
    stub: (fx) => fx.codexStub,
    canned: codexTranscript,
    transcriptName: 'echo.codex.jsonl',
  },
];

function runContract(P, fx, args, env = {}) {
  // Claude's stub reads its config from the environment (its child still
  // inherits one); codex's reads the same keys from the workspace file, since
  // its environment is constructed (ADR-0011). Both get the same values.
  fs.writeFileSync(
    fx.stubConfig,
    JSON.stringify({
      STUB_ARGV_FILE: fx.argvFile,
      STUB_TRANSCRIPT: fx.transcriptFile,
      ...env,
    }),
  );
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
  const argv = [
    CLI,
    'agent-exec',
    ...args,
    '--agent',
    P.agent,
    ...P.extraArgs,
    '--cwd',
    fx.repo,
    '--json',
  ];
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
