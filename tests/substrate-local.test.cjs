// Stage 80 (ADR-0029) — the local delivery-substrate driver, tested against
// contract local-work-item v1 (frozen):
//   - contract mapping: work-item record fixtures → the exact issues[] shape
//     the ledger reads; stage branches + gate-run records → the prs[] shape,
//     with EVERY honesty-rule branch pinned (green / red / missing record /
//     stale sha / empty gates ⇒ UNKNOWN; corrupt/invalid record ⇒
//     verified:false — never guessed).
//   - derive-equivalence: the SAME logical state as a gh-shaped snapshot
//     fixture and as local records yields IDENTICAL ledger.project output —
//     the derive layer cannot tell substrates apart.
//   - label semantics through next.decide over file-backed records:
//     announce-once, verity:approved consume-on-resume, needs-human parking.
//   - write-ops round-trip: create/label/close are engine-performed record
//     edits, committed (ADR-0026), idempotent, and re-readable via the
//     acquirer.
//   - substrate dispatch: absent/unreadable policy resolves 'github'
//     (byte-identical seam); `substrate: local` activates the driver with
//     zero gh involvement (no gh stub exists on PATH here — any gh call
//     would fail loudly).
// All fixtures are mkdtemp git repos; no network, no gh.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../verity/bin/lib/ledger.cjs');
const next = require('../verity/bin/lib/next.cjs');
const operatorAct = require('../verity/bin/lib/operator-act.cjs');
const labels = require('../verity/bin/lib/labels.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');
const workItems = require('../verity/bin/lib/work-items.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeStageFile(dir, n, slug, title, deps = 'none') {
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', `stage-${n}-${slug}.md`),
    `# Stage ${n}: ${title}\n\n- **Type:** feature\n- **Depends on:** ${deps}\n`,
  );
}

