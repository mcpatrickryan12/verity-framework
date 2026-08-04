// SRE (framework-spec.md §6, Role 10) — recovery-plan.md scaffold. Steady-state
// readiness (rollback/restore drills, backup contract, intermittent-env, secret
// rotation), distinct from the Operator's deploy act.
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'recovery-plan.md.tmpl');

function planPath(cwd) {
  return path.join(cwd, 'recovery-plan.md');
}

function init(cwd, opts = {}) {
  const p = planPath(cwd);
  if (fs.existsSync(p) && !opts.force) {
    return { created: false, path: p };
  }
  fs.writeFileSync(p, fs.readFileSync(TEMPLATE, 'utf8'));
  return { created: true, path: p };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'init') {
    return init(cwd, { force: Boolean(flags.force) });
  }
  if (verb === 'show') {
    if (!fs.existsSync(planPath(cwd))) {
      throw new Error('no recovery-plan.md — run `verity recovery init`');
    }
    return { path: planPath(cwd), content: fs.readFileSync(planPath(cwd), 'utf8') };
  }
  throw new Error(`unknown recovery verb: ${verb || '(none)'} — use init|show`);
}

module.exports = { planPath, init, dispatch };
