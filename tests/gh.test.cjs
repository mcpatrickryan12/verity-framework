// T07 — shared gh layer (SKETCH §8.3 retry policy).
//
// `gh` is a stateful PATH stub (the tests/labels.test.cjs pattern): it counts
// invocations on disk and fails the first GH_STUB_FAILS calls with GH_STUB_ERR
// on stderr, so the tests can assert exactly how many attempts the layer made.
// Backoff never sleeps for real: tests inject `sleep` (a recorder) and `random`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gh = require('../verity/bin/lib/gh.cjs');

const STUB_BODY = `const fs = require('node:fs');
fs.appendFileSync(process.env.GH_STUB_LOG, process.argv.slice(2).join(' ') + '\\n');
const n = Number(fs.readFileSync(process.env.GH_STUB_COUNT, 'utf8'));
fs.writeFileSync(process.env.GH_STUB_COUNT, String(n + 1));
if (n < Number(process.env.GH_STUB_FAILS || 0)) {
  console.error(process.env.GH_STUB_ERR || 'HTTP 502: Server Error');
  process.exit(1);
}
console.log(process.env.GH_STUB_OUT || 'ok');
`;

// Puts the stub first on PATH for the duration of fn, then restores the env.
// `fails` = how many leading invocations fail; `err` = their stderr line.
function withStubGh({ fails = 0, err, out }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-gh-'));
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\n${STUB_BODY}`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const count = path.join(dir, 'count');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(count, '0');
  fs.writeFileSync(log, '');
  const saved = {};
  const vars = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_STUB_COUNT: count,
    GH_STUB_LOG: log,
    GH_STUB_FAILS: String(fails),
    GH_STUB_ERR: err,
    GH_STUB_OUT: out,
  };
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn({
      dir,
      calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

const noSleep = () => {
  const slept = [];
  const sleep = (ms) => slept.push(ms);
  return { slept, sleep };
};

test('happy path: returns stdout, exactly one gh invocation', () => {
  withStubGh({ out: 'hello' }, (s) => {
    const { sleep } = noSleep();
    const result = gh.run(['pr', 'list'], { sleep });
    assertEqual(result.trim(), 'hello');
    assertEqual(s.calls().length, 1);
    assertEqual(s.calls()[0], 'pr list');
  });
});

test('retry-on-5xx: succeeds after transient failures, with backoff between tries', () => {
  withStubGh({ fails: 2, err: 'HTTP 502: Bad Gateway', out: '{"n":7}' }, (s) => {
    const { slept, sleep } = noSleep();
    const result = gh.json(['issue', 'view', '7'], { sleep, random: () => 0.5 });
    assertEqual(result.n, 7);
    assertEqual(s.calls().length, 3, 'two 502s then success = 3 invocations');
    assertEqual(slept.length, 2, 'one backoff per retry');
  });
});

test('persistent 5xx: 3 retries (4 attempts) then GhError with transient metadata', () => {
  withStubGh({ fails: 99, err: 'HTTP 503: Service Unavailable' }, (s) => {
    const { slept, sleep } = noSleep();
    let thrown;
    try {
      gh.run(['pr', 'view', '1'], { sleep, random: () => 0.5 });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof gh.GhError, 'throws GhError');
    assertEqual(s.calls().length, 4, '1 attempt + 3 retries, never more');
    assertEqual(slept.length, 3);
    assertEqual(thrown.attempts, 4);
    assertEqual(thrown.transient, true);
    assertEqual(thrown.reason, 'http-5xx');
    assertEqual(thrown.message, 'HTTP 503: Service Unavailable');
  });
});

test('no-retry-on-4xx: fails fast after exactly one invocation, no sleep', () => {
  withStubGh({ fails: 99, err: 'HTTP 404: Not Found (https://api.github.com/...)' }, (s) => {
    const { slept, sleep } = noSleep();
    let thrown;
    try {
      gh.run(['label', 'create', 'x'], { sleep });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof gh.GhError);
    assertEqual(s.calls().length, 1, '4xx is never retried');
    assertEqual(slept.length, 0, 'no backoff on fail-fast');
    assertEqual(thrown.transient, false);
    assertEqual(thrown.reason, 'http-404');
    assertEqual(thrown.attempts, 1);
  });
});

test('secondary rate limit is transient and retried', () => {
  const msg = 'You have exceeded a secondary rate limit. Please wait a few minutes.';
  withStubGh({ fails: 1, err: msg, out: 'fine' }, (s) => {
    const { slept, sleep } = noSleep();
    const result = gh.run(['issue', 'list'], { sleep, random: () => 0.5 });
    assertEqual(result.trim(), 'fine');
    assertEqual(s.calls().length, 2);
    assertEqual(slept.length, 1);
  });
});

test('non-HTTP errors (gh missing, no repo, auth) fail fast', () => {
  withStubGh({ fails: 99, err: 'failed to run git: not a git repository' }, (s) => {
    let thrown;
    try {
      gh.run(['label', 'list'], { sleep: () => {} });
    } catch (e) {
      thrown = e;
    }
    assertEqual(s.calls().length, 1);
    assertEqual(thrown.transient, false);
    assertEqual(thrown.reason, 'error');
  });
});

test('backoff is exponential and jittered (injectable random, never sleeps here)', () => {
  // Jitter factor is [0.5, 1.5) over a 500ms-doubling base.
  assertEqual(
    gh.backoffMs(1, () => 0),
    250,
  );
  assertEqual(
    gh.backoffMs(1, () => 0.5),
    500,
  );
  assertEqual(
    gh.backoffMs(2, () => 0.5),
    1000,
  );
  assertEqual(
    gh.backoffMs(3, () => 0.5),
    2000,
  );
  assert(
    gh.backoffMs(1, () => 0.1) !== gh.backoffMs(1, () => 0.9),
    'different random draws give different delays',
  );
  for (let i = 0; i < 50; i++) {
    const ms = gh.backoffMs(2, Math.random);
    assert(ms >= 500 && ms < 1500, `retry-2 backoff in [500,1500): ${ms}`);
  }
});

test('run() sleeps exactly backoffMs(attempt) between retries', () => {
  withStubGh({ fails: 3, err: 'HTTP 500: oops', out: 'ok' }, () => {
    const { slept, sleep } = noSleep();
    gh.run(['api', 'x'], { sleep, random: () => 0.5 });
    assertEqual(slept.join(','), '500,1000,2000', 'doubling schedule at jitter midpoint');
  });
});

test('uniform logging: one greppable verity:gh line per attempt, ok/retry/fail statuses', () => {
  withStubGh({ fails: 1, err: 'HTTP 502: x', out: 'y' }, () => {
    const lines = [];
    gh.run(['pr', 'checks', '9'], {
      sleep: () => {},
      random: () => 0.5,
      log: (l) => lines.push(l),
    });
    assertEqual(lines.length, 2);
    assert(
      lines.every((l) => l.startsWith('verity:gh status=')),
      'consistent greppable prefix',
    );
    assert(/^verity:gh status=retry attempt=1\/4 exit=1 ms=\d+ reason=http-5xx /.test(lines[0]));
    assert(/^verity:gh status=ok attempt=2\/4 exit=0 ms=\d+ reason=- /.test(lines[1]));
    assert(lines[1].endsWith('cmd="gh pr checks 9"'));
  });
});

test('classify: 5xx and secondary-rate-limit are transient; 4xx and unknown are not', () => {
  assertEqual(gh.classify({ stderr: 'HTTP 500: boom' }).transient, true);
  assertEqual(gh.classify({ stderr: 'HTTP 599: edge' }).transient, true);
  assertEqual(gh.classify({ stderr: 'HTTP 403: Forbidden' }).transient, false);
  assertEqual(gh.classify({ stderr: 'HTTP 422: Validation Failed' }).transient, false);
  assertEqual(gh.classify({ message: 'was submitted too quickly' }).transient, true);
  assertEqual(gh.classify({ stderr: '' }).transient, false);
  assertEqual(gh.classify(undefined).transient, false);
});

test('json() surfaces GhError from the underlying call (no retry on 4xx)', () => {
  withStubGh({ fails: 99, err: 'HTTP 401: Bad credentials' }, (s) => {
    let thrown;
    try {
      gh.json(['api', 'user'], { sleep: () => {} });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof gh.GhError);
    assertEqual(thrown.reason, 'http-401');
    assertEqual(s.calls().length, 1);
  });
});

// --- Stage 52 (#135): isRepoSlug — the repo-as-endpoint validator ------------
//
// A repo string is interpolated straight into the `gh api` PATH by
// operator-act.cjs and worker/index.cjs, and `gh api` truncates the endpoint at
// `?`/`#`. This predicate is the ONE shared shape check: GitHub's owner/name
// charset exactly ([A-Za-z0-9._-]), one slash, no empty side.
test('isRepoSlug accepts exactly GitHub owner/name and nothing else', () => {
  for (const good of ['acme/widget', 'octo-org/my_repo.js', 'a/b', 'Acme.Corp/Widget-2', '_x/-y']) {
    assertEqual(gh.isRepoSlug(good), true, `accepts ${JSON.stringify(good)}`);
  }
  for (const bad of [
    'acme/widget?',
    'acme/widget#',
    'acme/widget#frag',
    'acme/widget/branches/main/protection?',
    'acme/widget/extra',
    'acme/widget with space',
    'acme/ widget',
    'owner',
    '',
    '   ',
    '/widget',
    'acme/',
    '../../x',
    'acme/widget\n',
    'https://github.com/acme/widget',
    null,
    undefined,
    42,
    { toString: () => 'acme/widget' },
  ]) {
    assertEqual(gh.isRepoSlug(bad), false, `refuses ${JSON.stringify(bad)}`);
  }
});
