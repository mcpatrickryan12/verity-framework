// Characterization suite for the Grok Build driver (agents/grok.cjs) — the
// same observation discipline as tests/agents.test.cjs: the process boundary
// (CLI argv in, result object / exit code / stderr out) and stable module
// exports, never extraction internals. Covers: registry entry; binary
// selection & env precedence (VERITY_GROK_BIN); version gate; the verified
// headless argv (repeatable --allow LAST, --verbatim, streaming-messages-json);
// allowlist errors; substrate narrowing; transcript parsing / tool counting /
// usage + result normalization against the documented Grok Build wire shape
// (init/result lines may omit placeholder fields — the parsers must not
// require them); the grok host pass + installGrok layout; doctor's grok rows.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grok = require('../verity/bin/lib/agents/grok.cjs');
const registry = require('../verity/bin/lib/agents/index.cjs');
const install = require('../verity/bin/lib/install.cjs');
const doctor = require('../verity/bin/lib/doctor.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// Same stub-agent seam as tests/agents.test.cjs: answers --version from
// STUB_VERSION, records argv to STUB_ARGV_FILE, replays STUB_TRANSCRIPT.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write((process.env.STUB_VERSION || '1.2.0') + ' (Grok Build)\\n');
  process.exit(0);
}
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args));
if (process.env.STUB_TRANSCRIPT) process.stdout.write(fs.readFileSync(process.env.STUB_TRANSCRIPT, 'utf8'));
process.exit(Number(process.env.STUB_EXIT || 0));
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-agents-grok-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'grok-stub');
  fs.writeFileSync(stub, STUB);
  fs.chmodSync(stub, 0o755);
  const argvFile = path.join(dir, 'argv.json');
  const transcriptFile = path.join(dir, 'canned.jsonl');
  return { dir, home, stub, argvFile, transcriptFile };
}

