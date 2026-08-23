// Worker-owned, idempotent work-item reconciliation (ADR-0026, #176).
//
// After a PLAN role returns, the WORKER — which holds ambient `gh` (tier-2
// containment strips `gh` credentials only from the child SANDBOX, never the
// worker process, ADR-0011) — creates a `[stage N]` GitHub issue for every
// stage-instructions/stage-N-*.md that has no such issue yet, from the payload
// stage.cjs already computes. This is the deterministic projection ADR-0026
// makes worker-owned: the contained plan agent cannot run `gh issue create`
// (`github_write` denied, `GH_TOKEN`/`GITHUB_TOKEN` stripped from childEnv), so
// under Codex the plan step wrote its local artifacts but never registered the
// work-items — the worker saw "no progress" and stalled at plan (#176). The
// worker creating them turns that stall into forward motion.
//
// Idempotent: keyed on the `[stage N]` number (next.cjs's own idempotency key).
// A re-dispatch, a partial prior run, or a stage the plan agent ALREADY
// registered (Claude, whose agent holds github_write) is a no-op — never a
// double-create.
//
// Default-OFF: reconcileWorkItems does NOTHING unless `flag === true`. OFF is
// byte-identical to today (agent-created). All `gh` access is dependency-
// injectable (opts.ghList / opts.ghCreate) so tests never touch the network,
// mirroring gh.cjs / benchmark.cjs.
const gh = require('./gh.cjs');
const stage = require('./stage.cjs');
// Stage 80 (ADR-0029): the local-substrate work-item store. Reconcile's list/
// create seams dispatch here when the resolved policy substrate is 'local' —
// through the SAME opts.ghList/opts.ghCreate injection shape, so the github
// path (and every existing injected test) is byte-identical.
const substrateLocal = require('./substrate-local.cjs');

// The `[stage N]` idempotency key, parsed off an existing issue title.
function stageNumFromTitle(title) {
  const m = /^\[stage (\d+)\]/.exec(String(title || ''));
  return m ? Number(m[1]) : null;
}

// Existing `[stage N]` issue titles, via the shared gh layer. `--state all` so a
// closed/merged stage's issue still counts — a completed stage is never
// re-created. Best-effort like the rest of the CLI's gh access.
function defaultGhList(cwd) {
  return gh
    .json(['issue', 'list', '--state', 'all', '--limit', '500', '--json', 'title'], { cwd })
    .map((i) => i.title);
}

// Deterministic `gh issue create` from the stage.cjs payload — one `--label` per
// label, exactly as the old inline plan-agent call and benchmark replay do.
function defaultGhCreate(cwd, issue) {
  const args = ['issue', 'create', '--title', issue.title];
  for (const label of issue.labels) {
    args.push('--label', label);
  }
  args.push('--body', issue.body);
  return gh.run(args, { cwd });
}

function firstLine(err) {
  return String(err?.message || err).split('\n')[0];
}

// --- local-substrate seams (stage 80, contract local-work-item v1) -----------

// Existing `[stage N]` titles from the local record store. THROWS when the
// store cannot be honestly read (verified:false) — the same "cannot enumerate ⇒
// cannot safely create" rule the gh path applies to a failed list, so a corrupt
// store never double-creates.
function localList(cwd) {
  const snap = substrateLocal.fetchLocalSnapshot(cwd);
  if (snap.verified === false) {
    const detail = (snap.failures || []).map((f) => f.detail).join('; ');
    throw new Error(`local work-item store could not be read: ${detail || 'unknown failure'}`);
  }
  return snap.issues.map((i) => i.title);
}

// Deterministic record create from the SAME stage.cjs payload the gh path uses.
// The record carries the frozen v1 field set only — the issue BODY is not a
// snapshot field the ledger reads and not a contract field; graduation replays
// bodies from the committed stage files (contract §Consumers).
function localCreate(cwd, issue) {
  return substrateLocal.createWorkItem(cwd, { title: issue.title, labels: issue.labels });
}

// Reconcile stage-instructions/ files → `[stage N]` GitHub issues. Returns
// { enabled, created:[numbers], skipped:[numbers], failed?:[{number,error}],
// error? }. `enabled:false` (the default-OFF path) makes NO gh calls at all.
function reconcileWorkItems(cwd, opts = {}) {
  if (opts.flag !== true) {
    return { enabled: false, created: [], skipped: [] };
  }
  // Stage 80 (ADR-0029): substrate-aware DEFAULTS only — an injected
  // ghList/ghCreate (every existing test, every embedder) still wins outright,
  // and 'github' (absent key, unreadable policy) resolves to the exact same
  // defaults as before this line existed.
  const substrate =
    opts.substrate === undefined ? substrateLocal.resolveSubstrate(cwd) : opts.substrate;
  const ghList = opts.ghList || (substrate === 'local' ? localList : defaultGhList);
  const ghCreate = opts.ghCreate || (substrate === 'local' ? localCreate : defaultGhCreate);

  let existing;
  try {
    existing = ghList(cwd);
  } catch (err) {
    // Cannot enumerate ⇒ cannot safely create (a create now might double up a
    // pre-existing issue we failed to read). Report and create nothing — the
    // same best-effort posture labels.ensureLabels takes on a failed list.
    return { enabled: true, created: [], skipped: [], error: firstLine(err) };
  }
  const have = new Set((existing || []).map(stageNumFromTitle).filter((n) => n !== null));

  const created = [];
  const skipped = [];
  const failed = [];
  for (const fileName of stage.list(cwd).stages) {
    // issueFor reads the stage file off disk — fold it into the best-effort
    // envelope too: a file that vanishes between stage.list() and the read (or
    // any parse error) must degrade to a `failed` entry, never throw out of
    // reconcile and crash an otherwise-SUCCESSFUL plan into an infra error.
    let issue;
    try {
      issue = stage.issueFor(cwd, fileName);
    } catch (err) {
      failed.push({ file: fileName, error: firstLine(err) });
      continue;
    }
    if (issue === null) {
      continue;
    }
    if (have.has(issue.number)) {
      skipped.push(issue.number);
      continue;
    }
    try {
      ghCreate(cwd, issue);
      created.push(issue.number);
      have.add(issue.number); // guard against two files claiming the same N
    } catch (err) {
      failed.push({ number: issue.number, error: firstLine(err) });
    }
  }

  const result = { enabled: true, created, skipped };
  if (failed.length > 0) {
    result.failed = failed;
  }
  return result;
}

module.exports = { reconcileWorkItems, stageNumFromTitle };
