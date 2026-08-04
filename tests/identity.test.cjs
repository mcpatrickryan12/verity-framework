const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('../verity/bin/lib/identity.cjs');

// Fake runner: npm reports the name TAKEN (exit 0), gh reports NOT FOUND (fails).
const fakeRun = (cmd) => (cmd === 'npm' ? { ok: true } : { ok: false });

test('check aggregates availability across sources', () => {
  const r = identity.check('verity-framework', { owner: 'seanerama', run: fakeRun });
  assertEqual(r.valid, true, 'slug should be valid');
  assertEqual(r.availability.npm.available, false, 'npm taken');
  assertEqual(r.availability.github.available, true, 'github available');
  assertEqual(r.available, false, 'overall unavailable because npm is taken');
});

test('check skips availability lookups for an invalid slug', () => {
  const r = identity.check('Bad_Slug', { run: fakeRun });
  assertEqual(r.valid, false);
  assertEqual(Object.keys(r.availability).length, 0, 'no network checks when invalid');
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-id-'));

test('lock writes an immutable manifest with derived image_prefix', () => {
  const r = identity.lock(tmp, {
    name: 'Verity Framework',
    slug: 'verity-framework',
    owner: 'seanerama',
  });
  assert(r.locked, 'should lock');
  assertEqual(r.manifest.slug, 'verity-framework');
  assertEqual(r.manifest.image_prefix, 'ghcr.io/seanerama/verity-framework');
});

test('lock refuses to overwrite an existing manifest', () => {
  let failed = false;
  try {
    identity.lock(tmp, { name: 'Other', slug: 'other-name', owner: 'x' });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'second lock must refuse (identity is immutable)');
});

test('lock --force overwrites', () => {
  const r = identity.lock(tmp, { name: 'Why Not', slug: 'why-not', owner: 'x', force: true });
  assertEqual(r.manifest.slug, 'why-not');
});

test('get reads a manifest field', () => {
  assertEqual(identity.get(tmp, 'slug').value, 'why-not');
});

test('lock rejects an invalid slug', () => {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-id2-'));
  let failed = false;
  try {
    identity.lock(t2, { name: 'X', slug: 'Bad_Slug', owner: 'o' });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'invalid slug should be rejected');
});

test('get throws when no manifest exists', () => {
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-id3-'));
  let failed = false;
  try {
    identity.get(t3, 'slug');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'get should fail without a manifest');
});
