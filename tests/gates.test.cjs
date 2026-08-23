// Stage 82 (ADR-0029 §4, ADR-0028) — the local gate runner, tested with REAL
// git repos and REAL child processes in mkdtemp dirs (no network, no gh):
//   - gate definition (`.verity/gates.json`): committed single source; absent/
//     invalid/EMPTY refuses loudly — no record, never green, never a default
//     gate list.
//   - executor honesty: ordered, stop-at-first-failure, EXIT CODE is the only
//     verdict input (a gate printing "PASS" but exiting 1 is a FAILURE).
//   - SHA-pinned records (contract local-work-item v1, FROZEN) written via
//     stage 80's writer conventions (exported branchSlug + GATE_RUNS_DIR) and
//     round-tripped through stage 80's reader (localCiStateFor) — green AND
//     red; staleness detectable by SHA alone (move the head ⇒ UNKNOWN).
//   - fail-closed refusals: dirty tree, mid-run head move, gates that modify
//     tracked files — each writes NO record.
//   - record placement: committed on the DEFAULT branch, never on the judged
//     branch (which would stale the record instantly).
//   - worker wiring: a completed local build triggers the runner before the
//     next decision; a refused run leaves the branch honestly UNKNOWN.
//   - scaffold: the generated workflow carries the definition-consuming gates
//     job; the emitted runner fails LOUDLY with no definition.
//   - claude narrowing (the stage-81 carried item): a local claude dispatch
//     proceeds with gh/WebFetch/WebSearch stripped from the .tools.json
//     surface; a github dispatch's surface is byte-identical to the role file.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('../verity/bin/lib/agents/claude.cjs');
const gates = require('../verity/bin/lib/gates.cjs');
const identity = require('../verity/bin/lib/identity.cjs');
const ledger = require('../verity/bin/lib/ledger.cjs');
const scaffold = require('../verity/bin/lib/scaffold.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');
const worker = require('../verity/worker/index.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function writeStageFile(dir, n, slug, title) {
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', `stage-${n}-${slug}.md`),
    `# Stage ${n}: ${title}\n\n- **Type:** feature\n- **Depends on:** none\n`,
  );
}

function writeGatesFile(dir, gatesList) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.verity', 'gates.json'),
    `${JSON.stringify({ schema: 1, gates: gatesList }, null, 2)}\n`,
  );
}

// A deterministic fixture repo on `main`: one stage file, a committed gate
// definition (when given), one initial commit.
function makeRepo(gatesList) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-'));
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeStageFile(dir, 1, 'first', 'First');
  if (gatesList !== undefined) {
    writeGatesFile(dir, gatesList);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

// The stage-1 branch with one unique commit; back on main afterwards.
function makeStageBranch(dir, branch = 'feat/stage-1-first') {
  git(dir, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'work.txt'), 'work\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `work on ${branch}`);
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', 'main');
  return sha;
}

const recordPath = (dir, branch) =>
  path.join(dir, sub.GATE_RUNS_DIR, `${sub.branchSlug(branch)}.json`);

const QUIET = { stdio: 'ignore' };

// --- gate definition: absent / invalid / empty ⇒ refuse, never a default ----

test('gates: absent definition refuses loudly — no record, UNKNOWN downstream', () => {
  const dir = makeRepo(); // no gates.json at all
  makeStageBranch(dir);
  assertThrows(
    () => gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET }),
    /no gate definition/,
    'absent definition',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  // Stage 80's reader keeps answering UNKNOWN — the ci:unverified gate fires.
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN);
});

test('gates: invalid / wrong-schema / empty definitions all refuse (never green, never a default list)', () => {
  assertThrows(() => gates.parseGateDefinition('{ nope', 'x'), /not valid JSON/, 'corrupt');
  assertThrows(() => gates.parseGateDefinition('[1]', 'x'), /must be a JSON object/, 'array');
  assertThrows(
    () => gates.parseGateDefinition('{"schema":2,"gates":[]}', 'x'),
    /schema must be 1/,
    'wrong schema',
  );
  assertThrows(
    () => gates.parseGateDefinition('{"schema":1,"gates":[]}', 'x'),
    /defines no gates/,
    'EMPTY gate list can never read green',
  );
  assertThrows(
    () => gates.parseGateDefinition('{"schema":1,"gates":[{"name":"t"}]}', 'x'),
    /non-empty string name and command/,
    'entry without a command',
  );
  // End-to-end: a committed empty definition still refuses and writes nothing.
  const dir = makeRepo([]);
  makeStageBranch(dir);
  assertThrows(
    () => gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET }),
    /defines no gates/,
    'committed empty definition',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN);
});

// --- executor: ordering, stop-at-first-failure, exit-code truth --------------

test('gates: commands run in ORDER and stop at the first nonzero exit; unrun gates are absent from the results', () => {
  const dir = makeRepo();
  const marker = path.join(dir, '..', `order-${path.basename(dir)}.txt`);
  const out = gates.runGateCommands(
    dir,
    [
      { name: 'a', command: `printf a >> '${marker}'` },
      { name: 'boom', command: 'exit 3' },
      { name: 'c', command: `printf c >> '${marker}'` },
    ],
    QUIET,
  );
  assertEqual(out.ok, false);
  assertEqual(out.gates.length, 2, 'the gate after the failure never ran');
  assertEqual(out.gates[0].name, 'a');
  assertEqual(out.gates[0].exit_code, 0);
  assertEqual(out.gates[1].name, 'boom');
  assertEqual(out.gates[1].exit_code, 3, 'the exact exit code is recorded');
  assertEqual(fs.readFileSync(marker, 'utf8'), 'a', 'ordered, and c never executed');
});

test('gates: exit-code truth — a gate that prints PASS but exits 1 is a FAILURE (ADR-0028)', () => {
  const dir = makeRepo();
  const out = gates.runGateCommands(dir, [{ name: 'liar', command: 'echo PASS && exit 1' }], QUIET);
  assertEqual(out.ok, false, 'output is never parsed; the exit code is the only verdict input');
  assertEqual(out.gates[0].exit_code, 1);
});

// --- the full run: record written per contract, round-tripped via stage 80 ---

