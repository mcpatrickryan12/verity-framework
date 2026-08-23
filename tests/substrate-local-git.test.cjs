// Stage 81 (ADR-0029 §1 + §3) — the local substrate's git story, tested with
// REAL git in mkdtemp repos (no network, no gh on any asserted path):
//   - bare-origin provision: sibling bare repo wired as origin, origin/HEAD
//     set by the EXPLICIT set-head (stage-77 parity), so the EXISTING stage
//     lifecycle (agents/git-lifecycle.cjs) resolves its base off
//     `origin/<default>` UNCHANGED — no code fork.
//   - the stage-77/78 regression replayed locally: merge stage 1 locally,
//     then stage 2's branch forks off the MERGED base, not the stale scaffold.
//   - merge-bar honesty at BOTH merge sites (trust.merge, review.merge):
//     verified green (stage-80 snapshot) ⇒ engine-performed --no-ff merge +
//     bare origin advances + work-item record closed; red refuses; UNKNOWN
//     refuses; refusal shapes match the github path's refusals. UNKNOWN never
//     merges.
//   - role-capability narrowing (agents/policy.cjs narrowForSubstrate): a
//     'local' projection carries no github_read/github_write/network; any
//     other substrate returns the SAME policy object (github byte-identical);
//     agent-exec rejects --substrate local for a provider without a
//     narrowForSubstrate hook — never a silently ignored knob (stage 82 gave
//     claude the hook: allowlist stripping, pinned in tests/gates.test.cjs).
//   - stage 83 LIFTED the stage-79 startup refusal: assertSubstrateSupported
//     now admits 'github' AND 'local' (the driver completed across stages
//     80–82); anything else still refuses fail-closed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const gitLifecycle = require('../verity/bin/lib/agents/git-lifecycle.cjs');
const rolePolicy = require('../verity/bin/lib/agents/policy.cjs');
const review = require('../verity/bin/lib/review.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');
const trust = require('../verity/bin/lib/trust.cjs');
const worker = require('../verity/worker/index.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeStageFile(dir, n, slug, title) {
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', `stage-${n}-${slug}.md`),
    `# Stage ${n}: ${title}\n\n- **Type:** feature\n- **Depends on:** none\n`,
  );
}

