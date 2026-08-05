// Stage 1 — `verity doctor` host-dependency preflight, driven by a fake-PATH
// fixture dir of stub executables (no real git/gh/claude is ever consulted:
// the CLI child runs with PATH = the fixture dir, nothing else).
//
// Covers: healthy machine (all rows ok, exit 0), absent binary, too-old
// binary (min from package.json verity.claudeCodeMinVersion), gh auth-check
// failure, optional-dependency absence (ok:true — ADR-0001 graceful absence),
// `--quiet` exit-code-only mode, and the shared checkBinary() probe that
// agent-exec delegates to (regression: agent-exec's own suite stays green).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentExec = require('../verity/bin/lib/agent-exec.cjs');
// Stage 12: the feature matrix the codex too-old diagnosis is derived from.
const codexFeatures = require('../verity/bin/lib/agents/codex-features.cjs');
const doctor = require('../verity/bin/lib/doctor.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const MIN_CLAUDE = agentExec.MIN_CLAUDE_VERSION;

// Fixture: a temp bin dir that becomes the child's ENTIRE PATH, plus a temp
// HOME (stage 9: doctor reads install state / skills under $HOME, so the
// child must never see the developer's real home). Stubs are /bin/sh scripts
// (absolute-path shebang, so an empty-but-for-us PATH works).
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const stub = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  return { dir, bin, home, stub };
}

const GIT_OK = 'echo "git version 2.43.0"';
const GH_OK = `case "$1" in
  --version) echo "gh version 2.40.1 (2023-12-13)";;
  auth) echo "Logged in to github.com account someone";;
esac
exit 0`;
const GH_AUTH_FAIL = `case "$1" in
  --version) echo "gh version 2.40.1 (2023-12-13)"; exit 0;;
  auth) echo "You are not logged into any GitHub hosts." >&2; exit 1;;
esac
exit 0`;
const CLAUDE_OK = `echo "${MIN_CLAUDE} (Claude Code)"`;
const CLAUDE_OLD = 'echo "1.0.0 (Claude Code)"';
// The real knowing binary has no --version: `knowing version` prints
// "knowing x.y.z (commit: …)"; `knowing stats` exits 0 when the store opens.
const KNOWING_OK = `case "$1" in
  version) echo "knowing 0.15.1 (commit: e37ffd0, built: 2026-06-10)";;
  stats) echo "knowing stats";;
esac
exit 0`;
const KNOWING_STATS_FAIL = `case "$1" in
  version) echo "knowing 0.15.1 (commit: e37ffd0, built: 2026-06-10)"; exit 0;;
  stats) echo "cannot open store" >&2; exit 1;;
esac
exit 0`;
const KNOWING_OLD = `case "$1" in
  version) echo "knowing 0.1.0";;
esac
exit 0`;

// "Healthy machine" deliberately has NO knowing stub: knowing is optional and
// a healthy machine does not need it (ADR-0001 graceful absence).
function healthy(fx) {
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('claude', CLAUDE_OK);
}

function run(fx, args = [], env = {}) {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fx.bin,
      HOME: fx.home,
      // Never let the developer's real claude config leak into the child —
      // the install-state precedence source must be exactly the fixture's.
      CLAUDE_CONFIG_DIR: path.join(fx.home, '.claude'),
      ...env,
    },
  };
  // spawnSync (not execFileSync) so the stage-9 runtime-selection line on
  // stderr is captured on SUCCESSFUL runs too, not passed through.
  const res = spawnSync(process.execPath, [CLI, 'doctor', ...args], opts);
  return { out: res.stdout || '', stderr: res.stderr || '', code: res.status };
}

function rowsByName(out) {
  const checks = JSON.parse(out);
  assert(Array.isArray(checks), 'doctor emits a JSON array of checks');
  const byName = {};
  for (const row of checks) {
    byName[row.name] = row;
  }
  return { checks, byName };
}

// --- healthy machine ---

