// Stage 89 (ADR-0030) — the remote act runner: `gate_runner: remote:<name>`
// pushes the judged branch's pinned sha to a Verity-owned runner-side clone
// over SSH, checks it out there, ships the LOCALLY rendered workflow, runs
// act in Docker on the remote, and records the stage-87 one-aggregate-entry
// verdict under runner "remote:<name>".
//
// Test rig (the stage-81/82/87 pattern — real git in mkdtemp repos, NO real
// network): the `ssh` binary is a STUB reached through VERITY_SSH_BIN that
// SIMULATES the remote ON THIS MACHINE — it validates BatchMode, logs the
// remote command, re-homes `~` into a fixture "remote home", prepends a
// fixture bin dir (stub `docker`/`act`) to PATH, and executes the command
// locally. Real git therefore runs on BOTH sides: `git push` genuinely
// transports the pinned sha into the fixture clone through the stub channel
// (GIT_SSH_COMMAND), `git checkout`/`rev-parse` genuinely run in it — so the
// green path proves the actual plumbing, not a mock of it, while refusal
// variants (ssh down, docker/act broken, push failure, rev-parse lying,
// act sleeping past the budget) are byte-stable-message + NO-record checks.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gates = require('../verity/bin/lib/gates.cjs');
const gatesAct = require('../verity/bin/lib/gates-act.cjs');
const gatesRemote = require('../verity/bin/lib/gates-remote.cjs');
const ledger = require('../verity/bin/lib/ledger.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');

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

function writeGatesFile(dir, gatesList) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.verity', 'gates.json'),
    `${JSON.stringify({ schema: 1, gates: gatesList }, null, 2)}\n`,
  );
}

function makeRepo(gatesList) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gates-remote-'));
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', 'stage-1-first.md'),
    '# Stage 1: First\n\n- **Type:** feature\n- **Depends on:** none\n',
  );
  if (gatesList !== undefined) {
    writeGatesFile(dir, gatesList);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

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
const BRANCH = 'feat/stage-1-first';

// The stage-88 catalog fixture, credential-note included: the secret-key.pem
// LOCATION must never travel into records or refusals.
const CATALOG = [
  '## gpu-box — GPU box',
  '- **status:** active',
  '- **host:** gpu.lan',
  '- **user:** ci',
  '- **access:** key at ~/.ssh/secret-key.pem (location only)',
  '',
].join('\n');

// --- the simulated remote -----------------------------------------------------

// Build the "remote": a fixture home dir, a fixture bin dir carrying stub
// docker/act, and the ssh stub that executes remote commands locally against
// them. Variants swap in broken stubs or intercept single commands.
function rig(variant = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-remote-rig-'));
  const home = path.join(root, 'catalog-home'); // the VERITY_HOME catalog side
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'gate-runners.md'), CATALOG);
  const remoteHome = path.join(root, 'remote-home'); // the simulated runner box
  const remoteBin = path.join(root, 'remote-bin');
  fs.mkdirSync(remoteHome, { recursive: true });
  fs.mkdirSync(remoteBin, { recursive: true });
  const callLog = path.join(root, 'ssh-calls.log');
  const actArgs = path.join(root, 'act-args.txt');
  const workflowCopy = path.join(root, 'workflow-copy.yml');

  const exe = (file, body) => {
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };

  exe(
    path.join(remoteBin, 'docker'),
    variant.dockerBroken ? 'echo "Cannot connect to the Docker daemon" >&2\nexit 1' : 'exit 0',
  );
  const actBody = variant.actAbsent
    ? 'echo "sh: act: command not found" >&2\nexit 127'
    : variant.actUnparseable
      ? 'if [ "$1" = "--version" ]; then echo "act dev build"; exit 0; fi\nexit 0'
      : `if [ "$1" = "--version" ]; then echo "act version 0.2.89"; exit 0; fi
printf '%s\\n' "$@" > "${actArgs}"
prev=""
for a in "$@"; do
  if [ "$prev" = "--workflows" ]; then cp "$a" "${workflowCopy}"; fi
  prev="$a"
done
${variant.actSleep ? `sleep ${variant.actSleep}` : ':'}
exit ${variant.actExit || 0}`;
  exe(path.join(remoteBin, 'act'), actBody);

  // The channel: swallow every `-o <opt>` pair (git's transport adds its own,
  // e.g. -o SendEnv=GIT_PROTOCOL, after our -o BatchMode=yes), REQUIRE
  // BatchMode among them (prompt-free everywhere or the run is invalid), log
  // the remote command, then execute it locally with `~` re-homed into the
  // fixture remote home and the stub bin dir first on PATH.
  const intercepts = [
    variant.pushFail
      ? 'case "$*" in *git-receive-pack*) echo "fatal: remote disk full" >&2; exit 1;; esac'
      : ':',
    variant.revParseLie
      ? `case "$*" in *"rev-parse HEAD"*) echo "${variant.revParseLie}"; exit 0;; esac`
      : ':',
  ].join('\n');
  const sshBody = variant.sshDown
    ? 'echo "Permission denied (publickey)." >&2\nexit 255'
    : `batch=no
while [ "$1" = "-o" ]; do
  [ "$2" = "BatchMode=yes" ] && batch=yes
  shift 2
done
[ "$batch" = "yes" ] || { echo "not BatchMode" >&2; exit 9; }
shift
printf '%s\\n' "$*" >> "${callLog}"
${intercepts}
export HOME="${remoteHome}"
export PATH="${remoteBin}:$PATH"
cmd=$(printf '%s' "$*" | sed "s|~|$HOME|g")
exec sh -c "$cmd"`;
  const ssh = exe(path.join(root, 'ssh'), sshBody);

  return { root, home, remoteHome, remoteBin, callLog, actArgs, workflowCopy, ssh };
}

