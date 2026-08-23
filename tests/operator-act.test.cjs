// Stage 50 — the operator-act contract (contracts/operator-act.md, frozen v1).
// `verity operator act <verb>` is the operator seam's ONLY write surface. These
// tests drive act()/dispatch() with an INJECTED fake `gh.run` (records every
// argv; returns/throws per scenario) and an INJECTED fake worker spawn, so they
// perform ZERO real network/process, and prove every safety invariant:
//   - each verb issues EXACTLY the documented gh api argv (method+endpoint+label);
//     reject's three ops in effect-order; request-changes posts a comment;
//   - NO MERGE: across ALL verbs the recorded argvs NEVER contain a `merge` token,
//     and approve's reason states it is not a merge;
//   - idempotency: a simulated already-present(POST 200) / already-absent(DELETE
//     404) ⇒ ok:true;
//   - fail-closed: a simulated real gh error ⇒ ok:false + reason + non-zero exit;
//   - input validation: missing / flag-shaped / non-numeric target ⇒ refused
//     BEFORE any gh.run call (the fake gh is never invoked);
//   - unknown verb ⇒ an allowlist error;
//   - redaction: a token-shaped string in a --note / error never survives (the
//     token is assembled from RUNTIME fragments, never a literal in source).
const operatorAct = require('../verity/bin/lib/operator-act.cjs');

const REPO = 'acme/widget';

// A recording fake `gh.run`. `behavior(argv)` may return a string (success) or
// throw — default is success. Every argv it receives is captured in `.calls`.
function fakeGh(behavior) {
  const calls = [];
  const run = (argv, opts) => {
    calls.push({ argv, opts });
    const b = behavior ? behavior(argv, calls.length) : undefined;
    if (b instanceof Error) {
      throw b;
    }
    return typeof b === 'string' ? b : '';
  };
  return { run, calls };
}

// A GhError-shaped error (gh.cjs encodes the HTTP status in `.reason`).
function ghError(reason, message) {
  const err = new Error(message || `gh failed (${reason})`);
  err.name = 'GhError';
  err.reason = reason;
  return err;
}

// Assemble a token from RUNTIME fragments — NEVER a literal ghp_ + alnum in
// source (the promotion secret-scan smoke test flags a literal — it cost stage
// 47 a CI run).
function fakeToken() {
  return `ghp_${'A'.repeat(20)}`;
}

// Run a dispatch with an injected fake gh; returns { result, calls }.
function dispatchWith(args, flags, behavior, extra = {}) {
  const gh = fakeGh(behavior);
  const result = operatorAct.dispatch(args, { repo: REPO, ...flags }, { run: gh.run, ...extra });
  return { result, calls: gh.calls };
}

function argvOf(call) {
  return call.argv.join(' ');
}

test('approve → POST verity:approved; reason states it is NOT a merge', () => {
  const { result, calls } = dispatchWith(['approve', '42'], {});
  assertEqual(result.ok, true, 'approve ok');
  assertEqual(result.action, 'approve', 'action');
  assertEqual(result.target, 42, 'target parsed to int');
  assertEqual(result.effect.kind, 'label-add', 'effect kind');
  assertEqual(result.effect.label, 'verity:approved', 'effect label');
  assertEqual(calls.length, 1, 'exactly one gh call');
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/42/labels -f labels[]=verity:approved',
    'exact approve argv',
  );
  assert(/not a merge/i.test(result.reason), 'approve reason states it is not a merge');
});

test('reject → DELETE approved, DELETE awaiting, POST needs-human in order', () => {
  const { result, calls } = dispatchWith(['reject', '7'], {});
  assertEqual(result.ok, true, 'reject ok');
  assertEqual(calls.length, 3, 'three ops');
  assertEqual(
    argvOf(calls[0]),
    'api -X DELETE repos/acme/widget/issues/7/labels/verity%3Aapproved',
    'op1 removes approved',
  );
  assertEqual(
    argvOf(calls[1]),
    'api -X DELETE repos/acme/widget/issues/7/labels/verity%3Aawaiting-approval',
    'op2 removes awaiting-approval',
  );
  assertEqual(
    argvOf(calls[2]),
    'api -X POST repos/acme/widget/issues/7/labels -f labels[]=verity:needs-human',
    'op3 adds needs-human',
  );
  assertEqual(result.effects.length, 3, 'three effects in order');
  assertEqual(result.effects[0].kind, 'label-remove', 'effect1 remove');
  assertEqual(result.effects[2].kind, 'label-add', 'effect3 add');
});