test('gates: green run writes the SHA-pinned contract record on the DEFAULT branch and stage 80 reads it green', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  const mainBefore = git(dir, 'rev-parse', 'main').trim();
  const res = gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET });
  assertEqual(res.ok, true);
  assertEqual(res.sha, sha, 'the record claims the exact head the gates ran against');
  // The record file: stage 80's exported branchSlug + GATE_RUNS_DIR convention.
  const file = recordPath(dir, 'feat/stage-1-first');
  assert(fs.existsSync(file), 'record exists at .verity/gate-runs/<branch-slug>.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertEqual(rec.schema, 1);
  assertEqual(rec.branch, 'feat/stage-1-first');
  assertEqual(rec.sha, sha);
  assert(Number.isFinite(Date.parse(rec.started_at)), 'started_at is ISO');
  assert(Number.isFinite(Date.parse(rec.finished_at)), 'finished_at is ISO');
  assertEqual(JSON.stringify(rec.gates), '[{"name":"ok","command":"true","exit_code":0}]');
  // Committed (pathspec commit) on the DEFAULT branch — the judged branch's
  // head did NOT move (a record commit there would stale the record instantly).
  assertEqual(git(dir, 'status', '--porcelain').trim(), '', 'record commit leaves a clean tree');
  assertEqual(git(dir, 'rev-parse', 'feat/stage-1-first').trim(), sha, 'judged head unmoved');
  assert(git(dir, 'rev-parse', 'main').trim() !== mainBefore, 'record committed on main');
  assert(git(dir, 'log', '-1', '--format=%s', 'main').includes('gate run'), 'commit names the act');
  // Round-trip through stage 80's reader: verified GREEN.
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN);
  assertEqual(sub.localChecksGreen(dir, 1), true);
});

test('gates: red run — first failure recorded with its exit code, stage 80 reads RED (and an incomplete record is red, never green)', () => {
  const dir = makeRepo([
    { name: 'ok', command: 'true' },
    { name: 'liar', command: 'echo PASS && exit 1' },
    { name: 'never-ran', command: 'true' },
  ]);
  makeStageBranch(dir);
  const res = gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET });
  assertEqual(res.ok, false);
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, 'feat/stage-1-first'), 'utf8'));
  assertEqual(rec.gates.length, 2, 'stopped at first failure; the unrun gate is absent');
  assertEqual(rec.gates[1].name, 'liar');
  assertEqual(rec.gates[1].exit_code, 1, 'printed PASS, exited 1 ⇒ recorded FAILURE');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_RED, 'stage 80 reads the record red');
  assertEqual(sub.localChecksGreen(dir, 1), false);
});

test('gates: SHA honesty end-to-end — green reads green until the head moves, then UNKNOWN (stale by SHA alone)', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET });
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'verified green at the pinned sha');
  // Move the branch head: one more commit.
  git(dir, 'checkout', '-q', 'feat/stage-1-first');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'more work\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'more work');
  git(dir, 'checkout', '-q', 'main');
  assertEqual(
    sub.localCiStateFor(dir, 1),
    ledger.CI_UNKNOWN,
    'green is never carried forward — the stale record reads UNKNOWN by SHA alone',
  );
});

test('gates: the definition is read from the BRANCH HEAD commit, not the default branch (single-source at the pinned sha)', () => {
  const dir = makeRepo([{ name: 'src', command: 'exit 7' }]); // main's version would be red
  const marker = path.join(dir, '..', `which-${path.basename(dir)}.txt`);
  git(dir, 'checkout', '-q', '-b', 'feat/stage-1-first');
  writeGatesFile(dir, [{ name: 'src', command: `printf branch >> '${marker}'` }]);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'branch gates');
  git(dir, 'checkout', '-q', 'main');
  const res = gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET });
  assertEqual(res.ok, true, "the branch's committed definition ran, not main's");
  assertEqual(fs.readFileSync(marker, 'utf8'), 'branch');
});

// --- fail-closed refusals: no record on any of them --------------------------

test('gates: dirty working tree refuses BEFORE running — no record', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'dirty\n');
  assertThrows(
    () => gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET }),
    /working tree .* is dirty/,
    'dirty tree',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  git(dir, 'checkout', '-q', '--', 'README.md');
});

test('gates: a head that moves mid-run refuses the record (fail closed)', () => {
  const dir = makeRepo([{ name: 'mover', command: 'git commit --allow-empty -q -m mid-run-move' }]);
  makeStageBranch(dir);
  assertThrows(
    () => gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET }),
    /moved mid-run/,
    'mid-run head move',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'main', 'checkout restored');
});

test('gates: gates that modify TRACKED files refuse the record (the tree no longer matches the sha)', () => {
  const dir = makeRepo([{ name: 'mutator', command: 'echo mutated >> README.md' }]);
  makeStageBranch(dir);
  assertThrows(
    () => gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', ...QUIET }),
    /modified tracked files/,
    'tracked mutation',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
});

test('gates: writeGateRun refuses an invalid record and a record about the default branch itself', () => {
  const dir = makeRepo();
  makeStageBranch(dir);
  assertThrows(
    () => sub.writeGateRun(dir, { schema: 1 }),
    /invalid gate-run record/,
    'schema-invalid record never persisted',
  );
  assertThrows(
    () =>
      sub.writeGateRun(dir, {
        schema: 1,
        branch: 'main',
        sha: git(dir, 'rev-parse', 'main').trim(),
        started_at: '2026-08-19T00:00:00Z',
        finished_at: '2026-08-19T00:00:01Z',
        gates: [{ name: 'ok', command: 'true', exit_code: 0 }],
      }),
    /would move the very head it judges/,
    'a default-branch record would stale itself on commit',
  );
});

test('gates: running FROM the stage-branch checkout works — record still lands on main, checkout restored', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  git(dir, 'checkout', '-q', 'feat/stage-1-first');
  const res = gates.runGatesForBranch(dir, QUIET); // no --branch: the current branch
  assertEqual(res.branch, 'feat/stage-1-first');
  assertEqual(res.ok, true);
  assertEqual(
    git(dir, 'symbolic-ref', '--short', 'HEAD').trim(),
    'feat/stage-1-first',
    'checkout restored to where the caller stood',
  );
  assertEqual(git(dir, 'rev-parse', 'feat/stage-1-first').trim(), sha, 'judged head unmoved');
  git(dir, 'checkout', '-q', 'main');
  assert(fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'record committed on main');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN);
});

