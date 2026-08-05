// T13 — trust ladder (SKETCH §4.5): glob matcher, deterministic risk
// classifier, merge decision. All gh access is via the injectable `exec` seam
// of gh.cjs — no subprocess, no network.
const fs = require('node:fs');
const path = require('node:path');
const trust = require('../verity/bin/lib/trust.cjs');

// --- glob matcher -------------------------------------------------------------

test('globMatch: `*` matches within a segment, never across `/`', () => {
  assert(trust.globMatch('scripts/deploy*', 'scripts/deploy-prod.sh'), 'suffix run');
  assert(trust.globMatch('scripts/deploy*', 'scripts/deploy'), '`*` matches the empty run');
  assert(!trust.globMatch('scripts/deploy*', 'scripts/deploy/prod.sh'), 'no `/` crossing');
  assert(trust.globMatch('*.md', 'README.md'), 'leading `*`');
  assert(!trust.globMatch('*.md', 'docs/README.md'), 'single `*` is one segment only');
});

test('globMatch: `**` matches zero or more whole segments', () => {
  assert(trust.globMatch('docs/**', 'docs/guide.md'), 'one segment');
  assert(trust.globMatch('docs/**', 'docs/a/b/c.md'), 'many segments');
  assert(trust.globMatch('docs/**', 'docs'), 'zero segments');
  assert(!trust.globMatch('docs/**', 'docs2/guide.md'), 'literal prefix is exact');
  assert(trust.globMatch('**/*.md', 'README.md'), 'leading `**` matches zero segments');
  assert(trust.globMatch('**/*.md', 'a/b/README.md'), 'leading `**` matches many');
  assert(trust.globMatch('**/auth/**', 'auth/token.js'), 'mid `**`, zero-prefix');
  assert(trust.globMatch('**/auth/**', 'src/deep/auth/x/y.js'), 'mid `**`, both sides');
  assert(!trust.globMatch('**/auth/**', 'src/author/x.js'), 'segment match is exact');
});

test('globMatch: `?`, literals, dotfiles, regex metachars', () => {
  assert(trust.globMatch('a?.txt', 'ab.txt'), '`?` is one char');
  assert(!trust.globMatch('a?.txt', 'a.txt'), '`?` is not optional');
  assert(!trust.globMatch('a?.txt', 'a/b.txt'), '`?` never matches `/`');
  assert(trust.globMatch('.github/**', '.github/workflows/ci.yml'), 'dotfiles match');
  assert(trust.globMatch('.verity/**', '.verity/autonomy.yml'), 'forced protected path');
  assert(!trust.globMatch('a.b', 'aXb'), '`.` is literal, not regex any-char');
  assert(trust.globMatch('a+b/c', 'a+b/c'), 'regex metachars are literal');
  assert(trust.globMatch('docs/*', './docs/x.md'), 'leading ./ on the path is stripped');
});

test('matchAny: returns the first matching pattern, null when none match', () => {
  assertEqual(trust.matchAny(['docs/**', '**/*.md'], 'notes.md'), '**/*.md');
  assertEqual(trust.matchAny(['docs/**', '**/*.md'], 'src/app.js'), null);
  assertEqual(trust.matchAny([], 'anything'), null);
  assertEqual(trust.matchAny(undefined, 'anything'), null);
});

// --- classify: stubbed gh ------------------------------------------------------

// In-process gh stub via gh.cjs's `exec` injection point. `pr` state:
// { files, additions, deletions, checksPass }. Records every call.
function ghStub(pr) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'diff') {
      return `${pr.files.join('\n')}\n`;
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ additions: pr.additions, deletions: pr.deletions });
    }
    if (args[0] === 'pr' && args[1] === 'checks') {
      if (pr.checksPass) {
        return 'all checks pass\n';
      }
      const err = new Error('some checks failed');
      err.status = 1;
      err.stderr = '';
      throw err;
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      return '';
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { calls, ghOpts: { exec, retries: 0 } };
}

function policyWith(lowRisk = {}) {
  return {
    review: {
      trust: 1,
      low_risk: {
        max_changed_lines: 150,
        allowed_paths: ['docs/**', 'tests/**', '**/*.md'],
        protected_paths: ['**/auth/**', '.github/**', 'scripts/deploy*', '.verity/**'],
        require_ci_green: true,
        ...lowRisk,
      },
    },
  };
}

test('classify: all-allowed files, under the line cap, checks green → low', () => {
  const { ghOpts } = ghStub({
    files: ['docs/guide.md', 'tests/x.test.cjs', 'README.md'],
    additions: 80,
    deletions: 20,
    checksPass: true,
  });
  const c = trust.classify(7, policyWith(), ghOpts);
  assertEqual(c.risk, 'low');
  assertEqual(c.reasons.length, 0, `no reasons on low risk, got: ${c.reasons}`);
  assertEqual(c.changed_lines, 100);
  assertEqual(c.checks_green, true);
});

