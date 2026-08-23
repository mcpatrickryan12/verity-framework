// Stage 85 (ADR-0029; stage-83 review) — the worker's gh sites are
// SUBSTRATE-AWARE: on `substrate: local` every one of the six sites the
// stage-83 review named (preflight auth, bot identity, circuit-breaker read,
// postComment, parkedResultPointer, recheckApprovedCarrier), plus the scan and
// lock touchpoints a full runOnce crosses, performs an honest local
// equivalent — and a REAL full `verity-worker --once` on a local repo spawns
// ZERO `gh` processes, asserted with a PATH-shimmed sentinel (the stage-83
// technique), startup checks included. Nothing is fabricated: no invented bot
// login, no fabricated-healthy breaker, no silently dropped comment.
//
// Two layers:
//   - in-process per-site units with gh.run/gh.json PATCHED TO THROW (any gh
//     use on local is an immediate failure, not a stubbed success);
//   - the upgraded pipeline e2e: a spawned worker process, gh PATH-shimmed
//     with a sentinel that records-and-fails (exit 97) — the fixture does NOT
//     stub gh — driving build → local gates → review → engine merge to a bare
//     origin, model-free via a scripted claude stub.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gh = require('../verity/bin/lib/gh.cjs');
const scanner = require('../verity/bin/lib/scanner.cjs');
const stage = require('../verity/bin/lib/stage.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A committed local-substrate repo on `main` (the operator-local-contract
// fixture shape).
function makeLocalRepo(policy = 'mode: supervised\nsubstrate: local\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-wlocal-'));
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), policy);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

// Patch gh so ANY use is a loud failure — the local per-site invariant is
// "zero gh", not "gh stubbed green". Restored in finally, always.
function withGhForbidden(fn) {
  const savedRun = gh.run;
  const savedJson = gh.json;
  const boom = () => {
    throw new Error('gh must NOT be invoked on the local substrate (stage 85)');
  };
  gh.run = boom;
  gh.json = boom;
  try {
    return fn();
  } finally {
    gh.run = savedRun;
    gh.json = savedJson;
  }
}

function ctxFor(dir, lines) {
  return {
    cwd: dir,
    repo: 'local-bench/fixture',
    substrate: 'local',
    stdout: (l) => lines.push(`out:${l}`),
    stderr: (l) => lines.push(`err:${l}`),
  };
}

// --- sites 1+2: preflight auth + bot identity ---------------------------------

test('stage 85: startupChecks on local — auth/identity skipped, botLogin null (never fabricated), zero gh', () => {
  const dir = makeLocalRepo();
  const autonomy = require('../verity/bin/lib/autonomy.cjs');
  const policy = autonomy.loadPolicy(dir);
  const lines = [];
  const checks = withGhForbidden(() => worker.startupChecks(ctxFor(dir, lines), policy));
  assertEqual(checks.ok, true, JSON.stringify(checks));
  assertEqual(checks.botLogin, null, 'no GitHub ⇒ no bot login — null, never invented');
  assert(
    lines.some((l) => l.includes('preflight auth skipped') && l.includes('never fabricated')),
    `the skip is announced honestly: ${JSON.stringify(lines)}`,
  );
});

// --- site 3: the circuit breaker ---------------------------------------------

