// Stage 22 — the ci:unverified gate must be visible on GitHub, not only on
// stdout (issue #59; canary run 3, ticks 4 and 6).
//
// The defect: stage 19's gate refuses correctly, but when the ONLY finding is
// the P5 dependency engine's gated decision (no P1–P4 label selects an item),
// the scanner yields nothing and the worker reads the repository as plain
// `idle` — no label, no comment, no instruction. In a cron-driven worker
// nobody reads stdout, so a supervised repo parked forever, invisibly.
// (When a labeled tier DID select the item — e.g. a `verity:ready` stage
// issue, the shape stage 19's own e2e tests use — the run loop announced the
// gate via GATE_PAUSE all along. The canary repo had no labeled items.)
//
// The fix reuses the EXISTING gate machinery: runOnce routes an un-announced
// gated P5 decision through the same gatePause + §7 SUMMARIZE every other
// gate uses, and reports the run as `gated`, never `idle`. `verity next`
// marks a label-derived gate `announced: true` (additive field) so an
// already-visible pause stays quiet — re-announcing every cron tick would be
// comment spam, and the T14 guarantee ("no new comments while waiting for
// the human") must keep holding.
//
// Stub-driven like tests/ci-unknown.test.cjs (its own trimmed gh + agent
// stubs on PATH; a JSON state file holds labels/comments). No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nextLib = require('../verity/bin/lib/next.cjs');
const stage = require('../verity/bin/lib/stage.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// A ledger projection + raw snapshot for one stage whose PR is in the given
// CI state (same helpers as tests/ci-unknown.test.cjs).
function projWith(status, pr) {
  return {
    stages: [{ number: 1, title: 'Core', type: 'feature', dependsOn: [], status, issue: 41, pr }],
    next: [1],
  };
}
function snapWith(rollup) {
  return {
    issues: [{ number: 41, labels: [] }],
    prs: [{ number: 114, labels: [], statusCheckRollup: rollup }],
  };
}

// ---------------------------------------------------------------------------
// (1) `verity next` — announced is derived from the gate label, additively
// ---------------------------------------------------------------------------

test('REGRESSION #59: a fresh ci:unverified gate is NOT marked announced — nothing on GitHub says it yet', () => {
  const d = nextLib.decide(projWith('building', 114), snapWith([]));
  assertEqual(d.action, 'gated');
  assertEqual(d.gate, 'ci:unverified');
  assertEqual(d.announced, undefined, 'no gate label anywhere → the pause is not visible yet');
});

test('a label-derived gate IS marked announced — the pause is already visible on GitHub', () => {
  const onIssue = snapWith([]);
  onIssue.issues[0].labels = [{ name: 'verity:awaiting-approval' }];
  assertEqual(nextLib.decide(projWith('building', 114), onIssue).announced, true);
  const onPr = snapWith([]);
  onPr.prs[0].labels = [{ name: 'verity:awaiting-approval' }];
  const d = nextLib.decide(projWith('building', 114), onPr);
  assertEqual(d.announced, true, 'the label on the PR counts too (T14: labels are a union)');
  assertEqual(d.gate, 'ci:unverified', 'the gate keeps its stage-19 name');
});

test('announced is ADDITIVE: work and idle decisions never carry it', () => {
  const work = nextLib.decide(projWith('building', 114), snapWith([{ conclusion: 'FAILURE' }]));
  assertEqual(work.action, 'work');
  assertEqual(work.announced, undefined);
  const idle = nextLib.decide({ stages: [], next: [] }, snapWith([]));
  assertEqual(idle.action, 'idle');
  assertEqual(idle.announced, undefined);
});

test('the gate reason names the cause and never claims approval makes CI green', () => {
  const d = nextLib.decide(projWith('building', 114), snapWith([]));
  assert(/may have no CI configured/.test(d.reason), `names the likely cause, got: ${d.reason}`);
  assert(/without merging/i.test(d.reason), `approval scope: proceed, not merge — ${d.reason}`);
  assert(
    /does not make CI green/i.test(d.reason),
    `the honest note: approving is not verification — ${d.reason}`,
  );
  assert(/nothing merges on unverified CI/.test(d.reason), `merge bar unchanged — ${d.reason}`);
});

// ---------------------------------------------------------------------------
// (2) End-to-end: the worker on a repository whose ONLY finding is P5's gate
// ---------------------------------------------------------------------------

// Trimmed twin of tests/ci-unknown.test.cjs's stubs.
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
if (args[0] === 'pr' && args[1] === 'view') {
  const p = state().prs.find((x) => x.number === Number(args[2]));
  out({ labels: (p.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
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

// The DEFAULT policy the canary ran under (max_usd_per_day 25.0,
// unknown_cost_behavior 'gate' from autonomy DEFAULTS). The multi-tick tests
// below MUST run under it: the announcement run dispatches no model, so its
// cost is a VERIFIED $0 — if it were recorded as unknown instead, stage 21's
// rollup would read it as UNGATED unknown spend and the next tick's startup
// breaker would exit 30 unknown-cost-budget with approvable:false, wedging
// the operator who did exactly what the gate comment told them to do.
const POLICY = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gate-visible-'));
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
// usage.csv data rows (header dropped). Cell layout:
// timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate
const usageRows = (fx) =>
  fs
    .readFileSync(path.join(fx.dir, '.verity', 'usage.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);

function addLabelTo(fx, number, label) {
  const s = ghState(fx);
  const item = itemIn(s, number);
  item.labels = (item.labels || []).concat([label]);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

// The canary's exact shape: the stage's work-item issue carries NO scanner
// label — P1 through P4 are all empty, so only the P5 dependency engine can
// see the stage at all. (Stage 19's own e2e fixtures label the issue
// `verity:ready`, which is why P3 selected it and the gate WAS announced
// there.)
function unlabeledStageIssue(extra = {}) {
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

const reviewApproveStep = () => ({
  final: `Done.\n${JSON.stringify({
    verity: 1,
    outcome: 'success',
    gate: null,
    artifacts: { pr: 114, verdict: 'approve' },
    reason: 'LGTM',
  })}`,
});

test('e2e REGRESSION #59: a no-CI repo with no labeled work parks VISIBLY — label + comment + gated outcome, never plain idle', () => {
  const fx = fixture({
    issues: [unlabeledStageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [{ final: 'unused' }], // an untouched queue proves the agent never ran
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `the gate exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 1, 'no model run was spent');

  const state = ghState(fx);
  assert(
    labelsOf(state, 114).includes('verity:awaiting-approval'),
    `gate label lands on the PR — the canary saw nothing (labels: ${labelsOf(state, 114)})`,
  );
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate !== undefined, 'a GATE_PAUSE comment was posted on the PR');
  assert(gate.includes('paused at human gate `ci:unverified`'), `names the gate, got: ${gate}`);
  assert(gate.includes(worker.APPROVAL_ACTION), 'says exactly how to approve');
  assert(gate.includes('@seanerama'), 'mentions notify.mention');
  // The comment names cause + remedy, and never claims approval makes CI green.
  assert(gate.includes('may have no CI configured'), `names the cause, got: ${gate}`);
  assert(/does not make CI green/i.test(gate), `honest about what approval is NOT, got: ${gate}`);
  assert(gate.includes('nothing merges on unverified CI'), 'merge bar stated plainly');

  // The run reads as GATED, never as "no work exists".
  assert(!/verity-worker: idle/.test(out), `must not report idle, got: ${out}`);
  assert(/gated/.test(out), `outcome reads gated, got: ${out}`);
  const summary = comments(state, 114).find((b) => b.startsWith('🤖'));
  assert(summary !== undefined, 'the §7 run summary was posted');
  assert(summary.includes('⏸️ gated'), `outcome badge is gated, got: ${summary}`);
  assert(summary.includes('gated at ci:unverified'), `result names the gate, got: ${summary}`);
  assert(summary.includes(worker.APPROVAL_ACTION), 'the summary carries the approve line');
});

test('e2e: the announcement happens ONCE — the next tick stays quiet (no label/comment spam)', () => {
  // DEFAULT policy on purpose: a zero-dispatch announcement must not poison
  // the next tick's budget check (see the POLICY comment above).
  const fx = fixture({
    issues: [unlabeledStageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [{ final: 'unused' }],
  });
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 announces the gate (stderr: ${tick1.stderr})`);
  const after1 = comments(ghState(fx), 114).length;
  assert(after1 > 0, 'tick 1 posted the announcement');

  // The announcement dispatched nothing, so its ledger row is a VERIFIED $0 —
  // never an unknown-cost cell that would trip the stage-18/21 startup
  // breaker on the very next tick (exit 30 unknown-cost-budget, unapprovable).
  const row = usageRows(fx).find((r) => r.endsWith(',ci:unverified'));
  assert(
    row !== undefined,
    `the announcement wrote its gate-stamped usage row, got: ${usageRows(fx)}`,
  );
  assertEqual(
    row.split(',')[6],
    '0',
    'the announcement records est_usd 0 (verified zero spend), not an unknown cost',
  );

  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 exits 0 (stderr: ${tick2.stderr})`);
  assert(/ci:unverified/.test(tick2.out), `tick 2 still says WHY on stdout, got: ${tick2.out}`);
  assertEqual(
    comments(ghState(fx), 114).length,
    after1,
    'an already-announced gate is not re-announced — no comment spam while waiting for the human',
  );
  assertEqual(
    labelsOf(ghState(fx), 114).filter((l) => l === 'verity:awaiting-approval').length,
    1,
    'the gate label is applied exactly once',
  );
  assertEqual(queueLeft(fx), 1, 'neither tick spent a model run');
});

test('e2e: approving the ANNOUNCED gate flows through the existing machinery — review runs, nothing merges', () => {
  // DEFAULT policy on purpose: the operator who answers the gate comment with
  // `verity:approved` must actually be allowed to proceed on the next tick —
  // the canary's exact supervised shape.
  const fx = fixture({
    issues: [unlabeledStageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    queue: [reviewApproveStep()],
  });
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 announces (stderr: ${tick1.stderr})`);
  assertEqual(queueLeft(fx), 1, 'tick 1 dispatched nothing');
  assert(labelsOf(ghState(fx), 114).includes('verity:awaiting-approval'), 'gate is visible');

  // The human answers the gate comment exactly as it instructs.
  addLabelTo(fx, 114, 'verity:approved');

  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 proceeds on the approval (stderr: ${tick2.stderr})`);
  assertEqual(queueLeft(fx), 0, 'the review role DID run — the approval unblocked the stage');
  const state = ghState(fx);
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the single-use token was consumed');
  assertEqual(itemIn(state, 114).state, 'OPEN', 'the PR was NOT merged on unverified CI');
  const summary = comments(state, 114)
    .filter((b) => b.startsWith('🤖'))
    .pop();
  assert(summary.includes('roles: review'), `review was dispatched, got: ${summary}`);
  assert(summary.includes('gated at review:merge'), `merge is still gated, got: ${summary}`);
});

test('e2e: genuinely-RED CI in the P5-only shape still dispatches build — unchanged', () => {
  const fx = fixture({
    issues: [unlabeledStageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })],
    queue: [
      {
        final: `Done.\n${JSON.stringify({
          verity: 1,
          outcome: 'gated',
          gate: 'build',
          artifacts: {},
          reason: 'needs a human',
        })}`,
      },
    ],
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `gated run exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'red CI still dispatches build');
  assert(!/ci:unverified/.test(out), `red is red, never unverified — got: ${out}`);
});

test('e2e: genuinely-GREEN CI in the P5-only shape still dispatches review — unchanged', () => {
  const fx = fixture({
    issues: [unlabeledStageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr({ statusCheckRollup: [{ conclusion: 'SUCCESS' }] })],
    queue: [reviewApproveStep()],
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `run exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'green CI dispatched review as always');
  assert(!/ci:unverified/.test(out), `green is green, never unverified — got: ${out}`);
  const summary = comments(ghState(fx), 114).find((b) => b.startsWith('🤖'));
  assert(summary.includes('roles: review'), `review ran, got: ${summary}`);
});

test('e2e: allow_without_merge still behaves as stage 19 defined — advances, never merges, no gate', () => {
  const fx = fixture({
    issues: [unlabeledStageIssue()],
    stages: [{ title: 'Core' }],
    prs: [noCiPr()],
    policy: `${POLICY}limits:\n  unverified_ci_behavior: allow_without_merge\n`,
    queue: [reviewApproveStep()],
  });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(code, 0, `run exits 0 (stderr: ${stderr})`);
  assertEqual(queueLeft(fx), 0, 'the stage advanced to review instead of gating');
  assert(!/ci:unverified/.test(out), `the knob opts out of the gate, got: ${out}`);
  const state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'OPEN', 'trust 0 still refuses to merge unverified CI');
  const gate = comments(state, 114).find((b) => b.startsWith('⏸️'));
  assert(gate?.includes('review:merge'), 'the only pause is the merge gate');
});
