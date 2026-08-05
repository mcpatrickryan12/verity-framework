// Verity-performed stage lifecycle git (stage 17, ADR-0012) — the deterministic
// half of "the model edits files, Verity performs git".
//
// WHY THIS EXISTS. Under a runtime whose sandbox makes `.git` read-only, git
// READS work and git WRITES do not: `git checkout -b` and `git commit` both
// come back rc=128 "Read-only file system"
// (docs/dev/codex-headless-canary-results-0.146.0.md). Roles never ran raw git
// — `commands/verity/build.md` runs `verity stage branch` and `verity stage pr`
// — but the Verity CLI those steps invoke was shelling git INSIDE the model's
// execution context, so the whole stage lifecycle was non-functional there. The
// defect is WHERE the git ran, not that a prompt hard-codes it.
//
// So this module runs the same three acts OUTSIDE that context, in Verity's own
// process, driven by the coordinator (agent-exec.cjs):
//   0. resolveBase — decide EXPLICITLY which ref the stage forks from, and
//                    refuse when that cannot be determined. Branching off
//                    whatever HEAD happens to be is the defect that makes stage
//                    N+1 fork off stage N's branch and quietly ship the previous
//                    stage's commits inside its own PR;
//   1. plan/begin  — create (or re-check-out) the stage branch BEFORE the model
//                    is dispatched; the role never creates it and is told so;
//   2. finish      — after a SUCCESSFUL run, stage exactly the file changes the
//                    role produced, commit them with an attributable message,
//                    push the branch, and open the stage PR;
//   3. refuse      — when any of that cannot be provided, fail the run closed
//                    (exit 30) instead of letting it finish with no branch, no
//                    commit and no PR while reporting success;
//   4. restore     — put the operator's checkout back on the ref the run found
//                    it on. Verity moves the checkout as a means to an end; a
//                    run that silently leaves a human on a stage branch (with
//                    their uncommitted work carried across by the switch) has
//                    left a side effect nobody asked for.
//
// WHAT WE DELIBERATELY DO NOT DO: grant the model write access under `.git`.
// ADR-0012 records that it WORKS (a `.git/** = "write"` permission profile
// makes `checkout -b` succeed) and REJECTS it — it is unreachable from the
// headless entry point anyway, and ref mutation is precisely the authority the
// trust ladder exists to withhold. If a future contributor is tempted to "just
// grant it": that is a rejected option, not an unexplored one.
//
// Provider-NEUTRAL by construction, exactly like agents/invariants.cjs and
// agents/workspace.cjs: this module knows about a repository, a loaded role
// capability policy, and a stage number. A driver opts in by exporting the
// coordinator hooks; only the driver whose runtime needs it does today, and the
// reference driver (whose harness performs its own git) exports none of them,
// so its coordinator path is untouched.
//
// CHANGE SOURCES, one per containment tier (ADR-0011):
//   tier 2 — the ACCEPTED set from the gated merge-back. `workspace.cjs apply()`
//            has already copied those paths into the real checkout and stopped;
//            this module is what finally turns them into history. A REJECTED
//            merge-back never reaches here at all (the coordinator only calls
//            finish() on a successful run, and a rejection fails the run).
//   tier 1 — the working-tree paths whose `git status` entry differs from the
//            snapshot taken just before dispatch. Pre-existing dirt is excluded
//            by construction: it is in the snapshot, so it never differs.
// Either way an EMPTY change set commits NOTHING and says so — an empty commit
// would be a lie about what the run did.
const { spawnSync } = require('node:child_process');

const gh = require('../gh.cjs');
const stage = require('../stage.cjs');
const { AgentExecError } = require('./result-contract.cjs');
const { PROVIDED_CAPABILITIES } = require('./policy.cjs');

// The remote the stage branch is pushed to. Not configurable: the whole point
// of this module is that ref movement is deterministic Verity code, and a
// remote chosen at runtime is one more thing an operator could get wrong.
const DEFAULT_REMOTE = 'origin';

// The ONE capability this module honours, named explicitly rather than derived
// by iterating PROVIDED_CAPABILITIES. Iterating would make every FUTURE entry in
// that table a silent additional REQUIREMENT here — a role holding only
// `git_write` would quietly stop getting its git performed the day a second
// provided capability is added. The table stays the honesty map (it names the
// mechanism, below); this constant is what gates the lifecycle.
const PROVIDED_CAPABILITY = 'git_write';
const MECHANISM = PROVIDED_CAPABILITIES[PROVIDED_CAPABILITY];

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: res.stdout || '', stderr: res.stderr || String(res.error || '') };
  }
  return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function firstLine(text) {
  return (
    String(text || '')
      .split('\n')
      .find((l) => l.trim().length > 0) || ''
  ).trim();
}

