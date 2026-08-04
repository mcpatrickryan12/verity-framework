// Verity core utilities (the seed of the `identity` command, Role 1 / Vision).
//
// validateSlug enforces the UNION of downstream constraints the slug must satisfy,
// because it becomes the identity key threaded through repo name, package name,
// container-registry image path, DNS label, branch names, env names, and secret
// names (see framework-spec.md §4.1). The strictest common denominator is:
// lowercase, hyphen-separated, starts with a letter, no underscores, <= 63 chars.

function validateSlug(slug) {
  const issues = [];
  const s = String(slug ?? '');

  if (s.length === 0) {
    issues.push('empty');
  }
  if (s.length > 63) {
    issues.push('too long (max 63 chars — DNS label limit)');
  }
  if (!/^[a-z]/.test(s)) {
    issues.push('must start with a lowercase letter');
  }
  if (/[A-Z]/.test(s)) {
    issues.push('no uppercase (container/package registries require lowercase)');
  }
  if (s.includes('_')) {
    issues.push('no underscores (DNS/registry-unsafe)');
  }
  if (!/^[a-z0-9-]*$/.test(s)) {
    issues.push('only lowercase letters, digits, and hyphens allowed');
  }
  if (/--/.test(s)) {
    issues.push('no consecutive hyphens');
  }
  if (/-$/.test(s)) {
    issues.push('must not end with a hyphen');
  }

  return { valid: issues.length === 0, issues };
}

// Turn arbitrary text into a slug candidate (lowercase, hyphen-joined, trimmed,
// capped at 63). The result may still fail validateSlug (e.g. a leading digit) —
// the caller validates and surfaces issues; this only proposes.
function generateSlug(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

// Render a template: replace {{key}} (word chars only, no spaces) so GitHub Actions
// ${{ ... }} expressions — which always contain spaces/dots — pass through untouched.
function render(tmpl, vars) {
  return String(tmpl).replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in vars ? String(vars[key] ?? '') : match,
  );
}

module.exports = { validateSlug, generateSlug, render };
