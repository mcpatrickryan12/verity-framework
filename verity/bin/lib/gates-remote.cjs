// Remote act runner (stage 89, ADR-0030) — the last value of the runner axis:
// `gate_runner: remote:<name>` executes the committed gate definition via
// nektos/act in Docker on the CATALOG-NAMED host, over SSH. Fresh regains a
// truly independent execution environment: gates run on a box the roles
// cannot touch (ADR-0030 Consequences), pushed there from the LOCAL repo —
// the source of truth on the local substrate — with no GitHub involvement.
//
// This module replaces ONLY the "run the commands" middle of
// gates.runGatesForBranch, exactly like the stage-87 localhost executor. The
// stage-82 honesty protocol around it — SHA pin, dirty-tree refusal, mid-run
// head-move refusal, gates-modified-tree refusal, record-write bracketing —
// stays the SINGLE code path in gates.cjs; the honesty protocol is never
// forked per runner.
//
// The run, step by step (every step fail-closed, NO record ⇒ UNKNOWN ⇒ no
// merge; the engine NEVER falls back to another runner — fallback chains
// exist only as explicit configuration and v1 ships none, ADR-0030):
//   preflight  over `ssh -o BatchMode=yes <target>`: reachability (`true`),
//              remote Docker binary+daemon (`docker info`), remote act
//              present with a parseable version (`act --version`) — the
//              stage-87 preflight shapes, held remotely (doctor.cjs probes
//              the same three under the same VERITY_SSH_BIN override). The
//              LOCAL machine needs neither Docker nor act for a remote run,
//              so neither is probed here.
//   clone      an idempotent Verity-owned scratch clone on the runner:
//              `~/.verity/gate-work/<repo-slug>/repo` (`mkdir -p` +
//              `git init`, re-runnable). <repo-slug> derives deterministically
//              from the repo's locked identity slug (.verity/identity.json),
//              falling back to the checkout's directory basename — sanitized
//              to the catalog-name charset so it is always shell- and
//              path-safe. Verity OWNS this path: it is never an operator
//              checkout, and force-updating it can clobber nothing anyone
//              else wrote.
//   push       `git push --force <ssh-url> <sha>:refs/verity/gate-run` from
//              the LOCAL repo — force to a Verity-owned scratch ref is safe
//              by ownership and REQUIRED for re-runs after history rewrites;
//              refs/verity/* is never a branch head, so a non-bare remote
//              repo accepts it. The push rides GIT_SSH_COMMAND so the same
//              VERITY_SSH_BIN + BatchMode discipline (prompt-free, operator's
//              own SSH context) covers git's transport too.
//   checkout   detach the remote work tree onto the pinned sha (`checkout
//              --force --detach` + `clean -fdx`): tracked files match the
//              sha exactly and stale untracked leftovers from a previous run
//              cannot leak into what act tests.
//   guard      one-hop TOCTOU (the stage-84 pattern extended over SSH):
//              BEFORE any record is written, `git rev-parse HEAD` on the
//              remote must equal the pinned sha — the record's sha must be
//              the head the RUNNER actually tested, not the head we asked
//              it to test.
//   workflow   rendered LOCALLY from the committed definition at the pinned
//              sha (gates-act.renderWorkflowAt — `git show
//              <sha>:.verity/gates.json` and nothing else) and shipped over
//              the same SSH channel (`cat > <file>` fed on stdin — no scp
//              dependency, one binary override covers every remote byte).
//              A workflow lying in the REMOTE tree is never consulted:
//              workflow YAML must never become an independent source of gate
//              truth (ADR-0030 invariant).
//   act        `cd <clone> && act push --workflows <shipped file>` over SSH,
//              judged by exit code ONLY (ssh returns the remote command's
//              exit status; stdio is inherited, never parsed — ADR-0028).
//              The record carries the stage-87 ONE-aggregate-entry mapping:
//              {name: 'act:gates', command: <the real remote act argv>,
//              exit_code: <the real exit>}. A LOCAL spawn error (ssh binary
//              itself failed to start) is a refusal — an invocation that
//              never ran is distinct from act's own nonzero, which IS a red
//              verdict.
//
// Timeout: the whole execute phase shares ONE wall-clock budget —
// VERITY_GATE_TIMEOUT_SECS (default 1800s; opts.timeoutSecs for unit
// callers) — enforced as a shrinking deadline on every remote call
// (spawnSync's timeout option, the engine's existing bounded-wall-clock
// convention). A timed-out run is a byte-stable refusal with NO record —
// never a hang, never a silent pass. Preflight runs under the same budget as
// its own bracket.
//
// Secrets discipline (the stage-88 hygiene precedent): SSH auth comes
// entirely from the operator's SSH context (agent, config, key files the
// catalog merely POINTS at) — Verity never reads, copies, or logs credential
// contents. The gate-run RECORD carries the catalog NAME only (runner:
// "remote:<name>" plus the remote act argv — no host, no user, no key
// paths); the descriptor's target may appear in ERROR text (the stage-88
// doctor precedent: the operator needs to know which box refused) but never
// in anything committed.
//
// Node built-ins only (zero-dependency repo).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// doctor is a leaf module — firstLine/parseVersion keep the failure-detail
// and act-version-parse logic in exactly one place (the stage-87 convention).
const doctor = require('./doctor.cjs');
// The stage-87 renderer and gates[]-entry name are REUSED, not re-implemented:
// one workflow shape, one aggregate-entry mapping, on both act runners.
const gatesAct = require('./gates-act.cjs');

