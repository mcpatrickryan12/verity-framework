// Verity adapter / installer — the Runtime Adapter layer (framework-spec.md §4b).
// Same role-command CONTENT, transformed into each harness's format + install
// location. Claude Code is the reference harness; OpenCode is the second adapter.
// Capability differences (no Task sub-agents / no hooks on OpenCode) are handled by
// the commands' own "implement inline" fallback — the content already degrades.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./core.cjs');
const deployment = require('./deployment.cjs');
const labels = require('./labels.cjs');

const PKG_ROOT = path.join(__dirname, '..', '..', '..');
const TEMPLATES_DIR = path.join(PKG_ROOT, 'verity', 'templates');

// --- Role-prompt transform pipeline (ADR-0002) ---
//
// Every role file passes through here before being written to any host
// location: rendered role = shared preamble block(s) + role body + host pass.
// Pure string transforms only; templates use `core.render` {{var}} substitution
// (zero-dep policy — no templating engine).

// Shared preamble blocks, in render order. `option: null` = always included;
// `option: '<key>'` = conditional, included only when that install option is
// truthy (groundwork for `--with-knowing` — a future knowing preamble joins
// this table keyed on its option; no knowing content exists yet). Templates
// live once in verity/templates/ and are the ONLY place cross-cutting prompt
// content is written — role sources stay clean.
//
// `preamble-verity-git.md.tmpl` (stage 17, ADR-0012) is the first real user of
// the conditional mechanism. It is OFF by default and no install ever turns it
// on: it is set only by a headless driver whose runtime cannot write under
// `.git`, for the runs where Verity really has created the branch and really
// will commit/push/PR (it interpolates {{branch}}, so it can only be true when
// a branch exists). Every install path, every other host, and every golden
// render fixture are therefore byte-identical to before it existed.
// `preamble-verity-github.md.tmpl` (stage 24, ADR-0013) extends the same
// mechanism one layer up: GitHub I/O. OFF by default, set only by a headless
// contained render that was handed a Verity-gathered state snapshot (it
// interpolates {{stateSnapshot}}, so it can only be true when facts exist).
// Installs and every other host stay byte-identical, exactly like the git block.
const PREAMBLES = [
  { template: 'preamble-runtime.md.tmpl', option: null },
  { template: 'preamble-verity-git.md.tmpl', option: 'verityPerformsGit' },
  { template: 'preamble-verity-github.md.tmpl', option: 'verityPerformsGitHub' },
];

// Recorded install options (the idempotency state file alongside the engine
// copy). Chosen options must round-trip so a re-run with the same options is
// provably byte-identical, and a future re-run with DIFFERENT options (e.g.
// adding --with-knowing) can be detected.
const STATE_FILE = 'install-options.json';

// Render the preamble blocks selected by `options` into an array of trimmed
// text blocks. A block's template path is resolved against verity/templates/
// (absolute paths pass through — the test seam for synthetic blocks).
function composePreambles(options = {}, blocks = PREAMBLES) {
  const parts = [];
  for (const block of blocks) {
    if (block.option !== null && !options[block.option]) {
      continue;
    }
    const file = path.isAbsolute(block.template)
      ? block.template
      : path.join(TEMPLATES_DIR, block.template);
    parts.push(core.render(fs.readFileSync(file, 'utf8'), options).trimEnd());
  }
  return parts;
}

function splitFrontmatter(source) {
  const m = String(source).match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  return m ? { frontmatter: m[1], body: m[2] } : { frontmatter: '', body: String(source) };
}

// Host adapters are PASSES over the composed content, not separate code paths.
// claude: the reference harness — frontmatter kept verbatim (the `.tools.json`
// allowlist travels separately, copied by installClaude). opencode: the
// existing flattening transform, unchanged, as the final pass. codex: the
// SKILL.md transform (stage 6, ADR-0005/0006).
const HOST_PASSES = {
  claude: (content) => content,
  opencode: (content) => transformForOpenCode(content),
  codex: (content) => transformForCodex(content),
};

