// Stage 35 — the copied engine must be self-contained: NO module/file
// resolution above the engine root in the deployed `verity/` subtree.
//
// The engine is deployed to ~/.claude/verity / ~/.agents/verity as ONLY the
// `verity/` subtree (install.cjs copyInternals). The repo-root package.json is
// NOT copied, so a top-level `require('../../../package.json')` — which Node
// resolves at MODULE LOAD — threw `Cannot find module` on EVERY command from a
// copied engine (canary run 5, defect N6: `verity review checklist 2 5` → rc 1,
// after which the review role silently hand-rebuilt its checklist). These two
// guards keep the subtree self-contained: a static escape scan, and a
// copy-layout smoke run of the role-facing CLI. Stage 46: the smoke runs
// (copy-layout + stale-copy) depend on THIS repo's stage-instructions/ as cwd
// context, so they live in the private tests/dev-repo-context.test.cjs; the
// static escape scan and the engine-meta sync guard stay here, public.
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const VERITY_ROOT = path.join(REPO_ROOT, 'verity');

// --- guard 1: static escape scan -------------------------------------------------
//
// Walk every *.cjs under verity/ and flag any relative path that resolves ABOVE
// the engine root — in a `require(...)` literal (the crash class: Node resolves
// it at load) or in a `path.join(__dirname, '..', ...)` climb (fs/path reads).
// A file's `..`-budget is its directory depth below verity/: a path that climbs
// past verity/ is an escape.

function listCjs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listCjs(full));
    } else if (entry.name.endsWith('.cjs')) {
      out.push(full);
    }
  }
  return out;
}

// Does `resolved` sit outside the engine root?
function escapesRoot(resolved) {
  return resolved !== VERITY_ROOT && !resolved.startsWith(VERITY_ROOT + path.sep);
}

// Strip comments so the guard scans CODE, not prose — the fix's own comments
// legitimately mention the old `require('../../../package.json')` they removed,
// and a commented-out escape is not a real escape. Block comments first, then
// line comments (preserving `://` so URLs survive).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function findEscapes(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const fileDir = path.dirname(file);
  const escapes = [];

  // (a) require('<relative>') — resolve the literal against the file's dir.
  const reqRe = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const m of src.matchAll(reqRe)) {
    const arg = m[2];
    if (arg.startsWith('.') && arg.includes('..') && escapesRoot(path.resolve(fileDir, arg))) {
      escapes.push({ kind: 'require', text: `require('${arg}')` });
    }
  }

  // (b) path.join/resolve(__dirname, '..', '..', ...) — count the leading run
  //     of '..' segments and compare to the file's depth below verity/.
  const depth = path.relative(VERITY_ROOT, fileDir).split(path.sep).filter(Boolean).length;
  const climbRe = /__dirname((?:\s*,\s*(['"])\.\.\2)+)/g;
  for (const m of src.matchAll(climbRe)) {
    const climbs = (m[1].match(/\.\./g) || []).length;
    if (climbs > depth) {
      escapes.push({ kind: 'path-climb', text: `__dirname + ${climbs}×'..'` });
    }
  }
  return escapes;
}

// Explicit, narrow allowlist — ONLY lazy `path.join` climbs that read role/
// template SOURCE from the FULL npm package / checkout, where `commands/` is a
// sibling of `verity/`. These code paths never run from the copied fallback
// subtree: install.cjs CREATES the copies (a copy never re-installs); agent-exec
// is the headless worker's tool, invoked from the global `verity-framework`
// package (npm i -g) whose layout has commands/ beside verity/, never from a
// skill's engine-fallback; doctor's packagedRoleCount counts packaged roles the
// same way, only for the codex environment report. None is an eager `require`,
// none resolves at load, and none crashes — so none is the stage-35 defect.
// Keyed on (file, kind='path-climb'): a require escape is NEVER exempt, so a new
// above-root `require` in any of these files still fails the guard.
const ALLOWED_PATH_CLIMBS = new Set([
  'bin/lib/install.cjs',
  'bin/lib/agent-exec.cjs',
  'bin/lib/doctor.cjs',
]);

test('escape scan: no verity/ source resolves modules or files above the engine root', () => {
  const offenders = [];
  for (const file of listCjs(VERITY_ROOT)) {
    const rel = path.relative(VERITY_ROOT, file).split(path.sep).join('/');
    for (const esc of findEscapes(file)) {
      const exempt = esc.kind === 'path-climb' && ALLOWED_PATH_CLIMBS.has(rel);
      if (!exempt) {
        offenders.push(`${rel}: ${esc.text}`);
      }
    }
  }
  assertEqual(
    offenders.length,
    0,
    `above-root escapes in the deployed subtree (each reads above verity/, which a copy has not got):\n  ${offenders.join('\n  ')}`,
  );
});

// --- sync guard: engine-meta.json cannot drift from package.json -----------------
//
// engine-meta.json is the embedded, in-subtree copy of the version floors the
// escapes used to fetch. It is stamped from package.json at install/copy time
// AND committed in the checkout; this asserts the committed copy matches, so a
// package.json bump that forgets to re-stamp fails CI instead of shipping stale
// floors. Regenerate with `npm run stamp-meta`.
test('sync: verity/engine-meta.json mirrors package.json version + verity block', () => {
  const pkg = require('../package.json');
  const meta = require('../verity/engine-meta.json');
  assertEqual(meta.version, pkg.version, 'version must match package.json');
  assertEqual(
    JSON.stringify(meta.verity),
    JSON.stringify(pkg.verity),
    'verity block must match package.json (run `npm run stamp-meta`)',
  );
});