test('stage 85: local circuit breaker — an OPEN record carrying verity:circuit-open halts; CLOSED does not; unreadable store fails closed', () => {
  const dir = makeLocalRepo();
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  const autonomy = require('../verity/bin/lib/autonomy.cjs');
  const policy = autonomy.loadPolicy(dir);
  const run = () => withGhForbidden(() => worker.startupChecks(ctxFor(dir, []), policy));

  // Armed: any OPEN record with the label (the stage-84 circuit_open
  // derivation — exactly what `operator act circuit open` writes).
  sub.addLabel(dir, 1, 'verity:circuit-open');
  let checks = run();
  assertEqual(checks.ok, false, 'armed breaker halts');
  assertEqual(checks.slug, 'circuit-open');
  assert(/work-item record #1/.test(checks.message), checks.message);
  assert(/circuit close/.test(checks.message), 'the refusal names the disarm action');

  // A CLOSED record's label is invisible to the breaker read (OPEN records
  // only — the `--state open` semantics of the github query, carried over).
  sub.closeWorkItem(dir, 1);
  checks = run();
  assertEqual(checks.ok, true, `closed record does not halt: ${checks.message || ''}`);

  // Unreadable store: fail CLOSED — never a fabricated healthy breaker.
  fs.writeFileSync(path.join(dir, '.verity', 'work-items', '1.json'), '{corrupt');
  checks = run();
  assertEqual(checks.ok, false, 'unreadable store halts');
  assertEqual(checks.slug, 'circuit-open');
  assert(/failing closed/.test(checks.message), checks.message);
});

// --- site 4: postComment ------------------------------------------------------

test('stage 85: postComment on local — the full body lands on the run log, headed with its record; never dropped, zero gh', () => {
  const dir = makeLocalRepo();
  const lines = [];
  const ctx = ctxFor(dir, lines);
  withGhForbidden(() =>
    worker.performResultEffects(ctx, {
      runId: 'run-x',
      role: 'review',
      res: { artifacts: { effects: { findings_comment: 'finding: the frobnicator leaks' } } },
      pr: 3,
    }),
  );
  const line = lines.find((l) => l.includes('local comment for work-item #3'));
  assert(line !== undefined, `the comment route announced its target: ${JSON.stringify(lines)}`);
  assert(line.includes('finding: the frobnicator leaks'), 'the FULL body is on the log');
  assert(line.includes('no comment surface'), 'the route names WHY (contract v1)');
});

// --- site 5: parkedResultPointer / resume head reads --------------------------

test('stage 85: parkedResultPointer on local — head from the local snapshot (git), unknown+warn when no branch carries the PR', () => {
  const dir = makeLocalRepo();
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  git(dir, 'checkout', '-q', '-b', 'feat/stage-1-first');
  fs.writeFileSync(path.join(dir, 'work.md'), 'w\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'work');
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', 'main');

  const lines = [];
  const ctx = ctxFor(dir, lines);
  const pointer = withGhForbidden(() => worker.parkedResultPointer(ctx, { role: 'review', pr: 1 }));
  assertEqual(pointer.head, sha.toLowerCase(), 'the branch head anchors the pointer');

  const missing = withGhForbidden(() =>
    worker.parkedResultPointer(ctx, { role: 'review', pr: 99 }),
  );
  assertEqual(missing.head, 'unknown', 'no branch ⇒ honest unknown (approval repurchases)');
  assert(
    lines.some((l) => l.includes("could not read PR #99's head SHA")),
    'the unknown is loud',
  );
});

test('stage 85: resumeParkedResult on local — a moved head refuses the resume (fail closed), zero gh', () => {
  const dir = makeLocalRepo();
  sub.createWorkItem(dir, { title: '[stage 1] First' });
  git(dir, 'checkout', '-q', '-b', 'feat/stage-1-first');
  fs.writeFileSync(path.join(dir, 'work.md'), 'w\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'work');
  git(dir, 'checkout', '-q', 'main');

  const lines = [];
  const ctx = ctxFor(dir, lines);
  const stale = 'a'.repeat(40); // a valid-shaped SHA that is NOT the head
  const attempt = withGhForbidden(() =>
    worker.resumeParkedResult(ctx, {
      agentCfg: { provider: 'claude' },
      pointer: { role: 'review', runId: 'run-old', pr: 1, head: stale },
    }),
  );
  assertEqual(attempt.res, null, 'refused');
  assert(/head moved/.test(attempt.reason), attempt.reason);
});

// --- site 6: recheckApprovedCarrier ------------------------------------------

test('stage 85: recheckApprovedCarrier on local — reads the record store (strongly consistent), FIFO pick, zero gh', () => {
  const dir = makeLocalRepo();
  sub.createWorkItem(
    dir,
    { title: '[stage 1] First' },
    { now: Date.parse('2026-08-19T10:00:00Z') },
  );
  sub.createWorkItem(
    dir,
    { title: '[stage 2] Second' },
    { now: Date.parse('2026-08-19T09:00:00Z') },
  );
  const lines = [];
  const ctx = ctxFor(dir, lines);

  // No carriers yet.
  assertEqual(
    withGhForbidden(() => worker.recheckApprovedCarrier(ctx)),
    null,
  );

  // Awaiting without approval is not a carrier.
  sub.addLabel(dir, 1, 'verity:awaiting-approval');
  assertEqual(
    withGhForbidden(() => worker.recheckApprovedCarrier(ctx)),
    null,
  );

  // Both approved carriers: FIFO by created_at — record #2 is older.
  sub.addLabel(dir, 1, 'verity:approved');
  sub.addLabel(dir, 2, 'verity:awaiting-approval');
  sub.addLabel(dir, 2, 'verity:approved');
  const item = withGhForbidden(() => worker.recheckApprovedCarrier(ctx));
  assertEqual(item.tier, 'P1');
  assertEqual(item.kind, 'issue');
  assertEqual(item.number, 2, 'oldest carrier first (scanner FIFO)');

  // A CLOSED carrier is not a carrier.
  sub.closeWorkItem(dir, 2);
  assertEqual(withGhForbidden(() => worker.recheckApprovedCarrier(ctx)).number, 1);
});

// --- the scan path a full local runOnce crosses -------------------------------

test('stage 85: scanner tiers on local — record-store reads, precedence + needs-human filter + FIFO, zero gh', () => {
  const dir = makeLocalRepo();
  sub.createWorkItem(dir, { title: '[stage 1] Ready' });
  sub.addLabel(dir, 1, 'verity:ready');
  const scanOpts = {
    cwd: dir,
    substrate: 'local',
    nextDecision: () => ({ action: 'idle' }),
  };

  let item = withGhForbidden(() => scanner.scan(scanOpts));
  assertEqual(item.tier, 'P3', 'verity:ready record selected from the store');
  assertEqual(item.number, 1);

  // P1 outranks P3.
  sub.createWorkItem(dir, { title: '[stage 2] Approved' });
  sub.addLabel(dir, 2, 'verity:approved');
  item = withGhForbidden(() => scanner.scan(scanOpts));
  assertEqual(item.tier, 'P1');
  assertEqual(item.number, 2);

  // needs-human items are invisible to every tier.
  sub.addLabel(dir, 2, 'verity:needs-human');
  item = withGhForbidden(() => scanner.scan(scanOpts));
  assertEqual(item.tier, 'P3', 'the escalated P1 record is skipped');

  // CLOSED records are not work.
  sub.closeWorkItem(dir, 1);
  sub.closeWorkItem(dir, 2);
  assertEqual(
    withGhForbidden(() => scanner.scan(scanOpts)),
    null,
    'idle',
  );
});

test('stage 85: scanner P5 label fetch on local — record labels; recordless PR target reads []; corrupt record fails closed', () => {
  const dir = makeLocalRepo();
  sub.createWorkItem(dir, { title: '[stage 1] First', labels: ['feature'] });
  const local = { cwd: dir, substrate: 'local' };
  assertEqual(
    withGhForbidden(() => scanner.fetchTargetLabels({ kind: 'issue', number: 1 }, local)).join(','),
    'feature',
  );
  assertEqual(
    withGhForbidden(() => scanner.fetchTargetLabels({ kind: 'pr', number: 1 }, local)).join(','),
    'feature',
    'a PR target shares the record number space',
  );
  assertEqual(
    withGhForbidden(() => scanner.fetchTargetLabels({ kind: 'pr', number: 99 }, local)).length,
    0,
    'a recordless branch has no label carrier — honest []',
  );
  fs.writeFileSync(path.join(dir, '.verity', 'work-items', '1.json'), '{corrupt');
  assertEqual(
    withGhForbidden(() =>
      scanner.fetchTargetLabels({ kind: 'issue', number: 1 }, { ...local, log: () => {} }),
    ),
    null,
    'a corrupt record fails CLOSED (null ⇒ the scan stays idle)',
  );
});

// --- the operator-smoke residual sites (leak groups 1–3), unit-pinned ---------

test('stage 85 (smoke leak 1): verity state on local — ledger acquisition through the substrate seam, records not gh, GH_REPO inert', () => {
  const dir = makeLocalRepo();
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', 'stage-1-first.md'),
    '# Stage 1: First\n\n- **Type:** feature\n- **Depends on:** none\n',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'stage file');
  sub.createWorkItem(dir, { title: '[stage 1] First' });

  const ledger = require('../verity/bin/lib/ledger.cjs');
  const saved = process.env.GH_REPO;
  // The worker exports GH_REPO to its role children (the smoke's leaked argv
  // carried `--repo owner/slug`); on local it must be INERT — the acquisition
  // routes to the record store, so a slug can never retarget gh.
  process.env.GH_REPO = 'leaked/slug';
  try {
    const proj = ledger.dispatch(['view'], { cwd: dir });
    assertEqual(proj.stages.length, 1);
    assertEqual(proj.stages[0].issue, 1, 'the record is the issue the derive layer read');
    const one = ledger.dispatch(['stage', '1'], { cwd: dir });
    assertEqual(one.number, 1, 'verity state stage N answers from the local store');
  } finally {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined would set the env var to the string "undefined"
      delete process.env.GH_REPO;
    } else {
      process.env.GH_REPO = saved;
    }
  }
});

test('stage 85 (smoke leak 2): verity stage pr on local — deterministic opened:false with the handoff reason, no gh; the codex lifecycle can never reach openPr', () => {
  const dir = makeLocalRepo();
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', 'stage-1-first.md'),
    '# Stage 1: First\n\n- **Type:** feature\n- **Depends on:** none\n',
  );
  const res = stage.dispatch(['pr', '1'], { cwd: dir });
  assertEqual(res.opened, false, 'no PR claimed opened on local');
  assertEqual(res.substrate, 'local');
  assert(/pushed stage branch IS the review handoff/.test(res.reason), res.reason);
  assert(/ADR-0029/.test(res.reason), 'the reason names its provenance');

  // Idempotent/deterministic: a second call answers identically (the smoke saw
  // the role RETRY `gh pr create` after the first shim failure — there must be
  // nothing to retry).
  const again = stage.dispatch(['pr', '1'], { cwd: dir });
  assertEqual(again.opened, false);

  // The Verity-performed lifecycle (codex path) is structurally gated: the
  // local capability narrowing drops github_write, so plan.pr is false and
  // git-lifecycle's openPr (gh pr list/create) is unreachable on local.
  const agentsPolicy = require('../verity/bin/lib/agents/policy.cjs');
  const gitLifecycle = require('../verity/bin/lib/agents/git-lifecycle.cjs');
  const narrowed = agentsPolicy.narrowForSubstrate(
    { capabilities: { git_write: true, github_write: true } },
    'local',
  );
  const plan = gitLifecycle.plan({
    cwd: dir,
    role: 'build',
    roleArgs: ['1'],
    runId: null,
    policy: narrowed,
  });
  assertEqual(plan.pr, false, 'local narrowing makes openPr unreachable (no gh pr list/create)');
  // github regression: the un-narrowed grant still opens the PR.
  const ghPlan = gitLifecycle.plan({
    cwd: dir,
    role: 'build',
    roleArgs: ['1'],
    runId: null,
    policy: { capabilities: { git_write: true, github_write: true } },
  });
  assertEqual(ghPlan.pr, true, 'github path unchanged');
});

