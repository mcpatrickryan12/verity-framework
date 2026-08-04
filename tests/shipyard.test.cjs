const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const release = require('../verity/bin/lib/release.cjs');
const status = require('../verity/bin/lib/status.cjs');

function fresh(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`));
}

// --- release: version derived from tag ---
test('nextVersion bumps patch/minor/major from the latest tag', () => {
  assertEqual(release.nextVersion('v1.2.3', 'patch'), '1.2.4');
  assertEqual(release.nextVersion('v1.2.3', 'minor'), '1.3.0');
  assertEqual(release.nextVersion('v1.2.3', 'major'), '2.0.0');
});

test('nextVersion starts at 0.0.1 with no prior tag', () => {
  assertEqual(release.nextVersion(null, 'patch'), '0.0.1');
});

// --- release: changelog from Conventional Commits ---
test('changelogFrom groups Conventional Commits', () => {
  const log = release.changelogFrom(
    ['feat: profiles', 'fix(auth): token bug', 'chore: bump', 'random note'],
    '0.2.0',
  );
  assert(log.includes('## 0.2.0'), 'version header');
  assert(log.includes('### Features') && log.includes('- profiles'), 'features grouped');
  assert(log.includes('### Fixes') && log.includes('- token bug'), 'fixes grouped');
  assert(log.includes('### Other') && log.includes('- random note'), 'non-conventional -> Other');
});

test('cut --dry-run computes version + changelog without tagging (injected tags/commits)', () => {
  const r = release.cut(fresh('rel'), {
    tags: ['v0.1.0', 'v0.1.5'],
    commits: ['feat: a', 'fix: b'],
    dryRun: true,
  });
  assertEqual(r.previous, 'v0.1.5');
  assertEqual(r.version, '0.1.6');
  assertEqual(r.applied, false);
  assert(r.changelog.includes('### Features'), 'changelog generated');
});

// --- release: side effects are transactional (tag → changelog → push, with rollback) ---
test('cut applies in order: tag, changelog written, then push', () => {
  const d = fresh('rel-apply');
  const calls = [];
  const r = release.cut(d, {
    tags: ['v0.1.0'],
    commits: ['feat: a'],
    run: (cmd, args) => calls.push([cmd, ...args].join(' ')),
  });
  assertEqual(r.applied, true);
  assertEqual(r.tag, 'v0.1.1');
  // tag before push
  const tagIdx = calls.findIndex((c) => c.includes('tag v0.1.1'));
  const pushIdx = calls.findIndex((c) => c.includes('push origin v0.1.1'));
  assert(tagIdx >= 0 && pushIdx > tagIdx, 'tags before pushing');
  assert(
    fs.readFileSync(path.join(d, 'CHANGELOG.md'), 'utf8').includes('## 0.1.1'),
    'changelog written',
  );
});

test('cut rolls back tag + changelog when push fails (no prior CHANGELOG)', () => {
  const d = fresh('rel-rollback');
  const calls = [];
  let threw = false;
  try {
    release.cut(d, {
      tags: [],
      commits: ['feat: a'],
      run: (cmd, args) => {
        const line = [cmd, ...args].join(' ');
        calls.push(line);
        if (line.includes('push')) {
          throw new Error('network down');
        }
      },
    });
  } catch (_e) {
    threw = true;
  }
  assert(threw, 'push failure surfaces as an error');
  assert(
    !fs.existsSync(path.join(d, 'CHANGELOG.md')),
    'CHANGELOG.md removed on rollback (did not exist before)',
  );
  assert(
    calls.some((c) => c.includes('tag -d v0.0.1')),
    'the tag is deleted on rollback',
  );
});

test('cut restores a pre-existing CHANGELOG.md exactly on push failure', () => {
  const d = fresh('rel-restore');
  const original = '# Changelog\n\n## 0.0.1\n\n### Features\n- old\n';
  fs.writeFileSync(path.join(d, 'CHANGELOG.md'), original);
  try {
    release.cut(d, {
      tags: ['v0.0.1'],
      commits: ['feat: new'],
      run: (cmd, args) => {
        if ([cmd, ...args].join(' ').includes('push')) {
          throw new Error('rejected');
        }
      },
    });
  } catch (_e) {
    /* expected */
  }
  assertEqual(
    fs.readFileSync(path.join(d, 'CHANGELOG.md'), 'utf8'),
    original,
    'changelog restored byte-for-byte',
  );
});

// --- status: runtime truth artifact ---
test('status set writes runtime.json and renders STATUS.md', () => {
  const d = fresh('status');
  status.set(d, 'version', '0.4.2');
  assertEqual(status.read(d).version, '0.4.2');
  const md = fs.readFileSync(path.join(d, 'STATUS.md'), 'utf8');
  assert(md.includes('0.4.2'), 'STATUS.md reflects the version');
  assert(md.includes('Secret locations'), 'has the secrets section');
});

test('status set supports dot-path (environments.prod.digest)', () => {
  const d = fresh('status2');
  status.set(d, 'environments.prod.digest', 'sha256:abc');
  assertEqual(status.read(d).environments.prod.digest, 'sha256:abc');
});

test('status secret appends a LOCATION (never a value)', () => {
  const d = fresh('status3');
  status.append(d, 'secret_locations', 'JWT_SECRET @ VM1:/opt/app/.env.prod');
  const md = fs.readFileSync(path.join(d, 'STATUS.md'), 'utf8');
  assert(md.includes('JWT_SECRET @ VM1'), 'secret location rendered');
  assert(!md.includes('(none)\n- (none)'), 'secrets section populated');
});
