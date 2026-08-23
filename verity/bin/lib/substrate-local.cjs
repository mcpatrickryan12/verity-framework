// Local delivery-substrate driver (stage 80, ADR-0029, contract
// local-work-item v1 — FROZEN). The GitHub substrate's snapshot acquirer
// (ledger.fetchSnapshot) and its bounded issue write-backs get LOCAL
// equivalents here, so the derive layer (`ledger.project` / `deriveStatus` /
// `next.decide`) runs unmodified on either substrate — zero substrate
// conditionals live in decision logic (the ADR-0029 invariant; the seam is
// acquisition + write-back only, exactly where ADR-0005 put the codex seam).
//
// READ half — fetchLocalSnapshot(cwd) assembles the SAME snapshot shape
// fetchSnapshot returns ({ issues, prs, tags, online, verified, failures }):
//   - `.verity/work-items/<n>.json` records → issues[] (contract schema,
//     field-for-field the `gh issue list --json` read: number, title, state,
//     labels, assignees). Labels are flat strings — every consumer
//     (next.labelSet, operator.labelName) already accepts strings or {name}.
//   - per stage branch (`feat/stage-N-*`, ledger.prMatches' own headRefName
//     convention) git state + the matching `.verity/gate-runs/<slug>.json`
//     record → the prs[] entry. `state`: OPEN while unmerged, MERGED once the
//     branch is contained in the default branch (the engine's local `--no-ff`
//     merge, contract §Snapshot assembly). `statusCheckRollup` is synthesized
//     per the contract's HONESTY RULE (load-bearing): green ONLY when a
//     gate-run record exists whose `sha` equals the branch's CURRENT head and
//     every `gates[].exit_code` is 0 → one SUCCESS conclusion per gate; any
//     nonzero → a FAILURE entry (red); no record / stale sha / empty gates →
//     an EMPTY rollup, so ledger.rollupState reads UNKNOWN and the existing
//     ci:unverified gate fires. Green is never inferred, carried forward, or
//     defaulted. Stage 82's gate runner (gates.cjs + writeGateRun below) is
//     the ONLY writer of these records.
//   - `online` is always true (there is no network to be offline from);
//     `verified` reflects LOCAL readability: an unreadable / corrupt /
//     schema-invalid record ⇒ verified:false + a failures[] entry — the stage-20
//     state:unverified semantics carry over verbatim (next.decide gates; the
//     driver never guesses past a record it could not honestly read).
//
// WRITE half — the bounded work-item ops the worker/operator perform on issues
// today (create, label add/remove, close) as engine-performed record edits,
// each committed to the repo (worker-owned, ADR-0026: roles never write these
// files). Every write round-trips through the READ half by construction.
//
// Substrate dispatch — resolveSubstrate/fetchSubstrateSnapshot are the tiny
// seam the acquisition sites (next.dispatch, operator.cjs) call: the stage-79
// `policy.substrate` accessor selects the acquirer, 'github' (and any policy
// Verity cannot read — fail toward today's engine, whose own gh reads then
// fail honestly) stays byte-identical to ledger.fetchSnapshot.
//
// Node built-ins only (zero-dependency repo).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const autonomy = require('./autonomy.cjs');
const ledger = require('./ledger.cjs');

// Contract-fixed locations, relative to the repo root.
const WORK_ITEMS_DIR = path.join('.verity', 'work-items');
const GATE_RUNS_DIR = path.join('.verity', 'gate-runs');

// The stage-branch convention ledger.prMatches already keys on (headRefName
// startsWith `feat/stage-N-`) — the same branches stage.branchName creates.
const STAGE_BRANCH_RE = /^feat\/stage-(\d+)-/;

// --- git plumbing (result-shaped, never throws) ------------------------------

function git(cwd, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// The gate-run filename key: `<branch-slug>.json` (contract §Schema). Branch
// names carry '/', filenames cannot — the slug is the branch with every '/'
// flattened to '-' (`feat/stage-3-x` → `feat-stage-3-x.json`). Stage 82's
// writer must use this same key; the round-trip tests pin it.
function branchSlug(branch) {
  return String(branch).replace(/\//g, '-');
}

// The default branch, as a REF usable in merge-base/rev-list, resolved the way
// the stage lifecycle resolves its base (git-lifecycle.resolveBase rung 1):
// `refs/remotes/origin/HEAD` — ADR-0029's local provision wires a bare origin
// with an explicit set-head, so the same rung serves both substrates. Fallback
// for repos without an origin (fixtures, pre-provision): a local main/master,
// then whatever branch HEAD names. null when nothing resolves.
function defaultBranchRef(cwd) {
  const remote = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.stdout.trim() !== '') {
    return remote.stdout.trim();
  }
  for (const name of ['main', 'master']) {
    if (git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok) {
      return name;
    }
  }
  const head = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return head.ok && head.stdout.trim() !== '' ? head.stdout.trim() : null;
}

// --- record validation (the honesty rule's "schema-invalid ⇒ never guess") ---

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// Work-item record (contract §Schema) — field-for-field the issue snapshot the
// ledger reads. Returns an error string, or null when valid.
function workItemError(rec, expectedNumber) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return 'not an object';
  }
  if (rec.schema !== 1) {
    return `schema must be 1 (got ${JSON.stringify(rec.schema)})`;
  }
  if (!Number.isInteger(rec.number) || rec.number <= 0) {
    return `number must be a positive integer (got ${JSON.stringify(rec.number)})`;
  }
  if (expectedNumber !== undefined && rec.number !== expectedNumber) {
    // The filename MUST equal `<number>.json` (contract) — a mismatch is a
    // record Verity cannot trust either way.
    return `number ${rec.number} does not match its filename (${expectedNumber}.json)`;
  }
  if (typeof rec.title !== 'string' || rec.title === '') {
    return 'title must be a non-empty string';
  }
  if (rec.state !== 'OPEN' && rec.state !== 'CLOSED') {
    // Uppercase, matching the `gh --json` casing the derive layer switches on.
    return `state must be "OPEN" or "CLOSED" (got ${JSON.stringify(rec.state)})`;
  }
  if (!isStringArray(rec.labels)) {
    return 'labels must be a flat string array';
  }
  if (!Array.isArray(rec.assignees)) {
    return 'assignees must be an array';
  }
  if (typeof rec.created_at !== 'string' || typeof rec.updated_at !== 'string') {
    return 'created_at/updated_at must be ISO timestamp strings';
  }
  return null;
}