test('doctor: healthy machine — every registered dep ok, exit 0', () => {
  const fx = fixture();
  healthy(fx);
  const { out, code } = run(fx);
  assertEqual(code, 0, 'all-ok exits 0');
  const { checks, byName } = rowsByName(out);
  assertEqual(checks.length, 4, 'one row per registered dependency (incl. optional knowing)');
  for (const name of ['git', 'gh', 'claude']) {
    const row = byName[name];
    assert(row, `${name} row present`);
    assertEqual(row.present, true, `${name} present`);
    assertEqual(row.ok, true, `${name} ok`);
    assert(typeof row.detail === 'string' && row.detail.length > 0, `${name} has a detail`);
  }
  assertEqual(byName.git.version, '2.43.0');
  assertEqual(byName.gh.version, '2.40.1');
  assertEqual(byName.claude.version, MIN_CLAUDE);
  assert(byName.gh.detail.includes('gh auth status'), 'gh detail names the auth probe');
  assertEqual(byName.knowing.ok, true, 'absent optional knowing never fails the report');
  assertEqual(byName.knowing.present, false);
  assertEqual(byName.knowing.optional, true);
});

test('doctor: report rows carry exactly the contract fields', () => {
  const fx = fixture();
  healthy(fx);
  const { out } = run(fx);
  const { checks } = rowsByName(out);
  for (const row of checks) {
    const expected = row.optional
      ? '["name","present","version","ok","detail","optional"]'
      : '["name","present","version","ok","detail"]';
    assertEqual(
      JSON.stringify(Object.keys(row)),
      expected,
      `${row.name}: {name, present, version, ok, detail}${row.optional ? ' + optional' : ''}`,
    );
  }
  assertEqual(
    checks.filter((r) => r.optional).length,
    1,
    'exactly one optional row (knowing) in the registry',
  );
});

// --- degradation (informative, never fatal) ---

test('doctor: absent required binary — present:false, ok:false, others still reported', () => {
  const fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK); // no claude stub → not on the fake PATH
  const { out, code } = run(fx);
  assertEqual(code, 1, 'a failing check exits 1');
  const { checks, byName } = rowsByName(out);
  assertEqual(checks.length, 4, 'a broken dep never hides the others');
  assertEqual(byName.claude.present, false);
  assertEqual(byName.claude.ok, false);
  assertEqual(byName.claude.version, null);
  assert(byName.claude.detail.includes('not runnable'), 'detail says why');
  assertEqual(byName.git.ok, true, 'git still reported ok');
  assertEqual(byName.gh.ok, true, 'gh still reported ok');
});

test('doctor: claude below verity.claudeCodeMinVersion — ok:false, detail names the pin', () => {
  const fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('claude', CLAUDE_OLD);
  const { out, code } = run(fx);
  assertEqual(code, 1);
  const { byName } = rowsByName(out);
  assertEqual(byName.claude.present, true, 'too-old is present:true');
  assertEqual(byName.claude.version, '1.0.0');
  assertEqual(byName.claude.ok, false);
  assert(byName.claude.detail.includes(MIN_CLAUDE), 'detail names the configured minimum');
  assert(byName.claude.detail.includes('claudeCodeMinVersion'), 'detail names the pin key');
});

test('doctor: gh present but auth check fails — ok:false with the auth error', () => {
  const fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_AUTH_FAIL);
  fx.stub('claude', CLAUDE_OK);
  const { out, code } = run(fx);
  assertEqual(code, 1);
  const { byName } = rowsByName(out);
  assertEqual(byName.gh.present, true, 'auth failure is present:true');
  assertEqual(byName.gh.version, '2.40.1', 'version still parsed');
  assertEqual(byName.gh.ok, false);
  assert(byName.gh.detail.includes('gh auth status'), 'detail names the failing probe');
  assert(byName.gh.detail.includes('not logged in'), 'detail carries the stderr line');
});

test('doctor: unparsable version output — present:true, ok:false', () => {
  const fx = fixture();
  fx.stub('git', 'echo "no numbers here"');
  fx.stub('gh', GH_OK);
  fx.stub('claude', CLAUDE_OK);
  const { out, code } = run(fx);
  assertEqual(code, 1);
  const { byName } = rowsByName(out);
  assertEqual(byName.git.present, true);
  assertEqual(byName.git.version, null);
  assertEqual(byName.git.ok, false);
  assert(byName.git.detail.includes('could not parse'), 'detail says why');
});

// --- --quiet (exit-code-only) ---

