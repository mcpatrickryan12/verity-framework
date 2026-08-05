// Stage 17 (ADR-0012 — the model edits files, Verity performs git): the stage
// lifecycle git for the codex path, moved OUT of the model's execution context
// and into deterministic Verity code.
//
// The defect this closes: under `workspace-write` the model can read history and
// edit the working tree but cannot write under `.git` at all (`checkout -b` and
// `commit` are both rc=128 "Read-only file system"). Roles never ran raw git —
// `commands/verity/build.md` runs `verity stage branch` / `verity stage pr` —
// but the CLI those steps invoke was shelling git INSIDE the sandbox, so a codex
// build role could not produce a branch, a commit, or a PR at all. Verity now
// performs all three around the run.
//
// What is proven here, all against REAL git (real repos, real worktrees, a real
// bare `origin` that is really pushed to):
//   1. the branch is created by VERITY, outside the model's context, BEFORE
//      dispatch — the model observes it already checked out;
//   2. the role is TOLD the truth in its rendered prompt;
//   3. after a successful run Verity commits, pushes, and opens the PR — from
//      the gated ACCEPTED set at tier 2, from the working-tree diff at tier 1;
//   4. a run that changed nothing commits NOTHING and says so;
//   5. a containment-REJECTED tier-2 run never reaches the commit;
//   6. a `git_write` grant Verity cannot provide REFUSES the run (exit 30)
//      instead of finishing with no history;
//   7. claude is untouched — it declares none of the hooks and its rendered
//      prompt is byte-identical whatever render context it is handed.
//
// BINDING TEST RULE (issue #28, spike F4): every test that asserts a DENIAL
// makes the stub write a LIVENESS MARKER in the SAME invocation, after all its
// scripted actions. "Nothing was committed" is a pass ONLY when the marker
// proves the command ran; a missing marker is an INVALID TEST, never a pass.
//
// The real Codex CLI is not available in CI, so the model runtime is a stub —
// but everything Verity owns (every git and `gh` decision) runs for real.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../verity/bin/lib/agents/claude.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const gitLifecycle = require('../verity/bin/lib/agents/git-lifecycle.cjs');
const install = require('../verity/bin/lib/install.cjs');
const policyLib = require('../verity/bin/lib/agents/policy.cjs');
const stageLib = require('../verity/bin/lib/stage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const LIB_DIR = path.join(__dirname, '..', 'verity', 'bin', 'lib');
const ROLES_DIR = path.join(__dirname, '..', 'commands', 'verity');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// The codex stand-in. Records what it OBSERVED (its cwd, the branch checked out
// there, the prompt it was handed), performs its scripted writes, and — LAST, so
// its presence proves the whole body ran — writes the liveness marker beside the
// run's transcripts, outside the repository.
const ROLE_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli ${MIN_CODEX}\\n'); process.exit(0); }
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
const flag = (n) => args[args.indexOf(n) + 1];
const cwd = flag('--cd');
const logDir = path.dirname(flag('--output-last-message'));
// The script is delivered through the run's OWN state root (\$HOME/.verity),
// never through the repository: a script that lived in the repo would have to
// be committed, and would then travel — or fail to travel — with whatever
// branch Verity checked out. This fixture must be able to change the script
// between dispatches without touching git at all.
const cfg = JSON.parse(fs.readFileSync(path.join(logDir, '..', '..', 'stub.json'), 'utf8'));
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(logDir, 'prompt.txt'), prompt);
const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
fs.writeFileSync(path.join(logDir, 'probe.json'), JSON.stringify({
  cd: cwd,
  branch: (branch.stdout || '').trim(),
}));
for (const w of cfg.writes || []) {
  const target = path.join(cwd, w.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, w.text);
}
// LIVENESS MARKER — written last: present ⇒ every action above was attempted.
fs.writeFileSync(path.join(logDir, 'liveness.marker'), 'ran\\n');
const marker = 'Done.\\n{"verity":1,"outcome":"' + (cfg.outcome || 'success') + '","gate":null,"artifacts":{},"reason":"ok"}';
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: marker } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`;

// A `gh` stand-in on PATH: the ONLY GitHub surface this stage uses is
// `pr list --head` / `pr create`, and every call is logged so "Verity opened it"
// is provable rather than assumed.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');
const read = () => JSON.parse(fs.readFileSync(process.env.GH_PRS, 'utf8'));
const head = () => args[args.indexOf('--head') + 1];
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(read().filter((p) => p.head === head())));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  if (process.env.GH_PR_CREATE_FAIL) {
    process.stderr.write('HTTP 422: injected pr create failure\\n');
    process.exit(1);
  }
  const prs = read();
  const number = 200 + prs.length;
  prs.push({ number, head: head(), title: args[args.indexOf('--title') + 1] });
  fs.writeFileSync(process.env.GH_PRS, JSON.stringify(prs));
  process.stdout.write('https://github.test/o/r/pull/' + number + '\\n');
  process.exit(0);
}
process.stderr.write('HTTP 404: unhandled gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`;

// The proof subject: a role that HOLDS git_write (so Verity performs its git)
// and github_write (so Verity may open its PR).
const BUILDER = {
  schema_version: 1,
  capabilities: {
    read_repository: true,
    write_repository: true,
    run_tests: true,
    git_read: true,
    git_write: true,
    github_read: true,
    github_write: true,
    network: false,
    deploy: false,
  },
  codex: { sandbox: 'workspace-write', approval: 'never' },
};

function withCaps(caps) {
  const next = JSON.parse(JSON.stringify(BUILDER));
  Object.assign(next.capabilities, caps);
  return next;
}

