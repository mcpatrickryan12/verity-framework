// Security Auditor (framework-spec.md §6, Role 12). DEFINES the invariants; the
// Reviewer ENFORCES them per-PR. The invariants live in docs/security-invariants.md
// (committed, canonical) and are read by `review checklist`.
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'security-invariants.md.tmpl');

function invariantsPath(cwd) {
  return path.join(cwd, 'docs', 'security-invariants.md');
}

function init(cwd, opts = {}) {
  const p = invariantsPath(cwd);
  if (fs.existsSync(p) && !opts.force) {
    return { created: false, path: p };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, fs.readFileSync(TEMPLATE, 'utf8'));
  return { created: true, path: p };
}

function read(cwd) {
  const p = invariantsPath(cwd);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'init') {
    return init(cwd, { force: Boolean(flags.force) });
  }
  if (verb === 'show') {
    const content = read(cwd);
    if (!content) {
      throw new Error('no docs/security-invariants.md — run `verity security init`');
    }
    return { path: invariantsPath(cwd), content };
  }
  throw new Error(`unknown security verb: ${verb || '(none)'} — use init|show`);
}

module.exports = { invariantsPath, init, read, dispatch };