test('doctor: --quiet on a healthy machine — no stdout, exit 0', () => {
  const fx = fixture();
  healthy(fx);
  const { out, code } = run(fx, ['--quiet']);
  assertEqual(code, 0);
  assertEqual(out, '', '--quiet emits nothing on stdout');
});

test('doctor: --quiet with a failing check — no stdout, exit 1', () => {
  const fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_AUTH_FAIL);
  fx.stub('claude', CLAUDE_OLD);
  const { out, code } = run(fx, ['--quiet']);
  assertEqual(code, 1);
  assertEqual(out, '', '--quiet emits nothing on stdout');
});

test('doctor: positional arguments are a usage error', () => {
  const fx = fixture();
  healthy(fx);
  const { stderr, code } = run(fx, ['git']);
  assertEqual(code, 1);
  assert(stderr.includes('no positional arguments'), 'error explains usage');
});

// --- optional-dependency semantics (ADR-0001 graceful absence) ---

test('doctor: knowing present and healthy — version via `knowing version`, stats probe ok', () => {
  const fx = fixture();
  healthy(fx);
  fx.stub('knowing', KNOWING_OK);
  const { out, code } = run(fx);
  assertEqual(code, 0);
  const { byName } = rowsByName(out);
  assertEqual(byName.knowing.present, true);
  assertEqual(byName.knowing.version, '0.15.1');
  assertEqual(byName.knowing.ok, true);
  assertEqual(byName.knowing.optional, true);
  assert(byName.knowing.detail.includes('knowing stats'), 'detail names the health probe');
});

test('doctor: knowing present but store probe fails — broken install is NOT graceful absence', () => {
  const fx = fixture();
  healthy(fx);
  fx.stub('knowing', KNOWING_STATS_FAIL);
  const { out, code } = run(fx);
  assertEqual(code, 1, 'a broken optional dep fails the report');
  const { byName } = rowsByName(out);
  assertEqual(byName.knowing.present, true);
  assertEqual(byName.knowing.version, '0.15.1');
  assertEqual(byName.knowing.ok, false);
  assert(byName.knowing.detail.includes('knowing stats'), 'detail names the failing probe');
  assert(byName.knowing.detail.includes('cannot open store'), 'detail carries the stderr line');
});

test('doctor: knowing below verity.knowingMinVersion — ok:false, detail names the pin', () => {
  const fx = fixture();
  healthy(fx);
  fx.stub('knowing', KNOWING_OLD);
  const { out, code } = run(fx);
  assertEqual(code, 1);
  const { byName } = rowsByName(out);
  assertEqual(byName.knowing.present, true);
  assertEqual(byName.knowing.version, '0.1.0');
  assertEqual(byName.knowing.ok, false);
  assert(byName.knowing.detail.includes('knowingMinVersion'), 'detail names the pin key');
});

test('doctor: absent optional dep reports {ok:true, present:false, optional:true}', () => {
  const row = doctor.checkDependency({
    name: 'knowing',
    binary: 'verity-doctor-test-no-such-binary',
    versionArgs: ['--version'],
    optional: true,
  });
  assertEqual(row.ok, true, 'absence of an optional dep is never a failure');
  assertEqual(row.present, false);
  assertEqual(row.optional, true);
  assertEqual(row.version, null);
  assert(row.detail.includes('optional'), 'detail says it was skipped as optional');
});

test('doctor: present-but-too-old optional dep still fails (broken ≠ absent)', () => {
  const exec = () => ({ status: 0, stdout: 'knowing 0.1.0\n', stderr: '' });
  const row = doctor.checkDependency(
    {
      name: 'knowing',
      binary: 'knowing',
      versionArgs: ['--version'],
      minVersionKey: 'knowingMinVersion',
      optional: true,
    },
    { exec, pkg: { verity: { knowingMinVersion: '0.2.0' } } },
  );
  assertEqual(row.ok, false, 'a broken optional install is not graceful absence');
  assertEqual(row.present, true);
  assertEqual(row.optional, true);
  assertEqual(row.version, '0.1.0');
});

// --- shared probe (unit-level, injectable exec — what agent-exec delegates to) ---