function runRemote(dir, r, extra = {}) {
  return gates.runGatesForBranch(dir, {
    branch: BRANCH,
    runner: 'remote:gpu-box',
    home: r.home,
    env: { VERITY_SSH_BIN: r.ssh },
    ...QUIET,
    ...extra,
  });
}

// Refused runs must leave the LOCAL repo exactly as they found it: no record,
// checkout restored to main, clean tree — honestly UNKNOWN downstream.
function assertUntouched(dir, msg) {
  assert(!fs.existsSync(recordPath(dir, BRANCH)), `${msg}: no record written`);
  assertEqual(
    git(dir, 'symbolic-ref', '--short', 'HEAD').trim(),
    'main',
    `${msg}: checkout restored`,
  );
  assertEqual(git(dir, 'status', '--porcelain').trim(), '', `${msg}: tree clean`);
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_UNKNOWN, `${msg}: honestly UNKNOWN`);
}

// --- green / red --------------------------------------------------------------

test('stage 89 green: the pinned sha really lands in the runner-side clone, act runs there, record carries runner "remote:<name>" + ONE aggregate entry', () => {
  const r = rig();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  const res = runRemote(dir, r);
  assertEqual(res.ok, true);
  assertEqual(res.sha, sha, 'the record claims the exact head the runner tested');
  const slug = gatesRemote.repoSlug(dir);
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, BRANCH), 'utf8'));
  assertEqual(rec.runner, 'remote:gpu-box', 'the ADDITIVE field carries the catalog NAME only');
  assertEqual(rec.sha, sha);
  // The stage-87 mapping, held on the remote runner: ONE truthful aggregate
  // entry — act's real exit code under the real REMOTE act argv.
  assertEqual(rec.gates.length, 1, 'one truthful aggregate entry');
  assertEqual(rec.gates[0].name, gatesAct.ACT_GATE_NAME);
  assertEqual(rec.gates[0].exit_code, 0);
  assertEqual(
    rec.gates[0].command,
    `act push --workflows ~/.verity/gate-work/${slug}/workflow/gates.yml`,
    'the real remote invocation — Verity-owned paths, nothing machine-identifying',
  );
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_GREEN, 'stage 80 reads the record green');
  // REAL transport proof: the fixture clone (reached only through the stub
  // ssh channel + GIT_SSH_COMMAND push) genuinely has the pinned sha checked
  // out — the TOCTOU guard compared real heads, not echoes.
  const clone = path.join(r.remoteHome, '.verity', 'gate-work', slug, 'repo');
  assertEqual(git(clone, 'rev-parse', 'HEAD').trim(), sha, 'the runner-side clone IS at the sha');
  // act was invoked in the clone, pointed at the SHIPPED workflow file.
  const argv = fs.readFileSync(r.actArgs, 'utf8').trim().split('\n');
  assertEqual(argv[0], 'push');
  assertEqual(argv[1], '--workflows');
  assertEqual(
    argv[2],
    path.join(r.remoteHome, '.verity', 'gate-work', slug, 'workflow', 'gates.yml'),
  );
  const wf = fs.readFileSync(r.workflowCopy, 'utf8');
  assert(wf.includes(sha), 'the shipped workflow names the pinned sha');
  assert(wf.includes('"ok"') && wf.includes('"true"'), 'steps replay the committed definition');
  // Local repo state: checkout restored, judged head unmoved, record on main.
  assertEqual(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  assertEqual(git(dir, 'rev-parse', BRANCH).trim(), sha, 'judged head unmoved');
});

