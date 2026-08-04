const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const contract = require('../verity/bin/lib/contract.cjs');
const review = require('../verity/bin/lib/review.cjs');

function withStage() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-build-'));
  stage.create(d, 'Add billing', { type: 'feature' }); // stage 1
  return d;
}

// --- Stage Manager acts ---
test('branchName derives feat/stage-N-slug from the stage file', () => {
  const d = withStage();
  assertEqual(stage.branchName(d, 1), 'feat/stage-1-add-billing');
});

test('prSpec builds title + body with acceptance + Closes', () => {
  const d = withStage();
  const spec = stage.prSpec(d, 1, { issue: 7 });
  assertEqual(spec.title, '[stage 1] Add billing');
  assert(/kill-switch/i.test(spec.body), 'acceptance conditions in PR body');
  assert(spec.body.includes('Closes #7'), 'links the work-item');
  assertEqual(spec.branch, 'feat/stage-1-add-billing');
});

test('stage branch --dry-run returns the name without touching git', () => {
  const d = withStage();
  const r = stage.dispatch(['branch', '1'], { cwd: d, 'dry-run': true });
  assertEqual(r.branch, 'feat/stage-1-add-billing');
  assertEqual(r.created, false);
});

test('stage pr --dry-run returns the spec without calling gh', () => {
  const d = withStage();
  const r = stage.dispatch(['pr', '1'], { cwd: d, 'dry-run': true, issue: '7' });
  assertEqual(r.opened, false);
  assert(r.title.includes('[stage 1]'));
});

test('branchName throws for a missing stage', () => {
  let failed = false;
  try {
    stage.branchName(withStage(), 99);
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'missing stage should throw');
});

// --- Reviewer/Integrator ---
test('review checklist surfaces acceptance conditions + contracts', () => {
  const d = withStage();
  contract.create(d, 'billing-wire-v1');
  const c = review.checklist(d, 1);
  assert(/kill-switch/i.test(c.acceptance), 'acceptance conditions pulled from the stage');
  assert(c.contracts.includes('billing-wire-v1.md'), 'contracts listed for conformance check');
  assert(/ACTUAL diff/i.test(c.instructions), 'instructs verify-against-source');
});

test('the merge gate refuses on red CI and allows on green', () => {
  assertEqual(review.canMerge(true), true, 'green -> may merge');
  assertEqual(review.canMerge(false), false, 'red -> refuse');
  assertEqual(review.canMerge(undefined), false, 'unknown -> refuse (fail safe)');
});

test('review merge --dry-run does not act', () => {
  const r = review.merge(withStage(), 5, { 'dry-run': true });
  assertEqual(r.merged, false);
  assert(r.dryRun, 'dry-run flagged');
});
