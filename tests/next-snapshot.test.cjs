// T01 regression guard for the autonomy feature (docs/dev/autonomy-pathmap.md).
//
// Snapshots the CURRENT human-facing output of the dependency engine — the repo's
// real `verity next` is `verity state next` (verity/bin/lib/ledger.cjs) — on a
// deterministic fixture repo. Later autonomy tasks must keep `mode: manual`
// behavior byte-identical, so these assertions compare exact bytes.
//
// Determinism: stages live in a mkdtemp fixture; `gh` is stubbed via PATH so no
// network (or real repo state) is ever consulted; the fixture is not a git repo
// so `git tag` honestly degrades to no tags; outputs are asserted to contain no
// machine-specific absolute paths.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// Canned GitHub state: stage 1 merged, stage 2 in review (PR open, CI green),
// stage 3 untouched. Same shape `gh ... --json` returns (rollup, not ciGreen).
const ISSUES = [
  { number: 11, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
  {
    number: 12,
    title: '[stage 2] Second',
    state: 'OPEN',
    labels: [],
    assignees: [{ login: 'dev' }],
  },
];
const PRS = [
  {
    number: 21,
    title: '[stage 1] First',
    state: 'MERGED',
    headRefName: 'feat/stage-1-first',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  },
  {
    number: 22,
    title: '[stage 2] Second',
    state: 'OPEN',
    headRefName: 'feat/stage-2-second',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  },
];

// A fake `gh` placed first on PATH. `mode: 'online'` serves the canned state;
// `mode: 'offline'` always fails (stage 20: the ledger REFUSES rather than
// degrade to an empty snapshot — see the offline test at the bottom).
function stubGh(dir, mode) {
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const body =
    mode === 'offline'
      ? 'process.exit(1);\n'
      : `const a = process.argv.slice(2).join(' ');
if (a.startsWith('issue list')) { console.log(${JSON.stringify(JSON.stringify(ISSUES))}); }
else if (a.startsWith('pr list')) { console.log(${JSON.stringify(JSON.stringify(PRS))}); }
else if (a.startsWith('repo view')) { console.log('{"name":"fixture"}'); }
else { process.exit(1); }
`;
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return bin;
}

function fixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-next-snap-'));
  stage.create(dir, 'First'); // stage 1, deps none
  stage.create(dir, 'Second', { dependsOn: '1' }); // stage 2
  stage.create(dir, 'Third', { dependsOn: '2' }); // stage 3
  const bin = stubGh(dir, mode);
  const run = (args) =>
    execFileSync('node', [CLI, ...args, '--cwd', dir], {
      encoding: 'utf8',
      cwd: dir, // gh shell-outs resolve here, never against this repo
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
  return { dir, run };
}

const online = fixture('online');

test('SNAPSHOT: state next (human/default output) is byte-identical', () => {
  assertEqual(online.run(['state', 'next']), '{\n  "next": [\n    2\n  ],\n  "raw": "[2]"\n}\n');
});

test('SNAPSHOT: state next --raw is byte-identical', () => {
  assertEqual(online.run(['state', 'next', '--raw']), '[2]\n');
});

test('SNAPSHOT: state summary --raw (the human one-liner) is byte-identical', () => {
  assertEqual(online.run(['state', 'summary', '--raw']), '3 stages · release (none) · next [2]\n');
});

test('SNAPSHOT: state view (full projection) is byte-identical', () => {
  const expected = {
    online: true,
    release: null,
    stages: [
      {
        number: 1,
        title: 'First',
        type: 'feature',
        dependsOn: [],
        status: 'merged',
        issue: 11,
        pr: 21,
      },
      {
        number: 2,
        title: 'Second',
        type: 'feature',
        dependsOn: [1],
        status: 'in-review',
        issue: 12,
        pr: 22,
      },
      {
        number: 3,
        title: 'Third',
        type: 'feature',
        dependsOn: [2],
        status: 'planned',
        issue: null,
        pr: null,
      },
    ],
    next: [2],
  };
  assertEqual(online.run(['state', 'view']), `${JSON.stringify(expected, null, 2)}\n`);
});

// DELIBERATELY MOVED IN STAGE 20 (issue #60) — read this before "fixing" it.
//
// This assertion used to read:
//
//   test('SNAPSHOT: offline/idle — gh unavailable degrades to all-planned, roots next')
//     state next          -> {"next":[1],"raw":"[1]"}          exit 0
//     state summary --raw -> 3 stages · release (none) · next [1]
//
// It was pinning the DEFECT, not a behavior worth preserving: with `gh`
// unreachable the ledger emitted a confident empty state at exit 0 with an
// empty stderr, indistinguishable from a repository where nothing has started.
// Canary run 3 believed it — the `review` role was told "no PR or linked issue
// exists" while PR #2 was open. A snapshot test's job is to catch unintended
// change; when the pinned bytes are themselves the bug, the bytes are what
// move, and the move is written down here rather than regenerated in silence.
//
// What did NOT move: every online assertion above, byte for byte. The fix
// touches only the path that previously produced a falsehood.
test('SNAPSHOT: offline — gh unavailable now REFUSES (stage 20; this replaced all-planned)', () => {
  const offline = fixture('offline');
  for (const args of [
    ['state', 'next'],
    ['state', 'summary', '--raw'],
    ['state', 'view'],
  ]) {
    let code = 0;
    let out = '';
    let stderr = '';
    try {
      out = offline.run(args);
    } catch (err) {
      code = err.status;
      out = err.stdout || '';
      stderr = err.stderr || '';
    }
    assertEqual(code, 30, `${args.join(' ')} must exit 30, not answer from an unread snapshot`);
    assertEqual(out, '', `${args.join(' ')} must print no projection at all`);
    assert(stderr.includes('could not look'), `and must say why on stderr, got: ${stderr}`);
  }
});

test('snapshot outputs are machine-independent (no absolute paths leak)', () => {
  const out = online.run(['state', 'view']) + online.run(['state', 'summary']);
  assert(!out.includes(online.dir), 'output must not contain the fixture path');
  assert(!out.includes(os.tmpdir()), 'output must not contain tmpdir');
});

test('exit code is 0 for "no work" and nonzero only on real errors', () => {
  // SKETCH §3.1 invariant, pinned against today's behavior: querying next on a
  // valid project never exits nonzero just because nothing is unblocked.
  let code = 0;
  try {
    online.run(['state', 'next']);
  } catch (err) {
    code = err.status;
  }
  assertEqual(code, 0, 'state next must exit 0');
  let failed = false;
  try {
    online.run(['state', 'bogus-verb']);
  } catch (_err) {
    failed = true;
  }
  assert(failed, 'unknown state verb still exits nonzero');
});