// --- CLI (`verity gates run`) ------------------------------------------------

function runCli(args, cwd, env = {}) {
  try {
    const out = execFileSync('node', [CLI, 'gates', ...args, '--cwd', cwd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { out, code: 0, stderr: '' };
  } catch (err) {
    return { out: err.stdout || '', code: err.status, stderr: err.stderr || '' };
  }
}

test('gates CLI: green exits 0, red exits nonzero, absent definition exits nonzero LOUDLY (judged by exit code)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-cli-'));
  // Absent definition: loud nonzero.
  let r = runCli(['run', '--no-record'], dir);
  assert(r.code !== 0, 'no definition must never exit 0');
  assert(r.stderr.includes('no gate definition'), 'says so explicitly');
  // Green: exit 0.
  writeGatesFile(dir, [{ name: 'ok', command: 'true' }]);
  r = runCli(['run', '--no-record'], dir);
  assertEqual(r.code, 0, `green exits 0 (${r.stderr})`);
  // Red (prints PASS, exits 1): nonzero — exit-code judged, output ignored.
  writeGatesFile(dir, [{ name: 'liar', command: 'echo PASS && exit 1' }]);
  r = runCli(['run', '--no-record'], dir);
  assert(r.code !== 0, 'a lying gate is red');
  // --branch and --no-record are mutually exclusive (never silently ignored).
  r = runCli(['run', '--no-record', '--branch', 'x'], dir);
  assert(r.code !== 0 && r.stderr.includes('mutually exclusive'), 'ambiguous combo refused');
});

// --- worker wiring (stage 82: the local build → gate run seam) ---------------

function workerFixture(gatesList) {
  const dir = makeRepo(gatesList);
  makeStageBranch(dir);
  return dir;
}

function runWorkerBuild(dir, { gitLifecycle, policyPatch } = {}) {
  const agentExecMod = require('../verity/bin/lib/agent-exec.cjs');
  const nextMod = require('../verity/bin/lib/next.cjs');
  const autonomyMod = require('../verity/bin/lib/autonomy.cjs');
  const policy = JSON.parse(JSON.stringify(autonomyMod.DEFAULTS));
  policy.mode = 'supervised';
  // Stage 86: lets a test hand the loop a resolved gate_runner (raw policy
  // object, the unit-caller path — loadPolicy's resolution is tested in
  // autonomy.test.cjs).
  Object.assign(policy, policyPatch || {});
  const notes = [];
  const origDispatch = agentExecMod.dispatch;
  const origNext = nextMod.dispatch;
  let nextCalls = 0;
  nextMod.dispatch = () => {
    nextCalls += 1;
    return nextCalls === 1
      ? {
          schema: 1,
          action: 'work',
          role: 'build',
          args: ['1'],
          gate: null,
          target: { kind: 'stage', number: 1 },
          reason: 'stage ready',
        }
      : {
          schema: 1,
          action: 'idle',
          role: null,
          args: [],
          gate: null,
          target: null,
          reason: 'no work',
        };
  };
  agentExecMod.dispatch = () => ({
    schema: 1,
    role: 'build',
    outcome: 'success',
    tokens: { in: 10, out: 5 },
    est_usd: 0.01,
    wall_secs: 1,
    tool_calls: 1,
    artifacts: {},
    error: null,
    ...(gitLifecycle ? { git_lifecycle: gitLifecycle } : {}),
  });
  try {
    const summary = worker.runLoop(
      {
        repo: 'o/r',
        cwd: dir,
        stdout() {},
        stderr: (l) => notes.push(l),
        substrate: 'local',
      },
      { policy, runId: 'run-gates', item: { kind: 'stage', number: 1, tier: 'P5' } },
    );
    return { summary, notes };
  } finally {
    agentExecMod.dispatch = origDispatch;
    nextMod.dispatch = origNext;
  }
}

test('worker: a completed local build triggers the gate runner — the next snapshot reads verified green (branch derived from the stage number)', () => {
  const dir = workerFixture([{ name: 'ok', command: 'true' }]);
  const { summary, notes } = runWorkerBuild(dir); // no git_lifecycle: claude-path derivation
  assertEqual(summary.outcome, 'success', summary.result);
  assert(fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'record written by the worker');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'UNKNOWN turned into verified green');
  assert(
    notes.some((l) => l.includes('local gates for feat/stage-1-first') && l.includes('green')),
    `the act is visible in the run log: ${notes.join(' | ')}`,
  );
});

test('worker: the Verity-performed git lifecycle names the branch directly (codex path)', () => {
  const dir = workerFixture([{ name: 'ok', command: 'true' }]);
  const { summary } = runWorkerBuild(dir, {
    gitLifecycle: { branch: 'feat/stage-1-first', pushed: true },
  });
  assertEqual(summary.outcome, 'success');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN);
});

test('worker: a refused gate run (no definition) is loud but non-fatal — no record, branch stays UNKNOWN (fail closed)', () => {
  const dir = workerFixture(); // no gates.json
  const { summary, notes } = runWorkerBuild(dir);
  assertEqual(summary.outcome, 'success', 'the run itself completes');
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record fabricated');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN, 'honestly UNKNOWN, never green');
  assert(
    notes.some((l) => l.includes('wrote no record') && l.includes('UNKNOWN')),
    `the refusal is visible: ${notes.join(' | ')}`,
  );
});

test('worker: red gates are recorded red — the worker never coerces a failure', () => {
  const dir = workerFixture([{ name: 'liar', command: 'echo PASS && exit 1' }]);
  const { summary, notes } = runWorkerBuild(dir);
  assertEqual(summary.outcome, 'success', 'the build run completed; the GATES are red');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_RED, 'verified red, exit-code judged');
  assert(
    notes.some((l) => l.includes('red (liar=1)')),
    notes.join(' | '),
  );
});

// --- stage 86 (ADR-0030): the gate-runner seam --------------------------------

