// T15 — `verity install --actions`: SKETCH §6 workflow scaffold.
// The generated file was validated with REAL actionlint 1.7.12 (exit 0) during
// development; the `actionlint` test below re-runs it whenever the binary is on
// PATH and degrades to a no-op (with a note) where it isn't. The frozen-contract
// guard is the inline EXPECTED_BODY fixture: the exact YAML body (everything
// after the header comment) for the default bot, verified against actionlint.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const install = require('../verity/bin/lib/install.cjs');

const WF = path.join('.github', 'workflows', 'verity-worker.yml');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-actions-'));
}

test('install --actions scaffolds .github/workflows/verity-worker.yml', () => {
  const cwd = sandbox();
  const r = install.installActions({ cwd });
  assertEqual(r.created, true);
  assertEqual(r.path, WF);
  assertEqual(r.bot, 'verity-bot');
  const body = fs.readFileSync(path.join(cwd, WF), 'utf8');
  assert(body.includes('name: verity-worker'), 'workflow name');
  assert(body.includes("if: github.actor != 'verity-bot'"), 'self-event guard, default login');
  assert(body.includes('timeout-minutes: 50'), 'budget guardrail: job timeout');
  assert(body.includes('group: verity-${{ github.repository }}'), 'concurrency group');
  assert(body.includes('cancel-in-progress: false'), 'in-flight runs are never cancelled');
  assert(body.includes("cron: '*/30 * * * *'"), '30-minute schedule');
  assert(
    body.includes('GH_TOKEN: ${{ secrets.VERITY_BOT_TOKEN }}') &&
      body.includes('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'),
    'worker step wired to both secrets',
  );
});

test('header comment documents both secrets and the budget guardrails', () => {
  const yaml = install.actionsWorkflowYaml();
  const header = yaml
    .split('\n')
    .filter((l) => l.startsWith('#'))
    .join('\n');
  assert(header.includes('VERITY_BOT_TOKEN'), 'header names VERITY_BOT_TOKEN');
  assert(header.includes('ANTHROPIC_API_KEY'), 'header names ANTHROPIC_API_KEY');
  assert(header.includes('bot machine'), 'token purpose explained (dedicated bot account)');
  assert(header.includes('Budget guardrails'), 'guardrails section present');
  assert(header.includes('max_usd_per_day'), 'daily budget check documented');
  assert(header.includes('timeout-minutes: 50'), 'Actions-level cap documented');
});

test('running the scaffold twice is idempotent (byte-identical, no duplicates)', () => {
  const cwd = sandbox();
  install.installActions({ cwd });
  const first = fs.readFileSync(path.join(cwd, WF), 'utf8');
  const r2 = install.installActions({ cwd });
  assertEqual(r2.created, false);
  assertEqual(r2.unchanged, true);
  assertEqual(fs.readFileSync(path.join(cwd, WF), 'utf8'), first, 'second run changed nothing');
});

test('a locally-modified workflow is never clobbered silently; --force regenerates', () => {
  const cwd = sandbox();
  install.installActions({ cwd });
  const file = path.join(cwd, WF);
  const edited = `${fs.readFileSync(file, 'utf8')}# local tweak\n`;
  fs.writeFileSync(file, edited);
  let err = null;
  try {
    install.installActions({ cwd });
  } catch (e) {
    err = e;
  }
  assert(err !== null, 'modified file without --force must throw');
  assert(err.message.includes('--force'), 'error names the --force escape hatch');
  assertEqual(fs.readFileSync(file, 'utf8'), edited, 'file untouched after refusal');
  const forced = install.installActions({ cwd, force: true });
  assertEqual(forced.updated, true);
  assertEqual(fs.readFileSync(file, 'utf8'), install.actionsWorkflowYaml(), 'regenerated');
});

test('--bot templates the self-event guard (and only valid logins are accepted)', () => {
  const yaml = install.actionsWorkflowYaml('acme-verity-bot');
  assert(yaml.includes("if: github.actor != 'acme-verity-bot'"), 'guard uses the custom login');
  assert(yaml.includes('(bot login: acme-verity-bot)'), 'header records the login');
  assert(!yaml.includes("'verity-bot'"), 'default login fully replaced');
  for (const bad of ["x' || true || '", 'a b', '', 'café']) {
    let threw = false;
    try {
      install.actionsWorkflowYaml(bad);
    } catch {
      threw = true;
    }
    assert(threw, `login ${JSON.stringify(bad)} must be rejected (expression injection)`);
  }
});

