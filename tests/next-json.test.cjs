// T03 — `verity next` / `verity next --json` (SKETCH §3.1).
//
// Fixture-driven, no network: `gh` is stubbed via PATH (same pattern as
// tests/next-snapshot.test.cjs) serving canned issue/PR state per scenario.
// Covers the three contract states (work, gated, idle) + exit codes 0/0/10,
// and the pipe-safety invariant: --json emits exactly ONE JSON object on
// stdout, nothing else.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const nextLib = require('../verity/bin/lib/next.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// A fake `gh` first on PATH serving the given canned issue/PR state.
function stubGh(dir, issues, prs) {
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const body = `const a = process.argv.slice(2).join(' ');
if (a.startsWith('issue list')) { console.log(${JSON.stringify(JSON.stringify(issues))}); }
else if (a.startsWith('pr list')) { console.log(${JSON.stringify(JSON.stringify(prs))}); }
else if (a.startsWith('repo view')) { console.log('{"name":"fixture"}'); }
else { process.exit(1); }
`;
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return bin;
}

// Three stages (2 depends on 1, 3 depends on 2) + canned GitHub state.
// Returns a runner capturing { out, code } — exit code 10 must be observable.
function fixture(issues, prs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-next-json-'));
  stage.create(dir, 'First');
  stage.create(dir, 'Second', { dependsOn: '1' });
  stage.create(dir, 'Third', { dependsOn: '2' });
  const bin = stubGh(dir, issues, prs);
  return (args) => {
    try {
      const out = execFileSync('node', [CLI, ...args, '--cwd', dir], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      });
      return { out, code: 0 };
    } catch (err) {
      return { out: err.stdout || '', code: err.status };
    }
  };
}

// jq-equivalent check without requiring jq: stdout must be exactly one line,
// that line must be one JSON object, and `.schema == 1` must hold.
function parseSingleObject(out) {
  const lines = out.split('\n').filter(Boolean);
  assertEqual(lines.length, 1, '--json must emit exactly one line on stdout');
  const obj = JSON.parse(lines[0]);
  assert(obj && typeof obj === 'object' && !Array.isArray(obj), 'must be one JSON object');
  assertEqual(obj.schema, 1, "jq -e '.schema==1' must pass");
  return obj;
}

const MERGED_PR_1 = {
  number: 21,
  title: '[stage 1] First',
  state: 'MERGED',
  headRefName: 'feat/stage-1-first',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
};

// --- work-available ---