test('stage 85 (smoke leak 3): the doctor gh row is skipped-for-substrate on local — never probed, never vanished, never a local health failure', () => {
  const doctor = require('../verity/bin/lib/doctor.cjs');
  const probed = [];
  // exec seam: record every binary the check pass would spawn.
  const exec = (bin, args) => {
    probed.push(`${bin} ${args.join(' ')}`);
    return { status: 0, stdout: 'git version 2.45.1\n', stderr: '' };
  };

  const local = doctor.runChecks({ substrate: 'local', exec });
  const ghRow = local.find((c) => c.name === 'gh');
  assert(ghRow !== undefined, 'the row is reported, not silently vanished');
  assertEqual(ghRow.present, null, 'not probed — the unobserved null, never a fabricated reading');
  assertEqual(ghRow.version, null);
  assertEqual(ghRow.ok, true, 'gh is not a local dependency — it can never fail local health');
  assert(/skipped on the local substrate/.test(ghRow.detail), ghRow.detail);
  assert(
    probed.every((p) => !p.startsWith('gh ')),
    `no gh spawn in the local check pass (probed: ${probed.join(', ')})`,
  );

  // github default: byte-identical — the gh row probes for real (version +
  // auth), exactly as before stage 85.
  probed.length = 0;
  const github = doctor.runChecks({ exec });
  const realRow = github.find((c) => c.name === 'gh');
  assert(typeof realRow.present === 'boolean', 'github path probes gh');
  assert(
    probed.some((p) => p === 'gh --version'),
    'the version probe ran',
  );
});

