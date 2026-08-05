// T04 — autonomy policy: schema + loader + CLI (SKETCH §2, §3.2).
//
// Unit tests hit the lib directly (no network, no gh); CLI tests spawn the
// dispatcher with execFileSync to observe exit codes (20 = policy violation).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomy = require('../verity/bin/lib/autonomy.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-autonomy-'));
}

function writePolicy(dir, text) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), text);
}

function run(args, dir) {
  try {
    const out = execFileSync('node', [CLI, ...args, '--cwd', dir], { encoding: 'utf8' });
    return { out, err: '', code: 0 };
  } catch (e) {
    return { out: e.stdout || '', err: e.stderr || '', code: e.status };
  }
}

function deepEqual(actual, expected, msg) {
  assertEqual(JSON.stringify(actual, null, 1), JSON.stringify(expected, null, 1), msg);
}

// --- YAML subset parser ---

test('parseYaml: the full §2 example document round-trips into the §2 defaults', () => {
  const doc = `# .verity/autonomy.yml  (all keys optional; defaults shown)
mode: manual                     # manual | supervised | autonomous

auto_advance: [plan, build, test, docs]   # roles allowed to chain (supervised+)

gates:                           # roles that ALWAYS pause for a human
  - review:merge
  - ship:prod
  - golive

review:
  trust: 0                       # 0 none | 1 low-risk auto-merge | 2 full
  escalate_routing: false        # stage 36 — park escalate verdicts for a human
  low_risk:
    max_changed_lines: 150
    allowed_paths: ["docs/**", "tests/**", "**/*.md"]
    protected_paths: ["**/auth/**", ".github/**", "scripts/deploy*", ".verity/**"]
    require_ci_green: true

limits:
  max_chained_roles: 6
  max_tokens_per_run: 2000000
  max_wall_clock_min: 45
  max_runs_per_day: 24
  max_usd_per_day: 25.00
  unknown_cost_behavior: gate    # gate | allow_with_token_limit | fail (ADR-0008)

notify:
  mention: []                    # GitHub logins to @ on gate/fail/circuit
  webhook: null                  # optional POST url

humans: []                       # logins; bot token matching any → refuse to start

commit_usage: true               # §3.4: commit usage.csv after each run (T11)

agent:                           # stage 9 — worker runtime selection (ADR-0009)
  provider: claude               # claude | codex
  model: null                    # optional model override
  sandbox: null                  # codex-only; narrows the role projection
  approval: null                 # codex-only; narrows the role projection
  ignore_user_config: true
  ignore_rules: false
`;
  deepEqual(autonomy.parseYaml(doc), autonomy.DEFAULTS, 'parsed §2 example');
});

test('parseYaml: quoted strings, comments, block lists, scalar types', () => {
  const doc = [
    "mode: 'supervised'",
    'humans:',
    "  - 'sean''s-bot' # trailing comment",
    '  - "d#q" ',
    'notify:',
    '  webhook: https://example.com/hook#frag',
    'review:',
    '  trust: 2',
  ].join('\n');
  const got = autonomy.parseYaml(doc);
  assertEqual(got.mode, 'supervised', 'single-quoted scalar');
  deepEqual(got.humans, ["sean's-bot", 'd#q'], 'quoted list items with escapes and #');
  assertEqual(got.notify.webhook, 'https://example.com/hook#frag', '# without space is no comment');
  assertEqual(got.review.trust, 2, 'nested int');
});

test('parseYaml: empty input and null forms', () => {
  deepEqual(autonomy.parseYaml(''), {}, 'empty doc is an empty map');
  const got = autonomy.parseYaml('a: null\nb: ~\nc:\n');
  deepEqual(got, { a: null, b: null, c: null }, 'null spellings');
});

function rejects(doc, wantLine, why) {
  let threw = null;
  try {
    autonomy.parseYaml(doc);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, `${why}: expected a throw`);
  assertEqual(threw.exitCode, 20, `${why}: exitCode 20`);
  assertEqual(threw.line, wantLine, `${why}: line info`);
}