// `network: false` is the one restriction Verity cannot enforce on the exec
// path, so every run acknowledges it (or is refused at tier 1).
const ACK = ['--acknowledge-gaps', 'network'];
const TIER2 = ['--containment-tier', '2'];

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

// A REAL repository, a REAL bare origin, and a stage instruction file so the
// branch name is derived exactly as `verity stage branch` derives it. Everything
// the harness owns ($HOME, the stubs, the remote) is a SIBLING of the repo, so
// the repo's `git status` only ever reflects the role's work.
function fixture(permissions = BUILDER, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gitlc-'));
  const dir = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const ghBin = path.join(root, 'gh-bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ghBin, { recursive: true });

  const stub = path.join(root, 'codex-stub');
  fs.writeFileSync(stub, ROLE_STUB);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(ghBin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(ghBin, 'gh'), 0o755);
  const prsFile = path.join(root, 'prs.json');
  fs.writeFileSync(prsFile, '[]');
  const callsFile = path.join(root, 'gh-calls.jsonl');
  fs.writeFileSync(callsFile, '');

  const roleDir = path.join(dir, 'commands', 'verity');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, 'builder.md'),
    '---\nname: verity:builder\ndescription: Build stage $ARGUMENTS.\n---\nBuild stage $ARGUMENTS.\n',
  );
  fs.writeFileSync(
    path.join(roleDir, 'builder.permissions.json'),
    JSON.stringify(permissions, null, 2),
  );
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.txt'), 'baseline\n');
  // Stage 1 exists on disk, so `feat/stage-1-core` is the branch BOTH the
  // interactive `verity stage branch` and this module derive. `stages: 2` adds a
  // second one, for the "stage N+1 must not fork off stage N" regression.
  stageLib.create(dir, 'Core');
  if (opts.stages === 2) {
    stageLib.create(dir, 'Second');
  }

  const origin = path.join(root, 'origin.git');
  let base = null;
  if (opts.git !== false) {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'verity@example.test']);
    git(dir, ['config', 'user.name', 'Verity Test']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'baseline']);
    base = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (opts.remote !== false) {
      execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' });
      git(dir, ['remote', 'add', 'origin', origin]);
      git(dir, ['push', '-q', 'origin', base]);
      // `refs/remotes/origin/HEAD` is what `git clone` records and what
      // resolveBase prefers. `remoteHead: false` removes it, exercising the
      // second rung of the ladder.
      if (opts.remoteHead !== false) {
        git(dir, ['remote', 'set-head', 'origin', base]);
      }
    }
  }
  return { root, dir, home, stub, roleDir, ghBin, prsFile, callsFile, origin, base };
}

function logDir(fx, runId) {
  return path.join(fx.home, '.verity', 'logs', runId);
}

// The issue-#28 gate: a denial assertion is only meaningful if the command
// actually ran. Marker absent ⇒ INVALID TEST, never a pass.
function assertLive(fx, runId, label) {
  const marker = path.join(logDir(fx, runId), 'liveness.marker');
  assert(
    fs.existsSync(marker),
    `INVALID TEST (${label}): no liveness marker at ${marker} — the stub never completed its actions, so any "nothing was committed" reading is meaningless (issue #28)`,
  );
}

// One agent-exec run through the real CLI. The stub's script is delivered
// through the run's state root, NOT the repository, so changing it between
// dispatches never touches git — the repository stays exactly as clean or as
// dirty as a test intends it to be.
function run(fx, opts = {}) {
  const runId = opts.runId || 'g1';
  fs.mkdirSync(path.join(fx.home, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(fx.home, '.verity', 'stub.json'),
    JSON.stringify({ writes: opts.writes || [], outcome: opts.outcome }),
  );
  const argv = [
    CLI,
    'agent-exec',
    'builder',
    ...(opts.roleArgs === undefined ? ['1'] : opts.roleArgs),
    '--run-id',
    runId,
    '--agent',
    'codex',
    '--cwd',
    fx.dir,
    '--json',
    ...(opts.args === undefined ? ACK : opts.args),
  ];
  const res = spawnSync('node', argv, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.ghBin}${path.delimiter}${process.env.PATH}`,
      HOME: fx.home,
      GH_PRS: fx.prsFile,
      GH_CALLS: fx.callsFile,
      ...(opts.env || {}),
      VERITY_CODEX_BIN: fx.stub,
      VERITY_CLAUDE_BIN: '',
      VERITY_AGENT_BIN: '',
    },
  });
  return { out: res.stdout || '', stderr: res.stderr || '', code: res.status, runId };
}

function resultObject(res) {
  const lines = String(res.out).split('\n').filter(Boolean);
  assertEqual(lines.length, 1, `exactly one result object on stdout (stderr: ${res.stderr})`);
  return JSON.parse(lines[0]);
}

function probe(fx, runId) {
  return JSON.parse(fs.readFileSync(path.join(logDir(fx, runId), 'probe.json'), 'utf8'));
}

function prompt(fx, runId) {
  return fs.readFileSync(path.join(logDir(fx, runId), 'prompt.txt'), 'utf8');
}

function ghCalls(fx) {
  return fs
    .readFileSync(fx.callsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// The commits VERITY made on the branch for a role — the fixture's own
// housekeeping commits (which deliver the stub's script) are not role work and
// must never be counted as history the lifecycle produced.
function roleCommits(fx, branch = 'feat/stage-1-core') {
  return git(fx.dir, ['log', '--format=%s', branch])
    .split('\n')
    .filter((s) => s.includes('role-produced file changes'));
}

function loaded(permissions) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-glp-')), 'r.permissions.json');
  fs.writeFileSync(f, JSON.stringify(permissions));
  return policyLib.loadPolicy(f);
}

// --- 1. VERITY creates the branch, outside the model's context ------------------

test('branch: created by Verity BEFORE dispatch — the model observes it already checked out', () => {
  const fx = fixture();
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'feat/stage-1-core',
    false,
    'precondition: the stage branch does not exist yet',
  );
  const res = run(fx, { writes: [{ path: 'src/app.txt', text: 'built\n' }] });
  assertEqual(res.code, 0, `the run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'branch creation');

  // The model SAW the branch already checked out: it existed before dispatch,
  // and the role never created it (it cannot — see ADR-0012).
  assertEqual(probe(fx, res.runId).branch, 'feat/stage-1-core', 'branch checked out at dispatch');
  const obj = resultObject(res);
  assertEqual(obj.git_lifecycle.branch, 'feat/stage-1-core', 'and Verity reports which branch');
  assertEqual(obj.git_lifecycle.branch_created, true, 'created by this run');
  // Derived by the SAME code the interactive `verity stage branch` uses, so the
  // Verity-performed branch and a human's are the same branch by construction.
  assertEqual(stageLib.branchName(fx.dir, 1), 'feat/stage-1-core', 'same derivation');
});