test("stage 89 red: act nonzero on the remote ⇒ red record carrying act's REAL exit code — still SHA-honest", () => {
  const r = rig({ actExit: 3 });
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  const res = runRemote(dir, r);
  assertEqual(res.ok, false);
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, BRANCH), 'utf8'));
  assertEqual(rec.runner, 'remote:gpu-box');
  assertEqual(rec.sha, sha, 'red is honest too: the record still pins the tested head');
  assertEqual(rec.gates[0].exit_code, 3, "act's exact exit code, never coerced to 1");
  assertEqual(sub.localCiStateFor(dir, 1), ledger.CI_RED, 'stage 80 reads the record red');
});

// --- secrets discipline -------------------------------------------------------

test('stage 89 hygiene: the record carries the catalog NAME only — no host, no user, no key path, nothing from the operator catalog', () => {
  const r = rig();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  runRemote(dir, r);
  const raw = fs.readFileSync(recordPath(dir, BRANCH), 'utf8');
  assert(raw.includes('remote:gpu-box'), 'the catalog name IS in the record');
  assert(!raw.includes('gpu.lan'), 'no host in the record');
  assert(!raw.includes('ci@'), 'no user/target in the record');
  assert(!raw.includes('secret-key'), 'no credential location in the record (stage-88 pattern)');
  assert(!raw.includes(r.remoteHome), 'no runner filesystem identity in the record');
  assert(!raw.includes(r.ssh), 'no local ssh binary path in the record');
});

// --- the workflow is the LOCAL pinned truth -----------------------------------

test('stage 89 single-source: act receives the workflow rendered from the LOCAL pinned sha — doctored files pre-planted on the remote are ignored and cleaned', () => {
  const r = rig();
  const dir = makeRepo([{ name: 'real', command: 'echo committed-cmd' }]);
  const sha = makeStageBranch(dir);
  // Pre-provision the runner-side clone with LIES: a doctored workflow at the
  // exact shipping path and a doctored untracked file inside the work tree.
  const slug = gatesRemote.repoSlug(dir);
  const base = path.join(r.remoteHome, '.verity', 'gate-work', slug);
  fs.mkdirSync(path.join(base, 'workflow'), { recursive: true });
  fs.mkdirSync(path.join(base, 'repo'), { recursive: true });
  execFileSync('git', ['-C', path.join(base, 'repo'), 'init', '-q']);
  fs.writeFileSync(path.join(base, 'workflow', 'gates.yml'), 'name: DOCTORED-WORKFLOW\n');
  fs.writeFileSync(path.join(base, 'repo', 'planted.txt'), 'stale leftover\n');
  const res = runRemote(dir, r);
  assertEqual(res.ok, true, 'the pre-existing clone is REUSED (idempotent provisioning)');
  const wf = fs.readFileSync(r.workflowCopy, 'utf8');
  assert(!wf.includes('DOCTORED-WORKFLOW'), 'the planted workflow was overwritten, never used');
  assert(wf.includes('"real"') && wf.includes('"echo committed-cmd"'), 'committed gates only');
  assert(wf.includes(sha), 'rendered from the pinned sha');
  assert(
    !fs.existsSync(path.join(base, 'repo', 'planted.txt')),
    'stale untracked leftovers are cleaned before act runs (nothing but the pinned tree)',
  );
});

// --- refusal shapes: byte-stable, NO record, local repo untouched -------------

