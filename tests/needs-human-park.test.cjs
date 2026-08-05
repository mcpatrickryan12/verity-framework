// Stage 27 — verity:needs-human must park a stage everywhere, and a parked
// gate must not starve the queue (canary §4 re-run, defect 4, ticks 6–9).
//
// Two coupled defects, both in the P5/gate path (`next.cjs decide()` + the
// worker's stage-22 announcement branch), which stage 5 never taught:
//   1. With `verity:needs-human` on the stage's issue AND PR, the worker still
//      selected the stage and re-announced its ci:unverified gate — decide()
//      never consulted the label, so the operator's park was invisible to the
//      one tier that derives work instead of reading labels.
//   2. While a stage sat un-approved at its gate, decide() only ever looked at
//      proj.next[0] — a pending `verity:request` (or another unblocked stage)
//      was never reachable; ticks read `idle — no eligible work`.
//
// The fix applies stage 5's existing parking rule to the path that missed it:
// decide() walks the WHOLE unblocked list, skipping parked stages (never
// selected, never announced — the operator's label is the whole record) and
// stages already waiting at an ANNOUNCED gate (the pause is visible; it must
// not block the work behind it). A FRESH gate still takes the tick — stage
// 22's announce-once: the pause becomes visible BEFORE the queue drains
// around it. Removing the label restores exactly the old behavior.
//
// Harness mirrors tests/gate-visible.test.cjs (trimmed stateful gh + agent
// stubs on PATH; a JSON state file holds labels/comments). No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nextLib = require('../verity/bin/lib/next.cjs');
const scanner = require('../verity/bin/lib/scanner.cjs');
const stage = require('../verity/bin/lib/stage.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const NEEDS_HUMAN = scanner.NEEDS_HUMAN_LABEL; // stage 5's constant, reused

// ---------------------------------------------------------------------------
// (1) `verity next` decide() — the parking rule, unit level
// ---------------------------------------------------------------------------

// One stage building at PR 114 (no checks at all — the canary's exact shape),
// plus an optional second independent stage behind it.
function projOneStage(status = 'building') {
  return {
    stages: [
      { number: 1, title: 'Core', type: 'feature', dependsOn: [], status, issue: 41, pr: 114 },
    ],
    next: [1],
  };
}

function projTwoStages() {
  const proj = projOneStage();
  proj.stages.push({
    number: 2,
    title: 'Second',
    type: 'feature',
    dependsOn: [],
    status: 'planned',
    issue: 42,
    pr: null,
  });
  proj.next = [1, 2];
  return proj;
}

// Snapshot: issue 41 + PR 114 (no CI checks) with the given label names.
function snap({ issueLabels = [], prLabels = [] } = {}) {
  return {
    issues: [
      { number: 41, labels: issueLabels.map((name) => ({ name })) },
      { number: 42, labels: [] },
    ],
    prs: [{ number: 114, labels: prLabels.map((name) => ({ name })), statusCheckRollup: [] }],
  };
}

test('REGRESSION (stage 27): needs-human on the stage ISSUE parks the gate path — idle, never gated', () => {
  const d = nextLib.decide(projOneStage(), snap({ issueLabels: [NEEDS_HUMAN] }));
  assertEqual(d.action, 'idle', 'a parked stage is not selected and not announced');
  assertEqual(d.gate, null);
  assertEqual(d.target, null);
  assert(d.reason.includes(NEEDS_HUMAN), `the idle reason names the park, got: ${d.reason}`);
  assert(d.reason.includes('1'), `the idle reason names the stage, got: ${d.reason}`);
});

test('REGRESSION (stage 27): needs-human on the PR ONLY parks too (labels are a union, T14)', () => {
  const d = nextLib.decide(projOneStage(), snap({ prLabels: [NEEDS_HUMAN] }));
  assertEqual(d.action, 'idle', 'the PR-only park is honored');
  assertEqual(d.gate, null);
});

test('parking is case-insensitive, like every other label read', () => {
  const d = nextLib.decide(projOneStage(), snap({ issueLabels: ['Verity:Needs-Human'] }));
  assertEqual(d.action, 'idle');
});

test('needs-human wins even over an approval — scanner parity (stage 5 drops it from P1 too)', () => {
  const d = nextLib.decide(
    projOneStage(),
    snap({ issueLabels: [NEEDS_HUMAN, 'verity:awaiting-approval', 'verity:approved'] }),
  );
  assertEqual(d.action, 'idle', 'the worker never works an escalated item');
});

test('REGRESSION (stage 27): a parked stage does not starve the next unblocked stage', () => {
  const d = nextLib.decide(projTwoStages(), snap({ issueLabels: [NEEDS_HUMAN] }));
  assertEqual(d.action, 'work', 'stage 2 is still pickable while stage 1 is parked');
  assertEqual(d.role, 'build');
  assertEqual(JSON.stringify(d.args), '["2"]');
  assertEqual(JSON.stringify(d.target), '{"kind":"issue","number":42}');
});

test('REGRESSION (stage 27): an ANNOUNCED gate stops blocking the stages behind it', () => {
  const d = nextLib.decide(projTwoStages(), snap({ prLabels: ['verity:awaiting-approval'] }));
  assertEqual(d.action, 'work', 'the pause is already visible on GitHub — it must not starve');
  assertEqual(JSON.stringify(d.args), '["2"]');
});

test('a FRESH (unannounced) gate still takes the tick — stage 22 announce-once is unchanged', () => {
  const d = nextLib.decide(projTwoStages(), snap());
  assertEqual(d.action, 'gated', 'the pause must become visible before the queue drains around it');
  assertEqual(d.gate, 'ci:unverified');
  assertEqual(d.announced, undefined, 'nothing on GitHub says it yet');
  assertEqual(JSON.stringify(d.target), '{"kind":"pr","number":114}');
});

test('steady state: only an announced gate left → the gated decision returns unchanged', () => {
  const d = nextLib.decide(projOneStage(), snap({ prLabels: ['verity:awaiting-approval'] }));
  assertEqual(d.action, 'gated');
  assertEqual(d.gate, 'ci:unverified');
  assertEqual(d.announced, true, 'stage-22 semantics byte-identical when nothing else is workable');
});

test('label removal restores exactly today’s decision (fresh gate, unannounced)', () => {
  const parked = nextLib.decide(projOneStage(), snap({ issueLabels: [NEEDS_HUMAN] }));
  assertEqual(parked.action, 'idle');
  const restored = nextLib.decide(projOneStage(), snap());
  assertEqual(restored.action, 'gated');
  assertEqual(restored.gate, 'ci:unverified');
  assertEqual(restored.announced, undefined, 'announce-once flows exactly as before the park');
});

test('the parked idle decision is additive-clean: no new contract fields', () => {
  const d = nextLib.decide(projOneStage(), snap({ issueLabels: [NEEDS_HUMAN] }));
  assertEqual(d.schema, 1);
  assertEqual(d.announced, undefined);
  assertEqual(
    JSON.stringify(Object.keys(d).sort()),
    '["action","gate","reason","schema","target"]',
    'same field set every idle decision has always had',
  );
});

// ---------------------------------------------------------------------------
// (2) End-to-end: the worker on the canary's exact repository shape
// ---------------------------------------------------------------------------

// Trimmed twin of tests/gate-visible.test.cjs's stubs.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
if (args[0] === 'auth' && args[1] === 'status') { out('Logged in as verity-bot\\n'); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  const s = state();
  let items = args[0] === 'issue' ? s.issues : s.prs;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') { out({ name: 'fixture' }); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'view') {
  const s = state();
  const pool = args[0] === 'issue' ? s.issues : s.prs;
  const it = pool.find((x) => x.number === Number(args[2]));
  out({ labels: (it.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
  process.exit(0);
}
if (args[0] === 'api') {
  const method = flag('-X') || 'GET';
  const url = args.find((a) => a === 'user' || a.startsWith('repos/'));
  if (url === 'user') { out({ login: 'verity-bot' }); process.exit(0); }
  const m = (url || '').match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)(.*)$/);
  if (!m) { process.stderr.write('HTTP 404: no route\\n'); process.exit(1); }
  let rest = m[2] || '';
  let query = '';
  const qi = rest.indexOf('?');
  if (qi !== -1) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const s = state();
  const item = s.issues.concat(s.prs).find((it) => it.number === Number(m[1]));
  if (!item) { process.stderr.write('HTTP 404: not found\\n'); process.exit(1); }
  const fBody = () => args[args.indexOf('-f') + 1];
  if (rest === '' && method === 'GET') {
    out({ number: item.number, title: item.title, labels: (item.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
    process.exit(0);
  }
  if (rest === '/comments' && method === 'GET') {
    const page = Number((query.match(/(?:^|&)page=(\\d+)/) || [])[1] || 1);
    out(page > 1 ? [] : item.comments || []);
    process.exit(0);
  }
  if (rest === '/comments' && method === 'POST') {
    item.comments = item.comments || [];
    item.comments.push({ body: fBody().replace(/^body=/, '') });
    save(s); out({}); process.exit(0);
  }
  if (rest === '/labels' && method === 'POST') {
    item.labels = (item.labels || []).concat([fBody().replace(/^labels\\[\\]=/, '')]);
    save(s); out([]); process.exit(0);
  }
  if (rest.startsWith('/labels/') && method === 'DELETE') {
    const target = decodeURIComponent(rest.slice('/labels/'.length)).toLowerCase();
    item.labels = (item.labels || []).filter((l) => lname(l) !== target);
    save(s); out(''); process.exit(0);
  }
}
process.stderr.write('HTTP 404: unhandled gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`;

// Agent stub that POPS a queue step — an untouched queue proves the model was
// never invoked; a consumed one proves a dispatch actually happened.
const AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
const queueFile = process.env.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 1.87,
  usage: { input_tokens: 400000, cache_creation_input_tokens: 10000,
           cache_read_input_tokens: 2034, output_tokens: 38112 },
}) + '\\n');
`;

const POLICY = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-needs-human-park-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: opts.issues || [], prs: opts.prs || [] }));
  const queueFile = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(queueFile, JSON.stringify(opts.queue || []));
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY);
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  return { dir, home, bin, agent, stateFile, queueFile };
}

function runWorker(fx) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    AGENT_QUEUE: fx.queueFile,
    VERITY_AGENT_BIN: fx.agent,
  };
  try {
    const out = execFileSync('node', [WORKER, '--repo', 'octo/fixture', '--once'], {
      cwd: fx.dir,
      encoding: 'utf8',
      env,
    });
    return { code: 0, out, stderr: '' };
  } catch (err) {
    return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
  }
}

const ghState = (fx) => JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
const itemIn = (state, n) => state.issues.concat(state.prs).find((it) => it.number === n);
const comments = (state, n) => (itemIn(state, n).comments || []).map((c) => c.body);
const labelsOf = (state, n) =>
  (itemIn(state, n).labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const queueLeft = (fx) => JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length;

function setLabels(fx, number, labels) {
  const s = ghState(fx);
  itemIn(s, number).labels = labels;
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

// The canary's shape: the stage's work-item issue carries no scanner label, so
// only the P5 dependency engine can see the stage at all.
function stageIssue(extra = {}) {
  return {
    number: 41,
    title: '[stage 1] Core',
    state: 'OPEN',
    labels: [],
    author: { login: 'human' },
    createdAt: '2026-06-01T00:00:00Z',
    assignees: [],
    comments: [],
    ...extra,
  };
}

function noCiPr(extra = {}) {
  return {
    number: 114,
    title: '[stage 1] Core',
    state: 'OPEN',
    headRefName: 'feat/stage-1-core',
    labels: [],
    statusCheckRollup: [], // a PR with no checks at all — CI unverifiable
    comments: [],
    ...extra,
  };
}

const requestIssue = (extra = {}) => ({
  number: 30,
  title: 'Add widgets',
  state: 'OPEN',
  labels: ['verity:request'],
  author: { login: 'human' }, // NOT the bot — the P4 no-self-feeding rule is not under test
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
  ...extra,
});

// Nothing was written anywhere: the operator's own label is the whole record.
function assertNoParkNoise(fx, numbers) {
  const state = ghState(fx);
  for (const n of numbers) {
    assertEqual(comments(state, n).length, 0, `no comments on #${n} — parking makes no noise`);
    assert(
      !labelsOf(state, n).includes('verity:awaiting-approval'),
      `no gate label on #${n} — a parked stage is never announced (labels: ${labelsOf(state, n)})`,
    );
  }
}

test('e2e REGRESSION (stage 27): needs-human on the ISSUE parks the gate path — idle, silent, zero model runs', () => {
  const fx = fixture({
    issues: [stageIssue({ labels: [NEEDS_HUMAN] })],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [{ final: 'unused' }], // an untouched queue proves the agent never ran
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `a parked repo is honestly idle (stderr: ${stderr})`);
  assert(out.includes('idle'), `the tick reads idle, not gated — got: ${out}`);
  assert(!/gated/.test(out), `the parked stage is not re-announced — got: ${out}`);
  assertEqual(queueLeft(fx), 1, 'no model run was spent');
  assertNoParkNoise(fx, [41, 114]);
  assertEqual(
    JSON.stringify(labelsOf(ghState(fx), 41)),
    JSON.stringify([NEEDS_HUMAN]),
    'the operator’s label is untouched',
  );
});

test('e2e REGRESSION (stage 27): needs-human on the PR ONLY parks too', () => {
  const fx = fixture({
    issues: [stageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr({ labels: [NEEDS_HUMAN] })],
    queue: [{ final: 'unused' }],
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `PR-only park is honored (stderr: ${stderr})`);
  assert(out.includes('idle'), `idle, never re-gated — got: ${out}`);
  assertEqual(queueLeft(fx), 1, 'no model run was spent');
  assertNoParkNoise(fx, [41, 114]);
});

test('e2e REGRESSION (stage 27): a parked stage does not starve a pending verity:request', () => {
  const fx = fixture({
    issues: [stageIssue({ labels: [NEEDS_HUMAN] }), requestIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [{ final: marker('success') }], // the plan role for the request
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(code, 0, `the request run succeeds (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'the request WAS picked — plan dispatched');
  const state = ghState(fx);
  const summary = comments(state, 30).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'the §7 summary landed on the request issue');
  assert(summary.includes('✅ success'), `the run ends success, not re-gated — got: ${summary}`);
  assert(summary.includes('roles: plan'), `the plan role ran, got: ${summary}`);
  assertNoParkNoise(fx, [41, 114]);
});

test('e2e REGRESSION (stage 27): a parked stage does not starve another unblocked stage', () => {
  const fx = fixture({
    issues: [stageIssue({ labels: [NEEDS_HUMAN] })],
    stages: [{ title: 'Core' }, { title: 'Second' }], // stage 2 is independent
    prs: [noCiPr()],
    queue: [{ final: marker('gated', { gate: 'build' }) }],
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `stage 2's run completes (stderr: ${stderr})`);
  assertEqual(
    queueLeft(fx),
    0,
    'stage 2 WAS picked — build dispatched (the tick read idle before)',
  );
  assert(!/ci:unverified/.test(out), `stage 1's parked gate never surfaces — got: ${out}`);
  assertNoParkNoise(fx, [41, 114]);
});

test('e2e: removing the label restores stage-22 behavior exactly — announce once, then quiet', () => {
  const fx = fixture({
    issues: [stageIssue({ labels: [NEEDS_HUMAN] })],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [{ final: 'unused' }],
  });
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `parked tick is idle (stderr: ${tick1.stderr})`);
  assertNoParkNoise(fx, [41, 114]);

  // The operator un-parks the stage: the very next tick announces the gate
  // through the stage-22 machinery, exactly as if the park never happened.
  setLabels(fx, 41, []);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `un-parked tick announces (stderr: ${tick2.stderr})`);
  assert(/gated/.test(tick2.out), `outcome reads gated, got: ${tick2.out}`);
  const state = ghState(fx);
  assert(labelsOf(state, 114).includes('verity:awaiting-approval'), 'gate label lands on the PR');
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate !== undefined, 'the GATE_PAUSE comment was posted');
  assert(gate.includes('paused at human gate `ci:unverified`'), `names the gate, got: ${gate}`);
  const after2 = comments(state, 114).length;

  // Announce-once still holds on the tick after.
  const tick3 = runWorker(fx);
  assertEqual(tick3.code, 0, `announced gate stays quiet (stderr: ${tick3.stderr})`);
  assertEqual(comments(ghState(fx), 114).length, after2, 'no re-announcement, no comment spam');
  assertEqual(queueLeft(fx), 1, 'no tick spent a model run');
});