test('next --json: work (review) — stage 1 merged, stage 2 PR open + CI green', () => {
  const run = fixture(
    [
      { number: 11, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
      { number: 12, title: '[stage 2] Second', state: 'OPEN', labels: [], assignees: [] },
    ],
    [
      MERGED_PR_1,
      {
        number: 22,
        title: '[stage 2] Second',
        state: 'OPEN',
        headRefName: 'feat/stage-2-second',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      },
    ],
  );
  const { out, code } = run(['next', '--json']);
  assertEqual(code, 0, 'work exits 0');
  const obj = parseSingleObject(out);
  assertEqual(obj.action, 'work');
  assertEqual(obj.role, 'review');
  assertEqual(JSON.stringify(obj.args), '["2","22"]');
  assertEqual(obj.gate, null);
  assertEqual(JSON.stringify(obj.target), '{"kind":"pr","number":22}');
  assertEqual(obj.reason, 'PR #22 awaiting review for stage 2');
});

test('next --json: work (build) — nothing started, root stage unblocked', () => {
  const run = fixture([], []);
  const { out, code } = run(['next', '--json']);
  assertEqual(code, 0, 'work exits 0');
  const obj = parseSingleObject(out);
  assertEqual(obj.action, 'work');
  assertEqual(obj.role, 'build');
  assertEqual(JSON.stringify(obj.args), '["1"]');
  assertEqual(JSON.stringify(obj.target), '{"kind":"stage","number":1}');
});

// --- gated ---

const GATED_ISSUES = [
  { number: 11, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
  {
    number: 12,
    title: '[stage 2] Second',
    state: 'OPEN',
    labels: [{ name: 'verity:awaiting-approval' }],
    assignees: [],
  },
];
const GATED_PRS = [
  MERGED_PR_1,
  {
    number: 22,
    title: '[stage 2] Second',
    state: 'OPEN',
    headRefName: 'feat/stage-2-second',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  },
];

test('next --json: gated — verity:awaiting-approval on the work item, exit 10', () => {
  const run = fixture(GATED_ISSUES, GATED_PRS);
  const { out, code } = run(['next', '--json']);
  assertEqual(code, 10, 'gated exits 10');
  const obj = parseSingleObject(out);
  assertEqual(obj.action, 'gated');
  assertEqual(obj.role, 'review');
  assertEqual(obj.gate, 'review:merge');
  assertEqual(JSON.stringify(obj.target), '{"kind":"pr","number":22}');
});

test('next (human mode): gated also exits 10; pretty envelope unchanged otherwise', () => {
  const run = fixture(GATED_ISSUES, GATED_PRS);
  const { out, code } = run(['next']);
  assertEqual(code, 10, 'gated exits 10 in human mode too');
  const obj = JSON.parse(out);
  assertEqual(obj.action, 'gated');
  assert(out.includes('\n  "schema": 1'), 'human mode stays the pretty-printed envelope');
});

test('next --json: gated — verity:awaiting-approval on the PR itself, exit 10 (T14 fix)', () => {
  // The worker's GATE_PAUSE labels the gate's TARGET — for review:merge that is
  // the PR, which may carry the label while the work-item issue carries none.
  const issues = [GATED_ISSUES[0], { ...GATED_ISSUES[1], labels: [] }];
  const prs = [MERGED_PR_1, { ...GATED_PRS[1], labels: [{ name: 'verity:awaiting-approval' }] }];
  const run = fixture(issues, prs);
  const { out, code } = run(['next', '--json']);
  assertEqual(code, 10, 'PR gate label gates too');
  const obj = parseSingleObject(out);
  assertEqual(obj.action, 'gated');
  assertEqual(obj.gate, 'review:merge');
  assertEqual(JSON.stringify(obj.target), '{"kind":"pr","number":22}');
});

test('next --json: verity:approved overrides the gate (single-use resume token)', () => {
  const issues = [
    GATED_ISSUES[0],
    {
      ...GATED_ISSUES[1],
      labels: [{ name: 'verity:awaiting-approval' }, { name: 'verity:approved' }],
    },
  ];
  const run = fixture(issues, GATED_PRS);
  const { out, code } = run(['next', '--json']);
  assertEqual(code, 0, 'approved gate is work again');
  assertEqual(parseSingleObject(out).action, 'work');
});

// --- idle ---

test('next --json: idle — all stages merged, exit 0 (never nonzero for no work)', () => {
  const run = fixture(
    [
      { number: 11, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
      { number: 12, title: '[stage 2] Second', state: 'CLOSED', labels: [], assignees: [] },
      { number: 13, title: '[stage 3] Third', state: 'CLOSED', labels: [], assignees: [] },
    ],
    [],
  );
  const { out, code } = run(['next', '--json']);
  assertEqual(code, 0, 'idle exits 0');
  const obj = parseSingleObject(out);
  assertEqual(obj.action, 'idle');
  assertEqual(obj.role, undefined, 'role only present when action != idle');
  assertEqual(obj.gate, null);
  assertEqual(obj.target, null);
  assertEqual(obj.reason, 'all stages merged');
});

// --- unit-level mapping (pure decide(), no CLI spawn) ---

test('decide: building (PR open, CI red) maps to work/build targeting the PR', () => {
  const proj = {
    stages: [
      {
        number: 1,
        title: 'First',
        type: 'feature',
        dependsOn: [],
        status: 'building',
        issue: 11,
        pr: 21,
      },
    ],
    next: [1],
  };
  const d = nextLib.decide(proj, { issues: [{ number: 11, labels: [] }] });
  assertEqual(d.action, 'work');
  assertEqual(d.role, 'build');
  assertEqual(JSON.stringify(d.args), '["1","21"]');
  assertEqual(JSON.stringify(d.target), '{"kind":"pr","number":21}');
});

test('decide: gated before build names the paused role as the gate', () => {
  const proj = {
    stages: [
      {
        number: 1,
        title: 'First',
        type: 'feature',
        dependsOn: [],
        status: 'planned',
        issue: 11,
        pr: null,
      },
    ],
    next: [1],
  };
  const d = nextLib.decide(proj, {
    issues: [{ number: 11, labels: [{ name: 'verity:awaiting-approval' }] }],
  });
  assertEqual(d.action, 'gated');
  assertEqual(d.gate, 'build');
  assertEqual(nextLib.exitCodeFor(d), 10);
  assertEqual(JSON.stringify(d.target), '{"kind":"issue","number":11}');
});

test('decide: no stages at all is idle, not an error', () => {
  const d = nextLib.decide({ stages: [], next: [] }, {});
  assertEqual(d.action, 'idle');
  assertEqual(d.reason, 'no stages defined');
  assertEqual(nextLib.exitCodeFor(d), 0);
});
