// Ledger — the state-derivation engine (framework-spec.md §5). READ-ONLY w.r.t.
// state: it NEVER writes a state file. Integration state is DERIVED by correlating
// local stage specs (intent) with GitHub issues/PRs/tags (progress). A transition
// IS a GitHub act, so there is nothing to keep in sync and nothing to conflict on.
//
// The GitHub snapshot is injectable (opts.snapshot) so derivation is unit-testable
// without network; the default shells out to `gh` + `git` best-effort (offline →
// empty snapshot → everything reads as "planned", which is honest).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function stageDir(cwd) {
  return path.join(cwd, 'stage-instructions');
}

function stageNum(name) {
  const m = name.match(/^stage-(\d+)-/);
  return m ? Number(m[1]) : 0;
}

function parseStageFile(cwd, name) {
  const text = fs.readFileSync(path.join(stageDir(cwd), name), 'utf8');
  const title = (text.match(/^#\s+Stage\s+\d+:\s+(.+)$/m) || [])[1] || name;
  const type = (text.match(/\*\*Type:\*\*\s*(\w+)/) || [])[1] || 'feature';
  const depRaw = ((text.match(/\*\*Depends on:\*\*\s*(.+)$/m) || [])[1] || 'none').trim();
  const dependsOn =
    depRaw.toLowerCase() === 'none'
      ? []
      : depRaw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
  return { number: stageNum(name), title: title.trim(), type, dependsOn, file: name };
}

function readStages(cwd) {
  const dir = stageDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => parseStageFile(cwd, n))
    .sort((a, b) => a.number - b.number);
}

function matchesStage(title, number) {
  return typeof title === 'string' && title.startsWith(`[stage ${number}]`);
}

function prMatches(pr, number) {
  return (
    matchesStage(pr.title, number) ||
    (typeof pr.headRefName === 'string' && pr.headRefName.startsWith(`feat/stage-${number}-`))
  );
}

// Status precedence: merged (PR merged or issue closed) > in-review/building (PR open,
// by CI) > claimed (issue assigned) > planned.
function deriveStatus(stage, snapshot) {
  const issue = (snapshot.issues || []).find((i) => matchesStage(i.title, stage.number));
  const pr = (snapshot.prs || []).find((p) => prMatches(p, stage.number));
  const claimed = !!(issue && Array.isArray(issue.assignees) && issue.assignees.length > 0);

  let status = 'planned';
  if (claimed) {
    status = 'claimed';
  }
  if (issue && issue.state === 'CLOSED') {
    status = 'merged';
  }
  if (pr) {
    if (pr.state === 'MERGED') {
      status = 'merged';
    } else if (pr.state === 'OPEN') {
      status = pr.ciGreen ? 'in-review' : 'building';
    }
  }
  return {
    number: stage.number,
    title: stage.title,
    type: stage.type,
    dependsOn: stage.dependsOn,
    status,
    issue: issue ? issue.number : null,
    pr: pr ? pr.number : null,
  };
}

function unblocked(derived) {
  const merged = new Set(derived.filter((s) => s.status === 'merged').map((s) => s.number));
  return derived
    .filter((s) => s.status !== 'merged' && s.dependsOn.every((d) => merged.has(d)))
    .map((s) => s.number);
}

function semverKey(tag) {
  return tag
    .replace(/^v/, '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
}

function latestTag(tags) {
  if (!tags || tags.length === 0) {
    return null;
  }
  return [...tags]
    .sort((a, b) => {
      const ka = semverKey(a);
      const kb = semverKey(b);
      for (let i = 0; i < 3; i += 1) {
        if ((ka[i] || 0) !== (kb[i] || 0)) {
          return (ka[i] || 0) - (kb[i] || 0);
        }
      }
      return 0;
    })
    .pop();
}

function project(cwd, opts = {}) {
  const snapshot = opts.snapshot || fetchSnapshot(cwd);
  const stages = readStages(cwd).map((s) => deriveStatus(s, snapshot));
  return {
    online: snapshot.online !== false,
    release: latestTag(snapshot.tags),
    stages,
    next: unblocked(stages),
  };
}

function summarize(proj) {
  const byStatus = {};
  for (const s of proj.stages) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  }
  return {
    total: proj.stages.length,
    byStatus,
    release: proj.release,
    next: proj.next,
    online: proj.online,
    raw: `${proj.stages.length} stages · release ${proj.release || '(none)'} · next ${JSON.stringify(proj.next)}`,
  };
}

// --- default GitHub source (best-effort; never throws) ---
function ghJson(args) {
  try {
    return JSON.parse(
      execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    return null;
  }
}

function rollupGreen(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return false;
  }
  const ok = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  return rollup.every((c) => ok.has(c.conclusion || c.state));
}

function fetchSnapshot(cwd) {
  const issues =
    ghJson([
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '300',
      '--json',
      'number,title,state,labels,assignees',
    ]) || [];
  const prsRaw =
    ghJson([
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '300',
      '--json',
      'number,title,state,headRefName,statusCheckRollup,labels',
    ]) || [];
  const prs = prsRaw.map((p) => ({ ...p, ciGreen: rollupGreen(p.statusCheckRollup) }));
  let tags = [];
  try {
    tags = execFileSync('git', ['-C', cwd, 'tag'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    tags = [];
  }
  const online = ghJson(['repo', 'view', '--json', 'name']) !== null;
  return { issues, prs, tags, online };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0] || 'view';
  const proj = project(cwd, {});
  if (verb === 'view') {
    return proj;
  }
  if (verb === 'next') {
    return { next: proj.next, raw: JSON.stringify(proj.next) };
  }
  if (verb === 'summary') {
    return summarize(proj);
  }
  if (verb === 'graph') {
    return { graph: proj.stages.map((s) => ({ number: s.number, dependsOn: s.dependsOn })) };
  }
  if (verb === 'stage') {
    const n = Number(args[1]);
    const found = proj.stages.find((s) => s.number === n);
    if (!found) {
      throw new Error(`no stage ${args[1]}`);
    }
    return found;
  }
  throw new Error(`unknown state verb: ${verb} — use view|next|stage|summary|graph`);
}

module.exports = {
  readStages,
  parseStageFile,
  deriveStatus,
  unblocked,
  latestTag,
  fetchSnapshot,
  project,
  summarize,
  dispatch,
};