test('parseYaml: rejects unsupported YAML with line info instead of misparsing', () => {
  rejects('mode: manual\n\tgates: []', 2, 'tab indentation');
  rejects('a: &anchor x', 1, 'anchor');
  rejects('a: |\n  text', 1, 'block scalar');
  rejects('a: {b: 1}', 1, 'flow map');
  rejects('a:\n  - - nested', 2, 'nested list');
  rejects('a:\n  - b: 1', 2, 'map inside list');
  rejects('a: 1\n   b: 2', 2, 'bad indentation');
  rejects('---\nmode: manual', 1, 'multi-document');
  rejects('a: x\na: y', 2, 'duplicate key');
  rejects('just a sentence', 1, 'no key: value');
});

// --- loader: defaults + hard invariants ---

test('loadPolicy: missing file → exact §2 defaults', () => {
  const dir = tmpProject();
  deepEqual(autonomy.loadPolicy(dir), autonomy.DEFAULTS, 'defaults when no file');
});

test('loadPolicy: empty / comment-only file → defaults', () => {
  const dir = tmpProject();
  writePolicy(dir, '# nothing here\n\n');
  deepEqual(autonomy.loadPolicy(dir), autonomy.DEFAULTS, 'defaults for empty file');
});

test('loadPolicy: file merges over defaults without clobbering siblings', () => {
  const dir = tmpProject();
  writePolicy(dir, 'mode: supervised\nreview:\n  trust: 1\n');
  const policy = autonomy.loadPolicy(dir);
  assertEqual(policy.mode, 'supervised', 'overridden');
  assertEqual(policy.review.trust, 1, 'nested override');
  assertEqual(policy.review.low_risk.max_changed_lines, 150, 'sibling default kept');
  assertEqual(policy.limits.max_usd_per_day, 25, 'untouched section kept');
});

test('hard invariant: removing .verity/** and .github/** from protected_paths is overridden', () => {
  const dir = tmpProject();
  writePolicy(dir, 'review:\n  low_risk:\n    protected_paths: ["**/auth/**"]\n');
  const paths = autonomy.loadPolicy(dir).review.low_risk.protected_paths;
  assert(paths.includes('.verity/**'), '.verity/** forced back in');
  assert(paths.includes('.github/**'), '.github/** forced back in');
  assert(paths.includes('**/auth/**'), 'user entry kept');
});

test('hard invariant: golive is always in gates', () => {
  const dir = tmpProject();
  writePolicy(dir, 'gates: [review:merge]\n');
  const gates = autonomy.loadPolicy(dir).gates;
  assert(gates.includes('golive'), 'golive forced back in');
  assert(gates.includes('review:merge'), 'user entry kept');
});

test('loadPolicy: schema violations throw PolicyError (exit 20)', () => {
  const dir = tmpProject();
  writePolicy(dir, 'mode: yolo\nreview:\n  trust: 3\nbogus: 1\n');
  let threw = null;
  try {
    autonomy.loadPolicy(dir);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null && threw.exitCode === 20, 'PolicyError with exitCode 20');
  assert(/mode/.test(threw.message), 'enum violation named');
  assert(/review\.trust/.test(threw.message), 'range violation named');
  assert(/bogus.*unknown key/.test(threw.message), 'unknown key named');
});

test('toYaml/parseYaml round-trip of the defaults is lossless', () => {
  deepEqual(
    autonomy.parseYaml(autonomy.toYaml(autonomy.DEFAULTS)),
    autonomy.DEFAULTS,
    'round-trip',
  );
});

// --- CLI: show ---

test('cli: autonomy show prints the effective policy; --json is one compact line', () => {
  const dir = tmpProject();
  const pretty = run(['autonomy', 'show'], dir);
  assertEqual(pretty.code, 0, 'show exits 0');
  deepEqual(JSON.parse(pretty.out), autonomy.DEFAULTS, 'show = effective defaults');

  const piped = run(['autonomy', 'show', '--json'], dir);
  assertEqual(piped.code, 0, 'show --json exits 0');
  const lines = piped.out.split('\n').filter(Boolean);
  assertEqual(lines.length, 1, '--json emits exactly one line');
  deepEqual(JSON.parse(lines[0]), autonomy.DEFAULTS, '--json payload');
});

