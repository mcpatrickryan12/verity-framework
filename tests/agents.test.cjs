// Stage 7 (ADR-0005) — characterization suite for the Claude wire behavior of
// `verity agent-exec`. Written against the PRE-refactor code and kept green
// through the extraction into verity/bin/lib/agents/, so any behavior drift
// during the move is a test failure, not a silent regression. Everything here
// observes the process boundary (CLI argv in, result object / exit code /
// stderr out) or stable module exports — never extraction internals.
//
// Covers the spec's characterization bullets: binary selection & env
// precedence; version gate (missing / unparsable / too-old); argv order incl.
// variadic --allowed-tools last; allowlist errors (missing / invalid JSON /
// empty array); marker extraction; marker-absent fallback; error_max_turns;
// token normalization; total_cost_usd → est_usd; tool-call counting; nonzero
// exit; malformed transcript; `verity-agent-exec: 30 <slug>: …` stderr lines.
// The trailing "stage 7 seam" sections (added WITH the extraction) then pin
// the new surface: the agents/ registry, the VERITY_CLAUDE_BIN override
// precedence, the grep-assertable absence of Claude wire details in
// agent-exec.cjs, and the preserved module.exports surface.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const claude = require('../verity/bin/lib/agents/claude.cjs');
const registry = require('../verity/bin/lib/agents/index.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// Same stub-agent seam as tests/agent-exec.test.cjs: answers --version from
// STUB_VERSION, records argv to STUB_ARGV_FILE, replays STUB_TRANSCRIPT.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write((process.env.STUB_VERSION || '2.1.170') + ' (Claude Code)\\n');
  process.exit(0);
}
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args));
if (process.env.STUB_TRANSCRIPT) process.stdout.write(fs.readFileSync(process.env.STUB_TRANSCRIPT, 'utf8'));
process.exit(Number(process.env.STUB_EXIT || 0));
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-agents-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub');
  fs.writeFileSync(stub, STUB);
  fs.chmodSync(stub, 0o755);
  const argvFile = path.join(dir, 'argv.json');
  const transcriptFile = path.join(dir, 'canned.jsonl');
  return { dir, home, stub, argvFile, transcriptFile };
}

// Canned stream-json transcript: two tool_use blocks (one tool_result that
// must NOT count) and a final type:"result" line built from `overrides`.
function canned(fx, finalText, overrides = {}) {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's-1' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'working...' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 4200,
      num_turns: 3,
      result: finalText,
      session_id: 's-1',
      total_cost_usd: 1.87,
      usage: {
        input_tokens: 400000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 2034,
        output_tokens: 38112,
      },
      ...overrides,
    },
  ];
  fs.writeFileSync(fx.transcriptFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

// A scratch role with a KNOWN allowlist, so argv-order tests can assert the
// exact tail instead of depending on a packaged .tools.json.
const ECHO_TOOLS = ['Read', 'Grep', 'Bash(git *)'];
function echoRole(fx) {
  const roleDir = path.join(fx.dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), '---\nname: echo\n---\nEcho $ARGUMENTS\n');
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), JSON.stringify(ECHO_TOOLS));
  return roleDir;
}

function run(fx, args, env = {}) {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_AGENT_BIN: fx.stub,
      VERITY_CLAUDE_BIN: '', // empty = unset (precedence characterized below)
      STUB_ARGV_FILE: fx.argvFile,
      STUB_TRANSCRIPT: fx.transcriptFile,
      ...env,
    },
  };
  try {
    const out = execFileSync('node', [CLI, 'agent-exec', ...args, '--cwd', fx.dir, '--json'], opts);
    return { out, stderr: '', code: 0 };
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

const MARKER_SUCCESS =
  'Done.\n{"verity":1,"outcome":"success","gate":null,"artifacts":{"pr":7},"reason":"ok"}';

// --- binary selection & env precedence ---

test('characterize: VERITY_AGENT_BIN selects the agent binary (the test seam)', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { code } = run(fx, ['build', '7', '--run-id', 'c-1']);
  assertEqual(code, 0, 'stub via VERITY_AGENT_BIN was invoked and succeeded');
  assert(fs.existsSync(fx.argvFile), 'the VERITY_AGENT_BIN binary is the one that ran');
});