test('request-changes → POST needs-human + a comment carrying the note', () => {
  const { result, calls } = dispatchWith(['request-changes', '9'], {
    note: 'please fix the tests',
  });
  assertEqual(result.ok, true, 'ok');
  assertEqual(calls.length, 2, 'two ops');
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/9/labels -f labels[]=verity:needs-human',
    'op1 adds needs-human',
  );
  assertEqual(
    argvOf(calls[1]),
    'api -X POST repos/acme/widget/issues/9/comments -f body=please fix the tests',
    'op2 posts the comment',
  );
  assertEqual(result.effects[1].kind, 'comment', 'second effect is a comment');
});

test('request-changes with no --note posts a default rework note', () => {
  const { calls } = dispatchWith(['request-changes', '9'], {});
  assertEqual(calls.length, 2, 'two ops');
  assert(/comments -f body=/.test(argvOf(calls[1])), 'a comment is still posted');
  assert(
    argvOf(calls[1]).length > 'api -X POST repos/acme/widget/issues/9/comments -f body='.length,
    'default note is non-empty',
  );
});

test('needs-human → POST needs-human', () => {
  const { result, calls } = dispatchWith(['needs-human', '3'], {});
  assertEqual(result.ok, true, 'ok');
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/3/labels -f labels[]=verity:needs-human',
    'exact argv',
  );
});

test('clear-needs-human → DELETE needs-human', () => {
  const { result, calls } = dispatchWith(['clear-needs-human', '3'], {});
  assertEqual(result.ok, true, 'ok');
  assertEqual(
    argvOf(calls[0]),
    'api -X DELETE repos/acme/widget/issues/3/labels/verity%3Aneeds-human',
    'exact argv',
  );
});

test('circuit open → POST circuit-open; circuit close → DELETE circuit-open', () => {
  // Stage 52: `circuit open` first READS its target to prove it is an open
  // issue (the breaker query cannot see PRs or closed issues), so the fake must
  // now feed that precondition read. Only the fixture changed — the argv
  // assertion below is the same one, on the same label POST.
  const open = dispatchWith(['circuit', 'open', '12'], {}, openIssueRead);
  assertEqual(open.result.ok, true, 'open ok');
  assertEqual(open.result.action, 'circuit open', 'action');
  assertEqual(open.calls.length, 2, 'precondition read + the label POST');
  assertEqual(
    argvOf(open.calls[1]),
    'api -X POST repos/acme/widget/issues/12/labels -f labels[]=verity:circuit-open',
    'open argv',
  );
  const close = dispatchWith(['circuit', 'close', '12'], {});
  assertEqual(close.result.ok, true, 'close ok');
  assertEqual(
    argvOf(close.calls[0]),
    'api -X DELETE repos/acme/widget/issues/12/labels/verity%3Acircuit-open',
    'close argv',
  );
});

test('circuit without open|close is refused before any gh call', () => {
  const { result, calls } = dispatchWith(['circuit', '12'], {});
  assertEqual(result.ok, false, 'refused');
  assertEqual(calls.length, 0, 'no gh call');
});

test('run-once relays the worker outcome, never a merge claim', () => {
  const spawns = [];
  const spawn = (cmd, cmdArgs) => {
    spawns.push({ cmd, cmdArgs });
    return { status: 0, stdout: 'worker: one tick, no work', stderr: '' };
  };
  const result = operatorAct.dispatch(['run-once'], { repo: REPO }, { spawn });
  assertEqual(result.ok, true, 'ok on exit 0');
  assertEqual(result.action, 'run-once', 'action');
  assertEqual(result.target, null, 'no target');
  assertEqual(result.effect.kind, 'worker-tick', 'worker-tick effect');
  assertEqual(result.effect.exitCode, 0, 'relays exit code');
  assertEqual(spawns.length, 1, 'spawned once');
  assertEqual(spawns[0].cmd, 'verity-worker', 'spawns the worker binary');
  assertEqual(spawns[0].cmdArgs.join(' '), `--repo ${REPO} --once`, 'worker argv');
});