// A deterministic fixture repo on branch `main` with one initial commit.
function makeRepo(stages = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-local-git-'));
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const s of stages) {
    writeStageFile(dir, s.n, s.slug, s.title);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function writeGateRun(dir, branch, record) {
  const file = path.join(dir, '.verity', 'gate-runs', `${sub.branchSlug(branch)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

function gateRun(branch, sha, exitCode) {
  return {
    schema: 1,
    branch,
    sha,
    started_at: '2026-08-19T00:00:00Z',
    finished_at: '2026-08-19T00:01:00Z',
    gates: [{ name: 'test', command: 'npm test', exit_code: exitCode }],
  };
}

// Cut a stage branch via the EXISTING lifecycle (plan → assertProvidable →
// begin — the exact hooks the coordinator drives; no fork, no reimplementation)
// and leave one committed unit of work on it. Returns { branch, sha, started }.
function cutStageBranchViaLifecycle(dir, n) {
  const plan = gitLifecycle.plan({
    cwd: dir,
    role: 'build',
    roleArgs: [String(n)],
    runId: null,
    policy: { capabilities: { git_write: true } },
  });
  assert(plan !== null, `lifecycle plan engages for stage ${n}`);
  const provided = gitLifecycle.assertProvidable(dir, plan);
  const started = gitLifecycle.begin(dir, provided);
  fs.writeFileSync(path.join(dir, `work-${n}.txt`), `stage ${n} work\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `stage ${n} work`);
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', 'main');
  return { branch: started.branch, sha, started, provided };
}

function assertThrows(fn, re, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert(err !== null, `${msg}: expected a throw`);
  assert(re.test(err.message), `${msg}: message ${JSON.stringify(err.message)} matches ${re}`);
  return err;
}

// --- ADR-0029 §1: bare-origin provision --------------------------------------

test('stage 81: provisionBareOrigin creates a sibling bare origin with an explicit origin/HEAD', () => {
  const dir = makeRepo([]);
  const { barePath, branch } = sub.provisionBareOrigin(dir);
  assertEqual(branch, 'main');
  assertEqual(barePath, path.join(path.dirname(dir), `${path.basename(dir)}-origin.git`));
  assert(fs.existsSync(path.join(barePath, 'HEAD')), 'bare repo exists');
  // The remote is wired and the default branch pushed.
  assertEqual(git(dir, 'remote', 'get-url', 'origin').trim(), barePath);
  assertEqual(
    git(barePath, 'rev-parse', 'main').trim(),
    git(dir, 'rev-parse', 'main').trim(),
    'the default branch was pushed to the bare origin',
  );
  // The load-bearing bit (resolveBase rung 1): origin/HEAD exists, explicitly.
  assertEqual(
    git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim(),
    'origin/main',
    'explicit set-head recorded the default branch (stage-77 parity)',
  );
});

test('stage 81: provisionBareOrigin refuses to rewire an existing origin', () => {
  const dir = makeRepo([]);
  sub.provisionBareOrigin(dir);
  assertThrows(
    () => sub.provisionBareOrigin(dir),
    /already has an 'origin' remote/,
    'second provision refuses',
  );
});

test('stage 81: a stage branch cut via the EXISTING lifecycle forks off origin/<default> (rung 1, no code fork)', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.provisionBareOrigin(dir);
  const plan = gitLifecycle.plan({
    cwd: dir,
    role: 'build',
    roleArgs: ['1'],
    runId: null,
    policy: { capabilities: { git_write: true } },
  });
  const provided = gitLifecycle.assertProvidable(dir, plan);
  // rung 1 — the repository's own record of the default branch, set by the
  // provision helper; NOT the checkout fallback, NOT a refusal.
  assertEqual(provided.baseFrom, 'remote-head');
  assertEqual(provided.base, 'origin/main');
  const started = gitLifecycle.begin(dir, provided);
  assertEqual(started.created, true, 'branch was created');
  assertEqual(
    git(dir, 'rev-parse', started.branch).trim(),
    git(dir, 'rev-parse', 'origin/main').trim(),
    'the stage branch forks off origin/<default>',
  );
  git(dir, 'checkout', '-q', 'main');
});

// --- ADR-0029 §3: engine-performed local merge + the 77/78 regression --------

test('stage 81: green snapshot ⇒ review.merge performs --no-ff, advances the bare origin, closes the record; stage 2 then forks off the MERGED base (77/78 replayed locally)', () => {
  const dir = makeRepo([
    { n: 1, slug: 'first', title: 'First' },
    { n: 2, slug: 'second', title: 'Second' },
  ]);
  sub.provisionBareOrigin(dir);
  sub.createWorkItem(dir, { title: '[stage 1] First', labels: ['feature'] });
  const scaffoldSha = git(dir, 'rev-parse', 'origin/main').trim();

  const s1 = cutStageBranchViaLifecycle(dir, 1);
  writeGateRun(dir, s1.branch, gateRun(s1.branch, s1.sha, 0));

  // The snapshot reads a verified green OPEN PR #1 for the branch.
  assertEqual(sub.localCiStateFor(dir, 1), 'green');
  const res = review.merge(dir, 1, { substrate: 'local' });
  assertEqual(res.merged, true);

  // Engine-performed --no-ff: the branch tip is an ancestor of main, and a
  // REAL merge commit exists (stage commits are KEPT — the accepted divergence
  // from the gh path's squash). The tip itself is the record-close commit
  // (merge → close → one push), so look for the merge by its message.
  git(dir, 'merge-base', '--is-ancestor', s1.branch, 'main');
  assert(
    git(dir, 'log', '--merges', '--format=%s', 'main').includes(
      `verity: merge ${s1.branch} (#1) — engine-performed local merge (ADR-0029 §3)`,
    ),
    'the --no-ff merge commit exists with the engine-performed message',
  );
  // The bare origin's default branch ADVANCED — this is what un-stales the
  // next stage's base (the stage-77/78 fix, local edition).
  const bare = git(dir, 'remote', 'get-url', 'origin').trim();
  assertEqual(
    git(bare, 'rev-parse', 'main').trim(),
    git(dir, 'rev-parse', 'main').trim(),
    'the merge was pushed to the bare origin',
  );
  // The stage's work-item record is CLOSED (the local `Closes #N`).
  assertEqual(sub.readWorkItem(dir, 1).state, 'CLOSED');
  // And the snapshot now derives the PR as MERGED.
  const snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.prs.find((p) => p.number === 1).state, 'MERGED');

  // Stage 2, cut via the SAME lifecycle: fetch-before-branch refreshes
  // origin/main from the bare repo, so the new branch forks off the MERGED
  // base — never the stale scaffold (the exact 77/78 defect, replayed).
  const s2 = cutStageBranchViaLifecycle(dir, 2);
  const s2Base = git(dir, 'rev-parse', `${s2.branch}~1`).trim();
  assert(s2Base !== scaffoldSha, 'stage 2 did NOT fork off the stale scaffold');
  assertEqual(
    s2Base,
    git(dir, 'rev-parse', 'origin/main').trim(),
    'stage 2 forked off the refreshed origin/<default>',
  );
  git(dir, 'merge-base', '--is-ancestor', s1.branch, s2.branch); // throws unless contained
});