// Stage 88: a fake global catalog home (the ~/.verity-equivalent dir the
// deployment/gate-runners homeDir seam points at) carrying one RESOLVABLE
// entry — remote:<name> runs must now get PAST name resolution to prove the
// stage-86 placeholder still fires post-resolution; tests never read the
// developer's real ~/.verity.
const VALID_CATALOG =
  '## gpu-box — GPU box\n- **status:** active\n- **host:** gpu.lan\n- **user:** ci\n';
function runnerCatalogHome(text = VALID_CATALOG) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-grhome-'));
  fs.writeFileSync(path.join(home, 'gate-runners.md'), text);
  return home;
}

// Stage 89: a down-SSH stub — remote:<name> with a VALID catalog entry now
// proceeds past resolution into the gates-remote PREFLIGHT, whose FIRST probe
// (reachability, `ssh -o BatchMode=yes <target> true`) refuses here; the
// tests never open a real SSH connection (hermetic — VERITY_SSH_BIN is the
// stage-88 override convention).
function downSshStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-sshdown-'));
  const stub = path.join(dir, 'ssh-down');
  fs.writeFileSync(stub, '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 255\n');
  fs.chmodSync(stub, 0o755);
  return stub;
}

test('stage 86→89 seam: a resolved remote:<name> runner proceeds to the SSH preflight — an unreachable runner refuses byte-stably, NO record, UNKNOWN downstream', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  // Stage 88: name resolution runs FIRST — gpu-box resolves against the
  // seeded catalog; stage 89: execution then reaches the remote preflight,
  // where the unreachable stub refuses (the stage-86 placeholder is GONE).
  const home = runnerCatalogHome();
  const ssh = downSshStub();
  const err = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'remote:gpu-box',
        home,
        env: { VERITY_SSH_BIN: ssh },
        ...QUIET,
      }),
    /preflight: SSH to ci@gpu\.lan is not reachable/,
    'runner remote:gpu-box',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-box' preflight: SSH to ci@gpu.lan is not reachable (\`${ssh} -o BatchMode=yes ci@gpu.lan true\` failed: Permission denied (publickey).) — the remote runner executes over your existing SSH context, prompt-free (BatchMode, ADR-0030); fix SSH access to 'gpu-box' or point VERITY_SSH_BIN at your ssh; no record is written and the branch stays UNKNOWN`,
    'byte-stable preflight refusal',
  );
  assert(!/not yet implemented/.test(err.message), 'the stage-86 placeholder text is gone');
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN, 'honestly UNKNOWN downstream');
  // The record-free path refuses BEFORE any SSH byte moves: the working tree
  // names no committed sha for the remote runner to test (stage 89) — the
  // localhost rule, held on the second act runner.
  const noRec = assertThrows(
    () => gates.runGatesHere(dir, { runner: 'remote:gpu-box', home, ...QUIET }),
    /names no committed sha for the remote runner/,
    'runGatesHere refuses remote',
  );
  assertEqual(
    noRec.message,
    "gate_runner 'remote:gpu-box': the record-free path (--no-record) judges the working tree, which names no committed sha for the remote runner to test (stage 89, ADR-0030) — run `verity gates run` without --no-record, or configure gate_runner: direct",
    'byte-stable refusal',
  );
  // Admitted by the ONE shared guard: direct, absent (pre-stage-86 callers),
  // github-actions (the github substrate's ad-hoc CLI run), localhost
  // (stage 87), and — as of stage 89 — remote:<name>. Any FUTURE runner
  // value reaching execution before its executor exists still refuses
  // fail-closed (never a silent direct run).
  gates.assertRunnerExecutable(undefined);
  gates.assertRunnerExecutable('direct');
  gates.assertRunnerExecutable('github-actions');
  gates.assertRunnerExecutable('localhost');
  gates.assertRunnerExecutable('remote:gpu-box');
  assertThrows(
    () => gates.assertRunnerExecutable('carrier-pigeon'),
    /not a runner this engine can execute/,
    'unknown values keep the fail-closed default',
  );
});

test('stage 86: direct runs write runner: "direct" in the record; the snapshot driver reads records LACKING runner unchanged', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  gates.runGatesForBranch(dir, { branch: 'feat/stage-1-first', runner: 'direct', ...QUIET });
  const file = recordPath(dir, 'feat/stage-1-first');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertEqual(rec.runner, 'direct', 'the ADDITIVE field names where the exit codes came from');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'reads green with the field present');
  // Regression fixture: a pre-stage-86 record (no runner field) stays a valid
  // v1 record and reads IDENTICALLY — absent ⇒ direct (contract additive note).
  const { runner: _dropped, ...legacy } = rec;
  fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'absent runner reads unchanged');
  assertEqual(sub.localChecksGreen(dir, 1), true, 'older records stay valid');
});

test('stage 86→89 CLI: verity gates run under a resolved remote:<name> runner refuses at the SSH preflight — no record, loud', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  fs.writeFileSync(
    path.join(dir, '.verity', 'autonomy.yml'),
    'substrate: local\ngate_runner: remote:gpu-box\n',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'policy: remote runner');
  // Stage 88: the CLI resolves the name against the VERITY_HOME catalog first
  // (a valid entry here); stage 89: execution reaches the remote preflight,
  // where the unreachable stubbed ssh refuses — never a real connection.
  const env = { VERITY_HOME: runnerCatalogHome(), VERITY_SSH_BIN: downSshStub() };
  let r = runCli(['run', '--branch', 'feat/stage-1-first'], dir, env);
  assert(r.code !== 0, 'refused by exit code');
  assert(
    r.stderr.includes("gate_runner 'remote:gpu-box' preflight: SSH to ci@gpu.lan is not reachable"),
    `the preflight refusal is loud: ${r.stderr}`,
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  // The --no-record path refuses with the stage-89 record-free rule (no
  // committed sha to test) — never a silent direct run, and never SSH.
  r = runCli(['run', '--no-record'], dir, env);
  assert(
    r.code !== 0 && r.stderr.includes('names no committed sha for the remote runner'),
    r.stderr,
  );
  // Stage 88 ordering, CLI-shaped: a TYPO'd name is a CONFIG error naming the
  // catalog's known entries — the placeholder is never reached.
  fs.writeFileSync(
    path.join(dir, '.verity', 'autonomy.yml'),
    'substrate: local\ngate_runner: remote:gpu-boxx\n',
  );
  r = runCli(['run', '--no-record'], dir, env);
  assert(r.code !== 0, 'config error by exit code');
  assert(
    r.stderr.includes("no entry named 'gpu-boxx'") && r.stderr.includes('known entries: gpu-box'),
    `typo reads as a config error: ${r.stderr}`,
  );
  assert(!r.stderr.includes('not yet implemented'), 'the placeholder never fired');
});