test('run-once fails closed on a non-zero worker exit', () => {
  const spawn = () => ({ status: 20, stdout: '', stderr: 'boom' });
  const result = operatorAct.dispatch(['run-once'], { repo: REPO }, { spawn });
  assertEqual(result.ok, false, 'ok:false on non-zero exit');
  assertEqual(result.effect.exitCode, 20, 'relays exit code');
});

// --- Invariant 1: NO MERGE AUTHORITY, EVER --------------------------------
test('NO verb ever issues a `merge` argv (spied across every verb)', () => {
  const invocations = [
    ['approve', '1'],
    ['reject', '1'],
    ['request-changes', '1'],
    ['needs-human', '1'],
    ['clear-needs-human', '1'],
    ['circuit', 'open', '1'],
    ['circuit', 'close', '1'],
  ];
  for (const args of invocations) {
    // openIssueRead feeds `circuit open`'s precondition read (stage 52) so this
    // spy still sees that verb's real label POST, not a refusal.
    const { calls } = dispatchWith(args, { note: 'x' }, openIssueRead);
    for (const call of calls) {
      for (const tok of call.argv) {
        assert(
          !/merge/i.test(String(tok)),
          `verb ${args[0]} must never issue a merge argv (${tok})`,
        );
      }
    }
  }
});

// --- Invariant 4: IDEMPOTENT ----------------------------------------------
test('idempotent: DELETE of an already-absent label (gh 404) ⇒ ok:true', () => {
  const behavior = () => ghError('http-404', 'HTTP 404: Label does not exist');
  const { result, calls } = dispatchWith(['clear-needs-human', '5'], {}, behavior);
  assertEqual(result.ok, true, 'already-absent delete is idempotent ok');
  assertEqual(calls.length, 1, 'the op was attempted');
});

test('idempotent: POST of an already-present label (gh 200 no-op) ⇒ ok:true', () => {
  // GitHub returns 200 (no throw) when adding a present label.
  const behavior = () => 'ok';
  const { result } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, true, 'already-present add is ok');
});

// --- Invariant 3: FAIL-CLOSED ---------------------------------------------
test('fail-closed: a real gh error ⇒ ok:false + reason + non-zero exit map', () => {
  const behavior = () => ghError('http-403', 'HTTP 403: Resource not accessible');
  const { result, calls } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, false, 'real error fails closed');
  assert(typeof result.reason === 'string' && result.reason.length > 0, 'has a reason');
  assertEqual(calls.length, 1, 'the op was attempted');
  // verity.cjs maps ok:false → non-zero exit; assert the mapping the CLI uses.
  const exit = result.ok ? 0 : 1;
  assert(exit !== 0, 'a failed act maps to a non-zero exit');
});

test('fail-closed: a 404 on a POST (add) is NOT swallowed — it fails closed', () => {
  // 404 is only idempotent for a DELETE (already-absent). A 404 on an add is a
  // real error (e.g. issue not found) and must fail closed.
  const behavior = () => ghError('http-404', 'HTTP 404: Not Found');
  const { result } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, false, 'add 404 is not idempotent-swallowed');
});

// --- Invariant 5: INPUT-VALIDATED -----------------------------------------
test('missing / flag-shaped / non-numeric target ⇒ refused before any gh call', () => {
  for (const args of [
    ['approve'],
    ['approve', '--'],
    ['approve', 'abc'],
    ['approve', '0'],
    ['approve', '-3'],
  ]) {
    const { result, calls } = dispatchWith(args, {});
    assertEqual(result.ok, false, `refused: ${JSON.stringify(args)}`);
    assertEqual(result.effect, null, 'no effect performed');
    assertEqual(calls.length, 0, `gh.run NEVER called for ${JSON.stringify(args)}`);
  }
});

test('missing repo ⇒ refused before any gh call (fail closed)', () => {
  const gh = fakeGh();
  // repo explicitly null via opts overrides GH_REPO too.
  const result = operatorAct.dispatch(['approve', '5'], {}, { run: gh.run, repo: null });
  assertEqual(result.ok, false, 'no repo ⇒ ok:false');
  assertEqual(gh.calls.length, 0, 'gh.run never called');
});