// --- CLI: set ---

test('cli: autonomy set mode supervised writes the file and show reflects it', () => {
  const dir = tmpProject();
  const set = run(['autonomy', 'set', 'mode', 'supervised'], dir);
  assertEqual(set.code, 0, 'set exits 0');
  assert(fs.existsSync(path.join(dir, '.verity', 'autonomy.yml')), 'file written');
  const shown = JSON.parse(run(['autonomy', 'show'], dir).out);
  assertEqual(shown.mode, 'supervised', 'effective policy updated');
  assertEqual(shown.review.trust, 0, 'defaults still merged');
});

test('cli: set rejects unknown keys and bad values with exit 20', () => {
  const dir = tmpProject();
  assertEqual(run(['autonomy', 'set', 'nope.key', '1'], dir).code, 20, 'unknown key');
  assertEqual(run(['autonomy', 'set', 'mode', 'yolo'], dir).code, 20, 'bad enum');
  assertEqual(run(['autonomy', 'set', 'review.trust', 'high'], dir).code, 20, 'bad int');
});

test('cli: set review.trust 1 without --confirm → exit 20, nothing written', () => {
  const dir = tmpProject();
  const res = run(['autonomy', 'set', 'review.trust', '1'], dir);
  assertEqual(res.code, 20, 'exit 20 without --confirm');
  assert(/--confirm/.test(res.err), 'stderr explains --confirm');
  assert(!fs.existsSync(path.join(dir, '.verity', 'autonomy.yml')), 'policy file not written');
  assertEqual(autonomy.loadPolicy(dir).review.trust, 0, 'trust unchanged');
});

test('cli: set review.trust 1 --confirm succeeds and records an ADR', () => {
  const dir = tmpProject();
  const res = run(['autonomy', 'set', 'review.trust', '1', '--confirm'], dir);
  assertEqual(res.code, 0, 'exit 0 with --confirm');
  assertEqual(autonomy.loadPolicy(dir).review.trust, 1, 'trust raised');
  const adrs = fs.readdirSync(path.join(dir, 'docs', 'adr'));
  assertEqual(adrs.length, 1, 'one ADR created');
  assert(/trust/.test(adrs[0]), 'ADR filename mentions trust');
  const body = fs.readFileSync(path.join(dir, 'docs', 'adr', adrs[0]), 'utf8');
  assert(/from 0 to 1/.test(body), 'ADR records the trust change');
});

test('cli: lowering review.trust needs no --confirm and no ADR', () => {
  const dir = tmpProject();
  run(['autonomy', 'set', 'review.trust', '2', '--confirm'], dir);
  const res = run(['autonomy', 'set', 'review.trust', '0'], dir);
  assertEqual(res.code, 0, 'lowering exits 0');
  assertEqual(autonomy.loadPolicy(dir).review.trust, 0, 'trust lowered');
  const adrs = fs.readdirSync(path.join(dir, 'docs', 'adr'));
  assertEqual(adrs.length, 1, 'no second ADR for the decrease');
});

// --- CLI: validate ---

test('cli: validate exits 0 on missing file and on a valid file', () => {
  const dir = tmpProject();
  assertEqual(run(['autonomy', 'validate'], dir).code, 0, 'missing file is valid (defaults)');
  writePolicy(dir, 'mode: autonomous\ngates:\n  - ship:prod\n');
  assertEqual(run(['autonomy', 'validate'], dir).code, 0, 'valid file');
});

test('cli: validate on malformed YAML → exit 20 with line info', () => {
  const dir = tmpProject();
  writePolicy(dir, 'mode: manual\nreview: {trust: 1}\n');
  const res = run(['autonomy', 'validate'], dir);
  assertEqual(res.code, 20, 'exit 20 on malformed YAML');
  const payload = JSON.parse(res.err.split('\n').filter(Boolean)[0]);
  assertEqual(payload.line, 2, 'structured line info on stderr');
  assert(/line 2/.test(payload.error), 'line info in the message too');
});