// --- the engine-set substrate pin (smoke runs 4/5 belt, fix 3) ----------------

test('stage 85 (smoke runs 4/5): VERITY_SUBSTRATE pin — engine-set local outranks a policy-less checkout; default-absent and non-local values change nothing', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-pin-'));
  // A checkout that PREDATES the policy (the skew): no .verity/autonomy.yml.
  const saved = process.env.VERITY_SUBSTRATE;
  const restore = () => {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined would set the env var to the string "undefined"
      delete process.env.VERITY_SUBSTRATE;
    } else {
      process.env.VERITY_SUBSTRATE = saved;
    }
  };
  try {
    // Default-absent: byte-identical policy resolution (unreadable ⇒ github).
    // biome-ignore lint/performance/noDelete: the absent case must be genuinely absent
    delete process.env.VERITY_SUBSTRATE;
    assertEqual(sub.resolveSubstrate(bare), 'github', 'no pin ⇒ policy resolution unchanged');
    assertEqual(sub.pinnedSubstrate(), null);

    // The engine-set pin: the run's frozen 'local' travels to children whose
    // checkout predates the policy.
    process.env.VERITY_SUBSTRATE = 'local';
    assertEqual(sub.resolveSubstrate(bare), 'local', 'the pin outranks the cwd re-derivation');
    // operator.snapshot honors it too (a role-shelled `verity operator
    // snapshot` from the stale checkout must not flip to github paths):
    const operator = require('../verity/bin/lib/operator.cjs');
    const s = operator.snapshot(bare, {
      snapshot: { online: true, issues: [], prs: [], tags: [] },
    });
    assertEqual(s.repository, null, 'pinned local: no fabricated repository');
    assertEqual(s.health.github, null, 'pinned local: GitHub never consulted');

    // ONLY the value 'local' is honored — the sole value the engine ever pins;
    // anything else falls to policy resolution (fail toward github).
    process.env.VERITY_SUBSTRATE = 'github';
    assertEqual(sub.pinnedSubstrate(), null, "'github' is never pinned (default anyway)");
    process.env.VERITY_SUBSTRATE = 'bogus';
    assertEqual(sub.resolveSubstrate(bare), 'github', 'junk values are ignored, never honored');
  } finally {
    restore();
  }

  // A repo whose POLICY says local stays local without any pin (the pin is a
  // belt, never the mechanism).
  const dir = makeLocalRepo();
  assertEqual(sub.resolveSubstrate(dir), 'local');
});

