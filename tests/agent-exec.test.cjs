// T05 — `verity agent-exec` (SKETCH §3.3), driven entirely by a stub agent
// binary (VERITY_AGENT_BIN) emitting canned stream-json — NO live API calls.
// $HOME is redirected per fixture so transcripts land in a temp dir.
//
// Covers: success / gated / failed (exit 0/10/20), malformed output → 30,
// version-too-old → 30, missing binary → 30, unsupported --agent → 30,
// unknown role → 30, transcript file under the (redirected) log dir, the real
// verified claude flag spellings in the stub's argv, prompt rendering
// ($ARGUMENTS, frontmatter, result contract), and the T06 deny-by-default
// allowlists (verbatim pass-through; missing/empty/malformed .tools.json → 30;
// packaged review list has no merge-capable tool).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentExec = require('../verity/bin/lib/agent-exec.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// Stub agent: answers --version from STUB_VERSION, records its argv to
// STUB_ARGV_FILE, replays the canned transcript from STUB_TRANSCRIPT on stdout.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-agent-exec-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub');
  fs.writeFileSync(stub, STUB);
  fs.chmodSync(stub, 0o755);
  const argvFile = path.join(dir, 'argv.json');
  const transcriptFile = path.join(dir, 'canned.jsonl');
  return { dir, home, stub, argvFile, transcriptFile };
}

// Canned stream-json transcript whose last line is the claude result object.
// Carries TWO tool-use events (tool_result blocks must NOT count) so every
// test doubles as a stage-3 tool_calls fixture.
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

function run(fx, args, env = {}) {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_AGENT_BIN: fx.stub,
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
  assertEqual(lines.length, 1, '--json must emit exactly one line on stdout');
  const obj = JSON.parse(lines[0]);
  assertEqual(obj.schema, 1, 'schema must be 1');
  return obj;
}

const MARKER_SUCCESS =
  'Opened the PR.\n{"verity":1,"outcome":"success","gate":null,"artifacts":{"pr":114,"issues":[98]},"reason":"PR #114 opened"}';

// --- success ---

test('agent-exec: success — exit 0, §3.3 result object, tokens/est_usd from usage', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { out, code } = run(fx, ['build', '7', '--run-id', 'r-1']);
  assertEqual(code, 0, 'success exits 0');
  const obj = parseSingleObject(out);
  assertEqual(obj.role, 'build');
  assertEqual(obj.outcome, 'success');
  assertEqual(obj.tokens.in, 412034, 'in = input + cache_creation + cache_read');
  assertEqual(obj.tokens.out, 38112);
  assertEqual(obj.est_usd, 1.87);
  assertEqual(obj.tool_calls, 2, 'tool_use events counted from the transcript (stage 3)');
  assert(typeof obj.wall_secs === 'number', 'wall_secs is a number');
  assertEqual(JSON.stringify(obj.artifacts), '{"pr":114,"issues":[98]}');
  assertEqual(obj.error, null);
});

test('agent-exec: transcript streamed to $HOME/.verity/logs/<run-id>/<role>.jsonl', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { code } = run(fx, ['build', '7', '--run-id', 'r-log']);
  assertEqual(code, 0);
  const transcript = path.join(fx.home, '.verity', 'logs', 'r-log', 'build.jsonl');
  assert(fs.existsSync(transcript), 'transcript file exists under redirected $HOME');
  assertEqual(
    fs.readFileSync(transcript, 'utf8'),
    fs.readFileSync(fx.transcriptFile, 'utf8'),
    'transcript is the raw agent stream, verbatim',
  );
});

test('agent-exec: no marker but clean CLI result counts as success', () => {
  const fx = fixture();
  canned(fx, 'All done, nothing else to report.');
  const { out, code } = run(fx, ['build', '7', '--run-id', 'r-2']);
  assertEqual(code, 0);
  assertEqual(parseSingleObject(out).outcome, 'success');
});

// --- gated ---

