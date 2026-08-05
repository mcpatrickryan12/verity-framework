// Ledger — the state-derivation engine (framework-spec.md §5). READ-ONLY w.r.t.
// state: it NEVER writes a state file. Integration state is DERIVED by correlating
// local stage specs (intent) with GitHub issues/PRs/tags (progress). A transition
// IS a GitHub act, so there is nothing to keep in sync and nothing to conflict on.
//
// The GitHub snapshot is injectable (opts.snapshot) so derivation is unit-testable
// without network; the default shells out to `gh` + `git`.
//
// Stage 20 (issue #60): the shell-out is best-effort about NETWORK, never about
// TRUTH. It used to degrade an unreachable GitHub to the empty snapshot, and the
// comment here called that "honest" — it was the opposite. Everything read as
// `planned` / `issue: null` / `pr: null`, at exit 0 with an empty stderr, which
// is indistinguishable from a repository where nothing has started. Every
// consumer believed it: in canary run 3 the `review` role was told "no PR or
// linked issue exists" while PR #2 was open, so it could not review, failed
// twice, and burned a no-progress strike. A snapshot now records whether it was
// actually OBSERVED (`verified`), and the consumers refuse rather than answer.
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
      // CALL SITE (stage 19 audit): this vocabulary has no word for "we could
      // not verify", and adding one would change `verity state view` for every
      // existing consumer. So unknown is folded in with red — NOT green — which
      // is exactly today's behavior and keeps the projection byte-identical.
      // Distinguishing the two is `verity next`'s job (next.cjs reads the
      // three-state CI off the same snapshot and gates on unknown), because
      // that is where the decision to spend a model run is actually made.
      status = ciStateOf(pr) === CI_GREEN ? 'in-review' : 'building';
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

// The pure derive layer. It DERIVES; it does not decide whether the snapshot
// deserved to be believed — its shape is byte-frozen by `verity state view`, so
// it gains no field. Every caller that turns a projection into an ANSWER must
// gate on ledger.snapshotVerified(snapshot) first: `dispatch` below refuses, and
// next.decide() gates at `state:unverified` (stage 20 consumer audit, issue #60).
function project(cwd, opts = {}) {
  const snapshot = opts.snapshot || fetchSnapshot(cwd, { repo: opts.repo });
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

// --- default GitHub source (never throws; reports failure instead of hiding it) ---

// Credential shapes that must never reach a message, a log, or a comment. The
// list is the token formats GitHub actually issues plus the two header forms;
// over-redacting is the safe direction, and the failure REASON below carries
// the actionable part regardless.
const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // ghp_/gho_/ghu_/ghs_/ghr_
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b[A-Fa-f0-9]{40}\b/g, // classic 40-hex PAT
];
// Anything following an Authorization/Bearer/token keyword, to end of line.
const CREDENTIAL_LINE = /\b(authorization|bearer|token)\b\s*[:=]?\s*\S.*$/gim;

function redact(text) {
  let out = String(text ?? '');
  for (const re of TOKEN_SHAPES) {
    out = out.replace(re, '[redacted]');
  }
  return out.replace(CREDENTIAL_LINE, '$1: [redacted]');
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .find((l) => l.trim().length > 0) || 'gh failed with no diagnostic'
  );
}

// WHY a gh call failed, in the terms an operator can act on: auth vs network vs
// rate limit is the difference between "log in again", "wait", and "check the
// connection". Deliberately coarse — the (redacted) stderr line travels
// alongside it, so this is a label, not a parser.
function failureReason(err, cwd) {
  if (err?.code === 'ENOENT') {
    // A spawn ENOENT is ambiguous: `gh` is not on PATH, OR the directory we were
    // told to read does not exist (the spawn fails at chdir, before exec, with
    // the same code). Reporting `gh-not-installed` for a bad `--cwd` sends an
    // operator off to repair a working install, so the two are told apart here.
    return cwd !== undefined && !fs.existsSync(cwd) ? 'no-target-dir' : 'gh-not-installed';
  }
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  if (/rate limit|submitted too quickly/i.test(text)) {
    return 'rate-limit';
  }
  if (/bad credentials|not logged in|gh auth login|requires authentication|HTTP 401/i.test(text)) {
    return 'auth';
  }
  if (
    /dial tcp|no such host|connection (refused|reset)|network is unreachable|i\/o timeout|timed? ?out|EAI_AGAIN|proxy/i.test(
      text,
    )
  ) {
    return 'network';
  }
  if (
    /could not resolve to a repository|no git remotes|not a git repository|HTTP 404/i.test(text)
  ) {
    return 'no-repo';
  }
  const http = text.match(/HTTP (\d{3})/);
  return http ? `http-${http[1]}` : 'error';
}