// The fail-closed refusal. Raised BEFORE the model is invoked (nothing has been
// spent yet) and mapped by the coordinator onto exit 30 + one stderr slug line.
function unprovidable(detail) {
  return new AgentExecError(
    `fail-closed: this role is granted ${PROVIDED_CAPABILITY}, which on this runtime means Verity performs git on its behalf (ADR-0012, mechanism ${MECHANISM}) — but ${detail}. Refusing the run rather than letting it finish with no branch, no commit and no PR`,
    'git-unprovidable',
  );
}

// --- 1. does this run need Verity-performed git? --------------------------------

// The stage a role run is about: the first purely-numeric role argument
// (`verity agent-exec build 7 …`). Anything else means the run is not a stage
// act, and the stage lifecycle does not apply to it.
//
// The parse is deliberately loose because it is NOT the gate. A number here only
// becomes a stage act if `stage.branchName()` resolves it to a real
// `stage-instructions/stage-N-<slug>.md` (plan() below); a stray `7` in some
// other argument position names no stage, so the lifecycle simply does not
// engage. Tightening this regex would buy nothing the file check does not
// already provide.
function stageNumber(roleArgs) {
  for (const arg of roleArgs) {
    if (/^\d+$/.test(String(arg))) {
      return Number(arg);
    }
  }
  return null;
}

// Every branch name the stage corpus currently defines, derived through
// `stage.cjs` rather than re-spelled here — so "is this a stage branch?" cannot
// drift from "what does Verity name a stage branch?".
function stageBranches(cwd) {
  const names = [];
  for (const file of stage.list(cwd).stages) {
    const m = /^stage-(\d+)-/.exec(file);
    if (m !== null) {
      try {
        names.push(stage.branchName(cwd, Number(m[1])));
      } catch {
        // a stage file that resolves to no branch name is simply not one
      }
    }
  }
  return names;
}

// The ref the checkout is on right now: the branch name, or the commit when
// HEAD is detached (which is still a legal thing to restore to).
function currentRef(cwd) {
  const symbolic = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (symbolic.ok && symbolic.stdout.trim() !== '') {
    return symbolic.stdout.trim();
  }
  const head = git(cwd, ['rev-parse', 'HEAD']);
  return head.ok ? head.stdout.trim() : null;
}

// WHERE A STAGE BRANCH FORKS FROM. This is the whole of defect #1: branching off
// whatever HEAD happens to be means stage N+1 forks off stage N's branch, and
// its PR then silently carries the previous stage's commits — green CI, wrong
// diff. The base is therefore resolved EXPLICITLY, from a deterministic ladder,
// and a base that cannot be determined is a refusal rather than a fall back to
// HEAD:
//
//   1. `refs/remotes/<remote>/HEAD` — git's own record of the remote's default
//      branch (set by `git clone`, or by `git remote set-head`). Authoritative
//      when present: it is the repository's answer to "what do branches fork
//      from?", not ours.
//   2. otherwise the ref the checkout was ALREADY on, provided it is not itself
//      a stage branch. This is the interactive-parity case — a human sitting on
//      `main` gets exactly the branch `verity stage branch` would have given
//      them, which is the property this module's header claims. A stage branch
//      is excluded by name, so the stacking defect cannot recur through it.
//   3. otherwise REFUSE. "We are on a stage branch and the repository never
//      recorded a default branch" is precisely the case where guessing produces
//      the wrong PR, so it is the case we decline.
function resolveBase(cwd, startRef) {
  const remoteHead = git(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    `refs/remotes/${DEFAULT_REMOTE}/HEAD`,
  ]);
  if (remoteHead.ok && remoteHead.stdout.trim() !== '') {
    return { base: remoteHead.stdout.trim(), from: 'remote-head' };
  }
  if (startRef !== null && !stageBranches(cwd).includes(startRef)) {
    return { base: startRef, from: 'checkout' };
  }
  return { base: null, from: null };
}