test('branch: a second dispatch on the same stage re-uses the branch, never fails on "exists"', () => {
  const fx = fixture();
  const first = run(fx, { writes: [{ path: 'src/app.txt', text: 'one\n' }] });
  assertEqual(first.code, 0, `first dispatch (stderr: ${first.stderr})`);
  assertEqual(resultObject(first).git_lifecycle.branch_created, true, 'created the first time');

  const second = run(fx, { writes: [{ path: 'src/app.txt', text: 'two\n' }], runId: 'g1b' });
  assertEqual(second.code, 0, `re-dispatch succeeds (stderr: ${second.stderr})`);
  assertLive(fx, second.runId, 'branch re-use');
  const obj = resultObject(second);
  assertEqual(obj.git_lifecycle.branch_created, false, 'the existing branch is re-used');
  assertEqual(obj.git_lifecycle.committed, true, 'and the second run still commits');
  assertEqual(roleCommits(fx).length, 2, 'two role commits on the branch');
});

test('prompt: the role is TOLD the branch exists and that git is Verity’s job', () => {
  const fx = fixture();
  const res = run(fx, { writes: [{ path: 'src/app.txt', text: 'built\n' }] });
  assertLive(fx, res.runId, 'prompt truth');
  const text = prompt(fx, res.runId);
  assert(text.includes('feat/stage-1-core'), `the prompt names the branch:\n${text}`);
  assert(text.includes('already exists'), 'and says it already exists');
  assert(text.includes("Git is Verity's job on this run, not yours"), 'and whose job git is');
  assert(text.includes('verity stage branch'), 'and names the commands it must not run');
  assert(text.includes('opens the pull request'), 'and what Verity does afterwards');
});

// --- 2. commit / push / PR, per containment tier --------------------------------

test('tier 1: Verity commits the WORKING-TREE changes the role made, pushes, and opens the PR', () => {
  const fx = fixture();
  const res = run(fx, {
    writes: [
      { path: 'src/app.txt', text: 'edited by the role\n' },
      { path: 'src/new/deep.txt', text: 'brand new\n' },
    ],
  });
  assertEqual(res.code, 0, `the run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'tier-1 commit');
  assertEqual(probe(fx, res.runId).cd, fx.dir, 'tier 1: the role ran in the real checkout');

  const lc = resultObject(res).git_lifecycle;
  assertEqual(lc.committed, true, 'Verity committed');
  assertEqual(
    JSON.stringify(lc.paths),
    '["src/app.txt","src/new/deep.txt"]',
    'exactly the paths the role changed — sorted, attributable',
  );
  assertEqual(lc.pushed, true, 'and pushed');
  assertEqual(lc.error, null, 'with nothing to report');
  assertEqual(
    git(fx.dir, ['status', '--porcelain']).trim(),
    '',
    'the working tree is clean — the changes became history, not dirt',
  );
  // The commit is REAL and on the REAL remote.
  assertEqual(
    git(fx.dir, ['show', '--format=%s', '-s', lc.commit]).trim(),
    '[stage 1] builder: role-produced file changes',
    'deterministic, attributable subject naming the stage and the role',
  );
  assert(
    git(fx.dir, ['show', '--format=%B', '-s', lc.commit]).includes('Verity-Role: builder'),
    'the trailers make the run greppable in git log',
  );
  assertEqual(
    git(fx.dir, ['ls-remote', fx.origin, 'refs/heads/feat/stage-1-core']).trim().length > 0,
    true,
    'the branch really reached origin',
  );
  // And the PR was opened by VERITY, through gh, with the stage spec.
  const create = ghCalls(fx).find((c) => c[0] === 'pr' && c[1] === 'create');
  assert(create !== undefined, `gh pr create was called by Verity: ${JSON.stringify(ghCalls(fx))}`);
  assertEqual(create[create.indexOf('--head') + 1], 'feat/stage-1-core', 'on the stage branch');
  assertEqual(create[create.indexOf('--title') + 1], '[stage 1] Core', 'with the stage PR title');
  assertEqual(lc.pr, 200, 'the PR number is reported');
  assertEqual(resultObject(res).artifacts.pr, 200, 'and lands in the artifacts the worker reads');
});

test('tier 2: Verity commits the GATED ACCEPTED set from the merge-back', () => {
  const fx = fixture();
  const res = run(fx, {
    writes: [
      { path: 'src/app.txt', text: 'edited in the workspace\n' },
      { path: 'src/new/deep.txt', text: 'brand new\n' },
    ],
    args: [...ACK, ...TIER2],
  });
  assertEqual(res.code, 0, `the run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'tier-2 commit');
  assert(probe(fx, res.runId).cd !== fx.dir, 'tier 2: the role never ran in the real checkout');

  const obj = resultObject(res);
  assertEqual(obj.containment_tier, 2, 'tier 2 was active');
  assertEqual(
    JSON.stringify(obj.containment_merged),
    '["src/app.txt","src/new/deep.txt"]',
    'the gate accepted both paths',
  );
  assertEqual(
    JSON.stringify(obj.git_lifecycle.paths),
    JSON.stringify(obj.containment_merged),
    'and the commit is EXACTLY the accepted set — never a wider `git add -A`',
  );
  assertEqual(obj.git_lifecycle.committed, true, 'committed');
  assertEqual(obj.git_lifecycle.pushed, true, 'pushed');
  assertEqual(obj.git_lifecycle.pr, 200, 'PR opened');
  assertEqual(
    git(fx.dir, ['show', `${obj.git_lifecycle.commit}:src/new/deep.txt`]),
    'brand new\n',
    'the accepted content is what landed in history',
  );
});