// Every remote path lives under this Verity-owned root — `~` is expanded by
// the REMOTE side (login shell / git's enter_repo), so the clone lands in the
// remote user's home wherever that is; nothing local ever resolves it.
const GATE_WORK_ROOT = '~/.verity/gate-work';
// The Verity-owned scratch ref the pinned sha is pushed to. Deliberately NOT
// under refs/heads/: a non-bare repo refuses pushes to its checked-out branch
// head, and this ref is engine plumbing, not a branch anyone works on.
const JUDGE_REF = 'refs/verity/gate-run';
const DEFAULT_TIMEOUT_SECS = 1800;

function sshBin(env) {
  return (env || process.env).VERITY_SSH_BIN || 'ssh';
}

// The refusal-suffix every fail-closed message ends with (stage-87 shape).
const NO_RECORD = 'no record is written and the branch stays UNKNOWN';

// The one wall-clock budget (seconds). opts.timeoutSecs (unit callers) →
// VERITY_GATE_TIMEOUT_SECS → default. A malformed override is a loud config
// error, never a silent default (the fail-closed knob rule).
function timeoutSecs(opts = {}) {
  const env = opts.env || process.env;
  const raw = opts.timeoutSecs !== undefined ? opts.timeoutSecs : env.VERITY_GATE_TIMEOUT_SECS;
  if (raw === undefined || raw === '') {
    return DEFAULT_TIMEOUT_SECS;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `VERITY_GATE_TIMEOUT_SECS must be a positive integer number of seconds (got ${JSON.stringify(String(raw))}) — the remote gate run's wall-clock budget (stage 89, ADR-0030)`,
    );
  }
  return n;
}

// Deterministic runner-side directory name for THIS repo: the locked identity
// slug (.verity/identity.json — the identity key already threaded through
// repo/package/image names) when one exists, else the checkout's basename;
// sanitized to the catalog-name charset (lowercased; anything else → '-') so
// the remote path needs no quoting gymnastics and can never smuggle shell
// metacharacters. Same repo ⇒ same slug ⇒ the clone is REUSED across runs
// (idempotent provisioning), which is the point of deriving it.
function repoSlug(cwd) {
  let raw = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cwd, '.verity', 'identity.json'), 'utf8'));
    if (typeof m.slug === 'string' && m.slug.trim() !== '') {
      raw = m.slug.trim();
    }
  } catch {
    // No locked identity (pre-vision repos, fixtures): the basename fallback.
  }
  if (raw === null) {
    raw = path.basename(path.resolve(cwd));
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return slug === '' ? 'repo' : slug;
}

// Why a spawnSync result failed, for ERROR text (doctor's failWhy shape):
// local spawn error code/message, else the first non-empty stderr/stdout
// line, else the bare exit code. Detail only — NEVER a verdict input.
function failWhy(res) {
  if (res.error) {
    return res.error.code || res.error.message;
  }
  return doctor.firstLine(res.stderr) || doctor.firstLine(res.stdout) || `exit ${res.status}`;
}

