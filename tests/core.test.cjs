const { validateSlug, generateSlug } = require('../verity/bin/lib/core.cjs');

test('accepts a clean slug', () => {
  const r = validateSlug('verity-framework');
  assert(r.valid, `expected valid, got: ${JSON.stringify(r.issues)}`);
});

test('rejects uppercase', () => {
  assert(!validateSlug('Verity').valid, 'uppercase should be invalid');
});

test('rejects underscores', () => {
  assert(!validateSlug('verity_framework').valid, 'underscore should be invalid');
});

test('rejects a leading digit', () => {
  assert(!validateSlug('1verity').valid, 'leading digit should be invalid');
});

test('rejects names longer than 63 chars', () => {
  assert(!validateSlug('a'.repeat(64)).valid, 'overlong slug should be invalid');
});

test('rejects a trailing hyphen', () => {
  assert(!validateSlug('verity-').valid, 'trailing hyphen should be invalid');
});

test('reports the specific issue for an invalid slug', () => {
  const r = validateSlug('Bad_Name');
  assertEqual(r.valid, false, 'should be invalid');
  assert(r.issues.length > 0, 'should list at least one issue');
});

test('generateSlug produces a clean, valid slug from messy text', () => {
  const slug = generateSlug('My Cool App!');
  assertEqual(slug, 'my-cool-app');
  assert(validateSlug(slug).valid, 'generated slug should pass validation');
});

test('generateSlug collapses runs and trims hyphens', () => {
  assertEqual(generateSlug('  Foo --- Bar__Baz  '), 'foo-bar-baz');
});

test('generateSlug caps at 63 chars', () => {
  assert(generateSlug('a'.repeat(100)).length <= 63, 'should cap at 63');
});
