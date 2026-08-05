// Stage 41 (#107 Phase 1) — `verity promotion verify`: prove a projection is a
// working product, not just a filtered tree. Offline by default: every gate
// scenario runs against a tiny fixture package (own package.json + vendored
// lockfile + trivial test) so npm ci/lint/test/pack never touch the network.
// The baseline byte-match is the ONE network path and follows the house opt-in
// lane pattern (tests/real-codex.test.cjs): it registers a real case only under
// VERITY_PROMOTION_BASELINE_TEST=1 and is printed as SKIPPED — never counted as
// a pass — when the gate is off.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promotion = require('../verity/bin/lib/promotion.cjs');
const classification = require('../verity/bin/lib/classification.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'verity', 'bin', 'verity.cjs');
const CLASSIFICATION_PATH = '.verity/production-content-classification.yml';
const GATE = promotion.BASELINE_GATE;
const ENABLED = process.env[GATE] === '1';

// --- fixture helpers ---------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-verif-${tag}-`));
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function makeRepo(files) {
  const dir = tmp('repo');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeTree(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function rm(p) {
  if (p) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// A minimal valid lockfile for a zero-dependency package: npm ci accepts it
// without touching the registry, which keeps the install gate offline.
function lockfileFor(name) {
  return `${JSON.stringify(
    {
      name,
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name, version: '1.0.0' } },
    },
    null,
    2,
  )}\n`;
}

// A tiny self-contained package: its OWN lint/test scripts (no devDeps), a
// trivial passing test, and an npm files allowlist of exactly index.js.
function fixturePkg(overrides = {}) {
  const name = 'verity-verify-fixture';
  return {
    'package.json': `${JSON.stringify(
      {
        name,
        version: '1.0.0',
        license: 'MIT',
        files: overrides.files || ['index.js'],
        scripts: {
          lint: 'node -e "process.exit(0)"',
          test: 'node test.js',
        },
      },
      null,
      2,
    )}\n`,
    'package-lock.json': lockfileFor(name),
    'index.js': 'module.exports = 41;\n',
    'test.js': overrides.failingTest
      ? 'console.error("fixture test failing on purpose"); process.exit(1);\n'
      : 'if (require("./index.js") !== 41) { process.exit(1); }\n',
    ...(overrides.extraFiles || {}),
  };
}

function makeStaging(overrides) {
  const dir = tmp('staging');
  writeTree(dir, fixturePkg(overrides));
  return dir;
}

// One shared classification-authority repo for every verify call: verify reads
// the classification at the repo's HEAD (same authority as project). The rule
// set marks private-doc.md private so a smuggled tarball entry is detectable.
const AUTHORITY_RULES = [
  'schema_version: 1',
  'rules:',
  '  - pattern: "private-doc.md"',
  '    bucket: private',
  '    reason: "test"',
  '  - pattern: ".verity/**"',
  '    bucket: private',
  '    reason: "test"',
  '',
].join('\n');
const authorityRepo = makeRepo({ [CLASSIFICATION_PATH]: AUTHORITY_RULES });

// --- happy path: a good staging tree passes every offline gate ---------------

test('verify passes on a good staging tree: all gates ok, exit 0, verdict passed', () => {
  const dir = makeStaging();
  const r = promotion.verify(dir, { cwd: authorityRepo });
  assertEqual(r.exit_code, 0, `exit code (verify block: ${JSON.stringify(r.verify)})`);
  assertEqual(r.verify.verdict, 'passed', 'verdict');
  for (const gate of ['install', 'lint', 'test', 'pack']) {
    assertEqual(r.verify.gates[gate].ok, true, `${gate} gate ok`);
  }
  assertEqual(r.verify.gates.install.command, 'npm ci', 'install used the projected lockfile');
  assert(!r.verify.gates.install.downgraded, 'no downgrade on a tree with a lockfile');
  assert(/^[0-9a-f]{40}$/.test(r.verify.pack_shasum), 'pack_shasum is a sha1');
  assertEqual(r.verify.baseline, null, 'no baseline requested → baseline null');
  // Report written to the default path with the verify block.
  const onDisk = JSON.parse(fs.readFileSync(`${dir}.report.json`, 'utf8'));
  assertEqual(onDisk.verify.verdict, 'passed', 'verify block persisted');
  rm(dir);
  rm(`${dir}.report.json`);
});

// --- additive on the projection report: project fields untouched -------------

test('verify extends the projection report additively — project fields byte-identical', () => {
  // A fixture repo whose PUBLIC bucket is exactly the package: project it, then
  // verify the resulting staging tree against the same report file.
  const repo = makeRepo({
    ...fixturePkg(),
    'private-doc.md': 'dev only\n',
    [CLASSIFICATION_PATH]: [
      'schema_version: 1',
      'rules:',
      '  - pattern: "package.json"',
      '    bucket: public',
      '    reason: "test"',
      '  - pattern: "package-lock.json"',
      '    bucket: public',
      '    reason: "test"',
      '  - pattern: "index.js"',
      '    bucket: public',
      '    reason: "test"',
      '  - pattern: "test.js"',
      '    bucket: public',
      '    reason: "test"',
      '  - pattern: "private-doc.md"',
      '    bucket: private',
      '    reason: "test"',
      '  - pattern: ".verity/**"',
      '    bucket: private',
      '    reason: "test"',
      '',
    ].join('\n'),
  });
  const projected = promotion.project('HEAD', { cwd: repo });
  assertEqual(projected.verdict, 'built', 'projection built');
  const before = JSON.parse(fs.readFileSync(projected.report_path, 'utf8'));

  const r = promotion.verify(projected.staging_dir, {
    cwd: repo,
    report: projected.report_path,
  });
  assertEqual(r.exit_code, 0, `verify exit (verify block: ${JSON.stringify(r.verify)})`);
  const after = JSON.parse(fs.readFileSync(projected.report_path, 'utf8'));
  for (const key of Object.keys(before)) {
    assertEqual(
      JSON.stringify(after[key]),
      JSON.stringify(before[key]),
      `project-owned report field '${key}' untouched by verify`,
    );
  }
  assertEqual(after.verify.verdict, 'passed', 'verify block added');
  rm(projected.staging_dir);
  rm(projected.report_path);
});

// --- gate failure: a failing staged test names the gate, exit 20 -------------

test('a failing staged test → exit 20, test gate named, later gates not run', () => {
  const dir = makeStaging({ failingTest: true });
  const r = promotion.verify(dir, { cwd: authorityRepo });
  assertEqual(r.exit_code, 20, 'gate failure exit');
  assertEqual(r.verify.verdict, 'failed', 'verdict');
  assertEqual(r.verify.gates.install.ok, true, 'install passed first');
  assertEqual(r.verify.gates.lint.ok, true, 'lint passed');
  assertEqual(r.verify.gates.test.ok, false, 'the test gate is the failure');
  assertEqual(r.verify.gates.pack, null, 'pack not run after the failure');
  assert(/test gate failed/.test(r.raw), 'raw names the failing gate');
  rm(dir);
  rm(`${dir}.report.json`);
});

// --- pack-content inspection: a private-classified path in the tarball -------

test('a private-classified path riding in the tarball → pack-content failure, exit 20', () => {
  const dir = makeStaging({
    files: ['index.js', 'private-doc.md'],
    extraFiles: { 'private-doc.md': 'smuggled dev-only content\n' },
  });
  const r = promotion.verify(dir, { cwd: authorityRepo });
  assertEqual(r.exit_code, 20, 'pack-content failure exit');
  assertEqual(r.verify.gates.pack.ok, false, 'pack gate failed');
  assert(
    /private-doc\.md/.test(r.verify.gates.pack.summary) &&
      /private/.test(r.verify.gates.pack.summary),
    `the private entry is named: ${r.verify.gates.pack.summary}`,
  );
  rm(dir);
  rm(`${dir}.report.json`);
});

test('inspectPack: a tarball entry absent from the staging tree is a problem', () => {
  const dir = makeStaging();
  const ghostRoot = tmp('ghost');
  writeTree(ghostRoot, { 'package/ghost.txt': 'not in staging\n' });
  const tarball = path.join(ghostRoot, 'ghost.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', ghostRoot, 'package']);
  const { matchers } = classification.compile(classification.parseClassification(AUTHORITY_RULES));
  const inspection = promotion.inspectPack(tarball, dir, matchers);
  const problem = inspection.problems.find((p) => p.path === 'ghost.txt');
  assert(problem && /missing from staging tree/.test(problem.reason), 'ghost entry flagged');
  rm(dir);
  rm(ghostRoot);
});

// --- baseline comparator: pure bytes, no network -----------------------------

test('compareTarballs: identical bytes match; a single differing byte does not', () => {
  const dir = tmp('cmp');
  const bytes = Buffer.from('verity fixture tarball bytes for the comparator');
  const a = path.join(dir, 'a.tgz');
  const b = path.join(dir, 'b.tgz');
  const c = path.join(dir, 'c.tgz');
  fs.writeFileSync(a, bytes);
  fs.writeFileSync(b, bytes);
  const mutated = Buffer.from(bytes);
  mutated[0] ^= 0xff;
  fs.writeFileSync(c, mutated);
  const same = promotion.compareTarballs(a, b);
  assertEqual(same.match, true, 'identical tarballs match');
  assertEqual(same.local_shasum, same.fetched_shasum, 'shasums equal');
  const diff = promotion.compareTarballs(a, c);
  assertEqual(diff.match, false, 'one differing byte breaks the match');
  assert(/^[0-9a-f]{40}$/.test(diff.local_shasum), 'sha1 hex shape');
  rm(dir);
});

// --- structural downgrade: no lockfile → npm install, reported explicitly ----

test('missing lockfile → explicit npm install downgrade recorded in the report', () => {
  const dir = makeStaging();
  fs.rmSync(path.join(dir, 'package-lock.json'));
  const r = promotion.verify(dir, { cwd: authorityRepo });
  assertEqual(r.exit_code, 0, `exit (verify block: ${JSON.stringify(r.verify)})`);
  assertEqual(r.verify.gates.install.ok, true, 'install gate still passes');
  assertEqual(r.verify.gates.install.downgraded, true, 'downgrade is flagged');
  assertEqual(r.verify.gates.install.command, 'npm install', 'downgraded command recorded');
  assert(
    /package-lock\.json missing/.test(r.verify.gates.install.reason),
    'the structural reason is stated',
  );
  rm(dir);
  rm(`${dir}.report.json`);
});

// --- infra: a missing staging dir is exit 30, not a gate verdict -------------

test('a missing staging dir is an infra failure (exit 30)', () => {
  const r = promotion.verify(path.join(os.tmpdir(), 'verity-no-such-staging-dir'), {
    cwd: authorityRepo,
  });
  assertEqual(r.exit_code, 30, 'infra exit');
  assertEqual(r.verify.verdict, 'failed', 'verdict failed');
});

// --- the loud skip: baseline without the env gate ----------------------------

test('CLI: --baseline without the env gate SKIPS LOUDLY; exit reflects offline gates', () => {
  const dir = makeStaging();
  const env = { ...process.env };
  delete env[GATE];
  const r = spawnSync(
    'node',
    [CLI, 'promotion', 'verify', dir, '--cwd', authorityRepo, '--baseline', '9.9.9', '--json'],
    { encoding: 'utf8', env },
  );
  assertEqual(r.status, 0, `offline gates pass → exit 0 despite the skip (stderr: ${r.stderr})`);
  const lines = r.stdout.trim().split('\n');
  assertEqual(lines.length, 1, 'exactly one stdout line (pipe-safe --json)');
  const obj = JSON.parse(lines[0]);
  assertEqual(obj.verify.baseline.skipped, true, 'baseline recorded as skipped');
  assert(obj.verify.baseline.reason.includes(GATE), 'the skip reason names the env gate to flip');
  assert(r.stderr.includes('SKIPPED'), 'stderr says SKIPPED, loudly');
  assert(r.stderr.includes(GATE), 'stderr names the env gate');
  assert(!/match(ed|: ?true)/.test(r.stderr), 'a skip is never dressed up as a successful match');
  assert(!('match' in obj.verify.baseline), 'a skipped baseline carries no match field');
  rm(dir);
  rm(`${dir}.report.json`);
});

// --- the opt-in NETWORK lane (house pattern: tests/real-codex.test.cjs) ------
//
// With the gate off this registers NO network case and prints it as SKIPPED —
// skipped says skipped, never counted as a pass. With VERITY_PROMOTION_BASELINE_TEST=1
// it performs the real Phase-1 exit criterion: project v1.1.0 from THIS repo,
// verify the staging tree, and byte-match the packed tarball against the
// published verity-framework@1.1.0 npm artifact.
let registered = 0;

if (ENABLED) {
  registered += 1;
  test('REAL baseline: project v1.1.0 → verify --baseline 1.1.0 byte-matches npm', () => {
    const projected = promotion.project('v1.1.0', { cwd: REPO_ROOT });
    assertEqual(projected.verdict, 'built', 'v1.1.0 projection built');
    const r = promotion.verify(projected.staging_dir, {
      cwd: REPO_ROOT,
      report: projected.report_path,
      baseline: '1.1.0',
    });
    assertEqual(r.exit_code, 0, `verify exit (verify block: ${JSON.stringify(r.verify)})`);
    assertEqual(r.verify.baseline.match, true, 'published tarball byte-match');
    assertEqual(
      r.verify.baseline.local_shasum,
      r.verify.baseline.published_shasum,
      'local pack sha1 equals the registry dist.shasum',
    );
    rm(projected.staging_dir);
    rm(projected.report_path);
  });
} else {
  console.log('  ⊘ SKIPPED: baseline byte-match lane is opt-in (network + real npm registry).');
  console.log(`    Enable with ${GATE}=1.`);
  console.log('  ⊘ SKIPPED: REAL baseline: project v1.1.0 → verify --baseline 1.1.0');
}

test('baseline lane: opt-in only, and skipped-not-passed when the gate is off', () => {
  assertEqual(ENABLED, process.env[GATE] === '1', `the gate is exactly ${GATE}=1`);
  assertEqual(
    registered,
    ENABLED ? 1 : 0,
    ENABLED
      ? 'with the gate on the real baseline case is registered'
      : 'with the gate off NO network case is registered — printed as SKIPPED, never a pass',
  );
});

// fixture cleanup
rm(authorityRepo);