test('stage 81: merge-bar honesty at review.merge — red refuses, UNKNOWN refuses, shapes match the github refusals', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.provisionBareOrigin(dir);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const s1 = cutStageBranchViaLifecycle(dir, 1);
  const originBefore = git(dir, 'rev-parse', 'origin/main').trim();

  // UNKNOWN (no gate-run record at all) refuses, with the UNVERIFIED shape.
  const unknownErr = assertThrows(
    () => review.merge(dir, 1, { substrate: 'local' }),
    /^refusing to merge PR #1: CI is UNVERIFIED — /,
    'UNKNOWN never merges',
  );
  assert(
    unknownErr.message.endsWith(
      'Unverified is not green (the gate, even when branch protection is unavailable)',
    ),
    'local UNVERIFIED refusal keeps the github refusal shape (same head + tail)',
  );
  // The github path's UNVERIFIED refusal (this repo has no gh remote/checks,
  // so its reading is UNKNOWN too): same head, same tail — only the middle
  // diagnostic names the substrate's honest fact.
  const ghErr = assertThrows(
    () => review.merge(dir, 1, { substrate: 'github' }),
    /^refusing to merge PR #1: CI is UNVERIFIED — /,
    'github path unchanged',
  );
  assert(
    ghErr.message.endsWith(
      'Unverified is not green (the gate, even when branch protection is unavailable)',
    ),
    'github refusal tail unchanged',
  );

  // RED (a fresh gate-run with a nonzero exit) refuses with the byte-identical
  // not-green message the github path throws.
  writeGateRun(dir, s1.branch, gateRun(s1.branch, s1.sha, 1));
  assertEqual(sub.localCiStateFor(dir, 1), 'red');
  assertThrows(
    () => review.merge(dir, 1, { substrate: 'local' }),
    /^refusing to merge PR #1: CI is not green \(the gate, even when branch protection is unavailable\)$/,
    'red never merges',
  );

  // STALE sha (green record for an old head) is UNKNOWN — green is never
  // carried forward (contract honesty rule).
  writeGateRun(dir, s1.branch, gateRun(s1.branch, 'not-the-current-head', 0));
  assertThrows(
    () => review.merge(dir, 1, { substrate: 'local' }),
    /CI is UNVERIFIED/,
    'stale green never merges',
  );

  // Nothing moved: no merge, origin unchanged, record still OPEN.
  assertEqual(git(dir, 'rev-parse', 'origin/main').trim(), originBefore);
  assertEqual(sub.readWorkItem(dir, 1).state, 'OPEN');
  assertEqual(sub.fetchLocalSnapshot(dir).prs.find((p) => p.number === 1).state, 'OPEN');
});

