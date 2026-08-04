const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deployment = require('../verity/bin/lib/deployment.cjs');
const identity = require('../verity/bin/lib/identity.cjs');

function freshHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-dh-${tag}-`));
}
function freshProject(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-dp-${tag}-`));
}

// --- GLOBAL catalog: seed + non-clobber ---
test('ensure seeds the global catalog when absent, never clobbers', () => {
  const home = freshHome('seed');
  const first = deployment.ensure({ home });
  assert(first.created, 'seeded on first run');
  assert(fs.existsSync(first.path), 'file on disk');
  fs.writeFileSync(first.path, '# my edits\n');
  const second = deployment.ensure({ home });
  assertEqual(second.created, false, 'second run does not clobber');
  assertEqual(fs.readFileSync(first.path, 'utf8'), '# my edits\n', 'user edits preserved');
});

test('globalPath lives outside the install dir, in ~/.verity', () => {
  const home = freshHome('path');
  assertEqual(deployment.globalPath({ home }), path.join(home, 'deployment-methods.md'));
});

// --- list / show parsing ---
test('list parses the shipped samples; they are examples (not configured)', () => {
  const home = freshHome('list');
  const r = deployment.list({ home });
  const ids = r.methods.map((m) => m.id);
  assert(ids.includes('aws-ec2'), 'aws-ec2 sample present');
  assert(ids.includes('local-server'), 'local-server sample present');
  assert(
    r.methods.every((m) => m.status === 'example'),
    'shipped samples are status: example',
  );
  assertEqual(r.hasConfigured, false, 'examples do not count as configured');
});

test('list reports a user-added active method as configured', () => {
  const home = freshHome('list2');
  const { path: p } = deployment.ensure({ home });
  fs.appendFileSync(p, '\n## my-vm — My VM\n- **status:** active\n- **host:** box.local\n');
  const r = deployment.list({ home });
  assert(r.hasConfigured, 'now has a configured method');
  assert(
    r.configured.some((m) => m.id === 'my-vm'),
    'my-vm is in configured',
  );
});

test('show returns one method and throws on unknown', () => {
  const home = freshHome('show');
  const m = deployment.show('aws-ec2', { home });
  assertEqual(m.id, 'aws-ec2');
  assert(m.content.includes('ssh'), 'returns the section body');
  let failed = false;
  try {
    deployment.show('nope', { home });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'unknown id should throw');
});

// --- edit ---
test('edit is a no-op report when non-interactive', () => {
  const home = freshHome('edit');
  const r = deployment.edit({ home, isTTY: false });
  assertEqual(r.opened, false, 'does not spawn an editor headlessly');
  assert(r.path.endsWith('deployment-methods.md'), 'reports the path');
});

test('edit spawns $EDITOR on the file when interactive', () => {
  const home = freshHome('edit2');
  const calls = [];
  const r = deployment.edit({
    home,
    isTTY: true,
    editor: 'fake-ed',
    spawn: (cmd, args) => calls.push([cmd, args]),
  });
  assertEqual(r.opened, true, 'opened');
  assertEqual(calls.length, 1, 'spawned once');
  assertEqual(calls[0][0], 'fake-ed', 'used the chosen editor');
  assert(calls[0][1][0].endsWith('deployment-methods.md'), 'opened the catalog file');
});

// --- per-project access ---
test('init-access ignores the real file, commits a pointer, and is idempotent', () => {
  const cwd = freshProject('init');
  identity.dispatch(['lock', 'Acme App', 'acme-app'], { cwd, owner: 'acme-team' });
  const r = deployment.initAccess(cwd);
  assert(r.gitignoreUpdated, 'gitignore updated');
  assert(r.pointerCreated, 'pointer created');
  assertEqual(r.admin, 'acme-team', 'admin derived from locked identity owner');

  const gi = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
  assert(gi.split('\n').includes('.verity/deploy-access.md'), 'real access file is gitignored');
  const pointer = fs.readFileSync(path.join(cwd, '.verity/deploy-access.README.md'), 'utf8');
  assert(pointer.includes('acme-team'), 'pointer names the admin');
  assert(!pointer.includes('deploy-access.md\n```'), 'pointer carries no secrets');

  const again = deployment.initAccess(cwd);
  assertEqual(again.gitignoreUpdated, false, 'gitignore not double-written');
  assertEqual(again.pointerCreated, false, 'pointer not overwritten');
});

test('access reports presence and points at the admin when missing', () => {
  const cwd = freshProject('access');
  identity.dispatch(['lock', 'Acme App', 'acme-app'], { cwd, owner: 'acme-team' });
  const missing = deployment.accessStatus(cwd);
  assertEqual(missing.present, false, 'absent before the file is shared');
  assert(missing.message.includes('acme-team'), 'directs the teammate to the admin');

  fs.writeFileSync(path.join(cwd, deployment.ACCESS_FILE), 'host: box\n');
  assertEqual(deployment.accessStatus(cwd).present, true, 'present once the file exists');
});

test('init-access works without a locked identity (graceful admin)', () => {
  const cwd = freshProject('noident');
  const r = deployment.initAccess(cwd);
  assert(r.pointerCreated, 'still scaffolds');
  assert(/admin/i.test(r.admin), 'admin falls back to a human-readable hint');
});