// Gate-run record (contract §Schema). Only sha + gates are load-bearing for
// the honesty rule, but a record that does not match the frozen schema is not
// a record Verity may reason from at all — schema-invalid ⇒ verified:false.
function gateRunError(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return 'not an object';
  }
  if (rec.schema !== 1) {
    return `schema must be 1 (got ${JSON.stringify(rec.schema)})`;
  }
  if (typeof rec.branch !== 'string' || rec.branch === '') {
    return 'branch must be a non-empty string';
  }
  if (typeof rec.sha !== 'string' || rec.sha === '') {
    return 'sha must be a non-empty string';
  }
  if (!Array.isArray(rec.gates)) {
    return 'gates must be an array';
  }
  for (const g of rec.gates) {
    if (
      g === null ||
      typeof g !== 'object' ||
      typeof g.name !== 'string' ||
      !Number.isInteger(g.exit_code)
    ) {
      return 'every gates[] entry needs a string name and an integer exit_code';
    }
  }
  return null;
}

// --- READ half: the local snapshot acquirer ----------------------------------

// The `[stage N]` title convention — same predicate as ledger.matchesStage
// (not exported there; the byte-equal duplicate is the whole coupling).
function titleMatchesStage(title, number) {
  return typeof title === 'string' && title.startsWith(`[stage ${number}]`);
}

function readWorkItemRecords(cwd, failures) {
  const dir = path.join(cwd, WORK_ITEMS_DIR);
  if (!fs.existsSync(dir)) {
    // A missing store is a valid EMPTY store (nothing created yet), not a read
    // failure — same as a repo with zero issues.
    return [];
  }
  const issues = [];
  const names = fs
    .readdirSync(dir)
    .filter((n) => /^\d+\.json$/.test(n))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const name of names) {
    const file = path.join(dir, name);
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Unreadable/corrupt ⇒ verified:false — state:unverified semantics; the
      // record is EXCLUDED (never guessed), and the failure names the file.
      failures.push({
        source: 'work-items',
        reason: 'record-unreadable',
        detail: `${path.join(WORK_ITEMS_DIR, name)}: ${String(err?.message || err).split('\n')[0]}`,
      });
      continue;
    }
    const bad = workItemError(rec, Number.parseInt(name, 10));
    if (bad !== null) {
      failures.push({
        source: 'work-items',
        reason: 'record-invalid',
        detail: `${path.join(WORK_ITEMS_DIR, name)}: ${bad}`,
      });
      continue;
    }
    // Project EXACTLY the issue-snapshot fields the ledger reads (extra keys in
    // a future additive record version never leak into the snapshot).
    issues.push({
      number: rec.number,
      title: rec.title,
      state: rec.state,
      labels: [...rec.labels],
      assignees: [...rec.assignees],
    });
  }
  return issues;
}

// statusCheckRollup for one branch, per the contract honesty rule. `failures`
// collects unreadable/invalid records (⇒ verified:false); every UNKNOWN
// branch of the rule returns [] so ledger.rollupState reads CI_UNKNOWN.
function gateRunRollup(cwd, branch, headSha, failures) {
  const rel = path.join(GATE_RUNS_DIR, `${branchSlug(branch)}.json`);
  const file = path.join(cwd, rel);
  if (!fs.existsSync(file)) {
    return []; // no record ⇒ UNKNOWN (stage 82's runner is the only writer)
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures.push({
      source: 'gate-runs',
      reason: 'record-unreadable',
      detail: `${rel}: ${String(err?.message || err).split('\n')[0]}`,
    });
    return [];
  }
  const bad = gateRunError(rec);
  if (bad !== null) {
    failures.push({ source: 'gate-runs', reason: 'record-invalid', detail: `${rel}: ${bad}` });
    return [];
  }
  if (rec.sha !== headSha) {
    return []; // stale sha ⇒ UNKNOWN (green is never carried forward)
  }
  if (rec.gates.length === 0) {
    return []; // empty gates ⇒ UNKNOWN (an empty run proves nothing)
  }
  // exit_code is the judged truth (never parsed output): 0 ⇒ SUCCESS, anything
  // else ⇒ FAILURE — so ledger.rollupState reads green only when ALL are 0.
  return rec.gates.map((g) => ({
    name: g.name,
    conclusion: g.exit_code === 0 ? 'SUCCESS' : 'FAILURE',
  }));
}