// --- stage 88 (ADR-0030): remote:<name> resolves against the catalog FIRST ---

test('stage 88 ordering: an UNKNOWN remote name fails as a byte-stable CONFIG error BEFORE the stage-86 placeholder — catalog path + known entries, NO record', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const home = runnerCatalogHome(); // knows gpu-box, not gpu-boxx
  const catalog = path.join(home, 'gate-runners.md');
  const err = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'remote:gpu-boxx',
        home,
        ...QUIET,
      }),
    /no entry named 'gpu-boxx'/,
    'typo runner name',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-boxx': no entry named 'gpu-boxx' in the gate-runner catalog ${catalog} — known entries: gpu-box; fix the name in .verity/autonomy.yml or add the entry with \`verity gate-runners edit\` (ADR-0030); no gates ran and no record is written`,
    'byte-stable fail-closed config error',
  );
  assert(!/not yet implemented/.test(err.message), 'NOT the unimplemented placeholder');
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN, 'honestly UNKNOWN downstream');
  // Same ordering on the record-free path.
  assertThrows(
    () => gates.runGatesHere(dir, { runner: 'remote:gpu-boxx', home, ...QUIET }),
    /no entry named 'gpu-boxx'/,
    'runGatesHere resolves first too',
  );
});

test('stage 88 ordering: a MISSING catalog file fails closed with the catalog path — before the placeholder, NO record', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-nohome-')); // no catalog file
  const catalog = path.join(home, 'gate-runners.md');
  const err = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'remote:gpu-box',
        home,
        ...QUIET,
      }),
    /no gate-runner catalog/,
    'missing catalog',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-box': no gate-runner catalog at ${catalog} — seed and edit it with \`verity gate-runners edit\`, adding a '## gpu-box — <title>' entry (ADR-0030: names resolve against the global catalog at preflight, never mid-run); no gates ran and no record is written`,
    'byte-stable fail-closed config error',
  );
  assert(!/not yet implemented/.test(err.message), 'NOT the unimplemented placeholder');
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  // Non-remote runners never touch the catalog: the same catalog-less home
  // changes NOTHING for direct (kill-switch by design — inert unless
  // remote:<name> is configured).
  const res = gates.runGatesForBranch(dir, {
    branch: 'feat/stage-1-first',
    runner: 'direct',
    home,
    ...QUIET,
  });
  assertEqual(res.ok, true, 'direct runs byte-identically with no catalog anywhere');
});

// --- stage 87 (ADR-0030): the localhost act runner ---------------------------
// Real git in mkdtemp repos; act/docker are STUB executables reached through
// the VERITY_ACT_BIN / VERITY_DOCKER_BIN overrides (the stage-81/82 pattern —
// no real Docker, no real act, no network). The act stub records its argv and
// copies the workflow file it was pointed at, so the tests can prove WHAT the
// engine asked act to run without ever parsing act output for judgment.

const gatesAct = require('../verity/bin/lib/gates-act.cjs');

// Restore one env var to its pre-test value (the worker/CLI paths read the
// ambient environment, so those tests set process.env for their duration).
function restoreEnv(key, val) {
  if (val === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = val;
  }
}

// Stub executables for one test: docker (daemonful or daemonless), act
// (green/red/unparseable/head-mover). Capture paths are baked into the stub
// text — the engine spawns act with the ambient environment, so env-var
// plumbing from the test would be another moving part.
function actStubs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-act-stubs-'));
  const argsFile = path.join(dir, 'act-args.txt');
  const workflowCopy = path.join(dir, 'workflow-copy.yml');
  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const actBody = (exit) => `if [ "$1" = "--version" ]; then echo "act version 0.2.89"; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
prev=""
for a in "$@"; do
  if [ "$prev" = "--workflows" ]; then cp "$a" "${workflowCopy}"; fi
  prev="$a"
done
exit ${exit}`;
  return {
    dir,
    argsFile,
    workflowCopy,
    dockerOk: write(
      'docker-ok',
      'if [ "$1" = "--version" ]; then echo "Docker version 27.0.1, build abc"; fi\nexit 0',
    ),
    dockerNoDaemon: write(
      'docker-nodaemon',
      `case "$1" in
  --version) echo "Docker version 27.0.1, build abc"; exit 0;;
  info) echo "Cannot connect to the Docker daemon" >&2; exit 1;;
esac
exit 0`,
    ),
    actGreen: write('act-green', actBody(0)),
    actRed: write('act-red', actBody(3)),
    actMover: write(
      'act-mover',
      `if [ "$1" = "--version" ]; then echo "act version 0.2.89"; exit 0; fi
git commit --allow-empty -q -m mid-run-move
exit 0`,
    ),
    actUnparseable: write(
      'act-unparseable',
      'if [ "$1" = "--version" ]; then echo "act dev build"; exit 0; fi\nexit 0',
    ),
    missing: path.join(dir, 'no-such-binary'),
  };
}