// --- Invariant 2: ALLOWLIST ONLY ------------------------------------------
test('unknown verb ⇒ an allowlist error naming the valid verbs', () => {
  const gh = fakeGh();
  let threw = null;
  try {
    operatorAct.dispatch(['bogus-verb', '1'], { repo: REPO }, { run: gh.run });
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'unknown verb throws');
  assert(/unknown operator act verb/i.test(threw.message), 'message names it as unknown');
  assert(/approve/.test(threw.message), 'message lists valid verbs');
  assertEqual(gh.calls.length, 0, 'no gh call for an unknown verb');
});

// --- Redaction (invariant 4 of the contract: no credential shape survives) --
test('a token-shaped string in a --note never survives into the result', () => {
  const token = fakeToken();
  const { result } = dispatchWith(['request-changes', '9'], {
    note: `secret is ${token} do not leak`,
  });
  const json = JSON.stringify(result);
  assert(!json.includes(token), 'the token must not survive redaction in the result');
  assert(json.includes('[redacted]'), 'the token was redacted');
});

test('a token-shaped string in a gh error never survives into the reason', () => {
  const token = fakeToken();
  const behavior = () => ghError('http-401', `HTTP 401 for token ${token}`);
  const { result } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, false, 'fails closed');
  assert(!JSON.stringify(result).includes(token), 'token redacted out of the reason');
});

// --- Stage 52 (#135): the repo field is an ENDPOINT, so it must be validated --
//
// `apiBase` interpolates the resolved repo straight into the `gh api` PATH, and
// `gh api` truncates the endpoint at `?` / `#` — everything after is a query
// string / fragment. So a hostile `--repo`/`GH_REPO` retargets the label
// POST/DELETE at an ARBITRARY endpoint (e.g. DELETE
// /repos/{o}/{r}/branches/main/protection) while the envelope still reports a
// label op with ok:true. The existing "NO MERGE spy" greps argv tokens for the
// literal `merge` — a branch-protection DELETE contains no such token and sails
// straight past it. These assertions are therefore on the RESOLVED ENDPOINT:
// the path GitHub actually routes, after the ?/# truncation.

// The endpoint is the first non-flag token after `api` (skipping the value of
// -X/-f/-F/-H). Returns null if this argv is not a `gh api` call.
function endpointOf(argv) {
  const start = argv.indexOf('api');
  if (start === -1) {
    return null;
  }
  for (let i = start + 1; i < argv.length; i += 1) {
    const tok = String(argv[i]);
    if (tok === '-X' || tok === '-f' || tok === '-F' || tok === '-H') {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      continue;
    }
    return tok;
  }
  return null;
}