test('checkBinary: missing / unparsable / too-old / ok via injected exec', () => {
  const missing = doctor.checkBinary('claude', { exec: () => ({ error: { code: 'ENOENT' } }) });
  assertEqual(missing.present, false);
  assertEqual(missing.why, 'missing');
  assertEqual(missing.output, 'ENOENT');

  const unparsable = doctor.checkBinary('claude', {
    exec: () => ({ status: 0, stdout: 'no version here\n' }),
  });
  assertEqual(unparsable.present, true);
  assertEqual(unparsable.why, 'unparsable');
  assertEqual(unparsable.version, null);

  const old = doctor.checkBinary('claude', {
    exec: () => ({ status: 0, stdout: '2.0.9 (Claude Code)\n' }),
    minVersion: '2.1.170',
  });
  assertEqual(old.why, 'too-old');
  assertEqual(old.version, '2.0.9');
  assertEqual(old.ok, false);

  const ok = doctor.checkBinary('claude', {
    exec: () => ({ status: 0, stdout: '2.1.170 (Claude Code)\n' }),
    minVersion: '2.1.170',
  });
  assertEqual(ok.ok, true);
  assertEqual(ok.version, '2.1.170');
  assertEqual(ok.why, null);
});

// Stage 12: the pin only works if the probe can read what the binary actually
// prints. The REAL `codex --version` output carries a `codex-cli ` PREFIX
// (spike header: `codex-cli 0.146.0`) — if parseVersion tripped on it, every
// codex version check would misreport and the pin would bind nothing at all.
// Pinned here with the observed string, byte for byte.
test('checkBinary/parseVersion: the REAL `codex --version` form (`codex-cli 0.146.0`)', () => {
  assertEqual(
    JSON.stringify(doctor.parseVersion('codex-cli 0.146.0')),
    '[0,146,0]',
    'the codex-cli prefix does not shift the parse',
  );
  const codexExec = (out) => () => ({ status: 0, stdout: out });

  const at = doctor.checkBinary('codex', {
    exec: codexExec('codex-cli 0.146.0\n'),
    minVersion: '0.146.0',
  });
  assertEqual(at.version, '0.146.0', 'version extracted from the prefixed line');
  assertEqual(at.ok, true, 'exactly the pin passes');
  assertEqual(at.why, null);
  assertEqual(at.output, 'codex-cli 0.146.0', 'the raw first line is reported verbatim');

  const below = doctor.checkBinary('codex', {
    exec: codexExec('codex-cli 0.145.9\n'),
    minVersion: '0.146.0',
  });
  assertEqual(below.why, 'too-old', 'a lower version is caught, not silently accepted');
  assertEqual(below.version, '0.145.9');

  const above = doctor.checkBinary('codex', {
    exec: codexExec('codex-cli 1.0.0\n'),
    minVersion: '0.146.0',
  });
  assertEqual(above.ok, true, 'newer passes');
  // The comparison is numeric, not lexical: '0.42.0' > '0.146.0' as strings,
  // and reading it that way is exactly how a bad pin would pass unnoticed.
  const legacy = doctor.checkBinary('codex', {
    exec: codexExec('codex-cli 0.42.0\n'),
    minVersion: '0.146.0',
  });
  assertEqual(legacy.why, 'too-old', '0.42.0 < 0.146.0 — compared as numbers, never as strings');
});

test('checkBinary is the single shared probe: agent-exec re-exports its parse helpers', () => {
  assertEqual(agentExec.parseVersion, doctor.parseVersion, 'one parseVersion');
  assertEqual(agentExec.compareVersions, doctor.compareVersions, 'one compareVersions');
});

test('exitCodeFor: 0 iff every check ok', () => {
  assertEqual(doctor.exitCodeFor([{ ok: true }, { ok: true }]), 0);
  assertEqual(doctor.exitCodeFor([{ ok: true }, { ok: false }]), 1);
  assertEqual(doctor.exitCodeFor([]), 0, 'empty registry is vacuously healthy');
});

// --- stage 9: agent-aware doctor (`--agent claude|codex`) ----------------------

const MIN_CODEX = require('../package.json').verity.codexMinVersion;
const ROLE_COUNT = fs
  .readdirSync(path.join(__dirname, '..', 'commands', 'verity'))
  .filter((n) => n.endsWith('.md')).length;