// The PR's registration-relevant timestamp (ADR-0027): the branch's FIRST
// unique commit time — old enough by the time a snapshot is read that the
// ci:unverified recency grace (next.decide) does not defer a genuinely
// record-less local branch forever, yet honest for a just-forked branch. A
// merged branch (no unique commits left) falls back to its tip commit time.
function branchCreatedAt(cwd, branch, base) {
  const first = git(cwd, ['log', '--reverse', '--format=%cI', `${base}..${branch}`]);
  const firstLine = first.ok ? first.stdout.split('\n').find((l) => l.trim() !== '') : undefined;
  if (firstLine) {
    return firstLine.trim();
  }
  const tip = git(cwd, ['log', '-1', '--format=%cI', branch]);
  return tip.ok && tip.stdout.trim() !== '' ? tip.stdout.trim() : null;
}

function stageBranches(cwd) {
  const res = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (!res.ok) {
    return null;
  }
  return res.stdout.split('\n').filter((b) => STAGE_BRANCH_RE.test(b));
}

// One synthesized prs[] entry (or null when the branch carries no PR-shaped
// fact yet). Numbering: the matched `[stage N]` work-item record's number when
// one exists — so the derive layer's issue∪PR label union and the write ops'
// record addressing agree on ONE number per stage, exactly as GitHub's shared
// issue/PR number space behaves — else the stage number (display-only
// fallback; a stage the worker planned always has a record first).
function synthesizePr(cwd, branch, base, baseSha, issues, failures) {
  const n = Number(STAGE_BRANCH_RE.exec(branch)[1]);
  const head = git(cwd, ['rev-parse', '--verify', branch]);
  if (!head.ok) {
    failures.push({
      source: 'prs',
      reason: 'git-error',
      detail: `${branch}: ${String(head.error?.message || head.error).split('\n')[0]}`,
    });
    return null;
  }
  const headSha = head.stdout.trim();
  if (headSha === baseSha) {
    // Just forked, zero commits of its own: no PR exists in the GitHub analogy
    // either (a PR needs commits), so no entry — the stage derives from its
    // work-item exactly as a pre-PR stage does today.
    return null;
  }
  // Merged = the branch is contained in the default branch (the engine's local
  // `--no-ff` merge leaves the tip an ancestor of the default, contract
  // §Snapshot assembly); unmerged = OPEN.
  const merged = git(cwd, ['merge-base', '--is-ancestor', branch, base]).ok;
  const record = issues.find((i) => titleMatchesStage(i.title, n));
  const rollup = gateRunRollup(cwd, branch, headSha, failures);
  // Same derived stamps fetchSnapshot puts on every PR: the three-state
  // ciState (truth) plus the legacy ciGreen boolean derived FROM it.
  const ciState = ledger.rollupState(rollup);
  return {
    number: record ? record.number : n,
    title: record ? record.title : `[stage ${n}] ${branch}`,
    state: merged ? 'MERGED' : 'OPEN',
    headRefName: branch,
    statusCheckRollup: rollup,
    // Labels live on the work-item RECORD (the only local carrier — contract:
    // the full T02 vocabulary applies to records); consumers read the
    // issue∪PR union, so an empty PR-side set changes nothing.
    labels: [],
    createdAt: branchCreatedAt(cwd, branch, base),
    ciState,
    ciGreen: ciState === ledger.CI_GREEN,
  };
}

// The local snapshot acquirer — same shape as ledger.fetchSnapshot, no gh.
function fetchLocalSnapshot(cwd) {
  const failures = [];
  const issues = readWorkItemRecords(cwd, failures);

  const prs = [];
  const branches = stageBranches(cwd);
  if (branches === null) {
    // Not a git repo / git failed: the PR half of the snapshot is unobservable,
    // which is a verified:false, never an empty confident answer (stage 20).
    failures.push({
      source: 'prs',
      reason: 'git-error',
      detail: `could not enumerate branches under ${cwd}`,
    });
  } else if (branches.length > 0) {
    const base = defaultBranchRef(cwd);
    const baseRes = base === null ? { ok: false } : git(cwd, ['rev-parse', '--verify', base]);
    if (base === null || !baseRes.ok) {
      failures.push({
        source: 'prs',
        reason: 'no-default-branch',
        detail: 'stage branches exist but no default branch resolves (origin/HEAD, main, master)',
      });
    } else {
      const baseSha = baseRes.stdout.trim();
      for (const branch of branches) {
        const pr = synthesizePr(cwd, branch, base, baseSha, issues, failures);
        if (pr !== null) {
          prs.push(pr);
        }
      }
    }
  }

  // Tags: byte-identical to fetchSnapshot's own git read (release derivation).
  let tags = [];
  const tagRes = git(cwd, ['tag']);
  if (tagRes.ok) {
    tags = tagRes.stdout.split('\n').filter(Boolean);
  }

  // online:true — the local substrate has no network to be offline from; the
  // honest axis here is `verified` (could every record actually be READ?).
  return { issues, prs, tags, online: true, verified: failures.length === 0, failures };
}

