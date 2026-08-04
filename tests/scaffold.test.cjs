const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('../verity/bin/lib/identity.cjs');
const scaffold = require('../verity/bin/lib/scaffold.cjs');

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-scaf-'));
}

test('render replaces {{key}} but leaves GitHub ${{ }} expressions intact', () => {
  assertEqual(
    scaffold.render('a {{slug}} ${{ github.ref }}', { slug: 'x' }),
    'a x ${{ github.ref }}',
  );
});

test('init throws without a locked identity', () => {
  let failed = false;
  try {
    scaffold.init(fresh(), {});
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'should require a locked identity manifest');
});

test('init scaffolds the governance + hygiene file set', () => {
  const d = fresh();
  identity.lock(d, { name: 'Demo App', slug: 'demo-app', owner: 'acme' });
  const r = scaffold.init(d, { description: 'A demo.' });
  const expected = [
    'README.md',
    'LICENSE',
    '.gitignore',
    '.github/workflows/ci.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    'STATUS.md',
  ];
  for (const f of expected) {
    assert(fs.existsSync(path.join(d, f)), `expected ${f} on disk`);
    assert(r.created.includes(f), `should report ${f} created`);
  }
});

test('emitted ci.yml is the honest hygiene gate with GH expressions intact', () => {
  const d = fresh();
  identity.lock(d, { name: 'Demo', slug: 'demo', owner: 'acme' });
  scaffold.init(d, {});
  const ci = fs.readFileSync(path.join(d, '.github/workflows/ci.yml'), 'utf8');
  assert(ci.includes('gitleaks'), 'should include the secret-scan');
  assert(ci.includes('structure'), 'should include the structure check');
  assert(ci.includes('${{ github.ref }}'), 'GH expressions must survive templating');
});

test('interpolates the manifest into README', () => {
  const d = fresh();
  identity.lock(d, { name: 'Cool Thing', slug: 'cool-thing', owner: 'acme' });
  scaffold.init(d, { description: 'Does cool stuff.' });
  const readme = fs.readFileSync(path.join(d, 'README.md'), 'utf8');
  assert(readme.includes('Cool Thing'), 'name interpolated');
  assert(readme.includes('Does cool stuff.'), 'description interpolated');
  assert(readme.includes('cool-thing'), 'slug interpolated');
});

test('init is idempotent — second run skips existing files', () => {
  const d = fresh();
  identity.lock(d, { name: 'X', slug: 'x-app', owner: 'a' });
  scaffold.init(d, {});
  const r2 = scaffold.init(d, {});
  assert(r2.skipped.length > 0, 'second run should skip existing files');
  assertEqual(r2.created.length, 0, 'nothing new created on the second run');
});
