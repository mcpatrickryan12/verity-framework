// Verity identity manifest — `.verity/identity.json` (framework-spec.md §4.1).
// The slug is the identity key threaded through repo/package/image/dns/env/secret
// names. It is LOCKED ONCE and immutable; renaming later is a migration, not an edit.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { validateSlug } = require('./core.cjs');

function manifestPath(cwd) {
  return path.join(cwd, '.verity', 'identity.json');
}

// Default command runner: exit 0 → { ok: true }, anything else → { ok: false }.
// Injectable so availability checks (which shell out to gh/npm) stay unit-testable.
function defaultRun(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Best-effort availability: a successful lookup means the name is TAKEN.
// Caveat: a network/auth failure also returns non-zero, so "available" can be a
// false positive — surfaced as best-effort, not a guarantee.
function checkAvailability(slug, opts) {
  const run = opts.run || defaultRun;
  const checks = {};
  checks.npm = { available: !run('npm', ['view', slug, 'version']).ok };
  if (opts.owner) {
    checks.github = {
      available: !run('gh', ['repo', 'view', `${opts.owner}/${slug}`]).ok,
    };
  }
  return checks;
}

function check(slug, opts = {}) {
  const validation = validateSlug(slug);
  const availability = validation.valid ? checkAvailability(slug, opts) : {};
  const values = Object.values(availability).map((c) => c.available);
  const available = values.length > 0 ? values.every(Boolean) : null;
  return {
    slug,
    valid: validation.valid,
    issues: validation.issues,
    availability,
    available,
  };
}

function lock(cwd, opts) {
  const { name, slug, owner, force } = opts;
  const p = manifestPath(cwd);
  if (fs.existsSync(p) && !force) {
    throw new Error(
      `identity already locked at ${p} — renaming is a migration, not an edit (use --force to override)`,
    );
  }
  const v = validateSlug(slug);
  if (!v.valid) {
    throw new Error(`invalid slug "${slug}": ${v.issues.join('; ')}`);
  }
  const manifest = {
    version: '1.0',
    name: name || slug,
    slug,
    owner: owner || null,
    image_prefix: owner ? `ghcr.io/${owner}/${slug}` : null,
    locked_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`);
  return { locked: true, path: p, manifest };
}

function get(cwd, key) {
  const p = manifestPath(cwd);
  if (!fs.existsSync(p)) {
    throw new Error(`no identity manifest at ${p} — run 'verity identity lock' first`);
  }
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!key) {
    return { manifest };
  }
  const value = manifest[key];
  return { key, value, raw: value === null || value === undefined ? '' : String(value) };
}

function dispatch(args, flags) {
  const verb = args[0];
  const cwd = flags.cwd || process.cwd();
  if (verb === 'check') {
    return check(args[1], { owner: flags.owner });
  }
  if (verb === 'lock') {
    return lock(cwd, {
      name: args[1],
      slug: args[2],
      owner: flags.owner,
      force: Boolean(flags.force),
    });
  }
  if (verb === 'get') {
    return get(cwd, args[1]);
  }
  throw new Error(`unknown identity verb: ${verb || '(none)'} — use check|lock|get`);
}

module.exports = { manifestPath, check, checkAvailability, lock, get, dispatch };
