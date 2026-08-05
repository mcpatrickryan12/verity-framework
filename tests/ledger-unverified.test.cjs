// Stage 20 — an unreachable GitHub must not read as a confident empty state
// (issue #60; the 2026-07-31 canary run 3).
//
// The defect: `ledger.ghJson()` did `catch { return null }` with gh's stderr
// explicitly discarded, and every caller turned that null into `[]`. So
// "could not look" became "looked, and there is nothing":
//
//   $ verity state stage 1                    # gh working
//   { "status": "building", "issue": 1, "pr": 2 }
//   $ PATH=<gh that exits 1> verity state stage 1
//   { "status": "planned", "issue": null, "pr": null }   exit=0  stderr: (empty)
//
// A wrong answer indistinguishable from a true one is worse than a failure,
// because every consumer believes it. Live in run 3 the `review` role was told
// "no PR or linked issue exists" while PR #2 was open, so it could not review,
// failed twice, and burned a no-progress strike.
//
// The fix follows stage 19's precedent — unknown is its own state, never folded
// into a confident value — and ADR-0011's fail-closed rule: the snapshot is
// stamped `verified`, and every consumer REFUSES rather than answer from it.
//
// The one thing this suite must NEVER let pass is the tempting shortcut of
// letting an unverified snapshot answer "quietly, just this once": the
// consumer-audit test below is the guard against exactly that.
//
// Stub-driven like tests/next-snapshot.test.cjs and tests/ci-unknown.test.cjs
// (their own gh + agent stubs on PATH). No network, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../verity/bin/lib/ledger.cjs');
const nextLib = require('../verity/bin/lib/next.cjs');
const stage = require('../verity/bin/lib/stage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');