// Canned streaming-messages-json transcript in the DOCUMENTED Grok Build
// shape (user-guide 14-headless-mode.md): init line, assistant lines with
// tool_use blocks, a user tool_result line (must NOT count), and a terminal
// type:"result". Grok omits placeholder fields rather than zero-filling —
// the init line here carries fewer fields than Claude's on purpose.
function canned(fx, finalText, overrides = {}) {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's-g1', model: 'grok-4.6' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'working...' },
          { type: 'thinking', thinking: 'plan' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'x' } },
        ],
      },
      session_id: 's-g1',
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1' }] },
      session_id: 's-g1',
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_2', name: 'run_terminal_cmd', input: {} }],
      },
      session_id: 's-g1',
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      result: finalText,
      stop_reason: 'end_turn',
      session_id: 's-g1',
      total_cost_usd: 0.0127,
      usage: {
        input_tokens: 812,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 41000,
        output_tokens: 210,
      },
      ...overrides,
    },
  ];
  fs.writeFileSync(fx.transcriptFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

// A scratch role with a KNOWN allowlist, so argv-order tests can assert the
// exact tail instead of depending on a packaged .tools.json.
const ECHO_TOOLS = ['Read', 'Grep', 'Task', 'Bash(git *)'];
// What must actually reach --allow: the T06 list projected onto Grok's rule
// vocabulary (Task has no Grok rule spelling; strict parsing would abort on it).
const ECHO_TOOLS_PROJECTED = ['Read', 'Grep', 'Bash(git *)'];
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
      VERITY_GROK_BIN: '', // empty = unset (precedence characterized below)
      STUB_ARGV_FILE: fx.argvFile,
      STUB_TRANSCRIPT: fx.transcriptFile,
      ...env,
    },
  };
  try {
    const out = execFileSync(
      'node',
      [CLI, 'agent-exec', ...args, '--agent', 'grok', '--cwd', fx.dir, '--json'],
      opts,
    );
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

// --- registry ---

test('grok: registered as a provider beside claude and codex', () => {
  assert(registry.listProviders().includes('grok'), 'grok listed');
  const p = registry.getProvider('grok');
  assertEqual(p.id, 'grok');
  assertEqual(p.displayName, 'Grok Build');
  assertEqual(p.defaultBinary, 'grok');
  assertEqual(p.binaryEnvVar, 'VERITY_GROK_BIN');
  assertEqual(p.supportsMaxTurns, true, 'Grok Build headless supports --max-turns');
});

test('grok: unsupported-agent error now names grok among the valid providers', () => {
  let err = null;
  try {
    registry.getProvider('gemini');
  } catch (e) {
    err = e;
  }
  assert(err, 'unknown id throws');
  assert(err.message.includes('grok'), 'error names grok as supported');
});

// --- binary selection & env precedence ---

test('grok: VERITY_GROK_BIN wins over VERITY_AGENT_BIN wins over default', () => {
  assertEqual(
    grok.resolveBinary({ VERITY_GROK_BIN: '/a', VERITY_AGENT_BIN: '/b' }),
    '/a',
    'provider-specific override first',
  );
  assertEqual(grok.resolveBinary({ VERITY_AGENT_BIN: '/b' }), '/b', 'legacy seam second');
  assertEqual(grok.resolveBinary({}), 'grok', 'PATH default last');
});

// --- version gate ---

test('grok: version gate — missing / unparsable / too-old / ok', () => {
  const exec =
    (out, status = 0, error = null) =>
    () => ({ stdout: out, status, error });
  const missing = grok.checkVersion('grok', { exec: exec('', 1, { code: 'ENOENT' }) });
  assertEqual(missing.ok, false);
  assertEqual(missing.slug, 'agent-missing');
  assert(missing.error.includes('not runnable'), 'names the failure');

  const unparsable = grok.checkVersion('grok', { exec: exec('beta build\n') });
  assertEqual(unparsable.ok, false);
  assertEqual(unparsable.slug, 'agent-missing');
  assert(unparsable.error.includes('could not parse'), 'names the parse failure');

  const old = grok.checkVersion('grok', { exec: exec('0.9.0 (Grok Build)\n') });
  assertEqual(old.ok, false);
  assertEqual(old.slug, 'version-too-old');
  assert(old.error.includes(grok.MIN_GROK_VERSION), 'names the pin');
  assert(old.error.includes('x.ai/cli'), 'names the remedy');

  const ok = grok.checkVersion('grok', { exec: exec('1.2.0 (Grok Build)\n') });
  assertEqual(ok.ok, true);
  assertEqual(ok.version, '1.2.0');
});

// --- argv (verified Grok Build headless flag spellings) ---

test('grok: buildArgv — verbatim prompt, streaming-messages-json, repeatable --allow LAST', () => {
  const argv = grok.buildArgv({
    prompt: 'P',
    maxTurns: 5,
    allowlist: ['Read', 'Bash(git *)'],
  });
  assertEqual(
    JSON.stringify(argv),
    JSON.stringify([
      '-p',
      'P',
      '--verbatim',
      '--output-format',
      'streaming-messages-json',
      '--max-turns',
      '5',
      '--allow',
      'Read',
      '--allow',
      'Bash(git *)',
    ]),
    'exact argv shape',
  );
});

test('grok: buildArgv — model override is omitted-in', () => {
  const without = grok.buildArgv({ prompt: 'P', maxTurns: 1, allowlist: ['Read'] });
  assert(!without.includes('--model'), 'no --model without an override');
  const withModel = grok.buildArgv({
    prompt: 'P',
    maxTurns: 1,
    allowlist: ['Read'],
    model: 'grok-4.6',
  });
  const i = withModel.indexOf('--model');
  assert(i > -1, '--model present with an override');
  assertEqual(withModel[i + 1], 'grok-4.6');
  assert(i < withModel.indexOf('--allow'), '--model before the variadic --allow tail');
});

test('grok: NEVER passes an auto-approve flag — deny-by-default is the permission model', () => {
  const argv = grok.buildArgv({ prompt: 'P', maxTurns: 1, allowlist: ['Read'] });
  for (const forbidden of ['--yolo', '--always-approve', '--permission-mode']) {
    assert(!argv.includes(forbidden), `${forbidden} must never appear`);
  }
});

// --- rule-vocabulary projection ---
// Verified against xai-org/grok-build sources: permission/rules.rs
// tool_name_to_filter (the accepted prefixes; unknown -> Err) and headless.rs
// parse_permission_rules_strict (one bad --allow aborts the invocation).

test('grok: projectAllowlist keeps every Grok-expressible entry verbatim, drops the rest', () => {
  const projected = grok.projectAllowlist([
    'Read',
    'Task',
    'Write(docs/**)',
    'Glob',
    'Bash(git status:*)',
    'mcp__github__get_issue',
    'FutureTool(x)',
  ]);
  assertEqual(
    JSON.stringify(projected),
    JSON.stringify([
      'Read',
      'Write(docs/**)',
      'Glob',
      'Bash(git status:*)',
      'mcp__github__get_issue',
    ]),
    'kept entries byte-identical and in order; Task and unknown prefixes dropped',
  );
});

test('grok: a role whose allowlist projects to nothing is refused, never launched rule-less', () => {
  let err = null;
  try {
    grok.projectAllowlist(['Task', 'NotebookEdit']);
  } catch (e) {
    err = e;
  }
  assert(err?.message.includes('refusing the dispatch'), 'fails closed');
  assertEqual(err.slug, 'unenforceable-policy');
});

// --- allowlist (T06) ---

test('grok: allowlist errors — missing file / invalid JSON / empty array', () => {
  const fx = fixture();
  let err = null;
  try {
    grok.readAllowlist(path.join(fx.dir, 'none.tools.json'));
  } catch (e) {
    err = e;
  }
  assert(err?.message.includes('deny-all'), 'missing file is deny-all');

  const bad = path.join(fx.dir, 'bad.tools.json');
  fs.writeFileSync(bad, '{nope');
  err = null;
  try {
    grok.readAllowlist(bad);
  } catch (e) {
    err = e;
  }
  assert(err?.message.includes('invalid allowlist'), 'invalid JSON rejected');

  const empty = path.join(fx.dir, 'empty.tools.json');
  fs.writeFileSync(empty, '[]');
  err = null;
  try {
    grok.readAllowlist(empty);
  } catch (e) {
    err = e;
  }
  assert(err?.message.includes('non-empty'), 'empty array rejected');
});

// --- substrate narrowing (ADR-0029) ---

test('grok: narrowForSubstrate strips gh/network grants on local, identity elsewhere', () => {
  const policy = {
    allowlist: ['Read', 'Bash(gh pr create:*)', 'WebFetch', 'WebSearch(x)', 'Bash(git *)'],
  };
  const github = grok.narrowForSubstrate(policy, 'github');
  assert(github === policy, 'non-local returns the same reference');
  const local = grok.narrowForSubstrate(policy, 'local');
  assertEqual(JSON.stringify(local.allowlist), JSON.stringify(['Read', 'Bash(git *)']));
});

test('grok: narrowing to an empty allowlist refuses the dispatch', () => {
  let err = null;
  try {
    grok.narrowForSubstrate({ allowlist: ['WebFetch', 'Bash(gh pr list:*)'] }, 'local');
  } catch (e) {
    err = e;
  }
  assert(err?.message.includes('NO tools at all'), 'fails closed, never tool-less');
});

// --- transcript parsing / counting / normalization ---

test('grok: transcript filename carries the provider suffix (never clobbers claude)', () => {
  assertEqual(grok.transcriptFilename('build'), 'build.grok.jsonl');
});

test('grok: parseTranscript finds the terminal result; tool_use counted, tool_result not', () => {
  const fx = fixture();
  canned(fx, 'final text');
  const final = grok.parseTranscript(fx.transcriptFile);
  assert(final && final.type === 'result', 'terminal result found');
  assertEqual(final.result, 'final text');
  assertEqual(
    grok.countToolCalls(fx.transcriptFile),
    2,
    'two tool_use blocks, tool_result excluded',
  );
});

test('grok: usage normalization — uncached input + both cache buckets; cost float verbatim', () => {
  const fx = fixture();
  canned(fx, 'x');
  const usage = grok.normalizeUsage(grok.parseTranscript(fx.transcriptFile));
  assertEqual(usage.tokens.in, 812 + 100 + 41000, 'full prompt sum (documented identity)');
  assertEqual(usage.tokens.out, 210);
  assertEqual(usage.est_usd, 0.0127);
});

test('grok: absent total_cost_usd (partial-cost omission) → est_usd null, never 0', () => {
  const fx = fixture();
  canned(fx, 'x', { total_cost_usd: undefined });
  const usage = grok.normalizeUsage(grok.parseTranscript(fx.transcriptFile));
  assertEqual(usage.est_usd, null, 'omitted cost is UNKNOWN (ADR-0008)');
});

test('grok: result normalization — marker wins; bare success; both max-turns spellings', () => {
  const marker = grok.normalizeResult(
    { result: MARKER_SUCCESS, is_error: true, subtype: 'weird' },
    { maxTurns: 5 },
  );
  assertEqual(marker.outcome, 'success', 'in-band marker beats CLI fields');
  assertEqual(marker.artifacts.pr, 7);

  const bare = grok.normalizeResult(
    { result: 'no marker', is_error: false, subtype: 'success' },
    { maxTurns: 5 },
  );
  assertEqual(bare.outcome, 'success');

  const viaSubtype = grok.normalizeResult(
    { result: '', is_error: true, subtype: 'error_max_turns' },
    { maxTurns: 5 },
  );
  assertEqual(viaSubtype.error, 'max turns (5) exhausted');

  const viaStopReason = grok.normalizeResult(
    { result: '', is_error: true, subtype: 'failure', stop_reason: 'max_turn_requests' },
    { maxTurns: 5 },
  );
  assertEqual(viaStopReason.error, 'max turns (5) exhausted', 'Grok stop_reason spelling mapped');
});

// --- end-to-end through the CLI (--agent grok) ---

test('grok e2e: stub run over the documented wire shape → success result + verified argv', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  echoRole(fx);
  const { out, code } = run(fx, ['echo', 'hi', '--run-id', 'g-1', '--max-turns', '4']);
  assertEqual(code, 0, 'stub run succeeded');
  const obj = parseSingleObject(out);
  assertEqual(obj.outcome, 'success');
  assertEqual(obj.tokens.in, 812 + 100 + 41000);
  assertEqual(obj.est_usd, 0.0127);
  const argv = JSON.parse(fs.readFileSync(fx.argvFile, 'utf8'));
  assertEqual(argv[argv.indexOf('--output-format') + 1], 'streaming-messages-json');
  assert(argv.includes('--verbatim'), 'prompt sent verbatim');
  assertEqual(argv[argv.indexOf('--max-turns') + 1], '4');
  const allows = argv.filter((_, i) => argv[i - 1] === '--allow');
  assertEqual(
    JSON.stringify(allows),
    JSON.stringify(ECHO_TOOLS_PROJECTED),
    'T06 entries projected onto the Grok rule vocabulary, then verbatim as --allow',
  );
});

