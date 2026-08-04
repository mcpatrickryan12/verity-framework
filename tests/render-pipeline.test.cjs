// Stage 2 (ADR-0002): install-time role-prompt transform pipeline.
// rendered role = shared preamble block(s) + role body + host pass — one
// system for interactive installs AND headless renderPrompt().
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const install = require('../verity/bin/lib/install.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const ROLES_DIR = path.join(__dirname, '..', 'commands', 'verity');
const FIXTURES = path.join(__dirname, 'fixtures', 'render');
const RUNTIME_PREAMBLE = fs
  .readFileSync(
    path.join(__dirname, '..', 'verity', 'templates', 'preamble-runtime.md.tmpl'),
    'utf8',
  )
  .trimEnd();
// The tell-tale of a hand-pasted runtime-fallback line (build.md's unrelated
// "Runtime fallback: … implement inline" line must NOT match, so key on the path).
const FALLBACK_PATH = '$HOME/.claude/verity/bin/verity.cjs';

function roleFiles() {
  return fs.readdirSync(ROLES_DIR).filter((n) => n.endsWith('.md'));
}

function sandbox(tag) {
  return {
    target: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`)),
    home: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-home-`)),
  };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Recursive { relative path → content } snapshot of a directory tree.
function snapshot(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      snapshot(full, base, out);
    } else {
      out[path.relative(base, full)] = fs.readFileSync(full);
    }
  }
  return out;
}

// --- golden fixtures: exact rendered output per host ---

test('renderRole golden: claude output matches the fixture byte-for-byte', () => {
  const rendered = install.renderRole(path.join(FIXTURES, 'role.md'), {}, 'claude');
  assertEqual(rendered, fs.readFileSync(path.join(FIXTURES, 'role.claude.golden.md'), 'utf8'));
});

test('renderRole golden: opencode output matches the fixture byte-for-byte', () => {
  const rendered = install.renderRole(path.join(FIXTURES, 'role.md'), {}, 'opencode');
  assertEqual(rendered, fs.readFileSync(path.join(FIXTURES, 'role.opencode.golden.md'), 'utf8'));
});

test('renderRole golden: codex output matches the fixture byte-for-byte', () => {
  const rendered = install.renderRole(path.join(FIXTURES, 'role.md'), {}, 'codex');
  assertEqual(rendered, fs.readFileSync(path.join(FIXTURES, 'role.codex.golden.md'), 'utf8'));
});

test('renderRole rejects an unknown host', () => {
  let failed = false;
  try {
    install.renderRole(path.join(FIXTURES, 'role.md'), {}, 'emacs');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'unknown host must throw, never silently skip the host pass');
});

// --- conditional blocks keyed on install options (groundwork for --with-knowing) ---

test('conditional preamble blocks: excluded by default, included when the option is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cond-'));
  const tmpl = path.join(dir, 'preamble-fake.md.tmpl');
  fs.writeFileSync(tmpl, 'Fake conditional preamble ({{flavor}}).\n');
  const blocks = [...install.PREAMBLES, { template: tmpl, option: 'withFake' }];

  const source = fs.readFileSync(path.join(FIXTURES, 'role.md'), 'utf8');
  const off = install.renderRoleContent(source, {}, 'claude', blocks);
  assert(!off.includes('Fake conditional preamble'), 'option off → block absent');
  assert(off.includes(RUNTIME_PREAMBLE), 'unconditional block still present');

  const on = install.renderRoleContent(
    source,
    { withFake: true, flavor: 'graph' },
    'claude',
    blocks,
  );
  assert(
    on.includes('Fake conditional preamble (graph).'),
    'option on → block rendered with {{var}} substituted',
  );
  assert(
    on.indexOf(RUNTIME_PREAMBLE) < on.indexOf('Fake conditional preamble'),
    'blocks keep table order',
  );
});

test('preamble injection is idempotent (already-rendered input passes through unchanged)', () => {
  const once = install.renderRole(path.join(FIXTURES, 'role.md'), {}, 'claude');
  assertEqual(install.renderRoleContent(once, {}, 'claude'), once, 'no double insertion');
});

// --- migration: the runtime-fallback line lives ONLY in the template now ---

test('no role source file contains the runtime-fallback line', () => {
  for (const name of roleFiles()) {
    const source = fs.readFileSync(path.join(ROLES_DIR, name), 'utf8');
    assert(!source.includes(FALLBACK_PATH), `${name} still hand-pastes the runtime-fallback line`);
  }
});