const CODEX_OK = `case "$1" in
  --version) echo "codex-cli ${MIN_CODEX}";;
  login) echo "Logged in using ChatGPT";;
esac
exit 0`;
const CODEX_OLD = `case "$1" in
  --version) echo "codex-cli 0.1.0";;
  login) echo "Logged in using ChatGPT";;
esac
exit 0`;
const CODEX_UNAUTH = `case "$1" in
  --version) echo "codex-cli ${MIN_CODEX}"; exit 0;;
  login) echo "Not logged in" >&2; exit 1;;
esac
exit 0`;

// Seed what `verity install --codex` would have written under ~/.agents:
// skills (one dir + SKILL.md per role), the engine fallback, install state.
function seedCodexInstall(fx, opts = {}) {
  const root = path.join(fx.home, '.agents');
  if (opts.skills !== false) {
    const roles = fs
      .readdirSync(path.join(__dirname, '..', 'commands', 'verity'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3));
    for (const role of roles.slice(0, opts.skillCount ?? roles.length)) {
      const dir = path.join(root, 'skills', `verity-${role}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: verity-${role}\n---\nbody\n`);
    }
  }
  if (opts.engine !== false) {
    fs.mkdirSync(path.join(root, 'verity', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verity', 'bin', 'verity.cjs'), '// engine\n');
  }
  if (opts.state !== false) {
    fs.mkdirSync(path.join(root, 'verity'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'verity', 'install-options.json'),
      `${JSON.stringify({ schema: 1, harness: opts.harness || 'codex', options: {} }, null, 2)}\n`,
    );
  }
}

function healthyCodex(fx) {
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_OK);
  seedCodexInstall(fx);
}

test('doctor --agent codex: a Codex-only machine (no claude anywhere) is green', () => {
  const fx = fixture();
  healthyCodex(fx); // deliberately NO claude stub
  const { out, stderr, code } = run(fx, ['--agent', 'codex']);
  assertEqual(code, 0, `codex-only machine exits 0 (stderr: ${stderr})`);
  const { checks, byName } = rowsByName(out);
  assertEqual(
    JSON.stringify(checks.map((r) => r.name)),
    '["git","gh","codex","codex-skills","codex-engine","codex-install-state"]',
    'selected-runtime rows only — no claude, no knowing',
  );
  for (const row of checks) {
    assertEqual(row.ok, true, `${row.name} ok (${row.detail})`);
  }
  assertEqual(byName.codex.version, MIN_CODEX);
  assert(byName.codex.detail.includes('codex login status'), 'auth probe named');
  assert(
    byName['codex-skills'].detail.includes(`${ROLE_COUNT}/${ROLE_COUNT}`),
    'skill count reported',
  );
  assert(stderr.includes("agent runtime 'codex'"), 'selected runtime printed');
  assert(stderr.includes('--agent flag'), 'selection source printed');
});

test('doctor --agent codex: each distinct failure diagnosis carries a remediation command', () => {
  // not installed
  let fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  seedCodexInstall(fx);
  let res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  let { byName } = rowsByName(res.out);
  assertEqual(byName.codex.present, false, 'not installed');
  assert(byName.codex.detail.includes('not runnable'), 'diagnosis: not installed');
  assert(byName.codex.detail.includes('Run: npm install -g @openai/codex'), 'remediation');

  // too old
  fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_OLD);
  seedCodexInstall(fx);
  res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  byName = rowsByName(res.out).byName;
  assertEqual(byName.codex.present, true, 'too-old is present:true');
  assertEqual(byName.codex.version, '0.1.0');
  assert(byName.codex.detail.includes(MIN_CODEX), 'diagnosis names the pin');
  assert(byName.codex.detail.includes('codexMinVersion'), 'names the pin key');
  assert(byName.codex.detail.includes('Run: npm install -g @openai/codex@latest'), 'remediation');

  // unauthenticated
  fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_UNAUTH);
  seedCodexInstall(fx);
  res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  byName = rowsByName(res.out).byName;
  assert(byName.codex.detail.includes('codex login status'), 'diagnosis: unauthenticated');
  assert(byName.codex.detail.includes('Run: codex login'), 'remediation');

  // skills missing (authenticated, engine + state fine)
  fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_OK);
  seedCodexInstall(fx, { skills: false });
  res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  byName = rowsByName(res.out).byName;
  assertEqual(byName['codex-skills'].ok, false);
  assert(byName['codex-skills'].detail.includes('skills missing'), 'diagnosis: skills missing');
  assert(byName['codex-skills'].detail.includes('Run: verity install --codex'), 'remediation');
  assertEqual(byName['codex-engine'].ok, true, 'engine row independent of skills');

  // partial skills are still a failure (7 of N is not a working install)
  fx = fixture();
  healthyCodex(fx);
  fs.rmSync(path.join(fx.home, '.agents', 'skills', 'verity-build'), { recursive: true });
  res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1, 'partial skill set fails');
  byName = rowsByName(res.out).byName;
  assert(byName['codex-skills'].detail.includes(`${ROLE_COUNT - 1}/${ROLE_COUNT}`), 'count named');

  // engine missing (skills discovered but internals gone)
  fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_OK);
  seedCodexInstall(fx, { engine: false });
  res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  byName = rowsByName(res.out).byName;
  assertEqual(byName['codex-skills'].ok, true, 'skills row independent of engine');
  assertEqual(byName['codex-engine'].ok, false);
  assert(byName['codex-engine'].detail.includes('engine internals missing'), 'diagnosis');
  assert(byName['codex-engine'].detail.includes('Run: verity install --codex'), 'remediation');

  // stale install state (harness mismatch)
  fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_OK);
  seedCodexInstall(fx, { harness: 'claude' });
  res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  byName = rowsByName(res.out).byName;
  assertEqual(byName['codex-install-state'].ok, false);
  assert(byName['codex-install-state'].detail.includes('stale install state'), 'diagnosis: stale');
  assert(byName['codex-install-state'].detail.includes("'claude'"), 'names the found harness');
  assert(
    byName['codex-install-state'].detail.includes('Run: verity install --codex'),
    'remediation',
  );
});

