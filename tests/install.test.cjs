const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../verity/bin/lib/install.cjs');

// `home` keeps the global deployment-methods seed inside the test sandbox instead
// of the real ~/.verity.
function sandbox(tag) {
  return {
    target: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`)),
    home: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-home-`)),
  };
}

test('installClaude lays down command files + engine internals', () => {
  const { target, home } = sandbox('inst');
  const r = install.installClaude({ target, home });
  assertEqual(r.harness, 'claude');
  assert(
    r.installed.some((p) => p.endsWith('vision.md')),
    'vision.md should be reported installed',
  );
  assert(
    fs.existsSync(path.join(target, 'commands', 'verity', 'vision.md')),
    'command file on disk',
  );
  assert(
    fs.existsSync(path.join(target, 'verity', 'bin', 'verity.cjs')),
    'engine internals copied (self-contained fallback)',
  );
});

test('install seeds the global deployment-methods catalog (setup step)', () => {
  const { target, home } = sandbox('inst-deploy');
  const r = install.installClaude({ target, home });
  assert(r.deploymentMethods.created, 'catalog seeded on a fresh home');
  assert(
    fs.existsSync(path.join(home, 'deployment-methods.md')),
    'catalog on disk under ~/.verity',
  );
  // Reinstall must NOT clobber the user's edited catalog.
  const second = install.installClaude({ target, home });
  assertEqual(second.deploymentMethods.created, false, 'reinstall does not reseed');
});

test('installClaude does not require touching the real home dir', () => {
  const { target, home } = sandbox('inst2');
  const r = install.installClaude({ target, home });
  assert(r.target === target, 'must install into the provided target');
});

test('gemini adapter is not implemented yet', () => {
  let failed = false;
  try {
    install.dispatch([], { gemini: true });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'gemini adapter not implemented yet');
});

// --- OpenCode adapter ---
test('transformForOpenCode reduces frontmatter to description, drops allowed-tools', () => {
  const claudeCmd = [
    '---',
    'name: verity:vision',
    'description: Vision — do the thing.',
    'allowed-tools:',
    '  - Bash',
    '  - Write',
    '---',
    'Body uses `verity` and falls back to node "$HOME/.claude/verity/bin/verity.cjs".',
  ].join('\n');
  const out = install.transformForOpenCode(claudeCmd);
  assert(out.includes('description: Vision — do the thing.'), 'description preserved');
  assert(!out.includes('allowed-tools'), 'Claude-only allowed-tools dropped');
  assert(!out.includes('name: verity:vision'), 'name dropped (filename is the id)');
  assert(!out.includes('.claude/verity'), 'CLI fallback path rewritten away from .claude');
  assert(out.includes('OPENCODE_CONFIG_DIR'), 'fallback points at the OpenCode config dir');
});

test('installOpenCode flattens commands to command/verity-*.md and copies internals', () => {
  const { target, home } = sandbox('oc');
  const r = install.installOpenCode({ target, home });
  assertEqual(r.harness, 'opencode');
  assert(r.deploymentMethods.created, 'OpenCode install also seeds the global catalog');
  assert(
    fs.existsSync(path.join(target, 'command', 'verity-vision.md')),
    'flattened command installed',
  );
  assert(
    fs.existsSync(path.join(target, 'verity', 'bin', 'verity.cjs')),
    'engine internals copied',
  );
  const installed = fs.readFileSync(path.join(target, 'command', 'verity-vision.md'), 'utf8');
  assert(!installed.includes('allowed-tools'), 'installed command is OpenCode-shaped');
});

// --- Codex adapter (stage 6) ---

test('transformForCodex reduces frontmatter, rewrites invocations/paths/arguments', () => {
  const claudeCmd = [
    '---',
    'name: verity:vision',
    'description: Vision — do the thing.',
    'allowed-tools:',
    '  - Bash',
    '  - Write',
    '---',
    'Body uses `verity` and falls back to node "$HOME/.claude/verity/bin/verity.cjs".',
    'Hand off to /verity:plan with `verity slug "$ARGUMENTS"`.',
  ].join('\n');
  const out = install.transformForCodex(claudeCmd);
  assert(out.includes('name: verity-vision'), 'skill name uses dashes');
  assert(out.includes('description: Vision — do the thing.'), 'description preserved');
  assert(!out.includes('allowed-tools'), 'Claude-only allowed-tools dropped');
  assert(!out.includes('.claude/verity'), 'CLI fallback path rewritten away from .claude');
  assert(out.includes('$HOME/.agents/verity'), 'fallback points at the Codex host root');
  assert(!out.includes('/verity:plan'), 'cross-role handoff rewritten');
  assert(out.includes('$verity-plan'), 'handoff uses explicit skill invocation syntax');
  assert(!out.includes('$ARGUMENTS'), '$ARGUMENTS resolved (no shell-style expansion in Codex)');
  assert(out.includes(install.CODEX_ARGUMENTS_PLACEHOLDER), 'placeholder substituted');
});