// Diff test: for every role, the new claude output == old copy behavior modulo
// the extracted preamble — i.e. exactly frontmatter + preamble + untouched body.
test('every role rendered for claude == source + extracted preamble, exactly once', () => {
  for (const name of roleFiles()) {
    const file = path.join(ROLES_DIR, name);
    const source = fs.readFileSync(file, 'utf8');
    const m = source.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
    assert(m, `${name} has frontmatter`);
    const rendered = install.renderRole(file, {}, 'claude');
    assertEqual(rendered, `${m[1]}${RUNTIME_PREAMBLE}\n\n${m[2]}`, `${name} claude render`);
    assertEqual(count(rendered, RUNTIME_PREAMBLE), 1, `${name} renders the preamble exactly once`);
  }
});

// --- OpenCode: same pass, byte-identical output ---

test('opencode pipeline output is byte-identical to transformForOpenCode on the composed content', () => {
  for (const name of roleFiles()) {
    const file = path.join(ROLES_DIR, name);
    assertEqual(
      install.renderRole(file, {}, 'opencode'),
      install.transformForOpenCode(install.renderRole(file, {}, 'claude')),
      `${name} opencode pass`,
    );
  }
});

test('installed opencode roles carry the preamble with the rewritten config-dir path', () => {
  const { target, home } = sandbox('rp-oc');
  install.installOpenCode({ target, home });
  const installed = fs.readFileSync(path.join(target, 'command', 'verity-vision.md'), 'utf8');
  assert(
    installed.includes('${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/verity/bin/verity.cjs'),
    'runtime fallback rendered and rewritten for OpenCode',
  );
  assert(!installed.includes(FALLBACK_PATH), 'no Claude-specific path leaks into OpenCode output');
});

// --- Codex: same pass, byte-identical output + corpus-wide audit ---

test('codex pipeline output is byte-identical to transformForCodex on the composed content', () => {
  for (const name of roleFiles()) {
    const file = path.join(ROLES_DIR, name);
    assertEqual(
      install.renderRole(file, {}, 'codex'),
      install.transformForCodex(install.renderRole(file, {}, 'claude')),
      `${name} codex pass`,
    );
  }
});

// The stage 6 audit: every canonical role rendered for codex is free of
// Claude-host residue — the render-time proof behind ADR-0006's rewrites.
test('every role rendered for codex carries no Claude-host residue', () => {
  for (const name of roleFiles()) {
    const rendered = install.renderRole(path.join(ROLES_DIR, name), {}, 'codex');
    assert(!rendered.includes('$ARGUMENTS'), `${name}: unresolved $ARGUMENTS`);
    assert(!rendered.includes('/verity:'), `${name}: un-rewritten /verity: invocation`);
    assert(!rendered.includes(FALLBACK_PATH), `${name}: Claude engine fallback path leaked`);
    assert(!rendered.includes('allowed-tools'), `${name}: Claude-only frontmatter leaked`);
    const m = rendered.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    assert(m, `${name}: valid frontmatter`);
    assertEqual((m[1].match(/^name:/gm) || []).length, 1, `${name}: exactly one name`);
    assertEqual(
      (m[1].match(/^description:/gm) || []).length,
      1,
      `${name}: exactly one description`,
    );
    assert(/^name: verity-[a-z][a-z0-9-]*$/m.test(m[1]), `${name}: verity-<role> skill name`);
    assert(
      m[2].includes(RUNTIME_PREAMBLE.replace(/\$HOME\/\.claude\/verity/g, '$HOME/.agents/verity')),
      `${name}: preamble present, rewritten`,
    );
    // Body not truncated: the codex body must be at least as long as the
    // source body (all transforms are same-length-or-longer replacements).
    const source = fs.readFileSync(path.join(ROLES_DIR, name), 'utf8');
    const sourceBody = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)[1];
    assert(m[2].length >= sourceBody.length, `${name}: body truncated by the codex pass`);
  }
});

test('installCodex twice with the same options is byte-identical', () => {
  const { target, home } = sandbox('rp-idem-cx');
  install.installCodex({ target, home });
  const first = snapshot(target);
  install.installCodex({ target, home });
  const second = snapshot(target);
  assertEqual(Object.keys(first).length, Object.keys(second).length, 'same file count');
  for (const name of Object.keys(first)) {
    assert(second[name] && first[name].equals(second[name]), `${name} changed between installs`);
  }
});

test('install --dry-run <role> respects --codex', () => {
  const { target } = sandbox('rp-dry-cx');
  const r = install.dispatch([], { 'dry-run': 'vision', codex: true, target, cwd: target });
  assertEqual(r.role, 'vision');
  assertEqual(r.host, 'codex');
  assertEqual(r.rendered, install.renderRole(path.join(ROLES_DIR, 'vision.md'), {}, 'codex'));
  assertEqual(fs.readdirSync(target).length, 0, 'target untouched');
});

