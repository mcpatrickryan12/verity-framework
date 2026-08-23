// Stage 88 (ADR-0030) — the gate-runner catalog (~/.verity/gate-runners.md),
// tested on the deployment.test.cjs pattern: mkdtemp fake homes (the tests
// never read the developer's real ~/.verity), byte-stable message assertions.
// Covers: template seeding (once, idempotent, never clobbers), parse
// round-trips (host/user/status extraction, backtick stripping), the stage-86
// entry-name charset enforced at the heading, list/show/edit/dispatch shapes,
// and resolveRemote's fail-closed refusals (missing file, unknown entry,
// example placeholder, missing host) — each naming the catalog path and the
// known entry names, never credential material.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomy = require('../verity/bin/lib/autonomy.cjs');
const gateRunners = require('../verity/bin/lib/gate-runners.cjs');

function freshHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-gr-${tag}-`));
}

function assertThrows(fn, re, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert(err !== null, `${msg}: expected a throw`);
  assert(re.test(err.message), `${msg}: message ${JSON.stringify(err.message)} matches ${re}`);
  return err;
}

// --- seeding ------------------------------------------------------------------

test('gate-runners: ensure seeds the global catalog once, idempotent, never clobbers', () => {
  const home = freshHome('seed');
  const first = gateRunners.ensure({ home });
  assert(first.created, 'seeded on first run');
  assertEqual(first.path, path.join(home, 'gate-runners.md'), 'lives in the VERITY_HOME dir');
  const seeded = fs.readFileSync(first.path, 'utf8');
  // The template's non-negotiables: the bold locations-never-secrets warning
  // and an example entry that can never resolve as a real host.
  assert(
    seeded.includes('**Reference credential LOCATIONS, never paste secrets.**'),
    'the bold never-secrets warning ships in the template',
  );
  assert(seeded.includes('- **status:** example'), 'the sample entry is status: example');
  fs.writeFileSync(first.path, '# my edits\n');
  const second = gateRunners.ensure({ home });
  assertEqual(second.created, false, 'second run does not clobber');
  assertEqual(fs.readFileSync(first.path, 'utf8'), '# my edits\n', 'user edits preserved');
});

test('gate-runners: globalPath honors the home seam (the deployment homeDir convention)', () => {
  const home = freshHome('path');
  assertEqual(gateRunners.globalPath({ home }), path.join(home, 'gate-runners.md'));
});

// --- parsing ------------------------------------------------------------------

test('gate-runners: parseRunners round-trips entries — host/user/status extracted, backticks and trailing prose stripped, notes stay free-form', () => {
  const text = [
    '# heading prose',
    '## gpu-box — LAN GPU box',
    '- **status:** active',
    '- **host:** `gpu.lan` — only on the VPN',
    '- **user:** ci',
    '- **access:** key at ~/.ssh/gpu-key (location only)',
    '',
    '## alias-only.host_1 — SSH-config alias',
    '- **host:** gpubox-alias',
  ].join('\n');
  const runners = gateRunners.parseRunners(text);
  assertEqual(runners.length, 2, 'two entries');
  const [a, b] = runners;
  assertEqual(a.name, 'gpu-box');
  assertEqual(a.title, 'LAN GPU box');
  assertEqual(a.status, 'active');
  assertEqual(a.host, 'gpu.lan', 'backtick span extracted, trailing prose dropped');
  assertEqual(a.user, 'ci');
  assert(a.content.includes('key at ~/.ssh/gpu-key'), 'free-form notes preserved in content');
  assertEqual(gateRunners.targetFor(a), 'ci@gpu.lan', 'user@host target');
  assertEqual(b.name, 'alias-only.host_1', 'dots/underscores/digits admitted (stage-86 charset)');
  assertEqual(b.status, 'active', 'status defaults to active');
  assertEqual(b.user, null, 'user optional — the alias carries it');
  assertEqual(gateRunners.targetFor(b), 'gpubox-alias', 'bare-host target');
});

test('gate-runners: the stage-86 entry-name charset is enforced at the heading — an invalid name is NOT an entry and never pollutes a neighbor', () => {
  // The charset is single-sourced in autonomy.cjs (GATE_RUNNER_NAME_RE): a
  // name that validates as `remote:<name>` at policy load parses here, and
  // nothing else does.
  assert(autonomy.GATE_RUNNER_NAME_RE.test('gpu-box.lan_1'), 'the shared charset admits the name');
  assert(!autonomy.GATE_RUNNER_NAME_RE.test('has/slash'), 'and rejects an unsafe one');
  const text = [
    '## good — Good',
    '- **host:** good.lan',
    '## bad/slash — Invalid name',
    '- **host:** evil.lan',
    '- **status:** active',
  ].join('\n');
  const runners = gateRunners.parseRunners(text);
  assertEqual(runners.length, 1, 'the invalid-name section is not an entry');
  assertEqual(runners[0].name, 'good');
  // The wrong-machine hazard: the invalid section's host line must NOT have
  // merged into the previous entry (the heading terminates it).
  assertEqual(runners[0].host, 'good.lan', 'the neighbor keeps its own host');
});

// --- list / show / edit / dispatch --------------------------------------------

test('gate-runners: list separates shipped examples from configured runners', () => {
  const home = freshHome('list');
  const first = gateRunners.list({ home });
  assert(
    first.runners.some((r) => r.name === 'gpu-box' && r.status === 'example'),
    'the seeded sample is present as an example',
  );
  assertEqual(first.hasConfigured, false, 'examples do not count as configured');
  fs.appendFileSync(
    path.join(home, 'gate-runners.md'),
    '\n## my-box — My box\n- **status:** active\n- **host:** box.lan\n',
  );
  const second = gateRunners.list({ home });
  assert(second.hasConfigured, 'now has a configured runner');
  assert(
    second.configured.some((r) => r.name === 'my-box'),
    'my-box is in configured',
  );
});

test('gate-runners: show returns one entry and throws on unknown', () => {
  const home = freshHome('show');
  const r = gateRunners.show('gpu-box', { home });
  assertEqual(r.name, 'gpu-box');
  assert(r.content.includes('- **status:** example'), 'returns the section body');
  assertThrows(() => gateRunners.show('nope', { home }), /no such gate runner: nope/, 'unknown');
  assertThrows(() => gateRunners.show(undefined, { home }), /show requires/, 'no name');
});

test('gate-runners: edit reports the path headlessly and spawns $EDITOR when interactive', () => {
  const home = freshHome('edit');
  const headless = gateRunners.edit({ home, isTTY: false });
  assertEqual(headless.opened, false, 'does not spawn an editor headlessly');
  assert(headless.path.endsWith('gate-runners.md'), 'reports the path');
  const calls = [];
  const tty = gateRunners.edit({
    home,
    isTTY: true,
    editor: 'fake-ed',
    spawn: (cmd, args) => calls.push([cmd, args]),
  });
  assertEqual(tty.opened, true);
  assertEqual(calls.length, 1, 'spawned once');
  assertEqual(calls[0][0], 'fake-ed', 'used the chosen editor');
  assert(calls[0][1][0].endsWith('gate-runners.md'), 'opened the catalog file');
});

test('gate-runners: dispatch shapes mirror verity deployment (list|show|path|edit|ensure; unknown verb throws)', () => {
  const home = freshHome('dispatch');
  const flags = { home };
  assert(Array.isArray(gateRunners.dispatch(['list'], flags).runners), 'list');
  assertEqual(gateRunners.dispatch(['show', 'gpu-box'], flags).name, 'gpu-box', 'show');
  assertEqual(
    gateRunners.dispatch(['path'], flags).raw,
    path.join(home, 'gate-runners.md'),
    'path (raw for pipe-safety)',
  );
  assertEqual(gateRunners.dispatch(['ensure'], flags).created, false, 'ensure idempotent');
  assertThrows(
    () => gateRunners.dispatch(['bogus'], flags),
    /unknown gate-runners verb: bogus — use list\|show\|path\|edit\|ensure/,
    'unknown verb',
  );
  assertThrows(
    () => gateRunners.dispatch([], flags),
    /unknown gate-runners verb: \(none\)/,
    'none',
  );
});

// --- resolution: fail-closed at preflight -------------------------------------

const CATALOG = [
  '## gpu-box — GPU box',
  '- **status:** active',
  '- **host:** gpu.lan',
  '- **user:** ci',
  '- **access:** key at ~/.ssh/secret-key.pem (location only)',
  '',
  '## hostless — Broken entry',
  '- **status:** active',
  '',
  '## placeholder — Still a sample',
  '- **status:** example',
  '- **host:** `<hostname>`',
].join('\n');

function resolvableHome() {
  const home = freshHome('resolve');
  fs.writeFileSync(path.join(home, 'gate-runners.md'), CATALOG);
  return home;
}

test('gate-runners: resolveRemote returns the SSH target descriptor for a configured entry — and never echoes credential locations', () => {
  const home = resolvableHome();
  const r = gateRunners.resolveRemote('gpu-box', { home });
  assertEqual(r.name, 'gpu-box');
  assertEqual(r.host, 'gpu.lan');
  assertEqual(r.user, 'ci');
  assertEqual(r.target, 'ci@gpu.lan');
  assertEqual(r.path, path.join(home, 'gate-runners.md'));
  // The descriptor carries name/host/user/target/path and NOTHING from the
  // notes: credential locations never leave the operator's own file.
  assert(!JSON.stringify(r).includes('secret-key'), 'no credential material in the descriptor');
});

test('gate-runners: missing catalog file ⇒ byte-stable fail-closed error naming the catalog path', () => {
  const home = freshHome('nofile');
  const catalog = path.join(home, 'gate-runners.md');
  const err = assertThrows(
    () => gateRunners.resolveRemote('gpu-box', { home }),
    /no gate-runner catalog/,
    'missing file',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-box': no gate-runner catalog at ${catalog} — seed and edit it with \`verity gate-runners edit\`, adding a '## gpu-box — <title>' entry (ADR-0030: names resolve against the global catalog at preflight, never mid-run); no gates ran and no record is written`,
    'byte-stable',
  );
});