test('characterize: no env override → provider default `claude` resolved via PATH', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const binDir = path.join(fx.dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(fx.stub, path.join(binDir, 'claude'));
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  const { code } = run(fx, ['build', '7', '--run-id', 'c-2'], {
    VERITY_AGENT_BIN: '',
    PATH: `${binDir}:${process.env.PATH}`,
  });
  assertEqual(code, 0, 'fell back to the default binary name');
  assert(fs.existsSync(fx.argvFile), 'the PATH `claude` stub is the one that ran');
});

// --- version gate ---

test('characterize: missing binary → 30, slug agent-missing, "not runnable"', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const missing = path.join(fx.dir, 'no-such-claude');
  const { out, stderr, code } = run(fx, ['build', '7', '--run-id', 'c-3'], {
    VERITY_AGENT_BIN: missing,
  });
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 agent-missing:'), 'stderr slug line');
  assert(stderr.includes('agent binary not runnable'), 'message text preserved');
  assert(stderr.includes(missing), 'names the binary it tried');
});

test('characterize: unparsable --version output → 30, slug agent-missing, "could not parse"', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { stderr, code } = run(fx, ['build', '7', '--run-id', 'c-4'], {
    STUB_VERSION: 'not-a-version',
  });
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 agent-missing:'), 'stderr slug line');
  assert(stderr.includes('could not parse'), 'message text preserved');
});

test('characterize: version below pin → 30, slug version-too-old, names pin + remedy', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { stderr, code } = run(fx, ['build', '7', '--run-id', 'c-5'], { STUB_VERSION: '1.0.0' });
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 version-too-old:'), 'stderr slug line');
  assert(stderr.includes('1.0.0'), 'names the found version');
  assert(stderr.includes(agentExec.MIN_CLAUDE_VERSION), 'names the pinned minimum');
  assert(stderr.includes('claude update'), 'names the remedy');
});

// --- argv order (verified Claude headless flag spellings) ---

test('characterize: exact argv order; variadic --allowed-tools is the LAST flag', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  echoRole(fx);
  const { code } = run(fx, ['echo', 'hi', '--run-id', 'c-6']);
  assertEqual(code, 0);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[0], '-p', 'print mode first');
  assert(argv[1].includes('Echo hi'), 'argv[1] is the rendered prompt');
  assertEqual(
    JSON.stringify(argv.slice(2, 7)),
    JSON.stringify(['--output-format', 'stream-json', '--verbose', '--max-turns', '40']),
    'fixed flag order, default --max-turns 40',
  );
  assertEqual(argv[7], '--allowed-tools', '--allowed-tools directly after --max-turns');
  assertEqual(
    JSON.stringify(argv.slice(8)),
    JSON.stringify(ECHO_TOOLS),
    'allowlist entries verbatim, running to the end of argv',
  );
});

test('characterize: --max-turns N passes through to the agent argv', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  echoRole(fx);
  run(fx, ['echo', 'hi', '--run-id', 'c-7', '--max-turns', '13']);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[argv.indexOf('--max-turns') + 1], '13');
});

// --- allowlist errors (T06 deny-by-default) ---

test('characterize: missing .tools.json → 30 missing-allowlist, agent never invoked', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = echoRole(fx);
  fs.unlinkSync(path.join(roleDir, 'echo.tools.json'));
  const { out, stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'c-8']);
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 missing-allowlist:'), 'stderr slug line');
  assert(stderr.includes(path.join(roleDir, 'echo.tools.json')), 'names the missing file');
  assert(!fs.existsSync(fx.argvFile), 'deny-by-default: agent never invoked');
});

test('characterize: invalid allowlist JSON → 30 bad-allowlist', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = echoRole(fx);
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), '{nope');
  const { stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'c-9']);
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 bad-allowlist:'), 'stderr slug line');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