test('dispatch --actions routes to the Actions scaffold (and still ensures labels)', () => {
  const cwd = sandbox();
  // Stub gh as unavailable so the labels step degrades and no network is hit.
  const bin = path.join(cwd, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nprocess.exit(1);\n');
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  try {
    const r = install.dispatch([], { actions: true, cwd, bot: 'team-bot' });
    assertEqual(r.harness, 'actions');
    assertEqual(r.bot, 'team-bot');
    assert(fs.existsSync(path.join(cwd, WF)), 'workflow on disk');
    assertEqual(r.labels.skipped, true, 'labels step degrades gracefully without gh');
  } finally {
    process.env.PATH = savedPath;
  }
});

// Frozen-contract fixture: the exact YAML body (after the header comment) for
// the default bot login. This exact text passed actionlint 1.7.12. Any change
// to the template must update this fixture CONSCIOUSLY and re-run actionlint.
const EXPECTED_BODY = `name: verity-worker
on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, labeled, synchronize]
  issue_comment:
    types: [created] # an approval comment wakes the worker (see docs/autonomy.md)
  schedule:
    - cron: '*/30 * * * *'
concurrency:
  group: verity-\${{ github.repository }}
  cancel-in-progress: false
jobs:
  work:
    if: github.actor != 'verity-bot' # self-event guard (templated login)
    runs-on: ubuntu-latest
    timeout-minutes: 50
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.VERITY_BOT_TOKEN }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm i -g verity-framework@^1 @anthropic-ai/claude-code
      # The worker's usage-ledger commit self-identifies (author verity-worker); no git config step needed.
      - run: verity-worker --repo \${{ github.repository }} --once
        env:
          GH_TOKEN: \${{ secrets.VERITY_BOT_TOKEN }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

test('generated YAML body matches the actionlint-verified fixture exactly', () => {
  const yaml = install.actionsWorkflowYaml();
  const bodyStart = yaml.indexOf('name: verity-worker');
  assert(bodyStart > 0, 'header comment precedes the body');
  const head = yaml.slice(0, bodyStart);
  assert(
    head
      .split('\n')
      .filter((l) => l !== '')
      .every((l) => l.startsWith('#')),
    'everything before the body is comment',
  );
  assertEqual(yaml.slice(bodyStart), EXPECTED_BODY, 'frozen §6 template body');
});

test('--auth subscription swaps the agent secret to CLAUDE_CODE_OAUTH_TOKEN', () => {
  const yaml = install.actionsWorkflowYaml('verity-bot', { auth: 'subscription' });
  assert(
    yaml.includes('CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'),
    'worker step uses the OAuth token secret',
  );
  assert(
    !yaml.includes('ANTHROPIC_API_KEY: ${{'),
    'no API key secret wired into the env (the header may still mention it as a warning)',
  );
  const header = yaml
    .split('\n')
    .filter((l) => l.startsWith('#'))
    .join('\n');
  assert(header.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'header documents the OAuth token secret');
  assert(header.includes('setup-token'), 'header tells you how to mint it');
  assert(header.includes('Agent SDK credit'), 'header warns about the monthly credit ceiling');
});

test('subscription body == api-key body with only the agent-auth env line swapped', () => {
  const api = install.actionsWorkflowYaml();
  const sub = install.actionsWorkflowYaml('verity-bot', { auth: 'subscription' });
  const bodyOf = (y) => y.slice(y.indexOf('name: verity-worker'));
  const apiBody = bodyOf(api).replace(
    'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
    'CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
  );
  assertEqual(bodyOf(sub), apiBody, 'only the agent-auth env entry differs in the job body');
});

test('actionsWorkflowYaml rejects an unknown --auth mode', () => {
  let threw = false;
  try {
    install.actionsWorkflowYaml('verity-bot', { auth: 'oauth-magic' });
  } catch (e) {
    threw = true;
    assert(/--auth/.test(e.message), 'error names the --auth flag');
  }
  assert(threw, 'unknown auth mode must throw');
});

test('installActions --auth subscription writes the OAuth variant and reports auth', () => {
  const cwd = sandbox();
  const r = install.installActions({ cwd, auth: 'subscription' });
  assertEqual(r.created, true);
  assertEqual(r.auth, 'subscription');
  const body = fs.readFileSync(path.join(cwd, WF), 'utf8');
  assert(
    body.includes('CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'),
    'oauth env on disk',
  );
  assert(!body.includes('ANTHROPIC_API_KEY: ${{'), 'no api key secret wired on disk');
  assertEqual(install.installActions({ cwd: sandbox() }).auth, 'api-key', 'default stays api-key');
});

test('actionlint accepts the generated workflow (runs only when actionlint is on PATH)', () => {
  const probe = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stdout.write(
      '    (actionlint not on PATH — skipped; fixture test covers the freeze)\n',
    );
    return;
  }
  const cwd = sandbox();
  install.installActions({ cwd, bot: 'some-bot' });
  const r = spawnSync('actionlint', ['-no-color', path.join(cwd, WF)], { encoding: 'utf8' });
  assertEqual(r.status, 0, `actionlint failed:\n${r.stdout}${r.stderr}`);
});