// Resolve an endpoint the way `gh api` does: split on the first ? or #, keep
// the path. This is the ONLY assertion that would have caught the defect.
function resolvedPath(endpoint) {
  return String(endpoint).split(/[?#]/)[0];
}

// Repo shapes that are NOT a GitHub owner/name slug. Each one either escapes the
// issues subtree outright or truncates into a different endpoint.
const HOSTILE_REPOS = [
  'acme/widget/branches/main/protection?',
  'acme/widget#frag',
  'acme/widget/extra',
  'acme/widget?',
  'owner',
  '',
  '   ',
  '../../x',
  'acme/widget with space',
];

// Every verb in the allowlist, incl. run-once (which hands the repo to the
// worker's argv via spawn, not gh.run — so the choke point must cover it too).
const EVERY_VERB = [
  ['approve', '1'],
  ['reject', '1'],
  ['request-changes', '1'],
  ['needs-human', '1'],
  ['clear-needs-human', '1'],
  ['circuit', 'open', '1'],
  ['circuit', 'close', '1'],
  ['run-once'],
];

// Drive one verb with BOTH seams injected and report what each seam recorded.
function actWithSeams(args, flags, opts = {}) {
  const gh = fakeGh(opts.behavior);
  const spawns = [];
  const spawn = (cmd, cmdArgs) => {
    spawns.push({ cmd, cmdArgs });
    return { status: 0, stdout: 'worker: one tick, no work', stderr: '' };
  };
  const result = operatorAct.dispatch(args, flags, { run: gh.run, spawn });
  return { result, calls: gh.calls, spawns };
}

// Run fn with GH_REPO forced to `value` (undefined = unset), then restore.
const GH_REPO_ENV = 'GH_REPO';

function withGhRepo(value, fn) {
  const had = Object.hasOwn(process.env, GH_REPO_ENV);
  const prev = process.env[GH_REPO_ENV];
  if (value === undefined) {
    delete process.env[GH_REPO_ENV];
  } else {
    process.env[GH_REPO_ENV] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[GH_REPO_ENV] = prev;
    } else {
      delete process.env[GH_REPO_ENV];
    }
  }
}

test('repo injection (--repo rung): every hostile repo is refused for EVERY verb, before any gh.run or spawn', () => {
  withGhRepo(undefined, () => {
    for (const repo of HOSTILE_REPOS) {
      for (const args of EVERY_VERB) {
        const where = `${args.join(' ')} --repo ${JSON.stringify(repo)}`;
        const { result, calls, spawns } = actWithSeams(args, { repo });
        assertEqual(result.ok, false, `refused: ${where}`);
        assertEqual(result.effect, null, `effect:null: ${where}`);
        assertEqual(result.effects, undefined, `no effects array on a refusal: ${where}`);
        assertEqual(calls.length, 0, `gh.run NEVER called: ${where}`);
        assertEqual(spawns.length, 0, `spawn NEVER called: ${where}`);
        // verity.cjs:295-309 maps ok:false → exitCode 1 (fail-closed).
        assert((result.ok ? 0 : 1) !== 0, `maps to a non-zero exit: ${where}`);
      }
    }
  });
});

test('repo injection (GH_REPO rung): the env path is refused identically for EVERY verb', () => {
  for (const repo of HOSTILE_REPOS) {
    withGhRepo(repo, () => {
      for (const args of EVERY_VERB) {
        const where = `${args.join(' ')} GH_REPO=${JSON.stringify(repo)}`;
        // No --repo flag at all: resolveRepo must fall through to GH_REPO.
        const { result, calls, spawns } = actWithSeams(args, {});
        assertEqual(result.ok, false, `refused: ${where}`);
        assertEqual(result.effect, null, `effect:null: ${where}`);
        assertEqual(calls.length, 0, `gh.run NEVER called: ${where}`);
        assertEqual(spawns.length, 0, `spawn NEVER called: ${where}`);
      }
    });
  }
});

test('the refusal reason names the offending repo value and the required owner/name form', () => {
  withGhRepo(undefined, () => {
    const { result } = actWithSeams(['reject', '1'], {
      repo: 'acme/widget/branches/main/protection?',
    });
    assertEqual(result.ok, false, 'refused');
    assert(
      result.reason.includes('acme/widget/branches/main/protection?'),
      'reason quotes the offending value',
    );
    assert(/owner\/name/.test(result.reason), 'reason names the required form');
    assert(/before any/i.test(result.reason), 'reason states nothing was called');
  });
});

test('positive control: with a VALID repo every resolved endpoint stays inside repos/acme/widget/issues/<n>', () => {
  withGhRepo(undefined, () => {
    for (const args of EVERY_VERB) {
      if (args[0] === 'run-once') {
        continue;
      }
      const { result, calls } = actWithSeams(
        args,
        { repo: REPO, note: 'x' },
        {
          behavior: openIssueRead,
        },
      );
      assertEqual(result.ok, true, `${args.join(' ')} ok with a valid repo`);
      assert(calls.length > 0, `${args.join(' ')} issued at least one gh call`);
      for (const call of calls) {
        const endpoint = endpointOf(call.argv);
        assert(endpoint !== null, `${args.join(' ')} is a gh api call`);
        const seg = resolvedPath(endpoint).split('/');
        assertEqual(seg[0], 'repos', `${args.join(' ')}: routed under repos/`);
        assertEqual(seg[1], 'acme', `${args.join(' ')}: owner segment`);
        assertEqual(seg[2], 'widget', `${args.join(' ')}: name segment`);
        assertEqual(
          seg[3],
          'issues',
          `${args.join(' ')}: the resolved path NEVER leaves the issues subtree (got ${resolvedPath(endpoint)})`,
        );
        assertEqual(seg[4], '1', `${args.join(' ')}: the resolved path targets item #1`);
      }
    }
  });
});

// --- Stage 52 (#135): the kill switch must prove it can actually halt --------
//
// The worker's breaker query is
// `gh issue list --label verity:circuit-open --state open` (worker/index.cjs:798)
// — it never returns PRs, and --state open excludes closed issues. So labelling
// a PR or a closed issue is a GENUINE write that halts NOTHING, reported green.
// `circuit open` must verify its target is an OPEN ISSUE first, and fail closed
// when it cannot.

const PRECONDITION_ARGV = 'api repos/acme/widget/issues/12';

// The precondition read's payload for a plain open issue. Used as a default
// behavior wherever a test drives `circuit open` incidentally.
function openIssueRead() {
  return '{"state":"open","number":12}';
}

test('circuit open on a PR ⇒ ok:false, NO label write, reason names the breaker query', () => {
  const { result, calls } = dispatchWith(
    ['circuit', 'open', '12'],
    {},
    () => '{"state":"open","number":12,"pull_request":{"url":"https://api.github.com/x"}}',
  );
  assertEqual(result.ok, false, 'refused on a PR');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'the ONLY call is the precondition read');
  assertEqual(argvOf(calls[0]), PRECONDITION_ARGV, 'the precondition read argv');
  assert(/pull request/i.test(result.reason), 'reason says it is a PR');
  assert(/gh issue list/.test(result.reason), "reason quotes the worker's breaker query");
  assert(/--state open/.test(result.reason), 'reason names the --state open filter');
});