// The same canned GitHub state as tests/next-snapshot.test.cjs, so the healthy
// path asserted here is the identical projection that suite pins byte-for-byte:
// stage 1 merged, stage 2 in review (PR open, CI green), stage 3 untouched.
const ISSUES = [
  { number: 11, title: '[stage 1] First', state: 'CLOSED', labels: [], assignees: [] },
  { number: 12, title: '[stage 2] Second', state: 'OPEN', labels: [], assignees: [{ login: 'd' }] },
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

// Token-shaped strings are ASSEMBLED AT RUNTIME and never written as literals.
//
// This is not cosmetic. A literal `ghp_…` sitting in a source file is
// indistinguishable from a real leaked credential to a secret scanner, and
// gitleaks correctly flagged the first version of this file. The fix is NOT an
// allowlist: an allowlist on a test file is a permanent hole, and the next
// REAL secret committed here would sail straight through it. So the scanner
// stays sharp, the literals go away, and the assertions below are unchanged in
// strength — every shape is still built and still driven end-to-end through
// redact().
const BODY36 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 chars: the gh token body
// `gh<kind>_` + 36 chars — the shape of every gh-issued token (p personal,
// o oauth, u user-to-server, s server-to-server, r refresh).
const ghShape = (kind) => ['gh', kind, '_', BODY36].join('');
// `github_pat_` + 82 chars — the fine-grained PAT shape.
const fineGrainedShape = () =>
  ['github', '_', 'pat', '_', '11', BODY36.repeat(3).slice(0, 80)].join('');
// The classic 40-hex PAT.
const classicHexShape = () => '0123456789abcdef'.repeat(3).slice(0, 40);

// Canned gh stderr for each failure mode an operator has to tell apart. The
// auth one deliberately carries a token-shaped string: nothing Verity prints
// may ever repeat it.
const FAKE_TOKEN = ghShape('p');
const STDERR = {
  auth: `gh: Bad credentials (HTTP 401) — token ${FAKE_TOKEN} was rejected\nTry authenticating with: gh auth login`,
  network: 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
  rate: 'gh: API rate limit exceeded for user ID 4242. (HTTP 403)',
};

// A fake `gh` first on PATH. GH_FAIL is a list of { match, stderr }: a call
// whose joined argv contains `match` ('*' = every call) fails with that stderr.
const GH_STUB = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
const hit = JSON.parse(process.env.GH_FAIL || '[]').find((f) => f.match === '*' || a.includes(f.match));
if (hit) { process.stderr.write(hit.stderr + '\\n'); process.exit(1); }
if (a.startsWith('issue list')) { console.log(process.env.GH_ISSUES); }
else if (a.startsWith('pr list')) { console.log(process.env.GH_PRS); }
else if (a.startsWith('repo view')) { console.log('{"name":"fixture"}'); }
else { process.exit(1); }
`;

function fixture(fail = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-unverified-'));
  stage.create(dir, 'First'); // stage 1, deps none
  stage.create(dir, 'Second', { dependsOn: '1' }); // stage 2
  stage.create(dir, 'Third', { dependsOn: '2' }); // stage 3
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_FAIL: JSON.stringify(fail),
    GH_ISSUES: JSON.stringify(ISSUES),
    GH_PRS: JSON.stringify(PRS),
  };
  // Returns { code, out, stderr } — never throws, so exit codes are asserted
  // directly rather than inferred from a thrown error (verify by exit code).
  const run = (args) => {
    try {
      const out = execFileSync('node', [CLI, ...args, '--cwd', dir], {
        encoding: 'utf8',
        cwd: dir,
        env,
      });
      return { code: 0, out, stderr: '' };
    } catch (err) {
      return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
    }
  };
  return { dir, run, fail };
}

// ---------------------------------------------------------------------------
// (1) The reproduction, as a regression
// ---------------------------------------------------------------------------

test('REGRESSION #60: gh unreachable — `state stage 1` REFUSES, never a confident planned/null', () => {
  const fx = fixture([{ match: '*', stderr: STDERR.network }]);
  const { code, out, stderr } = fx.run(['state', 'stage', '1']);

  // The exact falsehood run 3 believed. Stage 1 has issue #11 and PR #21.
  assert(!/"status":\s*"planned"/.test(out), `must not claim planned, got stdout: ${out}`);
  assert(!/"pr":\s*null/.test(out), `must not claim there is no PR, got stdout: ${out}`);
  assert(!/"issue":\s*null/.test(out), `must not claim there is no issue, got stdout: ${out}`);

  // ...and the failure is visible, never silent at exit 0 with empty stderr.
  assert(code !== 0, `an unverifiable state must exit nonzero, got ${code}`);
  assert(stderr.trim().length > 0, 'the refusal must say something on stderr');
});

test('REGRESSION #60: every `verity state` verb refuses, not just `stage`', () => {
  const fx = fixture([{ match: '*', stderr: STDERR.network }]);
  for (const verb of [['view'], ['next'], ['summary'], ['graph'], ['stage', '1']]) {
    const { code, out } = fx.run(['state', ...verb]);
    assert(code !== 0, `state ${verb.join(' ')} must exit nonzero, got ${code}`);
    assertEqual(out, '', `state ${verb.join(' ')} must print no answer at all`);
  }
});

test('REGRESSION #60: `--raw` cannot launder the refusal into a printable value', () => {
  const fx = fixture([{ match: '*', stderr: STDERR.network }]);
  const { code, out } = fx.run(['state', 'next', '--raw']);
  assert(code !== 0, 'raw output refuses too');
  assertEqual(out, '', 'no raw value is emitted for a state nobody could read');
});

// ---------------------------------------------------------------------------
// (2) Partial failure — half a snapshot is not a whole one
// ---------------------------------------------------------------------------

test('partial failure: issues read, PRs did NOT — no half-true snapshot is presented as whole', () => {
  const fx = fixture([{ match: 'pr list', stderr: STDERR.rate }]);
  const { code, out } = fx.run(['state', 'view']);
  assert(code !== 0, `a snapshot missing its PRs must refuse, got ${code}`);
  assertEqual(out, '', 'and must not emit the issues-only projection');
});

test('partial failure: PRs read, issues did NOT — same refusal', () => {
  const fx = fixture([{ match: 'issue list', stderr: STDERR.rate }]);
  const { code, out } = fx.run(['state', 'view']);
  assert(code !== 0, `a snapshot missing its issues must refuse, got ${code}`);
  assertEqual(out, '', 'and must not emit the PRs-only projection');
});

test('fetchSnapshot stamps WHICH read failed, so the half-truth is inspectable', () => {
  const fx = fixture([{ match: 'pr list', stderr: STDERR.rate }]);
  const { out } = fx.run(['state', 'view']); // exercised through the CLI above
  assertEqual(out, '');
  // ...and directly, through the module API.
  const snap = withStubPath(fx, () => ledger.fetchSnapshot(fx.dir));
  assertEqual(snap.verified, false, 'a snapshot with a failed read is NOT verified');
  assertEqual(ledger.snapshotVerified(snap), false);
  assertEqual(
    snap.failures.map((f) => f.source).join(','),
    'prs',
    'exactly the read that failed is named',
  );
  assert(Array.isArray(snap.issues), 'the read that SUCCEEDED is still present');
  assertEqual(snap.prs, null, 'the read that failed is null — not an empty list');
});

// Run `fn` with the fixture's stub gh first on PATH (module-API calls shell out
// from this process, not a child).
function withStubPath(fx, fn) {
  const before = process.env.PATH;
  const beforeFail = process.env.GH_FAIL;
  const beforeIssues = process.env.GH_ISSUES;
  const beforePrs = process.env.GH_PRS;
  process.env.PATH = `${path.join(fx.dir, 'stub-bin')}${path.delimiter}${before}`;
  process.env.GH_FAIL = JSON.stringify(fx.fail || []);
  process.env.GH_ISSUES = JSON.stringify(ISSUES);
  process.env.GH_PRS = JSON.stringify(PRS);
  try {
    return fn();
  } finally {
    process.env.PATH = before;
    restore('GH_FAIL', beforeFail);
    restore('GH_ISSUES', beforeIssues);
    restore('GH_PRS', beforePrs);
  }
}

function restore(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// (3) The diagnostic — the reason survives, the credential does not
// ---------------------------------------------------------------------------

test('the diagnostic distinguishes auth from network from rate limit', () => {
  const cases = [
    ['auth', /auth/i],
    ['network', /network/i],
    ['rate', /rate.?limit/i],
  ];
  for (const [mode, re] of cases) {
    const fx = fixture([{ match: '*', stderr: STDERR[mode] }]);
    const { stderr } = fx.run(['state', 'view']);
    assert(re.test(stderr), `${mode} failure must be identifiable, got: ${stderr}`);
  }
});

test('the diagnostic NEVER repeats a credential', () => {
  const fx = fixture([{ match: '*', stderr: STDERR.auth }]);
  const { out, stderr } = fx.run(['state', 'view']);
  assert(!stderr.includes(FAKE_TOKEN), `stderr leaked the token: ${stderr}`);
  assert(!out.includes(FAKE_TOKEN), 'stdout leaked the token');
  assert(/redacted/i.test(stderr), `the token was redacted in place, got: ${stderr}`);
});

test('redact covers the token shapes GitHub actually issues', () => {
  // Every shape gh can hand out, assembled above rather than spelled out here.
  const shapes = [
    ghShape('p'), // personal access token
    ghShape('o'), // oauth token
    ghShape('u'), // user-to-server token
    ghShape('s'), // server-to-server token
    ghShape('r'), // refresh token
    fineGrainedShape(), // fine-grained PAT
    classicHexShape(), // classic 40-hex PAT
  ];
  // Guard the guard: a shape that did not actually get BUILT would make the
  // loop below vacuous, and this test would pass while proving nothing.
  assertEqual(shapes.length, 7, 'every shape is exercised');
  for (const s of shapes) {
    assert(s.length >= 40, `shape must be a real token length, got ${s.length}`);
  }
  for (const s of shapes) {
    const red = ledger.redact(`failed with ${s} in the message`);
    assert(!red.includes(s), `redact must remove ${s}, got: ${red}`);
  }
  assertEqual(
    ledger.redact('Authorization: Bearer sekrit-value'),
    'Authorization: [redacted]',
    'auth headers are redacted whole',
  );
  assertEqual(
    ledger.redact('HTTP 401: Bad credentials'),
    'HTTP 401: Bad credentials',
    'ordinary diagnostics survive intact',
  );
});

// ---------------------------------------------------------------------------
// (4) `verity next` — never `work`, never `idle`, on unverified state
// ---------------------------------------------------------------------------

const proj1 = () => ({
  stages: [
    {
      number: 1,
      title: 'Core',
      type: 'feature',
      dependsOn: [],
      status: 'planned',
      issue: 41,
      pr: null,
    },
  ],
  next: [1],
});

test('REGRESSION #60: `next` does not emit work for a stage whose real state is unknown', () => {
  const d = nextLib.decide(proj1(), { verified: false, failures: [] });
  assertEqual(d.action, 'gated', 'unverified state gates — it is never work');
  assertEqual(d.gate, nextLib.STATE_GATE);
  assertEqual(d.gate, 'state:unverified');
  assertEqual(nextLib.exitCodeFor(d), 10, 'gated exits 10');
});

test('an unverified snapshot is never IDLE either — "nothing to do" is the same falsehood', () => {
  // No stages at all: the shape that would otherwise read as a confident idle.
  const d = nextLib.decide({ stages: [], next: [] }, { verified: false, failures: [] });
  assertEqual(d.action, 'gated', 'idle claims Verity looked; it did not');
  assertEqual(d.gate, 'state:unverified');
});

test('the refusal outranks every other reading — it is checked FIRST', () => {
  // A snapshot that would otherwise produce a label gate, or a ci:unverified
  // gate, still reports state:unverified: none of those readings was observed.
  const snap = {
    verified: false,
    failures: [{ source: 'prs', reason: 'rate-limit', detail: 'x' }],
    issues: [{ number: 41, labels: [{ name: 'verity:awaiting-approval' }] }],
    prs: [{ number: 114, labels: [], statusCheckRollup: [] }],
  };
  assertEqual(nextLib.decide(proj1(), snap).gate, 'state:unverified');
});

test('a VERIFIED snapshot decides exactly as before — byte-identical', () => {
  const before = {
    schema: 1,
    action: 'work',
    role: 'build',
    args: ['1'],
    gate: null,
    target: { kind: 'issue', number: 41 },
    reason: 'stage 1 (Core) is unblocked for build',
  };
  // Explicitly verified, and — the backward-compatibility case — a legacy
  // injected snapshot carrying no `verified` field at all.
  for (const snap of [{ verified: true, issues: [], prs: [] }, { issues: [], prs: [] }, {}]) {
    assertEqual(JSON.stringify(nextLib.decide(proj1(), snap)), JSON.stringify(before));
  }
});

test('`verity next --json` on an unreachable gh gates at state:unverified, exit 10', () => {
  const fx = fixture([{ match: '*', stderr: STDERR.network }]);
  const { code, out } = fx.run(['next', '--json']);
  assertEqual(code, 10, 'gated is exit 10 (the frozen next contract), never 0');
  const d = JSON.parse(out);
  assertEqual(d.action, 'gated');
  assertEqual(d.gate, 'state:unverified');
  assert(/could not/i.test(d.reason), `the reason says we could not look, got: ${d.reason}`);
});

// ---------------------------------------------------------------------------
// (5) The consumer audit — the anti-shortcut guard
// ---------------------------------------------------------------------------

test('NO consumer of an unverified snapshot answers from it', () => {
  const unverified = { verified: false, failures: [], issues: null, prs: null, tags: [] };

  // ledger — the predicate itself, and its deliberate backward compatibility.
  assertEqual(ledger.snapshotVerified(unverified), false);
  assertEqual(ledger.snapshotVerified({}), true, 'an injected snapshot is verified (unchanged)');
  assertEqual(ledger.snapshotVerified({ verified: true }), true);

  // next.decide — the dispatch decision, where a model run is spent.
  assertEqual(nextLib.decide(proj1(), unverified).action, 'gated');
  assertEqual(nextLib.decide(proj1(), unverified).gate, 'state:unverified');

  // ...and it can never be work, for ANY policy knob value: the stage-19
  // opt-out is about unverified CI, not an unverified snapshot.
  for (const value of [undefined, 'gate', 'allow_without_merge']) {
    assertEqual(
      nextLib.decide(proj1(), unverified, { unverifiedCi: value }).action,
      'gated',
      `unverifiedCi=${String(value)} must not turn an unread snapshot into work`,
    );
  }
});

// ---------------------------------------------------------------------------
// (6) The healthy path is UNCHANGED
// ---------------------------------------------------------------------------

test('HEALTHY PATH: gh working — every state verb is byte-identical to before', () => {
  const fx = fixture([]);
  assertEqual(fx.run(['state', 'next']).out, '{\n  "next": [\n    2\n  ],\n  "raw": "[2]"\n}\n');
  assertEqual(fx.run(['state', 'next', '--raw']).out, '[2]\n');
  assertEqual(fx.run(['state', 'summary', '--raw']).out, '3 stages · release (none) · next [2]\n');
  assertEqual(
    fx.run(['state', 'stage', '1']).out,
    `${JSON.stringify(
      {
        number: 1,
        title: 'First',
        type: 'feature',
        dependsOn: [],
        status: 'merged',
        issue: 11,
        pr: 21,
      },
      null,
      2,
    )}\n`,
  );
  assertEqual(fx.run(['state', 'view']).code, 0, 'and it exits 0');
  // `online: true` is still in the projection, unchanged, for existing readers.
  assert(/"online": true/.test(fx.run(['state', 'view']).out), 'online is still reported');
});

test('HEALTHY PATH: an unknown verb still fails, and a real answer still exits 0', () => {
  const fx = fixture([]);
  assertEqual(fx.run(['state', 'next']).code, 0, 'state next must exit 0');
  assert(fx.run(['state', 'bogus-verb']).code !== 0, 'unknown state verb still exits nonzero');
});

// ---------------------------------------------------------------------------
// (7) The worker does not dispatch a model run against an unverified snapshot
// ---------------------------------------------------------------------------

// Trimmed twin of tests/ci-unknown.test.cjs's stub, plus one thing: the LEDGER's
// two reads (`--state all`) fail while every other gh call succeeds. That is the
// dangerous shape — `gh auth status`, `gh api user`, and the circuit-breaker
// query all pass startup, so nothing before the dispatch decision notices.
const WORKER_GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--state') && args[args.indexOf('--state') + 1] === 'all') {
  process.stderr.write('gh: API rate limit exceeded for user ID 4242. (HTTP 403)\\n');
  process.exit(1);
}
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

// An agent stub that POPS a queue step — an untouched queue proves the model
// was never invoked, which is the whole point of this section.
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

function workerFixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-unverified-worker-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), WORKER_GH_STUB);
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
  stage.create(dir, 'Core');
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

const queueLeft = (fx) => JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length;

const readyIssue = {
  number: 41,
  title: '[stage 1] Core',
  state: 'OPEN',
  labels: ['verity:ready'],
  author: { login: 'human' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
};

test('REGRESSION #60 (worker): a selected item + unverified state spends NO model run', () => {
  const fx = workerFixture({
    issues: [readyIssue],
    queue: [{ final: 'unused' }], // an untouched queue proves the agent never ran
  });
  const { code, stderr } = runWorker(fx);
  assertEqual(queueLeft(fx), 1, 'the agent was NEVER invoked against an unverified snapshot');
  assertEqual(code, 30, `an unreadable GitHub is an infra stop (stderr: ${stderr})`);
  assert(/unverified/i.test(stderr), `the worker says why it stopped, got: ${stderr}`);
});

test('REGRESSION #60 (worker): with NOTHING selectable, unverified state is not "idle"', () => {
  // Every scanner tier comes back empty, so the run reaches P5 — where the
  // dependency engine cannot see the repository at all. Reporting idle here
  // would be the same confident falsehood one layer up.
  const fx = workerFixture({ issues: [], queue: [{ final: 'unused' }] });
  const { code, out, stderr } = runWorker(fx);
  assertEqual(queueLeft(fx), 1, 'no model run');
  assertEqual(code, 30, `must not exit 0 as idle (stdout: ${out}, stderr: ${stderr})`);
  assert(!/idle/.test(out), `and must not print an idle line, got: ${out}`);
  assert(/state-unverified/.test(stderr), `the §8.2 stderr line names the slug, got: ${stderr}`);
});