test('tier 2: a DELETION in the accepted set is committed as a deletion', () => {
  const fx = fixture();
  const ws = path.join(fx.home, 'unit-ws');
  // Drive the workspace by hand so the deletion is unambiguous, then let the
  // lifecycle commit exactly what the gate accepted.
  const workspace = require('../verity/bin/lib/agents/workspace.cjs');
  // No github_write: Verity commits and pushes, and honestly opens no PR — this
  // unit is about what reaches HISTORY, not about GitHub.
  const policy = loaded(withCaps({ github_write: false }));
  const shaped = workspace.prepare({
    cwd: fx.dir,
    dir: ws,
    policy,
    protectedPaths: codex.PROTECTED_WRITE_PATHS,
  });
  fs.rmSync(path.join(ws, 'src', 'app.txt'));
  const merged = workspace.merge(shaped, policy);
  assertEqual(JSON.stringify(merged.merged), '["src/app.txt"]', 'the deletion propagated');
  workspace.cleanup(shaped);

  const plan = gitLifecycle.plan({ cwd: fx.dir, role: 'builder', roleArgs: ['1'], policy });
  const started = gitLifecycle.begin(fx.dir, gitLifecycle.assertProvidable(fx.dir, plan));
  const done = gitLifecycle.finish(fx.dir, started, { merged: merged.merged });
  assertEqual(done.error, null, `commit/push/PR succeeded (${done.error})`);
  assertEqual(done.committed, true, 'committed');
  assertEqual(
    git(fx.dir, ['show', '--name-status', '--format=', done.commit]).trim(),
    'D\tsrc/app.txt',
    'recorded as a deletion',
  );
});

// --- 3. never an empty commit ---------------------------------------------------

