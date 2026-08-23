const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage-'));
}

test('stage new (feature) bakes in kill-switch + UI-smoke acceptance conditions', () => {
  const d = fresh();
  const r = stage.create(d, 'Add user profiles', { type: 'feature' });
  assertEqual(r.number, 1);
  assertEqual(r.type, 'feature');
  const body = fs.readFileSync(r.path, 'utf8');
  assert(body.includes('Add user profiles'), 'title interpolated');
  assert(/kill-switch/i.test(body), 'feature must carry a kill-switch condition');
  assert(/UI-smoke/i.test(body), 'feature must carry a UI-smoke condition');
});

test('stage new (bug) carries a regression test, not a kill-switch', () => {
  const d = fresh();
  const body = fs.readFileSync(stage.create(d, 'Fix login 500', { type: 'bug' }).path, 'utf8');
  assert(/regression test/i.test(body), 'bug must carry a regression test');
  assert(!/kill-switch/i.test(body), 'bug should not carry a kill-switch');
});

test('stage new (chore) carries an exit-state', () => {
  const d = fresh();
  const body = fs.readFileSync(stage.create(d, 'Bump deps', { type: 'chore' }).path, 'utf8');
  assert(/exit-state/i.test(body), 'chore must define an exit-state');
});

test('stage numbering increments and depends-on renders', () => {
  const d = fresh();
  stage.create(d, 'First');
  const second = stage.create(d, 'Second', { dependsOn: '1' });
  assertEqual(second.number, 2);
  assert(fs.readFileSync(second.path, 'utf8').includes('**Depends on:** 1'), 'depends-on rendered');
  assertEqual(stage.list(d).stages.length, 2);
});

test('stage new returns a suggested work-item with type label', () => {
  const d = fresh();
  const r = stage.create(d, 'Add billing', { type: 'feature' });
  assertEqual(r.issue.title, '[stage 1] Add billing');
  assert(r.issue.labels.includes('feature'), 'issue carries the type label');
});

test('stage new rejects an unknown type', () => {
  let failed = false;
  try {
    stage.create(fresh(), 'X', { type: 'nonsense' });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'unknown type should be rejected');
});

test('stage new requires a title', () => {
  let failed = false;
  try {
    stage.create(fresh(), '');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'empty title should fail');
});

// --- stage branch (stage 78): base-fresh fork off the resolved default branch ---
//
// All against REAL git in temp dirs with a REAL bare `origin` (the stage-77
// lesson: never validate this path on stubs alone), mirroring the fixture of
// tests/git-lifecycle.test.cjs. Every check is judged by exit code / repository
// state, never by scraping inherited output.

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

// A work repo with two stage files (so stage-N+1-forks-off-stage-N is
// expressible), plus a real bare origin the default branch is pushed to.
// `remoteHead: false` leaves `refs/remotes/origin/HEAD` unrecorded — the
// fixture never clones and never plain-fetches, so no git version invents it
// behind our back (git 2.45+ auto-creates it on fetch; the verb's own fetch
// suppresses that with followRemoteHEAD=never, and the "absent AFTER the verb
// ran" assertions below prove the suppression held).
function gitFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage-git-'));
  const dir = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'verity@example.test']);
  git(dir, ['config', 'user.name', 'Verity Test']);
  stage.create(dir, 'Core');
  stage.create(dir, 'Second');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'baseline\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  const base = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', 'origin', base]);
  if (opts.remoteHead !== false) {
    git(dir, ['remote', 'set-head', 'origin', base]);
  }
  return { root, dir, origin, base };
}

// Advance the bare origin's default branch from a SECOND clone — the repo under
// test learns about it only if the verb really fetches. The clone suppresses
// followRemoteHEAD so it cannot record origin/HEAD anywhere the first repo
// would ever see (belt: it is a separate directory anyway).
function advanceOrigin(fx) {
  const second = path.join(fx.root, 'second');
  execFileSync(
    'git',
    ['-c', 'remote.origin.followRemoteHEAD=never', 'clone', '-q', fx.origin, second],
    { stdio: 'pipe' },
  );
  git(second, ['config', 'user.email', 'verity@example.test']);
  git(second, ['config', 'user.name', 'Verity Test']);
  fs.writeFileSync(path.join(second, 'merged.txt'), 'merged predecessor\n');
  git(second, ['add', '-A']);
  git(second, ['commit', '-q', '-m', 'merged predecessor stage']);
  git(second, ['push', '-q', 'origin', fx.base]);
  return git(second, ['rev-parse', 'HEAD']).trim();
}

function originHeadRecorded(dir) {
  try {
    git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    return true;
  } catch (_e) {
    return false;
  }
}

test('stage branch forks off origin/<default>, not the stale stage branch HEAD sits on', () => {
  // The a-20260813-223153 regression: HEAD is on stage 1's branch carrying an
  // un-squashed local commit while origin/<default> holds the squashed truth.
  // The old `checkout -b` off-HEAD code forks stage 2 off the stage-1 tip and
  // this test FAILS; the base-fresh code forks off origin/<default>.
  const fx = gitFixture();
  const branch1 = stage.dispatch(['branch', '1'], { cwd: fx.dir }).branch;
  fs.writeFileSync(path.join(fx.dir, 'stale.txt'), 'un-squashed stage-1 work\n');
  git(fx.dir, ['add', '-A']);
  git(fx.dir, ['commit', '-q', '-m', 'stage-1 local (not on origin)']);
  const originTip = git(fx.dir, ['rev-parse', `refs/remotes/origin/${fx.base}`]).trim();
  assert(
    git(fx.dir, ['rev-parse', 'HEAD']).trim() !== originTip,
    'HEAD must be stale for the test to mean anything',
  );
  // The ahead-note travels through process.stderr.write (never blocks) —
  // capture it here where the condition genuinely fires.
  const notes = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    notes.push(String(chunk));
    return realWrite.call(process.stderr, chunk, ...rest);
  };
  let r;
  try {
    r = stage.dispatch(['branch', '2'], { cwd: fx.dir });
  } finally {
    process.stderr.write = realWrite;
  }
  assertEqual(r.created, true);
  assertEqual(r.baseFrom, 'remote-head');
  assertEqual(git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), r.branch);
  assertEqual(
    git(fx.dir, ['rev-parse', 'HEAD']).trim(),
    originTip,
    'stage 2 must fork off origin default, not the stage-1 tip',
  );
  assert(
    notes.some((n) => n.includes('stage-branch-note') && n.includes(branch1)),
    'the unpushed-commits note must name the starting branch',
  );
});

