// Stage 40 (#107 Phase 1) — the fail-closed projection builder against the
// frozen production-projection contract v1. Stub-driven and offline: every
// scenario runs against a tiny fixture git repo built in a tmp dir (git init +
// commits + a tiny classification), plus one real-repo smoke on THIS repo's
// HEAD. Every contract invariant is covered: empty-tree start, public-only
// copy, fail-closed on unclassified/ambiguous/missing/empty classification
// (never copy everything), secret scan without echoing the value, read-only on
// the source repo, and digest determinism.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promotion = require('../verity/bin/lib/promotion.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'verity', 'bin', 'verity.cjs');
const CLASSIFICATION_PATH = '.verity/production-content-classification.yml';

// --- fixture helpers ---------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-prom-${tag}-`));
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function commitTree(dir, files, msg) {
  writeTree(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function makeRepo(files) {
  const dir = tmp('repo');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commitTree(dir, files, 'initial');
  return dir;
}

function rulesYaml(rules) {
  const lines = ['schema_version: 1', 'rules:'];
  for (const r of rules) {
    lines.push(`  - pattern: "${r.pattern}"`, `    bucket: ${r.bucket}`, '    reason: "test"');
  }
  return `${lines.join('\n')}\n`;
}

const BASE_RULES = [
  { pattern: 'src/**', bucket: 'public' },
  { pattern: 'notes/**', bucket: 'private' },
  { pattern: 'state.json', bucket: 'generated' },
  { pattern: '.verity/**', bucket: 'private' },
];

function baseFiles() {
  return {
    'src/app.js': 'console.log(1);\n',
    'src/lib/util.js': 'module.exports = 1;\n',
    'notes/dev.md': 'dev only\n',
    'state.json': '{"n":1}\n',
    [CLASSIFICATION_PATH]: rulesYaml(BASE_RULES),
  };
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function rm(p) {
  if (p) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// --- invariant 2: public-only copy; private/generated counted, not copied ----

const happyRepo = makeRepo(baseFiles());
const happy = promotion.project('HEAD', { cwd: happyRepo });

test('public-only copy: exactly the public-classified paths are materialized', () => {
  assertEqual(happy.verdict, 'built', 'verdict');
  assertEqual(happy.exit_code, 0, 'exit code');
  assertEqual(happy.files_projected, 2, 'files_projected');
  assertEqual(
    listFiles(happy.staging_dir).join(','),
    'src/app.js,src/lib/util.js',
    'staged tree is the public bucket and nothing else',
  );
  assertEqual(
    fs.readFileSync(path.join(happy.staging_dir, 'src/app.js'), 'utf8'),
    'console.log(1);\n',
    'staged content matches the source blob',
  );
});

test('private and generated paths are omitted and counted, never copied', () => {
  assertEqual(happy.files_omitted.private, 2, 'notes/dev.md + the classification file');
  assertEqual(happy.files_omitted.generated, 1, 'state.json');
  assert(!fs.existsSync(path.join(happy.staging_dir, 'notes')), 'private not staged');
  assert(!fs.existsSync(path.join(happy.staging_dir, 'state.json')), 'generated not staged');
});

test('projection report file matches the contract schema (schema 1, built)', () => {
  const onDisk = JSON.parse(fs.readFileSync(happy.report_path, 'utf8'));
  assertEqual(onDisk.schema, 1, 'schema');
  assertEqual(onDisk.source_ref, 'HEAD', 'source_ref');
  assertEqual(onDisk.source_commit, git(happyRepo, 'rev-parse', 'HEAD').trim(), 'full source SHA');
  assert(/^sha256:[0-9a-f]{64}$/.test(onDisk.classification_digest), 'classification_digest');
  assert(/^sha256:[0-9a-f]{64}$/.test(onDisk.staging_digest), 'staging_digest');
  assertEqual(onDisk.verdict, 'built', 'verdict');
  assertEqual(onDisk.failures.length, 0, 'no failures');
});

// --- invariant 1: empty tree start -------------------------------------------

test('a non-empty --out dir is refused (exit 20) and its content is untouched', () => {
  const out = tmp('dirty-out');
  fs.writeFileSync(path.join(out, 'keep.txt'), 'precious\n');
  const r = promotion.project('HEAD', { cwd: happyRepo, out });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  assertEqual(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'precious\n', 'untouched');
  const onDisk = JSON.parse(fs.readFileSync(r.report_path, 'utf8'));
  assertEqual(onDisk.verdict, 'failed', 'report written even on failure');
  rm(out);
  rm(r.report_path);
});

// --- invariant 3: fail closed on the unresolvable; NEVER copy everything -----

test('an unclassified path fails closed naming the path; nothing is copied', () => {
  const repo = makeRepo({ ...baseFiles(), 'rogue.txt': 'uncovered\n' });
  const out = tmp('unclassified-out');
  const r = promotion.project('HEAD', { cwd: repo, out });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  const failure = r.failures.find((f) => f.path === 'rogue.txt');
  assert(failure && /unclassified/.test(failure.reason), 'failure names the path + reason');
  assertEqual(listFiles(out).length, 0, 'staging dir left empty — the tree was NOT copied');
  rm(out);
  rm(r.report_path);
});

test('an ambiguous tie at equal specificity fails closed', () => {
  const repo = makeRepo({
    'src/app.js': 'x\n',
    [CLASSIFICATION_PATH]: rulesYaml([
      { pattern: 'src/*', bucket: 'public' },
      { pattern: 'src/*.js', bucket: 'private' },
      { pattern: '.verity/**', bucket: 'private' },
    ]),
  });
  const r = promotion.project('HEAD', { cwd: repo });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  const failure = r.failures.find((f) => f.path === 'src/app.js');
  assert(failure && /ambiguous/.test(failure.reason), 'ambiguity is named');
  assertEqual(r.staging_dir, null, 'no staging tree survives a failed run');
  rm(r.report_path);
});

test('a missing classification at HEAD fails closed', () => {
  const repo = makeRepo({ 'src/app.js': 'x\n' });
  const r = promotion.project('HEAD', { cwd: repo });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  assert(/classification missing at HEAD/.test(r.failures[0].reason), 'reason says why');
  rm(r.report_path);
});

test('an unparsable classification fails closed', () => {
  const repo = makeRepo({
    'src/app.js': 'x\n',
    [CLASSIFICATION_PATH]: 'schema_version: 1\nrules:\n   broken indentation here\n',
  });
  const r = promotion.project('HEAD', { cwd: repo });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  assert(/classification unusable/.test(r.failures[0].reason), 'parse failure is fatal');
  rm(r.report_path);
});

test('empty rules fail closed and copy NOTHING (never the whole tree)', () => {
  const repo = makeRepo({
    'src/app.js': 'x\n',
    'notes/dev.md': 'y\n',
    [CLASSIFICATION_PATH]: 'schema_version: 1\nrules:\n',
  });
  const out = tmp('empty-rules-out');
  const r = promotion.project('HEAD', { cwd: repo, out });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  assert(/rules list is empty/.test(r.failures[0].reason), 'empty rules are named');
  assertEqual(listFiles(out).length, 0, 'nothing was copied');
  rm(out);
  rm(r.report_path);
});

test('an unresolvable source ref is an infra failure (exit 30)', () => {
  const r = promotion.project('no-such-ref', { cwd: happyRepo });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 30, 'infra exit');
  rm(r.report_path);
});

// --- invariant 6: determinism ------------------------------------------------

test('determinism: the same ref twice yields an identical staging_digest', () => {
  const repo = makeRepo(baseFiles());
  const sha = git(repo, 'rev-parse', 'HEAD').trim();
  const r1 = promotion.project(sha, { cwd: repo });
  const r2 = promotion.project(sha, { cwd: repo });
  assertEqual(r1.verdict, 'built', 'run 1 built');
  assertEqual(r2.staging_digest, r1.staging_digest, 'digests identical');
  assertEqual(r2.classification_digest, r1.classification_digest, 'classification identical');

  // Changed file content changes the digest.
  commitTree(repo, { 'src/app.js': 'console.log(2);\n' }, 'change public content');
  const r3 = promotion.project('HEAD', { cwd: repo });
  assertEqual(r3.verdict, 'built', 'run 3 built');
  assert(r3.staging_digest !== r1.staging_digest, 'content change changes staging_digest');

  // Semantically-neutral rule reordering does NOT change the staging digest
  // (resolution is specificity-based, not order-based) even though the
  // classification file's own digest changes.
  const reordered = [BASE_RULES[1], BASE_RULES[0], ...BASE_RULES.slice(2)];
  commitTree(repo, { [CLASSIFICATION_PATH]: rulesYaml(reordered) }, 'reorder rules');
  const r4 = promotion.project(sha, { cwd: repo });
  assertEqual(r4.verdict, 'built', 'run 4 built');
  assertEqual(r4.staging_digest, r1.staging_digest, 'neutral reorder keeps staging_digest');
  assert(
    r4.classification_digest !== r1.classification_digest,
    'the classification digest does track the file content',
  );
  for (const r of [r1, r2, r3, r4]) {
    rm(r.staging_dir);
    rm(r.report_path);
  }
});

// --- invariant 4: secret scan ------------------------------------------------

test('a staged secret fails the projection without echoing the value', () => {
  // Assembled at runtime so this test file (public bucket) never contains a
  // token-shaped literal itself.
  const secret = `ghp_${'A'.repeat(24)}`;
  const repo = makeRepo({
    ...baseFiles(),
    'src/config.js': `const t = '${secret}';\n`,
  });
  const r = promotion.project('HEAD', { cwd: repo });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  const failure = r.failures.find((f) => f.path === 'src/config.js');
  assert(failure && /github-token/.test(failure.reason), 'path + pattern name reported');
  assert(!JSON.stringify(r).includes(secret), 'the secret value never reaches the envelope');
  assert(
    !fs.readFileSync(r.report_path, 'utf8').includes(secret),
    'the secret value never reaches the report file',
  );
  assertEqual(r.staging_dir, null, 'no staging tree survives a secret hit');
  rm(r.report_path);
});

test('a staged LLM API key (sk-ant-) fails the projection without echoing the value', () => {
  const secret = `sk-ant-${'b'.repeat(24)}`;
  const repo = makeRepo({
    ...baseFiles(),
    'src/settings.js': `process.env.ANTHROPIC_API_KEY = '${secret}';\n`,
  });
  const r = promotion.project('HEAD', { cwd: repo });
  assertEqual(r.verdict, 'failed', 'verdict');
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  const failure = r.failures.find((f) => f.path === 'src/settings.js');
  assert(failure && /anthropic-api-key/.test(failure.reason), 'path + pattern name reported');
  assert(!JSON.stringify(r).includes(secret), 'the key value never reaches the envelope');
  assert(
    !fs.readFileSync(r.report_path, 'utf8').includes(secret),
    'the key value never reaches the report file',
  );
  assertEqual(r.staging_dir, null, 'no staging tree survives a secret hit');
  rm(r.report_path);
});

// --- invariant 5: read-only on the repo --------------------------------------

test('project is provably read-only: fixture repo status and HEAD unchanged', () => {
  const repo = makeRepo({ ...baseFiles(), 'rogue.txt': 'uncovered\n' });
  fs.writeFileSync(path.join(repo, 'untracked.tmp'), 'dirty working tree\n');
  const statusBefore = git(repo, 'status', '--porcelain');
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
  const built = promotion.project('HEAD~0', { cwd: repo }); // fails (rogue.txt unclassified)
  const failed = promotion.project('no-such-ref', { cwd: repo });
  assertEqual(built.verdict, 'failed', 'sanity: classify failure exercised');
  assertEqual(failed.verdict, 'failed', 'sanity: ref failure exercised');
  assertEqual(git(repo, 'status', '--porcelain'), statusBefore, 'porcelain status unchanged');
  assertEqual(git(repo, 'rev-parse', 'HEAD').trim(), headBefore, 'HEAD unchanged');
  rm(built.report_path);
  rm(failed.report_path);
});

// --- CLI wiring ---------------------------------------------------------------

test('CLI: promotion project --json emits one compact object and exits 0', () => {
  const out = tmp('cli-out');
  fs.rmdirSync(out); // hand the CLI a non-existent path — it must create it empty
  const stdout = execFileSync(
    'node',
    [CLI, 'promotion', 'project', 'HEAD', '--cwd', happyRepo, '--out', out, '--json'],
    { encoding: 'utf8' },
  );
  const lines = stdout.trim().split('\n');
  assertEqual(lines.length, 1, 'exactly one stdout line (pipe-safe)');
  const obj = JSON.parse(lines[0]);
  assertEqual(obj.verdict, 'built', 'verdict');
  assertEqual(obj.files_projected, 2, 'files_projected');
  rm(out);
  rm(obj.report_path);
});

test('CLI: a contract violation exits 20', () => {
  const repo = makeRepo({ ...baseFiles(), 'rogue.txt': 'uncovered\n' });
  let status = 0;
  let stdout = '';
  try {
    execFileSync('node', [CLI, 'promotion', 'project', 'HEAD', '--cwd', repo, '--json'], {
      encoding: 'utf8',
    });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
  }
  assertEqual(status, 20, 'contract-violation exit code');
  const obj = JSON.parse(stdout.trim());
  assertEqual(obj.verdict, 'failed', 'failed envelope still emitted');
  rm(obj.report_path);
});

// The real-repo smoke (promotion project HEAD on THIS repo) is dev-context —
// it needs the checkout to be a git repo with the private classification file —
// so it lives in the private tests/dev-repo-context.test.cjs (stage 46).

// happy-path fixture cleanup (kept alive across the earlier tests)
rm(happy.staging_dir);
rm(happy.report_path);
