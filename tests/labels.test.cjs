// T02 — label vocabulary in `verity install` (SKETCH §1).
//
// `gh` is a stateful PATH stub (the tests/next-snapshot.test.cjs pattern): it keeps
// a JSON label store on disk and appends every invocation to a call log, so the
// tests can assert WHAT was mutated and that no delete ever happens. No network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../verity/bin/lib/install.cjs');
const labels = require('../verity/bin/lib/labels.cjs');

// The fake `gh`. Reads/writes the label store named by GH_STUB_STORE; logs every
// argv line to GH_STUB_LOG. `mode: 'offline'` always fails (gh missing / no repo).
const STUB_BODY = `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, args.join(' ') + '\\n');
if (process.env.GH_STUB_MODE === 'offline' || args[0] !== 'label') process.exit(1);
const store = process.env.GH_STUB_STORE;
const all = JSON.parse(fs.readFileSync(store, 'utf8'));
const flag = (f) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };
if (args[1] === 'list') { console.log(JSON.stringify(all)); process.exit(0); }
const name = args[2];
const color = (flag('--color') || '').replace(/^#/, '');
const description = flag('--description') || '';
if (args[1] === 'create') {
  if (all.some((l) => l.name === name)) { console.error('already exists'); process.exit(1); }
  all.push({ name, color, description });
} else if (args[1] === 'edit') {
  const cur = all.find((l) => l.name === name);
  if (!cur) { console.error('not found'); process.exit(1); }
  if (flag('--color') !== undefined) cur.color = color;
  if (flag('--description') !== undefined) cur.description = description;
} else { process.exit(1); }
fs.writeFileSync(store, JSON.stringify(all));
`;

// Puts the stub first on PATH for the duration of fn (sync runner, so this is
// safe), then restores the environment. fn gets store/log accessors.
function withStubGh(initialLabels, fn, mode = 'online') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-labels-'));
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\n${STUB_BODY}`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const store = path.join(dir, 'labels.json');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(store, JSON.stringify(initialLabels));
  fs.writeFileSync(log, '');
  const saved = {};
  for (const k of ['PATH', 'GH_STUB_STORE', 'GH_STUB_LOG', 'GH_STUB_MODE']) {
    saved[k] = process.env[k];
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.GH_STUB_STORE = store;
  process.env.GH_STUB_LOG = log;
  process.env.GH_STUB_MODE = mode;
  try {
    return fn({
      dir,
      read: () => JSON.parse(fs.readFileSync(store, 'utf8')),
      calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
      resetLog: () => fs.writeFileSync(log, ''),
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

test('vocabulary: 8 verity:* workflow labels + 4 stage work-item labels (gh-style colors)', () => {
  // Stage 67 (#188): the set grew from the 8 verity-namespaced workflow labels
  // to also carry the 4 BARE stage work-item labels stage.issueFor attaches.
  assertEqual(labels.LABELS.length, 12);
  for (const l of labels.LABELS) {
    assert(/^[0-9a-f]{6}$/.test(l.color), `${l.name} color must be 6-digit lowercase hex, no #`);
    assert(l.description.length > 0, `${l.name} needs a description`);
  }
  const verity = labels.LABELS.filter((l) => l.name.startsWith('verity:'));
  assertEqual(verity.length, 8, 'the 8 verity-namespaced workflow labels');
  const workItem = labels.LABELS.filter((l) => !l.name.startsWith('verity:')).map((l) => l.name);
  assertEqual(
    JSON.stringify(workItem.sort()),
    JSON.stringify(['bug', 'chore', 'feature', 'needs-triage']),
    'the 4 bare work-item labels match stage.issueFor `[type, needs-triage]`',
  );
  const req = labels.LABELS.find((l) => l.name === 'verity:request');
  assertEqual(req.color, '0e8a16');
});

test('fresh repo: ensureLabels creates all 12 with color + description', () => {
  withStubGh([], (s) => {
    const r = labels.ensureLabels(s.dir);
    assertEqual(r.ok, true);
    assertEqual(r.created.length, 12);
    assertEqual(r.updated.length, 0);
    const store = s.read();
    assertEqual(store.length, 12);
    const open = store.find((l) => l.name === 'verity:circuit-open');
    assertEqual(open.color, '000000');
    assertEqual(open.description, 'Budget/safety breaker tripped; worker halts');
    // Stage 67 (#188): the stage work-item labels are provisioned too, so the
    // worker reconcile / plan agent `gh issue create` no longer fails closed.
    for (const name of ['feature', 'bug', 'chore', 'needs-triage']) {
      assert(
        store.some((l) => l.name === name),
        `${name} provisioned`,
      );
      assert(
        s.calls().some((c) => c.startsWith(`label create ${name} `)),
        `${name} was created via gh label create`,
      );
    }
    assertEqual(store.find((l) => l.name === 'needs-triage').color, 'fef2c0');
  });
});