test('classify: EXACTLY max_changed_lines is still low-risk (boundary pinned)', () => {
  const { ghOpts } = ghStub({
    files: ['docs/a.md'],
    additions: 100,
    deletions: 50, // 150 == default max_changed_lines
    checksPass: true,
  });
  const c = trust.classify(7, policyWith(), ghOpts);
  assertEqual(c.changed_lines, 150);
  assertEqual(c.risk, 'low', 'additions+deletions == max is low-risk, not high');
});

test('classify: one line OVER max_changed_lines → high, reason names the cap', () => {
  const { ghOpts } = ghStub({
    files: ['docs/a.md'],
    additions: 101,
    deletions: 50,
    checksPass: true,
  });
  const c = trust.classify(7, policyWith(), ghOpts);
  assertEqual(c.risk, 'high');
  assert(
    c.reasons.some((r) => r.includes('151') && r.includes('max_changed_lines 150')),
    `reason names lines and cap, got: ${c.reasons}`,
  );
});

test('classify: protected-path veto BEATS an allowed-path match', () => {
  // docs/auth/setup.md matches allowed 'docs/**' AND protected '**/auth/**'.
  const { ghOpts } = ghStub({
    files: ['docs/auth/setup.md'],
    additions: 1,
    deletions: 0,
    checksPass: true,
  });
  const c = trust.classify(7, policyWith(), ghOpts);
  assertEqual(c.risk, 'high', 'protected veto wins even though allowed_paths matches');
  assert(
    c.reasons.some((r) => r.includes('protected path **/auth/**')),
    `reason names the protected pattern, got: ${c.reasons}`,
  );
});

test('classify: a file outside allowed_paths → high', () => {
  const { ghOpts } = ghStub({
    files: ['docs/ok.md', 'src/app.js'],
    additions: 1,
    deletions: 0,
    checksPass: true,
  });
  const c = trust.classify(7, policyWith(), ghOpts);
  assertEqual(c.risk, 'high');
  assert(
    c.reasons.some((r) => r.includes('src/app.js') && r.includes('outside allowed_paths')),
    `reason names the file, got: ${c.reasons}`,
  );
});

test('classify: require_ci_green + failing checks → high; checks failure is one reason', () => {
  const { ghOpts } = ghStub({
    files: ['docs/a.md'],
    additions: 1,
    deletions: 0,
    checksPass: false,
  });
  const c = trust.classify(7, policyWith(), ghOpts);
  assertEqual(c.risk, 'high');
  assertEqual(c.checks_green, false);
  assert(c.reasons.includes('checks are not green'), `got: ${c.reasons}`);
});

test('classify: require_ci_green false → gh pr checks is never consulted', () => {
  const { calls, ghOpts } = ghStub({
    files: ['docs/a.md'],
    additions: 1,
    deletions: 0,
    checksPass: false, // would fail IF consulted
  });
  const c = trust.classify(7, policyWith({ require_ci_green: false }), ghOpts);
  assertEqual(c.risk, 'low');
  assertEqual(c.checks_green, null, 'not consulted → null, not false');
  assert(
    calls.every((a) => a[1] !== 'checks'),
    'no gh pr checks call when the policy does not require it',
  );
});

test('classify: uses the exact §4.5 gh commands', () => {
  const { calls, ghOpts } = ghStub({
    files: ['docs/a.md'],
    additions: 1,
    deletions: 0,
    checksPass: true,
  });
  trust.classify(42, policyWith(), ghOpts);
  assertEqual(JSON.stringify(calls[0]), JSON.stringify(['pr', 'diff', '42', '--name-only']));
  assertEqual(
    JSON.stringify(calls[1]),
    JSON.stringify(['pr', 'view', '42', '--json', 'additions,deletions']),
  );
  assertEqual(JSON.stringify(calls[2]), JSON.stringify(['pr', 'checks', '42']));
});

// --- decideMerge: the ladder, exactly ------------------------------------------

const LOW = { risk: 'low', reasons: [] };
const HIGH = { risk: 'high', reasons: ['src/app.js is outside allowed_paths'] };

test('decideMerge: trust 0 NEVER merges, even on an approve verdict', () => {
  const d = trust.decideMerge('approve', 0, LOW, true);
  assertEqual(d.merge, false);
  assertEqual(d.gate, true);
  assert(d.reason.includes('trust 0'), 'reason names the trust level');
});