test('grok e2e: version below pin → 30, version-too-old, names pin + remedy', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  echoRole(fx);
  const { stderr, code } = run(fx, ['echo', 'hi', '--run-id', 'g-2'], { STUB_VERSION: '0.9.0' });
  assertEqual(code, 30);
  assert(stderr.includes('verity-agent-exec: 30 version-too-old:'), 'stderr slug line');
  assert(stderr.includes(grok.MIN_GROK_VERSION), 'names the pinned minimum');
});

test('grok e2e: VERITY_GROK_BIN wins over VERITY_AGENT_BIN', () => {
  const fx = fixture();
  canned(fx, MARKER_SUCCESS);
  echoRole(fx);
  const decoy = path.join(fx.dir, 'decoy');
  fs.writeFileSync(decoy, '#!/usr/bin/env node\nprocess.exit(9);\n');
  fs.chmodSync(decoy, 0o755);
  const { code } = run(fx, ['echo', 'hi', '--run-id', 'g-3'], {
    VERITY_AGENT_BIN: decoy,
    VERITY_GROK_BIN: fx.stub,
  });
  assertEqual(code, 0, 'the provider-specific override ran, not the decoy');
});

// --- host pass + installer ---

test('grok host pass: description-only frontmatter, handoffs flattened, engine path moved', () => {
  const input = [
    '---',
    'name: verity:plan',
    'description: Plan the next feature',
    'allowed-tools: Read, Bash(git *)',
    '---',
    'Hand off with /verity:build when done.',
    'Fallback: $HOME/.claude/verity/bin/verity.cjs',
    '',
  ].join('\n');
  const out = install.transformForGrok(input);
  assert(out.startsWith('---\ndescription: Plan the next feature\n---\n'), 'frontmatter reduced');
  assert(!out.includes('allowed-tools'), 'Claude-only allowlist dropped from the command file');
  assert(out.includes('/verity-build'), 'cross-role handoff flattened');
  assert(out.includes('${GROK_HOME:-$HOME/.grok}/verity'), 'engine fallback path moved');
});