test('stage 81: trust site — checksGreen reads the stage-80 snapshot on local; merge performs --no-ff on green and refuses UNKNOWN', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.provisionBareOrigin(dir);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const s1 = cutStageBranchViaLifecycle(dir, 1);
  const ghOpts = { substrate: 'local', cwd: dir };

  // UNKNOWN: not green, and the merge act itself refuses (belt — UNKNOWN
  // never merges even if a caller skipped decideMerge).
  assertEqual(trust.checksGreen(1, ghOpts), false, 'UNKNOWN is not green');
  assertThrows(() => trust.merge(1, ghOpts), /CI is UNVERIFIED/, 'trust.merge refuses UNKNOWN');

  // RED: not green, refused with the not-green shape.
  writeGateRun(dir, s1.branch, gateRun(s1.branch, s1.sha, 2));
  assertEqual(trust.checksGreen(1, ghOpts), false, 'red is not green');
  assertThrows(() => trust.merge(1, ghOpts), /CI is not green/, 'trust.merge refuses red');

  // GREEN: verified reading merges, closes the record, advances the origin.
  writeGateRun(dir, s1.branch, gateRun(s1.branch, s1.sha, 0));
  assertEqual(trust.checksGreen(1, ghOpts), true, 'fresh all-zero gate-run is green');
  const done = trust.merge(1, ghOpts);
  assertEqual(done.merged, true);
  assertEqual(done.method, 'no-ff');
  assertEqual(sub.readWorkItem(dir, 1).state, 'CLOSED');
  const bare = git(dir, 'remote', 'get-url', 'origin').trim();
  assertEqual(git(bare, 'rev-parse', 'main').trim(), git(dir, 'rev-parse', 'main').trim());
});

test('stage 81: trust github path is byte-identical — no substrate (or github) still shells gh pr merge --squash', () => {
  const calls = [];
  const fakeExec = (args) => {
    calls.push(args);
    return '';
  };
  const done = trust.merge(7, { exec: fakeExec });
  assertEqual(done.method, 'squash');
  assertEqual(JSON.stringify(calls), JSON.stringify([['pr', 'merge', '7', '--squash']]));
  const done2 = trust.merge(7, { exec: fakeExec, substrate: 'github' });
  assertEqual(done2.method, 'squash', "explicit 'github' routes identically");
  assertEqual(trust.checksGreen(7, { exec: fakeExec }), true, 'checksGreen still asks gh');
});

// --- role-capability narrowing (spec item 4) ---------------------------------

function writePermissions(dir, caps) {
  const file = path.join(dir, 'role.permissions.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      capabilities: caps,
      codex: { sandbox: 'workspace-write', approval: 'never' },
    }),
  );
  return file;
}

test("stage 81: narrowForSubstrate('local') drops github_read/github_write/network — nothing else; other substrates return the SAME object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-narrow-'));
  const file = writePermissions(dir, {
    read_repository: true,
    write_repository: true,
    run_tests: true,
    git_read: true,
    git_write: true,
    github_read: true,
    github_write: true,
    network: true,
    deploy: false,
  });
  const loaded = rolePolicy.loadPolicy(file);
  const local = rolePolicy.narrowForSubstrate(loaded, 'local');
  assertEqual(local.capabilities.github_read, false, 'github_read narrowed');
  assertEqual(local.capabilities.github_write, false, 'github_write narrowed');
  assertEqual(local.capabilities.network, false, 'network narrowed');
  // Everything else untouched — narrowing only.
  assertEqual(local.capabilities.git_write, true);
  assertEqual(local.capabilities.write_repository, true);
  assertEqual(local.capabilities.run_tests, true);
  assertEqual(JSON.stringify(local.codex), JSON.stringify(loaded.codex));
  // The input policy was NOT mutated (github dispatches still read the grant).
  assertEqual(loaded.capabilities.github_write, true, 'input policy unmutated');
  // github / absent: the IDENTICAL object comes back — byte-identical path.
  assert(rolePolicy.narrowForSubstrate(loaded, 'github') === loaded, "'github' is a no-op");
  assert(rolePolicy.narrowForSubstrate(loaded, undefined) === loaded, 'absent is a no-op');
  // The codex driver hook wraps the same narrowing in its policy bag.
  const bag = codex.narrowForSubstrate({ policy: loaded }, 'local');
  assertEqual(bag.policy.capabilities.github_write, false);
  assert(codex.narrowForSubstrate({ policy: loaded }, 'github').policy === loaded);
});