test('stage 87: localhost green — act exit 0 ⇒ record runner "localhost", pinned sha, ONE truthful aggregate entry; the tree\'s workflow files are ignored', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  // A doctored workflow lying in the tree must never be what act executes —
  // the engine renders its own workflow from the committed definition.
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github', 'workflows', 'ci.yml'),
    'name: DOCTORED-WORKFLOW\non: push\njobs: {}\n',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'doctored workflow');
  const sha = makeStageBranch(dir);
  const env = { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.actGreen };
  const res = gates.runGatesForBranch(dir, {
    branch: 'feat/stage-1-first',
    runner: 'localhost',
    env,
    ...QUIET,
  });
  assertEqual(res.ok, true);
  assertEqual(res.sha, sha, 'the record claims the exact head act ran against');
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, 'feat/stage-1-first'), 'utf8'));
  assertEqual(rec.runner, 'localhost', 'the ADDITIVE field names the act runner');
  assertEqual(rec.sha, sha);
  // The documented stage-87 mapping: ONE aggregate entry, named for the
  // rendered workflow's gates job, carrying act's REAL exit code — never
  // fabricated per-gate codes act did not report.
  assertEqual(rec.gates.length, 1, 'one truthful aggregate entry');
  assertEqual(rec.gates[0].name, gatesAct.ACT_GATE_NAME);
  assertEqual(rec.gates[0].exit_code, 0);
  assert(
    rec.gates[0].command.startsWith(`${stubs.actGreen} push --workflows `),
    `the command is the real act invocation: ${rec.gates[0].command}`,
  );
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'stage 80 reads the record green');
  // act was pointed at the RENDERED temp workflow, never a file in the repo.
  const argv = fs.readFileSync(stubs.argsFile, 'utf8').trim().split('\n');
  assertEqual(argv[0], 'push');
  assertEqual(argv[1], '--workflows');
  assert(!argv[2].startsWith(dir), `workflow rendered OUTSIDE the repo tree: ${argv[2]}`);
  const wf = fs.readFileSync(stubs.workflowCopy, 'utf8');
  assert(wf.includes(sha), 'the rendered workflow names the pinned sha');
  assert(wf.includes('"ok"') && wf.includes('"true"'), 'steps replay the committed definition');
  assert(!wf.includes('DOCTORED-WORKFLOW'), 'the doctored tree workflow was ignored');
});

test("stage 87: act nonzero ⇒ red record carrying act's REAL exit code — still SHA-honest", () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  const res = gates.runGatesForBranch(dir, {
    branch: 'feat/stage-1-first',
    runner: 'localhost',
    env: { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.actRed },
    ...QUIET,
  });
  assertEqual(res.ok, false);
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, 'feat/stage-1-first'), 'utf8'));
  assertEqual(rec.runner, 'localhost');
  assertEqual(rec.sha, sha, 'red is honest too: the record still pins the tested head');
  assertEqual(rec.gates[0].exit_code, 3, "act's exact exit code, never coerced to 1");
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_RED, 'stage 80 reads the record red');
});

test('stage 87 preflight: docker binary absent ⇒ byte-stable refusal, NO record, UNKNOWN', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const err = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'localhost',
        env: { VERITY_DOCKER_BIN: stubs.missing, VERITY_ACT_BIN: stubs.actGreen },
        ...QUIET,
      }),
    /docker binary/,
    'docker absent',
  );
  assertEqual(
    err.message,
    `gate_runner 'localhost' preflight: docker binary '${stubs.missing}' is not runnable — act executes the rendered gates workflow in Docker (ADR-0030); install Docker or point VERITY_DOCKER_BIN at it; no record is written and the branch stays UNKNOWN`,
    'byte-stable refusal',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN, 'honestly UNKNOWN downstream');
});

test('stage 87 preflight: docker daemon down ⇒ byte-stable refusal, NO record (exit-code judged, never parsed)', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const err = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'localhost',
        env: { VERITY_DOCKER_BIN: stubs.dockerNoDaemon, VERITY_ACT_BIN: stubs.actGreen },
        ...QUIET,
      }),
    /daemon is not reachable/,
    'daemon down',
  );
  assertEqual(
    err.message,
    `gate_runner 'localhost' preflight: the Docker daemon is not reachable (\`${stubs.dockerNoDaemon} info\` exited nonzero) — act needs a running daemon to execute the gates workflow (ADR-0030); start Docker; no record is written and the branch stays UNKNOWN`,
    'byte-stable refusal',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
});

test('stage 87 preflight: act absent / act version unparseable ⇒ byte-stable refusals, NO record', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const absent = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'localhost',
        env: { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.missing },
        ...QUIET,
      }),
    /act binary/,
    'act absent',
  );
  assertEqual(
    absent.message,
    `gate_runner 'localhost' preflight: act binary '${stubs.missing}' is not runnable — the localhost runner executes gates via nektos/act (ADR-0030); install act or point VERITY_ACT_BIN at it; no record is written and the branch stays UNKNOWN`,
    'byte-stable refusal',
  );
  const unparseable = assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'localhost',
        env: { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.actUnparseable },
        ...QUIET,
      }),
    /could not parse an act version/,
    'act version unparseable',
  );
  assertEqual(
    unparseable.message,
    `gate_runner 'localhost' preflight: could not parse an act version from \`${stubs.actUnparseable} --version\` — refusing to run gates under an act Verity cannot identify (fail closed); no record is written and the branch stays UNKNOWN`,
    'byte-stable refusal',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN, 'honestly UNKNOWN downstream');
});

test('stage 87 preflight: a workflow that cannot be rendered to a temp location refuses — NO record', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const origTmp = process.env.TMPDIR;
  process.env.TMPDIR = path.join(stubs.dir, 'no-such-tmp');
  try {
    const err = assertThrows(
      () =>
        gates.runGatesForBranch(dir, {
          branch: 'feat/stage-1-first',
          runner: 'localhost',
          env: { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.actGreen },
          ...QUIET,
        }),
      /failed to render the gates workflow/,
      'render failure',
    );
    assert(
      err.message.startsWith(
        "gate_runner 'localhost' preflight: failed to render the gates workflow for ",
      ),
      `stable prefix: ${err.message}`,
    );
    assert(
      err.message.endsWith('no record is written and the branch stays UNKNOWN'),
      'and the fail-closed consequence',
    );
  } finally {
    restoreEnv('TMPDIR', origTmp);
  }
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
});

test('stage 87: the head-moved-mid-run refusal still fires under the localhost path (the SHARED honesty bracketing)', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: 'feat/stage-1-first',
        runner: 'localhost',
        env: { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.actMover },
        ...QUIET,
      }),
    /moved mid-run/,
    'the stage-82 bracket is the one code path for every runner',
  );
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'main', 'checkout restored');
});

