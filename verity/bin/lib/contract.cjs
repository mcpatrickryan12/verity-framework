// Interface contracts — contracts/<name>.md (framework-spec.md §4.3).
// Contracts are MANDATES, frozen early. A change is ADDITIVE only; a breaking
// change is a NEW contract, not an edit — so `new` refuses to overwrite.
const fs = require('node:fs');
const path = require('node:path');

const { validateSlug, render } = require('./core.cjs');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'contract.md.tmpl');

function contractsDir(cwd) {
  return path.join(cwd, 'contracts');
}

function create(cwd, name) {
  if (!name) {
    throw new Error('contract new requires a name');
  }
  const v = validateSlug(name);
  if (!v.valid) {
    throw new Error(`invalid contract name "${name}": ${v.issues.join('; ')}`);
  }
  const file = path.join(contractsDir(cwd), `${name}.md`);
  if (fs.existsSync(file)) {
    throw new Error(
      `contract "${name}" already exists — contracts are frozen; a change is a NEW contract, not an edit`,
    );
  }
  fs.mkdirSync(contractsDir(cwd), { recursive: true });
  fs.writeFileSync(file, render(fs.readFileSync(TEMPLATE, 'utf8'), { name }));
  return { name, path: file };
}

function list(cwd) {
  const dir = contractsDir(cwd);
  const contracts = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.md'))
        .sort()
    : [];
  return { contracts };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'new') {
    return create(cwd, args[1]);
  }
  if (verb === 'list') {
    return list(cwd);
  }
  throw new Error(`unknown contract verb: ${verb || '(none)'} — use new|list`);
}

module.exports = { contractsDir, create, list, dispatch };