test('cli: validate flags schema violations with exit 20', () => {
  const dir = tmpProject();
  writePolicy(dir, 'limits:\n  max_usd_per_day: -1\n');
  assertEqual(run(['autonomy', 'validate'], dir).code, 20, 'range violation');
});

// --- stage 9: the `agent` block + limits.unknown_cost_behavior (additive) -----

test('stage 9 backward-compat: every pre-existing policy shape stays valid and Claude-backed', () => {
  // The policies the suite has always used (worker fixtures, docs examples) —
  // none mention `agent`, all must keep loading with the claude defaults.
  const legacy = [
    '', // empty file
    'mode: supervised\nnotify:\n  mention: [seanerama]\n',
    'mode: supervised\nlimits:\n  max_tokens_per_run: 1000\n',
    'mode: supervised\nreview:\n  trust: 1\n',
    'mode: autonomous\ngates:\n  - ship:prod\n',
    'humans: [seanerama, Verity-Bot]\n',
  ];
  for (const text of legacy) {
    const dir = tmpProject();
    writePolicy(dir, text);
    const policy = autonomy.loadPolicy(dir); // throws → test fails
    assertEqual(policy.agent.provider, 'claude', 'old policies default to claude');
    assertEqual(policy.agent.model, null, 'no model override');
    assertEqual(policy.agent.sandbox, null, 'no sandbox override');
    assertEqual(policy.agent.approval, null, 'no approval override');
    assertEqual(policy.agent.ignore_user_config, true, 'headless isolation defaults on');
    assertEqual(policy.agent.ignore_rules, false);
    assertEqual(
      policy.limits.unknown_cost_behavior,
      'gate',
      'unknown cost stays human-gated by default (ADR-0008)',
    );
  }
});

test('stage 9 schema: valid agent blocks load; codex knobs merge over defaults', () => {
  const dir = tmpProject();
  writePolicy(
    dir,
    [
      'mode: supervised',
      'agent:',
      '  provider: codex',
      '  model: gpt-5-codex',
      '  sandbox: read-only',
      '  approval: never',
      'limits:',
      '  unknown_cost_behavior: allow_with_token_limit',
      '',
    ].join('\n'),
  );
  const policy = autonomy.loadPolicy(dir);
  assertEqual(policy.agent.provider, 'codex');
  assertEqual(policy.agent.model, 'gpt-5-codex');
  assertEqual(policy.agent.sandbox, 'read-only');
  assertEqual(policy.agent.approval, 'never');
  assertEqual(policy.agent.ignore_user_config, true, 'unset sibling keeps its default');
  assertEqual(policy.limits.unknown_cost_behavior, 'allow_with_token_limit');
  assertEqual(policy.limits.max_usd_per_day, 25, 'sibling limit defaults kept');
});

function loadRejects(dir, needle, why) {
  let threw = null;
  try {
    autonomy.loadPolicy(dir);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, `${why}: expected a throw`);
  assertEqual(threw.exitCode, 20, `${why}: exitCode 20`);
  assert(threw.message.includes(needle), `${why}: message names it (${threw.message})`);
}

test('stage 9 schema: invalid agent blocks are rejected with exit 20', () => {
  const cases = [
    ['agent:\n  provider: gemini\n', 'agent.provider', 'unknown provider'],
    ['agent:\n  provider: codex\n  sandbox: yolo\n', 'agent.sandbox', 'bad sandbox value'],
    [
      // ADR-0007: no unrestricted-access value exists ANYWHERE in the schema.
      'agent:\n  provider: codex\n  sandbox: danger-full-access\n',
      'agent.sandbox',
      'danger-full-access is not representable',
    ],
    ['agent:\n  provider: codex\n  approval: always\n', 'agent.approval', 'bad approval value'],
    ['agent:\n  provider: codex\n  ignore_rules: 1\n', 'agent.ignore_rules', 'non-boolean'],
    ['agent:\n  turbo: true\n', 'unknown key', 'unknown agent key'],
    [
      'limits:\n  unknown_cost_behavior: shrug\n',
      'limits.unknown_cost_behavior',
      'bad unknown-cost value',
    ],
  ];
  for (const [text, needle, why] of cases) {
    const dir = tmpProject();
    writePolicy(dir, text);
    loadRejects(dir, needle, why);
  }
});