// The pipeline core: compose preambles + role body, then apply the host pass.
// Idempotent by construction — a block already present in the body (e.g. the
// input is an already-installed file) is never inserted twice.
function renderRoleContent(source, options = {}, host = 'claude', blocks = PREAMBLES) {
  const pass = HOST_PASSES[host];
  if (!pass) {
    throw new Error(`unknown host '${host}' (use ${Object.keys(HOST_PASSES).join(' | ')})`);
  }
  const { frontmatter, body } = splitFrontmatter(source);
  const parts = composePreambles(options, blocks).filter((p) => !body.includes(p));
  const preamble = parts.length > 0 ? `${parts.join('\n\n')}\n\n` : '';
  return pass(`${frontmatter}${preamble}${body}`);
}

// Public pipeline API (ADR-0002): rendered role for a host as a pure function
// of (role file, install options, host). Used by install, agent-exec's
// renderPrompt(), and the future `--with-knowing`.
function renderRole(roleFile, options = {}, host = 'claude') {
  return renderRoleContent(fs.readFileSync(roleFile, 'utf8'), options, host);
}

// Normalize the conditional install options out of CLI flags. Deliberately
// empty for now: no conditional option exists yet. `--with-knowing` will map
// here (flags['with-knowing'] → { withKnowing: true }) when it lands.
function conditionalOptions(_flags = {}) {
  return {};
}

// Record the chosen install options next to the engine copy. Deterministic
// content (no timestamps) so a same-options re-run is byte-identical.
function writeInstallState(target, harness, options) {
  const rel = path.join('verity', STATE_FILE);
  fs.writeFileSync(
    path.join(target, rel),
    `${JSON.stringify({ schema: 1, harness, options }, null, 2)}\n`,
  );
  return rel;
}

// Part of setup: seed the user-global deployment-methods catalog (NEVER clobbered).
// It lives in the user's home (~/.verity), independent of the harness target dir.
function seedDeploymentMethods(opts) {
  const seed = deployment.ensure({ home: opts.home });
  return { ...seed, label: `${seed.path}${seed.created ? '' : ' (existing)'}` };
}

function commandFiles(srcCommands, ext = '.md') {
  return fs.readdirSync(srcCommands).filter((n) => n.endsWith(ext));
}

// engine-meta.json (stage 35): the version floors doctor.cjs / the drivers used
// to fetch via `require('../../../package.json')` — an above-engine-root path
// that a copied engine (only the `verity/` subtree is deployed) cannot resolve,
// so it crashed EVERY command at load. The metadata now lives INSIDE the subtree
// and is (re)stamped FRESH from the live package.json on every copy, so a
// deployed copy is self-contained AND accurate.
const ENGINE_META_REL = path.join('verity', 'engine-meta.json');

// Read straight from the live package.json — install.cjs runs only from the full
// checkout / npm package (it is the thing that CREATES copies; a copy never
// re-installs), so this above-root read is legitimate here. PKG_ROOT is a
// variable, so this is not the crash-class literal-path escape the escape-scan
// guard forbids inside the deployed runtime.
function engineMetaContent() {
  const pkg = require(path.join(PKG_ROOT, 'package.json'));
  return `${JSON.stringify({ version: pkg.version, verity: pkg.verity }, null, 2)}\n`;
}

// Stamp <target>/verity/engine-meta.json. Called at copy time AND by
// scripts/stamp-engine-meta.cjs to keep the committed checkout copy in sync.
function stampEngineMeta(target) {
  fs.writeFileSync(path.join(target, ENGINE_META_REL), engineMetaContent());
  return ENGINE_META_REL;
}