test('stage 89 refusal: SSH unreachable ⇒ byte-stable preflight refusal, NO record, local repo untouched', () => {
  const r = rig({ sshDown: true });
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const err = assertThrows(
    () => runRemote(dir, r),
    /SSH to ci@gpu\.lan is not reachable/,
    'ssh down',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-box' preflight: SSH to ci@gpu.lan is not reachable (\`${r.ssh} -o BatchMode=yes ci@gpu.lan true\` failed: Permission denied (publickey).) — the remote runner executes over your existing SSH context, prompt-free (BatchMode, ADR-0030); fix SSH access to 'gpu-box' or point VERITY_SSH_BIN at your ssh; no record is written and the branch stays UNKNOWN`,
    'byte-stable refusal',
  );
  assertUntouched(dir, 'ssh down');
});

test('stage 89 refusal: remote Docker broken ⇒ byte-stable preflight refusal, NO record (exit-code judged, never parsed)', () => {
  const r = rig({ dockerBroken: true });
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const err = assertThrows(() => runRemote(dir, r), /remote Docker is not usable/, 'docker broken');
  assertEqual(
    err.message,
    "gate_runner 'remote:gpu-box' preflight: remote Docker is not usable (`docker info` on ci@gpu.lan failed: Cannot connect to the Docker daemon) — act executes the rendered gates workflow in Docker on the runner (ADR-0030); install Docker there and start the daemon; no record is written and the branch stays UNKNOWN",
    'byte-stable refusal',
  );
  assertUntouched(dir, 'docker broken');
});

test('stage 89 refusal: remote act absent / version unparseable ⇒ byte-stable preflight refusals, NO record', () => {
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const absent = assertThrows(
    () => runRemote(dir, rig({ actAbsent: true })),
    /remote act is not runnable/,
    'act absent',
  );
  assertEqual(
    absent.message,
    "gate_runner 'remote:gpu-box' preflight: remote act is not runnable (`act --version` on ci@gpu.lan failed: sh: act: command not found) — the remote runner executes gates via nektos/act (ADR-0030); install act there; no record is written and the branch stays UNKNOWN",
    'byte-stable refusal',
  );
  const unparseable = assertThrows(
    () => runRemote(dir, rig({ actUnparseable: true })),
    /could not parse an act version/,
    'act unparseable',
  );
  assertEqual(
    unparseable.message,
    "gate_runner 'remote:gpu-box' preflight: could not parse an act version from `act --version` on ci@gpu.lan (got: act dev build) — refusing to run gates under an act Verity cannot identify (fail closed); no record is written and the branch stays UNKNOWN",
    'byte-stable refusal',
  );
  assertUntouched(dir, 'act preflight');
});

test('stage 89 refusal: push failure ⇒ stable-shaped refusal, NO record, local repo untouched', () => {
  const r = rig({ pushFail: true });
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  const err = assertThrows(() => runRemote(dir, r), /pushing .* to the runner-side clone/, 'push');
  assert(
    err.message.startsWith(
      `gate_runner 'remote:gpu-box': pushing ${sha} to the runner-side clone on ci@gpu.lan failed (`,
    ),
    `stable prefix: ${err.message}`,
  );
  assert(
    err.message.endsWith('no record is written and the branch stays UNKNOWN'),
    'and the fail-closed consequence',
  );
  assertUntouched(dir, 'push failure');
});

test('stage 89 TOCTOU: a runner-side head that is not the pinned sha refuses BEFORE any record — byte-stable, one hop out', () => {
  const lie = '0123456789abcdef0123456789abcdef01234567';
  const r = rig({ revParseLie: lie });
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  const sha = makeStageBranch(dir);
  const err = assertThrows(() => runRemote(dir, r), /TOCTOU/, 'sha mismatch');
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-box': the runner-side work tree has ${lie} checked out, not the pinned ${sha} — refusing to write a record claiming a head the runner did not test (the stage-84 TOCTOU guard, one hop out; fail closed); no record is written and the branch stays UNKNOWN`,
    'byte-stable refusal',
  );
  assert(!fs.existsSync(r.actArgs), 'act never ran on an unverified head');
  assertUntouched(dir, 'sha mismatch');
});