test('decideMerge: trust 1 merges on approve + low-risk, gates on high-risk', () => {
  const low = trust.decideMerge('approve', 1, LOW, true);
  assertEqual(low.merge, true);
  assertEqual(low.gate, false);
  const high = trust.decideMerge('approve', 1, HIGH, true);
  assertEqual(high.merge, false);
  assertEqual(high.gate, true);
  assert(high.reason.includes('src/app.js'), 'gate reason carries the classifier reasons');
  const none = trust.decideMerge('approve', 1, null, true);
  assertEqual(none.merge, false, 'no classification → fail closed');
});

test('decideMerge: trust 2 merges ONLY when checks are green', () => {
  assertEqual(trust.decideMerge('approve', 2, null, true).merge, true);
  const red = trust.decideMerge('approve', 2, null, false);
  assertEqual(red.merge, false);
  assertEqual(red.gate, true);
  const unknown = trust.decideMerge('approve', 2, null, null);
  assertEqual(unknown.merge, false, 'unknown checks state is NOT green');
});

test('decideMerge: any non-approve verdict never merges, at every trust level', () => {
  for (const trustLevel of [0, 1, 2]) {
    for (const verdict of ['request_changes', 'reject', null, undefined]) {
      const d = trust.decideMerge(verdict, trustLevel, LOW, true);
      assertEqual(d.merge, false, `verdict ${verdict} trust ${trustLevel}`);
      assertEqual(d.gate, true);
    }
  }
});

test('decideMerge: an out-of-range trust level fails closed', () => {
  const d = trust.decideMerge('approve', 3, LOW, true);
  assertEqual(d.merge, false);
  assertEqual(d.gate, true);
  assert(d.reason.includes('failing closed'));
});

// --- stage 36: escalate is a tagged, never-merging non-approve verdict ----------

test('decideMerge: an escalate verdict gates and is TAGGED escalate, never merging at any trust', () => {
  for (const trustLevel of [0, 1, 2]) {
    const d = trust.decideMerge('escalate', trustLevel, LOW, true);
    assertEqual(d.merge, false, `escalate never merges at trust ${trustLevel}`);
    assertEqual(d.gate, true, `escalate gates at trust ${trustLevel}`);
    assertEqual(d.escalate, true, `escalate decision is tagged at trust ${trustLevel}`);
    assert(d.reason.includes('escalate'), 'reason names the verdict');
  }
});

test('decideMerge: request_changes / unknown / absent gate with NO escalate tag (byte-identical default)', () => {
  for (const trustLevel of [0, 1, 2]) {
    for (const verdict of ['request_changes', 'reject', null, undefined]) {
      const d = trust.decideMerge(verdict, trustLevel, LOW, true);
      assertEqual(d.merge, false, `verdict ${verdict} trust ${trustLevel} never merges`);
      assertEqual(d.gate, true, `verdict ${verdict} trust ${trustLevel} gates`);
      assertEqual(
        d.escalate,
        undefined,
        `verdict ${verdict} carries NO escalate field (unchanged from pre-stage-36)`,
      );
      assert(d.reason.includes('is not approve'), 'keeps the generic fail-closed reason');
    }
  }
});

// --- merge + checksGreen --------------------------------------------------------

test('merge: issues exactly `gh pr merge <n> --squash`', () => {
  const { calls, ghOpts } = ghStub({ files: [], additions: 0, deletions: 0, checksPass: true });
  const r = trust.merge(114, ghOpts);
  assertEqual(JSON.stringify(calls), JSON.stringify([['pr', 'merge', '114', '--squash']]));
  assertEqual(r.merged, true);
  assertEqual(r.method, 'squash');
});

test('checksGreen: exit 0 → true; any gh failure → false (fail closed)', () => {
  const green = ghStub({ files: [], additions: 0, deletions: 0, checksPass: true });
  assertEqual(trust.checksGreen(1, green.ghOpts), true);
  const red = ghStub({ files: [], additions: 0, deletions: 0, checksPass: false });
  assertEqual(trust.checksGreen(1, red.ghOpts), false);
  const broken = {
    exec: () => {
      throw new Error('spawn gh ENOENT');
    },
    retries: 0,
  };
  assertEqual(trust.checksGreen(1, broken), false, 'gh unavailable reads as NOT green');
});

// --- merge authority stays in the worker (T06 invariant) -------------------------

test('review tool allowlist still contains no merge-capable tool', () => {
  const file = path.join(__dirname, '..', 'commands', 'verity', 'review.tools.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(Array.isArray(list) && list.length > 0, 'allowlist exists and is non-empty');
  for (const entry of list) {
    assert(!/merge/i.test(entry), `merge-capable tool in review allowlist: ${entry}`);
    assert(
      entry !== 'Bash' && !/^Bash\((?:\*|gh:\*|gh \*)\)$/.test(entry),
      `unrestricted Bash: ${entry}`,
    );
    assert(entry !== 'node' && !entry.startsWith('Bash(node'), `node escape hatch: ${entry}`);
  }
});