test('agent-exec: gated — marker outcome gated, exit 10', () => {
  const fx = fixture();
  canned(
    fx,
    'Awaiting approval.\n{"verity":1,"outcome":"gated","gate":"review:merge","artifacts":{},"reason":"merge needs a human"}',
  );
  const { out, code } = run(fx, ['review', '7', '114', '--run-id', 'r-3']);
  assertEqual(code, 10, 'gated exits 10');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'gated');
  assertEqual(obj.role, 'review');
  assertEqual(obj.error, null);
});

// --- failed ---

test('agent-exec: failed — marker outcome failed, exit 20, reason in error', () => {
  const fx = fixture();
  canned(fx, '{"verity":1,"outcome":"failed","artifacts":{},"reason":"CI would not go green"}');
  const { out, code } = run(fx, ['build', '7', '--run-id', 'r-4']);
  assertEqual(code, 20, 'role failure exits 20');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.error, 'CI would not go green');
});

test('agent-exec: agent-level error (is_error, no marker) maps to failed/20', () => {
  const fx = fixture();
  canned(fx, 'something broke', { is_error: true, subtype: 'error_during_execution' });
  const { out, code } = run(fx, ['build', '7', '--run-id', 'r-5'], { STUB_EXIT: '1' });
  assertEqual(code, 20);
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.error, 'something broke');
});

test('agent-exec: error_max_turns maps to failed/20 with a max-turns error', () => {
  const fx = fixture();
  canned(fx, '', { is_error: true, subtype: 'error_max_turns' });
  const { out, code } = run(fx, ['build', '7', '--run-id', 'r-6', '--max-turns', '5']);
  assertEqual(code, 20);
  assert(parseSingleObject(out).error.includes('max turns (5)'), 'names the turn limit');
});

// --- infra (exit 30) ---

test('agent-exec: malformed agent output → outcome infra_error, exit 30', () => {
  const fx = fixture();
  fs.writeFileSync(fx.transcriptFile, 'this is not json\nnope\n');
  const { out, stderr, code } = run(fx, ['build', '7', '--run-id', 'r-7']);
  assertEqual(code, 30, 'malformed output exits 30');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'infra_error');
  assert(obj.error.includes('no parseable result object'), 'error names the problem');
  assert(stderr.includes('verity-agent-exec: 30 malformed-output:'), 'single-line stderr error');
});

test('agent-exec: agent version below pinned minimum → exit 30', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { out, stderr, code } = run(fx, ['build', '7', '--run-id', 'r-8'], {
    STUB_VERSION: '2.0.9',
  });
  assertEqual(code, 30, 'version-too-old exits 30');
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 version-too-old:'), 'stderr slug');
  assert(stderr.includes(agentExec.MIN_CLAUDE_VERSION), 'names the pinned minimum');
});

test('agent-exec: missing agent binary → exit 30', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { stderr, code } = run(fx, ['build', '7', '--run-id', 'r-9'], {
    VERITY_AGENT_BIN: path.join(fx.dir, 'no-such-claude'),
  });
  assertEqual(code, 30, 'missing binary exits 30');
  assert(stderr.includes('verity-agent-exec: 30 agent-missing:'), 'stderr slug');
});

test('agent-exec: --agent opencode is unsupported for now → exit 30', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { stderr, code } = run(fx, ['build', '7', '--run-id', 'r-10', '--agent', 'opencode']);
  assertEqual(code, 30);
  assert(stderr.includes('unsupported-agent'), 'stderr slug');
});

test('agent-exec: unknown role → exit 30', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { stderr, code } = run(fx, ['nosuchrole', '--run-id', 'r-11']);
  assertEqual(code, 30);
  assert(stderr.includes('unknown-role'), 'stderr slug');
});

test('agent-exec: missing --run-id is a usage error, exit 30', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const { code, stderr } = run(fx, ['build', '7']);
  assertEqual(code, 30);
  assert(stderr.includes('--run-id'), 'error names the missing flag');
});