function copyInternals(target) {
  fs.cpSync(path.join(PKG_ROOT, 'verity'), path.join(target, 'verity'), { recursive: true });
  // Re-stamp engine-meta.json fresh from THIS package's package.json. A copy
  // deployed BEFORE stage 35 hard-crashed on load; the next `verity install`
  // re-stamps it and the crash is gone. Even an un-refreshed old copy no longer
  // crashes: engine-meta.cjs falls back to built-in floors with a stderr notice.
  stampEngineMeta(target);
}

function claudeDir(opts) {
  return opts.target || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function installClaude(opts = {}) {
  const target = claudeDir(opts);
  const options = opts.options || {};
  const installed = [];

  // 1. Role command files (through the ADR-0002 pipeline) + their T06 tool
  //    allowlists (<role>.tools.json) → <target>/commands/verity/. agent-exec
  //    resolves both from the SAME dir, and a missing allowlist is deny-all
  //    (exit 30) — so the installed copies must always travel together.
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  const destCommands = path.join(target, 'commands', 'verity');
  fs.mkdirSync(destCommands, { recursive: true });
  for (const name of commandFiles(srcCommands)) {
    const rendered = renderRole(path.join(srcCommands, name), options, 'claude');
    fs.writeFileSync(path.join(destCommands, name), rendered);
    installed.push(path.join('commands', 'verity', name));
  }
  for (const name of commandFiles(srcCommands, '.tools.json')) {
    fs.copyFileSync(path.join(srcCommands, name), path.join(destCommands, name));
    installed.push(path.join('commands', 'verity', name));
  }

  // 2. Engine internals → <target>/verity/ (self-contained fallback for the
  //    CLI), then the install-options state record beside them.
  copyInternals(target);
  installed.push('verity/');
  installed.push(writeInstallState(target, 'claude', options));

  // 3. Seed the global deployment-methods catalog (setup step).
  const deploymentMethods = seedDeploymentMethods(opts);
  installed.push(deploymentMethods.label);

  return { harness: 'claude', target, installed, deploymentMethods };
}

// --- OpenCode adapter ---

function openCodeDir(opts) {
  return (
    opts.target || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode')
  );
}

// The OpenCode host pass (final pipeline pass — see HOST_PASSES). Transforms a
// Claude command .md into OpenCode's command format:
// - frontmatter reduced to `description:` (OpenCode's per-command field; the
//   Claude-only `allowed-tools` allowlist + `name` are dropped — OpenCode manages
//   permissions globally and derives the command id from the filename)
// - the Claude-specific CLI fallback path is rewritten to the OpenCode config dir
// Knowingly lossy (ADR-0002 keeps it visible as pass-level debt); fixing that
// is out of scope here — same output as before, just produced by the pipeline.
function transformForOpenCode(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    return content;
  }
  const description = (m[1].match(/^description:\s*(.+)$/m) || [])[1] || '';
  const body = m[2].replace(
    /\$HOME\/\.claude\/verity/g,
    '${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/verity',
  );
  return `---\ndescription: ${description}\n---\n${body}`;
}

function installOpenCode(opts = {}) {
  const target = openCodeDir(opts);
  const options = opts.options || {};
  const installed = [];

  // Role commands → <target>/command/, flattened to verity-<name>.md (invoked
  // /verity-<name>), rendered through the same pipeline (preambles first,
  // transformForOpenCode as the final pass).
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  const destCommands = path.join(target, 'command');
  fs.mkdirSync(destCommands, { recursive: true });
  for (const name of commandFiles(srcCommands)) {
    const out = `verity-${name}`;
    const rendered = renderRole(path.join(srcCommands, name), options, 'opencode');
    fs.writeFileSync(path.join(destCommands, out), rendered);
    installed.push(path.join('command', out));
  }

  copyInternals(target);
  installed.push('verity/');
  installed.push(writeInstallState(target, 'opencode', options));

  const deploymentMethods = seedDeploymentMethods(opts);
  installed.push(deploymentMethods.label);

  return { harness: 'opencode', target, installed, deploymentMethods };
}