test('stage 90: a github run DELETES an inherited VERITY_SUBSTRATE pin; a local run still exports it; a clean env stays clean', () => {
  // The cheapest deterministic path across the worker's pin site: mode
  // 'autonomous' + agent codex at the default tier 1 refuses at the ADR-0011
  // tier gate — the very next startup check AFTER the substrate stamp + pin,
  // BEFORE any gh call, scan, label, or lock — so runOnce mutates the pin and
  // then throws with the effect observable in process.env. (makeLocalRepo is
  // just a committed fixture repo; the policy argument picks the substrate.)
  const github = makeLocalRepo('mode: autonomous\nagent:\n  provider: codex\n');
  const local = makeLocalRepo('mode: autonomous\nsubstrate: local\nagent:\n  provider: codex\n');
  const runToTierGate = (repo) => {
    let threw = null;
    try {
      worker.runOnce({ cwd: repo, stdout() {}, stderr() {} });
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, 'the tier gate refuses (the run never reaches gh)');
    assertEqual(threw.slug, 'containment-tier-required', 'at the ADR-0011 gate, past the pin site');
  };
  // Save/restore the ambient var (the stage-85 pin-test pattern above).
  const saved = process.env.VERITY_SUBSTRATE;
  const restore = () => {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined would set the env var to the string "undefined"
      delete process.env.VERITY_SUBSTRATE;
    } else {
      process.env.VERITY_SUBSTRATE = saved;
    }
  };
  try {
    // The stage-90 hazard: a stale 'local' inherited from the parent env (an
    // operator shell after a local run, a wrapper script) is DELETED by a
    // github run — children can no longer see it (pinnedSubstrate honors
    // 'local' from the environment).
    process.env.VERITY_SUBSTRATE = 'local';
    runToTierGate(github);
    assert(!('VERITY_SUBSTRATE' in process.env), 'stale inherited pin deleted — genuinely absent');

    // Clean environment: deleting an absent var is a no-op — byte-identical.
    runToTierGate(github);
    assert(!('VERITY_SUBSTRATE' in process.env), 'unset stays unset on github runs');

    // A local run still exports the frozen pin (stage 85, unchanged).
    runToTierGate(local);
    assertEqual(process.env.VERITY_SUBSTRATE, 'local', 'a local run still exports the pin');
  } finally {
    restore();
  }
});