// --- WRITE half: work-item ops (engine-performed, worker-owned ADR-0026) -----

function recordRel(number) {
  return path.join(WORK_ITEMS_DIR, `${number}.json`);
}

// Commit ONE record file (add + pathspec commit, so concurrent staged state in
// the working tree is never swept into an engine bookkeeping commit). Throws on
// failure — a work-item write that did not commit is a write that did not
// happen (the record store is the committed files, contract §Exposes).
function commitRecord(cwd, rel, message) {
  execFileSync('git', ['-C', cwd, 'add', '--', rel], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', cwd, 'commit', '-m', message, '--', rel], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeRecord(cwd, rec) {
  const rel = recordRel(rec.number);
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return rel;
}

// Read one record for a WRITE op. Fail-closed and loud: a missing / corrupt /
// schema-invalid record throws (never guess, never "repair") — mirroring a gh
// write against a broken issue failing rather than inventing one.
function readWorkItem(cwd, number) {
  const rel = recordRel(number);
  const file = path.join(cwd, rel);
  if (!fs.existsSync(file)) {
    throw new Error(`no local work-item record ${rel}`);
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`local work-item record ${rel} is unreadable: ${err.message}`);
  }
  const bad = workItemError(rec, number);
  if (bad !== null) {
    throw new Error(`local work-item record ${rel} is invalid: ${bad}`);
  }
  return rec;
}

// Stage 85 (ADR-0029; stage-83 review): the FULL validated record list — the
// scanner's local tier reads and the worker's deferred-refusal re-check need
// `created_at` (FIFO ordering), which the snapshot projection deliberately
// strips (it mirrors the ledger's issue fields exactly). This is a READ of the
// frozen contract store, not a snapshot-shape change: the records already
// carry created_at (contract §Schema). Fail-closed and loud like readWorkItem:
// an unreadable / corrupt / schema-invalid record THROWS — a label query the
// engine cannot honestly answer must never quietly answer "no matches"
// (the gh path's failed list query throws too).
function listWorkItems(cwd) {
  const dir = path.join(cwd, WORK_ITEMS_DIR);
  if (!fs.existsSync(dir)) {
    return []; // a missing store is a valid EMPTY store (stage-80 rule)
  }
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d+\.json$/.test(n))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((n) => readWorkItem(cwd, Number.parseInt(n, 10)));
}

// Stage 85 (ADR-0029): the local answer to `gh pr view N --json headRefOid` —
// the current head SHA of the stage branch carrying local PR #n, resolved from
// the stage-80 snapshot (branch mapping) + git itself (the head). Throws when
// no OPEN local PR carries the number or the head cannot be resolved — the gh
// path throws on a failed view too, and both callers (the worker's
// parkedResultPointer / resumeParkedResult) already handle a throw as
// honest-unknown / fail-closed refusal. Never fabricated.
function localPrHead(cwd, prNumber) {
  const snap = fetchLocalSnapshot(cwd);
  const entry = snap.prs.find((p) => p.number === prNumber && p.state === 'OPEN');
  if (entry === undefined) {
    throw new Error(
      `no open local stage branch carries PR #${prNumber} — no head to read (stage 85, ADR-0029)`,
    );
  }
  const head = git(cwd, ['rev-parse', '--verify', entry.headRefName]);
  if (!head.ok || head.stdout.trim() === '') {
    throw new Error(`could not resolve the head of ${entry.headRefName} for local PR #${prNumber}`);
  }
  return head.stdout.trim().toLowerCase();
}

// Next free number: max existing record number + 1 (never reused — CLOSED
// records keep their files, so a closed number can never be handed out again).
function nextNumber(cwd) {
  const dir = path.join(cwd, WORK_ITEMS_DIR);
  if (!fs.existsSync(dir)) {
    return 1;
  }
  const nums = fs
    .readdirSync(dir)
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number.parseInt(n, 10));
  return nums.length === 0 ? 1 : Math.max(...nums) + 1;
}

function isoNow(opts = {}) {
  return new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString();
}

// Create one work-item record — the local `gh issue create`. Writes the
// contract-schema record (nothing more: the frozen v1 field set exactly),
// commits it, returns the record.
function createWorkItem(cwd, { title, labels = [], assignees = [] } = {}, opts = {}) {
  if (typeof title !== 'string' || title === '') {
    throw new Error('createWorkItem requires a non-empty title');
  }
  if (!isStringArray(labels)) {
    throw new Error('createWorkItem labels must be a flat string array');
  }
  const now = isoNow(opts);
  const rec = {
    schema: 1,
    number: nextNumber(cwd),
    title,
    state: 'OPEN',
    labels: [...labels],
    assignees: [...assignees],
    created_at: now,
    updated_at: now,
  };
  const rel = writeRecord(cwd, rec);
  commitRecord(cwd, rel, `verity: create work-item #${rec.number} — ${title}`);
  return rec;
}