// --- Codex adapter (stage 6, ADR-0005/0006) ---

// User-scoped Codex skill root. No env override: unlike CLAUDE_CONFIG_DIR /
// OPENCODE_CONFIG_DIR, Codex documents no config-dir variable for skill
// discovery today — opts.target is the test seam and the advanced-user escape.
function codexDir(opts) {
  return opts.target || path.join(os.homedir(), '.agents');
}

// $ARGUMENTS has no shell-style expansion under Codex skills; rendered roles
// carry a named placeholder the role resolves from its explicit invocation
// (e.g. `$verity-plan ISSUE-123` — the role reads ISSUE-123 from context).
const CODEX_ARGUMENTS_PLACEHOLDER = '<invocation arguments>';

// The Codex host pass (final pipeline pass — see HOST_PASSES). Transforms a
// Claude command .md into a Codex SKILL.md:
// - frontmatter reduced to `name:` + `description:` (skill ids use dashes:
//   verity:<role> → verity-<role>); the Claude-only `allowed-tools` allowlist
//   is dropped, and the paired .tools.json is NOT copied — Codex has no
//   --allowed-tools primitive; its permission policy is the stage 9 portable
//   layer (contracts/role-capability-policy.md), which fails closed headless.
// - cross-role handoffs /verity:<role> → $verity-<role>, Codex's explicit
//   skill-invocation syntax (implicit invocation stays off — ADR-0006).
// - the engine fallback path moves to the Codex host root ($HOME/.agents).
// - $ARGUMENTS → CODEX_ARGUMENTS_PLACEHOLDER (no automatic substitution).
function transformForCodex(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    return content;
  }
  const name = ((m[1].match(/^name:\s*(.+)$/m) || [])[1] || '').trim();
  const description = (m[1].match(/^description:\s*(.+)$/m) || [])[1] || '';
  const skillName = name.replace(/^verity:/, 'verity-');
  const body = m[2]
    .replace(/\$HOME\/\.claude\/verity/g, '$HOME/.agents/verity')
    .replace(/\/verity:([a-z][a-z0-9-]*)/g, '$verity-$1')
    .replace(/\$ARGUMENTS/g, CODEX_ARGUMENTS_PLACEHOLDER);
  return `---\nname: ${skillName}\ndescription: ${description}\n---\n${body}`;
}

// YAML double-quoted scalar (descriptions carry em-dashes and colons, so
// quoting is mandatory; zero-dep policy — no YAML library).
function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// agents/openai.yaml beside each SKILL.md: display metadata + the one policy
// line stage 6 exists to guarantee. Verity roles mutate repos, open PRs, cut
// releases — they must NEVER activate because an ordinary prompt resembles a
// role description (ADR-0006). Explicit `$verity-<role>` invocation only.
function codexSkillMeta(role, description) {
  const title = role
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return [
    'interface:',
    `  display_name: ${yamlQuote(`Verity ${title}`)}`,
    `  short_description: ${yamlQuote(description)}`,
    `  default_prompt: ${yamlQuote(`Run the Verity ${role} role for this repository.`)}`,
    '',
    'policy:',
    '  allow_implicit_invocation: false',
    '',
  ].join('\n');
}