test('idempotent: second run leaves 12 labels exactly once and only reads', () => {
  withStubGh([], (s) => {
    labels.ensureLabels(s.dir);
    s.resetLog();
    const r = labels.ensureLabels(s.dir);
    assertEqual(r.created.length, 0);
    assertEqual(r.updated.length, 0);
    assertEqual(r.unchanged.length, 12);
    assertEqual(s.read().length, 12, 'still exactly 12 labels');
    assertEqual(s.calls().length, 1, 'second run makes no mutating gh calls');
    assert(s.calls()[0].startsWith('label list'), 'the one call is the read');
  });
});

test('drifted color/description is edited in place, never re-created', () => {
  withStubGh([], (s) => {
    labels.ensureLabels(s.dir);
    const store = s.read();
    store.find((l) => l.name === 'verity:ready').color = 'ffffff';
    store.find((l) => l.name === 'verity:approved').description = 'stale';
    fs.writeFileSync(path.join(s.dir, 'labels.json'), JSON.stringify(store));
    s.resetLog();
    const r = labels.ensureLabels(s.dir);
    assertEqual(r.updated.sort().join(','), 'verity:approved,verity:ready');
    assertEqual(r.created.length, 0);
    assertEqual(r.unchanged.length, 10);
    assertEqual(s.read().length, 12);
    assertEqual(s.read().find((l) => l.name === 'verity:ready').color, '1d76db');
    assert(
      s.calls().every((c) => !c.startsWith('label create')),
      'drift repaired via edit, not create',
    );
  });
});

test('never deletes: a foreign label survives; `bug` is adopted via edit, never re-created', () => {
  const foreign = [
    // `bug` is now one of OUR labels (#188). A pre-existing `bug` (a GitHub
    // default) is UPSERTED in place — edited to our color/description, never
    // duplicate-created — so it stops being a foreign survivor.
    { name: 'bug', color: 'ee0701', description: '' },
    { name: 'verity:legacy', color: 'cccccc', description: 'not ours to remove' },
  ];
  withStubGh(foreign, (s) => {
    labels.ensureLabels(s.dir);
    labels.ensureLabels(s.dir);
    const names = s.read().map((l) => l.name);
    assert(names.includes('verity:legacy'), 'the purely-foreign label is intact');
    assert(names.includes('bug'), 'the adopted `bug` label is present exactly once');
    // 12 verity labels (8 verity:* + feature/bug/chore/needs-triage) + the one
    // untouched foreign label — `bug` was absorbed, not added alongside.
    assertEqual(s.read().length, 13, '12 verity labels + 1 foreign, exactly once each');
    assertEqual(
      s.read().find((l) => l.name === 'bug').color,
      'd73a4a',
      'the pre-existing bug was upserted to our color',
    );
    assert(
      s.calls().every((c) => !c.startsWith('label create bug')),
      'bug was edited, never re-created',
    );
    assert(
      s.calls().every((c) => !c.includes('delete')),
      'no gh label delete, ever',
    );
  });
});

test('install dispatch ensures labels; running install twice yields 12 exactly once', () => {
  withStubGh([], (s) => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-labels-target-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-labels-home-'));
    const first = install.dispatch([], { target, home, cwd: s.dir });
    assertEqual(first.harness, 'claude');
    assertEqual(first.labels.ok, true);
    assertEqual(first.labels.created.length, 12);
    const second = install.dispatch([], { target, home, cwd: s.dir });
    assertEqual(second.labels.created.length, 0);
    assertEqual(second.labels.unchanged.length, 12);
    assertEqual(s.read().length, 12, 'install twice → the 12 labels exactly once');
  });
});

test('offline / not a repo: install still succeeds, labels step reports skipped', () => {
  withStubGh(
    [],
    (s) => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-labels-off-'));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-labels-off-home-'));
      const r = install.dispatch([], { target, home, cwd: s.dir });
      assertEqual(r.harness, 'claude', 'install itself still completes');
      assertEqual(r.labels.ok, false);
      assertEqual(r.labels.skipped, true);
      assert(r.labels.error.length > 0, 'failure reason surfaced');
    },
    'offline',
  );
});

test('partial gh failure: remaining labels still attempted, failures reported', () => {
  // run() injection keeps this case deterministic without a flaky stub.
  const fail = new Set(['verity:ready']);
  const store = [];
  const run = (args) => {
    if (args[0] === 'list') {
      return JSON.stringify(store);
    }
    if (fail.has(args[1])) {
      throw new Error('HTTP 502 from gh');
    }
    store.push({ name: args[1], color: args[3], description: args[5] });
    return '';
  };
  const r = labels.ensureLabels('/tmp', run);
  assertEqual(r.ok, false);
  assertEqual(r.created.length, 11);
  assertEqual(r.failed.length, 1);
  assertEqual(r.failed[0].name, 'verity:ready');
  assertEqual(r.failed[0].error, 'HTTP 502 from gh');
});