test('characterize: empty allowlist array → 30 bad-allowlist, "non-empty" rule named', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = echoRole(fx);
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), '[]');
  const { stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'c-10']);
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 bad-allowlist:'), 'stderr slug line');
  assert(stderr.includes('non-empty'), 'explains the rule');
  assert(!fs.existsSync(fx.argvFile), 'agent never invoked');
});

// Slug PRECEDENCE, deliberately chosen in stage 16 (issue #42): the driver's
// permission surface is filesystem-only and is evaluated BEFORE the binary
// preflight, which shells out. So when both are broken the answer is the
// deny-by-default one — the role's allowlist is missing whether or not this
// machine happens to have a working `claude`. Nothing else about either
// diagnosis changed; each still stands alone exactly as before.
test('characterize: the T06 allowlist refusal PRECEDES the binary preflight (issue #42)', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = echoRole(fx);
  fs.unlinkSync(path.join(roleDir, 'echo.tools.json'));
  const { stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'c-8b'], {
    VERITY_AGENT_BIN: path.join(fx.dir, 'no-such-claude'),
  });
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 missing-allowlist:'), 'deny-by-default answers');
  assert(!stderr.includes('agent-missing'), 'the binary probe does not mask the policy refusal');
});

// --- marker extraction / marker-absent classification ---

test('characterize: marker on the last line WINS over the CLI result subtype', () => {
  const fx = fixture();
  // CLI says success (is_error:false, subtype:success) but the role marker
  // says failed — the marker is authoritative.
  canned(fx, 'Ran out of road.\n{"verity":1,"outcome":"failed","artifacts":{},"reason":"CI red"}');
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-11']);
  assertEqual(code, 20, 'marker outcome maps to the exit code');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.error, 'CI red', 'marker reason becomes error');
});

test('characterize: gated marker → exit 10, artifacts carried, error stays null', () => {
  const fx = fixture();
  canned(
    fx,
    'Waiting.\n{"verity":1,"outcome":"gated","gate":"review:merge","artifacts":{"pr":9},"reason":"needs human"}',
  );
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-12']);
  assertEqual(code, 10);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'gated');
  assertEqual(JSON.stringify(obj.artifacts), '{"pr":9}');
  assertEqual(obj.error, null);
});

test('characterize: no marker + is_error:false + subtype:success → success', () => {
  const fx = fixture();
  canned(fx, 'All wrapped up, nothing structured to report.');
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-13']);
  assertEqual(code, 0);
  assertEqual(parseSingleObject(out).outcome, 'success');
});

test('characterize: no marker + agent error → failed, first line of result as error', () => {
  const fx = fixture();
  canned(fx, 'boom happened\nstack noise', {
    is_error: true,
    subtype: 'error_during_execution',
  });
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-14']);
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.error, 'boom happened');
});

test('characterize: error_max_turns → failed with "max turns (N) exhausted"', () => {
  const fx = fixture();
  canned(fx, '', { is_error: true, subtype: 'error_max_turns' });
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-15', '--max-turns', '7']);
  assertEqual(code, 20);
  assertEqual(parseSingleObject(out).error, 'max turns (7) exhausted');
});

// --- usage / cost normalization + tool-call counting ---

test('characterize: tokens.in folds input + cache-creation + cache-read; est_usd from total_cost_usd', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { out } = run(fx, ['build', '7', '--run-id', 'c-16']);
  const obj = parseSingleObject(out);
  assertEqual(obj.tokens.in, 412034, '400000 + 10000 + 2034');
  assertEqual(obj.tokens.out, 38112);
  assertEqual(obj.est_usd, 1.87);
  assertEqual(obj.tool_calls, 2, 'two tool_use blocks; the tool_result does not count');
});