// --- invocation contract (verified flag spellings + prompt rendering) ---

test('agent-exec: invokes the verified claude headless flags', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  run(fx, ['build', '7', '--run-id', 'r-12', '--max-turns', '13']);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[0], '-p', 'print mode');
  const a = argv.join(' ');
  assert(a.includes('--output-format stream-json'), 'stream-json output');
  assert(argv.includes('--verbose'), 'stream-json requires --verbose with --print');
  assert(a.includes('--max-turns 13'), '--max-turns passed through');
  // T06: the packaged build allowlist is always passed (no role runs unscoped).
  const i = argv.indexOf('--allowed-tools');
  assert(i > 0, '--allowed-tools always present (deny-by-default, T06)');
  const packaged = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'commands', 'verity', 'build.tools.json'), 'utf8'),
  );
  assertEqual(
    JSON.stringify(argv.slice(i + 1)),
    JSON.stringify(packaged),
    'packaged build allowlist passed verbatim, flag last',
  );
});

test('agent-exec: prompt = role file minus frontmatter, $ARGUMENTS filled, contract appended', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  run(fx, ['build', '7', '--run-id', 'r-13']);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  const prompt = argv[1];
  assert(prompt.includes('Run the Stage Manager for stage 7'), '$ARGUMENTS substituted');
  assert(!prompt.includes('$ARGUMENTS'), 'no placeholder remains');
  assert(!prompt.startsWith('---'), 'YAML frontmatter stripped');
  assert(prompt.includes('<headless-result-contract>'), 'result contract appended');
});

test('agent-exec: allowlist seam — <role>.tools.json passed verbatim, repo copy wins', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = path.join(fx.dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), '---\nname: echo\n---\nEcho $ARGUMENTS\n');
  fs.writeFileSync(
    path.join(roleDir, 'echo.tools.json'),
    JSON.stringify(['Read', 'Grep', 'Bash(git *)']),
  );
  const { code } = run(fx, ['echo', 'hi', '--run-id', 'r-14']);
  assertEqual(code, 0);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  const i = argv.indexOf('--allowed-tools');
  assert(i > 0, '--allowed-tools passed when the allowlist exists');
  assertEqual(
    JSON.stringify(argv.slice(i + 1)),
    '["Read","Grep","Bash(git *)"]',
    'entries verbatim, flag last',
  );
});

test('agent-exec: malformed allowlist JSON → exit 30 bad-allowlist', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = path.join(fx.dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), 'Echo $ARGUMENTS\n');
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), '{not json');
  const { stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'r-15']);
  assertEqual(code, 30);
  assert(stderr.includes('bad-allowlist'), 'stderr slug');
});

// --- T06: deny-by-default allowlists ---

test('agent-exec: missing <role>.tools.json → deny-all, exit 30, agent never invoked', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = path.join(fx.dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), 'Echo $ARGUMENTS\n'); // no .tools.json
  const { out, stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'r-16']);
  assertEqual(code, 30, 'missing allowlist exits 30');
  assertEqual(parseSingleObject(out).outcome, 'infra_error');
  assert(stderr.includes('verity-agent-exec: 30 missing-allowlist:'), 'single-line stderr slug');
  assert(stderr.includes(path.join(roleDir, 'echo.tools.json')), 'names the missing file');
  assert(!fs.existsSync(fx.argvFile), 'agent was never invoked (deny-all, not default tools)');
});

test('agent-exec: empty allowlist array is rejected (cannot mean "default tools") → exit 30', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  const roleDir = path.join(fx.dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, 'echo.md'), 'Echo $ARGUMENTS\n');
  fs.writeFileSync(path.join(roleDir, 'echo.tools.json'), '[]');
  const { stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'r-17']);
  assertEqual(code, 30);
  assert(stderr.includes('bad-allowlist'), 'stderr slug');
  assert(stderr.includes('non-empty'), 'error explains the rule');
  assert(!fs.existsSync(fx.argvFile), 'agent was never invoked');
});