function installCodex(opts = {}) {
  const target = codexDir(opts);
  const options = opts.options || {};
  const installed = [];

  // Role commands → <target>/skills/verity-<role>/{SKILL.md, agents/openai.yaml}
  // (one Codex skill package per role, invoked $verity-<role>), rendered through
  // the same pipeline (preambles first, transformForCodex as the final pass).
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  for (const name of commandFiles(srcCommands)) {
    const role = name.replace(/\.md$/, '');
    const source = fs.readFileSync(path.join(srcCommands, name), 'utf8');
    const description = (source.match(/^description:\s*(.+)$/m) || [])[1] || '';
    const skillDir = path.join(target, 'skills', `verity-${role}`);
    fs.mkdirSync(path.join(skillDir, 'agents'), { recursive: true });
    const rendered = renderRoleContent(source, options, 'codex');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rendered);
    fs.writeFileSync(
      path.join(skillDir, 'agents', 'openai.yaml'),
      codexSkillMeta(role, description),
    );
    installed.push(path.join('skills', `verity-${role}`, 'SKILL.md'));
    installed.push(path.join('skills', `verity-${role}`, 'agents', 'openai.yaml'));
  }

  copyInternals(target);
  installed.push('verity/');
  installed.push(writeInstallState(target, 'codex', options));

  const deploymentMethods = seedDeploymentMethods(opts);
  installed.push(deploymentMethods.label);

  return { harness: 'codex', target, installed, deploymentMethods };
}

// `verity install --codex --dry-run` (no role name) — the full install plan,
// writing NOTHING: target root and every path installCodex would create.
function codexInstallPlan(flags) {
  const target = codexDir({ target: flags.target });
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  const plan = [];
  for (const name of commandFiles(srcCommands)) {
    const role = name.replace(/\.md$/, '');
    plan.push(path.join('skills', `verity-${role}`, 'SKILL.md'));
    plan.push(path.join('skills', `verity-${role}`, 'agents', 'openai.yaml'));
  }
  plan.push('verity/');
  plan.push(path.join('verity', STATE_FILE));
  return { dryRun: true, harness: 'codex', target, plan };
}

// --- GitHub Actions driver (T15) ---
//
// `verity install --actions` scaffolds .github/workflows/verity-worker.yml from
// the SKETCH §6 template. Bot login: default 'verity-bot' (the §6 literal),
// override with `--bot <login>` — it only parameterizes the self-event guard
// (`github.actor != '<bot>'`), so a wrong value fails safe (extra runs that the
// worker's own §4.2 no-self-feeding rule then ignores), never silently skips
// human events. Not read from .verity/autonomy.yml: the policy has no bot field
// (the bot is whoever owns VERITY_BOT_TOKEN, known only at secret-config time).
const ACTIONS_WORKFLOW_PATH = path.join('.github', 'workflows', 'verity-worker.yml');
const ACTIONS_DEFAULT_BOT = 'verity-bot';

// How the headless agent authenticates to Anthropic. `api-key` is the default
// (pay-per-token, no usage ceiling). `subscription` runs `claude -p` against a
// Claude Pro/Max plan via an OAuth token from `claude setup-token` — usage draws
// from the plan's monthly Agent SDK credit and STOPS when that's exhausted.
const ACTIONS_DEFAULT_AUTH = 'api-key';
const ACTIONS_AUTH_MODES = ['api-key', 'subscription'];

