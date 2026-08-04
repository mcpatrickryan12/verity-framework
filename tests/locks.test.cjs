// T09 — lock protocol (SKETCH §4.3 acquire/release/reclaim, §8 invariants).
//
// gh is stubbed at the gh.cjs `exec` seam (the ledger.test.cjs pattern — no
// subprocess, no network): fakeRepo() is an in-memory GitHub item that answers
// the exact `gh api repos/.../issues/<n>/...` calls locks.cjs makes and mutates
// its own labels/comments, so multi-step protocols (double-start, crash +
// finally release) run against evolving state. The clock is injected via
// opts.now, so freshness/staleness is deterministic.
const locks = require('../verity/bin/lib/locks.cjs');

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const FUTURE = new Date(NOW + 60 * 60_000).toISOString();
const PAST = new Date(NOW - 60 * 60_000).toISOString();

// In-memory GitHub item behind gh.cjs's injectable exec.
function fakeRepo({ labels = [], comments = [] } = {}) {
  const state = {
    labels: new Set(labels),
    comments: comments.map((body) => ({ body })),
    calls: [],
  };
  const exec = (args) => {
    state.calls.push(args.join(' '));
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
    const path = args.find((a) => a.startsWith('repos/'));
    if (method === 'GET' && path.includes('/comments?')) {
      return JSON.stringify(state.comments);
    }
    if (method === 'GET') {
      return JSON.stringify({
        number: 7,
        labels: [...state.labels].map((name) => ({ name })),
      });
    }
    if (method === 'POST' && path.endsWith('/labels')) {
      state.labels.add(args[args.length - 1].replace('labels[]=', ''));
      return '{}';
    }
    if (method === 'POST' && path.endsWith('/comments')) {
      state.comments.push({ body: args[args.length - 1].replace(/^body=/, '') });
      return '{}';
    }
    if (method === 'DELETE' && path.includes('/labels/')) {
      const label = decodeURIComponent(path.split('/labels/')[1]);
      if (!state.labels.has(label)) {
        const err = new Error('gh: Label does not exist');
        err.status = 1;
        err.stderr = 'HTTP 404: Not Found';
        throw err;
      }
      state.labels.delete(label);
      return '[]';
    }
    throw new Error(`fakeRepo: unexpected gh call: gh ${args.join(' ')}`);
  };
  return { state, exec };
}

const lastComment = (state) => state.comments[state.comments.length - 1]?.body;

test('acquire on an unlocked item: adds label, posts lock comment with 1.5x ttl expiry', () => {
  const { state, exec } = fakeRepo();
  const res = locks.acquire({ number: 7 }, { runId: 'run-a', ttlMinutes: 40, now: NOW, exec });
  assertEqual(res.acquired, true);
  assertEqual(res.reclaimed, null);
  // 40 min * 1.5 = 60 min headroom (SKETCH §4.3: now + max_wall_clock*1.5)
  assertEqual(res.expires, new Date(NOW + 60 * 60_000).toISOString());
  assert(state.labels.has('verity:in-progress'), 'lock label added');
  assertEqual(lastComment(state), `lock:run-a expires:${res.expires}`);
});

test('acquire aborts on fresh lock: {acquired:false, reason:fresh-lock}, nothing mutated', () => {
  const { state, exec } = fakeRepo({
    labels: ['verity:in-progress'],
    comments: [`lock:run-other expires:${FUTURE}`],
  });
  const before = state.comments.length;
  const res = locks.acquire({ number: 7 }, { runId: 'run-b', ttlMinutes: 40, now: NOW, exec });
  assertEqual(res.acquired, false);
  assertEqual(res.reason, 'fresh-lock');
  assertEqual(res.holder.runId, 'run-other');
  assertEqual(res.holder.expires, FUTURE);
  assertEqual(state.comments.length, before, 'no comment posted on abort');
  assert(state.labels.has('verity:in-progress'), 'holder label untouched');
});

test('stale lock (expires < now) is reclaimed and noted in the new lock comment', () => {
  const { state, exec } = fakeRepo({
    labels: ['verity:in-progress'],
    comments: [`lock:run-old expires:${PAST}`],
  });
  const res = locks.acquire({ number: 7 }, { runId: 'run-new', ttlMinutes: 40, now: NOW, exec });
  assertEqual(res.acquired, true);
  assertEqual(res.reclaimed.runId, 'run-old');
  assertEqual(res.reclaimed.expires, PAST);
  assertEqual(lastComment(state), `lock:run-new expires:${res.expires} reclaimed:run-old`);
});