test('gate-runners: unknown entry ⇒ byte-stable fail-closed error naming the KNOWN entry names', () => {
  const home = resolvableHome();
  const catalog = path.join(home, 'gate-runners.md');
  const err = assertThrows(
    () => gateRunners.resolveRemote('gpu-boxx', { home }),
    /no entry named 'gpu-boxx'/,
    'typo',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:gpu-boxx': no entry named 'gpu-boxx' in the gate-runner catalog ${catalog} — known entries: gpu-box, hostless, placeholder; fix the name in .verity/autonomy.yml or add the entry with \`verity gate-runners edit\` (ADR-0030); no gates ran and no record is written`,
    'byte-stable, names every entry the file knows',
  );
  assert(!err.message.includes('secret-key'), 'no credential material in the error');
  // An EMPTY catalog says so instead of listing nothing-shaped text.
  const empty = freshHome('empty');
  fs.writeFileSync(path.join(empty, 'gate-runners.md'), '# nothing yet\n');
  const none = assertThrows(
    () => gateRunners.resolveRemote('gpu-box', { home: empty }),
    /known entries: \(none\)/,
    'empty catalog',
  );
  assert(none.message.includes(path.join(empty, 'gate-runners.md')), 'still names the path');
});

test('gate-runners: an example-status entry never resolves (the shipped placeholder is not a host)', () => {
  const home = resolvableHome();
  const catalog = path.join(home, 'gate-runners.md');
  const err = assertThrows(
    () => gateRunners.resolveRemote('placeholder', { home }),
    /still '- \*\*status:\*\* example'/,
    'example entry',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:placeholder': entry 'placeholder' in ${catalog} is still '- **status:** example' — a shipped placeholder never resolves as a real host (fail closed); set a real host and '- **status:** active' with \`verity gate-runners edit\``,
    'byte-stable',
  );
});