// Label ADD — the local `gh api POST .../labels`. Idempotent like GitHub's
// POST (already-present ⇒ no-op, no commit). Missing/corrupt record throws.
function addLabel(cwd, number, label, opts = {}) {
  const rec = readWorkItem(cwd, number);
  if (rec.labels.includes(label)) {
    return { changed: false, record: rec };
  }
  rec.labels.push(label);
  rec.updated_at = isoNow(opts);
  const rel = writeRecord(cwd, rec);
  commitRecord(cwd, rel, `verity: label work-item #${number} +${label}`);
  return { changed: true, record: rec };
}

// Label REMOVE — the local `gh api DELETE .../labels/<label>`, with the same
// idempotence the gh path's 404-tolerance provides: an absent label OR an
// absent record is the desired end-state already (no-op, no commit). A corrupt
// record still throws — absence is benign, unreadability is never.
function removeLabel(cwd, number, label, opts = {}) {
  if (!fs.existsSync(path.join(cwd, recordRel(number)))) {
    return { changed: false, record: null };
  }
  const rec = readWorkItem(cwd, number);
  if (!rec.labels.includes(label)) {
    return { changed: false, record: rec };
  }
  rec.labels = rec.labels.filter((l) => l !== label);
  rec.updated_at = isoNow(opts);
  const rel = writeRecord(cwd, rec);
  commitRecord(cwd, rel, `verity: label work-item #${number} -${label}`);
  return { changed: true, record: rec };
}

// Close — the local `gh issue close`. Idempotent (already CLOSED ⇒ no-op).
function closeWorkItem(cwd, number, opts = {}) {
  const rec = readWorkItem(cwd, number);
  if (rec.state === 'CLOSED') {
    return { changed: false, record: rec };
  }
  rec.state = 'CLOSED';
  rec.updated_at = isoNow(opts);
  const rel = writeRecord(cwd, rec);
  commitRecord(cwd, rel, `verity: close work-item #${number}`);
  return { changed: true, record: rec };
}

// --- stage 82 (ADR-0029 §4): the gate-run record WRITER ----------------------

// Write + commit ONE gate-run record (contract local-work-item v1, FROZEN) —
// the write half of gateRunRollup above, sharing its exact conventions by
// construction: the SAME branchSlug filename key, the SAME GATE_RUNS_DIR, and
// the SAME gateRunError schema check (a record this module would refuse to
// READ is never written). The caller (gates.runGatesForBranch) owns the
// honesty protocol that produced `rec` — sha pinned before the run and
// re-verified after; this function owns only the durable act.
//
// The record is committed on the DEFAULT branch, NEVER on the branch it
// judges: a record commit on the judged branch would advance that branch's
// head, making the record stale-by-sha (honesty rule: sha must equal the
// CURRENT head) the instant it exists. For the same reason a record ABOUT the
// default branch itself is refused outright. The checkout is restored to
// wherever the caller stood, mergeLocalPr's courtesy.
function writeGateRun(cwd, rec) {
  const bad = gateRunError(rec);
  if (bad !== null) {
    // Fail closed: never persist a record the READ half would flag invalid.
    throw new Error(`refusing to write an invalid gate-run record: ${bad}`);
  }
  const baseRef = defaultBranchRef(cwd);
  if (baseRef === null) {
    throw new Error(`cannot write a gate-run record: no default branch resolves in ${cwd}`);
  }
  const target = baseRef.replace(/^origin\//, '');
  if (!git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]).ok) {
    throw new Error(
      `cannot write a gate-run record: the default branch '${target}' has no local ref to commit it on`,
    );
  }
  if (rec.branch === target) {
    throw new Error(
      `refusing to write a gate-run record for '${rec.branch}': committing it there would move the very head it judges, making the record stale-by-sha immediately (contract honesty rule) — gate-run records exist for stage branches`,
    );
  }
  // TOCTOU guard (stage 84, stage-82 review finding 4). The caller
  // (gates.runGatesForBranch) pinned `rec.sha` before the run and re-verified
  // it after — but between that re-check and THIS commit the judged branch's
  // head can still move (nothing serializes the two). A cheap re-check here
  // narrows the window to the git commands below: refuse a record whose
  // branch no longer exists or whose head is no longer the claimed sha —
  // persisting it would mint a record that is stale-by-sha at birth (the
  // reader would honestly read it UNKNOWN, but a knowingly-stale write is
  // still a write this module must not perform; contract honesty rule).
  const headNow = git(cwd, ['rev-parse', '--verify', `refs/heads/${rec.branch}`]);
  if (!headNow.ok || headNow.stdout.trim() !== rec.sha) {
    throw new Error(
      `refusing to write a gate-run record for '${rec.branch}': its head is ${
        headNow.ok ? headNow.stdout.trim() : 'unresolvable'
      }, not the claimed ${rec.sha} — the branch moved (or vanished) since the gates ran, so the record would be stale-by-sha at birth (contract local-work-item honesty rule; stage 84 TOCTOU guard)`,
    );
  }
  const rel = path.join(GATE_RUNS_DIR, `${branchSlug(rec.branch)}.json`);
  const startSymbolic = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const startRef = startSymbolic.ok
    ? startSymbolic.stdout.trim()
    : gitOrThrow(cwd, ['rev-parse', 'HEAD'], 'gate-run record write').trim();
  const moved = startRef !== target;
  if (moved) {
    gitOrThrow(cwd, ['checkout', '--quiet', target], 'gate-run record write');
  }
  try {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    const verdict =
      rec.gates.length > 0 && rec.gates.every((g) => g.exit_code === 0) ? 'green' : 'red';
    // Pathspec commit, stage-80 writer style: only THIS record file is swept in.
    commitRecord(
      cwd,
      rel,
      `verity: gate run ${rec.branch} @ ${rec.sha.slice(0, 12)} — ${verdict} (stage 82, ADR-0029 §4)`,
    );
  } finally {
    if (moved) {
      // Restore the caller's checkout; never throws over the real outcome.
      git(cwd, ['checkout', '--quiet', startRef]);
    }
  }
  return rel;
}