test('no changes: the run commits NOTHING, pushes nothing, and says so', () => {
  const fx = fixture();
  const res = run(fx, { writes: [] });
  assertEqual(res.code, 0, `a no-op run still succeeds (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'empty change set');
  const lc = resultObject(res).git_lifecycle;
  assertEqual(lc.committed, false, 'nothing was committed');
  assertEqual(lc.commit, null, 'no commit id');
  assertEqual(JSON.stringify(lc.paths), '[]', 'no paths');
  assertEqual(lc.pushed, false, 'and nothing was pushed');
  assert(lc.reason.includes('no file changes'), `and it SAYS so: ${lc.reason}`);
  assertEqual(lc.error, null, 'a no-op is not a failure');
  // The branch exists (Verity made it) and carries no empty commit.
  assertEqual(
    git(fx.dir, ['rev-parse', 'feat/stage-1-core']).trim(),
    git(fx.dir, ['rev-parse', 'HEAD']).trim(),
    'the branch is at the base commit — no empty commit was manufactured',
  );
  assertEqual(
    ghCalls(fx).length,
    0,
    'no PR was opened for a run with nothing in it (never a phantom PR)',
  );
});

test('no changes: an accepted path whose content matches HEAD is still not a commit', () => {
  const fx = fixture();
  const policy = loaded(withCaps({ github_write: false }));
  const plan = gitLifecycle.plan({ cwd: fx.dir, role: 'builder', roleArgs: ['1'], policy });
  const started = gitLifecycle.begin(fx.dir, gitLifecycle.assertProvidable(fx.dir, plan));
  // The merge-back accepted the path (the role touched it) but what it wrote is
  // byte-identical to HEAD — the belt on the never-an-empty-commit rule.
  fs.writeFileSync(path.join(fx.dir, 'src', 'app.txt'), 'baseline\n');
  const done = gitLifecycle.finish(fx.dir, started, { merged: ['src/app.txt'] });
  assertEqual(done.committed, false, 'identical-to-HEAD content is not a commit');
  assert(done.reason.includes('identical to HEAD'), `and it says why: ${done.reason}`);
  assertEqual(roleCommits(fx).length, 0, 'and no empty commit was manufactured');
});

// --- 4. a rejected containment path never reaches the commit --------------------

test('rejection: a tier-2 protected-path write fails the run LOUDLY and is never committed', () => {
  const fx = fixture();
  const res = run(fx, {
    writes: [
      { path: '.github/workflows/pwn.yml', text: 'on: push\n' },
      { path: 'src/app.txt', text: 'legitimate work in the same run\n' },
    ],
    args: [...ACK, ...TIER2],
  });
  assertLive(fx, res.runId, 'rejected path');
  assertEqual(res.code, 20, `a rejected path fails the run (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'failed', 'the role claimed success — the gate overrides it');
  assert(
    obj.error.includes('.github/workflows/pwn.yml'),
    `the error names the path (${obj.error})`,
  );
  assert(res.stderr.includes('containment-rejected'), 'loud on stderr');

  // The commit never happened, and the report says WHY.
  assertEqual(obj.git_lifecycle.committed, false, 'nothing was committed');
  assert(obj.git_lifecycle.reason.includes('failed'), `named: ${obj.git_lifecycle.reason}`);
  assertEqual(roleCommits(fx).length, 0, 'the branch carries no role commit at all');
  assertEqual(ghCalls(fx).length, 0, 'and no PR was opened for a run that failed containment');
  assert(
    !fs.existsSync(path.join(fx.dir, '.github', 'workflows', 'pwn.yml')),
    'the rejected write never reached the real repository either',
  );
});

test('rejection: a role that reports FAILURE is never committed for', () => {
  const fx = fixture();
  const res = run(fx, {
    writes: [{ path: 'src/app.txt', text: 'half-done\n' }],
    outcome: 'failed',
  });
  assertLive(fx, res.runId, 'role failure');
  assertEqual(res.code, 20, `a failed role fails the run (stderr: ${res.stderr})`);
  const lc = resultObject(res).git_lifecycle;
  assertEqual(lc.committed, false, 'a failed run produces no history');
  assert(lc.reason.includes("ended 'failed'"), `and says why: ${lc.reason}`);
  assertEqual(roleCommits(fx).length, 0, 'no commit on the branch');
});

// --- 5. capability honesty: an unprovidable grant REFUSES the run ---------------

test('honesty: git_write with no remote to push to REFUSES the run (exit 30), model never invoked', () => {
  const fx = fixture(BUILDER, { remote: false });
  const res = run(fx, { writes: [{ path: 'src/app.txt', text: 'x\n' }] });
  assertEqual(res.code, 30, `refused, never a silent no-history run (${res.stderr})`);
  assert(
    res.stderr.includes('verity-agent-exec: 30 git-unprovidable:'),
    `stderr slug line (${res.stderr})`,
  );
  assert(res.stderr.includes("no 'origin' remote"), 'names exactly what is missing');
  assert(res.stderr.includes('ADR-0012'), 'and the decision it comes from');
  assertEqual(resultObject(res).outcome, 'infra_error');
  // The refusal is REAL, not a broken stub — and it mutated nothing.
  assert(
    !fs.existsSync(path.join(logDir(fx, res.runId), 'liveness.marker')),
    'the agent was never invoked',
  );
  let branched = true;
  try {
    git(fx.dir, ['rev-parse', '--verify', 'feat/stage-1-core']);
  } catch {
    branched = false;
  }
  assertEqual(branched, false, 'and no branch was created by a refused run');
});

test('honesty: git_write outside a repository REFUSES the run rather than producing no history', () => {
  const fx = fixture(BUILDER, { git: false });
  const res = run(fx, { writes: [{ path: 'src/app.txt', text: 'x\n' }] });
  assertEqual(res.code, 30, `refused (${res.stderr})`);
  assert(res.stderr.includes('git-unprovidable'), 'with the honesty slug');
  assert(res.stderr.includes('not a git repository'), 'naming why');
  assert(
    !fs.existsSync(path.join(logDir(fx, res.runId), 'liveness.marker')),
    'the agent was never invoked',
  );
});

test('honesty: a PR Verity promised but could not open FAILS the run — never a silent success', () => {
  const fx = fixture();
  const res = run(fx, {
    writes: [{ path: 'src/app.txt', text: 'built\n' }],
    env: { GH_PR_CREATE_FAIL: '1' },
  });
  assertLive(fx, res.runId, 'pr-create failure');
  assertEqual(res.code, 20, `the run fails (stderr: ${res.stderr})`);
  const obj = resultObject(res);
  assertEqual(obj.outcome, 'failed', 'a promise Verity could not keep is a failure');
  assert(obj.error.includes('could not open its pull request'), `named: ${obj.error}`);
  assert(res.stderr.includes('git-lifecycle-failed'), 'and loud on stderr');
  assertEqual(obj.git_lifecycle.committed, true, 'the commit that DID happen is still reported');
  assertEqual(obj.git_lifecycle.pr, null, 'and the PR honestly reports as absent');
});

test('honesty: the lifecycle does NOT engage without the git_write grant', () => {
  const fx = fixture(withCaps({ git_write: false, github_write: false }));
  const res = run(fx, { writes: [{ path: 'src/app.txt', text: 'built\n' }] });
  assertEqual(res.code, 0, `the run completes unchanged (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'no-grant path');
  const obj = resultObject(res);
  assert(!('git_lifecycle' in obj), 'no lifecycle report — nothing about the run changed');
  assert(
    probe(fx, res.runId).branch !== 'feat/stage-1-core',
    "the role ran on the repository's own branch — no stage branch was created for it",
  );
  let branched = true;
  try {
    git(fx.dir, ['rev-parse', '--verify', 'feat/stage-1-core']);
  } catch {
    branched = false;
  }
  assertEqual(branched, false, 'and the stage branch does not exist');
  assert(
    !prompt(fx, res.runId).includes("Git is Verity's job"),
    'and no git preamble was rendered',
  );
});

test('honesty: git_write is wired into the ADR-0011 mechanism map as a PROVIDED capability', () => {
  assertEqual(
    policyLib.PROVIDED_CAPABILITIES.git_write,
    'verity-performed-git',
    'the grant projects to Verity-performed git',
  );
  for (const mechanism of Object.values(policyLib.PROVIDED_CAPABILITIES)) {
    assert(policyLib.MECHANISMS.includes(mechanism), `${mechanism} is a published mechanism`);
  }
  // Wired, not decorative: plan() consults the table rather than hardcoding a key.
  const src = fs.readFileSync(path.join(LIB_DIR, 'agents', 'git-lifecycle.cjs'), 'utf8');
  assert(src.includes('PROVIDED_CAPABILITIES'), 'git-lifecycle reads the map');
});

// --- 6. claude is untouched -----------------------------------------------------

test('claude: declares NONE of the git-lifecycle hooks — its coordinator path is unchanged', () => {
  for (const hook of ['planGit', 'assertGitProvidable', 'beginGit', 'finishGit', 'skipGit']) {
    assert(typeof codex[hook] === 'function', `codex declares ${hook}`);
    assert(claude[hook] === undefined, `claude declares no ${hook} — it performs its own git`);
  }
});

test('claude: renderPrompt is byte-identical whatever render context it is handed', () => {
  for (const name of ['build.md', 'ship.md', 'vision.md']) {
    const file = path.join(ROLES_DIR, name);
    const plain = claude.renderPrompt(file, ['7']);
    assertEqual(
      claude.renderPrompt(file, ['7'], { policy: {}, git: { branch: 'feat/stage-7-x' } }),
      plain,
      `${name}: the render context cannot change claude's prompt`,
    );
    assert(!plain.includes("Git is Verity's job"), `${name}: no git preamble leaks into claude`);
  }
});

