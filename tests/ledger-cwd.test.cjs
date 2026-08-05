// Stage 23 — `verity state` must read the repository it was POINTED AT (#64).
//
// The defect: `--cwd` was honoured by the FILE half of the derivation
// (`readStages`) and silently ignored by the GITHUB half. `ghJson()` shelled out
// to `gh` with no `cwd`, so `gh` resolved the repository from the PROCESS's
// working directory. Run from anywhere else, `verity state` answered with the
// CURRENT repository's issues and PRs projected onto the TARGET repository's
// stages — confidently, at exit 0, with no warning:
//
//   $ cd ~/vcc3 && verity state stage 1 --cwd ~/vcc3
//     { "status": "building", "issue": 1, "pr": 2 }        # correct
//   $ cd ~/projects/verity-framework && verity state stage 1 --cwd ~/vcc3
//     { "status": "planned", "issue": null, "pr": null }   # WRONG — exit 0
//
// Same confident-falsehood family as #60/stage 20, and stage 20 does NOT catch
// it: here the read SUCCEEDS, so the snapshot is stamped `verified` and is
// nonetheless about the wrong repository.
//
// No existing test could have caught this, because every one of them invokes the
// CLI from the directory it is testing. So this suite is built around two
// DISTINCT fixture repositories with different GitHub state, and always runs
// from the wrong one — a test that ran from the target would pass against the
// broken code and prove nothing. The `gh` stub answers about the repository of
// the directory it was RUN FROM, exactly like the real thing.
//
// Section (2) is the part that matters most: it asserts directly that every gh
// invocation the ledger makes carries the target directory, so a future read
// added without one fails the suite instead of surfacing in a canary six weeks
// later.
//
// Stub-driven like tests/ledger-unverified.test.cjs and
// tests/next-snapshot.test.cjs (their own gh stub on PATH). No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../verity/bin/lib/ledger.cjs');
const stage = require('../verity/bin/lib/stage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// --- the two repositories -----------------------------------------------------
//
// TARGET is what the operator points `--cwd` at: stage 1 merged, stage 2 open
// with red CI (the live reproduction's shape), stage 3 untouched.
const TARGET_GH = {
  name: 'target',
  issues: [
    { number: 101, title: '[stage 1] Target one', state: 'CLOSED', labels: [], assignees: [] },
    {
      number: 103,
      title: '[stage 2] Target two',
      state: 'OPEN',
      labels: [],
      assignees: [{ login: 'dev' }],
    },
  ],
  prs: [
    {
      number: 102,
      title: '[stage 1] Target one',
      state: 'MERGED',
      headRefName: 'feat/stage-1-target-one',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
    {
      number: 104,
      title: '[stage 2] Target two',
      state: 'OPEN',
      headRefName: 'feat/stage-2-target-two',
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    },
  ],
};

// ELSEWHERE is the repository the CLI is INVOKED from. Its state is chosen to
// make the bug loud in both directions: it knows nothing about stage 2 (so the
// broken code reports the target's live stage 2 as a confident
// planned/null/null) and it has a CLOSED stage-3 item (so the broken code
// reports the target's untouched stage 3 as merged, with issue #303 — an issue
// that does not exist in the target repository at all).
const ELSEWHERE_GH = {
  name: 'elsewhere',
  issues: [
    {
      number: 301,
      title: '[stage 1] Elsewhere one',
      state: 'OPEN',
      labels: [],
      assignees: [{ login: 'someone' }],
    },
    {
      number: 303,
      title: '[stage 3] Elsewhere three',
      state: 'CLOSED',
      labels: [],
      assignees: [],
    },
  ],
  prs: [],
};

// A fake `gh` first on PATH. It behaves like the real one in the single respect
// this stage is about: the repository it answers about is the repository of the
// directory it was RUN FROM — read from `.gh-fixture.json` in its own cwd. A
// call that inherited the parent's directory therefore answers about the
// parent's repository, which IS the defect, reproduced without a network.
//
// Every invocation is appended to GH_CALL_LOG together with the directory it
// actually resolved from. That log is the anti-reintroduction guard in (2).
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.GH_CALL_LOG) {
  fs.appendFileSync(
    process.env.GH_CALL_LOG,
    JSON.stringify({ args, cwd: fs.realpathSync(process.cwd()) }) + '\\n',
  );
}
let repo = null;
try {
  repo = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.gh-fixture.json'), 'utf8'));
} catch {
  // What real gh says in a directory whose repository it cannot resolve.
  process.stderr.write('no git remotes found\\n');
  process.exit(1);
}
if (repo.failStderr) { process.stderr.write(repo.failStderr + '\\n'); process.exit(1); }
const a = args.join(' ');
if (a.startsWith('issue list')) { console.log(JSON.stringify(repo.issues)); }
else if (a.startsWith('pr list')) { console.log(JSON.stringify(repo.prs)); }
else if (a.startsWith('repo view')) { console.log(JSON.stringify({ name: repo.name })); }
else { process.stderr.write('HTTP 404: unhandled gh call: ' + a + '\\n'); process.exit(1); }
`;

// Token-shaped strings are ASSEMBLED AT RUNTIME, never written as literals — a
// literal `gh?_…` is indistinguishable from a real leaked credential to the
// secret scanner, and an allowlist on a test file is a permanent hole. Same
// approach as tests/ledger-unverified.test.cjs.
const BODY36 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ghShape = (kind) => ['gh', kind, '_', BODY36].join('');

// mkdtemp under a symlinked tmpdir (macOS) resolves differently in the child, so
// every fixture path is realpath'd once, here, and compared as such everywhere.
function repoFixture(prefix, stages, github) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const s of stages) {
    stage.create(dir, s.title, s.dependsOn ? { dependsOn: s.dependsOn } : {});
  }
  if (github) {
    fs.writeFileSync(path.join(dir, '.gh-fixture.json'), JSON.stringify(github));
  }
  return dir;
}

const TARGET_STAGES = [
  { title: 'Target one' },
  { title: 'Target two', dependsOn: '1' },
  { title: 'Target three', dependsOn: '2' },
];

// Builds both repositories plus the stub, and a runner that ALWAYS invokes the
// CLI from `elsewhere` unless a test deliberately asks otherwise.
function world(opts = {}) {
  // `targetGh: null` means "a directory gh cannot resolve a repository in".
  const targetGh = 'targetGh' in opts ? opts.targetGh : TARGET_GH;
  const target = repoFixture('verity-cwd-target-', TARGET_STAGES, targetGh);
  const elsewhere = repoFixture(
    'verity-cwd-elsewhere-',
    [{ title: 'Elsewhere one' }, { title: 'Elsewhere two', dependsOn: '1' }],
    ELSEWHERE_GH,
  );
  const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cwd-bin-')));
  const bin = path.join(support, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const log = path.join(support, 'gh-calls.log');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_CALL_LOG: log,
  };
  // Returns { code, out, stderr } — never throws, so exit codes are asserted
  // directly rather than inferred from a thrown error (verify by exit code).
  const run = (args, runOpts = {}) => {
    try {
      const out = execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        cwd: runOpts.from || elsewhere,
        env,
      });
      return { code: 0, out, stderr: '' };
    } catch (err) {
      return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
    }
  };
  const calls = () =>
    (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { target, elsewhere, bin, log, env, run, calls };
}

// Run `fn` with the world's stub gh first on PATH (module-API calls shell out
// from THIS process, whose cwd is the framework repo — itself a third,
// definitely-different directory).
function withStubPath(w, fn) {
  const beforePath = process.env.PATH;
  const beforeLog = process.env.GH_CALL_LOG;
  process.env.PATH = `${w.bin}${path.delimiter}${beforePath}`;
  process.env.GH_CALL_LOG = w.log;
  try {
    return fn();
  } finally {
    process.env.PATH = beforePath;
    restore('GH_CALL_LOG', beforeLog);
  }
}

// Same restore helper as tests/ledger-unverified.test.cjs.
function restore(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

// ---------------------------------------------------------------------------
// (1) The reproduction, as a regression
// ---------------------------------------------------------------------------

test('REGRESSION #64: `state stage 2 --cwd <target>` from ANOTHER repo answers about the TARGET', () => {
  const w = world();
  const { code, out } = w.run(['state', 'stage', '2', '--cwd', w.target]);

  assertEqual(code, 0, 'the target is perfectly readable — this must not refuse');
  assertEqual(
    out,
    json({
      number: 2,
      title: 'Target two',
      type: 'feature',
      dependsOn: [1],
      status: 'building',
      issue: 103,
      pr: 104,
    }),
    'the target repository real linkage, not the invoking repository',
  );

  // Spelled out, because these are the exact falsehoods the live bug produced.
  assert(!/"status":\s*"planned"/.test(out), `must not claim planned, got: ${out}`);
  assert(!/"issue":\s*null/.test(out), `must not claim there is no issue, got: ${out}`);
  assert(!/"pr":\s*null/.test(out), `must not claim there is no PR, got: ${out}`);
});

test("REGRESSION #64: the INVOKING repository's issues never leak onto the target's stages", () => {
  const w = world();
  // The invoking repo has a CLOSED `[stage 3]` issue (#303); the target has
  // nothing for stage 3. Reading #303 here would report a stage as MERGED on
  // the strength of another repository's issue.
  const { code, out } = w.run(['state', 'stage', '3', '--cwd', w.target]);
  assertEqual(code, 0);
  assertEqual(
    out,
    json({
      number: 3,
      title: 'Target three',
      type: 'feature',
      dependsOn: [2],
      status: 'planned',
      issue: null,
      pr: null,
    }),
    'stage 3 is genuinely untouched IN THE TARGET',
  );
  assert(!out.includes('303'), `the other repository's issue leaked in: ${out}`);
  assert(!/"status":\s*"merged"/.test(out), 'and it certainly is not merged');
});

