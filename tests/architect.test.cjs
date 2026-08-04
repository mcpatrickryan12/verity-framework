const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adr = require('../verity/bin/lib/adr.cjs');
const contract = require('../verity/bin/lib/contract.cjs');
const catalog = require('../verity/bin/lib/catalog.cjs');

function fresh(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`));
}

// --- ADR ---
test('adr new auto-numbers from 0001 and writes from template', () => {
  const d = fresh('adr');
  const r = adr.create(d, 'Choose Postgres over MySQL');
  assertEqual(r.number, '0001');
  assert(fs.existsSync(r.path), 'adr file on disk');
  const body = fs.readFileSync(r.path, 'utf8');
  assert(body.includes('Choose Postgres over MySQL'), 'title interpolated');
  assert(body.includes('Alternatives considered'), 'ADR shape present');
});

test('adr numbering increments', () => {
  const d = fresh('adr2');
  adr.create(d, 'First');
  const second = adr.create(d, 'Second');
  assertEqual(second.number, '0002');
  assertEqual(adr.list(d).adrs.length, 2);
});

test('adr new requires a title', () => {
  let failed = false;
  try {
    adr.create(fresh('adr3'), '');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'empty title should fail');
});

// --- contracts ---
test('contract new writes a frozen-v1 template', () => {
  const d = fresh('ct');
  const r = contract.create(d, 'subagent-wire-v1');
  assert(fs.existsSync(r.path), 'contract on disk');
  assert(fs.readFileSync(r.path, 'utf8').includes('frozen'), 'should be frozen v1');
});

test('contract new refuses to overwrite (frozen)', () => {
  const d = fresh('ct2');
  contract.create(d, 'wire');
  let failed = false;
  try {
    contract.create(d, 'wire');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'contracts are frozen — a change is a new contract, not an edit');
});

test('contract name must be a valid slug', () => {
  let failed = false;
  try {
    contract.create(fresh('ct3'), 'Bad_Name');
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'invalid contract name should be rejected');
});

// --- catalog (reads the shipped package content) ---
test('guides list returns the shipped sample guides', () => {
  const { guides } = catalog.guidesDispatch(['list']);
  assert(guides.length >= 2, 'should ship sample guides');
  assert(
    guides.some((g) => g.id === 'contracts-first'),
    'contracts-first guide present',
  );
});

test('feature list includes the helper-bot catalog entry', () => {
  const { features } = catalog.featureDispatch(['list']);
  assert(
    features.some((f) => f.id === 'helper-bot'),
    'helper-bot feature present',
  );
});

test('feature show returns content', () => {
  const r = catalog.featureDispatch(['show', 'helper-bot']);
  assert(r.content.includes('Help Agent'), 'should return the feature spec content');
});

test('guides show throws for an unknown id', () => {
  let failed = false;
  try {
    catalog.guidesDispatch(['show', 'no-such-guide']);
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'unknown guide should fail');
});