// --- headless parity: renderPrompt() consumes the same pipeline ---

test('renderPrompt contains the same preamble as installed files (headless parity)', () => {
  const { target, home } = sandbox('rp-parity');
  install.installClaude({ target, home });
  const installed = fs.readFileSync(path.join(target, 'commands', 'verity', 'vision.md'), 'utf8');
  assert(installed.includes(RUNTIME_PREAMBLE), 'installed file carries the preamble');
  const prompt = agentExec.renderPrompt(path.join(ROLES_DIR, 'vision.md'), []);
  assertEqual(count(prompt, RUNTIME_PREAMBLE), 1, 'headless prompt carries the same preamble once');
  assert(
    prompt.includes('<headless-result-contract>'),
    'RESULT_CONTRACT still appended (headless-only)',
  );
});

test('renderPrompt on an already-installed copy does not double the preamble', () => {
  const { target, home } = sandbox('rp-installed');
  install.installClaude({ target, home });
  const prompt = agentExec.renderPrompt(path.join(target, 'commands', 'verity', 'vision.md'), []);
  assertEqual(count(prompt, RUNTIME_PREAMBLE), 1, 'installed input → still exactly one preamble');
});

// --- idempotency: same options twice → byte-identical files + recorded options ---

test('installClaude twice with the same options is byte-identical and records options', () => {
  const { target, home } = sandbox('rp-idem');
  install.installClaude({ target, home });
  const first = snapshot(target);
  install.installClaude({ target, home });
  const second = snapshot(target);
  const names = Object.keys(first).sort();
  assertEqual(names.join('\n'), Object.keys(second).sort().join('\n'), 'same file set');
  for (const name of names) {
    assert(first[name].equals(second[name]), `${name} changed between identical installs`);
  }
  const state = JSON.parse(
    fs.readFileSync(path.join(target, 'verity', install.STATE_FILE), 'utf8'),
  );
  assertEqual(state.schema, 1, 'state schema');
  assertEqual(state.harness, 'claude', 'state harness');
  assertEqual(JSON.stringify(state.options), '{}', 'chosen options recorded');
});

test('installOpenCode twice with the same options is byte-identical', () => {
  const { target, home } = sandbox('rp-idem-oc');
  install.installOpenCode({ target, home });
  const first = snapshot(target);
  install.installOpenCode({ target, home });
  const second = snapshot(target);
  assertEqual(Object.keys(first).length, Object.keys(second).length, 'same file count');
  for (const name of Object.keys(first)) {
    assert(second[name] && first[name].equals(second[name]), `${name} changed between installs`);
  }
});

// --- --dry-run: prints the rendered role, writes nothing ---

test('install --dry-run renders a role and writes nothing', () => {
  const { target } = sandbox('rp-dry');
  const r = install.dispatch(['vision'], { 'dry-run': true, target, cwd: target });
  assertEqual(r.dryRun, true, 'dry-run result');
  assertEqual(r.host, 'claude', 'default host');
  assertEqual(r.rendered, install.renderRole(path.join(ROLES_DIR, 'vision.md'), {}, 'claude'));
  assertEqual(fs.readdirSync(target).length, 0, 'target untouched — nothing written');
});

test('install --dry-run <role> works as a flag value and respects --opencode', () => {
  const { target } = sandbox('rp-dry2');
  const r = install.dispatch([], { 'dry-run': 'vision', opencode: true, target, cwd: target });
  assertEqual(r.role, 'vision');
  assertEqual(r.host, 'opencode');
  assertEqual(r.rendered, install.renderRole(path.join(ROLES_DIR, 'vision.md'), {}, 'opencode'));
  assertEqual(fs.readdirSync(target).length, 0, 'target untouched');
});

test('install --dry-run rejects an unknown role', () => {
  let failed = false;
  try {
    install.dispatch([], { 'dry-run': 'no-such-role' });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'unknown role must throw');
});

test('CLI: verity install --dry-run vision --raw prints the rendered role', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-rp-cli-'));
  const out = execFileSync('node', [CLI, 'install', '--dry-run', 'vision', '--raw'], {
    encoding: 'utf8',
    cwd,
  });
  assert(out.includes(RUNTIME_PREAMBLE), 'rendered output includes the runtime preamble');
  assertEqual(fs.readdirSync(cwd).length, 0, 'cwd untouched — dry-run writes nothing');
});