test('stage 89 timeout: a remote run that exceeds the wall-clock budget is a byte-stable refusal — never a hang, never a record', () => {
  const r = rig({ actSleep: 30 });
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const started = Date.now();
  const err = assertThrows(
    () => runRemote(dir, r, { timeoutSecs: 3 }),
    /exceeded its 3s wall-clock budget/,
    'timeout',
  );
  assert(Date.now() - started < 20000, 'the run was killed, not waited out');
  assertEqual(
    err.message,
    "gate_runner 'remote:gpu-box': the remote gate run exceeded its 3s wall-clock budget (VERITY_GATE_TIMEOUT_SECS, default 1800) — a timed-out run is a refusal, never a hang or a silent pass (stage 89, ADR-0030); no record is written and the branch stays UNKNOWN",
    'byte-stable refusal',
  );
  assertUntouched(dir, 'timeout');
});

test('stage 89 config: a malformed VERITY_GATE_TIMEOUT_SECS is a loud error, never a silent default', () => {
  assertThrows(
    () => gatesRemote.timeoutSecs({ env: { VERITY_GATE_TIMEOUT_SECS: 'soon' } }),
    /VERITY_GATE_TIMEOUT_SECS must be a positive integer/,
    'malformed budget',
  );
  assertEqual(gatesRemote.timeoutSecs({}), gatesRemote.DEFAULT_TIMEOUT_SECS, 'absent ⇒ default');
  assertEqual(gatesRemote.timeoutSecs({ env: { VERITY_GATE_TIMEOUT_SECS: '60' } }), 60);
});

// --- ordering + kill-switch (stage-88 coherence with the executor live) -------

test('stage 89 ordering: a typo’d name is STILL a config error first — the ssh channel is never even opened', () => {
  const r = rig();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  assertThrows(
    () =>
      gates.runGatesForBranch(dir, {
        branch: BRANCH,
        runner: 'remote:gpu-boxx',
        home: r.home,
        env: { VERITY_SSH_BIN: r.ssh },
        ...QUIET,
      }),
    /no entry named 'gpu-boxx'.*known entries: gpu-box/,
    'config error first (stage 88 ordering, held with the executor live)',
  );
  assert(!fs.existsSync(r.callLog), 'no SSH call was ever made');
  assertUntouched(dir, 'typo name');
});

test('stage 89 kill-switch: direct runs are byte-identical with the rig present — no catalog read, no ssh, no remote fields', () => {
  const r = rig();
  const dir = makeRepo([{ name: 'ok', command: 'true' }]);
  makeStageBranch(dir);
  const res = gates.runGatesForBranch(dir, {
    branch: BRANCH,
    runner: 'direct',
    home: r.home,
    env: { VERITY_SSH_BIN: r.ssh },
    ...QUIET,
  });
  assertEqual(res.ok, true);
  assert(!fs.existsSync(r.callLog), 'the direct runner never touches the ssh channel');
  const rec = JSON.parse(fs.readFileSync(recordPath(dir, BRANCH), 'utf8'));
  assertEqual(rec.runner, 'direct');
  assertEqual(JSON.stringify(rec.gates), '[{"name":"ok","command":"true","exit_code":0}]');
});

// --- repo-slug derivation -----------------------------------------------------

test('stage 89 repoSlug: locked identity slug wins, basename is the fallback, output is always path/shell-safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-slug-Test_1-'));
  assertEqual(
    gatesRemote.repoSlug(dir),
    path.basename(dir).toLowerCase(),
    'no identity ⇒ sanitized basename',
  );
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.verity', 'identity.json'),
    JSON.stringify({ schema: 1, slug: 'demo-app' }),
  );
  assertEqual(gatesRemote.repoSlug(dir), 'demo-app', 'the locked identity slug wins');
  // Determinism: the same repo always maps to the same runner-side clone.
  assertEqual(gatesRemote.repoSlug(dir), gatesRemote.repoSlug(dir));
  // Hostile characters can never reach the remote shell.
  fs.writeFileSync(
    path.join(dir, '.verity', 'identity.json'),
    JSON.stringify({ schema: 1, slug: 'My App; rm -rf /' }),
  );
  assertEqual(gatesRemote.repoSlug(dir), 'my-app-rm--rf', 'sanitized to the safe charset');
});