test('characterize: absent total_cost_usd → est_usd null (unknown ≠ 0, ADR-0008)', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS, { total_cost_usd: undefined, usage: {} });
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-17']);
  assertEqual(code, 0);
  const obj = parseSingleObject(out);
  assertEqual(obj.est_usd, null, 'unknown cost is null, never 0');
  assertEqual(obj.tokens.in, 0);
  assertEqual(obj.tokens.out, 0);
});

// --- nonzero exit / malformed transcript / stderr line grammar ---

test('characterize: nonzero agent exit with a parseable result still classifies normally', () => {
  const fx = fixture();
  canned(fx, 'it broke', { is_error: true, subtype: 'error_during_execution' });
  const { out, code } = run(fx, ['build', '7', '--run-id', 'c-18'], { STUB_EXIT: '1' });
  assertEqual(code, 20, 'transcript wins over the process exit code');
  assertEqual(parseSingleObject(out).outcome, 'failed');
});

test('characterize: nonzero agent exit with NO result object → malformed-output names the exit', () => {
  const fx = fixture();
  fs.writeFileSync(fx.transcriptFile, ''); // agent produced nothing
  const { out, stderr, code } = run(fx, ['build', '7', '--run-id', 'c-19'], { STUB_EXIT: '3' });
  assertEqual(code, 30);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'infra_error');
  assert(obj.error.includes('agent exit 3'), 'hint carries the agent exit status');
  assert(stderr.includes('verity-agent-exec: 30 malformed-output:'), 'stderr slug line');
});

test('characterize: non-JSON transcript → 30 malformed-output, names the transcript path', () => {
  const fx = fixture();
  fs.writeFileSync(fx.transcriptFile, 'plain prose\nstill not json\n');
  const { out, stderr, code } = run(fx, ['build', '7', '--run-id', 'c-20']);
  assertEqual(code, 30);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'infra_error');
  assert(obj.error.includes('no parseable result object'), 'names the problem');
  const transcript = path.join(fx.home, '.verity', 'logs', 'c-20', 'build.jsonl');
  assert(obj.error.includes(transcript), 'points at the retained transcript');
  assert(stderr.includes('verity-agent-exec: 30 malformed-output:'), 'stderr slug line');
});

test('characterize: infra stderr is exactly one machine-parsable line', () => {
  const fx = fixture();
  fs.writeFileSync(fx.transcriptFile, 'garbage\n');
  const { stderr } = run(fx, ['build', '7', '--run-id', 'c-21']);
  const lines = stderr.split('\n').filter(Boolean);
  assertEqual(lines.length, 1, 'one line, nothing else on stderr');
  assert(
    /^verity-agent-exec: 30 [a-z-]+: .+$/.test(lines[0]),
    `stderr line matches the §8.2 grammar: ${lines[0]}`,
  );
});

// --- stage 7 seam: provider registry ---

test('registry: getProvider("claude") returns the driver; listProviders() names it', () => {
  const provider = registry.getProvider('claude');
  assertEqual(provider.id, 'claude');
  assertEqual(provider, claude, 'the registry hands out the claude.cjs module itself');
  // Generalized in stage 8: codex registered beside claude (spec: "stage 7's
  // characterization set generalized"); claude remains the reference driver.
  assertEqual(
    JSON.stringify(registry.listProviders()),
    '["claude","codex"]',
    'claude + codex as of stage 8',
  );
});

test('registry: unknown provider → stable error listing valid providers', () => {
  let thrown = null;
  try {
    registry.getProvider('opencode');
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== null, 'unknown id throws');
  assertEqual(thrown.name, 'AgentExecError');
  assertEqual(thrown.slug, 'unsupported-agent');
  assertEqual(thrown.message, "unsupported agent 'opencode' — supported providers: claude, codex");
  // Inherited Object.prototype names must not resolve to phantom providers.
  let proto = null;
  try {
    registry.getProvider('hasOwnProperty');
  } catch (err) {
    proto = err;
  }
  assert(proto !== null, 'prototype keys are not providers');
});