test('claude: the git preamble is OPTION-KEYED and off by default for every host', () => {
  const block = install.PREAMBLES.find((b) => b.option === 'verityPerformsGit');
  assert(block !== undefined, 'the block is registered as a conditional preamble');
  for (const host of ['claude', 'opencode', 'codex']) {
    const rendered = install.renderRole(path.join(ROLES_DIR, 'build.md'), {}, host);
    assert(!rendered.includes("Git is Verity's job"), `${host}: absent with the option off`);
  }
  // On, it renders with the branch interpolated — the only reason it can be true.
  const on = install.renderRole(path.join(ROLES_DIR, 'build.md'), {
    verityPerformsGit: true,
    branch: 'feat/stage-7-x',
  });
  assert(on.includes('feat/stage-7-x'), 'the branch name is interpolated when on');
});

// --- 7. module hygiene + units --------------------------------------------------

test('git-lifecycle: the module is provider-NEUTRAL — it names no runtime', () => {
  const src = fs.readFileSync(path.join(LIB_DIR, 'agents', 'git-lifecycle.cjs'), 'utf8');
  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('//')) {
      continue; // the header explains WHY a runtime needs this; the code must not know
    }
    assert(
      !/\bcodex\b/i.test(line) && !/\bclaude\b/i.test(line),
      `agents/git-lifecycle.cjs must stay runtime-neutral, found: ${line.trim()}`,
    );
  }
});

test('git-lifecycle: `.git` is never handed to the model — no permission-profile escape hatch', () => {
  // ADR-0012 records `.git/** = "write"` as a REJECTED option, not an
  // unexplored one. If this ever fails, read the ADR before "fixing" it.
  for (const file of ['agents/git-lifecycle.cjs', 'agents/codex.cjs', 'agent-exec.cjs']) {
    const code = fs
      .readFileSync(path.join(LIB_DIR, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//')) // the comments RECORD the rejection
      .join('\n');
    assert(!/\.git\/\*\*/.test(code), `${file} must never grant the model writes under .git`);
    assert(!code.includes('sandbox_permissions'), `${file} must not widen the sandbox`);
  }
});

test('git-lifecycle: plan() engages only on a git_write role naming an EXISTING stage', () => {
  const fx = fixture();
  const base = { cwd: fx.dir, role: 'builder', policy: loaded(BUILDER) };
  assertEqual(
    gitLifecycle.plan({ ...base, roleArgs: ['1'] }).branch,
    'feat/stage-1-core',
    'stage 1',
  );
  assertEqual(
    gitLifecycle.plan({ ...base, roleArgs: ['9'] }),
    null,
    'no such stage → no lifecycle',
  );
  assertEqual(
    gitLifecycle.plan({ ...base, roleArgs: [] }),
    null,
    'no stage argument → no lifecycle',
  );
  assertEqual(
    gitLifecycle.plan({ ...base, roleArgs: ['now'] }),
    null,
    'a non-numeric argument is not a stage act',
  );
  assertEqual(
    gitLifecycle.plan({
      ...base,
      roleArgs: ['1'],
      policy: loaded(withCaps({ git_write: false })),
    }),
    null,
    'no git_write grant → Verity performs no git on its behalf',
  );
  assertEqual(
    gitLifecycle.plan({
      ...base,
      roleArgs: ['1'],
      policy: loaded(withCaps({ github_write: false })),
    }).pr,
    false,
    'without github_write Verity commits and pushes but opens no PR',
  );
  assertEqual(
    gitLifecycle.stageNumber(['--flag', '12']),
    12,
    'the stage number is the first digit run',
  );
});

test('git-lifecycle: the tier-1 change source excludes pre-existing dirt', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.dir, 'src', 'dirty.txt'), 'someone else was here\n');
  const plan = gitLifecycle.plan({
    cwd: fx.dir,
    role: 'builder',
    roleArgs: ['1'],
    policy: loaded(BUILDER),
  });
  const started = gitLifecycle.begin(fx.dir, gitLifecycle.assertProvidable(fx.dir, plan));
  fs.writeFileSync(path.join(fx.dir, 'src', 'app.txt'), 'the role edited this\n');
  assertEqual(
    JSON.stringify(gitLifecycle.changedPaths(fx.dir, started)),
    '["src/app.txt"]',
    'only what changed AFTER the pre-dispatch snapshot — never the caller’s dirt',
  );
  const done = gitLifecycle.finish(fx.dir, started, {});
  assertEqual(JSON.stringify(done.paths), '["src/app.txt"]', 'and only that is committed');
  assertEqual(
    git(fx.dir, ['show', '--name-only', '--format=', done.commit]).trim(),
    'src/app.txt',
    'the pre-existing dirt stayed out of history',
  );
});