// spawnSync's timeout kill surfaces as error.code ETIMEDOUT — the ONE signal
// the budget refusal keys on.
function timedOut(res) {
  return Boolean(res.error && res.error.code === 'ETIMEDOUT');
}

function timeoutRefusal(name, budget) {
  return new Error(
    `gate_runner 'remote:${name}': the remote gate run exceeded its ${budget}s wall-clock budget (VERITY_GATE_TIMEOUT_SECS, default ${DEFAULT_TIMEOUT_SECS}) — a timed-out run is a refusal, never a hang or a silent pass (stage 89, ADR-0030); ${NO_RECORD}`,
  );
}

// One remote call: `ssh -o BatchMode=yes <target> <argv...>` under what
// remains of the deadline. BatchMode EVERYWHERE — a gate run must never hang
// on a password prompt (the doctor stage-88 rule, held at execution).
function sshCall(ssh, target, argv, { deadline, input, stdio } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { error: Object.assign(new Error('deadline exhausted'), { code: 'ETIMEDOUT' }) };
  }
  return spawnSync(ssh, ['-o', 'BatchMode=yes', target, ...argv], {
    timeout: remaining,
    killSignal: 'SIGKILL',
    ...(stdio ? { stdio } : { encoding: 'utf8', input }),
  });
}

// --- preflight: refuse BEFORE anything runs (never mid-run) ------------------

// Probe the resolved remote runner's dependencies over SSH. Throws a
// byte-stable refusal on the first missing one; returns
// { ssh, target, actVersion } when the runner can honestly execute. Called by
// gates.runGatesForBranch with the stage-88 catalog DESCRIPTOR (resolution
// already succeeded — a typo'd name failed as a config error before this).
function preflight(resolved, opts = {}) {
  const env = opts.env || process.env;
  const ssh = sshBin(env);
  const { name, target } = resolved;
  const budget = timeoutSecs(opts);
  const deadline = Date.now() + budget * 1000;
  const probe = (argv) => sshCall(ssh, target, argv, { deadline });
  const guard = (res) => {
    if (timedOut(res)) {
      throw timeoutRefusal(name, budget);
    }
    return res;
  };

  // 1. Reachability — `true` proves the channel and nothing else, so the
  //    docker/act failures below are attributable to the REMOTE host.
  const reach = guard(probe(['true']));
  if (reach.error || reach.status !== 0) {
    throw new Error(
      `gate_runner 'remote:${name}' preflight: SSH to ${target} is not reachable (\`${ssh} -o BatchMode=yes ${target} true\` failed: ${failWhy(reach)}) — the remote runner executes over your existing SSH context, prompt-free (BatchMode, ADR-0030); fix SSH access to '${name}' or point VERITY_SSH_BIN at your ssh; ${NO_RECORD}`,
    );
  }
  // 2. Remote Docker, binary AND daemon in one exit-code-judged probe —
  //    `docker info` fails for an absent binary and a stopped daemon alike,
  //    and both mean the same thing here: act cannot run there.
  const docker = guard(probe(['docker', 'info']));
  if (docker.error || docker.status !== 0) {
    throw new Error(
      `gate_runner 'remote:${name}' preflight: remote Docker is not usable (\`docker info\` on ${target} failed: ${failWhy(docker)}) — act executes the rendered gates workflow in Docker on the runner (ADR-0030); install Docker there and start the daemon; ${NO_RECORD}`,
    );
  }
  // 3. Remote act, present with a version Verity can identify (the stage-87
  //    act shape, held remotely; doctor.parseVersion is the one x.y.z parser).
  const act = guard(probe(['act', '--version']));
  if (act.error || act.status !== 0) {
    throw new Error(
      `gate_runner 'remote:${name}' preflight: remote act is not runnable (\`act --version\` on ${target} failed: ${failWhy(act)}) — the remote runner executes gates via nektos/act (ADR-0030); install act there; ${NO_RECORD}`,
    );
  }
  const version = doctor.parseVersion(act.stdout);
  if (version === null) {
    throw new Error(
      `gate_runner 'remote:${name}' preflight: could not parse an act version from \`act --version\` on ${target} (got: ${doctor.firstLine(act.stdout) || '(empty)'}) — refusing to run gates under an act Verity cannot identify (fail closed); ${NO_RECORD}`,
    );
  }
  return { ssh, target, actVersion: version.join('.') };
}