test('stage 9 cross-field: sandbox/approval are codex-only — rejected under claude', () => {
  for (const knob of ['sandbox: read-only', 'approval: never']) {
    const dir = tmpProject();
    writePolicy(dir, `agent:\n  ${knob.replace(': ', ': ')}\n`);
    loadRejects(dir, 'only meaningful with agent.provider codex', `claude + ${knob}`);
  }
});

// --- stage 11: agent.acknowledged_enforcement_gaps (additive, default-absent) ---

test('stage 11 knob: default-ABSENT — no policy acknowledges anything (fail closed)', () => {
  for (const text of ['', 'mode: supervised\n', 'agent:\n  provider: codex\n']) {
    const dir = tmpProject();
    writePolicy(dir, text);
    const policy = autonomy.loadPolicy(dir);
    assertEqual(
      policy.agent.acknowledged_enforcement_gaps,
      undefined,
      'the knob is absent unless the operator writes it — absence acknowledges NOTHING',
    );
  }
});

// --- stage 36: review.escalate_routing (additive boolean, default OFF) ---

test('stage 36 knob: review.escalate_routing defaults to false (OFF) when absent', () => {
  for (const text of ['', 'mode: supervised\n', 'review:\n  trust: 1\n']) {
    const dir = tmpProject();
    writePolicy(dir, text);
    assertEqual(
      autonomy.loadPolicy(dir).review.escalate_routing,
      false,
      'absent escalate_routing merges to the default-OFF state',
    );
  }
});

test('stage 36 knob: review.escalate_routing accepts a boolean, rejects a non-boolean', () => {
  const on = tmpProject();
  writePolicy(on, 'review:\n  escalate_routing: true\n');
  assertEqual(autonomy.loadPolicy(on).review.escalate_routing, true, 'true is accepted');

  const bad = tmpProject();
  writePolicy(bad, 'review:\n  escalate_routing: yes\n');
  loadRejects(bad, 'review.escalate_routing', 'non-boolean escalate_routing rejected');
});

test('stage 11 knob: an explicit acknowledgement loads as a list under codex', () => {
  const dir = tmpProject();
  writePolicy(
    dir,
    [
      'mode: supervised',
      'agent:',
      '  provider: codex',
      '  acknowledged_enforcement_gaps: [network]',
      '',
    ].join('\n'),
  );
  const policy = autonomy.loadPolicy(dir);
  assertEqual(
    JSON.stringify(policy.agent.acknowledged_enforcement_gaps),
    '["network"]',
    'the operator acknowledgement the worker forwards to agent-exec (ADR-0011)',
  );
  assertEqual(policy.agent.provider, 'codex', 'sibling keys unaffected');
});

test('stage 11 knob: non-list values and claude+acknowledgement are rejected with exit 20', () => {
  const bad = tmpProject();
  writePolicy(bad, 'agent:\n  provider: codex\n  acknowledged_enforcement_gaps: network\n');
  loadRejects(bad, 'acknowledged_enforcement_gaps', 'a bare scalar is not a list');
  const claude = tmpProject();
  writePolicy(claude, 'agent:\n  acknowledged_enforcement_gaps: [network]\n');
  loadRejects(
    claude,
    'only meaningful with agent.provider codex',
    'claude has no gap to acknowledge',
  );
  const empty = tmpProject();
  writePolicy(empty, 'agent:\n  acknowledged_enforcement_gaps: []\n');
  assertEqual(
    JSON.stringify(autonomy.loadPolicy(empty).agent.acknowledged_enforcement_gaps),
    '[]',
    'an EMPTY list is the default-absent state and stays legal under claude',
  );
});

