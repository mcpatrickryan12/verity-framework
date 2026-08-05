// Stage 44 (#107 Phase 3) — `verity promotion finalize`: prod-side tag +
// GitHub Release from a MERGED promotion PR, completing the promotion-records
// v1 evidence trail. Offline, the stage-43 fixture pattern extended: a LOCAL
// bare repo stands in for prod carrying a real --no-ff merge of a promotion
// branch, gh sits behind an injectable stub (pr view / release create), and
// the record's digests are deliberately fake — equality proves finalize
// COMPARES them (verify-before-tag) and never recomputes. The pack shasum is
// the one REAL value: computed once from the fixture package by `npm pack`,
// so the merged tree provably reproduces it.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promotion = require('../verity/bin/lib/promotion.cjs');
const { findBare } = require('../verity/bin/lib/changelog-sanitize.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'verity', 'bin', 'verity.cjs');

const DEV_SLUG = 'acme/widget-dev';
const DEV_URL = `https://github.com/${DEV_SLUG}.git`;
const PROD_REPO = 'acme/widget-prod';
const DEV_SHA = 'f0e1d2c3b4a5968778695a4b3c2d1e0f01234567';
const CLASSIFICATION_DIGEST = `sha256:${'a'.repeat(64)}`;
const STAGING_DIGEST = `sha256:${'b'.repeat(64)}`;

// --- fixture helpers ---------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-finalize-${tag}-`));
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

// The promotion tree's packable content. `npm pack` respects the files
// allowlist, so RELEASE-MANIFEST.json / .github never enter the tarball —
// the merged tree must pack byte-identically to this set alone.
const PACK_FILES = {
  'package.json': `${JSON.stringify(
    { name: 'widget-prod', version: '1.2.0', license: 'MIT', files: ['lib'] },
    null,
    2,
  )}\n`,
  'lib/a.js': 'module.exports = 44;\n',
};

// The ONE real verification value: what the fixture package actually packs to.
function computePackShasum(files) {
  const dir = tmp('packsrc');
  const dest = tmp('packdest');
  writeTree(dir, files);
  execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  const sha = crypto
    .createHash('sha1')
    .update(fs.readFileSync(path.join(dest, tgz)))
    .digest('hex');
  rm(dir);
  rm(dest);
  return sha;
}
const REAL_PACK_SHASUM = computePackShasum(PACK_FILES);

function manifestJson(overrides = {}) {
  return `${JSON.stringify(
    {
      schema: 1,
      version: '1.2.0',
      promotion_id: 'PROM-0001',
      development_commit: DEV_SHA,
      classification_digest: CLASSIFICATION_DIGEST,
      staging_digest: STAGING_DIGEST,
      package_shasum: REAL_PACK_SHASUM,
      verify: { gates: 'all-pass', baseline: null },
      promoted_at: '2026-08-05T00:00:00.000Z',
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

// A PROM record exactly as propose (stage 43) writes it.
function promRecordText({
  version = '1.2.0',
  status = 'proposed',
  pull = 7,
  packShasum = REAL_PACK_SHASUM,
} = {}) {
  return [
    'promotion_id: PROM-0001',
    `version: ${version}`,
    `status: ${status}`,
    'development:',
    `  repository: ${DEV_SLUG}`,
    `  commit: ${DEV_SHA}`,
    `  staging_digest: ${STAGING_DIGEST}`,
    `  classification_digest: ${CLASSIFICATION_DIGEST}`,
    'production:',
    `  repository: ${PROD_REPO}`,
    `  pull_request: ${pull}`,
    '  commit: null',
    '  tag: null',
    'verification:',
    '  gates: all-pass',
    `  package_shasum: ${packShasum}`,
    '  baseline: null',
    'timestamps:',
    '  proposed_at: 2026-08-05T00:00:00.000Z',
    '  finalized_at: null',
    '',
  ].join('\n');
}

// The dev repo: origin remote (sanitization checks need a slug to scan for),
// promotion.json + the PROM record committed. NO tags — the ADR-0019
// assertion is that finalize never adds one.
function makeDevRepo(recordText = promRecordText()) {
  const dir = tmp('dev');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', DEV_URL);
  const files = {
    '.verity/promotion.json': `${JSON.stringify({
      schema: 1,
      split_active: true,
      prod_repo: PROD_REPO,
      prod_owned: ['.github/**', 'RELEASE-MANIFEST.json'],
    })}\n`,
  };
  if (recordText !== null) {
    files['.verity/promotions/PROM-0001.yml'] = recordText;
  }
  writeTree(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dev fixture');
  return dir;
}

// The prod stand-in AFTER the review/merge step: baseline (tagged v1.1.0) +
// a promotion branch merged into main with a real --no-ff merge commit.
function makeMergedProd({ files = PACK_FILES, manifest = manifestJson(), preTag = null } = {}) {
  const work = tmp('prodwork');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Verity Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  writeTree(work, {
    'README.md': 'prod baseline readme\n',
    '.github/workflows/ci.yml': 'name: prod-ci\non: [push]\n',
  });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'prod baseline');
  git(work, 'tag', 'v1.1.0');
  git(work, 'checkout', '-q', '-b', 'promote/v1.2.0');
  for (const entry of fs.readdirSync(work)) {
    if (entry !== '.git') {
      rm(path.join(work, entry));
    }
  }
  writeTree(work, {
    ...files,
    'RELEASE-MANIFEST.json': manifest,
    '.github/workflows/ci.yml': 'name: prod-ci\non: [push]\n',
  });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Promote Verity v1.2.0');
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'Merge promotion PR', 'promote/v1.2.0');
  const mergeSha = git(work, 'rev-parse', 'HEAD').trim();
  if (preTag) {
    git(work, 'tag', preTag);
  }
  const bare = tmp('prodbare');
  fs.rmdirSync(bare);
  git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  rm(work);
  return { bare, mergeSha };
}

// gh stub: answers `pr view --json state,mergeCommit` and `release create`.
function finalizeGhStub(calls, { state = 'MERGED', mergeSha = null } = {}) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return `${JSON.stringify({
        state,
        mergeCommit: state === 'MERGED' ? { oid: mergeSha } : null,
      })}\n`;
    }
    if (args[0] === 'release' && args[1] === 'create') {
      return `https://github.com/${PROD_REPO}/releases/tag/${args[2]}\n`;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

function refsOf(bare) {
  return git(bare, 'for-each-ref');
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// --- happy path: verified merge → tag + release + completed record -----------

const happyProd = makeMergedProd();
const happyDev = makeDevRepo();
const happyCalls = [];
const happy = promotion.finalize('1.2.0', {
  cwd: happyDev,
  prodUrl: happyProd.bare,
  gh: finalizeGhStub(happyCalls, { mergeSha: happyProd.mergeSha }),
});

test('finalize: happy path exits 0 with the full envelope', () => {
  assertEqual(happy.exit_code, 0, `exit (failures: ${JSON.stringify(happy.failures || null)})`);
  assertEqual(happy.promotion_id, 'PROM-0001', 'promotion id from the record');
  assertEqual(happy.prod_repo, PROD_REPO, 'prod repo from config');
  assertEqual(happy.pull_request, 7, 'PR number from the record');
  assertEqual(happy.merge_commit, happyProd.mergeSha, 'merge commit from gh');
  assertEqual(happy.tag, 'v1.2.0', 'authoritative tag name');
  assertEqual(happy.release_created, true, 'release issued');
  assertEqual(happy.published, 'pending-O4', 'npm publish deferred to O4');
  assertEqual(happy.verification.manifest, 'match', 'manifest verified before tagging');
  assertEqual(
    happy.verification.pack_shasum,
    REAL_PACK_SHASUM,
    'merged tree repacked to the record shasum',
  );
});

test('annotated tag v1.2.0 sits ON the merge commit in PROD, message sanitized', () => {
  const tagType = git(happyProd.bare, 'cat-file', '-t', 'refs/tags/v1.2.0').trim();
  assertEqual(tagType, 'tag', 'ANNOTATED tag object, not lightweight');
  const target = git(happyProd.bare, 'rev-parse', 'v1.2.0^{}').trim();
  assertEqual(target, happyProd.mergeSha, 'tag points at the merge commit');
  const tagObj = git(happyProd.bare, 'cat-file', 'tag', 'refs/tags/v1.2.0');
  assert(tagObj.includes('Verity v1.2.0 (PROM-0001)'), 'tag message names version + promotion');
  assert(tagObj.includes(STAGING_DIGEST), 'tag message carries the staging digest');
  assert(!tagObj.includes(DEV_SLUG), 'no dev repo name in the tag');
  assert(!tagObj.includes(DEV_URL), 'no dev URL in the tag');
});

test('gh saw pr view then release create against PROD; release body embeds the manifest, sanitized', () => {
  assertEqual(happyCalls.length, 2, 'exactly two gh calls');
  const [view, release] = happyCalls;
  assertEqual(view[0], 'pr', 'first call is pr view');
  assertEqual(view[1], 'view', 'first call is pr view');
  assertEqual(view[2], '7', 'PR number from the record');
  assertEqual(flag(view, '--repo'), PROD_REPO, 'pr view targets prod');
  assertEqual(release[0], 'release', 'second call is release create');
  assertEqual(release[1], 'create', 'second call is release create');
  assertEqual(release[2], 'v1.2.0', 'release for the tag');
  assertEqual(flag(release, '--repo'), PROD_REPO, 'release targets prod');
  assertEqual(flag(release, '--title'), 'v1.2.0', 'release title');
  const body = flag(release, '--notes');
  assert(body?.includes('RELEASE-MANIFEST.json'), 'body embeds the manifest');
  assert(body.includes(STAGING_DIGEST), 'manifest content present');
  assert(body.includes(REAL_PACK_SHASUM), 'package shasum present');
  assert(!body.includes(DEV_SLUG), 'no dev repo name in the release body');
  assert(!body.includes(DEV_URL), 'no dev URL in the release body');
  assertEqual(findBare(body).length, 0, 'no bare #NN autolink hazards in the release body');
});

test('PROM record completed per the contract and committed with a chore(promotion) message', () => {
  const p = path.join(happyDev, '.verity/promotions/PROM-0001.yml');
  assertEqual(happy.record_path, p, 'record path in the envelope');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  assert(lines.includes('status: released'), 'status → released');
  assert(lines.includes(`  commit: ${happyProd.mergeSha}`), 'production.commit = merge commit');
  assert(lines.includes('  tag: v1.2.0'), 'production.tag set');
  assert(
    lines.some((l) => /^ {2}finalized_at: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(l)),
    'finalized_at is iso8601',
  );
  assert(lines.includes('  proposed_at: 2026-08-05T00:00:00.000Z'), 'proposed_at untouched');
  assert(lines.includes(`  staging_digest: ${STAGING_DIGEST}`), 'digests untouched');
  assert(lines.includes(`  package_shasum: ${REAL_PACK_SHASUM}`), 'shasum untouched');
  assertEqual(happy.record_committed, true, 'record committed');
  const subject = git(happyDev, 'log', '-1', '--pretty=%s').trim();
  assertEqual(
    subject,
    'chore(promotion): record PROM-0001 — finalize v1.2.0 released (prod tag v1.2.0)',
    'dev commit message (no #NN autolink hazard)',
  );
  assertEqual(git(happyDev, 'status', '--porcelain'), '', 'dev working tree clean');
});

test('ADR-0019: the DEV repo has NO tags after finalize — authoritative tags are born in prod only', () => {
  assertEqual(git(happyDev, 'tag'), '', 'dev tag list empty after a successful finalize');
});

test('manual publish instruction: expected shasum present, npm publish named, no secrets or dev identifiers', () => {
  const text = happy.publish_instruction;
  assert(text.includes(REAL_PACK_SHASUM), 'expected tarball shasum stated');
  assert(text.includes('npm publish'), 'the manual command is named');
  assert(text.includes('pending-O4'), 'O4 deferral stated');
  assert(text.includes(`https://github.com/${PROD_REPO}.git`), 'clone URL is the PROD repo');
  assert(!text.includes(DEV_SLUG), 'no dev repo name');
  assert(!text.includes(DEV_URL), 'no dev URL');
  for (const p of promotion.SECRET_PATTERNS) {
    assert(!p.re.test(text), `no ${p.name} shape in the instruction`);
  }
});

// --- verify-before-tag: every mismatch aborts, tags NOTHING, status untouched -

function finalizeExpectingAbort(name, { record, prod, ghState, reMessage, expectStatus }) {
  test(name, () => {
    const p = prod ? prod() : makeMergedProd();
    const dev = makeDevRepo(record !== undefined ? record : promRecordText());
    const refsBefore = refsOf(p.bare);
    const devLogBefore = git(dev, 'rev-list', '--all');
    const recordPath = path.join(dev, '.verity/promotions/PROM-0001.yml');
    const recordBefore = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : null;
    const calls = [];
    const r = promotion.finalize('1.2.0', {
      cwd: dev,
      prodUrl: p.bare,
      gh: finalizeGhStub(calls, { state: ghState || 'MERGED', mergeSha: p.mergeSha }),
    });
    assertEqual(r.exit_code, 20, `contract exit (raw: ${r.raw})`);
    assert(reMessage.test(r.raw), `refusal names the cause: ${r.raw}`);
    assertEqual(refsOf(p.bare), refsBefore, 'prod refs BYTE-IDENTICAL — nothing tagged');
    assert(!calls.some((a) => a[0] === 'release'), 'no release call ever issued');
    if (recordBefore !== null) {
      assertEqual(
        fs.readFileSync(recordPath, 'utf8'),
        recordBefore,
        `record byte-identical — status stays ${expectStatus || 'proposed'}`,
      );
    }
    assertEqual(git(dev, 'rev-list', '--all'), devLogBefore, 'no dev commit');
    assertEqual(git(dev, 'tag'), '', 'dev never tagged (ADR-0019, refusal path too)');
    rm(dev);
    rm(p.bare);
  });
}

finalizeExpectingAbort('mismatch: manifest version differs from the record → abort, tag nothing', {
  prod: () => makeMergedProd({ manifest: manifestJson({ version: '1.3.0' }) }),
  reMessage: /verification mismatch \(version/,
});

finalizeExpectingAbort('mismatch: manifest staging digest differs → abort, tag nothing', {
  prod: () =>
    makeMergedProd({ manifest: manifestJson({ staging_digest: `sha256:${'d'.repeat(64)}` }) }),
  reMessage: /verification mismatch \(.*staging_digest/,
});

finalizeExpectingAbort('mismatch: manifest classification digest differs → abort, tag nothing', {
  prod: () =>
    makeMergedProd({
      manifest: manifestJson({ classification_digest: `sha256:${'e'.repeat(64)}` }),
    }),
  reMessage: /verification mismatch \(.*classification_digest/,
});

finalizeExpectingAbort('mismatch: merged tree PACKS to a different shasum → abort, tag nothing', {
  prod: () =>
    makeMergedProd({
      files: { ...PACK_FILES, 'lib/a.js': 'module.exports = 45; // drifted after verify\n' },
    }),
  reMessage: /verification mismatch \(package_shasum \(npm pack\)\)/,
});

finalizeExpectingAbort('mismatch: merged tree has no RELEASE-MANIFEST.json → abort, tag nothing', {
  prod: () => {
    const p = makeMergedProd();
    // Simulate a merge that somehow lost the manifest: point gh at the
    // BASELINE commit (a real commit whose tree has no manifest).
    return { bare: p.bare, mergeSha: git(p.bare, 'rev-parse', 'v1.1.0^{}').trim() };
  },
  reMessage: /no RELEASE-MANIFEST\.json/,
});

// --- status machine ----------------------------------------------------------

finalizeExpectingAbort(
  'status machine: finalize on a released record refuses (idempotence guard)',
  {
    record: promRecordText({ status: 'released' }),
    reMessage: /already released.*not repeatable/,
    expectStatus: 'released',
  },
);

finalizeExpectingAbort('status machine: finalize on an abandoned record refuses', {
  record: promRecordText({ status: 'abandoned' }),
  reMessage: /status "abandoned", not "proposed"/,
  expectStatus: 'abandoned',
});

finalizeExpectingAbort(
  'status machine: an OPEN promotion PR refuses, naming the review/merge step',
  {
    ghState: 'OPEN',
    reMessage: /is OPEN, not MERGED.*reviewed and merged in prod/,
  },
);

finalizeExpectingAbort('status machine: a CLOSED-unmerged PR refuses — propose a new promotion', {
  ghState: 'CLOSED',
  reMessage: /is CLOSED, not MERGED/,
});

finalizeExpectingAbort('no PROM record for the version → refuse pointing at propose', {
  record: null,
  reMessage: /no PROM record for version 1\.2\.0/,
});

finalizeExpectingAbort('tag already present in prod → refuse, never re-tag', {
  prod: () => makeMergedProd({ preTag: 'v1.2.0' }),
  reMessage: /tag v1\.2\.0 already exists/,
});

// --- CLI wiring ---------------------------------------------------------------

test('CLI: finalize --json with no PROM record exits 20 with one compact object', () => {
  const dev = makeDevRepo(null);
  let status = 0;
  let stdout = '';
  try {
    execFileSync('node', [CLI, 'promotion', 'finalize', '1.2.0', '--cwd', dev, '--json'], {
      encoding: 'utf8',
    });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
  }
  assertEqual(status, 20, 'contract-violation exit code');
  const lines = stdout.trim().split('\n');
  assertEqual(lines.length, 1, 'exactly one stdout line (pipe-safe)');
  const obj = JSON.parse(lines[0]);
  assert(/no PROM record/.test(obj.raw), 'the refusal reason reaches the envelope');
  assertEqual(obj.published, 'pending-O4', 'publish deferral present even on refusal');
  rm(dev);
});

test('CLI: finalize without a version is a usage error', () => {
  let status = 0;
  let stderr = '';
  try {
    execFileSync('node', [CLI, 'promotion', 'finalize'], { encoding: 'utf8' });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr || '');
  }
  assertEqual(status, 1, 'usage error exit');
  assert(/usage: verity promotion finalize/.test(stderr), 'usage line printed');
});

// happy-path fixture cleanup (kept alive across the earlier tests)
rm(happyDev);
rm(happyProd.bare);
