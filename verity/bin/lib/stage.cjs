// Stage instructions — stage-instructions/stage-N-slug.md (framework-spec.md §6,
// Intake/Planner). This is the ONLY place stages are born. Acceptance conditions are
// pre-filled by work-type so the two biggest interview gaps (kill-switch + UI-smoke)
// can't be forgotten on a feature.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { generateSlug, render } = require('./core.cjs');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'stage.md.tmpl');
const TYPES = new Set(['feature', 'bug', 'chore']);

function stageDir(cwd) {
  return path.join(cwd, 'stage-instructions');
}

function stageNum(name) {
  const m = name.match(/^stage-(\d+)-/);
  return m ? Number(m[1]) : 0;
}

function nextNumber(cwd) {
  const dir = stageDir(cwd);
  if (!fs.existsSync(dir)) {
    return 1;
  }
  const nums = fs
    .readdirSync(dir)
    .map(stageNum)
    .filter((n) => n > 0);
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function acceptanceFor(type) {
  const suiteGreen = '- [ ] Existing suite stays green; CI all-green';
  if (type === 'bug') {
    return [
      '- [ ] Reproduction captured + a regression test (fails before, passes after)',
      suiteGreen,
    ].join('\n');
  }
  if (type === 'chore') {
    return ['- [ ] Clear exit-state defined (what "done" means here)', suiteGreen].join('\n');
  }
  // feature (default) — the two interview gaps baked in:
  return [
    '- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature',
    '- [ ] UI-smoke "observably-works" check authored for any user-facing surface',
    '- [ ] Additive migration only (no destructive schema change)',
    suiteGreen,
  ].join('\n');
}

function create(cwd, title, opts = {}) {
  if (!title) {
    throw new Error('stage new requires a title');
  }
  const type = opts.type || 'feature';
  if (!TYPES.has(type)) {
    throw new Error(`unknown stage type "${type}" — use feature|bug|chore`);
  }
  const num = nextNumber(cwd);
  const slug = generateSlug(title) || 'stage';
  const rel = path.join('stage-instructions', `stage-${num}-${slug}.md`);
  const file = path.join(cwd, rel);
  fs.mkdirSync(stageDir(cwd), { recursive: true });
  fs.writeFileSync(
    file,
    render(fs.readFileSync(TEMPLATE, 'utf8'), {
      number: String(num),
      title,
      type,
      depends_on: opts.dependsOn || 'none',
      acceptance: acceptanceFor(type),
    }),
  );
  // Suggested GitHub work-item the Planner opens for traceability (issue <-> stage <-> PR).
  const issue = {
    title: `[stage ${num}] ${title}`,
    labels: [type, 'needs-triage'],
    body: `Stage ${num} (${type}) — see \`${rel}\`.`,
  };
  return { number: num, slug, type, path: file, rel, issue };
}

function list(cwd) {
  const dir = stageDir(cwd);
  const stages = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.md'))
        .sort((a, b) => stageNum(a) - stageNum(b))
    : [];
  return { stages };
}

// --- Stage Manager acts (branch / PR) ---

function findStageFile(cwd, n) {
  const dir = stageDir(cwd);
  if (!fs.existsSync(dir)) {
    return null;
  }
  return fs.readdirSync(dir).find((name) => stageNum(name) === n) || null;
}

function branchName(cwd, n) {
  const file = findStageFile(cwd, n);
  if (!file) {
    throw new Error(`no stage ${n}`);
  }
  const slug = file.replace(/^stage-\d+-/, '').replace(/\.md$/, '');
  return `feat/stage-${n}-${slug}`;
}

function acceptanceText(cwd, n) {
  const file = findStageFile(cwd, n);
  if (!file) {
    throw new Error(`no stage ${n}`);
  }
  const text = fs.readFileSync(path.join(stageDir(cwd), file), 'utf8');
  const m = text.match(/##\s+Acceptance conditions\s*\n([\s\S]*?)(?:\n##\s|$)/);
  return (m ? m[1] : '').trim();
}

function prSpec(cwd, n, opts = {}) {
  const file = findStageFile(cwd, n);
  if (!file) {
    throw new Error(`no stage ${n}`);
  }
  const text = fs.readFileSync(path.join(stageDir(cwd), file), 'utf8');
  const title = (text.match(/^#\s+Stage\s+\d+:\s+(.+)$/m) || [])[1] || `stage ${n}`;
  const closes = opts.issue ? `\n\nCloses #${opts.issue}` : '';
  const body = `Stage ${n}.\n\n### Acceptance conditions\n${acceptanceText(cwd, n)}${closes}`;
  return { title: `[stage ${n}] ${title.trim()}`, body, branch: branchName(cwd, n) };
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'new') {
    return create(cwd, args[1], { type: flags.type, dependsOn: flags['depends-on'] });
  }
  if (verb === 'list') {
    return list(cwd);
  }
  if (verb === 'branch') {
    const name = branchName(cwd, Number(args[1]));
    if (!flags['dry-run']) {
      run('git', ['-C', cwd, 'checkout', '-b', name], cwd);
    }
    return { branch: name, created: !flags['dry-run'], raw: name };
  }
  if (verb === 'pr') {
    const spec = prSpec(cwd, Number(args[1]), { issue: flags.issue });
    if (!flags['dry-run']) {
      run('gh', ['pr', 'create', '--title', spec.title, '--body', spec.body], cwd);
    }
    return { ...spec, opened: !flags['dry-run'] };
  }
  throw new Error(`unknown stage verb: ${verb || '(none)'} — use new|list|branch|pr`);
}

module.exports = {
  stageDir,
  nextNumber,
  acceptanceFor,
  create,
  list,
  findStageFile,
  branchName,
  acceptanceText,
  prSpec,
  dispatch,
};
