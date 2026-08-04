// Integration tests: spawn the real dispatcher, the way a harness would.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const ROOT = path.join(__dirname, '..');

function run(args) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('slug --raw emits a clean slug', () => {
  assertEqual(run(['slug', 'My Cool App!', '--raw']).trim(), 'my-cool-app');
});

test('slug (json) includes validation', () => {
  const obj = JSON.parse(run(['slug', 'Good Name']));
  assert(obj.validation.valid, 'generated slug should validate');
});

test('timestamp --raw is ISO-8601', () => {
  assert(/^\d{4}-\d{2}-\d{2}T/.test(run(['timestamp', '--raw']).trim()), 'expected ISO timestamp');
});

test('verify-path --raw reports existence', () => {
  assertEqual(run(['verify-path', 'package.json', '--raw', '--cwd', ROOT]).trim(), 'true');
  assertEqual(run(['verify-path', 'nope.xyz', '--raw', '--cwd', ROOT]).trim(), 'false');
});

test('help lists commands', () => {
  const obj = JSON.parse(run(['help']));
  assert(obj.commands.includes('slug'), 'help should list slug');
});

test('unknown command exits non-zero', () => {
  let failed = false;
  try {
    run(['nonsense-command']);
  } catch (_err) {
    failed = true;
  }
  assert(failed, 'unknown command should exit non-zero');
});

test('identity lock + get round-trip via CLI (no network)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cli-id-'));
  run(['identity', 'lock', 'My App', 'my-app', '--owner', 'acme', '--cwd', tmp]);
  const out = JSON.parse(run(['identity', 'get', '--cwd', tmp]));
  assertEqual(out.manifest.slug, 'my-app');
  assertEqual(out.manifest.image_prefix, 'ghcr.io/acme/my-app');
});

test('--raw on a structured result emits JSON, never [object Object]', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cli-raw-'));
  run(['config', 'ensure', '--cwd', tmp]);
  const out = run(['config', 'get', '--raw', '--cwd', tmp]).trim();
  assert(!out.includes('[object Object]'), 'must not stringify an object naively');
  assert(out.includes('model_profile'), 'should emit the config as JSON');
});

test('scaffold init via CLI produces the file set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cli-scaf-'));
  run(['identity', 'lock', 'Cli Demo', 'cli-demo', '--owner', 'acme', '--cwd', tmp]);
  const out = JSON.parse(run(['scaffold', 'init', '--cwd', tmp, '--description', 'Hi']));
  assert(out.created.includes('STATUS.md'), 'should create STATUS.md');
  assert(fs.existsSync(path.join(tmp, '.github/workflows/ci.yml')), 'ci.yml on disk');
  assert(fs.existsSync(path.join(tmp, '.verity/config.json')), 'config ensured');
});

test('install --claude --target via CLI lays down the command', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cli-inst-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cli-inst-home-'));
  // install now also ensures the autonomy labels on the target repo; stub gh as
  // unavailable (next-snapshot offline pattern) so this test stays network-free.
  const bin = path.join(tmp, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nprocess.exit(1);\n');
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const out = JSON.parse(
    execFileSync(
      'node',
      [CLI, 'install', '--claude', '--target', tmp, '--home', home, '--cwd', tmp],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      },
    ),
  );
  assertEqual(out.harness, 'claude');
  assertEqual(out.labels.skipped, true, 'labels step degrades gracefully without gh');
  assert(
    fs.existsSync(path.join(tmp, 'commands', 'verity', 'vision.md')),
    'vision command installed',
  );
  assert(
    fs.existsSync(path.join(home, 'deployment-methods.md')),
    'global deployment catalog seeded',
  );
});

test('deployment list via CLI returns the shipped samples', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-cli-dep-'));
  const out = JSON.parse(run(['deployment', 'list', '--home', home]));
  assert(
    out.methods.some((m) => m.id === 'aws-ec2'),
    'aws-ec2 sample present',
  );
  assertEqual(out.hasConfigured, false, 'shipped samples are examples, not configured');
});