test('stage branch fetches before resolving: forks off the ADVANCED origin tip', () => {
  const fx = gitFixture();
  const advanced = advanceOrigin(fx);
  assert(
    git(fx.dir, ['rev-parse', `refs/remotes/origin/${fx.base}`]).trim() !== advanced,
    'remote-tracking ref must be frozen pre-verb',
  );
  const r = stage.dispatch(['branch', '1'], { cwd: fx.dir });
  assertEqual(r.created, true);
  assertEqual(
    git(fx.dir, ['rev-parse', 'HEAD']).trim(),
    advanced,
    'the fork base must reflect the fetch, not the clone-time ref',
  );
});

test('stage branch with no origin/HEAD, on a non-stage branch: forks off the current ref (parity)', () => {
  const fx = gitFixture({ remoteHead: false });
  const headBefore = git(fx.dir, ['rev-parse', 'HEAD']).trim();
  const r = stage.dispatch(['branch', '1'], { cwd: fx.dir });
  assertEqual(r.created, true);
  assertEqual(r.baseFrom, 'checkout');
  assertEqual(r.base, fx.base);
  assertEqual(
    git(fx.dir, ['rev-parse', 'HEAD']).trim(),
    headBefore,
    'parity: fork off the ref the checkout was on',
  );
  // The verb DID fetch — prove the followRemoteHEAD suppression held and no
  // git version invented a recorded default branch mid-test.
  assert(!originHeadRecorded(fx.dir), 'origin/HEAD must still be absent after the verb ran');
});

test('stage branch with no origin/HEAD, on a stage branch: refuses actionably', () => {
  const fx = gitFixture({ remoteHead: false });
  stage.dispatch(['branch', '1'], { cwd: fx.dir }); // now sitting on a stage branch
  let err = null;
  try {
    stage.dispatch(['branch', '2'], { cwd: fx.dir });
  } catch (e) {
    err = e;
  }
  assert(err !== null, 'stacking stage 2 on stage 1 with no recorded default must refuse');
  assert(/stage branch/.test(err.message), 'refusal names the stage-branch hazard');
  assert(err.message.includes('git remote set-head origin --auto'), 'refusal carries the fix');
  assert(!originHeadRecorded(fx.dir), 'origin/HEAD must still be absent after the verb ran');
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    stage.branchName(fx.dir, 1),
    'a refusal moves nothing',
  );
});

test('stage branch on an existing branch: checks out, never re-creates or re-bases', () => {
  const fx = gitFixture();
  const first = stage.dispatch(['branch', '1'], { cwd: fx.dir });
  fs.writeFileSync(path.join(fx.dir, 'work.txt'), 'stage work\n');
  git(fx.dir, ['add', '-A']);
  git(fx.dir, ['commit', '-q', '-m', 'stage-1 work']);
  const tip = git(fx.dir, ['rev-parse', 'HEAD']).trim();
  git(fx.dir, ['checkout', '-q', fx.base]);
  advanceOrigin(fx); // even with origin moved, re-dispatch must not move the base
  const again = stage.dispatch(['branch', '1'], { cwd: fx.dir });
  assertEqual(again.created, false);
  assertEqual(again.branch, first.branch);
  assertEqual(git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), first.branch);
  assertEqual(
    git(fx.dir, ['rev-parse', 'HEAD']).trim(),
    tip,
    'existing branch keeps its tip — no silent re-base',
  );
});

test('stage branch sets NO upstream (--no-track keeps gh pr create head detection honest)', () => {
  const fx = gitFixture();
  stage.dispatch(['branch', '1'], { cwd: fx.dir });
  let hasUpstream = true;
  try {
    git(fx.dir, ['rev-parse', '--abbrev-ref', '@{u}']);
  } catch (_e) {
    hasUpstream = false;
  }
  assert(
    !hasUpstream,
    'a stage branch must have no upstream, or gh pr create picks the wrong head',
  );
});

test('stage branch --dry-run performs no git at all', () => {
  const fx = gitFixture();
  const advanced = advanceOrigin(fx);
  const trackedBefore = git(fx.dir, ['rev-parse', `refs/remotes/origin/${fx.base}`]).trim();
  assert(trackedBefore !== advanced, 'origin must be ahead so a fetch would be observable');
  const r = stage.dispatch(['branch', '1'], { cwd: fx.dir, 'dry-run': true });
  assertEqual(r.created, false);
  assertEqual(r.raw, r.branch);
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    fx.base,
    'still on the same ref',
  );
  assertEqual(git(fx.dir, ['branch', '--list', r.branch]).trim(), '', 'no branch was created');
  assertEqual(
    git(fx.dir, ['rev-parse', `refs/remotes/origin/${fx.base}`]).trim(),
    trackedBefore,
    'no fetch happened — the remote-tracking ref did not move',
  );
});