test('lock label with NO lock comment is reclaimable (never deadlocks): reclaimed:unknown', () => {
  const { state, exec } = fakeRepo({ labels: ['verity:in-progress'] });
  const res = locks.acquire({ number: 7 }, { runId: 'run-x', ttlMinutes: 10, now: NOW, exec });
  assertEqual(res.acquired, true);
  assertEqual(res.reclaimed.runId, 'unknown');
  assertEqual(lastComment(state), `lock:run-x expires:${res.expires} reclaimed:unknown`);
});

test('double-start: second acquire sees the first lock and returns acquired:false (caller exits 0 "locked")', () => {
  const { state, exec } = fakeRepo();
  const first = locks.acquire({ number: 7 }, { runId: 'run-1', ttlMinutes: 45, now: NOW, exec });
  assertEqual(first.acquired, true);
  const second = locks.acquire(
    { number: 7 },
    { runId: 'run-2', ttlMinutes: 45, now: NOW + 60_000, exec },
  );
  assertEqual(second.acquired, false);
  assertEqual(second.reason, 'fresh-lock');
  assertEqual(second.holder.runId, 'run-1');
  // first holder's lock comment is still the LAST event — nothing clobbered
  assertEqual(lastComment(state), `lock:run-1 expires:${first.expires}`);
});

test('release removes the label and posts the exact unlock comment', () => {
  const { state, exec } = fakeRepo({
    labels: ['verity:in-progress'],
    comments: [`lock:run-1 expires:${FUTURE}`],
  });
  const res = locks.release({ number: 7 }, { runId: 'run-1', outcome: 'success', exec });
  assertEqual(res.released, true);
  assert(!state.labels.has('verity:in-progress'), 'lock label removed');
  assertEqual(lastComment(state), 'unlock:run-1 outcome:success');
  assertEqual(
    locks.isFreshlyLocked({ number: 7 }, { now: NOW, comments: state.comments }),
    false,
    'item is free after release',
  );
});

test('simulated crash: thrown error mid-run still releases via finally', () => {
  const { state, exec } = fakeRepo();
  let crashed = false;
  try {
    // The T10 run-loop shape: acquire, work (throws), release in finally.
    try {
      const got = locks.acquire({ number: 7 }, { runId: 'run-c', ttlMinutes: 30, now: NOW, exec });
      assertEqual(got.acquired, true);
      throw new Error('boom: agent crashed mid-run');
    } finally {
      locks.release({ number: 7 }, { runId: 'run-c', outcome: 'infra', exec });
    }
  } catch (err) {
    crashed = /boom/.test(err.message);
  }
  assert(crashed, 'the original crash propagates (release does not mask it)');
  assert(!state.labels.has('verity:in-progress'), 'label removed despite crash');
  assertEqual(lastComment(state), 'unlock:run-c outcome:infra');
  assertEqual(locks.isFreshlyLocked({ number: 7 }, { now: NOW, exec }), false);
});

test('release is idempotent when the label is already absent (partial acquire / repeat call)', () => {
  const { state, exec } = fakeRepo(); // no label, no comments
  const res = locks.release({ number: 7 }, { runId: 'run-p', outcome: 'failed', exec });
  assertEqual(res.released, true, 'HTTP 404 on label delete is swallowed as success');
  assertEqual(lastComment(state), 'unlock:run-p outcome:failed');
});

test('release never throws out of a finally: gh hard-down -> {released:false, errors}, one log line', () => {
  const downExec = () => {
    const err = new Error('gh: connection refused');
    err.status = 1;
    err.stderr = 'connection refused';
    throw err;
  };
  const logged = [];
  let result;
  try {
    try {
      throw new Error('boom');
    } finally {
      result = locks.release(
        { number: 7 },
        { runId: 'run-d', outcome: 'infra', exec: downExec, log: (l) => logged.push(l) },
      );
    }
  } catch (err) {
    assert(/boom/.test(err.message), 'only the original error escapes the finally');
  }
  assertEqual(result.released, false);
  assertEqual(result.errors.length, 2, 'both label removal and unlock comment reported');
  // the injected log also receives gh.cjs per-attempt lines; exactly ONE is ours
  const mine = logged.filter((l) => l.startsWith('verity:locks '));
  assertEqual(mine.length, 1);
  assert(/verity:locks status=release-error .*run=run-d/.test(mine[0]), `log line: ${mine[0]}`);
});

