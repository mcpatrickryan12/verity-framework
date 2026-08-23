// Local gate runner (stage 82, ADR-0029 §4) — the local substrate's
// verification oracle. A committed, SINGLE-SOURCE gate definition
// (`.verity/gates.json`: ordered, named commands) is executed by the engine and
// judged by EXIT CODE ONLY — the ADR-0028 test-honesty invariant: never parsed
// output, never through a pipe (each command's stdio is inherited or discarded,
// never captured for judgment; the ONLY verdict input is spawnSync's status).
// The run produces the SHA-pinned gate-run record of contract local-work-item
// v1 (FROZEN) that stage 80's snapshot driver reads
// (substrate-local.gateRunRollup → localCiStateFor), turning a local branch's
// honest UNKNOWN into a verified green/red.
//
// Contract properties fixed by ADR-0029 (Consequences):
//   - committed: the definition is read from the BRANCH HEAD's committed tree
//     (`git show <sha>:.verity/gates.json`), so an uncommitted edit can never
//     shape a record that claims a committed sha;
//   - ordered: gates run top to bottom, STOPPING at the first nonzero exit —
//     unrun gates are simply absent from the record's gates[] (the record is
//     red anyway via its nonzero entry; absence is never mistaken for green);
//   - exit-code judged: 0 ⇒ pass, anything else (including a command killed by
//     a signal, status null → recorded as 1) ⇒ fail;
//   - ABSENT ⇒ UNKNOWN, never green: no definition / unreadable / schema-
//     invalid / EMPTY gate list refuses the run and writes NO record, so the
//     stage-80 reader keeps answering UNKNOWN and the existing ci:unverified
//     gate fires. Green is never inferred, defaulted, or carried forward.
//
// SHA honesty (contract local-work-item v1 honesty rule): the record's `sha`
// is the exact head the gates ran against, pinned BEFORE the run and
// re-verified AFTER it. A dirty working tree before the run, a branch head
// that moved mid-run, or tracked files the gates themselves modified all
// REFUSE the record (fail closed) — a record must never claim a head its
// gates did not honestly test. Staleness stays detectable by SHA alone.
//
// The record is committed on the DEFAULT branch, never on the branch it
// judges: a record commit on the judged branch would MOVE that branch's head,
// making the record stale-by-sha the instant it exists (the honesty rule
// would then read the fresh record as UNKNOWN forever).
//
// The scaffolded CI workflow executes the SAME definition (a thin
// definition-reading step, templates/run-gates.cjs.tmpl) — so "tests exist but
// CI never runs them" (the issue-#203 defect class) is impossible by
// construction: graduation-day CI replays what was green all along (ADR-0028).
//
// Stages 87/89 (ADR-0030): WHERE the definition executes is a runner choice
// (`gate_runner`). This module is the `direct` runner and the single honesty
// bracket for every runner; the "run the commands" middle dispatches to
// gates-act.cjs when the resolved runner is 'localhost' (act in Docker here)
// and to gates-remote.cjs when it is 'remote:<name>' (the pinned sha pushed
// to a runner-side clone over SSH, act in Docker there) — see those modules'
// headers for the preflight refusals and the one-aggregate-entry mapping.
// The workflow both execute is rendered from the committed definition at the
// pinned sha, never from any working tree.
//
// Node built-ins only (zero-dependency repo).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const autonomy = require('./autonomy.cjs');
// Stage 88 (ADR-0030): the gate-runner catalog — a resolved `remote:<name>`
// runner resolves its NAME against ~/.verity/gate-runners.md before anything
// else (see resolveRemoteRunner below); resolution is read-only config, and
// as of stage 89 the descriptor it yields feeds the remote executor.
const gateRunners = require('./gate-runners.cjs');
// Stage 87 (ADR-0030): the localhost act executor — replaces ONLY the
// "run the commands" middle of runGatesForBranch when the resolved runner is
// 'localhost'; the honesty protocol around it stays this module's single path.
const gatesAct = require('./gates-act.cjs');
// Stage 89 (ADR-0030): the remote act executor — the same replace-only-the-
// middle contract as gates-act, executing on the catalog-named host over SSH.
const gatesRemote = require('./gates-remote.cjs');
const substrateLocal = require('./substrate-local.cjs');