test('circuit open on a CLOSED issue ⇒ ok:false, NO label write', () => {
  const { result, calls } = dispatchWith(
    ['circuit', 'open', '12'],
    {},
    () => '{"state":"closed","number":12}',
  );
  assertEqual(result.ok, false, 'refused on a closed issue');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'the ONLY call is the precondition read');
  assert(/closed/i.test(result.reason), 'reason says it is closed');
  assert(/--state open/.test(result.reason), 'reason names the filter that hides it');
});

test('circuit open with an UNREADABLE target fails closed — never claims the switch is armed', () => {
  const { result, calls } = dispatchWith(['circuit', 'open', '12'], {}, () =>
    ghError('http-403', 'HTTP 403: Resource not accessible'),
  );
  assertEqual(result.ok, false, 'refused on an unverifiable read');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'no label write was attempted');
  assert(/could not (verify|read|check)/i.test(result.reason), 'reason names the failed read');
  assert(!/halts/.test(result.reason), 'reason NEVER claims the worker halts');
});

test('circuit open with unparseable precondition JSON fails closed', () => {
  const { result, calls } = dispatchWith(['circuit', 'open', '12'], {}, () => 'not json at all');
  assertEqual(result.ok, false, 'refused on unparseable JSON');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'no label write was attempted');
  assert(!/halts/.test(result.reason), 'reason NEVER claims the worker halts');
});

test('circuit open on a genuine OPEN ISSUE still issues the exact documented POST', () => {
  const { result, calls } = dispatchWith(['circuit', 'open', '12'], {}, openIssueRead);
  assertEqual(result.ok, true, 'ok on an open issue');
  assertEqual(result.effect.kind, 'label-add', 'label-add effect');
  assertEqual(result.effect.label, 'verity:circuit-open', 'the breaker label');
  assertEqual(calls.length, 2, 'precondition read + the label POST');
  assertEqual(argvOf(calls[0]), PRECONDITION_ARGV, 'op1 is the precondition read');
  assertEqual(
    argvOf(calls[1]),
    'api -X POST repos/acme/widget/issues/12/labels -f labels[]=verity:circuit-open',
    'op2 is the exact documented POST',
  );
  assert(/halts/.test(result.reason), 'reason may claim the halt — it is now proven');
});

test('DELIBERATE ASYMMETRY: circuit close is NOT gated — its DELETE issues with NO precondition read', () => {
  // Refusing to REMOVE a halt label is not fail-closed, and gating close would
  // strand a verity:circuit-open label a pre-fix build already applied to a PR
  // or a closed issue. This test pins the asymmetry so it is never "fixed" into
  // symmetry. The fake returns a payload that WOULD read as a closed PR — if
  // close ever grew a precondition it would refuse here, and this test fails.
  const { result, calls } = dispatchWith(
    ['circuit', 'close', '12'],
    {},
    () => '{"state":"closed","pull_request":{"url":"https://api.github.com/x"}}',
  );
  assertEqual(result.ok, true, 'close succeeds regardless of the target kind/state');
  assertEqual(calls.length, 1, 'exactly ONE call — no precondition read');
  assertEqual(
    argvOf(calls[0]),
    'api -X DELETE repos/acme/widget/issues/12/labels/verity%3Acircuit-open',
    'the only call is the DELETE',
  );
});