// A deterministic fixture repo on branch `main` with one initial commit.
function makeRepo(stages = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-substrate-local-'));
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const s of stages) {
    writeStageFile(dir, s.n, s.slug, s.title, s.deps);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

// A stage branch with one unique commit, back on main afterwards.
function makeStageBranch(dir, branch) {
  git(dir, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, `${branch.replace(/\//g, '-')}.txt`), 'work\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `work on ${branch}`);
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', 'main');
  return sha;
}

function writeGateRun(dir, branch, record) {
  const file = path.join(dir, '.verity', 'gate-runs', `${sub.branchSlug(branch)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record, null, 2));
}

function greenGateRun(branch, sha) {
  return {
    schema: 1,
    branch,
    sha,
    started_at: '2026-08-19T00:00:00Z',
    finished_at: '2026-08-19T00:01:00Z',
    gates: [
      { name: 'test', command: 'npm test', exit_code: 0 },
      { name: 'lint', command: 'npx biome ci .', exit_code: 0 },
    ],
  };
}

// --- write-ops round-trip (contract §Schema; ADR-0026 engine-performed) ------

test('local: createWorkItem writes the contract v1 record, commits it, and round-trips', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  const rec = sub.createWorkItem(dir, { title: '[stage 1] First', labels: ['feature'] });
  assertEqual(rec.number, 1, 'first record gets number 1');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.verity', 'work-items', '1.json')));
  assertEqual(onDisk.schema, 1);
  assertEqual(onDisk.title, '[stage 1] First');
  assertEqual(onDisk.state, 'OPEN');
  assertEqual(JSON.stringify(onDisk.labels), '["feature"]');
  assertEqual(JSON.stringify(onDisk.assignees), '[]');
  assert(typeof onDisk.created_at === 'string' && typeof onDisk.updated_at === 'string');
  // Committed (worker-owned, ADR-0026): a clean tree and a commit naming the item.
  assertEqual(git(dir, 'status', '--porcelain').trim(), '', 'record commit leaves a clean tree');
  assert(git(dir, 'log', '--oneline').includes('work-item #1'), 'commit names the work-item');
  // Round-trip via the READ half — the exact issue-snapshot field set.
  const snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.verified, true);
  assertEqual(snap.online, true);
  assertEqual(
    JSON.stringify(snap.issues),
    JSON.stringify([
      {
        number: 1,
        title: '[stage 1] First',
        state: 'OPEN',
        labels: ['feature'],
        assignees: [],
      },
    ]),
  );
  // Numbers are never reused: the next create gets 2.
  const rec2 = sub.createWorkItem(dir, { title: '[stage 2] Second' });
  assertEqual(rec2.number, 2);
});

test('local: label add/remove and close are idempotent committed edits that round-trip', () => {
  const dir = makeRepo([]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  assertEqual(sub.addLabel(dir, 1, 'verity:approved').changed, true);
  assertEqual(sub.addLabel(dir, 1, 'verity:approved').changed, false, 'add is idempotent');
  const commitsAfterAdd = git(dir, 'rev-list', '--count', 'HEAD').trim();
  assertEqual(sub.addLabel(dir, 1, 'verity:approved').changed, false);
  assertEqual(
    git(dir, 'rev-list', '--count', 'HEAD').trim(),
    commitsAfterAdd,
    'a no-op label add commits nothing',
  );
  assertEqual(sub.removeLabel(dir, 1, 'verity:approved').changed, true);
  assertEqual(sub.removeLabel(dir, 1, 'verity:approved').changed, false, 'remove is idempotent');
  assertEqual(sub.removeLabel(dir, 99, 'anything').changed, false, 'absent record: gh-404 rule');
  assertEqual(sub.closeWorkItem(dir, 1).changed, true);
  assertEqual(sub.closeWorkItem(dir, 1).changed, false, 'close is idempotent');
  const snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.issues[0].state, 'CLOSED');
  assertEqual(snap.issues[0].labels.length, 0);
  assertEqual(git(dir, 'status', '--porcelain').trim(), '', 'every write op committed');
});

test('local: write ops against a missing or corrupt record fail loudly (never guess)', () => {
  const dir = makeRepo([]);
  let threw = false;
  try {
    sub.addLabel(dir, 7, 'x');
  } catch (err) {
    threw = true;
    assert(err.message.includes('no local work-item record'), err.message);
  }
  assert(threw, 'addLabel on a missing record throws');
  fs.mkdirSync(path.join(dir, '.verity', 'work-items'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'work-items', '3.json'), 'not json');
  threw = false;
  try {
    sub.closeWorkItem(dir, 3);
  } catch (err) {
    threw = true;
    assert(err.message.includes('unreadable'), err.message);
  }
  assert(threw, 'close on a corrupt record throws');
});

// --- READ half: contract mapping + EVERY honesty-rule branch -----------------

test('honesty: no gate-run record ⇒ EMPTY rollup ⇒ rollupState UNKNOWN', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  makeStageBranch(dir, 'feat/stage-1-first');
  const snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.verified, true);
  assertEqual(snap.prs.length, 1);
  const pr = snap.prs[0];
  assertEqual(pr.state, 'OPEN');
  assertEqual(pr.headRefName, 'feat/stage-1-first');
  assertEqual(pr.number, 1, 'PR numbered by the matched work-item record');
  assertEqual(pr.statusCheckRollup.length, 0);
  assertEqual(ledger.rollupState(pr.statusCheckRollup), ledger.CI_UNKNOWN);
  assertEqual(pr.ciState, ledger.CI_UNKNOWN);
  assertEqual(pr.ciGreen, false);
  assert(typeof pr.createdAt === 'string' && Number.isFinite(Date.parse(pr.createdAt)));
});

test('honesty: current-sha all-zero gate-run ⇒ SUCCESS entries ⇒ green', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const sha = makeStageBranch(dir, 'feat/stage-1-first');
  writeGateRun(dir, 'feat/stage-1-first', greenGateRun('feat/stage-1-first', sha));
  const pr = sub.fetchLocalSnapshot(dir).prs[0];
  assertEqual(pr.statusCheckRollup.length, 2, 'one entry per gate');
  assertEqual(pr.statusCheckRollup[0].conclusion, 'SUCCESS');
  assertEqual(pr.statusCheckRollup[0].name, 'test');
  assertEqual(pr.ciState, ledger.CI_GREEN);
  assertEqual(pr.ciGreen, true);
});

test('honesty: any nonzero exit_code ⇒ a FAILURE entry ⇒ red (never green)', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const sha = makeStageBranch(dir, 'feat/stage-1-first');
  const run = greenGateRun('feat/stage-1-first', sha);
  run.gates[1].exit_code = 2;
  writeGateRun(dir, 'feat/stage-1-first', run);
  const pr = sub.fetchLocalSnapshot(dir).prs[0];
  assertEqual(pr.statusCheckRollup[1].conclusion, 'FAILURE');
  assertEqual(pr.ciState, ledger.CI_RED);
  assertEqual(pr.ciGreen, false);
});

test('honesty: stale sha ⇒ UNKNOWN (green is never carried forward)', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  makeStageBranch(dir, 'feat/stage-1-first');
  writeGateRun(
    dir,
    'feat/stage-1-first',
    greenGateRun('feat/stage-1-first', '0000000000000000000000000000000000000000'),
  );
  const pr = sub.fetchLocalSnapshot(dir).prs[0];
  assertEqual(pr.statusCheckRollup.length, 0);
  assertEqual(pr.ciState, ledger.CI_UNKNOWN);
});

test('honesty: empty gates[] ⇒ UNKNOWN (an empty run proves nothing)', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const sha = makeStageBranch(dir, 'feat/stage-1-first');
  const run = greenGateRun('feat/stage-1-first', sha);
  run.gates = [];
  writeGateRun(dir, 'feat/stage-1-first', run);
  const pr = sub.fetchLocalSnapshot(dir).prs[0];
  assertEqual(pr.statusCheckRollup.length, 0);
  assertEqual(pr.ciState, ledger.CI_UNKNOWN);
});

test('honesty: corrupt or schema-invalid gate-run ⇒ UNKNOWN + verified:false', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const sha = makeStageBranch(dir, 'feat/stage-1-first');
  writeGateRun(dir, 'feat/stage-1-first', '{ nope');
  let snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.verified, false, 'corrupt gate-run cannot be verified past');
  assertEqual(snap.prs[0].ciState, ledger.CI_UNKNOWN);
  assertEqual(snap.failures[0].source, 'gate-runs');
  // Schema-invalid (gates entries missing exit_code) — same refusal.
  writeGateRun(dir, 'feat/stage-1-first', {
    schema: 1,
    branch: 'feat/stage-1-first',
    sha,
    started_at: 'x',
    finished_at: 'x',
    gates: [{ name: 'test' }],
  });
  snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.verified, false);
  assertEqual(snap.prs[0].ciState, ledger.CI_UNKNOWN);
});

test('honesty: corrupt / schema-invalid work-item record ⇒ verified:false, never guessed', () => {
  const dir = makeRepo([]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  fs.writeFileSync(path.join(dir, '.verity', 'work-items', '2.json'), '{ nope');
  let snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.verified, false);
  assertEqual(snap.issues.length, 1, 'the unreadable record is excluded, not invented');
  assertEqual(snap.failures[0].reason, 'record-unreadable');
  // Schema-invalid: lowercase state (the gh --json casing is normative).
  fs.writeFileSync(
    path.join(dir, '.verity', 'work-items', '2.json'),
    JSON.stringify({
      schema: 1,
      number: 2,
      title: '[stage 2] Second',
      state: 'open',
      labels: [],
      assignees: [],
      created_at: 'x',
      updated_at: 'x',
    }),
  );
  snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.verified, false);
  assertEqual(snap.failures[0].reason, 'record-invalid');
  // And next.decide REFUSES the unverified snapshot — stage-20 semantics.
  const proj = ledger.project(dir, { snapshot: snap });
  const decision = next.decide(proj, snap);
  assertEqual(decision.action, 'gated');
  assertEqual(decision.gate, 'state:unverified');
});

test('prs: merged branch reads MERGED; a just-forked branch has no PR entry', () => {
  const dir = makeRepo([
    { n: 1, slug: 'first', title: 'First' },
    { n: 2, slug: 'second', title: 'Second', deps: '1' },
  ]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  makeStageBranch(dir, 'feat/stage-1-first');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge stage 1', 'feat/stage-1-first');
  git(dir, 'branch', '-q', 'feat/stage-2-second'); // forked, zero commits of its own
  const snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.prs.length, 1, 'the empty fork synthesizes no PR');
  assertEqual(snap.prs[0].state, 'MERGED');
  const proj = ledger.project(dir, { snapshot: snap });
  assertEqual(proj.stages[0].status, 'merged');
});

// --- derive-equivalence: the derive layer cannot tell substrates apart -------

test('derive-equivalence: identical ledger.project output from gh-shaped and local snapshots', () => {
  const dir = makeRepo([
    { n: 1, slug: 'first', title: 'First' },
    { n: 2, slug: 'second', title: 'Second', deps: '1' },
    { n: 3, slug: 'third', title: 'Third', deps: '2' },
  ]);
  // Local records: stage 1 merged (record CLOSED + branch merged), stage 2 in
  // review (branch open, green gate-run), stage 3 untouched.
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  sub.createWorkItem(dir, { title: '[stage 2] Second' });
  sub.closeWorkItem(dir, 1);
  makeStageBranch(dir, 'feat/stage-1-first');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge stage 1', 'feat/stage-1-first');
  const sha2 = makeStageBranch(dir, 'feat/stage-2-second');
  writeGateRun(dir, 'feat/stage-2-second', greenGateRun('feat/stage-2-second', sha2));
  const local = sub.fetchLocalSnapshot(dir);
  assertEqual(local.verified, true);

  // The SAME logical state, gh-shaped (numbers matching the local records).
  const ghShaped = {
    issues: [
      { number: 1, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
      { number: 2, title: '[stage 2] Second', state: 'OPEN', labels: [], assignees: [] },
    ],
    prs: [
      {
        number: 1,
        title: '[stage 1] First',
        state: 'MERGED',
        headRefName: 'feat/stage-1-first',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      },
      {
        number: 2,
        title: '[stage 2] Second',
        state: 'OPEN',
        headRefName: 'feat/stage-2-second',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      },
    ],
    tags: [],
  };
  assertEqual(
    JSON.stringify(ledger.project(dir, { snapshot: local })),
    JSON.stringify(ledger.project(dir, { snapshot: ghShaped })),
    'the derive layer must not be able to tell which substrate produced the snapshot',
  );
});

// --- label semantics through next.decide over file-backed records ------------

test('labels via decide: needs-human parks, awaiting announces once, approved resumes (single-use)', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const decideNow = () => {
    const snap = sub.fetchLocalSnapshot(dir);
    return next.decide(ledger.project(dir, { snapshot: snap }), snap);
  };
  // Baseline: workable.
  assertEqual(decideNow().action, 'work');
  // Parking: verity:needs-human on the record ⇒ skipped, named in the reason.
  sub.addLabel(dir, 1, 'verity:needs-human');
  let d = decideNow();
  assertEqual(d.action, 'idle');
  assert(d.reason.includes('parked'), d.reason);
  sub.removeLabel(dir, 1, 'verity:needs-human');
  // Announced gate: the awaiting-approval label IS the announcement.
  sub.addLabel(dir, 1, 'verity:awaiting-approval');
  d = decideNow();
  assertEqual(d.action, 'gated');
  assertEqual(d.announced, true, 'label-derived gate must not be re-announced');
  // Resume: verity:approved alongside the gate reads as work again.
  sub.addLabel(dir, 1, 'verity:approved');
  assertEqual(decideNow().action, 'work');
  // Consume-on-resume (the worker's T10 job, via the same local ops): both
  // labels removed ⇒ still workable; re-adding awaiting alone gates again —
  // the token was single-use, not a standing approval.
  sub.removeLabel(dir, 1, 'verity:approved');
  sub.removeLabel(dir, 1, 'verity:awaiting-approval');
  assertEqual(decideNow().action, 'work');
  sub.addLabel(dir, 1, 'verity:awaiting-approval');
  assertEqual(decideNow().action, 'gated');
});

// --- substrate dispatch seam -------------------------------------------------

test('dispatch: absent/unreadable policy resolves github; substrate: local activates the driver', () => {
  const dir = makeRepo([]);
  assertEqual(sub.resolveSubstrate(dir), 'github', 'no policy file ⇒ github (byte-identical)');
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'substrate: local\n');
  assertEqual(sub.resolveSubstrate(dir), 'local');
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  // No gh exists in this test path — a github route would throw/report failures.
  const snap = sub.fetchSubstrateSnapshot(dir);
  assertEqual(snap.online, true);
  assertEqual(snap.verified, true);
  assertEqual(snap.issues.length, 1);
});

// --- write-site dispatches ---------------------------------------------------

test('work-items: reconcile creates local records from stage files (idempotent)', () => {
  const dir = makeRepo([
    { n: 1, slug: 'first', title: 'First' },
    { n: 2, slug: 'second', title: 'Second', deps: '1' },
  ]);
  const first = workItems.reconcileWorkItems(dir, { flag: true, substrate: 'local' });
  assertEqual(JSON.stringify(first.created), '[1,2]');
  const snap = sub.fetchLocalSnapshot(dir);
  assertEqual(snap.issues.length, 2);
  assertEqual(snap.issues[0].title, '[stage 1] First');
  assertEqual(JSON.stringify(snap.issues[0].labels), '["feature","needs-triage"]');
  // Idempotent: the `[stage N]` key skips existing records.
  const second = workItems.reconcileWorkItems(dir, { flag: true, substrate: 'local' });
  assertEqual(JSON.stringify(second.created), '[]');
  assertEqual(JSON.stringify(second.skipped), '[1,2]');
});

test('work-items: an unreadable local store refuses to create (never double-creates)', () => {
  const dir = makeRepo([{ n: 1, slug: 'first', title: 'First' }]);
  fs.mkdirSync(path.join(dir, '.verity', 'work-items'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'work-items', '1.json'), '{ nope');
  const res = workItems.reconcileWorkItems(dir, { flag: true, substrate: 'local' });
  assertEqual(res.created.length, 0);
  assert(typeof res.error === 'string' && res.error.includes('could not be read'), res.error);
});

test('labels: ensureLabels is an honest no-op on the local substrate (zero gh calls)', () => {
  const dir = makeRepo([]);
  const boom = () => {
    throw new Error('gh must not be called on the local substrate');
  };
  const res = labels.ensureLabels(dir, boom, { substrate: 'local' });
  assertEqual(res.ok, true);
  assertEqual(res.skipped, true);
  assertEqual(res.substrate, 'local');
  // And via the on-disk policy (the production resolution path).
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'substrate: local\n');
  assertEqual(labels.ensureLabels(dir, boom).ok, true);
});

test('operator act: label verbs edit local records; worker-facing verbs refuse honestly', () => {
  const dir = makeRepo([]);
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  sub.addLabel(dir, 1, 'verity:awaiting-approval');
  const boom = () => {
    throw new Error('gh must not be called on the local substrate');
  };
  const opts = { cwd: dir, substrate: 'local', run: boom };
  // approve — the single-use resume token lands on the record.
  let res = operatorAct.act('approve', ['1'], opts);
  assertEqual(res.ok, true, res.reason);
  assert(sub.readWorkItem(dir, 1).labels.includes('verity:approved'));
  // reject — the swap: token + gate off, needs-human on (idempotent removes).
  res = operatorAct.act('reject', ['1'], opts);
  assertEqual(res.ok, true, res.reason);
  const rec = sub.readWorkItem(dir, 1);
  assert(!rec.labels.includes('verity:approved'));
  assert(!rec.labels.includes('verity:awaiting-approval'));
  assert(rec.labels.includes('verity:needs-human'));
  // clear-needs-human — unpark.
  res = operatorAct.act('clear-needs-human', ['1'], opts);
  assertEqual(res.ok, true, res.reason);
  assert(!sub.readWorkItem(dir, 1).labels.includes('verity:needs-human'));
  // request-changes — the label applies, but the comment has no local surface:
  // fail-closed honest ok:false, never a fabricated comment.
  res = operatorAct.act('request-changes', ['1'], opts);
  assertEqual(res.ok, false);
  assert(res.reason.includes('no'), res.reason);
  assert(sub.readWorkItem(dir, 1).labels.includes('verity:needs-human'));
  // run-once / circuit — LIFTED by stage 85 (the worker's gh sites are
  // substrate-aware): circuit arms the record-label breaker the local worker
  // genuinely reads (still zero gh — `run` throws); run-once without a
  // resolved repo id still refuses honestly (the worker CLI requires the
  // run-naming --repo pointer). Full lifted-behavior coverage lives in
  // operator-local-contract.test.cjs (stage 85 tests).
  res = operatorAct.act('run-once', [], { cwd: dir, substrate: 'local' });
  assertEqual(res.ok, false);
  assert(res.reason.includes('no repository resolved'), res.reason);
  res = operatorAct.act('circuit', ['open', '1'], opts);
  assertEqual(res.ok, true, res.reason);
  assert(sub.readWorkItem(dir, 1).labels.includes('verity:circuit-open'));
  res = operatorAct.act('circuit', ['close', '1'], opts);
  assertEqual(res.ok, true, res.reason);
  assert(!sub.readWorkItem(dir, 1).labels.includes('verity:circuit-open'));
});
