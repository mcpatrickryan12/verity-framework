const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-stage-'));
}

test('stage new (feature) bakes in kill-switch + UI-smoke acceptance conditions', () => {
  const d = fresh();
  const r = stage.create(d, 'Add user profiles', { type: 'feature' });
  assertEqual(r.number, 1);
  assertEqual(r.type, 'feature');
  const body = fs.readFileSync(r.path, 'utf8');
  assert(body.includes('Add user profiles'), 'title interpolated');
  assert(/kill-switch/i.test(body), 'feature must carry a kill-switch condition');
  assert(/UI-smoke/i.test(body), 'feature must carry a UI-smoke condition');
});

test('stage new (bug) carries a regression test, not a kill-switch', () => {
  const d = fresh();
  const body = fs.readFileSync(stage.create(d, 'Fix login 500', { type: 'bug' }).path, 'utf8');
  assert(/regression test/i.test(body), 'bug must carry a regression test');
  assert(!/kill-switch/i.test(body), 'bug should not carry a kill-switch');
});

test('stage new (chore) carries an exit-state', () => {
  const d = fresh();
  const body = fs.readFileSync(stage.create(d, 'Bump deps', { type: 'chore' }).path, 'utf8');
  assert(/exit-state/i.test(body), 'chore must define an exit-state');
});

test('stage numbering increments and depends-on renders', () => {
  const d = fresh();
  stage.create(d, 'First');
  const second = stage.create(d, 'Second', { dependsOn: '1' });
  assertEqual(second.number, 2);
  assert(fs.readFileSync(second.path, 'utf8').includes('**Depends on:** 1'), 'depends-on rendered');
  assertEqual(stage.list(d).stages.length, 2);
});

test('stage new returns a suggested work-item with type label', () => {
  const d = fresh();
  const r = stage.create(d, 'Add billing', { type: 'feature' });
  assertEqual(r.issue.title, '[stage 1] Add billing');
  assert(r.issue.labels.includes('feature'), 'issue carries the type label');
});

test('stage new rejects an unknown type', () => {
  let failed = false;
  try {
    stage.create(fresh(), 'X', { type: 'nonsense' });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'unknown type should be rejected');
});

test('stage new requires a title', () => {
  let failed = false;
  try {
    stage.create(fresh(), '');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'empty title should fail');
});