test('git-lifecycle: an existing PR for the branch is re-used, never duplicated', () => {
  const fx = fixture();
  const first = run(fx, { writes: [{ path: 'src/app.txt', text: 'one\n' }] });
  assertEqual(resultObject(first).git_lifecycle.pr, 200, 'first run opened PR 200');
  const second = run(fx, { writes: [{ path: 'src/app.txt', text: 'two\n' }], runId: 'g2' });
  assertEqual(second.code, 0, `second run completes (stderr: ${second.stderr})`);
  assertLive(fx, second.runId, 'PR re-use');
  assertEqual(resultObject(second).git_lifecycle.pr, 200, 'the SAME PR — no duplicate');
  assertEqual(
    ghCalls(fx).filter((c) => c[0] === 'pr' && c[1] === 'create').length,
    1,
    'gh pr create was called exactly once across both runs',
  );
});

// --- 8. REGRESSIONS: the fork point and the operator's checkout -----------------
// Both of these FAILED before the fix. `begin()` ran `git checkout -b <branch>
// HEAD` and nothing ever switched back, so: stage 2 forked off stage 1's branch
// (its PR silently carrying stage 1's commits — green CI, wrong diff), and a
// human was left standing on a stage branch with their uncommitted work dragged
// across by the switch.

test('regression: stage N+1 forks off the BASE ref, never off stage N’s branch', () => {
  const fx = fixture(BUILDER, { stages: 2 });
  const baseCommit = git(fx.dir, ['rev-parse', 'HEAD']).trim();

  const one = run(fx, { writes: [{ path: 'src/one.txt', text: 'stage one work\n' }] });
  assertEqual(one.code, 0, `stage 1 completes (stderr: ${one.stderr})`);
  assertLive(fx, one.runId, 'stage 1');
  const stageOneCommit = resultObject(one).git_lifecycle.commit;
  assert(stageOneCommit !== null, 'stage 1 really produced a commit');

  const two = run(fx, {
    roleArgs: ['2'],
    runId: 'g-stage2',
    writes: [{ path: 'src/two.txt', text: 'stage two work\n' }],
  });
  assertEqual(two.code, 0, `stage 2 completes (stderr: ${two.stderr})`);
  assertLive(fx, two.runId, 'stage 2');
  const lc = resultObject(two).git_lifecycle;
  assertEqual(lc.branch, 'feat/stage-2-second', 'stage 2 got its own branch');

  // THE PROOF: stage 1's commit is NOT an ancestor of stage 2's branch, so
  // stage 2's PR cannot silently carry stage 1's work.
  let carries = true;
  try {
    git(fx.dir, ['merge-base', '--is-ancestor', stageOneCommit, 'feat/stage-2-second']);
  } catch {
    carries = false;
  }
  assertEqual(carries, false, "stage 2's branch must not contain stage 1's commit");
  assertEqual(
    git(fx.dir, ['rev-parse', 'feat/stage-2-second~1']).trim(),
    baseCommit,
    "and its parent is the base commit — the stage's diff is its own work only",
  );
  assertEqual(
    git(fx.dir, ['log', '--format=%H', 'feat/stage-2-second', '--', 'src/one.txt']).trim(),
    '',
    "stage 1's file appears nowhere in stage 2's history",
  );
  // ...and the fork point is REPORTED, so the canary can read it rather than
  // reconstruct it.
  assertEqual(lc.base, `origin/${fx.base}`, 'forked from the recorded default branch');
  assertEqual(lc.base_from, 'remote-head', 'and says how that was decided');
});