// A gh JSON read as a RESULT, not a value. This used to be
// `catch { return null }` with gh's stderr thrown away outright
// (`stdio: [...,'ignore']`), and every caller turned that null into `[]` — the
// fail-open at the heart of issue #60. The reason now travels with the failure.
//
// Stage 23 (issue #64): `cwd` is REQUIRED, and it is the whole point. `gh`
// resolves the repository from the directory it runs in, so omitting it made
// every GitHub read answer about the PROCESS's repository while `readStages`
// read the one `--cwd` named — the current repo's issues and PRs projected onto
// the target's stages, confidently, at exit 0. Any gh read added here later must
// take it too; tests/ledger-cwd.test.cjs asserts every invocation carries it.
function ghJson(args, cwd) {
  try {
    return {
      ok: true,
      data: JSON.parse(
        execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      ),
    };
  } catch (err) {
    const reason = failureReason(err, cwd);
    return {
      ok: false,
      reason,
      // A bad target has no gh stderr to quote — the spawn never happened — so
      // the actionable part is the directory itself.
      detail:
        reason === 'no-target-dir'
          ? `target directory does not exist: ${redact(cwd)}`
          : firstLine(redact(err?.stderr || err?.message)),
    };
  }
}

// --- CI reading: THREE answers, not two (stage 19, issue #50) ----------------
//
// `statusCheckRollup` answers a question with three outcomes, and a boolean can
// only carry two. Collapsing them is what made a repository with NO CI
// indistinguishable from one whose CI is FAILING: an empty check set returned
// `false`, so the stage never left `building` and the worker re-dispatched
// `build` every tick, a full model run each time (the 2026-07-31 canary — two
// consecutive ticks, `test`/`review` never reached). The three states:
//
//   'green'   — checks were reported and every one of them concluded acceptably
//   'red'     — checks were reported and at least one failed or is still pending
//   'unknown' — NO checks were reported at all. The repository may have no CI
//               configured, or GitHub may not have answered. Either way Verity
//               CANNOT VERIFY this PR, in either direction.
//
// `unknown` is NEVER green. Reading it as green would be strictly worse than
// the bug it replaces, because the worker would then merge on unverified CI.
// Every consumer must decide deliberately what unknown means for it; the audit
// of all call sites lives in docs/autonomy.md § "Unverified CI".
const CI_GREEN = 'green';
const CI_RED = 'red';
const CI_UNKNOWN = 'unknown';
const OK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function rollupState(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return CI_UNKNOWN;
  }
  return rollup.every((c) => OK_CONCLUSIONS.has(c.conclusion || c.state)) ? CI_GREEN : CI_RED;
}

// The boolean projection, for the boundaries that genuinely need one. It is
// deliberately `=== green`: unknown collapses to NOT-green, never to green.
function rollupGreen(rollup) {
  return rollupState(rollup) === CI_GREEN;
}

// The three-state reading of a snapshot PR. `fetchSnapshot` stamps `ciState` on
// every PR it returns, so the live path is exact. An INJECTED snapshot (tests,
// embedders) may still carry only the legacy boolean: `true` is green and
// `false` is read as RED, not unknown — "unknown" is claimable only from a
// rollup we actually saw, so an old-shaped snapshot can never manufacture the
// new state (and therefore can never change an existing consumer's behavior).
function ciStateOf(pr) {
  if (pr && (pr.ciState === CI_GREEN || pr.ciState === CI_RED || pr.ciState === CI_UNKNOWN)) {
    return pr.ciState;
  }
  if (pr && Array.isArray(pr.statusCheckRollup)) {
    return rollupState(pr.statusCheckRollup);
  }
  return pr && pr.ciGreen === true ? CI_GREEN : CI_RED;
}

// Stage 34 (canary run 5, defect N5): WHICH repository the snapshot describes
// is resolved HERE, upstream of gh, in gh's own documented precedence — an
// explicit --repo (the caller's flag), then the GH_REPO environment variable,
// then the cwd's git remotes (resolved by naming nothing and letting gh look,
// byte-identically to every release before this one — stage 23's cwd-honesty).
// Leaving the env rung to gh itself was the defect: the GH_REPO override only
// reaches -R-capable subcommands, and `gh repo view` is not one (it takes its
// repository as a positional argument), so `GH_REPO=owner/name verity state
// next` in a remoteless clone died `no-repo — no git remotes found` at the
// probe even though the caller had named the repository (tick 11). A resolved
// repository therefore travels EXPLICITLY on every read's argv below.
function resolveRepo(explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    return explicit;
  }
  const env = process.env.GH_REPO;
  return typeof env === 'string' && env !== '' ? env : null;
}

