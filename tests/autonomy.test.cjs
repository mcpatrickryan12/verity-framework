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

// Stage 79 (ADR-0029): the effective policy loadPolicy returns ALWAYS carries
// the resolved `substrate` field ('github' when the file omits it) — DEFAULTS
// stays the pure §2 document (the knob is DEFAULT-ABSENT there, like
// containment_tier), so the resolved shape is DEFAULTS plus the one field.
// Stage 86 (ADR-0030): likewise `gate_runner` — absent resolves to the
// substrate's native runner ('github-actions' on github), so the resolved
// shape gains exactly one more field and NOTHING else changes (the stage-86
// kill-switch regression: byte-identical apart from the new resolved field).
const RESOLVED_DEFAULTS = {
  ...autonomy.DEFAULTS,
  substrate: 'github',
  gate_runner: 'github-actions',
};

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

test('loadPolicy: missing file → exact §2 defaults (+ stage-79 resolved substrate)', () => {
  const dir = tmpProject();
  deepEqual(autonomy.loadPolicy(dir), RESOLVED_DEFAULTS, 'defaults when no file');
});

test('loadPolicy: empty / comment-only file → defaults', () => {
  const dir = tmpProject();
  writePolicy(dir, '# nothing here\n\n');
  deepEqual(autonomy.loadPolicy(dir), RESOLVED_DEFAULTS, 'defaults for empty file');
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
  deepEqual(JSON.parse(pretty.out), RESOLVED_DEFAULTS, 'show = effective defaults');

  const piped = run(['autonomy', 'show', '--json'], dir);
  assertEqual(piped.code, 0, 'show --json exits 0');
  const lines = piped.out.split('\n').filter(Boolean);
  assertEqual(lines.length, 1, '--json emits exactly one line');
  deepEqual(JSON.parse(lines[0]), RESOLVED_DEFAULTS, '--json payload');
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

// --- stage 54 (ADR-0024): agent.roles — per-role override map (additive) ---

test('stage 54 schema: absent agent.roles ⇒ the effective agent block is unchanged', () => {
  // The kill-switch: no roles map means byte-identical to a pre-stage-54 policy.
  for (const text of ['', 'mode: supervised\n', 'agent:\n  provider: codex\n']) {
    const dir = tmpProject();
    writePolicy(dir, text);
    assertEqual(autonomy.loadPolicy(dir).agent.roles, undefined, 'no roles key materializes');
  }
});

test('stage 54 schema: a valid per-role override map loads and merges over defaults', () => {
  const dir = tmpProject();
  writePolicy(
    dir,
    [
      'agent:',
      '  provider: claude',
      '  roles:',
      '    build:',
      '      model: cheap-model',
      '    review:',
      '      provider: codex',
      '      model: gpt-5-codex',
      '      sandbox: read-only',
      '      approval: never',
      '      containment_tier: 2',
      '',
    ].join('\n'),
  );
  const roles = autonomy.loadPolicy(dir).agent.roles;
  assertEqual(roles.build.model, 'cheap-model', 'a partial (model-only) override loads');
  assertEqual(roles.review.provider, 'codex', 'a per-role codex override loads');
  assertEqual(roles.review.containment_tier, 2, 'with its own tier');
});

test('stage 54 schema: an UNKNOWN role key is a load error (fail closed)', () => {
  const dir = tmpProject();
  writePolicy(dir, 'agent:\n  roles:\n    deploy:\n      model: x\n');
  loadRejects(dir, 'unknown role', 'a role the worker never dispatches is refused');
});

test('stage 54 schema: per-role enums use the SAME validation as the base block', () => {
  const badProvider = tmpProject();
  writePolicy(badProvider, 'agent:\n  roles:\n    build:\n      provider: gemini\n');
  loadRejects(badProvider, 'agent.roles.build.provider', 'a bad per-role provider is rejected');

  const badSandbox = tmpProject();
  writePolicy(
    badSandbox,
    'agent:\n  provider: codex\n  roles:\n    review:\n      sandbox: yolo\n',
  );
  loadRejects(badSandbox, 'agent.roles.review.sandbox', 'a bad per-role sandbox value is rejected');

  const unknownKey = tmpProject();
  writePolicy(unknownKey, 'agent:\n  roles:\n    build:\n      ignore_rules: true\n');
  loadRejects(unknownKey, 'unknown key', 'a run-wide-only knob is not a per-role key');
});

test('stage 54 cross-field: per-role codex knobs are refused when the role resolves to claude', () => {
  // base claude, role sets no provider ⇒ resolves claude ⇒ sandbox is meaningless.
  const dir = tmpProject();
  writePolicy(dir, 'agent:\n  provider: claude\n  roles:\n    review:\n      sandbox: read-only\n');
  loadRejects(dir, 'only meaningful with codex', 'a codex knob under a claude role is refused');

  // But base codex + role omits provider ⇒ resolves codex ⇒ the same knob is fine.
  const ok = tmpProject();
  writePolicy(ok, 'agent:\n  provider: codex\n  roles:\n    review:\n      sandbox: read-only\n');
  assertEqual(
    autonomy.loadPolicy(ok).agent.roles.review.sandbox,
    'read-only',
    'the effective provider (base codex) makes the per-role knob meaningful',
  );
});

test('stage 54 cross-field: a per-role sandbox/approval override may only NARROW the base', () => {
  const widerSandbox = tmpProject();
  writePolicy(
    widerSandbox,
    'agent:\n  provider: codex\n  sandbox: read-only\n  roles:\n    review:\n      sandbox: workspace-write\n',
  );
  loadRejects(widerSandbox, 'WIDEN', 'workspace-write over a read-only base is refused');

  const widerApproval = tmpProject();
  writePolicy(
    widerApproval,
    'agent:\n  provider: codex\n  approval: untrusted\n  roles:\n    review:\n      approval: never\n',
  );
  loadRejects(widerApproval, 'WIDEN', 'never over an untrusted base is refused');

  // Narrowing is allowed: workspace-write base, read-only role.
  const narrower = tmpProject();
  writePolicy(
    narrower,
    'agent:\n  provider: codex\n  sandbox: workspace-write\n  roles:\n    build:\n      sandbox: read-only\n',
  );
  assertEqual(
    autonomy.loadPolicy(narrower).agent.roles.build.sandbox,
    'read-only',
    'read-only over a workspace-write base narrows and is accepted',
  );
});

test('stage 54 schema: the shipped JSON schema publishes agent.roles additively', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const roles = schema.properties.agent.properties.roles;
  assert(roles !== undefined, 'published in the shipped schema');
  assert(!('default' in roles), 'no default — absence is the kill-switch');
  assertEqual(
    JSON.stringify(roles.propertyNames.enum),
    '["build","plan","review"]',
    'keyed on exactly the worker-dispatch roles',
  );
  assert(/ADR-0024/.test(roles.description), 'the description points at the decision');
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

// --- stage 79 (ADR-0029): substrate — delivery-substrate seam (additive) ---

test('stage 79 knob: absent substrate RESOLVES to github on the effective policy', () => {
  // DEFAULT-ABSENT in the file, but the RESOLVED policy always carries the
  // field — the single grep-able source of truth stages 80–84 branch on.
  for (const text of ['', 'mode: supervised\n', 'agent:\n  provider: codex\n']) {
    const dir = tmpProject();
    writePolicy(dir, text);
    assertEqual(
      autonomy.loadPolicy(dir).substrate,
      'github',
      'absence resolves to github — byte-identical pre-stage-79 behavior',
    );
  }
});

test('stage 79 knob: explicit github resolves byte-identical to absent', () => {
  // The kill-switch guarantee, stated as object equality: a file that writes
  // `substrate: github` and a file that omits the key resolve to the SAME
  // effective policy — nothing downstream can tell them apart.
  const absent = tmpProject();
  writePolicy(absent, 'mode: supervised\n');
  const explicit = tmpProject();
  writePolicy(explicit, 'mode: supervised\nsubstrate: github\n');
  deepEqual(
    autonomy.loadPolicy(explicit),
    autonomy.loadPolicy(absent),
    'explicit github ⇒ the byte-identical resolved policy',
  );
});

test('stage 79/83 knob: local RESOLVES as a value and the worker entry now ADMITS it (stage 83 lifted the refusal)', () => {
  // 'local' is a valid enum value; loading it is NOT a schema error. The
  // stage-79 placeholder refusal at the worker's policy consumption was
  // LIFTED by stage 83 (the local driver completed across stages 80–82), so
  // the check now admits both schema enums and stays fail-closed only for
  // values the engine cannot drive (unit callers passing raw policies).
  const dir = tmpProject();
  writePolicy(dir, 'substrate: local\n');
  const policy = autonomy.loadPolicy(dir);
  assertEqual(policy.substrate, 'local', 'local resolves as a value at load');

  const worker = require('../verity/worker/index.cjs');
  worker.assertSubstrateSupported(policy); // stage 83: no longer throws

  // github — resolved or raw/absent (unit callers) — passes untouched.
  worker.assertSubstrateSupported({ substrate: 'github' });
  worker.assertSubstrateSupported({});

  // The belt is still fail-closed for a substrate the engine cannot drive.
  let threw = null;
  try {
    worker.assertSubstrateSupported({ substrate: 'sqlite' });
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, 'an unknown substrate still refuses');
  assertEqual(threw.exitCode, 30, 'refused as a startup infra error (exit 30)');
  assertEqual(threw.slug, 'substrate-unimplemented', 'with its fail-closed slug');
});

test('stage 79 knob: a junk value is a load error naming the key and allowed values', () => {
  const dir = tmpProject();
  writePolicy(dir, 'substrate: gitlab\n');
  loadRejects(dir, 'substrate', 'the load error names the key');
  loadRejects(dir, 'github|local', 'and the allowed values — never a silent default');
});

test('stage 79 knob: the shipped JSON schema publishes it with NO default', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const knob = schema.properties.substrate;
  assert(knob !== undefined, 'published in the shipped schema');
  assertEqual(JSON.stringify(knob.enum), '["github","local"]', 'exactly the two substrates');
  assert(!('default' in knob), 'no default written — absence is the kill-switch (github)');
  assert(/ADR-0029/.test(knob.description), 'the description points at the decision');
  // Stage 90: the stage-79 placeholder text is gone — the description now
  // records that 'local' executes (refusal lifted stage 83, driver landed
  // stages 80–85), and the stale "not yet implemented" phrase must never
  // resurface (the stage-89 gate_runner flip, applied to substrate).
  assert(/EXECUTES as of stage 83/.test(knob.description), "'local' executes (stage 83)");
  assert(!/not yet implemented/.test(knob.description), 'the stage-79 placeholder text is gone');
  assert(/fail-closed/.test(knob.description), 'and the fail-closed unknown-value rule');
});

// --- stage 86 (ADR-0030): gate_runner — the gate-runner seam (additive) ------

test('stage 86 knob: absent gate_runner RESOLVES to the substrate NATIVE runner', () => {
  // github (explicit or absent substrate) ⇒ github-actions; local ⇒ direct —
  // both byte-identical to today's behavior, and the resolved policy always
  // carries the field (the single source of truth stages 87–89 branch on).
  for (const text of ['', 'mode: supervised\n', 'substrate: github\n']) {
    const dir = tmpProject();
    writePolicy(dir, text);
    assertEqual(
      autonomy.loadPolicy(dir).gate_runner,
      'github-actions',
      `github substrate resolves the native github-actions runner (${JSON.stringify(text)})`,
    );
  }
  const local = tmpProject();
  writePolicy(local, 'substrate: local\n');
  assertEqual(
    autonomy.loadPolicy(local).gate_runner,
    'direct',
    'local substrate resolves the native direct runner',
  );
});

test('stage 86 knob: explicit native values resolve byte-identical to absent (the kill-switch)', () => {
  const absentLocal = tmpProject();
  writePolicy(absentLocal, 'substrate: local\n');
  const explicitLocal = tmpProject();
  writePolicy(explicitLocal, 'substrate: local\ngate_runner: direct\n');
  deepEqual(
    autonomy.loadPolicy(explicitLocal),
    autonomy.loadPolicy(absentLocal),
    'local: explicit direct ⇒ the byte-identical resolved policy',
  );
  const absentGithub = tmpProject();
  writePolicy(absentGithub, 'mode: supervised\n');
  const explicitGithub = tmpProject();
  writePolicy(explicitGithub, 'mode: supervised\ngate_runner: github-actions\n');
  deepEqual(
    autonomy.loadPolicy(explicitGithub),
    autonomy.loadPolicy(absentGithub),
    'github: explicit github-actions ⇒ the byte-identical resolved policy',
  );
});

test('stage 86 knob: localhost and remote:<name> RESOLVE as values on the local substrate', () => {
  // Placeholders resolve at load; the gate-execution call sites refuse them
  // (gates.test.cjs covers the seam refusal + no-record guarantee).
  const localhost = tmpProject();
  writePolicy(localhost, 'substrate: local\ngate_runner: localhost\n');
  assertEqual(autonomy.loadPolicy(localhost).gate_runner, 'localhost');
  const remote = tmpProject();
  writePolicy(remote, 'substrate: local\ngate_runner: remote:gpu-box.lan\n');
  assertEqual(autonomy.loadPolicy(remote).gate_runner, 'remote:gpu-box.lan');
});

test('stage 86 knob: junk values are a load error naming the key and allowed values', () => {
  const dir = tmpProject();
  writePolicy(dir, 'gate_runner: jenkins\n');
  loadRejects(dir, 'gate_runner', 'the load error names the key');
  loadRejects(
    dir,
    'direct|localhost|remote:<name>|github-actions',
    'and the allowed values — never a silent default',
  );
});

test('stage 86 knob: remote: with an empty or unsafe name is a load error (fail closed)', () => {
  for (const bad of ["'remote:'", "'remote:has space'", "'remote:no/slash'"]) {
    const dir = tmpProject();
    writePolicy(dir, `substrate: local\ngate_runner: ${bad}\n`);
    loadRejects(dir, 'gate_runner', `${bad}: refused as an unknown value`);
    loadRejects(dir, 'remote:<name>', `${bad}: the error shows the pattern`);
  }
});

test('stage 86 REJECTED combination: substrate local + gate_runner github-actions refuses at load, byte-stable', () => {
  const dir = tmpProject();
  writePolicy(dir, 'substrate: local\ngate_runner: github-actions\n');
  let threw = null;
  try {
    autonomy.loadPolicy(dir);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, 'the combination is a load refusal');
  assertEqual(threw.exitCode, 20, 'PolicyError, exit 20');
  assert(
    threw.message.includes(
      "gate_runner: 'github-actions' is refused on substrate 'local' — it presumes a pushed GitHub branch the local substrate says does not exist (ADR-0030); use direct, localhost, or remote:<name>",
    ),
    `byte-stable refusal message: ${threw.message}`,
  );
});

test('stage 86: substrate github + any non-native runner is a v1 refusal at load (fail closed; admitting it later is additive)', () => {
  for (const runner of ['direct', 'localhost', 'remote:gpu-box']) {
    // Explicit github AND absent substrate (which resolves to github) both hit
    // the same rule — set/validate/load agree on the effective substrate.
    for (const substrateLine of ['substrate: github\n', '']) {
      const dir = tmpProject();
      writePolicy(dir, `${substrateLine}gate_runner: '${runner}'\n`);
      loadRejects(dir, 'not supported in v1', `github + ${runner} refused`);
      loadRejects(dir, 'ADR-0030', 'the refusal points at the decision');
    }
  }
});

test('stage 86 regression: a policy WITHOUT the key round-trips byte-identical apart from the new resolved field', () => {
  const dir = tmpProject();
  writePolicy(dir, 'mode: supervised\nreview:\n  trust: 1\n');
  const policy = autonomy.loadPolicy(dir);
  const { gate_runner, ...rest } = policy;
  assertEqual(gate_runner, 'github-actions', 'the one new resolved field');
  const expected = autonomy.enforceInvariants(
    JSON.parse(JSON.stringify({ ...autonomy.DEFAULTS, mode: 'supervised' })),
  );
  expected.review.trust = 1;
  expected.substrate = 'github';
  deepEqual(rest, expected, 'everything else is the pre-stage-86 resolved policy, byte-identical');
});

test('stage 86 cli: autonomy set gate_runner writes valid combos and refuses invalid ones without writing', () => {
  // local substrate: localhost is settable (resolves; the seam refusal lives
  // at the gate-execution call sites, not in the policy).
  const local = tmpProject();
  assertEqual(run(['autonomy', 'set', 'substrate', 'local'], local).code, 0, 'set substrate');
  assertEqual(run(['autonomy', 'set', 'gate_runner', 'localhost'], local).code, 0, 'set runner');
  assertEqual(autonomy.loadPolicy(local).gate_runner, 'localhost', 'effective policy updated');
  // local + github-actions: the REJECTED combination refuses at set time too.
  const combo = run(['autonomy', 'set', 'gate_runner', 'github-actions'], local);
  assertEqual(combo.code, 20, 'rejected combination refused');
  assertEqual(autonomy.loadPolicy(local).gate_runner, 'localhost', 'file untouched');
  // default (github) substrate: a non-native runner refuses, nothing written.
  const github = tmpProject();
  const v1 = run(['autonomy', 'set', 'gate_runner', 'localhost'], github);
  assertEqual(v1.code, 20, 'github + localhost is the v1 refusal');
  assert(!fs.existsSync(path.join(github, '.verity', 'autonomy.yml')), 'nothing written');
  // junk value: the enum-shaped coerce error.
  const junk = run(['autonomy', 'set', 'gate_runner', 'jenkins'], github);
  assertEqual(junk.code, 20, 'junk refused');
  assert(junk.err.includes('direct|localhost|remote:<name>|github-actions'), junk.err);
});

test('stage 86 knob: the shipped JSON schema publishes gate_runner with NO default', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const knob = schema.properties.gate_runner;
  assert(knob !== undefined, 'published in the shipped schema');
  assert(!('default' in knob), 'no default written — absence is the kill-switch (native runner)');
  assertEqual(
    JSON.stringify(knob.anyOf[0].enum),
    '["direct","localhost","github-actions"]',
    'exactly the three literals',
  );
  assertEqual(
    knob.anyOf[1].pattern,
    '^remote:[A-Za-z0-9._-]+$',
    'plus the remote:<name> pattern (non-empty, catalog-name-safe)',
  );
  assert(/ADR-0030/.test(knob.description), 'the description points at the decision');
  // Stage 89: the last placeholder is gone — the description now records that
  // every runner value executes, and the stale "not yet implemented" phrase
  // must never resurface.
  assert(/EXECUTES as of stage 89/.test(knob.description), 'remote:<name> executes (stage 89)');
  assert(!/not yet implemented/.test(knob.description), 'the stage-86 placeholder text is gone');
  assert(/fail-closed/.test(knob.description), 'and the fail-closed unknown-value rule');
});
