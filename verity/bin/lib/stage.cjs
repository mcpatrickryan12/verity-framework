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

// Derive the GitHub work-item payload for an EXISTING stage file — the same
// shape create() computes for a NEW stage ({ title, labels, body }), but read
// back from a stage-instructions/ file already on disk. This is what the
// worker's work-item reconciliation (ADR-0026, #176) uses: the worker, not the
// contained plan agent (whose github_write is denied), registers the `[stage N]`
// issue. `fileName` is a bare basename as returned by list(); returns null for a
// name that carries no stage number.
function issueFor(cwd, fileName) {
  const num = stageNum(fileName);
  if (num <= 0) {
    return null;
  }
  const rel = path.join('stage-instructions', fileName);
  const text = fs.readFileSync(path.join(cwd, rel), 'utf8');
  const title = (text.match(/^#\s+Stage\s+\d+:\s+(.+)$/m) || [])[1] || fileName;
  const type = (text.match(/\*\*Type:\*\*\s*(\w+)/) || [])[1] || 'feature';
  return {
    number: num,
    title: `[stage ${num}] ${title.trim()}`,
    labels: [type, 'needs-triage'],
    // Mirrors create()'s body, plus the `refs stage N` traceability the old
    // inline `gh issue create` carried (ADR-0026 "What to build").
    body: `Stage ${num} (${type}) — see \`${rel}\`.\n\nrefs stage ${num}`,
  };
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

// A git PROBE, judged by exit code with nothing inherited: run() above streams
// everything to the operator, which is right for the acts themselves (checkout)
// but wrong for existence/count reads whose failure is an answer, not an error.
// Returns stdout on success, null on any failure.
function gitProbe(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

// Create — or re-check-out — the stage branch. Stage 78: a NEW branch forks off
// the SAME base the codex/git-lifecycle path resolves (stage 77's fetch +
// resolveBase ladder), never off whatever HEAD happens to be. Branching off
// HEAD is the defect: under a build-through where the agent itself runs
// `verity stage branch` (build.md step 2), every stage after the first forked
// off a base missing its just-merged predecessors, re-implemented them, and
// landed a CONFLICTING PR (run a-20260813-223153). One resolver, both paths —
// so the interactive/claude base and the Verity-performed base cannot drift.
function branchAct(cwd, name) {
  // Lazy require, NOT top-level: git-lifecycle.cjs requires stage.cjs at its
  // own top level, so requiring it back from here at load time is a CJS cycle —
  // git-lifecycle would capture this module's not-yet-populated exports object
  // and every stage.* call inside it would fail. By the time the branch verb
  // runs, both modules are fully loaded and the require is safe.
  const lifecycle = require('./agents/git-lifecycle.cjs');
  if (gitProbe(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null) {
    // Existing branch → plain checkout, mirroring git-lifecycle's begin():
    // re-dispatch while driving CI to green must not fail on "branch already
    // exists", and must never silently re-base a branch that already has a
    // base — so no fetch and no base resolution on this path.
    run('git', ['-C', cwd, 'checkout', name], cwd);
    return { branch: name, created: false, raw: name, base: null, baseFrom: null };
  }
  // Best-effort refresh of the remote-tracking refs so the base resolved below
  // reflects just-merged predecessor stages. Never fatal — fetchBase logs its
  // own note and the pre-fetch refs are the graceful offline fallback.
  lifecycle.fetchBase(cwd, lifecycle.DEFAULT_REMOTE);
  const startRef = lifecycle.currentRef(cwd);
  const { base, from } = lifecycle.resolveBase(cwd, startRef);
  if (base === null) {
    // Same refusal git-lifecycle raises, for the same reason: on a stage branch
    // with no recorded default branch, branching off HEAD would silently base
    // this stage on the previous one — today's silent stacking IS the defect,
    // so this case refuses instead of guessing.
    throw new Error(
      `cannot determine which ref '${name}' should fork from: the checkout is on '${startRef}', which is itself a stage branch, and this repository has no recorded default branch (refs/remotes/${lifecycle.DEFAULT_REMOTE}/HEAD). Branching off the current HEAD would silently base this stage on the previous one — record the default branch (\`git remote set-head ${lifecycle.DEFAULT_REMOTE} --auto\`) or run from it`,
    );
  }
  // Interactive-parity courtesy, never a block: when the base is the recorded
  // remote default, a human's unpushed local commits on the starting branch are
  // NOT in the new stage branch. Say so once, on stderr, and proceed.
  if (from === 'remote-head' && startRef !== null) {
    const onBranch = gitProbe(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${startRef}`]);
    const count =
      onBranch === null
        ? 0
        : Number(gitProbe(cwd, ['rev-list', '--count', `${base}..${startRef}`]) || 0);
    if (count > 0) {
      process.stderr.write(
        `verity: stage-branch-note: ${count} local commit(s) on '${startRef}' are not on '${base}' and will not be in '${name}' — push them first if they belong in this stage\n`,
      );
    }
  }
  // `--no-track` is load-bearing: `checkout -b` off a remote-tracking ref
  // auto-sets the branch's upstream to origin/<default>, and `gh pr create`
  // (the stage `pr` verb) reads the upstream to pick the PR head — the branch
  // must keep NO upstream so gh pushes origin/<branch> exactly as today.
  run('git', ['-C', cwd, 'checkout', '--no-track', '-b', name, base], cwd);
  return { branch: name, created: true, raw: name, base, baseFrom: from };
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
    if (flags['dry-run']) {
      // Name only — no git at all (no fetch, no probe), byte-identical to the
      // pre-stage-78 dry-run result.
      return { branch: name, created: false, raw: name };
    }
    return branchAct(cwd, name);
  }
  if (verb === 'pr') {
    const spec = prSpec(cwd, Number(args[1]), { issue: flags.issue });
    if (flags['dry-run']) {
      return { ...spec, opened: false };
    }
    // Stage 85 (ADR-0029; operator-smoke finding): on the LOCAL substrate there
    // is no PR surface to open — the pushed stage branch IS the review handoff
    // (the stage-81 delivered-for-review evidence; the snapshot synthesizes the
    // PR-shaped fact from the branch + gate-run record). The real-model smoke
    // caught this verb's unconditional `gh pr create` retried against the
    // sentinel: the role follows build.md and shells this exact command, so it
    // must answer DETERMINISTICALLY on local — a clear opened:false with the
    // reason, never a gh attempt the role then retries or works around.
    // Lazy require (branchAct's own rule): substrate-local ↔ this module have
    // no cycle, but git-lifecycle requires stage.cjs at load time and the lazy
    // form keeps every require in this dispatch call-time-safe.
    const substrateLocal = require('./substrate-local.cjs');
    if (substrateLocal.resolveSubstrate(cwd) === 'local') {
      return {
        ...spec,
        opened: false,
        substrate: 'local',
        reason:
          'the local substrate has no PR surface — nothing to open: the pushed stage branch IS the review handoff (ADR-0029 §3, stage 85); the engine reads it as the PR-shaped fact and merges it after a verified-green review',
      };
    }
    run('gh', ['pr', 'create', '--title', spec.title, '--body', spec.body], cwd);
    return { ...spec, opened: true };
  }
  throw new Error(`unknown stage verb: ${verb || '(none)'} — use new|list|branch|pr`);
}

module.exports = {
  stageDir,
  nextNumber,
  acceptanceFor,
  create,
  issueFor,
  list,
  findStageFile,
  branchName,
  acceptanceText,
  prSpec,
  dispatch,
};