test('gate-runners: an entry with no host line refuses — the SSH target must come from the catalog', () => {
  const home = resolvableHome();
  const catalog = path.join(home, 'gate-runners.md');
  const err = assertThrows(
    () => gateRunners.resolveRemote('hostless', { home }),
    /has no '- \*\*host:\*\*/,
    'hostless entry',
  );
  assertEqual(
    err.message,
    `gate_runner 'remote:hostless': entry 'hostless' in ${catalog} has no '- **host:** <hostname-or-ssh-config-alias>' line — the SSH target must come from the catalog, never the repo (ADR-0030); add one with \`verity gate-runners edit\``,
    'byte-stable',
  );
});

test('gate-runners stage 90: an option-shaped host or user refuses at resolution — ssh must never parse the target as an option', () => {
  // Every consumer puts the resolved target in `ssh -o BatchMode=yes
  // <target> …` argv, where OpenSSH parses a leading-'-' value as an option
  // (e.g. '-oProxyCommand=…' runs a command). The refusal lives at the
  // resolveRemote chokepoint; parsing stays permissive so list/show still
  // surface the entry for the operator to fix.
  const home = freshHome('optshape');
  const catalog = path.join(home, 'gate-runners.md');
  fs.writeFileSync(
    catalog,
    [
      '## opt-host — Option-shaped host',
      '- **status:** active',
      '- **host:** -oProxyCommand=evil',
      '',
      '## opt-user — Option-shaped user',
      '- **status:** active',
      '- **host:** gpu.lan',
      '- **user:** -l',
      '',
      '## fine — Healthy neighbor',
      '- **status:** active',
      '- **host:** gpu.lan',
      '- **user:** ci',
      '',
    ].join('\n'),
  );
  const hostErr = assertThrows(
    () => gateRunners.resolveRemote('opt-host', { home }),
    /beginning with '-'/,
    'option-shaped host',
  );
  assertEqual(
    hostErr.message,
    `gate_runner 'remote:opt-host': entry 'opt-host' in ${catalog} has '- **host:** -oProxyCommand=evil' beginning with '-' — ssh would parse it as an option, not a target (fail closed); fix the host with \`verity gate-runners edit\``,
    'byte-stable, names the entry and the offending field',
  );
  const userErr = assertThrows(
    () => gateRunners.resolveRemote('opt-user', { home }),
    /beginning with '-'/,
    'option-shaped user',
  );
  assertEqual(
    userErr.message,
    `gate_runner 'remote:opt-user': entry 'opt-user' in ${catalog} has '- **user:** -l' beginning with '-' — ssh would parse it as an option, not a target (fail closed); fix the user with \`verity gate-runners edit\``,
    'byte-stable, names the entry and the offending field',
  );
  // A well-formed neighbor in the same catalog still resolves (no behavior
  // change on the healthy path).
  assertEqual(
    gateRunners.resolveRemote('fine', { home }).target,
    'ci@gpu.lan',
    'neighbor resolves',
  );
  // list/show still render the bad entries — the operator must be able to
  // SEE what to fix; only resolution refuses.
  const names = gateRunners.list({ home }).runners.map((r) => r.name);
  assert(names.includes('opt-host') && names.includes('opt-user'), `list renders them: ${names}`);
  assertEqual(
    gateRunners.show('opt-host', { home }).host,
    '-oProxyCommand=evil',
    'show renders it',
  );
});