test('installGrok: flattened commands + paired allowlists + engine + state under ~/.grok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-install-grok-'));
  const result = install.installGrok({ target: dir, home: path.join(dir, 'home') });
  assertEqual(result.harness, 'grok');
  const commands = fs.readdirSync(path.join(dir, 'commands'));
  assert(commands.length > 0, 'commands installed');
  assert(
    commands.every((n) => n.startsWith('verity-')),
    'every installed file carries the flattened verity- prefix',
  );
  const mds = commands.filter((n) => n.endsWith('.md'));
  const tools = commands.filter((n) => n.endsWith('.tools.json'));
  assertEqual(mds.length, tools.length, 'each role .md travels with its .tools.json');
  assert(fs.existsSync(path.join(dir, 'verity', 'bin', 'verity.cjs')), 'engine copied');
  const state = JSON.parse(
    fs.readFileSync(path.join(dir, 'verity', 'install-options.json'), 'utf8'),
  );
  assertEqual(state.harness, 'grok');
});

test('install dispatch: --grok is a harness flag, mutually exclusive with the others', () => {
  let err = null;
  try {
    install.dispatch([], { grok: true, codex: true });
  } catch (e) {
    err = e;
  }
  assert(err?.message.includes('mutually exclusive'), 'ambiguous selection rejected');
});