test('stage 11 knob: the shipped JSON schema publishes it as an additive string list', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const knob = schema.properties.agent.properties.acknowledged_enforcement_gaps;
  assertEqual(knob.type, 'array', 'published in the shipped schema');
  assertEqual(knob.items.type, 'string');
  assert(!('default' in knob), 'no default — absence is the fail-closed state');
  assert(/ADR-0011/.test(knob.description), 'the description points at the decision');
});

// --- stage 14: agent.containment_tier (additive, default-absent, fail closed) ---

test('stage 14 knob: default-ABSENT — no policy claims tier 2 (fail closed)', () => {
  for (const text of ['', 'mode: supervised\n', 'agent:\n  provider: codex\n']) {
    const dir = tmpProject();
    writePolicy(dir, text);
    assertEqual(
      autonomy.loadPolicy(dir).agent.containment_tier,
      undefined,
      'the knob is absent unless the operator writes it — absence is tier 1',
    );
  }
});

test('stage 14 knob: an explicit tier loads under codex; bad values and claude are rejected', () => {
  const dir = tmpProject();
  writePolicy(dir, 'mode: autonomous\nagent:\n  provider: codex\n  containment_tier: 2\n');
  assertEqual(autonomy.loadPolicy(dir).agent.containment_tier, 2, 'the tier the worker demands');

  const one = tmpProject();
  writePolicy(one, 'agent:\n  provider: codex\n  containment_tier: 1\n');
  assertEqual(autonomy.loadPolicy(one).agent.containment_tier, 1, 'tier 1 is expressible too');

  const bad = tmpProject();
  writePolicy(bad, 'agent:\n  provider: codex\n  containment_tier: 3\n');
  loadRejects(bad, 'containment_tier', 'there is no tier 3');

  const claude = tmpProject();
  writePolicy(claude, 'agent:\n  containment_tier: 2\n');
  loadRejects(
    claude,
    'only meaningful with agent.provider codex',
    'claude has no ADR-0011 containment tiers',
  );
});

test('stage 14 knob: the shipped JSON schema publishes it with NO default', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const knob = schema.properties.agent.properties.containment_tier;
  assertEqual(JSON.stringify(knob.enum), '[1,2]', 'exactly the two ADR-0011 tiers');
  assert(!('default' in knob), 'no default — absence is the fail-closed state (tier 1)');
  assert(/ADR-0011/.test(knob.description), 'the description points at the decision');
  assert(/autonomous/.test(knob.description), 'and says what tier 2 unlocks');
});

test('cli: autonomy set agent.provider codex writes and validates; enums enforced', () => {
  const dir = tmpProject();
  assertEqual(run(['autonomy', 'set', 'agent.provider', 'codex'], dir).code, 0, 'set provider');
  assertEqual(autonomy.loadPolicy(dir).agent.provider, 'codex', 'effective policy updated');
  assertEqual(run(['autonomy', 'set', 'agent.sandbox', 'read-only'], dir).code, 0, 'codex knob ok');
  assertEqual(autonomy.loadPolicy(dir).agent.sandbox, 'read-only');
  assertEqual(run(['autonomy', 'set', 'agent.sandbox', 'null'], dir).code, 0, 'null clears it');
  assertEqual(autonomy.loadPolicy(dir).agent.sandbox, null);
  assertEqual(run(['autonomy', 'set', 'agent.provider', 'gemini'], dir).code, 20, 'bad enum');
  assertEqual(
    run(['autonomy', 'set', 'limits.unknown_cost_behavior', 'fail'], dir).code,
    0,
    'unknown-cost knob settable',
  );
});

test('cli: setting a codex-only knob under claude refuses to write invalid policy', () => {
  const dir = tmpProject();
  const res = run(['autonomy', 'set', 'agent.sandbox', 'read-only'], dir);
  assertEqual(res.code, 20, 'refused (provider is still claude)');
  assert(!fs.existsSync(path.join(dir, '.verity', 'autonomy.yml')), 'nothing written');
});