// The committed gate-definition file, relative to the repo root. Shape:
//   { "schema": 1, "gates": [ { "name": "test", "command": "npm test" } ] }
// Documented in docs/autonomy.md §"Local substrate gates"; consumed here, by
// stage 83's benchmark fixtures, and by the scaffolded CI workflow.
const GATES_FILE = path.join('.verity', 'gates.json');

const USAGE = 'usage: verity gates run [--branch <branch>] [--no-record]';

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

// --- gate definition (parse + validate; invalid ⇒ throw, never a default) ----

// Validate parsed definition text. Fail closed on EVERY malformation — a
// definition Verity cannot honestly read is a repo with NO gates, which must
// read UNKNOWN downstream, never green and never a default gate list.
function parseGateDefinition(text, source) {
  let def;
  try {
    def = JSON.parse(text);
  } catch (err) {
    throw new Error(`gate definition ${source} is not valid JSON: ${err.message}`);
  }
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    throw new Error(`gate definition ${source} must be a JSON object`);
  }
  if (def.schema !== 1) {
    throw new Error(
      `gate definition ${source}: schema must be 1 (got ${JSON.stringify(def.schema)})`,
    );
  }
  if (!Array.isArray(def.gates) || def.gates.length === 0) {
    // An EMPTY gate list proves nothing — running it would write a record the
    // stage-80 reader correctly refuses (empty gates ⇒ UNKNOWN), so refuse
    // here, loudly, before any command runs (ADR-0029: absence ⇒ UNKNOWN).
    throw new Error(
      `gate definition ${source} defines no gates — an empty gate list can never read green (ADR-0029 §4); define at least one { "name", "command" } gate`,
    );
  }
  for (const g of def.gates) {
    if (
      g === null ||
      typeof g !== 'object' ||
      typeof g.name !== 'string' ||
      g.name === '' ||
      typeof g.command !== 'string' ||
      g.command === ''
    ) {
      throw new Error(
        `gate definition ${source}: every gates[] entry needs a non-empty string name and command`,
      );
    }
  }
  return def.gates.map((g) => ({ name: g.name, command: g.command }));
}

// The definition AT a commit — `git show <sha>:.verity/gates.json` — so the
// gates a record claims for `sha` are exactly the gates committed at `sha`
// (single-source, committed: ADR-0029). Missing from the tree ⇒ throw (no
// record is ever written; the branch stays UNKNOWN via stage 80's reader).
function readGateDefinitionAt(cwd, sha) {
  // git's path syntax here is '/'-separated regardless of platform.
  const res = git(cwd, ['show', `${sha}:.verity/gates.json`]);
  if (!res.ok) {
    throw new Error(
      `no gate definition at ${GATES_FILE} in commit ${sha} — a branch with no committed gates reads UNKNOWN, never green (ADR-0029 §4); commit a gate definition to run gates`,
    );
  }
  return parseGateDefinition(res.stdout, `${GATES_FILE}@${sha.slice(0, 12)}`);
}