// --- stage 81 (ADR-0029 §1): bare-origin provision ---------------------------

// git, throw-on-failure — for the stage-81 acts where a half-done step must be
// LOUD (a half-provisioned origin or a half-performed merge is worse than
// none). The result-shaped git() above stays the READ style; these are writes.
function gitOrThrow(cwd, args, what) {
  const res = git(cwd, args);
  if (!res.ok) {
    const detail = String(res.error?.stderr || res.error?.message || res.error)
      .split('\n')
      .find((l) => l.trim() !== '');
    throw new Error(`${what}: git ${args.join(' ')} failed: ${detail || 'unknown error'}`);
  }
  return res.stdout;
}

// Provision a bare sibling repository as `origin` (ADR-0029 §1: "`gh repo
// create` is replaced by three git commands"). After this, the EXISTING stage
// lifecycle (agents/git-lifecycle.cjs) runs UNCHANGED against a local repo:
//   - resolveBase rung 1 reads `refs/remotes/origin/HEAD` — set here by an
//     EXPLICIT `git remote set-head origin <branch>`, the same explicit
//     set-head the GitHub benchmark provision performs (benchmark.cjs stage 77;
//     `--auto` needs a remote HEAD query, which a fresh remote cannot answer);
//   - `git fetch origin` runs FIRST to materialize the `origin/<branch>`
//     tracking ref the explicit set-head points at (stage-77 quirk parity);
//   - the stage-77/78 fetch-before-branch behavior then keeps every stage
//     forking off the MERGED `origin/<default>`, exactly as on GitHub.
// Unlike the benchmark's best-effort GitHub steps, every step here THROWS on
// failure: this is an engine capability (consumed by stage-83 benchmark
// provision, later Fresh init), and a repo left half-wired would make
// resolveBase silently fall to a weaker rung.
function provisionBareOrigin(cwd, opts = {}) {
  const abs = path.resolve(cwd);
  const head = git(abs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch =
    opts.branch !== undefined ? String(opts.branch) : head.ok ? head.stdout.trim() : '';
  if (branch === '') {
    throw new Error(
      `provisionBareOrigin: cannot determine the default branch of ${abs} (detached HEAD?) — pass opts.branch`,
    );
  }
  const remotes = git(abs, ['remote']);
  if (remotes.ok && remotes.stdout.split('\n').some((l) => l.trim() === 'origin')) {
    // Fail-closed, never rewire: an existing origin (real or provisioned)
    // is an operator decision this helper must not silently replace.
    throw new Error(
      `provisionBareOrigin: ${abs} already has an 'origin' remote — refusing to rewire it`,
    );
  }
  const barePath =
    opts.barePath !== undefined
      ? path.resolve(opts.barePath)
      : path.join(path.dirname(abs), `${path.basename(abs)}-origin.git`);
  gitOrThrow(abs, ['init', '--bare', '--quiet', barePath], 'provisionBareOrigin');
  gitOrThrow(abs, ['remote', 'add', 'origin', barePath], 'provisionBareOrigin');
  gitOrThrow(abs, ['push', '--quiet', 'origin', branch], 'provisionBareOrigin');
  // Stage-77 parity, in the stage-77 order: fetch to materialize the tracking
  // ref, THEN the explicit set-head (its target ref must exist).
  gitOrThrow(abs, ['fetch', '--quiet', 'origin'], 'provisionBareOrigin');
  gitOrThrow(abs, ['remote', 'set-head', 'origin', branch], 'provisionBareOrigin');
  return { barePath, branch };
}

// --- stage 81 (ADR-0029 §3): the local merge bar reading + engine merge ------

// The verified CI reading for ONE open local stage PR — the SAME three-state
// `ledger.rollupState` trichotomy `review.ciStateFor` gets from gh, sourced
// from the stage-80 snapshot (whose rollup obeys the contract honesty rule:
// no gate-run record / stale sha / empty gates ⇒ UNKNOWN, never green). No
// entry (no such PR, or already merged) reads UNKNOWN — an unobservable state
// is never a green one.
function localCiStateFor(cwd, pr) {
  const snap = fetchLocalSnapshot(cwd);
  const entry = snap.prs.find((p) => p.number === pr && p.state === 'OPEN');
  return entry === undefined ? ledger.CI_UNKNOWN : entry.ciState;
}

// The local answer to trust.checksGreen's ONE question — "did Verity VERIFY
// this PR green?" — for which unverified and failing are the same answer: no
// (the stage-19 call-site rule carries over verbatim; UNKNOWN never merges).
function localChecksGreen(cwd, pr) {
  return localCiStateFor(cwd, pr) === ledger.CI_GREEN;
}

// Stage 84 (ADR-0029 consequence: operator contracts degrade honestly on
// local): the LOCAL source of trust.classify's diff evidence — the same two
// facts `gh pr diff --name-only` and `gh pr view --json additions,deletions`
// supply on the github substrate, read from git itself, which IS available
// locally. The three-dot (merge-base) diff is exactly the reading a GitHub PR
// diff presents, so the §4.5 policy rules (allowed/protected globs,
// max_changed_lines) judge the SAME evidence either substrate — resolved from
// the local substrate, never fabricated from a gh call that never ran.
// Binary files (numstat '-') contribute no line counts, matching GitHub's
// additions/deletions semantics. An unlocatable PR THROWS (the gh path throws
// too when gh fails): the caller either surfaces the failure loudly (worker
// trust-1) or maps it to honest-unknown nulls (operator gateEvidence's catch).
function localPrDiff(cwd, prNumber) {
  const snap = fetchLocalSnapshot(cwd);
  const entry = snap.prs.find((p) => p.number === prNumber && p.state === 'OPEN');
  if (entry === undefined) {
    throw new Error(
      `no open local stage branch carries PR #${prNumber} — nothing to classify (stage 84, ADR-0029)`,
    );
  }
  const base = defaultBranchRef(cwd);
  if (base === null) {
    throw new Error(
      `cannot classify PR #${prNumber}: no default branch resolves in ${cwd} (origin/HEAD, main, master)`,
    );
  }
  const branch = entry.headRefName;
  const what = `local PR #${prNumber} classification`;
  const files = gitOrThrow(cwd, ['diff', '--name-only', `${base}...${branch}`], what)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  let changedLines = 0;
  for (const line of gitOrThrow(cwd, ['diff', '--numstat', `${base}...${branch}`], what).split(
    '\n',
  )) {
    if (line.trim() === '') {
      continue;
    }
    const [added, deleted] = line.split('\t');
    const a = Number.parseInt(added, 10);
    const d = Number.parseInt(deleted, 10);
    if (Number.isInteger(a)) {
      changedLines += a;
    }
    if (Number.isInteger(d)) {
      changedLines += d;
    }
  }
  return { files, changed_lines: changedLines };
}

// Engine-performed local merge (ADR-0029 §3) — the local `gh pr merge`.
// ADR-0012/0013: Verity performs git; no role, no model, ever invokes this —
// its ONLY two callers are the deterministic merge sites (trust.merge, the
// autonomous ladder's write-back, and review.merge, the CLI gate), and BOTH
// verify the merge bar first (trust.checksGreen / review.canMerge over the
// stage-80 snapshot reading). This function is the act, not the decision.
//
// `--no-ff` where the GitHub path squashes — ACCEPTED divergence (stage 81):
// local keeps the stage's commits (the Fresh audit record is the history
// itself); graduation may squash later if desired. `--no-ff` is also what
// makes the snapshot's MERGED derivation work: the branch tip stays an
// ancestor of the default branch (contract §Snapshot assembly).
//
// Sequence: checkout <default> → merge --no-ff → close the stage's work-item
// record (the local analog of the PR-body `Closes #N` auto-close — a stage-80
// write op, committed on the default branch so ONE push carries both) → push
// to the bare origin (advancing origin/<default>, so the NEXT stage's
// fetch-before-branch forks off the merged base — stages 77/78, replayed
// locally) → restore the checkout the run found (git-lifecycle.restore's
// courtesy, same reasoning).
function mergeLocalPr(cwd, prNumber) {
  const snap = fetchLocalSnapshot(cwd);
  const entry = snap.prs.find((p) => p.number === prNumber);
  if (entry === undefined) {
    throw new Error(`no local stage branch carries PR #${prNumber} — nothing to merge`);
  }
  if (entry.state !== 'OPEN') {
    throw new Error(
      `PR #${prNumber} (${entry.headRefName}) is already ${entry.state} — nothing to merge`,
    );
  }
  const branch = entry.headRefName;
  const baseRef = defaultBranchRef(cwd);
  if (baseRef === null) {
    throw new Error(`cannot merge PR #${prNumber}: no default branch resolves in ${cwd}`);
  }
  // The LOCAL default branch the merge commit lands on (origin/<name> → <name>;
  // provision pushed it, so it exists in every ADR-0029 §1 repo).
  const target = baseRef.replace(/^origin\//, '');
  if (!git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]).ok) {
    throw new Error(
      `cannot merge PR #${prNumber}: the default branch '${target}' has no local ref to merge into`,
    );
  }
  const startSymbolic = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const startRef = startSymbolic.ok
    ? startSymbolic.stdout.trim()
    : gitOrThrow(cwd, ['rev-parse', 'HEAD'], `merge of PR #${prNumber}`).trim();
  gitOrThrow(cwd, ['checkout', '--quiet', target], `merge of PR #${prNumber}`);
  try {
    const mergeRes = git(cwd, [
      'merge',
      '--no-ff',
      '--quiet',
      '-m',
      `verity: merge ${branch} (#${prNumber}) — engine-performed local merge (ADR-0029 §3)`,
      branch,
    ]);
    if (!mergeRes.ok) {
      git(cwd, ['merge', '--abort']); // best-effort; a no-merge-in-progress abort just fails
      const detail = String(mergeRes.error?.stderr || mergeRes.error?.message || mergeRes.error)
        .split('\n')
        .find((l) => l.trim() !== '');
      throw new Error(
        `could not merge ${branch} into ${target} for PR #${prNumber}: ${detail || 'merge failed'}`,
      );
    }
    // Close the stage's work-item record BEFORE the push, so the one push
    // carries merge + close. Tolerate an absent record (the display-only
    // fallback numbering: a branch with no record has nothing to close) —
    // absence is benign, but closeWorkItem still throws on a CORRUPT record
    // (unreadability is never benign, contract honesty rule).
    let workItemClosed = false;
    if (fs.existsSync(path.join(cwd, recordRel(prNumber)))) {
      closeWorkItem(cwd, prNumber);
      workItemClosed = true;
    }
    gitOrThrow(
      cwd,
      ['push', '--quiet', 'origin', target],
      `merge of PR #${prNumber} committed locally on '${target}' but`,
    );
    return { merged: true, pr: prNumber, branch, base: target, workItemClosed, method: 'no-ff' };
  } finally {
    // Put the checkout back where the caller had it — never throws over the
    // real outcome (a failed restore would mask the merge result).
    if (startRef !== target) {
      git(cwd, ['checkout', '--quiet', startRef]);
    }
  }
}