test('packaged allowlists: every role .md ships a sibling non-empty .tools.json', () => {
  const dir = path.join(__dirname, '..', 'commands', 'verity');
  const roles = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3));
  assert(roles.length >= 13, 'all 13 role files present');
  for (const role of roles) {
    const file = path.join(dir, `${role}.tools.json`);
    assert(fs.existsSync(file), `${role}.tools.json exists`);
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(Array.isArray(list) && list.length > 0, `${role}: non-empty array`);
    assert(
      list.every((t) => typeof t === 'string' && t.trim() === t && t.length > 0),
      `${role}: entries are trimmed non-empty strings`,
    );
    assert(
      list.every((t) => !t.startsWith('Bash(') || t.endsWith(':*)')),
      `${role}: every Bash entry is prefix-scoped`,
    );
  }
});

test('packaged review allowlist: no merge-capable tool (merge authority is the worker, T13)', () => {
  const file = path.join(__dirname, '..', 'commands', 'verity', 'review.tools.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(!list.includes('Bash'), 'no unrestricted Bash');
  assert(
    list.every((t) => !/merge/i.test(t)),
    'nothing matching /merge/ (gh pr merge, verity review merge, git merge)',
  );
  assert(
    list.every((t) => !t.includes('git')),
    'no git at all — the reviewer reads via gh pr view/diff',
  );
  assert(
    list.every((t) => !t.includes('node')),
    'no node fallback (would be arbitrary execution incl. verity review merge)',
  );
  assert(!list.includes('Edit') && !list.includes('Write'), 'reviewer does not edit code');
});

// --- unit-level (no CLI spawn) ---

test('parseVersion/compareVersions: semver triples', () => {
  assertEqual(JSON.stringify(agentExec.parseVersion('2.1.170 (Claude Code)')), '[2,1,170]');
  assertEqual(agentExec.parseVersion('nonsense'), null);
  assertEqual(agentExec.compareVersions([2, 1, 170], [2, 1, 170]), 0);
  assertEqual(agentExec.compareVersions([2, 0, 999], [2, 1, 170]), -1);
  assertEqual(agentExec.compareVersions([3, 0, 0], [2, 1, 170]), 1);
});

test('extractMarker: last single-line JSON outcome wins; fences and noise ignored', () => {
  const text = [
    'prose',
    '{"outcome":"failed","reason":"earlier draft"}',
    '```json',
    '{"verity":1,"outcome":"gated","gate":"review:merge","artifacts":{}}',
    '```',
  ].join('\n');
  const m = agentExec.extractMarker(text);
  assertEqual(m.outcome, 'gated');
  assertEqual(agentExec.extractMarker('no marker here {broken'), null);
  assertEqual(agentExec.extractMarker('{"outcome":"sideways"}'), null, 'unknown outcome rejected');
});

test('countToolCalls: counts tool_use blocks only; tolerates noise and a missing file', () => {
  const fx = fixture();
  const transcript = path.join(fx.dir, 'transcript.jsonl');
  const lines = [
    'not json at all',
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] },
    }),
    JSON.stringify({ type: 'assistant', message: { content: 'string content, no blocks' } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }] },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
  ];
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  assertEqual(agentExec.countToolCalls(transcript), 3, 'tool_use blocks across assistant lines');
  assertEqual(agentExec.countToolCalls(path.join(fx.dir, 'nope.jsonl')), 0, 'missing file → 0');
});

test('exitCodeFor: outcome → 0/10/20/30 map', () => {
  assertEqual(agentExec.exitCodeFor({ outcome: 'success' }), 0);
  assertEqual(agentExec.exitCodeFor({ outcome: 'gated' }), 10);
  assertEqual(agentExec.exitCodeFor({ outcome: 'failed' }), 20);
  assertEqual(agentExec.exitCodeFor({ outcome: 'infra_error' }), 30);
  assertEqual(agentExec.exitCodeFor({}), 30, 'unknown outcome is infra');
});