// Stage 12: the too-old row is the one place an operator is told to upgrade, so
// it is the one place the REASON has to appear. "codex 0.1.0 is below 0.146.0"
// with no feature named is exactly the unauditable claim the historical 0.42.0
// pin got away with for three stages.
test('doctor --agent codex: the too-old diagnosis NAMES the feature motivating the pin', () => {
  const fx = fixture();
  fx.stub('git', GIT_OK);
  fx.stub('gh', GH_OK);
  fx.stub('codex', CODEX_OLD);
  seedCodexInstall(fx);
  const res = run(fx, ['--agent', 'codex']);
  assertEqual(res.code, 1);
  const detail = rowsByName(res.out).byName.codex.detail;
  const motivating = codexFeatures.motivatingFeatures();
  assert(motivating.length > 0, 'at least one feature justifies the pin');
  for (const feature of motivating) {
    assert(detail.includes(feature), `too-old detail must name '${feature}' (got: ${detail})`);
  }
  assert(detail.includes(codexFeatures.SPIKE_DOC), 'and point at the real-CLI evidence');
  // The stage-9 shape is EXTENDED, not rewritten: pin, key and remedy all stay.
  assert(detail.includes(MIN_CODEX), 'still names the pin');
  assert(detail.includes('codexMinVersion'), 'still names the pin key');
  assert(detail.includes('Run: npm install -g @openai/codex@latest'), 'still names the remedy');
  // …and rows WITHOUT a motivation are byte-identical to their stage-1 output.
  const claudeRow = doctor.checkDependency(
    { name: 'claude', binary: 'claude', minVersionKey: 'claudeCodeMinVersion' },
    { exec: () => ({ status: 0, stdout: '1.0.0 (Claude Code)\n' }) },
  );
  assertEqual(
    claudeRow.detail,
    'claude 1.0.0 is below the configured minimum 2.1.170 (package.json verity.claudeCodeMinVersion)',
    'a row with no minVersionMotivation is unchanged',
  );
});