test('stage 87 single-source: the rendered workflow derives from the COMMITTED definition at the pinned sha — an uncommitted gates.json edit changes NOTHING', () => {
  const dir = makeRepo([{ name: 'real', command: 'echo committed-cmd' }]);
  const sha = git(dir, 'rev-parse', 'main').trim();
  // Doctor the WORKING TREE's definition (uncommitted): the render must not see it.
  writeGatesFile(dir, [{ name: 'evil', command: 'echo EDITED-cmd' }]);
  const yaml = gatesAct.renderWorkflowAt(dir, sha);
  assert(yaml.includes('"real"') && yaml.includes('"echo committed-cmd"'), 'committed gates only');
  assert(!yaml.includes('EDITED-cmd'), 'the uncommitted edit shaped nothing');
  assert(yaml.includes(sha), 'the header names the sha it was rendered from');
  assert(yaml.includes('actions/checkout@v4'), 'graduation-shaped: checkout first');
  assert(yaml.includes('runs-on: ubuntu-latest'), 'the scaffolded runner image');
  // Names/commands are embedded as JSON strings, so shell metacharacters and
  // quotes can never change the workflow's shape.
  const tricky = gatesAct.renderWorkflow(
    [{ name: 'q"uote', command: 'echo "hi" && exit 0 # {{steps}}' }],
    'abc123',
  );
  assert(tricky.includes(JSON.stringify('q"uote')), 'name JSON-escaped');
  assert(
    tricky.includes(JSON.stringify('echo "hi" && exit 0 # {{steps}}')),
    'command JSON-escaped',
  );
});

test('stage 87: the record-free path (--no-record) refuses localhost — no committed sha for act to replay, never a silent direct run', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const err = assertThrows(
    () => gates.runGatesHere(dir, { runner: 'localhost', ...QUIET }),
    /names no committed sha/,
    'runGatesHere refuses localhost',
  );
  assertEqual(
    err.message,
    "gate_runner 'localhost': the record-free path (--no-record) judges the working tree, which names no committed sha for act to replay (stage 87, ADR-0030) — run `verity gates run` without --no-record, or configure gate_runner: direct",
    'byte-stable refusal',
  );
});

test('stage 87 CLI: verity gates run under a resolved localhost policy executes act and records runner "localhost"', () => {
  const stubs = actStubs();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  fs.writeFileSync(
    path.join(dir, '.verity', 'autonomy.yml'),
    'substrate: local\ngate_runner: localhost\n',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'policy: localhost runner');
  const env = { VERITY_DOCKER_BIN: stubs.dockerOk, VERITY_ACT_BIN: stubs.actGreen };
  let r = runCli(['run', '--branch', 'feat/stage-1-first'], dir, env);
  assertEqual(r.code, 0, `green act run exits 0 (${r.stderr})`);
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, 'feat/stage-1-first'), 'utf8'));
  assertEqual(rec.runner, 'localhost', 'the policy-resolved runner reached the record');
  // The --no-record path refuses loudly (no sha to replay) — never direct.
  r = runCli(['run', '--no-record'], dir, env);
  assert(r.code !== 0 && r.stderr.includes('names no committed sha'), r.stderr);
});

test('stage 87 worker: a resolved localhost runner executes act at the gate call site — record runner "localhost", verified green', () => {
  const stubs = actStubs();
  const dir = workerFixture([{ name: 'ok', command: 'true' }]);
  // The worker spawns the engine in-process with the ambient environment, so
  // the binary overrides ride process.env for the duration of this test only.
  const orig = { docker: process.env.VERITY_DOCKER_BIN, act: process.env.VERITY_ACT_BIN };
  process.env.VERITY_DOCKER_BIN = stubs.dockerOk;
  process.env.VERITY_ACT_BIN = stubs.actGreen;
  let out;
  try {
    out = runWorkerBuild(dir, { policyPatch: { substrate: 'local', gate_runner: 'localhost' } });
  } finally {
    restoreEnv('VERITY_DOCKER_BIN', orig.docker);
    restoreEnv('VERITY_ACT_BIN', orig.act);
  }
  assertEqual(out.summary.outcome, 'success', out.summary.result);
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, 'feat/stage-1-first'), 'utf8'));
  assertEqual(rec.runner, 'localhost', 'the run-frozen gate_runner reached the record');
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'verified green through act');
  assert(
    out.notes.some((l) => l.includes('local gates for feat/stage-1-first') && l.includes('green')),
    `the act is visible in the run log: ${out.notes.join(' | ')}`,
  );
});

test('stage 87 worker: an unprovisionable localhost runner (docker absent) refuses at preflight — loud warn, NO record, honestly UNKNOWN', () => {
  const stubs = actStubs();
  const dir = workerFixture([{ name: 'ok', command: 'true' }]);
  const orig = { docker: process.env.VERITY_DOCKER_BIN, act: process.env.VERITY_ACT_BIN };
  process.env.VERITY_DOCKER_BIN = stubs.missing;
  process.env.VERITY_ACT_BIN = stubs.actGreen;
  let out;
  try {
    out = runWorkerBuild(dir, { policyPatch: { substrate: 'local', gate_runner: 'localhost' } });
  } finally {
    restoreEnv('VERITY_DOCKER_BIN', orig.docker);
    restoreEnv('VERITY_ACT_BIN', orig.act);
  }
  assertEqual(out.summary.outcome, 'success', 'loud-but-non-fatal: the run itself completes');
  assert(!fs.existsSync(recordPath(dir, 'feat/stage-1-first')), 'no record written');
  assertEqual(
    sub.localCiStateFor(dir, 1),
    ledger.CI_UNKNOWN,
    'UNKNOWN — never a silent direct execution on a different runner than configured',
  );
  assert(
    out.notes.some((l) => l.includes('docker binary') && l.includes('wrote no record')),
    `the preflight refusal is visible in the run log: ${out.notes.join(' | ')}`,
  );
});

// --- scaffold: the generated workflow consumes the SAME definition -----------

test('scaffold: ci.yml carries the gates job and the definition-reading runner is emitted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-scaf-'));
  identity.lock(dir, { name: 'Demo', slug: 'demo', owner: 'acme' });
  const r = scaffold.init(dir, {});
  assert(r.created.includes('.verity/run-gates.cjs'), 'runner script scaffolded');
  const ci = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
  assert(ci.includes('gates:'), 'gates job present');
  assert(ci.includes('node .verity/run-gates.cjs'), 'the job executes the committed runner');
  assert(ci.includes('.verity/gates.json'), 'the workflow names the single-source definition');
});