function fetchSnapshot(cwd, opts = {}) {
  // Each failed read is recorded, with its reason, instead of collapsing into
  // an empty list. A read that failed yields `null` — NOT `[]` — so even the
  // raw snapshot cannot be mistaken for "looked, and there is nothing".
  const failures = [];
  // EVERY read goes through here, and every read therefore resolves its
  // repository from `cwd` — the directory Verity was pointed at (stage 23) —
  // unless the caller pointed one rung higher (stage 34, `pointed` above it).
  const read = (source, args) => {
    const r = ghJson(args, cwd);
    if (r.ok) {
      return r.data;
    }
    failures.push({ source, reason: r.reason, detail: r.detail });
    return null;
  };

  // The pointed-at repository (or null → the cwd's remotes, argv unchanged).
  const pointed = resolveRepo(opts.repo);
  const target = pointed === null ? [] : ['--repo', pointed];
  const issues = read('issues', [
    'issue',
    'list',
    '--state',
    'all',
    '--limit',
    '300',
    '--json',
    'number,title,state,labels,assignees',
    ...target,
  ]);
  const prsRaw = read('prs', [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    '300',
    '--json',
    'number,title,state,headRefName,statusCheckRollup,labels',
    ...target,
  ]);
  // Every PR carries BOTH readings: the three-state `ciState` (the truth) and
  // the legacy `ciGreen` boolean (kept so existing consumers of the snapshot
  // keep working). ciGreen is derived FROM ciState, so the two can never drift
  // and ciGreen can never be true for an unverified PR.
  const prs =
    prsRaw === null
      ? null
      : prsRaw.map((p) => {
          const ciState = rollupState(p.statusCheckRollup);
          return { ...p, ciState, ciGreen: ciState === CI_GREEN };
        });
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
  // The probe names the repository POSITIONALLY — `repo view` has no -R flag,
  // so neither `--repo` nor GH_REPO can ever reach it (the stage-34 defect's
  // exact mechanism). Null keeps the frozen no-argument probe.
  const repo = read(
    'repo',
    pointed === null
      ? ['repo', 'view', '--json', 'name']
      : ['repo', 'view', pointed, '--json', 'name'],
  );
  // `online` keeps its exact old meaning (the repo probe answered) for existing
  // readers of the projection. `verified` is the new, stricter question: was
  // EVERY read observed? A partial answer is not a whole one — issues without
  // PRs derives a stage that has "no PR", which is the same falsehood in half.
  return { issues, prs, tags, online: repo !== null, verified: failures.length === 0, failures };
}

// Was this snapshot actually OBSERVED? `false` ONLY when fetchSnapshot stamped
// it so. An injected snapshot (tests, embedders) carries no `verified` field
// and reads as verified — the same rule ciStateOf applies to the legacy CI
// boolean: an old-shaped snapshot can never manufacture the new state, so no
// existing consumer's behavior changes.
function snapshotVerified(snapshot) {
  return snapshot?.verified !== false;
}

// The operator-facing explanation of an unverified snapshot: which reads failed
// and why. Never a credential — ghJson redacts before the detail gets here.
function unverifiedMessage(snapshot) {
  const failures = snapshot?.failures || [];
  const parts = failures.map((f) => `${f.source}: ${f.reason} — ${f.detail}`);
  const why = parts.length > 0 ? parts.join('; ') : 'no diagnostic captured';
  return `GitHub state could NOT be read, so Verity cannot tell "there is nothing there" from "we could not look" — refusing to answer rather than report a confident empty state (${why})`;
}

// The refusal `verity state` raises. exitCode 30 is this codebase's
// environment/infra code (agent-exec infra_error, verity-worker infra) — an
// unreachable GitHub is exactly that, not a policy violation and not a bad
// argument.
class StateUnverifiedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateUnverifiedError';
    this.exitCode = 30;
  }
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0] || 'view';
  // Stage 20 (issue #60): fetch HERE, and refuse BEFORE any answer is composed.
  // Chosen over an explicit `unknown` status in the projection: this is the
  // boundary a human and a role read, and there is no partial answer to "what
  // is stage N's status" that a caller cannot misread — emitting an object at
  // all is the invitation. The gh calls and their order are unchanged, so the
  // healthy path is byte-identical.
  // Stage 34: `--repo` (additive) points the GitHub half of the derivation at
  // a named repository — fetchSnapshot resolves flag → GH_REPO → cwd remotes.
  const snapshot = fetchSnapshot(cwd, { repo: flags.repo });
  if (!snapshotVerified(snapshot)) {
    throw new StateUnverifiedError(`verity state ${verb}: ${unverifiedMessage(snapshot)}`);
  }
  const proj = project(cwd, { snapshot });
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
  CI_GREEN,
  CI_RED,
  CI_UNKNOWN,
  StateUnverifiedError,
  rollupState,
  rollupGreen,
  ciStateOf,
  readStages,
  parseStageFile,
  deriveStatus,
  unblocked,
  latestTag,
  failureReason,
  redact,
  fetchSnapshot,
  snapshotVerified,
  unverifiedMessage,
  project,
  summarize,
  dispatch,
};
