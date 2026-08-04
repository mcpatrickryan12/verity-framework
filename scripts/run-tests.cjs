#!/usr/bin/env node
// Verity test runner. Zero dependencies — discovers tests/*.test.cjs, provides
// global test/assert/assertEqual, runs them, and exits non-zero on any failure.
// (Deliberately tiny: the point of the walking skeleton is a REAL passing test,
// not a heavy framework.)
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;
const failures = [];

global.assert = (cond, msg) => {
  if (!cond) {
    throw new Error(msg || 'assertion failed');
  }
};

global.assertEqual = (actual, expected, msg) => {
  if (actual !== expected) {
    throw new Error(
      `${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

global.test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
};

const dir = path.join(__dirname, '..', 'tests');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')) : [];

if (files.length === 0) {
  console.error('No test files found in tests/ — refusing a vacuous pass.');
  process.exit(1);
}

for (const file of files) {
  console.log(file);
  require(path.join(dir, file));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