test('regression: the run leaves the checkout on the ref it started on (success AND failure)', () => {
  const fx = fixture();
  const startRef = git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  const ok = run(fx, { writes: [{ path: 'src/app.txt', text: 'built\n' }] });
  assertEqual(ok.code, 0, `success path (stderr: ${ok.stderr})`);
  assertLive(fx, ok.runId, 'restore on success');
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    startRef,
    'a SUCCESSFUL run puts the operator back where it found them',
  );
  // ...and the commit still landed on the stage branch, not on the base ref.
  assertEqual(roleCommits(fx).length, 1, 'the commit is on the stage branch');
  assertEqual(roleCommits(fx, startRef).length, 0, 'and NOT on the base ref');

  // A FAILED run restores too — the checkout is not collateral damage.
  const failing = fixture();
  const bad = run(failing, {
    runId: 'g-restore-fail',
    outcome: 'failed',
    writes: [{ path: 'src/app.txt', text: 'half-done\n' }],
  });
  assertEqual(bad.code, 20, `failure path (stderr: ${bad.stderr})`);
  assertLive(failing, bad.runId, 'restore on failure');
  assertEqual(
    git(failing.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    failing.base,
    'a FAILED run restores the checkout too',
  );
  assertEqual(
    fs.readFileSync(path.join(failing.dir, 'src', 'app.txt'), 'utf8'),
    'half-done\n',
    "and carries the failed role's work back with it — nothing is destroyed",
  );

  // A refusal never moved the checkout in the first place.
  const refused = fixture(BUILDER, { remote: false });
  const refusedStart = git(refused.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const no = run(refused, { runId: 'g-restore-refused' });
  assertEqual(no.code, 30, 'refused before dispatch');
  assertEqual(
    git(refused.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    refusedStart,
    'and the checkout never moved',
  );
});

test('base: without a recorded default branch, the ref the run STARTED on is the base', () => {
  const fx = fixture(BUILDER, { remoteHead: false });
  const res = run(fx, { writes: [{ path: 'src/app.txt', text: 'built\n' }] });
  assertEqual(res.code, 0, `the run completes (stderr: ${res.stderr})`);
  assertLive(fx, res.runId, 'checkout-derived base');
  const lc = resultObject(res).git_lifecycle;
  assertEqual(lc.base, fx.base, 'the base is the branch the operator was on');
  assertEqual(lc.base_from, 'checkout', 'and says so — interactive parity, not a guess');
});

test('base: an undeterminable fork point REFUSES the run rather than falling back to HEAD', () => {
  const fx = fixture(BUILDER, { stages: 2, remoteHead: false });
  // Stand the checkout on stage 1's branch with no recorded default branch: the
  // exact state in which "branch off HEAD" produces the wrong PR.
  git(fx.dir, ['checkout', '-q', '-b', 'feat/stage-1-core']);
  const res = run(fx, { roleArgs: ['2'], writes: [{ path: 'src/two.txt', text: 'x\n' }] });
  assertEqual(res.code, 30, `refused (stderr: ${res.stderr})`);
  assert(res.stderr.includes('git-unprovidable'), 'with the honesty slug');
  assert(res.stderr.includes('itself a stage branch'), 'naming why it will not guess');
  assert(res.stderr.includes('remote set-head'), 'and how to fix it');
  assert(
    !fs.existsSync(path.join(logDir(fx, res.runId), 'liveness.marker')),
    'the agent was never invoked',
  );
  let created = true;
  try {
    git(fx.dir, ['rev-parse', '--verify', 'feat/stage-2-second']);
  } catch {
    created = false;
  }
  assertEqual(created, false, 'and no stacked branch was created');
});

test('restore: a failure to restore is REPORTED, never silent', () => {
  const fx = fixture();
  const plan = gitLifecycle.plan({
    cwd: fx.dir,
    role: 'builder',
    roleArgs: ['1'],
    policy: loaded(BUILDER),
  });
  const started = gitLifecycle.begin(fx.dir, gitLifecycle.assertProvidable(fx.dir, plan));
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    'feat/stage-1-core',
    'begin moved the checkout',
  );
  const back = gitLifecycle.restore(fx.dir, started);
  assertEqual(back.restored, true, 'restore puts it back');
  assertEqual(back.error, null, 'cleanly');
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    fx.base,
    'on the base ref',
  );

  // A ref that cannot be checked out reports the failure instead of throwing.
  const broken = gitLifecycle.restore(fx.dir, { ...started, startRef: 'no/such/ref' });
  assertEqual(broken.restored, false, 'a restore that cannot happen does not pretend');
  assert(broken.error.includes('could not restore the checkout'), `and says so: ${broken.error}`);
  // Restoring when already there is a no-op, not an error.
  assertEqual(gitLifecycle.restore(fx.dir, { ...started, startRef: fx.base }).error, null);
  assertEqual(gitLifecycle.restore(fx.dir, null).error, null, 'nothing to restore is not an error');
});

test('restore: work that BLOCKS the switch back is reported loudly, never destroyed', () => {
  // The one case restoration cannot serve: a second dispatch fails after the
  // first committed the same path, so the role's uncommitted work would be
  // overwritten by the switch. Verity will not force it — the failed role's
  // output is exactly what a human needs to debug — so it says where it left
  // them instead. Loud beats tidy.
  const fx = fixture();
  const first = run(fx, { writes: [{ path: 'src/app.txt', text: 'built\n' }] });
  assertEqual(first.code, 0, `first dispatch commits (stderr: ${first.stderr})`);

  const bad = run(fx, {
    runId: 'g-restore-blocked',
    outcome: 'failed',
    writes: [{ path: 'src/app.txt', text: 'half-done\n' }],
  });
  assertLive(fx, bad.runId, 'blocked restore');
  assertEqual(bad.code, 20, `the run still reports its own outcome (stderr: ${bad.stderr})`);
  assert(bad.stderr.includes('verity-agent-exec: git-restore-failed:'), 'a loud, greppable line');
  assert(bad.stderr.includes('feat/stage-1-core'), 'naming where the checkout was left');
  assertEqual(
    git(fx.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    'feat/stage-1-core',
    'left on the stage branch — reported, not silently forced',
  );
  assertEqual(
    fs.readFileSync(path.join(fx.dir, 'src', 'app.txt'), 'utf8'),
    'half-done\n',
    "the failed role's work is intact — Verity never discards it to tidy up",
  );
});