// Decide, deterministically and BEFORE anything is spawned, whether Verity
// performs the stage lifecycle git for this run. Returns null (the common case
// — nothing about the run changes) or the plan the remaining steps consume.
//
// All three conditions are load-bearing:
//   - the policy GRANTS git_write. Absence never grants anything
//     (contracts/role-capability-policy.md v1), and a role that may not move a
//     ref does not get one moved on its behalf either.
//   - the run resolves to an EXISTING stage. The branch name is derived from
//     `stage-instructions/stage-N-<slug>.md` by the same `stage.cjs` code the
//     interactive path uses, so the Verity-performed branch and the one a human
//     would create are the same branch, by construction.
//   - the caller's driver opted in. Handled by the coordinator, not here.
function plan({ cwd, role, roleArgs = [], runId = null, policy }) {
  const caps = policy?.capabilities || {};
  if (caps[PROVIDED_CAPABILITY] !== true) {
    return null;
  }
  const number = stageNumber(roleArgs);
  if (number === null) {
    return null;
  }
  let branch;
  try {
    branch = stage.branchName(cwd, number);
  } catch {
    return null; // no such stage — this run is not a stage act
  }
  return {
    role,
    runId,
    stage: number,
    branch,
    remote: DEFAULT_REMOTE,
    // Opening the PR is a GitHub write. A role without that capability has no
    // GitHub credential in its child environment and no business creating one,
    // so Verity commits and pushes for it and stops there — visibly, in the
    // report, never as a silent omission.
    pr: caps.github_write === true,
  };
}

// --- 2. can Verity actually provide it? -----------------------------------------

// The capability-honesty rule (ADR-0011) applied to a GRANT rather than a
// restriction: everything the promise "Verity performs git for you" depends on
// is checked here, before the run. Every check is a git READ — nothing is
// mutated, so a refusal leaves the repository exactly as it was.
function assertProvidable(cwd, p) {
  if (!git(cwd, ['rev-parse', '--git-dir']).ok) {
    throw unprovidable(`${cwd} is not a git repository`);
  }
  if (!git(cwd, ['rev-parse', '--verify', 'HEAD']).ok) {
    throw unprovidable(`${cwd} has no commits (unborn HEAD), so there is nothing to branch from`);
  }
  // `git var GIT_COMMITTER_IDENT` fails exactly when git cannot auto-detect an
  // identity — the same condition that would make the post-run commit die, but
  // discovered before a single token is spent.
  if (!git(cwd, ['var', 'GIT_COMMITTER_IDENT']).ok) {
    throw unprovidable(
      'git has no committer identity here (user.name / user.email are unset), so Verity cannot author the commit',
    );
  }
  const remotes = git(cwd, ['remote']);
  const names = remotes.ok ? remotes.stdout.split('\n').map((l) => l.trim()) : [];
  if (!names.includes(p.remote)) {
    throw unprovidable(
      `this repository has no '${p.remote}' remote, so the stage branch could never be pushed (a branch nobody else can see is not a delivered stage)`,
    );
  }
  // The fork point, resolved here so an undeterminable base refuses BEFORE the
  // model runs — and never degrades to "branch off whatever HEAD is", which is
  // how a stage's PR ends up carrying the previous stage's commits.
  const startRef = currentRef(cwd);
  const { base, from } = resolveBase(cwd, startRef);
  if (base === null) {
    throw unprovidable(
      `Verity cannot determine which ref stage ${p.stage} should fork from: the checkout is on '${startRef}', which is itself a stage branch, and this repository has no recorded default branch (refs/remotes/${p.remote}/HEAD). Branching off the current HEAD would silently base this stage on the previous one — record the default branch (\`git remote set-head ${p.remote} --auto\`) or run from it`,
    );
  }
  if (!git(cwd, ['rev-parse', '--verify', '--quiet', base]).ok) {
    throw unprovidable(`the base ref '${base}' does not resolve in this repository`);
  }
  return { ...p, base, baseFrom: from };
}

// --- 3. the branch, created OUTSIDE the model's execution context ----------------

// `git status --porcelain` as a path → code map. Rename/copy ORIGIN paths are
// recorded too, so a rename is seen from both ends.
function statusMap(cwd) {
  const res = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const map = new Map();
  if (!res.ok) {
    return map;
  }
  const fields = res.stdout.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    map.set(entry.slice(3), code);
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1; // the ORIGIN path follows in its own NUL field
      if (fields[i] !== undefined && fields[i] !== '') {
        map.set(fields[i], code);
      }
    }
  }
  return map;
}