// --- substrate dispatch (the stage-79 seam's consumer side) ------------------

// Stage 85 (ADR-0029; operator-smoke runs 4/5): the ENGINE-SET substrate pin.
// The worker resolves the run's substrate ONCE from the frozen policy
// (runOnce) and exports `VERITY_SUBSTRATE=local` to its children — mirroring
// its GH_REPO export — because a dispatched role shells engine commands
// (`verity state`, `verity stage pr`, `verity operator snapshot`) from a
// STAGE-BRANCH checkout whose tree can PREDATE the substrate policy (the
// smoke's skew: the run-half variant commit forked stage branches off an
// origin/<default> without it), and a cwd re-derivation there silently flips
// those commands onto the github code paths. The pin is the run's own frozen
// resolution traveling with the run — provenance: ONLY the engine sets it,
// only the value 'local' is honored (the sole value the engine ever pins;
// anything else is ignored and resolution falls to the policy, the
// fail-toward-github direction), and it is DEFAULT-ABSENT: no worker export ⇒
// byte-identical policy resolution everywhere, github runs never set it.
function pinnedSubstrate(env = process.env) {
  return env.VERITY_SUBSTRATE === 'local' ? 'local' : null;
}

// The resolved `policy.substrate` (stage 79: loadPolicy stamps it — absent ⇒
// 'github', unknown values refused at validation). Any problem reading the
// policy resolves to 'github': the failure direction that keeps behavior
// byte-identical to today (whose gh reads then fail with their own honest
// diagnostics) — a policy Verity cannot read never activates a driver.
// Stage 85: the engine-set pin (above) outranks the cwd re-derivation — the
// run's frozen resolution over a checkout that may predate the policy.
function resolveSubstrate(cwd) {
  const pinned = pinnedSubstrate();
  if (pinned !== null) {
    return pinned;
  }
  try {
    return autonomy.loadPolicy(cwd).substrate;
  } catch {
    return 'github';
  }
}

// The ONE acquisition dispatcher the snapshot sites call (next.dispatch,
// operator.cjs). 'github' (and everything that is not exactly 'local') routes
// to ledger.fetchSnapshot with the same args as before — byte-identical.
// `opts.substrate` short-circuits resolution (tests; callers that already
// hold a loaded policy).
function fetchSubstrateSnapshot(cwd, opts = {}) {
  const substrate = opts.substrate === undefined ? resolveSubstrate(cwd) : opts.substrate;
  if (substrate === 'local') {
    return fetchLocalSnapshot(cwd);
  }
  return ledger.fetchSnapshot(cwd, { repo: opts.repo });
}

module.exports = {
  WORK_ITEMS_DIR,
  GATE_RUNS_DIR,
  branchSlug,
  fetchLocalSnapshot,
  listWorkItems,
  localPrHead,
  createWorkItem,
  addLabel,
  removeLabel,
  closeWorkItem,
  readWorkItem,
  pinnedSubstrate,
  resolveSubstrate,
  fetchSubstrateSnapshot,
  provisionBareOrigin,
  localCiStateFor,
  localChecksGreen,
  localPrDiff,
  mergeLocalPr,
  writeGateRun,
};
