// Technical Writer (framework-spec.md §6, Role 13) — handoff briefs in docs/handoff/.
// The brief's highest-leverage element is the "settled decisions — do NOT re-litigate"
// section (H6); the reading-order README is what makes zero-setup rejoin real (H5).
const fs = require('node:fs');
const path = require('node:path');

const { validateSlug, render } = require('./core.cjs');

const README_TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'handoff-readme.md.tmpl');
const BRIEF_TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'handoff-brief.md.tmpl');

function handoffDir(cwd) {
  return path.join(cwd, 'docs', 'handoff');
}

function ensureReadme(cwd) {
  const p = path.join(handoffDir(cwd), 'README.md');
  if (fs.existsSync(p)) {
    return { created: false, path: p };
  }
  fs.mkdirSync(handoffDir(cwd), { recursive: true });
  fs.writeFileSync(p, fs.readFileSync(README_TEMPLATE, 'utf8'));
  return { created: true, path: p };
}

function create(cwd, slug, opts = {}) {
  if (!slug) {
    throw new Error('handoff new requires a slug');
  }
  const v = validateSlug(slug);
  if (!v.valid) {
    throw new Error(`invalid handoff slug "${slug}": ${v.issues.join('; ')}`);
  }
  ensureReadme(cwd);
  const p = path.join(handoffDir(cwd), `${slug}.md`);
  if (fs.existsSync(p) && !opts.force) {
    throw new Error(`handoff brief "${slug}" already exists`);
  }
  fs.writeFileSync(
    p,
    render(fs.readFileSync(BRIEF_TEMPLATE, 'utf8'), { slug, title: opts.title || slug }),
  );
  return { created: true, path: p };
}

function list(cwd) {
  const dir = handoffDir(cwd);
  const briefs = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.md') && n !== 'README.md')
        .sort()
    : [];
  return { briefs };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'new') {
    return create(cwd, args[1], { title: flags.title, force: Boolean(flags.force) });
  }
  if (verb === 'list') {
    return list(cwd);
  }
  if (verb === 'readme') {
    return ensureReadme(cwd);
  }
  throw new Error(`unknown handoff verb: ${verb || '(none)'} — use new|list|readme`);
}

module.exports = { handoffDir, ensureReadme, create, list, dispatch };