// Create the stage branch (or check out the one a previous dispatch of the same
// stage already created — the worker re-dispatches `build` while driving CI to
// green, and a second run must not fail on "branch already exists"). Runs in
// Verity's own process, in the real checkout, BEFORE the model is dispatched.
//
// A NEW branch forks from the resolved base ref (never from HEAD — see
// resolveBase). An EXISTING one is simply checked out: it already has a base,
// and re-basing someone's stage branch is not a thing a dispatch may do
// silently.
//
// Also records the ref the checkout was on (restore() puts it back) and takes
// the pre-dispatch `git status` snapshot the tier-1 change source is diffed
// against — taken here, after Verity's own branch move, so nothing Verity did
// can be mistaken for the role's work.
//
// A DIRTY working tree is deliberately NOT refused. In a worker chain the
// preceding role legitimately leaves uncommitted work in the checkout (a role
// without git_write has nothing that commits for it), so refusing here would
// break the very plan → build chain this stage exists to enable. The dirt is
// safe on both tiers by construction: at tier 1 it is inside `statusBefore` and
// therefore excluded from the commit, and at tier 2 only the gated accepted set
// is committed. Where git itself refuses to carry the changes across the switch,
// that IS a fail-closed refusal — the checkout below returns non-zero and the
// run is refused before the model is invoked.
function begin(cwd, p) {
  if (!p.base) {
    // Structural: the fork point is resolved by assertProvidable, which the
    // coordinator always runs first. Reaching here means a caller skipped the
    // provision check — refuse rather than quietly fall back to HEAD, which is
    // the exact behaviour this stage removed.
    throw unprovidable('the fork point was never resolved (assertProvidable must run first)');
  }
  const startRef = currentRef(cwd);
  const exists = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`]).ok;
  const res = exists
    ? git(cwd, ['checkout', p.branch])
    : git(cwd, ['checkout', '-b', p.branch, p.base]);
  if (!res.ok) {
    const act = exists
      ? `check out the existing stage branch '${p.branch}'`
      : `create the stage branch '${p.branch}' from '${p.base}'`;
    throw unprovidable(`git could not ${act}: ${firstLine(res.stderr)}`);
  }
  return { ...p, created: !exists, startRef, statusBefore: statusMap(cwd) };
}

// Put the operator's checkout back where the run found it. Called on EVERY exit
// path (the coordinator's `finally`, after the commit) — a run that quietly
// leaves a human on a stage branch, with their uncommitted work carried across
// by the switch, is a side effect nobody asked for. Never throws: a failed
// restore is REPORTED (loudly, by the caller) rather than turned into a second
// failure that would mask the run's real outcome.
function restore(cwd, started) {
  if (started === null || started === undefined || !started.startRef) {
    return { restored: false, ref: null, error: null };
  }
  if (currentRef(cwd) === started.startRef) {
    return { restored: false, ref: started.startRef, error: null }; // already there
  }
  const res = git(cwd, ['checkout', started.startRef]);
  if (!res.ok) {
    return {
      restored: false,
      ref: started.startRef,
      error: `could not restore the checkout to '${started.startRef}' (it is left on '${started.branch}'): ${firstLine(res.stderr)}`,
    };
  }
  return { restored: true, ref: started.startRef, error: null };
}

// The tier-1 change source: paths whose working-tree status differs from the
// pre-dispatch snapshot. A path that was already dirty before the run and is
// unchanged since is NOT the role's work and never enters the commit.
function changedPaths(cwd, started) {
  const before = started.statusBefore || new Map();
  const now = statusMap(cwd);
  const changed = [];
  for (const [file, code] of now) {
    if (before.get(file) !== code) {
      changed.push(file);
    }
  }
  return changed.sort();
}

// --- 4. commit, push, PR --------------------------------------------------------

// The report that travels back in the result object as the additive OPTIONAL
// field `git_lifecycle` (contracts/agent-result.md v1 permits additive optional
// fields; consumers tolerate its absence). Always the SAME key set, whatever
// happened, so a consumer never has to guess which shape it got.
function report(started, extra = {}) {
  return {
    branch: started.branch,
    branch_created: started.created === true,
    // Which ref the branch forks from, and how Verity decided that — the canary
    // reads this to confirm a stage did not get based on the previous one.
    base: started.base === undefined ? null : started.base,
    base_from: started.baseFrom === undefined ? null : started.baseFrom,
    stage: started.stage,
    committed: false,
    commit: null,
    paths: [],
    pushed: false,
    pr: null,
    reason: null,
    error: null,
    ...extra,
  };
}

// The run did not reach the commit (it failed, was gated, or containment
// rejected it). The branch still exists — Verity made it — and the report says
// so plus WHY nothing was committed onto it.
function skipped(started, reason) {
  return report(started, { reason });
}

// Deterministic, attributable commit message. Subject names the stage and the
// role; the trailers make the run itself greppable in `git log`, and the body
// states in the history WHY a commit exists that the role did not make.
function commitMessage(started) {
  const subject = `[stage ${started.stage}] ${started.role}: role-produced file changes`;
  const body = [
    `Committed by Verity on behalf of the ${started.role} role: on this runtime the`,
    'model edits files and Verity performs git (ADR-0012). The model never wrote',
    'under .git.',
  ].join('\n');
  const trailers = [
    `Verity-Role: ${started.role}`,
    `Verity-Stage: ${started.stage}`,
    ...(started.runId === null || started.runId === undefined
      ? []
      : [`Verity-Run-Id: ${started.runId}`]),
  ].join('\n');
  return [subject, body, trailers];
}

// Open the stage PR — or reuse the one this branch already has. `gh pr create`
// fails when a PR for the head branch exists, and the worker legitimately
// re-dispatches the same role on the same stage, so an existing PR is the
// expected steady state, not an error.
function openPr(cwd, started) {
  const existing = gh.run(
    ['pr', 'list', '--head', started.branch, '--json', 'number', '--limit', '1'],
    { cwd },
  );
  const found = JSON.parse(String(existing).trim() || '[]');
  if (Array.isArray(found) && found.length > 0 && Number.isInteger(found[0].number)) {
    return found[0].number;
  }
  const spec = stage.prSpec(cwd, started.stage);
  const out = gh.run(
    ['pr', 'create', '--head', started.branch, '--title', spec.title, '--body', spec.body],
    { cwd },
  );
  const m = String(out).match(/\/pull\/(\d+)/);
  return m === null ? null : Number(m[1]);
}

// The whole post-run half in one call: stage the role's changes → commit →
// push → PR. Returns the report; `error` is non-null iff a step Verity promised
// to perform failed, and the coordinator then fails the run loudly rather than
// reporting a success with no history behind it.
//
// `merged` (tier 2) is the ACCEPTED set from the gated merge-back; absent it,
// the tier-1 working-tree diff is used. An empty set commits nothing.
function finish(cwd, started, opts = {}) {
  const paths = Array.isArray(opts.merged) ? [...opts.merged].sort() : changedPaths(cwd, started);
  if (paths.length === 0) {
    return skipped(started, 'the run produced no file changes — nothing to commit');
  }
  const add = git(cwd, ['add', '--', ...paths]);
  if (!add.ok) {
    return report(started, {
      paths,
      error: `Verity could not stage the role's changes on ${started.branch}: ${firstLine(add.stderr)}`,
    });
  }
  // Belt on the never-an-empty-commit rule: paths can DIFFER from the snapshot
  // and still match HEAD (a change made and undone within the run). `git diff
  // --cached --quiet` exits 0 when nothing is staged.
  if (git(cwd, ['diff', '--cached', '--quiet']).ok) {
    return skipped(started, "the run's changes are identical to HEAD — nothing to commit");
  }
  const [subject, body, trailers] = commitMessage(started);
  const commit = git(cwd, ['commit', '-m', subject, '-m', body, '-m', trailers]);
  if (!commit.ok) {
    return report(started, {
      paths,
      error: `Verity could not commit the role's changes on ${started.branch}: ${firstLine(commit.stderr)}`,
    });
  }
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const base = report(started, {
    committed: true,
    commit: head.ok ? head.stdout.trim() : null,
    paths,
  });
  const push = git(cwd, ['push', '--set-upstream', started.remote, started.branch]);
  if (!push.ok) {
    return {
      ...base,
      error: `Verity committed ${base.commit} but could not push ${started.branch} to ${started.remote}: ${firstLine(push.stderr)}`,
    };
  }
  if (started.pr !== true) {
    return {
      ...base,
      pushed: true,
      reason: 'the role is not granted github_write — branch pushed, PR not opened',
    };
  }
  try {
    return { ...base, pushed: true, pr: openPr(cwd, started) };
  } catch (err) {
    return {
      ...base,
      pushed: true,
      error: `Verity pushed ${started.branch} but could not open its pull request: ${firstLine(err.message)}`,
    };
  }
}

module.exports = {
  DEFAULT_REMOTE,
  MECHANISM,
  PROVIDED_CAPABILITY,
  assertProvidable,
  begin,
  changedPaths,
  commitMessage,
  currentRef,
  finish,
  plan,
  report,
  resolveBase,
  restore,
  skipped,
  stageNumber,
  statusMap,
};