// --- THE UPGRADED PIPELINE E2E (spec: PATH-shimmed gh, zero calls) ------------
//
// A REAL spawned `verity-worker --once` on a local-substrate repo, INVOKED THE
// WAY THE BENCHMARK INVOKES IT (`--repo <owner/slug> --once`, cwd = the repo —
// the exact shape the real-model operator smoke used): the fixture does NOT
// stub gh — a sentinel `gh` on PATH records any invocation and exits 97 — and
// the run is driven model-free by a scripted claude stub that does what a real
// build/review role does per commands/verity/build.md AND review.md, engine
// CLI included: `verity state stage` + `verity state next` (the ledger
// acquisition the smoke caught as the doubled gh triple), `verity stage
// branch`, real code + node:test files, `verity stage pr` (the smoke's
// retried `gh pr create` site), and the review's own `verity state stage`.
// Everything else is the REAL engine: startup checks, the local scan,
// agent-exec dispatch (--substrate local), the stage-82 gate runner executing
// the committed gates SHA-pinned, the trust ladder's local checksGreen, and
// the engine-performed --no-ff merge + record close + bare-origin push.
// Afterward the SAME sentinel guards the benchmark's defaultSnapshotReader →
// `verity operator snapshot --json` → doctor chain (the smoke's third leak
// group, the 5× `gh --version` dependency probes).

const LOCAL_AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
const queueFile = process.env.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
const cwd = process.cwd();
// Stage 85 (smoke runs 4/5): record the worker's frozen-run substrate pin as
// the role child sees it — the belt that keeps role-shelled engine commands
// local even when a stage-branch checkout predates the policy.
fs.appendFileSync(process.env.CLI_LOG,
  'role env VERITY_SUBSTRATE=' + (process.env.VERITY_SUBSTRATE || '(absent)') + '\\n');