test('installCodex lays down one skill package per role + engine internals', () => {
  const { target, home } = sandbox('cx');
  const r = install.installCodex({ target, home });
  assertEqual(r.harness, 'codex');
  assert(r.deploymentMethods.created, 'Codex install also seeds the global catalog');
  const roles = fs
    .readdirSync(path.join(__dirname, '..', 'commands', 'verity'))
    .filter((n) => n.endsWith('.md'));
  const skills = fs.readdirSync(path.join(target, 'skills'));
  assertEqual(skills.length, roles.length, 'one skill directory per role');
  const names = new Set();
  for (const skill of skills) {
    assert(/^verity-[a-z][a-z0-9-]*$/.test(skill), `${skill} is a verity-<role> id`);
    const md = fs.readFileSync(path.join(target, 'skills', skill, 'SKILL.md'), 'utf8');
    const name = (md.match(/^name:\s*(.+)$/m) || [])[1];
    const description = (md.match(/^description:\s*(.+)$/m) || [])[1] || '';
    assertEqual(name, skill, `${skill} SKILL.md name matches its directory`);
    assert(!names.has(name), `${name} is unique`);
    names.add(name);
    assert(description.trim().length > 0, `${skill} has a concrete description`);
    const yaml = fs.readFileSync(
      path.join(target, 'skills', skill, 'agents', 'openai.yaml'),
      'utf8',
    );
    assert(
      yaml.includes('allow_implicit_invocation: false'),
      `${skill} disables implicit invocation (ADR-0006)`,
    );
    assert(!md.includes('allowed-tools'), `${skill} carries no Claude-only frontmatter`);
    assert(!md.includes('$HOME/.claude/verity'), `${skill} has no Claude engine path`);
  }
  assert(
    fs.existsSync(path.join(target, 'verity', 'bin', 'verity.cjs')),
    'engine internals copied (self-contained fallback)',
  );
  const state = JSON.parse(
    fs.readFileSync(path.join(target, 'verity', install.STATE_FILE), 'utf8'),
  );
  assertEqual(state.harness, 'codex', 'install state records the codex harness');
});

test('installCodex does not copy .tools.json allowlists (no Codex equivalent yet)', () => {
  const { target, home } = sandbox('cx-tools');
  install.installCodex({ target, home });
  const stray = [];
  for (const skill of fs.readdirSync(path.join(target, 'skills'))) {
    for (const f of fs.readdirSync(path.join(target, 'skills', skill))) {
      if (f.endsWith('.tools.json')) {
        stray.push(`${skill}/${f}`);
      }
    }
  }
  assertEqual(stray.length, 0, 'no Claude allowlists in Codex skill packages');
});

test('dispatch --codex routes to the Codex adapter', () => {
  const { target, home } = sandbox('cx2');
  const bin = path.join(target, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nprocess.exit(1);\n');
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  try {
    const r = install.dispatch([], { codex: true, target, home, cwd: target });
    assertEqual(r.harness, 'codex');
    assertEqual(r.labels.skipped, true, 'labels step degrades gracefully without gh');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('harness flags are mutually exclusive', () => {
  for (const flags of [
    { codex: true, opencode: true },
    { claude: true, codex: true },
    { opencode: true, gemini: true },
  ]) {
    let failed = false;
    try {
      install.dispatch([], flags);
    } catch (e) {
      failed = true;
      assert(e.message.includes('mutually exclusive'), 'error names the conflict');
    }
    assert(failed, `${JSON.stringify(flags)} must be rejected`);
  }
});

test('install --codex --dry-run reports the full plan and writes nothing', () => {
  const { target } = sandbox('cx-dry');
  const r = install.dispatch([], { codex: true, 'dry-run': true, target, cwd: target });
  assertEqual(r.dryRun, true, 'dry-run result');
  assertEqual(r.harness, 'codex');
  assertEqual(r.target, target, 'plan names the target root');
  const roles = fs
    .readdirSync(path.join(__dirname, '..', 'commands', 'verity'))
    .filter((n) => n.endsWith('.md')).length;
  const skillMds = r.plan.filter((p) => p.endsWith('SKILL.md')).length;
  const yamls = r.plan.filter((p) => p.endsWith('openai.yaml')).length;
  assertEqual(skillMds, roles, 'plan lists every SKILL.md');
  assertEqual(yamls, roles, 'plan lists every openai.yaml');
  assert(
    r.plan.includes(path.join('verity', install.STATE_FILE)),
    'plan lists the install-state destination',
  );
  assertEqual(fs.readdirSync(target).length, 0, 'target untouched — nothing written');
});

test('dispatch --opencode routes to the OpenCode adapter', () => {
  const { target, home } = sandbox('oc2');
  // dispatch now also ensures autonomy labels; stub gh as unavailable so this
  // stays network-free (labels behavior itself is covered in labels.test.cjs).
  const bin = path.join(target, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nprocess.exit(1);\n');
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  try {
    const r = install.dispatch([], { opencode: true, target, home, cwd: target });
    assertEqual(r.harness, 'opencode');
    assertEqual(r.labels.skipped, true, 'labels step degrades gracefully without gh');
  } finally {
    process.env.PATH = savedPath;
  }
});
