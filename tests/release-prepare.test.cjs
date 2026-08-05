// Stage 42 (ADR-0022 §§2–3): `verity release prepare` — the dev-side untagged
// release computation — and the authoritative-tag guard in `release cut`.
// Everything here runs against REAL git fixtures (real repo, real tags, a real
// bare origin that would really receive a push) so "no tag, no commit, no push"
// is proven against git state, not against a mock's bookkeeping.
//
// The guard's regression contract is NOT here: it is the existing release tests
// (tests/shipyard.test.cjs) passing UNCHANGED — absent `.verity/promotion.json`
// must leave `cut` byte-identical to before this stage.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const release = require('../verity/bin/lib/release.cjs');
const promotionConfig = require('../verity/bin/lib/promotion-config.cjs');
const { sanitize } = require('../verity/bin/lib/changelog-sanitize.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

// A real repo: one tagged baseline (v0.1.0), one Conventional Commit carrying a
// raw `(#12)` ref, a committed CHANGELOG.md, and a real bare origin fully pushed.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-prepare-'));
  const git = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'verity-test',
        GIT_AUTHOR_EMAIL: 'test@verity.local',
        GIT_COMMITTER_NAME: 'verity-test',
        GIT_COMMITTER_EMAIL: 'test@verity.local',
      },
    });
  git(['init', '-q']);
  fs.writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    '# Changelog\n\n## 0.1.0\n\n### Features\n- baseline\n',
  );
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: baseline']);
  git(['tag', 'v0.1.0']);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: add the thing (#12)']);
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-prepare-origin-'));
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' });
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'HEAD', '--tags']);
  return { dir, git, origin };
}

function snapshot(f) {
  return {
    head: f.git(['rev-parse', 'HEAD']).trim(),
    tags: f.git(['tag']).trim(),
    remoteRefs: execFileSync('git', ['ls-remote', f.origin], { encoding: 'utf8' }).trim(),
  };
}

// --- promotion-config reader: presence is the opt-in, malformed fails closed ---
test('promotion-config: absent file means split_active false (guard inert by default)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-noconf-'));
  const c = promotionConfig.read(dir);
  assertEqual(c.present, false);
  assertEqual(c.split_active, false);
});

test('promotion-config: well-formed file is read verbatim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-conf-'));
  fs.mkdirSync(path.join(dir, '.verity'));
  fs.writeFileSync(
    path.join(dir, '.verity', 'promotion.json'),
    JSON.stringify({ schema: 1, split_active: true, prod_repo: 'org/prod' }),
  );
  const c = promotionConfig.read(dir);
  assertEqual(c.present, true);
  assertEqual(c.split_active, true);
  assertEqual(c.prod_repo, 'org/prod');
});