// --- execute: push the pinned sha, guard it, run act there -------------------

// The "run the commands" middle for a resolved remote runner. cwd/sha come
// from runGatesForBranch's honesty bracket (sha pinned, tree verified clean);
// `resolved` is the stage-88 catalog descriptor. Returns the runGateCommands
// outcome shape { ok, gates } under the stage-87 single-entry mapping, or
// throws a byte-stable refusal (NO record — the bracket writes nothing on a
// throw).
function execute(cwd, sha, resolved, opts = {}) {
  const env = opts.env || process.env;
  const ssh = sshBin(env);
  const { name, target } = resolved;
  const budget = timeoutSecs(opts);
  const deadline = Date.now() + budget * 1000;

  const slug = repoSlug(cwd);
  const base = `${GATE_WORK_ROOT}/${slug}`;
  const repoDir = `${base}/repo`;
  const workflowFile = `${base}/workflow/gates.yml`;

  // Render FIRST, from the LOCAL repo's committed definition at the pinned
  // sha (`git show <sha>:.verity/gates.json` — gates-act.renderWorkflowAt),
  // before any remote byte moves: what act will execute is fixed here, and a
  // doctored workflow or gates.json on the REMOTE can never shape it.
  const yaml = gatesAct.renderWorkflowAt(cwd, sha);

  // One plumbing step: run remote argv, refuse byte-stably on any failure.
  // The remote shell interprets the joined argv (that is how `&&` chains and
  // the `cat >` redirect below work over ssh); every path fragment is
  // slug-charset-safe by construction, so no quoting is ever needed.
  const step = (argv, describe, extra) => {
    const res = sshCall(ssh, target, argv, { deadline, ...(extra || {}) });
    if (timedOut(res)) {
      throw timeoutRefusal(name, budget);
    }
    if (res.error || res.status !== 0) {
      throw new Error(describe(failWhy(res)));
    }
    return res;
  };

  // 1. Idempotent Verity-owned clone: mkdir -p + git init re-run safely, so
  //    the first run provisions and every later run reuses (spec: a
  //    runner-side clone Verity owns, created idempotently over SSH).
  step(
    ['mkdir', '-p', repoDir, `${base}/workflow`, '&&', 'git', '-C', repoDir, 'init', '-q'],
    (why) =>
      `gate_runner 'remote:${name}': could not prepare the Verity-owned runner-side clone at ${repoDir} on ${target} (${why}) — the runner tests a scratch clone Verity provisions over SSH, never an operator checkout (stage 89, ADR-0030); ${NO_RECORD}`,
  );

  // 2. Push the pinned sha from the LOCAL repo — the source of truth on the
  //    local substrate; no GitHub involvement anywhere in this path. --force
  //    to the Verity-owned scratch ref (safe by ownership, required for
  //    re-runs after a history rewrite). GIT_SSH_COMMAND keeps git's
  //    transport on the SAME ssh binary + BatchMode discipline as every
  //    other remote byte; the `/~/` URL form makes the REMOTE side expand
  //    the home-relative clone path.
  {
    const remaining = deadline - Date.now();
    const push =
      remaining <= 0
        ? { error: Object.assign(new Error('deadline exhausted'), { code: 'ETIMEDOUT' }) }
        : spawnSync(
            'git',
            [
              '-C',
              cwd,
              'push',
              '--force',
              '--quiet',
              `ssh://${target}/${base}/repo`,
              `${sha}:${JUDGE_REF}`,
            ],
            {
              encoding: 'utf8',
              env: { ...process.env, GIT_SSH_COMMAND: `${JSON.stringify(ssh)} -o BatchMode=yes` },
              timeout: remaining,
              killSignal: 'SIGKILL',
            },
          );
    if (timedOut(push)) {
      throw timeoutRefusal(name, budget);
    }
    if (push.error || push.status !== 0) {
      throw new Error(
        `gate_runner 'remote:${name}': pushing ${sha} to the runner-side clone on ${target} failed (${failWhy(push)}) — the LOCAL repo is the source of what the runner tests (no GitHub involvement, ADR-0030); ${NO_RECORD}`,
      );
    }
  }

  // 3. Detach the remote work tree onto the pinned sha. --force pins tracked
  //    files to the sha over any leftover local edits; clean -fdx removes
  //    stale untracked leftovers from earlier runs so nothing but the pinned
  //    tree is inside what act bind-mounts (honesty, not tidiness).
  step(
    [
      'git',
      '-C',
      repoDir,
      'checkout',
      '-q',
      '--force',
      '--detach',
      sha,
      '&&',
      'git',
      '-C',
      repoDir,
      'clean',
      '-fdxq',
    ],
    (why) =>
      `gate_runner 'remote:${name}': checking out ${sha} in the runner-side work tree on ${target} failed (${why}) — ${NO_RECORD}`,
  );

  // 4. One-hop TOCTOU guard (the stage-84 pattern over SSH), BEFORE any
  //    record can exist: the head the runner ACTUALLY has checked out must
  //    equal the pinned sha. Reading stdout here is a sha comparison for a
  //    refusal decision — never a gate verdict (those stay exit-code-only).
  const head = step(
    ['git', '-C', repoDir, 'rev-parse', 'HEAD'],
    (why) =>
      `gate_runner 'remote:${name}': could not read the runner-side work tree's head on ${target} (${why}) — without it no record may claim a tested sha (fail closed); ${NO_RECORD}`,
  ).stdout.trim();
  if (head !== sha) {
    throw new Error(
      `gate_runner 'remote:${name}': the runner-side work tree has ${head || '(nothing)'} checked out, not the pinned ${sha} — refusing to write a record claiming a head the runner did not test (the stage-84 TOCTOU guard, one hop out; fail closed); ${NO_RECORD}`,
    );
  }

  // 5. Ship the locally rendered workflow over the SAME ssh channel (stdin →
  //    `cat >` — no scp dependency; one VERITY_SSH_BIN override covers every
  //    remote byte). It lands BESIDE the clone, never inside it, so the work
  //    tree stays exactly the pinned sha.
  step(
    ['cat', '>', workflowFile],
    (why) =>
      `gate_runner 'remote:${name}': shipping the rendered gates workflow to ${target} failed (${why}) — the workflow act executes is rendered from the LOCAL committed definition at the pinned sha, never taken from the remote tree (ADR-0030); ${NO_RECORD}`,
    { input: yaml },
  );

  // 6. act, judged by exit code ONLY. ssh exits with the remote command's
  //    status, so act's real exit code arrives intact; stdio streams to the
  //    operator (or opts.stdio in tests), never parsed for judgment
  //    (ADR-0028). A LOCAL spawn error means the invocation never ran — a
  //    refusal, distinct from act's own nonzero (a red VERDICT, recorded).
  const actArgs = ['push', '--workflows', workflowFile];
  {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timeoutRefusal(name, budget);
    }
    const run = spawnSync(
      ssh,
      ['-o', 'BatchMode=yes', target, 'cd', repoDir, '&&', 'act', ...actArgs],
      { stdio: opts.stdio || 'inherit', timeout: remaining, killSignal: 'SIGKILL' },
    );
    if (timedOut(run)) {
      throw timeoutRefusal(name, budget);
    }
    if (run.error) {
      throw new Error(
        `gate_runner 'remote:${name}': could not invoke act over SSH (${run.error.code || run.error.message}) — an invocation that never ran is a refusal, distinct from act's own nonzero verdict (fail closed); ${NO_RECORD}`,
      );
    }
    const exitCode = run.status === 0 ? 0 : Number.isInteger(run.status) ? run.status : 1;
    return {
      ok: exitCode === 0,
      // The stage-87 documented mapping, unchanged: ONE truthful aggregate
      // entry — act's real exit code under the real REMOTE act argv. The
      // command names the shipped workflow path (slug-derived, Verity-owned)
      // and NOTHING about the host: the record carries the catalog NAME only
      // (its `runner` field), never host, user, or key paths (stage-88
      // hygiene precedent, held at execution).
      gates: [
        { name: gatesAct.ACT_GATE_NAME, command: `act ${actArgs.join(' ')}`, exit_code: exitCode },
      ],
    };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_SECS,
  GATE_WORK_ROOT,
  JUDGE_REF,
  execute,
  preflight,
  repoSlug,
  sshBin,
  timeoutSecs,
};