// ---------------------------------------------------------------------------
// (2) The anti-reintroduction guard — every ledger gh read carries the target
// ---------------------------------------------------------------------------

test('GUARD: every gh call `verity state` makes runs in the TARGET directory', () => {
  const w = world();
  assertEqual(w.run(['state', 'view', '--cwd', w.target]).code, 0);
  const calls = w.calls();
  // Non-vacuous: the three reads fetchSnapshot performs today.
  assert(calls.length >= 3, `expected the ledger's gh reads to be logged, got ${calls.length}`);
  for (const c of calls) {
    assertEqual(
      c.cwd,
      w.target,
      `gh ${c.args.join(' ')} resolved its repository from the wrong directory`,
    );
  }
});

test('GUARD: fetchSnapshot(target) shells out ONLY into the target — issues, PRs and the repo probe', () => {
  const w = world();
  // Called in-process: this process's cwd is the framework repo, so an omitted
  // `cwd` shows up immediately. Asserting over EVERY logged call (rather than a
  // fixed list) is what makes this a guard: a future read added to the ledger
  // without a cwd lands in this log pointing somewhere else and fails here.
  const snap = withStubPath(w, () => ledger.fetchSnapshot(w.target));
  assertEqual(
    snap.verified,
    true,
    `the target reads cleanly (failures: ${JSON.stringify(snap.failures)})`,
  );
  const calls = w.calls();
  assert(calls.length >= 3, `expected at least 3 gh reads, got ${calls.length}`);
  for (const c of calls) {
    assertEqual(c.cwd, w.target, `gh ${c.args.join(' ')} ran outside the target directory`);
  }
  // ...and the reads Verity is known to make are all present, so the loop above
  // is covering the whole snapshot rather than one lucky call.
  const seen = calls.map((c) => c.args.slice(0, 2).join(' '));
  for (const expected of ['issue list', 'pr list', 'repo view']) {
    assert(
      seen.includes(expected),
      `\`gh ${expected}\` was never observed, saw: ${seen.join(', ')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (3) Every verb, under --cwd, from elsewhere
// ---------------------------------------------------------------------------

// The target's projection, in full. Stage 1 merged, stage 2 building (PR open,
// CI red), stage 3 planned — so the only unblocked stage is 2.
const TARGET_VIEW = {
  online: true,
  release: null,
  stages: [
    {
      number: 1,
      title: 'Target one',
      type: 'feature',
      dependsOn: [],
      status: 'merged',
      issue: 101,
      pr: 102,
    },
    {
      number: 2,
      title: 'Target two',
      type: 'feature',
      dependsOn: [1],
      status: 'building',
      issue: 103,
      pr: 104,
    },
    {
      number: 3,
      title: 'Target three',
      type: 'feature',
      dependsOn: [2],
      status: 'planned',
      issue: null,
      pr: null,
    },
  ],
  next: [2],
};

test('`state view` under --cwd is the TARGET projection, whole', () => {
  const w = world();
  const { code, out } = w.run(['state', 'view', '--cwd', w.target]);
  assertEqual(code, 0);
  assertEqual(out, json(TARGET_VIEW));
});

test('`state next`, `summary` and `graph` under --cwd describe the TARGET', () => {
  const w = world();
  // The contrast, made explicit: from the invoking repository with no --cwd the
  // honest answer is ITS next stage, [1]. Pointed at the target it is [2]. The
  // broken code said [1] both times.
  assertEqual(w.run(['state', 'next', '--raw'], {}).out, '[1]\n', 'the invoking repo answers [1]');
  assertEqual(w.run(['state', 'next', '--raw', '--cwd', w.target]).out, '[2]\n');
  assertEqual(
    w.run(['state', 'summary', '--raw', '--cwd', w.target]).out,
    '3 stages · release (none) · next [2]\n',
  );
  assertEqual(
    w.run(['state', 'graph', '--cwd', w.target]).out,
    json({
      graph: [
        { number: 1, dependsOn: [] },
        { number: 2, dependsOn: [1] },
        { number: 3, dependsOn: [2] },
      ],
    }),
  );
});

test('`verity next --json --cwd <target>` dispatches on the TARGET, not the invoking repo', () => {
  const w = world();
  const { code, out } = w.run(['next', '--json', '--cwd', w.target]);
  assertEqual(code, 0, 'work is exit 0');
  const d = JSON.parse(out);
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'build');
  assertEqual(JSON.stringify(d.args), '["2","104"]', 'the target stage and the target PR');
  assertEqual(JSON.stringify(d.target), '{"kind":"pr","number":104}');
  // The invoking repository would have produced stage 1 / issue 301 here.
  assert(!out.includes('301'), `the invoking repository's issue leaked into the decision: ${out}`);
});

// ---------------------------------------------------------------------------
// (4) The common case — same-directory invocation is unchanged
// ---------------------------------------------------------------------------

test('SAME DIRECTORY: invoking from inside the target is byte-identical, with or without --cwd', () => {
  const w = world();
  const expected = json(TARGET_VIEW);
  // The literal above pins today's bytes; these three then pin that all three
  // ways of naming the same repository agree.
  assertEqual(w.run(['state', 'view'], { from: w.target }).out, expected, 'no --cwd at all');
  assertEqual(
    w.run(['state', 'view', '--cwd', w.target], { from: w.target }).out,
    expected,
    '--cwd pointing at the directory we are already in (the overwhelmingly common case)',
  );
  assertEqual(
    w.run(['state', 'view', '--cwd', w.target], { from: w.elsewhere }).out,
    expected,
    'and from elsewhere — which is the whole point of the flag',
  );
});

test('SAME DIRECTORY: every verb is unchanged from elsewhere-with---cwd', () => {
  const w = world();
  const verbs = [
    ['state', 'next'],
    ['state', 'next', '--raw'],
    ['state', 'summary', '--raw'],
    ['state', 'graph'],
    ['state', 'stage', '2'],
    ['next', '--json'],
  ];
  for (const v of verbs) {
    const here = w.run([...v], { from: w.target });
    const there = w.run([...v, '--cwd', w.target], { from: w.elsewhere });
    assertEqual(there.out, here.out, `\`verity ${v.join(' ')}\` differs between the two`);
    assertEqual(there.code, here.code, `\`verity ${v.join(' ')}\` exit code differs`);
  }
});

// ---------------------------------------------------------------------------
// (5) Honest failure — an unresolvable target refuses (stage 20's refusal)
// ---------------------------------------------------------------------------

test('a target that is not a resolvable repository REFUSES — never a confident empty', () => {
  // Stage files, but no repository gh can resolve. Before this stage the gh
  // reads succeeded (against the INVOKING repo), so this answered with a
  // verified snapshot describing a repository nobody asked about.
  const w = world({ targetGh: null });
  const { code, out, stderr } = w.run(['state', 'view', '--cwd', w.target]);
  assertEqual(code, 30, `an unreadable target is an infra refusal (stderr: ${stderr})`);
  assertEqual(out, '', 'and it emits no projection at all');
  assert(/no-repo/.test(stderr), `the reason names the unresolvable repo, got: ${stderr}`);
});

test('a target directory that does not exist REFUSES, and says so in those words', () => {
  const w = world();
  const missing = path.join(w.target, 'no-such-directory');
  const { code, out, stderr } = w.run(['state', 'view', '--cwd', missing]);
  assertEqual(code, 30, `a nonexistent target must refuse, got ${code} (stderr: ${stderr})`);
  assertEqual(out, '', 'never an empty-but-confident snapshot of zero stages');
  assert(
    /no-target-dir/.test(stderr),
    `an operator must not be sent to reinstall gh, got: ${stderr}`,
  );
  // ...and directly, so the diagnostic is pinned rather than inferred.
  const snap = withStubPath(w, () => ledger.fetchSnapshot(missing));
  assertEqual(ledger.snapshotVerified(snap), false);
  assertEqual(snap.failures[0].reason, 'no-target-dir');
  assertEqual(snap.issues, null, 'the read that could not happen is null — not an empty list');
});

test('a MISSING gh is still reported as a missing gh (the ENOENT cases stay apart)', () => {
  const w = world();
  // Same ENOENT the kernel raises for a bad cwd, from the other cause: an empty
  // PATH means `gh` itself cannot be found, while the target exists.
  const before = process.env.PATH;
  process.env.PATH = path.join(w.target, 'empty-bin');
  let snap;
  try {
    snap = ledger.fetchSnapshot(w.target);
  } finally {
    process.env.PATH = before;
  }
  assertEqual(ledger.snapshotVerified(snap), false);
  assertEqual(snap.failures[0].reason, 'gh-not-installed');
});

// ---------------------------------------------------------------------------
// (6) Stage 20's guarantees still hold when the read is aimed elsewhere
// ---------------------------------------------------------------------------

test('an unreadable TARGET refuses, and the diagnostic never repeats a credential', () => {
  const token = ghShape('p');
  const w = world({
    targetGh: {
      ...TARGET_GH,
      failStderr: `gh: Bad credentials (HTTP 401) — token ${token} was rejected`,
    },
  });
  const { code, out, stderr } = w.run(['state', 'stage', '2', '--cwd', w.target]);
  assertEqual(code, 30, 'stage 20 still refuses when the read fails');
  assertEqual(out, '', 'and answers nothing');
  assert(/auth/i.test(stderr), `the failure is still classified, got: ${stderr}`);
  assert(!stderr.includes(token), `stderr leaked the token: ${stderr}`);
  assert(!out.includes(token), 'stdout leaked the token');
  assert(/redacted/i.test(stderr), `the token was redacted in place, got: ${stderr}`);
});
