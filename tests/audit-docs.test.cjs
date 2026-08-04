const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const security = require('../verity/bin/lib/security.cjs');
const handoff = require('../verity/bin/lib/handoff.cjs');
const review = require('../verity/bin/lib/review.cjs');
const stage = require('../verity/bin/lib/stage.cjs');

function fresh(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`));
}

// --- Security Auditor ---
test('security init writes the invariants doc; idempotent', () => {
  const d = fresh('sec');
  const r = security.init(d);
  assert(r.created, 'created on first run');
  assert(fs.readFileSync(r.path, 'utf8').includes('NON-WIDENABLE'), 'has a real invariant');
  assertEqual(security.init(d).created, false, 'second run is idempotent');
});

test('review checklist wires in the security invariants', () => {
  const d = fresh('sec2');
  stage.create(d, 'Add billing', { type: 'feature' });
  // before init -> placeholder
  assert(
    /none defined/i.test(review.checklist(d, 1).securityInvariants),
    'placeholder before init',
  );
  security.init(d);
  assert(
    /NON-WIDENABLE/.test(review.checklist(d, 1).securityInvariants),
    'invariants flow into the reviewer checklist',
  );
});

// --- Technical Writer (handoff) ---
test('handoff new scaffolds a brief + the reading-order README', () => {
  const d = fresh('ho');
  const r = handoff.create(d, 'help-agent', { title: 'In-App Help Agent' });
  assert(fs.existsSync(r.path), 'brief on disk');
  const brief = fs.readFileSync(r.path, 'utf8');
  assert(/do NOT re-litigate/i.test(brief), 'has the settled-decisions section');
  assert(brief.includes('In-App Help Agent'), 'title interpolated');
  assert(
    fs.existsSync(path.join(d, 'docs', 'handoff', 'README.md')),
    'reading-order README ensured',
  );
});

test('handoff new refuses to overwrite; list excludes README', () => {
  const d = fresh('ho2');
  handoff.create(d, 'feat-a');
  let failed = false;
  try {
    handoff.create(d, 'feat-a');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'overwrite refused');
  const { briefs } = handoff.list(d);
  assert(briefs.includes('feat-a.md') && !briefs.includes('README.md'), 'list briefs only');
});

test('handoff new rejects an invalid slug', () => {
  let failed = false;
  try {
    handoff.create(fresh('ho3'), 'Bad_Slug');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'invalid slug rejected');
});
