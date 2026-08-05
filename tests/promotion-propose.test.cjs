// Stage 43 (#107 Phase 3) — `verity promotion propose`: turn a VERIFIED
// projection into the promotion PR in prod plus both promotion-records v1
// records. Offline node:test style: a LOCAL bare fixture repo stands in for
// prod (real git mechanics — branch, single commit, push, ref byte-compares),
// gh sits behind an injectable runner stub (house pattern), and the projection
// report is a fixture whose digests are deliberately fake — equality in the
// records PROVES propose copies them verbatim and never recomputes.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promotion = require('../verity/bin/lib/promotion.cjs');
const promotionConfig = require('../verity/bin/lib/promotion-config.cjs');
const { findBare } = require('../verity/bin/lib/changelog-sanitize.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'verity', 'bin', 'verity.cjs');

const DEV_SLUG = 'acme/widget-dev';
const DEV_URL = `https://github.com/${DEV_SLUG}.git`;
const PROD_REPO = 'acme/widget-prod';
const DEV_SHA = 'f0e1d2c3b4a5968778695a4b3c2d1e0f01234567';
const CLASSIFICATION_DIGEST = `sha256:${'a'.repeat(64)}`;
const STAGING_DIGEST = `sha256:${'b'.repeat(64)}`;
const PACK_SHASUM = 'c'.repeat(40);

// --- fixture helpers ---------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-propose-${tag}-`));
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function rm(p) {
  if (p) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function promotionJson(overrides = {}) {
  return `${JSON.stringify({
    schema: 1,
    split_active: true,
    prod_repo: PROD_REPO,
    prod_owned: ['.github/**', 'docs/repository-transition.md', 'RELEASE-MANIFEST.json'],
    ...overrides,
  })}\n`;
}

// The dev repo: origin remote set (the PROM record names the dev repository),
// promotion.json committed.
function makeDevRepo(configOverrides) {
  const dir = tmp('dev');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', DEV_URL);
  writeTree(dir, { '.verity/promotion.json': promotionJson(configOverrides) });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dev fixture');
  return dir;
}

const PROD_FILES = {
  '.github/workflows/ci.yml': 'name: prod-ci\non: [push]\n',
  'docs/repository-transition.md': 'prod-owned transition doc\n',
  'RELEASE-MANIFEST.json': '{"schema":1,"version":"1.1.0","promotion_id":"PROM-0000"}\n',
  'README.md': 'old projected readme\n',
  'stale.js': 'public at v1.1.0, private at v1.2.0 — must disappear\n',
};

// The prod stand-in: a bare repo seeded with furniture + an old projection,
// tagged v1.1.0. Returned path doubles as the clone/push URL.
function makeProdBare(files = PROD_FILES, tag = 'v1.1.0') {
  const work = tmp('prodwork');
  git(work, 'init', '-q');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Verity Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  writeTree(work, files);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'prod baseline');
  if (tag) {
    git(work, 'tag', tag);
  }
  const bare = tmp('prodbare');
  fs.rmdirSync(bare);
  git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  rm(work);
  return bare;
}

const STAGING_FILES = {
  'README.md': 'new projected readme\n',
  'lib/a.js': 'module.exports = 43;\n',
};

// A staging dir plus its projection report. The digests/shasums are FAKE on
// purpose: any recomputation would produce different values, so record
// equality proves the copy-verbatim rule.
function makeStaging({ files = STAGING_FILES, report = {}, verify = {} } = {}) {
  const dir = tmp('staging');
  writeTree(dir, files);
  const reportPath = `${dir}.report.json`;
  const base = {
    schema: 1,
    source_ref: 'HEAD',
    source_commit: DEV_SHA,
    classification_digest: CLASSIFICATION_DIGEST,
    staging_digest: STAGING_DIGEST,
    files_projected: Object.keys(files).length,
    files_omitted: { private: 0, generated: 0 },
    verdict: 'built',
    failures: [],
    verify: {
      gates: {
        install: { ok: true },
        lint: { ok: true },
        test: { ok: true },
        pack: { ok: true },
      },
      pack_shasum: PACK_SHASUM,
      baseline: null,
      verdict: 'passed',
      ...verify,
    },
    ...report,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(base, null, 2)}\n`);
  return { dir, reportPath };
}

function ghStub(calls, url = `https://github.com/${PROD_REPO}/pull/7`) {
  return (args) => {
    calls.push(args);
    return `${url}\n`;
  };
}

function refsOf(bare) {
  return git(bare, 'for-each-ref');
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// --- happy path: constructed tree, single commit, both records ---------------

const happyDev = makeDevRepo();
const happyBare = makeProdBare();
const happyStaging = makeStaging();
const happyCalls = [];
const happy = promotion.propose('1.2.0', {
  cwd: happyDev,
  staging: happyStaging.dir,
  prodUrl: happyBare,
  gh: ghStub(happyCalls),
});

test('propose: happy path exits 0 with the full envelope', () => {
  assertEqual(happy.exit_code, 0, `exit (failures: ${JSON.stringify(happy.failures || null)})`);
  assertEqual(happy.promotion_id, 'PROM-0001', 'first promotion is PROM-0001');
  assertEqual(happy.branch, 'promote/v1.2.0', 'branch name');
  assertEqual(happy.prod_repo, PROD_REPO, 'prod repo from config');
  assertEqual(happy.pull_request, 7, 'PR number parsed from the gh URL');
  assertEqual(happy.dry_run, false, 'not a dry run');
});

test('ADR-0023 constructed tree: projection verbatim ∪ prod-owned from prod HEAD', () => {
  const show = (p) => git(happyBare, 'show', `promote/v1.2.0:${p}`);
  assertEqual(show('README.md'), 'new projected readme\n', 'projection file verbatim (replaced)');
  assertEqual(show('lib/a.js'), 'module.exports = 43;\n', 'new projection file present');
  assertEqual(
    show('.github/workflows/ci.yml'),
    'name: prod-ci\non: [push]\n',
    'prod-owned furniture carried from prod HEAD byte-identically',
  );
  assertEqual(
    show('docs/repository-transition.md'),
    'prod-owned transition doc\n',
    'prod-owned doc carried',
  );
  assertEqual(happy.tree.projected, 2, 'projected count');
  assertEqual(happy.tree.prod_owned, 3, 'prod-owned count (incl. the old manifest)');
  assertEqual(happy.tree.total, 5, 'total tree files');
});

test('deletion case: a prod file in neither set is ABSENT from the promotion tree', () => {
  let err = null;
  try {
    git(happyBare, 'show', 'promote/v1.2.0:stale.js');
  } catch (e) {
    err = e;
  }
  assert(err, 'stale.js fell out of the constructed tree');
  assertEqual(happy.tree.deleted, 1, 'deletion counted');
});

test('single sanitized commit on prod HEAD; no shared ancestry with dev', () => {
  const defaultBranch = git(happyBare, 'symbolic-ref', '--short', 'HEAD').trim();
  const count = git(happyBare, 'rev-list', '--count', `${defaultBranch}..promote/v1.2.0`).trim();
  assertEqual(count, '1', 'exactly ONE commit on top of prod HEAD');
  const subject = git(happyBare, 'log', '-1', '--pretty=%s', 'promote/v1.2.0').trim();
  assertEqual(subject, `Promote Verity v1.2.0 (dev@${DEV_SHA.slice(0, 12)})`, 'commit title');
  const message = git(happyBare, 'log', '-1', '--pretty=%B', 'promote/v1.2.0');
  assert(!message.includes(DEV_SLUG), 'no dev repo name in the commit message');
  assert(!message.includes(DEV_URL), 'no dev URL in the commit message');
  const devShas = git(happyDev, 'rev-list', '--all').trim().split('\n');
  const prodShas = git(happyBare, 'rev-list', 'promote/v1.2.0').trim().split('\n');
  for (const sha of devShas) {
    assert(!prodShas.includes(sha), `dev commit ${sha} must not be in the promotion ancestry`);
  }
});

test('RELEASE-MANIFEST.json matches the promotion-records contract field-for-field, digests COPIED', () => {
  const m = JSON.parse(git(happyBare, 'show', 'promote/v1.2.0:RELEASE-MANIFEST.json'));
  assertEqual(m.schema, 1, 'schema');
  assertEqual(m.version, '1.2.0', 'version');
  assertEqual(m.promotion_id, 'PROM-0001', 'promotion_id');
  assertEqual(m.development_commit, DEV_SHA, 'development_commit copied');
  assertEqual(m.classification_digest, CLASSIFICATION_DIGEST, 'classification_digest verbatim');
  assertEqual(
    m.staging_digest,
    STAGING_DIGEST,
    'staging_digest verbatim (fake → provably not recomputed)',
  );
  assertEqual(m.package_shasum, PACK_SHASUM, 'package_shasum copied from verify.pack_shasum');
  assertEqual(m.verify.gates, 'all-pass', 'verify.gates literal');
  assertEqual(m.verify.baseline, null, 'baseline null when not run');
  assert(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(m.promoted_at), 'promoted_at is iso8601');
  assertEqual(Object.keys(m).length, 9, 'no extra fields beyond the contract');
});

test('manifest sanitization: no dev repo name or URL anywhere in it', () => {
  const text = git(happyBare, 'show', 'promote/v1.2.0:RELEASE-MANIFEST.json');
  assert(!text.includes(DEV_SLUG), 'no dev slug');
  assert(!text.includes('widget-dev'), 'no dev repo name fragment');
  assert(!text.includes(DEV_URL), 'no dev URL');
});

test('PROM-0001.yml written in dev per the contract, committed with a chore(promotion) message', () => {
  const p = path.join(happyDev, '.verity/promotions/PROM-0001.yml');
  assertEqual(happy.record_path, p, 'record path in the envelope');
  const text = fs.readFileSync(p, 'utf8');
  const expectLines = [
    'promotion_id: PROM-0001',
    'version: 1.2.0',
    'status: proposed',
    'development:',
    `  repository: ${DEV_SLUG}`,
    `  commit: ${DEV_SHA}`,
    `  staging_digest: ${STAGING_DIGEST}`,
    `  classification_digest: ${CLASSIFICATION_DIGEST}`,
    'production:',
    `  repository: ${PROD_REPO}`,
    '  pull_request: 7',
    '  commit: null',
    '  tag: null',
    'verification:',
    '  gates: all-pass',
    `  package_shasum: ${PACK_SHASUM}`,
    '  baseline: null',
    'timestamps:',
    '  finalized_at: null',
  ];
  for (const line of expectLines) {
    assert(text.split('\n').includes(line), `record line present: ${line}`);
  }
  assert(/^ {2}proposed_at: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/m.test(text), 'proposed_at is iso8601');
  assertEqual(happy.record_committed, true, 'record committed');
  const subject = git(happyDev, 'log', '-1', '--pretty=%s').trim();
  assertEqual(
    subject,
    'chore(promotion): record PROM-0001 — propose v1.2.0 (prod PR 7)',
    'dev commit message (no #NN autolink hazard)',
  );
  assertEqual(git(happyDev, 'status', '--porcelain'), '', 'dev working tree clean after commit');
});

test('gh stub saw ONE pr create against prod; the body is sanitized', () => {
  assertEqual(happyCalls.length, 1, 'exactly one gh call');
  const args = happyCalls[0];
  assertEqual(args[0], 'pr', 'gh pr');
  assertEqual(args[1], 'create', 'gh pr create');
  assertEqual(flag(args, '--repo'), PROD_REPO, 'targets prod');
  assertEqual(flag(args, '--head'), 'promote/v1.2.0', 'head branch');
  assertEqual(flag(args, '--title'), 'Promote Verity v1.2.0', 'PR title');
  const body = flag(args, '--body');
  assert(body?.includes(STAGING_DIGEST), 'body carries the manifest summary');
  assert(
    body.includes('| install / lint / test / pack | all-pass |'),
    'body carries the gate table',
  );
  assert(!body.includes(DEV_SLUG), 'no dev repo name in the PR body');
  assert(!body.includes(DEV_URL), 'no dev URL in the PR body');
  assertEqual(findBare(body).length, 0, 'no bare #NN autolink hazards in the PR body');
});

// --- PROM numbering ----------------------------------------------------------

test('PROM numbering derives from existing records: next after PROM-0002 is PROM-0003', () => {
  const dev = makeDevRepo();
  writeTree(dev, { '.verity/promotions/PROM-0002.yml': 'promotion_id: PROM-0002\n' });
  const bare = makeProdBare();
  const staging = makeStaging();
  const r = promotion.propose('1.2.0', {
    cwd: dev,
    staging: staging.dir,
    prodUrl: bare,
    dryRun: true,
    gh: ghStub([]),
  });
  assertEqual(r.exit_code, 0, 'dry-run ok');
  assertEqual(r.promotion_id, 'PROM-0003', 'append-only numbering from the max existing record');
  rm(r.tree_dir);
  rm(dev);
  rm(bare);
  rm(staging.dir);
  rm(staging.reportPath);
});

// --- disjointness ------------------------------------------------------------

test('disjointness violation: a projected path matching a prod_owned glob fails closed naming it', () => {
  const dev = makeDevRepo();
  const bare = makeProdBare();
  const before = refsOf(bare);
  const staging = makeStaging({
    files: { ...STAGING_FILES, 'docs/repository-transition.md': 'smuggled from dev\n' },
  });
  const calls = [];
  const r = promotion.propose('1.2.0', {
    cwd: dev,
    staging: staging.dir,
    prodUrl: bare,
    gh: ghStub(calls),
  });
  assertEqual(r.exit_code, 20, 'contract-violation exit');
  assert(/disjointness/.test(r.raw), 'named as a disjointness violation');
  const failure = (r.failures || []).find((f) => f.path === 'docs/repository-transition.md');
  assert(failure, 'the offending path is named');
  assert(
    /prod_owned glob docs\/repository-transition\.md/.test(failure.reason),
    'the glob is named',
  );
  assertEqual(refsOf(bare), before, 'prod refs untouched');
  assertEqual(calls.length, 0, 'no PR attempted');
  assert(!fs.existsSync(path.join(dev, '.verity/promotions')), 'no PROM record written');
  rm(dev);
  rm(bare);
  rm(staging.dir);
  rm(staging.reportPath);
});

// --- preconditions fail closed -----------------------------------------------

function proposeExpectingRefusal(name, { config, staging, mutate, version = '1.2.0', reMessage }) {
  test(name, () => {
    const dev = makeDevRepo(config);
    const bare = makeProdBare();
    const before = refsOf(bare);
    const st = staging ? staging() : makeStaging();
    if (mutate) {
      mutate(st);
    }
    const calls = [];
    const r = promotion.propose(version, {
      cwd: dev,
      staging: st.dir,
      prodUrl: bare,
      gh: ghStub(calls),
    });
    assertEqual(r.exit_code, 20, `contract exit (raw: ${r.raw})`);
    assert(reMessage.test(r.raw), `refusal names the cause: ${r.raw}`);
    assertEqual(refsOf(bare), before, 'prod refs untouched');
    assertEqual(calls.length, 0, 'no PR attempted');
    rm(dev);
    rm(bare);
    rm(st.dir);
    rm(st.reportPath);
  });
}

proposeExpectingRefusal('precondition: a report without a verify block is not proposable', {
  staging: () => {
    const st = makeStaging();
    const rep = JSON.parse(fs.readFileSync(st.reportPath, 'utf8'));
    rep.verify = undefined; // JSON.stringify drops it — a report with NO verify block
    fs.writeFileSync(st.reportPath, JSON.stringify(rep));
    return st;
  },
  reMessage: /no verify block/,
});

proposeExpectingRefusal('precondition: a FAILED verify block is not proposable', {
  staging: () => makeStaging({ verify: { verdict: 'failed' } }),
  reMessage: /verify verdict is "failed"/,
});

proposeExpectingRefusal('precondition: a failed projection report is not proposable', {
  staging: () => makeStaging({ report: { verdict: 'failed' } }),
  reMessage: /verdict is "failed", not "built"/,
});

proposeExpectingRefusal('precondition: a missing report is not proposable', {
  staging: () => {
    const st = makeStaging();
    fs.rmSync(st.reportPath);
    return st;
  },
  reMessage: /projection report not found/,
});

proposeExpectingRefusal('precondition: version equal to the latest prod tag is refused', {
  version: '1.1.0',
  reMessage: /not greater than prod's latest tag v1\.1\.0/,
});

proposeExpectingRefusal('precondition: version below the latest prod tag is refused', {
  version: '1.0.9',
  reMessage: /not greater than prod's latest tag/,
});

proposeExpectingRefusal('precondition: a non-semver version is refused', {
  version: 'v1.2.0',
  reMessage: /must be semver/,
});

proposeExpectingRefusal('precondition: a missing prod_repo fails closed', {
  config: { prod_repo: null },
  reMessage: /prod_repo is not configured/,
});

proposeExpectingRefusal('precondition: malformed prod_owned fails closed, never silently []', {
  config: { prod_owned: 'not-an-array' },
  reMessage: /prod_owned must be an array/,
});

// --- verify's install artifacts never ride into the promotion tree -----------

test('node_modules left behind by the verify install gate is EXCLUDED from the tree', () => {
  const dev = makeDevRepo();
  const bare = makeProdBare();
  // Verified staging in real life: verify ran `npm ci` INSIDE this dir.
  const staging = makeStaging({
    files: {
      ...STAGING_FILES,
      'node_modules/dep/index.js': 'installed artifact, not projection content\n',
      'node_modules/.package-lock.json': '{}\n',
    },
  });
  const rep = JSON.parse(fs.readFileSync(staging.reportPath, 'utf8'));
  rep.files_projected = 2; // the report counts the PROJECTION, not npm's leavings
  fs.writeFileSync(staging.reportPath, JSON.stringify(rep));
  const r = promotion.propose('1.2.0', {
    cwd: dev,
    staging: staging.dir,
    prodUrl: bare,
    gh: ghStub([]),
  });
  assertEqual(r.exit_code, 0, `ok (raw: ${r.raw})`);
  assertEqual(r.tree.projected, 2, 'projected count matches the report, not the polluted dir');
  let err = null;
  try {
    git(bare, 'show', 'promote/v1.2.0:node_modules/dep/index.js');
  } catch (e) {
    err = e;
  }
  assert(err, 'node_modules never reaches the promotion tree');
  rm(dev);
  rm(bare);
  rm(staging.dir);
  rm(staging.reportPath);
});

proposeExpectingRefusal('a staging tree that no longer matches its report count fails closed', {
  staging: () =>
    makeStaging({ files: { ...STAGING_FILES, 'rogue.txt': 'appeared after project\n' } }),
  // makeStaging sets files_projected to the file count — override it back down
  // so the on-disk set (3) disagrees with the report (2).
  mutate: (st) => {
    const rep = JSON.parse(fs.readFileSync(st.reportPath, 'utf8'));
    rep.files_projected = 2;
    fs.writeFileSync(st.reportPath, JSON.stringify(rep));
  },
  reMessage: /staging tree has 3 projection file\(s\) but the report says files_projected: 2/,
});

// --- dry-run: pushes NOTHING -------------------------------------------------

test('--dry-run stops after tree + manifest: prod refs byte-identical, no gh, no records, no dev commit', () => {
  const dev = makeDevRepo();
  const bare = makeProdBare();
  const staging = makeStaging();
  const refsBefore = refsOf(bare);
  const devLogBefore = git(dev, 'rev-list', '--all');
  const calls = [];
  const r = promotion.propose('1.2.0', {
    cwd: dev,
    staging: staging.dir,
    prodUrl: bare,
    dryRun: true,
    gh: ghStub(calls),
  });
  assertEqual(r.exit_code, 0, `dry-run ok (raw: ${r.raw})`);
  assertEqual(r.dry_run, true, 'flagged as dry run');
  assertEqual(refsOf(bare), refsBefore, 'prod refs BYTE-IDENTICAL before/after');
  assertEqual(calls.length, 0, 'gh never invoked');
  assertEqual(git(dev, 'rev-list', '--all'), devLogBefore, 'no dev commit');
  assert(!fs.existsSync(path.join(dev, '.verity/promotions')), 'no PROM record');
  assertEqual(r.pull_request, null, 'no PR number claimed');
  assertEqual(r.tree.projected, 2, 'would-be tree: projected');
  assertEqual(r.tree.prod_owned, 3, 'would-be tree: prod-owned');
  assertEqual(r.tree.deleted, 1, 'would-be tree: deleted');
  const m = JSON.parse(fs.readFileSync(path.join(r.tree_dir, 'RELEASE-MANIFEST.json'), 'utf8'));
  assertEqual(m.version, '1.2.0', 'manifest built in the kept tree dir');
  assert(/nothing pushed/.test(r.raw), 'raw says nothing was pushed');
  rm(r.tree_dir);
  rm(dev);
  rm(bare);
  rm(staging.dir);
  rm(staging.reportPath);
});

// --- promotion-config reader: prod_owned validation --------------------------

test('promotion-config: prod_owned absent → [], valid array read verbatim, malformed → hard error', () => {
  const dir = tmp('cfg');
  const p = path.join(dir, '.verity/promotion.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });

  fs.writeFileSync(p, JSON.stringify({ schema: 1, split_active: true, prod_repo: 'o/r' }));
  assertEqual(promotionConfig.read(dir).prod_owned.join(','), '', 'absent → empty array');

  fs.writeFileSync(p, promotionJson());
  assertEqual(
    promotionConfig.read(dir).prod_owned.join(','),
    '.github/**,docs/repository-transition.md,RELEASE-MANIFEST.json',
    'well-formed array read verbatim',
  );

  for (const bad of ['nope', 42, {}, [''], [1], ['ok', null]]) {
    fs.writeFileSync(
      p,
      JSON.stringify({ schema: 1, split_active: true, prod_repo: 'o/r', prod_owned: bad }),
    );
    let err = null;
    try {
      promotionConfig.read(dir);
    } catch (e) {
      err = e;
    }
    assert(err, `read must throw for prod_owned ${JSON.stringify(bad)}`);
    assertEqual(err.exitCode, 20, 'fail-closed exit code');
  }
  rm(dir);
});

// --- CLI wiring ---------------------------------------------------------------

test('CLI: propose --json refuses unverified staging with exit 20 and one compact object', () => {
  const dev = makeDevRepo();
  const staging = makeStaging();
  const rep = JSON.parse(fs.readFileSync(staging.reportPath, 'utf8'));
  rep.verify = undefined; // JSON.stringify drops it — a report with NO verify block
  fs.writeFileSync(staging.reportPath, JSON.stringify(rep));
  let status = 0;
  let stdout = '';
  try {
    execFileSync(
      'node',
      [CLI, 'promotion', 'propose', '1.2.0', '--staging', staging.dir, '--cwd', dev, '--json'],
      { encoding: 'utf8' },
    );
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
  }
  assertEqual(status, 20, 'contract-violation exit code');
  const lines = stdout.trim().split('\n');
  assertEqual(lines.length, 1, 'exactly one stdout line (pipe-safe)');
  const obj = JSON.parse(lines[0]);
  assert(/no verify block/.test(obj.raw), 'the refusal reason reaches the envelope');
  rm(dev);
  rm(staging.dir);
  rm(staging.reportPath);
});

test('CLI: propose without --staging is a usage error', () => {
  let status = 0;
  let stderr = '';
  try {
    execFileSync('node', [CLI, 'promotion', 'propose', '1.2.0'], { encoding: 'utf8' });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr || '');
  }
  assertEqual(status, 1, 'usage error exit');
  assert(/usage: verity promotion propose/.test(stderr), 'usage line printed');
});

// happy-path fixture cleanup (kept alive across the earlier tests)
rm(happyDev);
rm(happyBare);
rm(happyStaging.dir);
rm(happyStaging.reportPath);