test('doctor precedence 1: the --agent flag wins over a codex policy file', () => {
  const fx = fixture();
  healthy(fx); // claude-healthy machine
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-proj-'));
  fs.mkdirSync(path.join(project, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(project, '.verity', 'autonomy.yml'), 'agent:\n  provider: codex\n');
  const { out, stderr, code } = run(fx, ['--agent', 'claude', '--cwd', project]);
  assertEqual(code, 0);
  const { byName } = rowsByName(out);
  assert(byName.claude !== undefined, 'claude registry selected');
  assert(byName.codex === undefined, 'no codex rows');
  assert(stderr.includes("agent runtime 'claude'"), 'runtime printed');
  assert(stderr.includes('--agent flag'), 'source is the flag, not the policy');
});

test('doctor precedence 2: .verity/autonomy.yml agent.provider selects codex', () => {
  const fx = fixture();
  healthyCodex(fx);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-proj-'));
  fs.mkdirSync(path.join(project, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(project, '.verity', 'autonomy.yml'), 'agent:\n  provider: codex\n');
  const { out, stderr, code } = run(fx, ['--cwd', project]);
  assertEqual(code, 0, 'codex-healthy fixture is green');
  assert(rowsByName(out).byName.codex !== undefined, 'codex registry selected');
  assert(stderr.includes("agent runtime 'codex'"), 'runtime printed');
  assert(stderr.includes('.verity/autonomy.yml agent.provider'), 'source is the policy file');
});

test('doctor precedence 3: install-state harness selects codex when nothing else does', () => {
  const fx = fixture();
  healthyCodex(fx); // includes the ~/.agents install state with harness codex
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-proj-'));
  const { out, stderr, code } = run(fx, ['--cwd', project]); // no flag, no policy
  assertEqual(code, 0);
  assert(rowsByName(out).byName.codex !== undefined, 'codex registry selected');
  assert(stderr.includes("agent runtime 'codex'"), 'runtime printed');
  assert(stderr.includes('install state'), 'source is the install state');
  assert(stderr.includes('install-options.json'), 'names the state file');
});

test('doctor precedence 4: no flag, no policy, no install state → legacy claude default', () => {
  const fx = fixture();
  healthy(fx);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-proj-'));
  const { out, stderr, code } = run(fx, ['--cwd', project]);
  assertEqual(code, 0);
  const { checks, byName } = rowsByName(out);
  assertEqual(checks.length, 4, 'the untouched stage-1 registry (incl. optional knowing)');
  assert(byName.claude !== undefined, 'claude registry');
  assert(stderr.includes("agent runtime 'claude'"), 'runtime printed');
  assert(stderr.includes('legacy default'), 'source is the legacy default');
});

test('doctor: ambiguous install states (claude AND codex) fall back to the claude default', () => {
  const fx = fixture();
  healthy(fx);
  seedCodexInstall(fx); // ~/.agents says codex...
  const claudeState = path.join(fx.home, '.claude', 'verity');
  fs.mkdirSync(claudeState, { recursive: true });
  fs.writeFileSync(
    path.join(claudeState, 'install-options.json'),
    `${JSON.stringify({ schema: 1, harness: 'claude', options: {} })}\n`,
  ); // ...and ~/.claude says claude
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-doctor-proj-'));
  const { stderr, code } = run(fx, ['--cwd', project]);
  assertEqual(code, 0);
  assert(stderr.includes("agent runtime 'claude'"), 'ambiguity never guesses codex');
  assert(stderr.includes('legacy default'), 'falls through to the default');
});

test('doctor: invalid --agent value is a usage error naming the valid runtimes', () => {
  const fx = fixture();
  healthy(fx);
  const { stderr, code } = run(fx, ['--agent', 'gemini']);
  assertEqual(code, 1);
  assert(stderr.includes('claude|codex'), 'names the valid providers');
});

test('doctor: --quiet --agent codex stays exit-code-only (stdout empty)', () => {
  const fx = fixture();
  healthyCodex(fx);
  const ok = run(fx, ['--quiet', '--agent', 'codex']);
  assertEqual(ok.code, 0);
  assertEqual(ok.out, '', 'nothing on stdout');
  const broken = fixture();
  broken.stub('git', GIT_OK);
  broken.stub('gh', GH_OK); // no codex binary
  const bad = run(broken, ['--quiet', '--agent', 'codex']);
  assertEqual(bad.code, 1);
  assertEqual(bad.out, '', 'nothing on stdout even when failing');
});
