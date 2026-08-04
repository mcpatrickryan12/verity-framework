// T08 — scanner (SKETCH §4.2 ranked work selection).
//
// Fixture-driven: `exec` is injected through the shared gh layer (gh.cjs), so
// no real `gh`/network is touched; queries are routed on `<kind> <label>` and
// recorded so the frozen §4.2 command shapes can be asserted. P5 is driven by
// an injected `nextDecision` (the `verity next` module API seam).
const scanner = require('../verity/bin/lib/scanner.cjs');

// fixtures: map 'issue verity:approved' | 'pr verity:awaiting-review' | ... ->
// array of raw gh items. Unlisted queries return [].
function fakeGh(fixtures) {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    const label = args[args.indexOf('--label') + 1];
    return JSON.stringify(fixtures[`${args[0]} ${label}`] || []);
  };
  return { exec, calls };
}

function scanWith(fixtures, opts = {}) {
  const { exec, calls } = fakeGh(fixtures);
  const result = scanner.scan({
    exec,
    nextDecision: opts.nextDecision || (() => ({ action: 'idle' })),
    ...opts,
  });
  return { result, calls };
}

const issue = (number, createdAt, extra = {}) => ({
  number,
  title: `issue ${number}`,
  createdAt,
  labels: [],
  ...extra,
});

test('P1 wins over all lower tiers; issues and PRs merge FIFO by createdAt', () => {
  const { result } = scanWith({
    'issue verity:approved': [issue(10, '2026-06-02T00:00:00Z')],
    'pr verity:approved': [issue(11, '2026-06-01T00:00:00Z')],
    'pr verity:awaiting-review': [issue(20, '2026-01-01T00:00:00Z')],
    'issue verity:ready': [issue(30, '2026-01-01T00:00:00Z')],
    'issue verity:request': [issue(40, '2026-01-01T00:00:00Z')],
  });
  assertEqual(result.tier, 'P1');
  assertEqual(result.kind, 'pr', 'older PR beats newer issue within P1');
  assertEqual(result.number, 11);
});

test('P2 wins when P1 empty; headRefName surfaces on the item', () => {
  const { result } = scanWith({
    'pr verity:awaiting-review': [
      issue(21, '2026-06-02T00:00:00Z', { headRefName: 'feat/b' }),
      issue(20, '2026-06-01T00:00:00Z', { headRefName: 'feat/a' }),
    ],
    'issue verity:ready': [issue(30, '2026-01-01T00:00:00Z')],
  });
  assertEqual(result.tier, 'P2');
  assertEqual(result.kind, 'pr');
  assertEqual(result.number, 20, 'FIFO: oldest first');
  assertEqual(result.headRefName, 'feat/a');
  assertEqual(result.title, 'issue 20');
});

test('P3 wins when P1-P2 empty', () => {
  const { result } = scanWith({
    'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z')],
    'issue verity:request': [issue(40, '2026-01-01T00:00:00Z')],
  });
  assertEqual(result.tier, 'P3');
  assertEqual(result.kind, 'issue');
  assertEqual(result.number, 30);
});

test('P4 wins when P1-P3 empty; bot-authored requests are ignored', () => {
  const fixtures = {
    'issue verity:request': [
      issue(40, '2026-06-01T00:00:00Z', { author: { login: 'verity-bot' } }),
      issue(41, '2026-06-02T00:00:00Z', { author: { login: 'human' } }),
    ],
  };
  const { result } = scanWith(fixtures, { botLogin: 'verity-bot' });
  assertEqual(result.tier, 'P4');
  assertEqual(result.number, 41, 'older bot-authored item is skipped (no self-feeding)');
  assertEqual(result.author, 'human');
});

test('P4: only bot-authored requests -> tier is empty, falls through to P5/idle', () => {
  const { result } = scanWith(
    {
      'issue verity:request': [
        issue(40, '2026-06-01T00:00:00Z', { author: { login: 'Verity-Bot' } }),
      ],
    },
    { botLogin: 'verity-bot' }, // login match is case-insensitive
  );
  assertEqual(result, null);
});

