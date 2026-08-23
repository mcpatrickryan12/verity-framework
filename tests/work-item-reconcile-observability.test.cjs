// Stage 67 (#188) — the worker reconcile (agent-exec `withWorkItems`) must no
// longer FAIL SILENTLY. reconcileWorkItems is best-effort and folds a failing
// `gh issue create` into its `failed[]`; before this stage the caller dropped
// that on the floor, so a repo missing the work-item labels created zero
// `[stage N]` items with no trace. Now a non-empty `failed[]` emits a §8.2-style
// stderr warning naming the failed stages — while staying non-fatal (the plan
// run still exits on its own outcome).
//
// Driven through the REAL CLI (`verity agent-exec plan ... --reconcile-work-items`)
// with a claude agent stub (VERITY_AGENT_BIN) and a `gh` PATH stub whose
// `issue create` can be made to fail — so the reconcile inside dispatch runs its
// true code path against an injected gh. No network, ever.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

// A minimal claude agent: reports a modern version, then a success result. The
// plan role's outcome is `success`, so withWorkItems runs the reconcile.
const AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, num_turns: 1,
  result: 'Planned.', session_id: 's-1', total_cost_usd: 0.5,
  usage: { input_tokens: 100, output_tokens: 50 },
}) + '\\n');
`;

// A `gh` that answers `issue list` from GH_EXISTING and either creates (exit 0)
// or fails `issue create` closed on a missing label (GH_CREATE_FAIL=1) — the
// exact real-world failure this stage exists to surface.
const GH_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'issue' && args[1] === 'list') {
  const titles = JSON.parse(process.env.GH_EXISTING || '[]');
  process.stdout.write(JSON.stringify(titles.map((t) => ({ title: t }))));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  if (process.env.GH_CREATE_FAIL === '1') {
    process.stderr.write("could not add label: 'needs-triage' not found in repository\\n");
    process.exit(1);
  }
  process.stdout.write('https://github.com/o/r/issues/1\\n');
  process.exit(0);
}
process.stderr.write('unhandled gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-reconcile-obs-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  stage.create(dir, 'Add user profiles', { type: 'feature' });
  return { dir, home, bin, agent };
}

function runPlan(fx, env = {}) {
  const res = spawnSync(
    'node',
    [CLI, 'agent-exec', 'plan', '1', '--run-id', 'obs-1', '--reconcile-work-items'],
    {
      cwd: fx.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
        HOME: fx.home,
        VERITY_AGENT_BIN: fx.agent,
        ...env,
      },
    },
  );
  return { code: res.status, out: res.stdout || '', stderr: res.stderr || '' };
}

test('a non-empty reconcile failed[] emits a §8.2 stderr warning naming the failed stage — but stays NON-FATAL', () => {
  const fx = fixture();
  const { code, out, stderr } = runPlan(fx, { GH_CREATE_FAIL: '1' });

  // Non-fatal: the plan role SUCCEEDED, so the run still exits 0. The reconcile
  // is best-effort — a failed create never turns a good plan into a failure.
  assertEqual(code, 0, `reconcile failure stays non-fatal (stderr: ${stderr})`);

  assert(
    stderr.includes('verity-agent-exec: work-item-reconcile-failed:'),
    `the failure is surfaced in the §8.2 stderr style (stderr: ${stderr})`,
  );
  assert(stderr.includes('[stage 1]'), 'the warning names the failed stage number');
  assert(stderr.includes('needs-triage'), 'and carries the underlying gh error');

  // The result still carries the work_items field with the failure recorded.
  const obj = JSON.parse(out);
  assertEqual(obj.outcome, 'success', 'the plan outcome is unchanged');
  assert(Array.isArray(obj.work_items.failed), 'work_items.failed is present on the result');
  assertEqual(obj.work_items.failed[0].number, 1, 'and records the failed stage');
});

test('a clean reconcile (every create succeeds) emits NO warning', () => {
  const fx = fixture();
  const { code, out, stderr } = runPlan(fx); // GH_CREATE_FAIL unset ⇒ creates succeed

  assertEqual(code, 0, `clean run exits 0 (stderr: ${stderr})`);
  assert(
    !stderr.includes('work-item-reconcile-failed'),
    `no warning when nothing failed (stderr: ${stderr})`,
  );
  const obj = JSON.parse(out);
  assertEqual(JSON.stringify(obj.work_items.created), JSON.stringify([1]), 'stage 1 was created');
  assert(!('failed' in obj.work_items), 'no failed[] on a clean reconcile');
});
