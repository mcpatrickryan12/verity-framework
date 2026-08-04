const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../verity/bin/lib/config.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cfg-'));

test('config ensure creates defaults on first run', () => {
  const r = config.ensure(tmp);
  assert(r.created, 'should create on first ensure');
  assert(fs.existsSync(r.path), 'config file should exist');
});

test('config ensure is idempotent', () => {
  const r = config.ensure(tmp);
  assertEqual(r.created, false, 'second ensure should not recreate');
});

test('config get reads a default value', () => {
  assertEqual(config.get(tmp, 'prod_promote').value, 'confirm');
});

test('config set then get round-trips', () => {
  config.set(tmp, 'prod_promote', 'auto');
  assertEqual(config.get(tmp, 'prod_promote').value, 'auto');
});

test('config set coerces booleans and nests keys', () => {
  config.set(tmp, 'gates.go_live', 'true');
  assertEqual(config.get(tmp, 'gates.go_live').value, true, 'boolean coercion + dot-path');
});