// The two agent-auth variants: the header doc lines + the worker-step env entry.
// api-key MUST stay byte-identical to the original §6 template (frozen fixture).
function agentAuthBlock(auth) {
  if (auth === 'subscription') {
    return {
      headerDoc: [
        '#   CLAUDE_CODE_OAUTH_TOKEN — subscription auth for the headless agent. Generate it once',
        "#                        with 'claude setup-token' (≈1-year token) on a machine logged",
        '#                        into your Claude Pro/Max plan, then store it here. Headless',
        "#                        'claude -p' usage draws from your plan's monthly Agent SDK credit;",
        '#                        when that credit is exhausted the worker STOPS until the next',
        '#                        cycle — it does NOT fall back to paid API billing.',
        '#                        Do NOT also set ANTHROPIC_API_KEY: an API key takes precedence',
        '#                        and would force pay-per-token billing instead of the subscription.',
      ].join('\n'),
      env: 'CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    };
  }
  return {
    headerDoc: [
      '#   ANTHROPIC_API_KEY  — API key for the headless agent (verity agent-exec).',
      '#                        This is the key that spends money — see guardrails.',
    ].join('\n'),
    env: 'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
  };
}

// SKETCH §6 template, frozen contract. Deliberate adjustments, documented:
//   - block-style YAML (the sketch's flow-style `issue_comment:{...}` is not
//     even valid YAML; actionlint-verified spelling below),
//   - setup-node WITHOUT `cache: npm` — the cache option hard-fails when the
//     target repo has no npm lockfile (most Verity-managed repos aren't npm
//     projects), and the only npm work here is a global install of the tools.
function actionsWorkflowYaml(bot = ACTIONS_DEFAULT_BOT, opts = {}) {
  if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(bot)) {
    throw new Error(`invalid bot login for --bot: ${JSON.stringify(bot)}`);
  }
  const auth = opts.auth || ACTIONS_DEFAULT_AUTH;
  if (!ACTIONS_AUTH_MODES.includes(auth)) {
    throw new Error(
      `invalid --auth (use ${ACTIONS_AUTH_MODES.join(' | ')}): ${JSON.stringify(auth)}`,
    );
  }
  const agentAuth = agentAuthBlock(auth);
  return `# verity-worker — GitHub Actions driver for Verity autonomy.
# Generated by \`verity install --actions\` (bot login: ${bot}).
# Regenerate with the same command; it refuses to overwrite local edits
# unless you pass --force.
#
# Required repository secrets (Settings → Secrets and variables → Actions):
#   VERITY_BOT_TOKEN   — token for the DEDICATED bot machine account. Used for
#                        checkout and every gh call so all worker actions stay
#                        bot-attributed. It needs WRITE access to this repo.
#                        Never a human's token: the worker refuses to start
#                        (exit 30 bot-is-human) if its login is listed under \`humans:\`.
${agentAuth.headerDoc}
#
# Budget guardrails (ON by default):
#   - timeout-minutes: 50 hard-caps any single run at the Actions level.
#   - the worker's startup checks refuse to run (exit 30 daily-limit) once
#     today's .verity/usage.csv totals exceed limits.max_usd_per_day or
#     limits.max_runs_per_day from .verity/autonomy.yml.
#   - the concurrency group serializes runs: when the 30-minute schedule and
#     an event fire together (or a cron driver also ticks the same repo),
#     GitHub queues instead of double-working — and the worker's GitHub lock
#     protocol is the second fence.
#   - the \`github.actor != '${bot}'\` guard stops the bot's own labels,
#     comments and pushes from re-triggering this workflow (self-event loop).
name: verity-worker
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
    if: github.actor != '${bot}' # self-event guard (templated login)
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
          ${agentAuth.env}
`;
}

// Idempotent scaffold. Same inputs twice → byte-identical file, reported
// `unchanged`. A file that differs from what we would generate (local edits,
// or a different --bot) is NEVER clobbered silently: hard error naming
// --force; `--force` regenerates and reports `updated`.
function installActions(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const bot = typeof opts.bot === 'string' ? opts.bot : ACTIONS_DEFAULT_BOT;
  const auth = typeof opts.auth === 'string' ? opts.auth : ACTIONS_DEFAULT_AUTH;
  const content = actionsWorkflowYaml(bot, { auth });
  const file = path.join(cwd, ACTIONS_WORKFLOW_PATH);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === content) {
      return {
        harness: 'actions',
        path: ACTIONS_WORKFLOW_PATH,
        bot,
        auth,
        created: false,
        unchanged: true,
      };
    }
    if (!opts.force) {
      throw new Error(
        `${ACTIONS_WORKFLOW_PATH} exists with different content (local edits, a different --bot login, or a different --auth mode) — refusing to overwrite. Re-run with --force to regenerate.`,
      );
    }
    fs.writeFileSync(file, content);
    return {
      harness: 'actions',
      path: ACTIONS_WORKFLOW_PATH,
      bot,
      auth,
      created: false,
      updated: true,
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { harness: 'actions', path: ACTIONS_WORKFLOW_PATH, bot, auth, created: true };
}