test('stage 81/82: agent-exec accepts --substrate local for claude (stage 82 narrows its allowlist), and rejects unknown values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-substrate-flag-'));
  // Stage 82 resolved the stage-81 carried item: claude implements
  // narrowForSubstrate (gh/WebFetch/WebSearch stripped from the .tools.json
  // surface), so --substrate local sails past the provider-hook check — the
  // next refusal here is the ordinary unknown-role one, not a substrate error.
  // (Deliberately an unknown role: this asserts the substrate gate alone,
  // with zero provider spawns — tests/gates.test.cjs drives a full stubbed
  // local dispatch and pins the stripped argv.)
  const local = agentExec.dispatch(['no-such-role'], {
    cwd: dir,
    'run-id': 'r1',
    substrate: 'local',
  });
  assertEqual(local.outcome, 'infra_error');
  assert(
    String(local.error).includes('no command file'),
    'claude + local passes the substrate check; refusal is unknown-role',
  );
  assertThrows(
    () => agentExec.dispatch(['build', '1'], { cwd: dir, 'run-id': 'r1', substrate: 'sqlite' }),
    /--substrate must be 'github' or 'local'/,
    'unknown substrate value refuses',
  );
  // Explicit 'github' (the default spelled out) sails past the substrate check
  // — the next refusal is the ordinary unknown-role one, not a substrate error.
  const res = agentExec.dispatch(['no-such-role'], {
    cwd: dir,
    'run-id': 'r1',
    substrate: 'github',
  });
  assertEqual(res.outcome, 'infra_error');
  assert(String(res.error).includes('no command file'), 'refusal is unknown-role, not substrate');
});

// --- worker seams (spec items 3 + 5) -----------------------------------------

test('stage 81: buildMisdeclaredHandoff — github keys on a real PR number (byte-identical); local accepts the pushed stage branch', () => {
  const gated = { outcome: 'gated', artifacts: {} };
  // github (or unit-built undefined substrate): only a real PR number counts.
  assertEqual(
    worker.buildMisdeclaredHandoff({ outcome: 'gated', artifacts: { pr: 114 } }, 'github'),
    true,
  );
  assertEqual(worker.buildMisdeclaredHandoff(gated, 'github'), false, 'no-PR build stop untouched');
  assertEqual(
    worker.buildMisdeclaredHandoff({ ...gated, git_lifecycle: { pushed: true } }, 'github'),
    false,
    'a pushed branch is NOT handoff evidence on github (the PR is)',
  );
  // local: the delivered-for-review evidence is the pushed stage branch.
  assertEqual(
    worker.buildMisdeclaredHandoff(
      { outcome: 'gated', git_lifecycle: { pushed: true, branch: 'feat/stage-1-x' } },
      'local',
    ),
    true,
  );
  assertEqual(worker.buildMisdeclaredHandoff(gated, 'local'), false, 'no evidence, no coercion');
  assertEqual(
    worker.buildMisdeclaredHandoff(
      { outcome: 'success', git_lifecycle: { pushed: true } },
      'local',
    ),
    false,
    'only a gated outcome is ever coerced',
  );
});

test("stage 83: assertSubstrateSupported admits 'local' (drivers complete) — unknown substrates still refuse fail-closed", () => {
  // The stage-79 placeholder refusal is LIFTED: the local driver exists in
  // full (stage 80 store/snapshot, stage 81 git lifecycle + merge, stage 82
  // gate runner), so a local-substrate policy proceeds at startup.
  worker.assertSubstrateSupported({ substrate: 'local' }); // does not throw
  worker.assertSubstrateSupported({ substrate: 'github' }); // byte-identical
  worker.assertSubstrateSupported({}); // absent resolves to github
  // The belt stays fail-closed: a substrate this engine cannot drive is
  // refused with the same slug (exit 30) — never a silent github fallback.
  const err = assertThrows(
    () => worker.assertSubstrateSupported({ substrate: 'sqlite' }),
    /substrate 'sqlite' is not supported/,
    'unknown substrate values still refuse',
  );
  assertEqual(err.slug, 'substrate-unimplemented', 'the refusal keeps its exit-30 slug');
});