test('registry: unsupported --agent still exits 30 with the unsupported-agent slug', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { out, stderr, code } = run(fx, ['build', '7', '--run-id', 'r-1', '--agent', 'opencode']);
  assertEqual(code, 30);
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 unsupported-agent:'), 'stderr slug line');
  assert(stderr.includes('supported providers: claude'), 'error names the registry list');
});

// --- stage 7 seam: binary override precedence ---
// explicit flag (none yet) → VERITY_CLAUDE_BIN → legacy VERITY_AGENT_BIN → `claude`

test('resolveBinary: VERITY_CLAUDE_BIN → VERITY_AGENT_BIN → provider default', () => {
  assertEqual(
    claude.resolveBinary({ VERITY_CLAUDE_BIN: '/c', VERITY_AGENT_BIN: '/a' }),
    '/c',
    'provider-specific override wins',
  );
  assertEqual(claude.resolveBinary({ VERITY_AGENT_BIN: '/a' }), '/a', 'legacy seam preserved');
  assertEqual(claude.resolveBinary({}), 'claude', 'provider default last');
  assertEqual(claude.defaultBinary, 'claude');
  assertEqual(claude.binaryEnvVar, 'VERITY_CLAUDE_BIN');
});

test('seam: VERITY_CLAUDE_BIN beats VERITY_AGENT_BIN end-to-end', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { code } = run(fx, ['build', '7', '--run-id', 'r-2'], {
    VERITY_CLAUDE_BIN: fx.stub,
    VERITY_AGENT_BIN: path.join(fx.dir, 'no-such-claude'),
  });
  assertEqual(code, 0, 'the VERITY_CLAUDE_BIN stub ran, not the broken legacy path');
  assert(fs.existsSync(fx.argvFile), 'stub invoked via the provider-specific override');
});

// --- stage 7 seam: agent-exec.cjs contains zero Claude wire details ---

test('seam: no Claude wire strings survive in agent-exec.cjs (grep assertion)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'verity', 'bin', 'lib', 'agent-exec.cjs'),
    'utf8',
  );
  const forbidden = [
    'stream-json', // wire output format
    'tool_use', // transcript event grammar
    'total_cost_usd', // Claude usage field
    '--allowed-tools', // Claude argv flag
    "'--max-turns'", // argv element (the flag NAME may appear in usage text)
    '--output-format', // Claude argv flag
    'is_error', // Claude result field
    'subtype', // Claude result field
    'error_max_turns', // Claude failure mode
    'cache_creation_input_tokens', // Claude usage field
    'cache_read_input_tokens', // Claude usage field
    'spawnSync', // execution moved into the driver
  ];
  for (const needle of forbidden) {
    assert(!src.includes(needle), `agent-exec.cjs must not contain ${JSON.stringify(needle)}`);
  }
});

test('seam: agent-exec module.exports surface is intact (worker/test compatibility)', () => {
  const expected = [
    'AgentExecError',
    'DEFAULT_MAX_TURNS',
    'MIN_CLAUDE_VERSION',
    'RESULT_CONTRACT',
    'SCHEMA',
    'checkAgentVersion',
    'compareVersions',
    'countToolCalls',
    'dispatch',
    'exitCodeFor',
    'extractMarker',
    'parseVersion',
    'readAllowlist',
    'readParkedResult', // stage 31 (ADR-0014): re-read a parked result for the worker's resume
    'renderPrompt',
    'resolveRole',
  ];
  assertEqual(
    JSON.stringify(Object.keys(agentExec).sort()),
    JSON.stringify(expected),
    'exact pre-refactor key set',
  );
  assertEqual(agentExec.checkAgentVersion, claude.checkVersion, 're-export, not a copy');
  assertEqual(agentExec.countToolCalls, claude.countToolCalls, 're-export, not a copy');
  assertEqual(agentExec.readAllowlist, claude.readAllowlist, 're-export, not a copy');
  assertEqual(agentExec.renderPrompt, claude.renderPrompt, 're-export, not a copy');
  assertEqual(agentExec.MIN_CLAUDE_VERSION, claude.MIN_CLAUDE_VERSION, 'same pin');
});
