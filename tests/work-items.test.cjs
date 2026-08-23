// Stage 63 (ADR-0026, #176) — worker-owned, idempotent `[stage N]` work-item
// reconciliation. All `gh` access is injected (opts.ghList / opts.ghCreate), so
// these tests never touch the network. Stage files are written with the real
// stage.create() so issueFor() reads the exact on-disk shape the worker sees.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const workItems = require('../verity/bin/lib/work-items.cjs');

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-work-items-'));
}

// An injected gh backed by an in-memory issue store. `titles` seeds pre-existing
// issues; every create is recorded AND added to the store, so a second reconcile
// pass observes the first pass's issues (the real idempotency path).
function fakeGh(titles = []) {
  const store = [...titles];
  const creates = [];
  return {
    ghList: () => store.slice(),
    ghCreate: (_cwd, issue) => {
      creates.push(issue);
      store.push(issue.title);
    },
    creates,
    store,
  };
}

test('reconcile creates one issue per un-issued stage file with correct title/labels/body', () => {
  const d = fresh();
  stage.create(d, 'Add user profiles', { type: 'feature' });
  const gh = fakeGh();

  const res = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: gh.ghList,
    ghCreate: gh.ghCreate,
  });

  assertEqual(gh.creates.length, 1, 'exactly one issue created');
  const issue = gh.creates[0];
  assertEqual(issue.title, '[stage 1] Add user profiles', 'title = [stage N] <h1 title>');
  assertEqual(JSON.stringify(issue.labels), JSON.stringify(['feature', 'needs-triage']), 'labels');
  assert(/see `stage-instructions\/stage-1-/.test(issue.body), 'body references the stage file');
  assert(/refs stage 1/.test(issue.body), 'body carries the refs-stage-N traceability');
  assertEqual(JSON.stringify(res.created), JSON.stringify([1]), 'result reports created [1]');
});

test('reconcile is a no-op when the `[stage N]` issue already exists (idempotency)', () => {
  const d = fresh();
  stage.create(d, 'Add user profiles', { type: 'feature' });
  const gh = fakeGh(['[stage 1] Add user profiles']);

  const res = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: gh.ghList,
    ghCreate: gh.ghCreate,
  });

  assertEqual(gh.creates.length, 0, 'no create when the stage already has an issue');
  assertEqual(JSON.stringify(res.skipped), JSON.stringify([1]), 'stage 1 skipped');
});

test('reconcile handles multiple new stages in one pass; only the un-issued ones create', () => {
  const d = fresh();
  stage.create(d, 'First', { type: 'feature' });
  stage.create(d, 'Second', { type: 'bug' });
  stage.create(d, 'Third', { type: 'chore' });
  // Stage 2 already registered — a partial prior run; only 1 and 3 are missing.
  const gh = fakeGh(['[stage 2] Second']);

  const res = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: gh.ghList,
    ghCreate: gh.ghCreate,
  });

  assertEqual(
    JSON.stringify(res.created),
    JSON.stringify([1, 3]),
    'creates only the missing stages',
  );
  assertEqual(JSON.stringify(res.skipped), JSON.stringify([2]), 'skips the already-issued stage');
  const bug = gh.creates.find((i) => i.number === 3);
  assertEqual(
    JSON.stringify(bug.labels),
    JSON.stringify(['chore', 'needs-triage']),
    'type-derived label',
  );
});

test('a second reconcile pass creates nothing (keyed on `[stage N]`)', () => {
  const d = fresh();
  stage.create(d, 'First', { type: 'feature' });
  stage.create(d, 'Second', { type: 'feature' });
  const gh = fakeGh();

  const first = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: gh.ghList,
    ghCreate: gh.ghCreate,
  });
  assertEqual(JSON.stringify(first.created), JSON.stringify([1, 2]), 'first pass creates both');

  const second = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: gh.ghList,
    ghCreate: gh.ghCreate,
  });
  assertEqual(gh.creates.length, 2, 'second pass adds no creates');
  assertEqual(JSON.stringify(second.created), JSON.stringify([]), 'second pass created nothing');
  assertEqual(JSON.stringify(second.skipped), JSON.stringify([1, 2]), 'both skipped on re-run');
});

test('kill-switch OFF: reconcile makes NO gh calls and creates nothing', () => {
  const d = fresh();
  stage.create(d, 'Add user profiles', { type: 'feature' });
  let listed = false;
  let created = false;

  const res = workItems.reconcileWorkItems(d, {
    ghList: () => {
      listed = true;
      return [];
    },
    ghCreate: () => {
      created = true;
    },
  });

  assert(!listed, 'OFF must not even list issues');
  assert(!created, 'OFF must not create');
  assertEqual(res.enabled, false, 'result marked disabled');
  assertEqual(JSON.stringify(res.created), JSON.stringify([]), 'nothing created');
});

test('Codex #176 repro: github_write denied to the plan agent — the WORKER still creates the work-item', () => {
  // The contained codex plan agent cannot run `gh issue create` (github_write
  // denied, GH_TOKEN stripped, ADR-0011), so the repo carries only issue #1 (the
  // request) and NO `[stage N]` item — the exact stall (#176). reconcile takes
  // NO role/capability input: it uses the worker's ambient (injected) gh, so it
  // creates the missing item regardless of what the child was denied.
  const d = fresh();
  stage.create(d, 'Worker-owned work items', { type: 'feature' });
  const gh = fakeGh(['request: add worker-owned work items']); // only the intake issue

  const res = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: gh.ghList,
    ghCreate: gh.ghCreate,
  });

  assertEqual(gh.creates.length, 1, 'worker created the missing [stage 1] item');
  assertEqual(gh.creates[0].title, '[stage 1] Worker-owned work items', 'correct [stage N] title');
  assertEqual(JSON.stringify(res.created), JSON.stringify([1]), 'stall → forward motion');
});

test('reconcile is best-effort: a failed issue list creates nothing (no risky double-create)', () => {
  const d = fresh();
  stage.create(d, 'Add user profiles', { type: 'feature' });
  let created = false;

  const res = workItems.reconcileWorkItems(d, {
    flag: true,
    ghList: () => {
      throw new Error('HTTP 500: GitHub is down');
    },
    ghCreate: () => {
      created = true;
    },
  });

  assert(!created, 'cannot enumerate ⇒ must not create');
  assertEqual(res.enabled, true, 'still an enabled run');
  assert(/HTTP 500/.test(res.error), 'the list failure is reported');
});

test('stageNumFromTitle parses the `[stage N]` key and rejects non-matches', () => {
  assertEqual(workItems.stageNumFromTitle('[stage 7] Something'), 7);
  assertEqual(workItems.stageNumFromTitle('[stage 42] x'), 42);
  assertEqual(workItems.stageNumFromTitle('no stage marker'), null);
  assertEqual(workItems.stageNumFromTitle(''), null);
});