test('isFreshlyLocked: fresh lock -> true; expired -> false; lock then unlock -> false; none -> false', () => {
  const fresh = [{ body: `lock:r1 expires:${FUTURE}` }];
  const expired = [{ body: `lock:r1 expires:${PAST}` }];
  const unlocked = [{ body: `lock:r1 expires:${FUTURE}` }, { body: 'unlock:r1 outcome:success' }];
  assertEqual(locks.isFreshlyLocked(7, { now: NOW, comments: fresh }), true);
  assertEqual(locks.isFreshlyLocked(7, { now: NOW, comments: expired }), false);
  assertEqual(locks.isFreshlyLocked(7, { now: NOW, comments: unlocked }), false);
  assertEqual(locks.isFreshlyLocked(7, { now: NOW, comments: [] }), false);
});

test('isFreshlyLocked: LAST lock event wins over an earlier unlock; malformed expires is stale', () => {
  const relocked = [
    { body: `lock:r1 expires:${PAST}` },
    { body: 'unlock:r1 outcome:failed' },
    { body: `lock:r2 expires:${FUTURE}` },
  ];
  assertEqual(locks.isFreshlyLocked(7, { now: NOW, comments: relocked }), true);
  const malformed = [{ body: 'lock:r9 expires:not-a-date' }];
  assertEqual(
    locks.isFreshlyLocked(7, { now: NOW, comments: malformed }),
    false,
    'unparseable expires must be reclaimable, never a deadlock',
  );
});

test('isFreshlyLocked fetches comments via gh when not pre-fetched', () => {
  const { exec } = fakeRepo({ comments: [`lock:r1 expires:${FUTURE}`] });
  assertEqual(locks.isFreshlyLocked({ number: 7 }, { now: NOW, exec }), true);
});

test('countFailures counts only unlock outcome:failed* comments', () => {
  const comments = [
    { body: `lock:r1 expires:${PAST}` },
    { body: 'unlock:r1 outcome:failed' }, // counts
    { body: `lock:r2 expires:${PAST}` },
    { body: 'unlock:r2 outcome:failed_once' }, // counts (failed*)
    { body: 'unlock:r3 outcome:success' },
    { body: 'unlock:r4 outcome:gated' },
    { body: 'unlock:r5 outcome:infra' },
    { body: 'run summary: roles=build unlock:r1 outcome:failed tokens=1' }, // mid-text, not anchored
    { body: 'just a human comment mentioning outcome:failed' },
  ];
  assertEqual(locks.countFailures(7, { comments }), 2);
  const { exec } = fakeRepo({ comments: comments.map((c) => c.body) });
  assertEqual(locks.countFailures({ number: 7 }, { exec }), 2, 'same count via gh fetch');
});

test('parseLockEvent: exact comment grammar; non-lock bodies -> null', () => {
  assertEqual(locks.lockCommentBody('r1', FUTURE), `lock:r1 expires:${FUTURE}`);
  assertEqual(locks.lockCommentBody('r2', FUTURE, 'r1'), `lock:r2 expires:${FUTURE} reclaimed:r1`);
  assertEqual(locks.unlockCommentBody('r1', 'failed_once'), 'unlock:r1 outcome:failed_once');

  const lock = locks.parseLockEvent(`lock:r2 expires:${FUTURE} reclaimed:r1`);
  assertEqual(lock.kind, 'lock');
  assertEqual(lock.runId, 'r2');
  assertEqual(lock.expires, FUTURE);
  assertEqual(lock.reclaimed, 'r1');
  const unlock = locks.parseLockEvent('unlock:r2 outcome:limit_hit');
  assertEqual(unlock.kind, 'unlock');
  assertEqual(unlock.outcome, 'limit_hit');
  assertEqual(locks.parseLockEvent('> lock:r1 quoted by a human'), null);
  assertEqual(locks.parseLockEvent('see the lock:r1 comment above'), null);
  assertEqual(locks.parseLockEvent(''), null);
  assertEqual(locks.parseLockEvent(undefined), null);
});

test('acquire validates runId and ttlMinutes', () => {
  const { exec } = fakeRepo();
  for (const bad of [{}, { runId: '' }, { runId: 'has space', ttlMinutes: 5 }]) {
    let threw = false;
    try {
      locks.acquire(7, { ttlMinutes: 5, ...bad, exec });
    } catch (err) {
      threw = err instanceof TypeError;
    }
    assert(threw, `TypeError for ${JSON.stringify(bad)}`);
  }
  let threw = false;
  try {
    locks.acquire(7, { runId: 'r1', ttlMinutes: 0, exec });
  } catch (err) {
    threw = err instanceof TypeError;
  }
  assert(threw, 'TypeError for ttlMinutes 0');
});