// The working tree's definition — the --no-record path (CI checkouts, ad-hoc
// developer runs), where no record claims any sha.
function readGateDefinition(cwd) {
  const file = path.join(cwd, GATES_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no gate definition at ${GATES_FILE} — a repo with no committed gates must never read green (ADR-0029 §4)`,
    );
  }
  return parseGateDefinition(fs.readFileSync(file, 'utf8'), GATES_FILE);
}

// --- stage 86 (ADR-0030): the gate-runner seam -------------------------------

// This module IS the `direct` runner. The stage-86 `gate_runner` policy axis
// names WHERE the committed definition executes; any resolved value the
// engine cannot honestly execute REFUSES here, BEFORE anything runs — never a
// silent fall-through to direct execution (ADR-0030: the engine never
// silently executes on a different runner than configured) — and writes NO
// record, so the branch stays honestly UNKNOWN downstream. Admitted
// unchanged: `direct` and absent (pre-stage-86 callers and the local
// substrate's native resolution) name this runner by definition;
// `github-actions` only ever resolves on the github substrate (the local
// combo is a rejected-combination load error), where an ad-hoc `verity gates
// run` has always executed directly while CI stays the merge oracle —
// byte-identical to today. `localhost` executes as of stage 87 (the
// gates-act.cjs act executor) and `remote:<name>` as of stage 89 (the
// gates-remote.cjs SSH act executor — its NAME has already resolved against
// the catalog by the time execution reaches this guard, so admitting the
// prefix admits only resolvable runners). The fail-closed default stays for
// any FUTURE runner value that reaches execution before its executor exists:
// policy load already rejects unknown values, but a unit caller handing a
// raw string must refuse here, never fall through to direct execution. The
// ONE guard serves both call sites (the worker's runLocalGates and the CLI
// dispatch below).
function assertRunnerExecutable(runner) {
  if (
    runner === undefined ||
    runner === 'direct' ||
    runner === 'github-actions' ||
    runner === 'localhost' ||
    (typeof runner === 'string' && runner.startsWith('remote:'))
  ) {
    return;
  }
  throw new Error(
    `gate_runner '${runner}' is not a runner this engine can execute — refusing to execute on the direct runner instead (ADR-0030: the engine never silently executes on a different runner than configured); no record is written and the branch stays UNKNOWN`,
  );
}

// Stage 88 (ADR-0030): for a `remote:<name>` runner the catalog resolution
// runs FIRST, before any execution guard — ordering is the point: a typo'd
// name must fail as the CONFIG error it is (catalog path + known entry
// names, gate-runners.resolveRemote's fail-closed throws), never as an
// execution failure. Resolution happens ONCE, at run start, at
// config/preflight time — never mid-run — and is read-only. Stage 89: the
// resolved DESCRIPTOR ({name, host, user, target, path}) is returned so the
// remote executor can use it; it feeds preflight/execute and ERROR text only
// — the RECORD carries the catalog name alone, never the descriptor (stage-88
// hygiene precedent). Every other runner value returns null untouched (the
// catalog is inert unless `remote:<name>` is configured — kill-switch by
// design; absent config is byte-identical).
function resolveRemoteRunner(runner, opts = {}) {
  if (typeof runner === 'string' && runner.startsWith('remote:')) {
    return gateRunners.resolveRemote(runner.slice('remote:'.length), { home: opts.home });
  }
  return null;
}

// --- the executor: ordered, stop-at-first-failure, exit code is the verdict --

// Run gate commands in ORDER, stopping at the first nonzero exit. The verdict
// input is spawnSync's `status` and NOTHING else — output is inherited (or
// discarded via opts.stdio), never piped into a judgment, never parsed: a gate
// that prints "PASS" and exits 1 is a FAILURE (ADR-0028 test-honesty
// invariant; the exact defect class the exit-code rule exists to kill).
// A command that died without an integer status (spawn error, killed by a
// signal) is recorded as exit_code 1 — fail closed, and the contract's
// "integer exit_code" field stays honest about the one thing known: not 0.
function runGateCommands(cwd, gates, opts = {}) {
  const results = [];
  let ok = true;
  for (const gate of gates) {
    const run = spawnSync(gate.command, {
      cwd,
      shell: true,
      // 'inherit' streams straight through to the operator — no pipe exists to
      // swallow a failure (the tail-swallowed-Biome lesson behind ADR-0028).
      stdio: opts.stdio || 'inherit',
    });
    const exitCode = run.status === 0 ? 0 : Number.isInteger(run.status) ? run.status : 1;
    results.push({ name: gate.name, command: gate.command, exit_code: exitCode });
    if (exitCode !== 0) {
      // STOP at first failure: what ran is recorded; unrun gates are ABSENT
      // from gates[] — the record is red anyway via this nonzero entry, and
      // absence can never read as a pass (stage 80 judges every entry).
      ok = false;
      break;
    }
  }
  return { ok, gates: results };
}

// --- the full local run: pin sha → run → re-verify → write the record --------

// Execute the branch's committed gates against its head and write the
// SHA-pinned gate-run record (contract local-work-item v1) via stage 80's
// writer — the exported branchSlug/GATE_RUNS_DIR convention, never a
// reimplementation. Throws (and writes NOTHING) on every refusal path; the
// branch then honestly stays UNKNOWN downstream. Returns
// { ok, branch, sha, started_at, finished_at, gates, record }.
function runGatesForBranch(cwd, opts = {}) {
  // Stage 88 (ADR-0030): remote:<name> resolves its catalog name BEFORE any
  // execution guard — a typo fails as a config error, never as an execution
  // failure (see resolveRemoteRunner for the ordering rationale). Stage 89:
  // the descriptor is kept — it names the SSH target the remote executor
  // preflights and executes against.
  const remote = resolveRemoteRunner(opts.runner, opts);
  // Stage 86 (ADR-0030): a resolved runner the engine cannot execute refuses
  // FIRST — before any git read, checkout move, or command spawn.
  assertRunnerExecutable(opts.runner);
  // Stages 87/89 (ADR-0030): the resolved runner's host dependencies are
  // probed HERE, before anything else runs — localhost probes THIS machine's
  // Docker + act (gates-act), remote:<name> probes SSH reachability + the
  // REMOTE host's Docker + act over the operator's SSH context
  // (gates-remote; the local machine needs neither binary for a remote run).
  // An unprovisionable runner refuses at preflight, never mid-run, writes NO
  // record, and is NEVER silently degraded to another runner (no implicit
  // runner substitution — v1 ships no fallback chains).
  const localhost = opts.runner === 'localhost';
  if (localhost) {
    gatesAct.preflight(opts);
  }
  if (remote) {
    gatesRemote.preflight(remote, opts);
  }
  const startSymbolic = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const startRef = startSymbolic.ok
    ? startSymbolic.stdout.trim()
    : gitOrThrow(cwd, ['rev-parse', 'HEAD'], 'gate run').trim();

  const branch =
    opts.branch !== undefined ? String(opts.branch) : startSymbolic.ok ? startRef : null;
  if (branch === null || branch === '') {
    throw new Error(`gate run: HEAD is detached and no --branch was given — ${USAGE}`);
  }
  if (!git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    throw new Error(`gate run: no local branch '${branch}' exists in ${cwd}`);
  }

  // SHA pin, captured BEFORE anything runs: the exact head this record may
  // claim. Everything below either tests THIS commit or refuses.
  const sha = gitOrThrow(cwd, ['rev-parse', '--verify', branch], 'gate run').trim();

  // Dirty working tree ⇒ refuse BEFORE running: the tree does not match any
  // committed sha, so no record could honestly claim one (fail closed).
  const status = gitOrThrow(cwd, ['status', '--porcelain'], 'gate run');
  if (status.trim() !== '') {
    throw new Error(
      `gate run: the working tree in ${cwd} is dirty — gates must run against the committed head of '${branch}' exactly (SHA-pinned record, contract local-work-item v1); commit or stash first`,
    );
  }

  // The definition committed AT the pinned sha — absent/invalid throws here,
  // before any checkout moves (no record, UNKNOWN downstream).
  const gates = readGateDefinitionAt(cwd, sha);

  // Run ON the branch head. The checkout is restored on every exit path.
  const moved = startRef !== branch;
  if (moved) {
    gitOrThrow(cwd, ['checkout', '--quiet', branch], 'gate run');
  }
  let outcome;
  let startedAt;
  let finishedAt;
  try {
    startedAt = new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString();
    // Stages 87/89 (ADR-0030): ONLY the "run the commands" middle is a
    // runner choice. Both act executors render their workflow from the SAME
    // committed definition at the SAME pinned sha (gates-act.renderWorkflowAt
    // re-reads `git show <sha>:.verity/gates.json` itself — the working
    // tree's gates.json, or a workflow file lying in any tree, can never
    // shape what act runs) and judge by act's exit code; the remote executor
    // additionally pushes the pinned sha to the runner-side clone and holds
    // the one-hop TOCTOU guard before returning. Everything bracketing this
    // line — the SHA pin above, the head-move and tracked-mutation re-checks
    // below, the record write — is the ONE code path for every runner (the
    // honesty protocol is never forked).
    outcome = localhost
      ? gatesAct.execute(cwd, sha, opts)
      : remote
        ? gatesRemote.execute(cwd, sha, remote, opts)
        : runGateCommands(cwd, gates, opts);
    finishedAt = new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString();

    // Post-run honesty re-checks (fail closed, BEFORE any record exists):
    //   1. the branch head must still be the pinned sha — a head that moved
    //      mid-run means the gates tested a commit the record would not name;
    const after = gitOrThrow(cwd, ['rev-parse', '--verify', branch], 'gate run').trim();
    if (after !== sha) {
      throw new Error(
        `gate run: the head of '${branch}' moved mid-run (${sha} → ${after}) — refusing to write a record that would claim a head the gates did not test (fail closed)`,
      );
    }
    //   2. no TRACKED file may have been modified by the gates themselves —
    //      later gates would have seen code that is not the pinned commit.
    //      (`-uno`: untracked build outputs a gate creates are tolerated —
    //      they are not part of the committed tree the sha names.)
    const dirtied = gitOrThrow(cwd, ['status', '--porcelain', '-uno'], 'gate run');
    if (dirtied.trim() !== '') {
      throw new Error(
        `gate run: the gates modified tracked files (${dirtied.trim().split('\n')[0]} …) — the tree no longer matches ${sha}, so no record may claim it (fail closed)`,
      );
    }
  } finally {
    if (moved) {
      // Courtesy restore, never masking the real outcome (mergeLocalPr's rule).
      git(cwd, ['checkout', '--quiet', startRef]);
    }
  }

  // The frozen contract local-work-item v1 record — written and committed by
  // stage 80's driver module (writeGateRun: exported branchSlug + GATE_RUNS_DIR,
  // pathspec commit on the DEFAULT branch).
  const record = {
    schema: 1,
    branch,
    sha,
    started_at: startedAt,
    finished_at: finishedAt,
    gates: outcome.gates,
    // Stage 86 (ADR-0030): ADDITIVE field naming where these exit codes came
    // from (contract local-work-item v1 stays additive-only). 'localhost'
    // when the stage-87 act executor produced them; 'remote:<name>' when the
    // stage-89 remote executor did — the catalog NAME only, never host,
    // user, or key paths (the contract's additive note fixes the value
    // space; stage-88 hygiene keeps machine identity out of every repo);
    // otherwise 'direct' — this module's own executor, which also serves the
    // github substrate's ad-hoc CLI runs (runner 'github-actions' resolved,
    // executed directly, recorded as what actually ran). Readers treat an
    // absent field (every pre-stage-86 record) as 'direct'.
    runner: localhost ? 'localhost' : remote ? `remote:${remote.name}` : 'direct',
  };
  let rel = null;
  if (opts.record !== false) {
    rel = substrateLocal.writeGateRun(cwd, record);
  }
  return { ok: outcome.ok, branch, sha, ...record, record: rel };
}

// The record-free run: execute the WORKING TREE's definition where the
// checkout stands (CI's detached merge checkout, an operator's ad-hoc run).
// No sha is claimed, so no record and none of the record's honesty protocol —
// just the exit-code truth: ok iff every gate exited 0.
function runGatesHere(cwd, opts = {}) {
  // Stage 88 (ADR-0030): the record-free path resolves remote:<name> names
  // against the catalog first too — the SAME config-errors-first ordering as
  // runGatesForBranch (one rule, both run paths); the descriptor is unused
  // here because the remote refusal below fires before anything executes.
  resolveRemoteRunner(opts.runner, opts);
  // Stage 86 (ADR-0030): the record-free path executes just as directly, so
  // the same seam guard applies — refuse before reading the definition.
  assertRunnerExecutable(opts.runner);
  // Stages 87/89 (ADR-0030): both act runners render their workflow from a
  // COMMITTED definition at a pinned sha and nothing else — the record-free
  // path judges the working tree, which names no sha, so there is nothing
  // honest for act to replay on either. Refuse rather than silently
  // executing the working tree directly (no implicit runner substitution),
  // byte-stable per runner; for remote:<name> the refusal fires AFTER the
  // catalog resolution above (config errors first, the stage-88 ordering)
  // and BEFORE any SSH byte moves — the record-free path never contacts the
  // remote at all.
  if (opts.runner === 'localhost') {
    throw new Error(
      "gate_runner 'localhost': the record-free path (--no-record) judges the working tree, which names no committed sha for act to replay (stage 87, ADR-0030) — run `verity gates run` without --no-record, or configure gate_runner: direct",
    );
  }
  if (typeof opts.runner === 'string' && opts.runner.startsWith('remote:')) {
    throw new Error(
      `gate_runner '${opts.runner}': the record-free path (--no-record) judges the working tree, which names no committed sha for the remote runner to test (stage 89, ADR-0030) — run \`verity gates run\` without --no-record, or configure gate_runner: direct`,
    );
  }
  const gates = readGateDefinition(cwd);
  const outcome = runGateCommands(cwd, gates, opts);
  return { ok: outcome.ok, branch: null, sha: null, gates: outcome.gates, record: null };
}

// --- CLI (`verity gates run`) ------------------------------------------------

function dispatch(rest, flags) {
  const verb = rest[0];
  if (verb !== 'run') {
    throw new Error(`unknown gates verb: ${verb || '(none)'} — ${USAGE}`);
  }
  const cwd = flags.cwd || process.cwd();
  const noRecord = flags['no-record'] !== undefined;
  if (noRecord && flags.branch !== undefined) {
    // --branch names the head a RECORD will claim; --no-record claims nothing.
    // Refuse the ambiguous combination rather than silently ignoring either.
    throw new Error(`--branch and --no-record are mutually exclusive — ${USAGE}`);
  }
  if (flags.branch === true) {
    throw new Error(`--branch requires a branch name — ${USAGE}`);
  }
  // Stage 86 (ADR-0030): the CLI executes gates under the SAME resolved
  // policy the worker freezes — so `verity gates run` on a project whose
  // resolved gate_runner this direct executor cannot serve refuses through
  // the one shared guard (assertRunnerExecutable, inside both run paths),
  // never a silent direct run. A repo with no policy file resolves to the
  // substrate's native runner (github ⇒ github-actions, local ⇒ direct),
  // both of which this executor serves byte-identically to today; a policy
  // Verity cannot READ is a loud PolicyError here — with the runner axis
  // configurable, executing before knowing the configured runner would be
  // exactly the silent substitution ADR-0030 forbids (fail closed).
  const runner = autonomy.loadPolicy(cwd).gate_runner;
  if (noRecord) {
    return runGatesHere(cwd, { runner });
  }
  return runGatesForBranch(cwd, {
    branch: flags.branch === undefined ? undefined : String(flags.branch),
    runner,
  });
}

// Exit-code mapping for the CLI (verity.cjs main): a red gate run is a
// NONZERO exit — the run itself is judged the same way it judges its gates.
function exitCodeFor(result) {
  return result && result.ok === true ? 0 : 1;
}

module.exports = {
  GATES_FILE,
  assertRunnerExecutable,
  dispatch,
  exitCodeFor,
  parseGateDefinition,
  readGateDefinition,
  readGateDefinitionAt,
  resolveRemoteRunner,
  runGateCommands,
  runGatesForBranch,
  runGatesHere,
};