// The engine CLI, shelled exactly as the role commands instruct — every call
// must be DETERMINISTIC on local (exit 0, zero gh): a nonzero exit fails the
// role loudly, which fails the run, which fails the test.
const cli = (...args) => {
  const r = spawnSync(process.execPath, [process.env.VERITY_CLI, ...args], {
    cwd, encoding: 'utf8',
  });
  fs.appendFileSync(process.env.CLI_LOG,
    'verity ' + args.join(' ') + ' -> exit ' + r.status + '\\n' + r.stdout + r.stderr + '\\n');
  if (r.status !== 0) {
    process.stdout.write('role CLI step failed: verity ' + args.join(' ') +
      ' exit ' + r.status + '\\n' + r.stdout + r.stderr + '\\n');
    process.exit(1);
  }
  return r.stdout;
};
const g = (...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' });
// BUILD step — build.md: state reads, stage branch, code + tests, stage pr.
if (step.role === 'build') {
  cli('state', 'stage', '1'); // build.md step 1 (the smoke's doubled
  cli('state', 'next');       // fetchSnapshot triple came from exactly this pair)
  cli('stage', 'branch', '1'); // build.md step 2 — the REAL branch path
  fs.mkdirSync(cwd + '/lib', { recursive: true });
  fs.mkdirSync(cwd + '/test', { recursive: true });
  fs.writeFileSync(cwd + '/lib/core.js', 'exports.core = (x) => x + 1;\\n');
  fs.writeFileSync(cwd + '/test/core.test.js',
    "const test = require('node:test');\\nconst assert = require('node:assert');\\nconst { core } = require('../lib/core.js');\\ntest('core', () => assert.equal(core(1), 2));\\n");
  g('add', '-A');
  g('commit', '-q', '-m', 'feat: stage 1 core (simulated role completion)');
  g('push', '-q', 'origin', step.branch);
  cli('stage', 'pr', '1', '--issue', '1'); // build.md step 5 — the smoke's gh pr create site
  cli('state', 'stage', '1'); // build.md step 6
  g('checkout', '-q', 'main');
}
// REVIEW step — review.md step 1.
if (step.role === 'review') {
  cli('state', 'stage', '1');
}
const result = {
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 1.87,
  usage: { input_tokens: 400000, cache_creation_input_tokens: 10000,
           cache_read_input_tokens: 2034, output_tokens: 38112 },
};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify(result) + '\\n');
`;

const markerFor = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

test('stage 85 PIPELINE e2e: full local runOnce — build → SHA-pinned gates → review → engine merge, ZERO gh (PATH-shim sentinel, startup included)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-wlocal-e2e-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');

  // Harness scratch is gitignored — it is not the role's work (the worker.test
  // fixture discipline).
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    ['home/', 'shim-bin/', 'agent-stub', 'agent-queue.json', 'role-cli.log', ''].join('\n'),
  );

  // Committed local-substrate state: policy (trust 2 so the verified-green
  // review auto-merges), the single-source gate definition (the honest
  // stage-85 directory form — red on a test-less tree), one stage.
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.verity', 'autonomy.yml'),
    ['mode: supervised', 'substrate: local', 'review:', '  trust: 2', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, '.verity', 'gates.json'),
    `${JSON.stringify({
      schema: 1,
      // The stage-85 honest form (see benchmark-local.test.cjs): red on a
      // test-less tree on Node 20 AND 22, green only with real passing tests.
      gates: [
        { name: 'test', command: 'ls test/*.test.js >/dev/null && node --test test/*.test.js' },
      ],
    })}\n`,
  );
  stage.create(dir, 'Core', {});
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');

  // ADR-0029 §1 bare origin (origin/HEAD wired) + the stage's work-item record
  // (engine-committed, contract local-work-item v1).
  sub.provisionBareOrigin(dir);
  sub.createWorkItem(dir, { title: '[stage 1] Core', labels: ['feature'] });

  // The branch the engine will derive for stage 1 — the stub must build THERE.
  const branch = stage.branchName(dir, 1);

  // Scripted claude stub: build (creates the branch + code + tests), then
  // review (approve verdict on local PR #1).
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, LOCAL_AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  const queueFile = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(
    queueFile,
    JSON.stringify([
      { role: 'build', branch, final: markerFor('success') },
      {
        role: 'review',
        final: markerFor('success', { artifacts: { verdict: 'approve', pr: 1 } }),
      },
    ]),
  );
  const cliLog = path.join(dir, 'role-cli.log');
  fs.writeFileSync(cliLog, '');

  // The zero-gh sentinel: NOT a stub — any gh invocation is recorded AND fails
  // (exit 97), so a regression both derails the run and leaves evidence.
  const shimBin = path.join(dir, 'shim-bin');
  fs.mkdirSync(shimBin, { recursive: true });
  const sentinel = path.join(shimBin, 'gh-invocations.log');
  fs.writeFileSync(
    path.join(shimBin, 'gh'),
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stderr.write('gh is FORBIDDEN in a local-substrate worker run (stage 85)\\n');\nprocess.exit(97);\n`,
  );
  fs.chmodSync(path.join(shimBin, 'gh'), 0o755);

  const env = {
    ...process.env,
    PATH: `${shimBin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    AGENT_QUEUE: queueFile,
    VERITY_AGENT_BIN: agent,
    VERITY_CLI: path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs'),
    CLI_LOG: cliLog,
  };
  // THE BENCHMARK'S INVOCATION SHAPE (the one that leaked in the smoke): no
  // --cwd flag — the worker's cwd IS the repo, exactly as drivePipeline spawns
  // it — and runOnce exports GH_REPO to every child, so the roles' own
  // `verity state` reads inherit the pointed slug (the leaked argv's
  // `--repo owner/slug`) and must STILL resolve the local substrate.
  const res = spawnSync('node', [WORKER, '--repo', 'local-bench/core', '--once'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  const out = `${res.stdout}\n${res.stderr}`;

  // ZERO gh across the ENTIRE run — startup checks included. Asserted first:
  // if this fails, nothing else matters.
  assert(
    !fs.existsSync(sentinel),
    `gh was invoked on local: ${fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : ''}`,
  );

  assertEqual(res.status, 0, `run succeeded (stdout: ${res.stdout} stderr: ${res.stderr})`);
  assert(res.stdout.includes('success'), `terminal line reports success: ${res.stdout}`);

  // Sites 1+2: honest local markers, no fabricated identity/lock.
  assert(
    out.includes('preflight auth skipped') && out.includes('never fabricated'),
    'the identity skip is announced',
  );
  assert(out.includes('proceeding without a lock'), 'the lockless run is announced');

  // Site 4: the §7 summary text landed on the run log — never dropped — and
  // names the record it addresses; the structured half is in the ledger.
  assert(out.includes('local comment for work-item #1'), `summary route: ${out}`);
  assert(out.includes('🤖 **verity-worker**'), 'the §7 template is intact');
  assert(/roles: build → review/.test(out), `both roles ran: ${out}`);
  assert(fs.existsSync(path.join(dir, '.verity', 'usage.csv')), 'usage ledger written');

  // The REAL engine acts happened: green SHA-pinned gate-run record …
  const recPath = path.join(dir, '.verity', 'gate-runs', `${sub.branchSlug(branch)}.json`);
  assert(fs.existsSync(recPath), 'gate-run record written (stage 82 runner, engine-performed)');
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  assertEqual(
    rec.gates[0].command,
    'ls test/*.test.js >/dev/null && node --test test/*.test.js',
    'the committed gate actually ran',
  );
  assert(
    rec.gates.every((g) => g.exit_code === 0),
    'gates green',
  );
  assertEqual(rec.sha, git(dir, 'rev-parse', branch).trim(), 'SHA-pinned to the branch head');

  // … the record CLOSED (the local Closes #N) and the branch merged into the
  // BARE origin's default branch (the outcome lives in the origin).
  assertEqual(sub.readWorkItem(dir, 1).state, 'CLOSED', 'work-item record closed by the merge');
  const bare = path.join(path.dirname(dir), `${path.basename(dir)}-origin.git`);
  execFileSync('git', ['-C', bare, 'merge-base', '--is-ancestor', rec.sha, 'main'], {
    stdio: 'pipe',
  });
  assert(
    git(bare, 'show', 'main:test/core.test.js').includes('node:test'),
    'the built tests reached the origin',
  );

  // The role's OWN engine-CLI trail (the smoke's leak groups 1+2, now gh-free):
  // every `verity state` read answered from the record store, and `verity
  // stage pr` answered deterministically — opened:false with the
  // pushed-branch-IS-the-handoff reason, no gh attempt, no retry.
  const cliTrail = fs.readFileSync(cliLog, 'utf8');
  assert(
    /role env VERITY_SUBSTRATE=local/.test(cliTrail),
    `the worker exported its frozen-run substrate pin to the role (smoke runs 4/5 belt):\n${cliTrail}`,
  );
  assert(/verity state stage 1 -> exit 0/.test(cliTrail), `state reads ran gh-free:\n${cliTrail}`);
  assert(/verity state next -> exit 0/.test(cliTrail), 'the back-to-back second state read too');
  assert(/verity stage pr 1 --issue 1 -> exit 0/.test(cliTrail), 'stage pr is deterministic');
  assert(/"opened": false/.test(cliTrail), 'no PR was claimed opened');
  assert(
    /pushed stage branch IS the review handoff/.test(cliTrail),
    'the local handoff reason reached the role',
  );

  // Leak group 3: the benchmark's DEFAULT snapshot reader → `verity operator
  // snapshot --json` → doctor chain, under the SAME sentinel — the smoke's 5×
  // `gh --version` dependency probes must not fire (the gh row reads
  // skipped-for-substrate instead).
  const benchmark = require('../verity/bin/lib/benchmark.cjs');
  const oldPath = process.env.PATH;
  process.env.PATH = `${shimBin}${path.delimiter}${oldPath}`;
  let snap;
  try {
    snap = benchmark.defaultSnapshotReader('local-bench/core', { cwd: dir });
  } finally {
    process.env.PATH = oldPath;
  }
  assertEqual(snap.schema, 1, `the drive loop's reader works post-run: ${JSON.stringify(snap)}`);
  assertEqual(snap.repository, null, 'no fabricated repo slug');
  assertEqual(
    snap.worker.last_outcome,
    'success',
    'liveness resolves from the ledger the run wrote',
  );

  // FINAL zero-gh verdict across ALL THREE leak paths (worker run + role CLI
  // + snapshot/doctor chain).
  assert(
    !fs.existsSync(sentinel),
    `gh was invoked on local: ${fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : ''}`,
  );
});