test('verity:needs-human is excluded in every tier', () => {
  const nh = { labels: [{ name: 'Verity:Needs-Human' }] }; // case-insensitive
  const { result } = scanWith({
    'issue verity:approved': [issue(10, '2026-06-01T00:00:00Z', nh)],
    'pr verity:approved': [issue(11, '2026-06-01T00:00:00Z', nh)],
    'pr verity:awaiting-review': [issue(20, '2026-06-01T00:00:00Z', nh)],
    'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z', nh)],
    'issue verity:request': [
      issue(40, '2026-06-01T00:00:00Z', { ...nh, author: { login: 'human' } }),
    ],
  });
  assertEqual(result, null, 'all candidates carry needs-human -> idle');
});

test('locked items are skipped via the injected isLocked predicate', () => {
  const seen = [];
  const { result } = scanWith(
    {
      'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z'), issue(31, '2026-06-02T00:00:00Z')],
    },
    {
      isLocked: (item) => {
        seen.push(item);
        return item.number === 30;
      },
    },
  );
  assertEqual(result.number, 31, 'locked oldest is skipped, next-oldest selected');
  assert(
    seen.every((i) => i.kind === 'issue' && typeof i.number === 'number' && i.tier === 'P3'),
    'predicate receives normalized items (kind/number/tier present)',
  );
});

test('default lock predicate filters nothing (T10 wires the real one)', () => {
  const { exec } = fakeGh({ 'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z')] });
  const result = scanner.scan({ exec, nextDecision: () => ({ action: 'idle' }) });
  assertEqual(result.number, 30);
});

test('whole tier locked -> falls through to the next tier', () => {
  const { result } = scanWith(
    {
      'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z')],
      'issue verity:request': [issue(40, '2026-06-01T00:00:00Z', { author: { login: 'h' } })],
    },
    { isLocked: (item) => item.number === 30, botLogin: 'verity-bot' },
  );
  assertEqual(result.tier, 'P4');
  assertEqual(result.number, 40);
});

test('P5: next decision action=work is trusted and returned with the decision attached', () => {
  const decision = {
    schema: 1,
    action: 'work',
    role: 'build',
    args: ['3'],
    gate: null,
    target: { kind: 'pr', number: 12 },
    reason: 'PR #12 open',
  };
  const { result } = scanWith({}, { nextDecision: () => decision });
  assertEqual(result.tier, 'P5');
  assertEqual(result.kind, 'pr');
  assertEqual(result.number, 12);
  assertEqual(result.decision, decision);
});

test('P5: gated decision yields nothing (ship gated -> no sweep)', () => {
  const decision = {
    action: 'gated',
    gate: 'review:merge',
    target: { kind: 'pr', number: 12 },
  };
  const { result } = scanWith({}, { nextDecision: () => decision });
  assertEqual(result, null);
});

test('P5: locked engine item is skipped (idle, not selected)', () => {
  const decision = { action: 'work', target: { kind: 'issue', number: 9 } };
  const { result } = scanWith(
    {},
    { nextDecision: () => decision, isLocked: (item) => item.tier === 'P5' },
  );
  assertEqual(result, null);
});

test('all tiers empty and next idle -> null (idle)', () => {
  const { result, calls } = scanWith({});
  assertEqual(result, null);
  assertEqual(calls.length, 5, 'all five §4.2 queries were attempted');
});

test('first non-empty tier wins: lower-tier queries are not even issued', () => {
  const { calls } = scanWith({ 'issue verity:approved': [issue(10, '2026-06-01T00:00:00Z')] });
  assertEqual(calls.length, 2, 'P1 issue+pr queries only; P2-P4 never run');
});

test('gh commands match the frozen §4.2 contract (createdAt/labels additions noted)', () => {
  const { calls } = scanWith({});
  assertEqual(
    calls.join('\n'),
    [
      'issue list --label verity:approved --state open --json number,labels,title,createdAt',
      'pr list --label verity:approved --state open --json number,labels,title,createdAt',
      'pr list --label verity:awaiting-review --state open --json number,headRefName,title,labels,createdAt',
      'issue list --label verity:ready --state open --json number,title,labels,createdAt',
      'issue list --label verity:request --state open --json number,title,author,labels,createdAt',
    ].join('\n'),
  );
});