function runScaffoldedRunner(dir) {
  try {
    const out = execFileSync('node', ['.verity/run-gates.cjs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0, stderr: '' };
  } catch (err) {
    return { out: err.stdout || '', code: err.status, stderr: err.stderr || '' };
  }
}

test('scaffold: the emitted runner FAILS LOUDLY with no definition, runs green/red by exit code with one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-scafrun-'));
  identity.lock(dir, { name: 'Demo', slug: 'demo', owner: 'acme' });
  scaffold.init(dir, {});
  // No definition: loud failure, never a silently green empty job.
  let r = runScaffoldedRunner(dir);
  assert(r.code !== 0, 'no definition must never exit 0');
  assert(r.stderr.includes('no gate definition'), `says so explicitly: ${r.stderr}`);
  assert(r.stderr.includes('never report a green check'), 'and says WHY');
  // Empty gate list: same refusal.
  writeGatesFile(dir, []);
  r = runScaffoldedRunner(dir);
  assert(r.code !== 0 && r.stderr.includes('at least one gate'), 'empty list refused');
  // Green definition: exit 0.
  writeGatesFile(dir, [{ name: 'ok', command: 'true' }]);
  r = runScaffoldedRunner(dir);
  assertEqual(r.code, 0, `green exits 0 (${r.stderr})`);
  // Exit-code truth: prints PASS, exits 1 ⇒ the job fails with that code.
  writeGatesFile(dir, [{ name: 'liar', command: 'echo PASS && exit 1' }]);
  r = runScaffoldedRunner(dir);
  assertEqual(r.code, 1, 'judged by exit code only, never by output');
});

// --- claude narrowing (stage-81 carried item, resolved here) ------------------

test('claude: narrowForSubstrate strips gh/WebFetch/WebSearch on local — nothing else; github returns the SAME object', () => {
  const allowlist = [
    'Read',
    'Edit',
    'Bash(git:*)',
    'Bash(npm test:*)',
    'Bash(npx:*)',
    'Bash(verity stage:*)',
    'Bash(gh pr create:*)',
    'Bash(gh issue view:*)',
    'WebFetch',
    'WebSearch(domain:example.com)',
  ];
  const policy = { allowlist };
  const local = claude.narrowForSubstrate(policy, 'local');
  assertEqual(
    JSON.stringify(local.allowlist),
    JSON.stringify([
      'Read',
      'Edit',
      'Bash(git:*)',
      'Bash(npm test:*)',
      'Bash(npx:*)',
      'Bash(verity stage:*)',
    ]),
    'gh + network tools stripped, everything else verbatim',
  );
  assertEqual(policy.allowlist.length, 10, 'input policy unmutated');
  assert(claude.narrowForSubstrate(policy, 'github') === policy, "'github' is a no-op reference");
  assert(claude.narrowForSubstrate(policy, undefined) === policy, 'absent is a no-op reference');
  // Fail closed: an allowlist that narrows to NOTHING refuses the dispatch.
  assertThrows(
    () => claude.narrowForSubstrate({ allowlist: ['Bash(gh pr view:*)', 'WebFetch'] }, 'local'),
    /leaving NO tools/,
    'empty narrowed surface refused',
  );
});

// Full stubbed dispatch: the packaged build role carries gh grants; a LOCAL
// dispatch proceeds (no throw) with them stripped from --allowed-tools; a
// GITHUB dispatch passes the role file's list verbatim (byte-identical).
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args));
if (process.env.STUB_TRANSCRIPT) process.stdout.write(fs.readFileSync(process.env.STUB_TRANSCRIPT, 'utf8'));
process.exit(0);
`;

function claudeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-claude-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub');
  fs.writeFileSync(stub, STUB);
  fs.chmodSync(stub, 0o755);
  const transcript = path.join(dir, 'canned.jsonl');
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done\n{"verity":1,"outcome":"success","gate":null,"artifacts":{},"reason":"ok"}',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
    })}\n`,
  );
  return { dir, home, stub, transcript };
}

function dispatchClaude(fx, extraArgs) {
  const argvFile = path.join(fx.dir, `argv-${extraArgs.length}.json`);
  const out = execFileSync(
    'node',
    [CLI, 'agent-exec', 'build', '1', '--run-id', 'r-1', ...extraArgs, '--cwd', fx.dir, '--json'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: fx.home,
        VERITY_AGENT_BIN: fx.stub,
        STUB_ARGV_FILE: argvFile,
        STUB_TRANSCRIPT: fx.transcript,
      },
    },
  );
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  return { result: JSON.parse(out.split('\n').filter(Boolean)[0]), argv };
}

function allowedTools(argv) {
  const i = argv.indexOf('--allowed-tools');
  assert(i !== -1, 'argv carries --allowed-tools');
  return argv.slice(i + 1);
}

test('claude: a LOCAL dispatch proceeds with gh/network tools stripped; a github dispatch surface is byte-identical to the role file', () => {
  const fx = claudeFixture();
  const packaged = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'commands', 'verity', 'build.tools.json'), 'utf8'),
  );
  assert(
    packaged.some((t) => t.startsWith('Bash(gh')),
    'precondition: the packaged build role declares gh grants',
  );
  // github (flag absent): the T06 allowlist passes through VERBATIM.
  const github = dispatchClaude(fx, []);
  assertEqual(github.result.outcome, 'success');
  assertEqual(
    JSON.stringify(allowedTools(github.argv)),
    JSON.stringify(packaged),
    'github dispatch surface byte-identical',
  );
  // local: the dispatch PROCEEDS (the stage-81 fail-closed throw is resolved)
  // and every gh grant is gone from the surface the harness enforces.
  const local = dispatchClaude(fx, ['--substrate', 'local']);
  assertEqual(local.result.outcome, 'success', 'local claude dispatch no longer refuses');
  const tools = allowedTools(local.argv);
  assert(
    !tools.some((t) => /^\s*Bash\(\s*gh/.test(t) || /^Web(Fetch|Search)/.test(t)),
    `no gh/network grant survives: ${JSON.stringify(tools)}`,
  );
  assertEqual(
    JSON.stringify(tools),
    JSON.stringify(packaged.filter((t) => !/^\s*Bash\(\s*gh/.test(t))),
    'exactly the gh grants are stripped — nothing else changes',
  );
});