// `verity install --dry-run <role>` — print the rendered output for one role,
// write NOTHING (the ADR-0002 debuggability mitigation: installed files diverge
// from sources, this shows exactly what a host would receive). The role name is
// accepted either positionally or as the flag value (`--dry-run vision`).
function dryRunRole(args, flags) {
  const role = typeof flags['dry-run'] === 'string' ? flags['dry-run'] : args[0];
  if (typeof role !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(role)) {
    throw new Error('usage: verity install --dry-run <role> [--opencode|--codex]');
  }
  const roleFile = path.join(PKG_ROOT, 'commands', 'verity', `${role}.md`);
  if (!fs.existsSync(roleFile)) {
    throw new Error(`unknown role '${role}' (no commands/verity/${role}.md)`);
  }
  const host = flags.codex ? 'codex' : flags.opencode ? 'opencode' : 'claude';
  const rendered = renderRole(roleFile, conditionalOptions(flags), host);
  return { dryRun: true, role, host, rendered, raw: rendered };
}

function dispatch(args, flags) {
  let result;
  // Harness flags are mutually exclusive — checked first so every mode
  // (dry-run included) rejects an ambiguous selection instead of guessing.
  const hosts = ['claude', 'opencode', 'codex', 'gemini'].filter((h) => flags[h]);
  if (hosts.length > 1) {
    throw new Error(
      `--${hosts[0]} and --${hosts[1]} are mutually exclusive — pick one harness per install`,
    );
  }
  if (flags['dry-run']) {
    // `--codex --dry-run` with no role = the whole-install plan; with a role,
    // the usual single-role render (both write nothing).
    if (flags.codex && flags['dry-run'] === true && args.length === 0) {
      return codexInstallPlan(flags);
    }
    return dryRunRole(args, flags);
  }
  if (flags.actions) {
    // Standalone scaffold into the TARGET REPO (cwd), not a harness config dir.
    // Run plain `verity install` separately for commands/labels.
    result = installActions({
      cwd: flags.cwd,
      bot: flags.bot,
      auth: flags.auth,
      force: Boolean(flags.force),
    });
    result.labels = labels.ensureLabels(flags.cwd || process.cwd());
    return result;
  }
  const options = conditionalOptions(flags);
  if (flags.opencode) {
    result = installOpenCode({ target: flags.target, home: flags.home, options });
  } else if (flags.codex) {
    result = installCodex({ target: flags.target, home: flags.home, options });
  } else if (flags.gemini) {
    throw new Error(
      'the gemini adapter is not implemented yet (use --claude | --opencode | --codex)',
    );
  } else {
    result = installClaude({ target: flags.target, home: flags.home, options });
  }
  // Autonomy label vocabulary on the target repo (SKETCH §1): idempotent
  // create-or-update, never delete. Best-effort — offline / outside a repo,
  // install still succeeds and the labels step reports itself as skipped.
  result.labels = labels.ensureLabels(flags.cwd || process.cwd());
  return result;
}

module.exports = {
  PREAMBLES,
  STATE_FILE,
  composePreambles,
  renderRole,
  renderRoleContent,
  installClaude,
  installActions,
  actionsWorkflowYaml,
  ACTIONS_WORKFLOW_PATH,
  ACTIONS_DEFAULT_BOT,
  ACTIONS_DEFAULT_AUTH,
  ACTIONS_AUTH_MODES,
  installOpenCode,
  transformForOpenCode,
  openCodeDir,
  installCodex,
  stampEngineMeta,
  ENGINE_META_REL,
  transformForCodex,
  codexDir,
  codexSkillMeta,
  CODEX_ARGUMENTS_PLACEHOLDER,
  dispatch,
  claudeDir,
  PKG_ROOT,
};