test('FIFO tie-break: equal createdAt sorts by number; missing createdAt sorts last', () => {
  const t = '2026-06-01T00:00:00Z';
  const sorted = [
    { number: 5, createdAt: null },
    { number: 3, createdAt: t },
    { number: 2, createdAt: t },
  ].sort(scanner.byCreatedAt);
  assertEqual(sorted.map((i) => i.number).join(','), '2,3,5');
});

// --- P5 needs-human enforcement (#4, stage 5) ---------------------------------
// The dependency-engine fallback carries no labels, so scan() fetches the P5
// target's labels and drops escalated items — failing CLOSED on fetch errors.

// exec stub that answers list queries from fixtures (like fakeGh) AND `view`
// calls for the P5 label fetch. viewLabels: array of names, or 'THROW'.
function fakeGhWithView(fixtures, viewLabels) {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'view') {
      if (viewLabels === 'THROW') {
        // Same convention as tests/gh.test.cjs: a FAILING exec THROWS an
        // error object carrying status/stderr — so this exercises gh.run's
        // real error path (classify -> GhError), not an accidental parse error.
        const err = new Error('gh: boom');
        err.status = 1;
        err.stderr = 'boom';
        throw err;
      }
      return JSON.stringify({ labels: viewLabels.map((name) => ({ name })) });
    }
    const label = args[args.indexOf('--label') + 1];
    return JSON.stringify(fixtures[`${args[0]} ${label}`] || []);
  };
  return { exec, calls };
}

const workDecision = () => ({
  action: 'work',
  role: 'build',
  target: { kind: 'issue', number: 9 },
});

test('P5 regression (#4): target labeled verity:needs-human is dropped -> idle', () => {
  const { exec } = fakeGhWithView({}, ['verity:ready', 'verity:needs-human']);
  const result = scanner.scan({ exec, nextDecision: workDecision });
  assertEqual(result, null);
});

test('P5: fetched labels are carried on the returned item (no more hardcoded [])', () => {
  const { exec, calls } = fakeGhWithView({}, ['verity:ready']);
  const result = scanner.scan({ exec, nextDecision: workDecision });
  assertEqual(result.tier, 'P5');
  assertEqual(result.labels.join(','), 'verity:ready');
  assertEqual(
    calls.filter((c) => c.startsWith('issue view 9 --json labels')).length,
    1,
    'labels come from exactly one issue view call',
  );
});

test('P5: label fetch failure fails closed -> idle, no throw, with a warn', () => {
  const { exec } = fakeGhWithView({}, 'THROW');
  const warns = [];
  const result = scanner.scan({
    exec,
    nextDecision: workDecision,
    log: (line) => warns.push(line),
    retries: 0,
  });
  assertEqual(result, null);
  assertEqual(
    warns.some((w) => w.includes('P5 label fetch failed for issue #9')),
    true,
    'fail-closed is never silent',
  );
});

test('P5: stage-kind target skips the label fetch entirely (stage number is not an issue number)', () => {
  const { exec, calls } = fakeGhWithView({}, 'THROW'); // any view call would throw
  const decision = { action: 'work', role: 'build', target: { kind: 'stage', number: 3 } };
  const result = scanner.scan({ exec, nextDecision: () => decision });
  assertEqual(result.tier, 'P5');
  assertEqual(result.labels.join(','), '');
  assertEqual(
    calls.some((c) => c.split(' ')[1] === 'view'),
    false,
    'no gh view call for stage targets',
  );
});

test('P5: pr target uses pr view for the label fetch', () => {
  const { exec, calls } = fakeGhWithView({}, []);
  const decision = { action: 'work', role: 'review', target: { kind: 'pr', number: 4 } };
  const result = scanner.scan({ exec, nextDecision: () => decision });
  assertEqual(result.tier, 'P5');
  assertEqual(
    calls.some((c) => c.startsWith('pr view 4 --json labels')),
    true,
  );
});