test('promotion-config: malformed JSON and wrong schema are hard errors (exit 20), never silently off', () => {
  for (const bad of [
    '{ nope',
    JSON.stringify({ schema: 2, split_active: true }),
    JSON.stringify({ schema: 1 }),
    '[]',
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-badconf-'));
    fs.mkdirSync(path.join(dir, '.verity'));
    fs.writeFileSync(path.join(dir, '.verity', 'promotion.json'), bad);
    let err = null;
    try {
      promotionConfig.read(dir);
    } catch (e) {
      err = e;
    }
    assert(err, `read must throw for ${JSON.stringify(bad)}`);
    assertEqual(err.exitCode, 20, 'fail-closed contract exit code');
  }
});

// The committed-.verity/promotion.json check (split on for THIS repo) is
// dev-context — it reads this repo's committed .verity/ state — so it lives in
// the private tests/dev-repo-context.test.cjs (stage 46).

// --- prepare: computation only, sanitized, nothing touched ---
test('prepare (report-only) derives version + SANITIZED changelog and touches nothing', () => {
  const f = fixture();
  const before = snapshot(f);
  const r = release.prepare(f.dir);
  assertEqual(r.version, '0.1.1');
  assertEqual(r.tag_candidate, 'v0.1.1');
  assertEqual(r.previous, 'v0.1.0');
  assertEqual(r.commitCount, 1);
  assertEqual(r.applied, false);
  assert(r.changelog.includes('add the thing (dev#12)'), 'section is sanitized');
  assert(!r.changelog.includes('(#12)'), 'raw ref is gone from the section');
  assertEqual(f.git(['status', '--porcelain']).trim(), '', 'working tree untouched');
  const after = snapshot(f);
  assertEqual(after.head, before.head, 'no commit');
  assertEqual(after.tags, before.tags, 'no tag');
  assertEqual(after.remoteRefs, before.remoteRefs, 'no push');
});

test('prepare --apply edits ONLY CHANGELOG.md — no tag, no commit, no push', () => {
  const f = fixture();
  const before = snapshot(f);
  const r = release.prepare(f.dir, { apply: true });
  assertEqual(r.applied, true);
  assertEqual(
    f.git(['status', '--porcelain']).trim(),
    'M CHANGELOG.md',
    'the one working-tree edit',
  );
  const changelog = fs.readFileSync(path.join(f.dir, 'CHANGELOG.md'), 'utf8');
  assert(changelog.startsWith('# Changelog'), 'prepended via the shared prependChangelog');
  assert(changelog.includes('## 0.1.1'), 'new section present');
  assert(changelog.includes('(dev#12)'), 'prepended section is sanitized');
  assert(changelog.includes('## 0.1.0'), 'prior content preserved');
  const after = snapshot(f);
  assertEqual(after.head, before.head, 'no commit');
  assertEqual(after.tags, before.tags, 'no tag');
  assertEqual(after.remoteRefs, before.remoteRefs, 'fixture remote untouched');
});

test('CLI: verity release prepare --bump minor exits 0 and reports the computation', () => {
  const f = fixture();
  const r = cli(['release', 'prepare', '--bump', 'minor', '--cwd', f.dir, '--json']);
  assertEqual(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assertEqual(out.version, '0.2.0');
  assertEqual(out.tag_candidate, 'v0.2.0');
  assertEqual(out.applied, false);
  assertEqual(f.git(['status', '--porcelain']).trim(), '', 'CLI report mode touches nothing');
});

// --- cut vs prepare: one derivation, two verbs ---
test('cut and prepare agree on version/tag for the same fixture and bump (shared derivation)', () => {
  const f = fixture();
  const dry = release.cut(f.dir, { bump: 'minor', dryRun: true });
  const prep = release.prepare(f.dir, { bump: 'minor' });
  assertEqual(prep.version, dry.version);
  assertEqual(prep.tag_candidate, dry.tag);
  assertEqual(prep.previous, dry.previous);
  assertEqual(prep.commitCount, dry.commitCount);
  assertEqual(prep.changelog, sanitize(dry.changelog), 'same section, sanitized vs raw');
});

// --- the authoritative-tag guard in cut ---
function armSplit(f) {
  fs.mkdirSync(path.join(f.dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(f.dir, '.verity', 'promotion.json'),
    JSON.stringify({ schema: 1, split_active: true, prod_repo: null }),
  );
}

test('guard: split_active true makes cut refuse with exit 20, no tag created, message names release prepare', () => {
  const f = fixture();
  armSplit(f);
  const before = snapshot(f);
  const r = cli(['release', 'cut', '--no-push', '--cwd', f.dir]);
  assertEqual(r.status, 20, `expected exit 20, got ${r.status} (stderr: ${r.stderr})`);
  assert(r.stderr.includes('release prepare'), 'refusal points at release prepare');
  assert(r.stderr.includes('promotion'), 'refusal names the promotion flow');
  const after = snapshot(f);
  assertEqual(after.tags, before.tags, 'no tag was born');
  assertEqual(after.head, before.head, 'no commit');
  assertEqual(after.remoteRefs, before.remoteRefs, 'no push');
  assertEqual(
    f.git(['status', '--porcelain']).trim(),
    '?? .verity/',
    'only the armed config is untracked — cut itself touched nothing',
  );
});

test('guard: cut --dry-run still returns the computation under split_active true', () => {
  const f = fixture();
  armSplit(f);
  const r = cli(['release', 'cut', '--dry-run', '--cwd', f.dir]);
  assertEqual(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assertEqual(out.version, '0.1.1');
  assertEqual(out.applied, false);
  assertEqual(f.git(['tag']).trim(), 'v0.1.0', 'still no tag');
});

test('guard: malformed promotion.json is a hard error (exit 20) — never a silently-disarmed guard', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, '.verity', 'promotion.json'), '{ this is not json');
  const r = cli(['release', 'cut', '--no-push', '--cwd', f.dir]);
  assertEqual(r.status, 20, `expected exit 20, got ${r.status} (stderr: ${r.stderr})`);
  assert(r.stderr.includes('promotion.json'), 'error names the file');
  assertEqual(f.git(['tag']).trim(), 'v0.1.0', 'no tag under a broken config');
});

test('guard: absent config leaves cut fully operational (kill-switch default OFF)', () => {
  const f = fixture();
  const r = release.cut(f.dir, { push: false });
  assertEqual(r.applied, true);
  assertEqual(r.tag, 'v0.1.1');
  assert(f.git(['tag']).includes('v0.1.1'), 'tag created as before this stage');
});

test('guard: module-level cut throws with exitCode 20 under split_active true', () => {
  const f = fixture();
  armSplit(f);
  let err = null;
  try {
    release.cut(f.dir, { push: false });
  } catch (e) {
    err = e;
  }
  assert(err, 'cut must refuse');
  assertEqual(err.exitCode, 20);
  assert(err.message.includes('release prepare'), 'message names the replacement verb');
});
