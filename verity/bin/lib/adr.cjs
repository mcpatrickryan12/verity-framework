// Architecture Decision Records — docs/adr/NNNN-slug.md (framework-spec.md §4.3).
// Every architectural decision/deviation is an append-only, numbered ADR.
const fs = require('node:fs');
const path = require('node:path');

const { generateSlug, render } = require('./core.cjs');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'adr.md.tmpl');

function adrDir(cwd) {
  return path.join(cwd, 'docs', 'adr');
}

function nextNumber(cwd) {
  const dir = adrDir(cwd);
  if (!fs.existsSync(dir)) {
    return 1;
  }
  const nums = fs
    .readdirSync(dir)
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .filter((n) => Number.isFinite(n));
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function create(cwd, title, opts = {}) {
  if (!title) {
    throw new Error('adr new requires a title');
  }
  const padded = String(nextNumber(cwd)).padStart(4, '0');
  const slug = generateSlug(title) || 'decision';
  const file = path.join(adrDir(cwd), `${padded}-${slug}.md`);
  fs.mkdirSync(adrDir(cwd), { recursive: true });
  const content = render(fs.readFileSync(TEMPLATE, 'utf8'), {
    number: padded,
    title,
    status: opts.status || 'Proposed',
    date: new Date().toISOString().slice(0, 10),
  });
  fs.writeFileSync(file, content);
  return { number: padded, title, path: file };
}

function list(cwd) {
  const dir = adrDir(cwd);
  const adrs = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.md'))
        .sort()
    : [];
  return { adrs };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'new') {
    return create(cwd, args[1], { status: flags.status });
  }
  if (verb === 'list') {
    return list(cwd);
  }
  throw new Error(`unknown adr verb: ${verb || '(none)'} — use new|list`);
}

module.exports = { adrDir, nextNumber, create, list, dispatch };