// --- doctor ---

test('doctor: grok registry — git + gh + grok rows, no claude row', () => {
  const names = doctor.GROK_DEPENDENCIES.map((d) => d.name);
  assertEqual(JSON.stringify(names), JSON.stringify(['git', 'gh', 'grok']));
  const grokDep = doctor.GROK_DEPENDENCIES[2];
  assertEqual(grokDep.minVersionKey, 'grokBuildMinVersion');
  assert(grokDep.remedies.missing.includes('x.ai/cli'), 'remedy names the installer');
});

test('doctor: --agent grok selects the grok registry + environment rows', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-grok-'));
  const rows = doctor.runChecks({ agent: 'grok', home, env: {} });
  const names = rows.map((r) => r.name);
  assert(names.includes('grok'), 'grok binary row present');
  assert(!names.includes('claude'), 'no claude row — a Grok-only machine can be green');
  assert(names.includes('grok-commands'), 'command-discovery row present');
  assert(names.includes('grok-engine'), 'engine row present');
  assert(names.includes('grok-install-state'), 'install-state row present');
  const state = rows.find((r) => r.name === 'grok-install-state');
  assert(state.detail.includes('verity install --grok'), 'failing detail names the remedy');
});

test('doctor: a real installGrok tree turns the environment rows green', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-grok-ok-'));
  install.installGrok({ target: path.join(home, '.grok'), home });
  const rows = doctor.grokEnvironmentChecks({ home, env: {} });
  for (const row of rows) {
    assert(row.ok, `${row.name} ok after install: ${row.detail}`);
  }
});

test('doctor: resolveAgent honors --agent grok and a grok install state', () => {
  const grokSel = doctor.resolveAgent({ agent: 'grok', cwd: os.tmpdir() });
  assertEqual(grokSel.agent, 'grok');
  assertEqual(grokSel.source, 'the --agent flag');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-grok-state-'));
  install.installGrok({ target: path.join(home, '.grok'), home });
  const fromState = doctor.resolveAgent({ cwd: home }, { home, env: {} });
  assertEqual(fromState.agent, 'grok', 'install state under ~/.grok is a selection signal');
});
