// Verity scaffold — generate a target repo's Layer-1 governance + hygiene files
// from the locked identity manifest (framework-spec.md §6, walking-skeleton plan §6).
// Stack-AGNOSTIC: the emitted CI is the honest hygiene gate (secret-scan + a
// structure check) that's genuinely green on a fresh repo. Lint/test gates are
// added later when the Architect chooses the stack (the progressive gate).
const fs = require('node:fs');
const path = require('node:path');

const identity = require('./identity.cjs');
const config = require('./config.cjs');
const { render } = require('./core.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const FILES = [
  { out: 'README.md', tmpl: 'README.md.tmpl' },
  { out: 'LICENSE', tmpl: 'LICENSE.tmpl' },
  { out: '.gitignore', tmpl: 'gitignore.tmpl' },
  { out: '.github/workflows/ci.yml', tmpl: 'ci.yml.tmpl' },
  { out: '.github/ISSUE_TEMPLATE/bug_report.yml', tmpl: 'bug_report.yml.tmpl' },
  { out: 'STATUS.md', tmpl: 'STATUS.md.tmpl' },
];

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

function init(cwd, opts = {}) {
  const { manifest } = identity.get(cwd); // throws if identity not locked yet
  const owner = manifest.owner || manifest.name || manifest.slug;
  const vars = {
    name: manifest.name,
    slug: manifest.slug,
    owner,
    image_prefix: manifest.image_prefix || '',
    description: opts.description || '',
    year: String(new Date().getFullYear()),
  };

  const created = [];
  const skipped = [];
  for (const file of FILES) {
    const dest = path.join(cwd, file.out);
    if (fs.existsSync(dest) && !opts.force) {
      skipped.push(file.out);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, render(readTemplate(file.tmpl), vars));
    created.push(file.out);
  }

  config.ensure(cwd);
  return { created, skipped, slug: manifest.slug };
}

function dispatch(args, flags) {
  const verb = args[0];
  const cwd = flags.cwd || process.cwd();
  if (verb === 'init') {
    return init(cwd, { description: flags.description, force: Boolean(flags.force) });
  }
  throw new Error(`unknown scaffold verb: ${verb || '(none)'} — use init`);
}

module.exports = { render, init, dispatch, FILES };
