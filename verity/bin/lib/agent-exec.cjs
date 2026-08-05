// `verity agent-exec <role> [args...]` — headless single-role execution
// (verity-autonomy-technical-sketch.md §3.3). The ONLY place that invokes an
// AI assistant — but as of stage 7 (ADR-0005) it is a runtime-neutral
// coordinator: every provider wire detail (binary selection, argv shape,
// transcript grammar, usage fields) lives in a driver under ./agents/, looked
// up through the registry. This file must never regain provider specifics.
//
//   verity agent-exec build 7 --run-id <id> [--max-turns N] [--timeout-secs N]
//     [--agent claude|codex]
//
// Flow:
//   1. Resolve role → commands/verity/<role>.md prompt file + its REQUIRED
//      <role>.tools.json allowlist (T06, deny-by-default): a missing allowlist
//      means the agent is never invoked — exit 30 with a single-line error
//      naming the missing file. No role runs with the agent's default tools.
//   2. Look up the provider driver (--agent, default claude) in the registry.
//   2b. (stage 11, ADR-0011) providers that opt into tier-1 containment are
//      asked whether every restriction the role declares maps to a mechanism
//      that enforces it — an unenforceable restriction refuses the run (exit
//      30 `unenforceable-policy`) unless the operator acknowledged the gap.
//   2b'. (stage 16, issue #42) steps 1 and 2b are FILESYSTEM-ONLY and run
//      BEFORE the preflight below, so a pure-policy refusal can never be
//      masked by a provider probe that shells out (codex: `codex login
//      status`) — a restriction Verity cannot enforce is not an auth question.
//   2b''. THEN the preflight: fail fast (exit 30) if the driver's binary is
//      missing or below its pinned minimum version, and take the pre-run
//      workspace snapshot for the post-run invariants.
//   2c. (stage 14, ADR-0011 TIER 2 — OPT-IN, default OFF) with
//      `--containment-tier 2` the provider materializes a DISPOSABLE SHAPED
//      workspace, the role runs there instead of the real checkout, and a
//      gated merge-back decides what propagates back. Absent the flag nothing
//      about the run changes (tier 1).
//   2d. (stage 17, ADR-0012) providers whose model cannot write under `.git`
//      declare the git-lifecycle hooks: the `git_write` GRANT then projects to
//      "Verity performs git on this role's behalf", so VERITY creates the stage
//      branch here — outside the model's execution context, before dispatch —
//      and commits/pushes/opens the PR after a successful run. A grant that
//      cannot be provided refuses the run (exit 30 `git-unprovidable`). The
//      reference driver declares no hooks and is wholly unaffected.
//   3. driver.execute() invokes the agent with cwd = repo root — or, under
//      tier 2, the shaped workspace; the raw transcript streams kernel-side to
//      ~/.verity/logs/<run-id>/<role>.jsonl ($HOME-relative via os.homedir(),
//      so tests can redirect it).
//   3b. (stage 11) the post-run invariants run on EVERY exit path: a protected
//      path mutated, a ref moved without git_write, or anything written by a
//      role with an empty writable set is reverted where safe and turns the
//      run into a loud failure — never a silent pass.
//   4. The driver parses its own transcript into the frozen result-contract
//      pieces (contracts/agent-result.md v1) — final result, normalized
//      usage/cost, tool-call count, outcome classification — and this file
//      assembles + emits the §3.3 result object on stdout:
//        { schema, role, outcome, tokens:{in,out}, est_usd, wall_secs,
//          tool_calls, artifacts, error }
//
// Outcome detection: every rendered prompt gets a RESULT_CONTRACT footer
// (agents/result-contract.cjs) telling the (human-less) agent to end its final
// message with one single-line JSON marker
// {"verity":1,"outcome":"success|gated|failed",...}. Marker wins; no marker →
// the driver infers from its CLI result. No parseable result at all →
// infra_error.
//
// Exit codes (mapped by exitCodeFor() in the dispatcher): 0 success, 10 gated,
// 20 role failure, 30 infra (agent missing/too old, unsupported agent, unknown
// role, malformed output). Infra outcomes also print one machine-parsable line
// to stderr: `verity-agent-exec: 30 <slug>: <message>` (SKETCH §8.2 style).
//
// Test seam: each driver's binary is overridable via env — provider-specific
// VERITY_CLAUDE_BIN, then legacy VERITY_AGENT_BIN (see the driver's
// resolveBinary precedence). Tests use a stub script emitting canned JSONL;
// no live API calls ever happen in CI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Shared version-probe helpers (stage 1), re-exported for compatibility: the
// parse/compare logic lives in doctor.cjs; the drivers consume it.
const { compareVersions, parseVersion } = require('./doctor.cjs');

const { getProvider } = require('./agents/index.cjs');
// The reference driver, required directly ONLY to keep this module's historic
// exports intact (worker + tests import them from here); dispatch() always
// goes through the registry.
const claude = require('./agents/claude.cjs');
const {
  AgentExecError,
  RESULT_CONTRACT,
  SCHEMA,
  buildResult,
  exitCodeFor,
  extractMarker,
} = require('./agents/result-contract.cjs');

const DEFAULT_AGENT = 'claude';
const DEFAULT_MAX_TURNS = 40;
// run-id and role become path components under ~/.verity/logs — keep them tame.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USAGE =
  'usage: verity agent-exec <role> [args...] --run-id <id> [--max-turns N] [--timeout-secs N] [--agent claude|codex] [--model M] [--sandbox S] [--approval A] [--acknowledge-gaps c1,c2] [--containment-tier 1|2] [--keep-workspace] [--state-snapshot JSON]';
// ADR-0011 enforcement tiers. Tier 1 (stage 11: credential stripping +
// mandatory post-run invariants) is what every codex run has had since that
// stage and stays the DEFAULT. Tier 2 (stage 14: disposable shaped workspace +
// gated merge-back) is OPT-IN — a net-new containment feature ships dark, and
// absence of the flag means the weaker, already-proven guarantee, never the
// stronger claim.
const DEFAULT_CONTAINMENT_TIER = 1;
const CONTAINMENT_TIERS = [1, 2];
// Stage 30: driver spawn-error codes that can only occur BEFORE the child
// process executed — the binary missing/unrunnable or the OS refusing to
// create the process. Deliberately an ALLOWLIST: any code not listed here
// (ENOBUFS — the piped-stderr cap overflowed, which only a RUNNING child can
// cause; ETIMEDOUT — the deadline killed a running child; anything future)
// reads as "the model may have run", so runDispatch keeps its cost unknown
// (est_usd null, ADR-0008) instead of recording a fabricated verified $0.
const PRE_EXECUTION_SPAWN_ERRORS = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'ENOMEM',
  'EINVAL',
]);

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

// Role → command file + permission files (Claude's `.tools.json` allowlist and
// the runtime-neutral `.permissions.json` capability policy — the resolved
// driver reads its own via readPolicy), preferring the target repo's installed
// copies over the packaged ones. Returns null when the role does not exist.
//
// The LAST entry is the packaged canary corpus (stage 16, issue #43):
// `commands/canary/` holds test-only roles — today just `canary-exec`, which
// executes its own arguments so the containment canary can drive an arbitrary
// adversarial instruction (docs/dev/codex-headless-canary.md §3/§5). It is a
// SIBLING of the workflow corpus on purpose: every adapter, doctor probe, docs
// listing, and role-count assertion enumerates `commands/verity/` only, so a
// canary role can never be installed as a skill, offered to a user, or counted
// among the workflow roles. It is searched LAST so a real role always wins.
function resolveRole(cwd, role) {
  const dirs = [
    path.join(cwd, 'commands', 'verity'),
    path.join(cwd, '.claude', 'commands', 'verity'),
    path.join(__dirname, '..', '..', '..', 'commands', 'verity'),
    path.join(__dirname, '..', '..', '..', 'commands', 'canary'),
  ];
  for (const dir of dirs) {
    const file = path.join(dir, `${role}.md`);
    if (fs.existsSync(file)) {
      return {
        file,
        toolsFile: path.join(dir, `${role}.tools.json`),
        permissionsFile: path.join(dir, `${role}.permissions.json`),
      };
    }
  }
  return null;
}

// The run itself. `session` is the one piece of state that must survive EVERY
// exit path, including a thrown one: the undo for anything this function did to
// the operator's checkout (stage 17). dispatch() below owns running it.
function runDispatch(args, flags, session) {
  const cwd = flags.cwd || process.cwd();
  const t0 = Date.now();
  const stderr = (line) => process.stderr.write(`${line}\n`);

  // §3.3 result object, exact field set — infra problems still emit it (with
  // outcome infra_error) so callers (T10) always get one parseable object.
  const result = (outcome, extra = {}) => buildResult(args[0] || null, t0, outcome, extra);
  // Stage 30: a refusal made BEFORE the provider process ran has a VERIFIED
  // cost of $0 — est_usd null means UNKNOWN (ADR-0008) and is reserved for
  // runs where a model actually consumed provider-side resources. Reporting
  // null for a spawn-free refusal (unknown-role, unenforceable-policy,
  // git-unprovidable, a failed spawn, ...) made the worker's ledger read the
  // refusal as unverifiable spend, and the startup breaker then refused the
  // rest of the UTC day non-approvably (canary run 5, tick 8). `modelRan`
  // flips once the child has actually executed — from then on an infra_error
  // (malformed output, inconsistent result) is genuinely unknown spend and
  // stays null.
  let modelRan = false;
  const infra = (slug, message) => {
    stderr(`verity-agent-exec: 30 ${slug}: ${message}`);
    return result('infra_error', { error: message, ...(modelRan ? {} : { est_usd: 0 }) });
  };

  // -- argument validation (true usage errors throw → dispatcher exits 30) --
  const role = args[0];
  if (!role) {
    throw new AgentExecError(USAGE);
  }
  const roleArgs = args.slice(1);
  const runId = flags['run-id'];
  if (typeof runId !== 'string' || !SAFE_ID.test(runId)) {
    throw new AgentExecError(`--run-id is required (letters/digits/._- only). ${USAGE}`);
  }
  const rawTurns = flags['max-turns'] === undefined ? DEFAULT_MAX_TURNS : flags['max-turns'];
  const maxTurns = Number(rawTurns);
  if (rawTurns === true || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new AgentExecError(`--max-turns must be a positive integer. ${USAGE}`);
  }
  // Provider-neutral run limit (ADR-0008): a hard wall-clock deadline on the
  // agent child process, honored identically by every driver.
  const rawTimeout = flags['timeout-secs'];
  const timeoutSecs = rawTimeout === undefined ? undefined : Number(rawTimeout);
  if (
    rawTimeout !== undefined &&
    (rawTimeout === true || !Number.isInteger(timeoutSecs) || timeoutSecs < 1)
  ) {
    throw new AgentExecError(`--timeout-secs must be a positive integer. ${USAGE}`);
  }
  // Stage 9 knobs (worker provider selection): --model is provider-neutral
  // and omitted-in (no flag → the argv the driver built before stage 9);
  // --sandbox/--approval override the runtime-neutral capability policy and
  // may only NARROW the role's projection (ADR-0007) — validated below by the
  // driver's applyOverrides once the role policy is loaded.
  const model = flags.model;
  if (model !== undefined && (model === true || String(model).trim() === '')) {
    throw new AgentExecError(`--model requires a model name. ${USAGE}`);
  }
  // Stage 11 (ADR-0011 capability honesty rule): the operator's EXPLICIT
  // acknowledgement that a declared restriction has no enforcing mechanism.
  // Default absent = nothing acknowledged = the run is refused (fail closed);
  // the worker passes the autonomy policy's
  // `agent.acknowledged_enforcement_gaps` here.
  const rawAck = flags['acknowledge-gaps'];
  let acknowledgedGaps;
  if (rawAck !== undefined) {
    if (rawAck === true || String(rawAck).trim() === '') {
      throw new AgentExecError(
        `--acknowledge-gaps requires a comma-separated capability list. ${USAGE}`,
      );
    }
    acknowledgedGaps = String(rawAck)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  // Stage 14 (ADR-0011 tier 2), OPT-IN and default OFF: which containment tier
  // this run demands. An unparsable value is a usage error — never a silent
  // fallback to tier 1, which would hand the operator the weaker guarantee
  // while they believed they had asked for the stronger one.
  const rawTier = flags['containment-tier'];
  const containmentTier = rawTier === undefined ? DEFAULT_CONTAINMENT_TIER : Number(rawTier);
  if (rawTier !== undefined && (rawTier === true || !CONTAINMENT_TIERS.includes(containmentTier))) {
    throw new AgentExecError(
      `--containment-tier must be one of ${CONTAINMENT_TIERS.join(' | ')} (ADR-0011). ${USAGE}`,
    );
  }
  // Debug retention of the disposable workspace. Boolean flag: a value is
  // ignored, and it is meaningless without tier 2 — rejected rather than
  // accepted-and-ignored, the same rule every other knob here follows.
  const keepWorkspace = flags['keep-workspace'] !== undefined;
  if (keepWorkspace && containmentTier !== 2) {
    throw new AgentExecError(
      `--keep-workspace retains the tier-2 disposable workspace, and there is none without --containment-tier 2. ${USAGE}`,
    );
  }
  // Stage 24 (ADR-0013): the Verity-gathered GitHub state snapshot rendered
  // into a CONTAINED role's prompt. The worker (module API) passes the facts
  // object the dispatch decision derived; the CLI passes JSON. Deliberately
  // data-only here — this coordinator performs NO GitHub read of its own, so
  // the one verified read per tick (the worker's, stage 20 fail-closed) stays
  // the single source of truth.
  const rawState = flags['state-snapshot'];
  let stateSnapshot = null;
  if (rawState !== undefined) {
    if (rawState === true) {
      throw new AgentExecError(`--state-snapshot requires a JSON object of facts. ${USAGE}`);
    }
    if (typeof rawState === 'string') {
      try {
        stateSnapshot = JSON.parse(rawState);
      } catch (err) {
        throw new AgentExecError(`--state-snapshot is not valid JSON (${err.message}). ${USAGE}`);
      }
    } else {
      stateSnapshot = rawState;
    }
    if (
      stateSnapshot === null ||
      typeof stateSnapshot !== 'object' ||
      Array.isArray(stateSnapshot)
    ) {
      throw new AgentExecError(
        `--state-snapshot must be a JSON object of Verity-read GitHub facts. ${USAGE}`,
      );
    }
  }

  // -- infra preconditions (emit infra_error result, exit 30) --
  const agent = flags.agent === undefined ? DEFAULT_AGENT : String(flags.agent);
  let provider;
  try {
    provider = getProvider(agent);
  } catch (err) {
    return infra(err.slug || 'unsupported-agent', err.message);
  }
  // ADR-0008: a provider without the max-turns concept REJECTS the flag with a
  // clear usage error — never accepts and silently ignores a limit the
  // operator believes exists.
  if (flags['max-turns'] !== undefined && provider.supportsMaxTurns === false) {
    throw new AgentExecError(
      `--max-turns is a Claude-only limit with no ${agent} equivalent — bound the run with --timeout-secs and worker limits instead (ADR-0008). ${USAGE}`,
    );
  }
  // Same never-silently-ignore rule for the capability-policy overrides: a
  // provider without an applyOverrides projection (claude — governed by its
  // .tools.json allowlist) REJECTS them rather than accepting a control the
  // operator believes exists.
  const hasPolicyOverride = flags.sandbox !== undefined || flags.approval !== undefined;
  if (hasPolicyOverride && typeof provider.applyOverrides !== 'function') {
    throw new AgentExecError(
      `--sandbox/--approval override the runtime-neutral capability policy, which '${agent}' does not consume — its permission surface is the .tools.json allowlist (ADR-0007). ${USAGE}`,
    );
  }
  // Same rule for the enforcement-gap acknowledgement: a provider whose
  // restrictions ARE enforced by its own harness (claude) has no gaps to
  // acknowledge, so it rejects the flag rather than accepting a knob the
  // operator believes did something.
  if (acknowledgedGaps !== undefined && typeof provider.checkEnforceable !== 'function') {
    throw new AgentExecError(
      `--acknowledge-gaps acknowledges an unenforceable capability restriction, which '${agent}' does not have — its restrictions are enforced by its own harness allowlist (ADR-0011). ${USAGE}`,
    );
  }
  // Same rule for the state snapshot (ADR-0013): a provider whose harness
  // performs its own GitHub reads (claude) REJECTS the flag rather than
  // accepting facts it would never render — the operator must never believe a
  // snapshot was delivered when it was dropped on the floor.
  if (stateSnapshot !== null && provider.supportsStateSnapshot !== true) {
    throw new AgentExecError(
      `--state-snapshot renders Verity-read GitHub facts into a contained role's prompt, which '${agent}' does not consume — its harness performs its own GitHub reads (ADR-0013). ${USAGE}`,
    );
  }
  // Same rule for the tier-2 request: a provider that does not implement the
  // shaped-workspace hooks REJECTS it rather than reporting a containment tier
  // it never provided.
  const supportsWorkspace = typeof provider.prepareWorkspace === 'function';
  if (containmentTier === 2 && !supportsWorkspace) {
    throw new AgentExecError(
      `--containment-tier 2 needs a disposable shaped workspace, which the '${agent}' driver does not implement — its write-time restriction is enforced by its own harness allowlist (ADR-0011). ${USAGE}`,
    );
  }
  if (!SAFE_ID.test(role)) {
    return infra('unknown-role', `invalid role name '${role}'`);
  }
  const resolved = resolveRole(cwd, role);
  if (resolved === null) {
    return infra('unknown-role', `no command file for role '${role}' (commands/verity/${role}.md)`);
  }
  // Driver-owned permission surface, fail closed (Claude: the T06 `.tools.json`
  // allowlist; Codex: the ADR-0007 `.permissions.json` capability policy).
  // Whatever the driver refuses, the agent is never invoked — exit 30.
  //
  // ORDER (stage 16, issue #42): the permission surface and the honesty gate
  // are evaluated BEFORE the binary/auth preflight. Both are filesystem-only —
  // they read the role's two policy files and spawn nothing — while
  // checkVersion shells out to the provider (codex: `codex login status`).
  // With the old order codex WAS invoked before a refusal specified to precede
  // it, and on the real-CLI lane every `unenforceable-policy` came back as
  // `agent-unauthenticated`: a pure-policy decision masked by a
  // network-dependent auth probe. Nothing else moved — the preflight still
  // runs, just after, so a role whose policy is fine still fails
  // `agent-missing`/`version-too-old`/`agent-unauthenticated` exactly as before.
  let policy;
  try {
    policy = provider.readPolicy(resolved);
  } catch (err) {
    return infra(err.slug || 'bad-allowlist', err.message);
  }
  // Worker overrides narrow the loaded projection, never widen it — an
  // illegal value or any widening refuses execution (ADR-0007 fail-closed).
  if (hasPolicyOverride) {
    try {
      policy = provider.applyOverrides(policy, {
        sandbox: flags.sandbox,
        approval: flags.approval,
      });
    } catch (err) {
      return infra(err.slug || 'bad-override', err.message);
    }
  }

  // ADR-0011 capability honesty rule, fail closed: every restriction the role
  // declares must map to a mechanism that actually enforces it. An
  // unenforceable restriction refuses the run (exit 30 `unenforceable-policy`)
  // unless the operator acknowledged the gap — and an acknowledgement that
  // applied becomes VISIBLE in the result below, never a silent allowance.
  let appliedGaps = [];
  if (typeof provider.checkEnforceable === 'function') {
    try {
      appliedGaps = provider.checkEnforceable(policy, { acknowledged: acknowledgedGaps || [] });
    } catch (err) {
      return infra(err.slug || 'unenforceable-policy', err.message);
    }
  }

  // ADR-0012 (stage 17): on a provider whose model cannot write under `.git`,
  // the `git_write` GRANT projects to "Verity performs git on this role's
  // behalf". Planning is pure policy + filesystem (does the role hold the
  // capability, does the run name an existing stage?), and the provision check
  // is git READS only — so both sit here with the other pure refusals, ahead of
  // the network-dependent preflight (issue #42's ordering rule). A grant Verity
  // cannot honour refuses the run (exit 30 `git-unprovidable`) instead of
  // letting it finish with no branch, no commit and no PR.
  let gitPlan = null;
  if (typeof provider.planGit === 'function') {
    gitPlan = provider.planGit(policy, { cwd, role, roleArgs, runId });
    if (gitPlan !== null) {
      try {
        // The check RESOLVES as well as refuses — it hands back the plan with
        // the fork point attached, so `begin` never has to guess one.
        gitPlan = provider.assertGitProvidable(gitPlan, cwd);
      } catch (err) {
        return infra(err.slug || 'git-unprovidable', err.message);
      }
    }
  }

  // Provider preflight: binary present, at or above its pinned minimum, and
  // authenticated. Deliberately LAST of the refusals (issue #42) — it is the
  // only one that costs a subprocess, and the only one whose answer depends on
  // the machine rather than on the role.
  const bin = provider.resolveBinary(process.env);
  const version = provider.checkVersion(bin);
  if (!version.ok) {
    return infra(version.slug, version.error);
  }

  // -- invocation (argv construction + spawn live in the driver) --
  // ADR-0012: the stage branch is created HERE — in Verity's own process, in
  // the real checkout, BEFORE the model is dispatched and before the prompt is
  // even composed. The role never creates it, is never asked to, and (below) is
  // told so. A failure to create it refuses the run; it never degrades to
  // "carry on and hope", which is what produced a build role that reported
  // success with no branch behind it.
  //
  // Moving the checkout is a means, not an end, so the undo is registered in the
  // SAME breath: dispatch()'s `finally` runs it on every exit path — success,
  // failure, timeout, refusal, or an unexpected throw — after the commit below
  // has had its chance to land on the branch.
  let gitRun = null;
  if (gitPlan !== null) {
    try {
      gitRun = provider.beginGit(gitPlan, cwd);
    } catch (err) {
      return infra(err.slug || 'git-unprovidable', err.message);
    }
    session.restore = () => {
      const back = provider.restoreGit(gitRun, cwd);
      if (back.error !== null) {
        // Visible, never silent: the operator is standing somewhere they did not
        // ask to be, and the only honest thing is to say so.
        stderr(`verity-agent-exec: git-restore-failed: ${back.error}`);
      }
    };
  }
  // Drivers that take a render context get one; claude's renderPrompt takes two
  // parameters and ignores the third, so its rendered prompt is byte-identical.
  // `state` (stage 24, ADR-0013) is the Verity-gathered GitHub snapshot — only
  // a provider that declared supportsStateSnapshot can ever see one (rejected
  // above otherwise), and absent it the render context is exactly stage 17's.
  const prompt = provider.renderPrompt(resolved.file, roleArgs, {
    policy,
    git: gitRun,
    state: stateSnapshot,
  });
  const logDir = path.join(os.homedir(), '.verity', 'logs', runId);
  fs.mkdirSync(logDir, { recursive: true });
  const transcript = path.join(logDir, provider.transcriptFilename(role));

  // ADR-0011 layer 5: the pre-run snapshot the post-run invariants diff
  // against. Taken as late as possible (right before the spawn) so anything
  // Verity itself wrote is baseline, not a violation. It always snapshots the
  // REAL checkout — under tier 2 that makes it the cross-check on merge-back
  // (did the gate let anything through?), not the primary guarantee.
  const before =
    typeof provider.captureInvariants === 'function'
      ? provider.captureInvariants({ cwd, ...policy })
      : null;

  // ADR-0011 tier 2: materialize the disposable shaped workspace, run the role
  // THERE, then gate what propagates back. The workspace is sited beside the
  // run's transcripts under the Verity state root — never under TMPDIR, where
  // it would be writable from inside the Codex sandbox and therefore no
  // boundary at all (spike F5). Disposal happens in the `finally` below, so it
  // runs on success, failure, and timeout alike.
  let workspace = null;
  let merge = null;
  let run;
  try {
    if (containmentTier === 2) {
      try {
        workspace = provider.prepareWorkspace(policy, {
          cwd,
          dir: path.join(os.homedir(), '.verity', 'workspaces', runId, role),
          keep: keepWorkspace,
        });
      } catch (err) {
        return infra(err.slug || 'workspace-unavailable', err.message);
      }
    }
    run = provider.execute({
      bin,
      prompt,
      maxTurns,
      cwd: workspace === null ? cwd : workspace.path,
      transcript,
      logDir,
      role,
      timeoutSecs,
      model,
      ...policy,
    });
    // Stage 30: whether the child ran decides verified-$0 vs unknown, so the
    // predicate FAILS TOWARD UNKNOWN. `run.error` is NOT only set for
    // failures to start the child: ETIMEDOUT means it ran until the deadline
    // killed it, and ENOBUFS means it ran long enough to overflow the 16MB
    // piped-stderr cap — both after potentially real provider spend. Only the
    // enumerated PRE_EXECUTION_SPAWN_ERRORS are genuinely "could not spawn";
    // any other code — ENOBUFS, ETIMEDOUT, and anything not listed — reads as
    // "the model may have run", so its cost stays null (unknown, ADR-0008)
    // rather than becoming a fabricated verified $0.
    modelRan = !(run.error && PRE_EXECUTION_SPAWN_ERRORS.has(run.error.code));
    if (workspace !== null) {
      merge = provider.mergeWorkspace(workspace, policy);
    }
  } finally {
    if (workspace !== null) {
      const disposal = provider.disposeWorkspace(workspace);
      if (disposal.retained === true) {
        stderr(`verity-agent-exec: note: workspace retained (--keep-workspace): ${disposal.path}`);
      }
    }
  }

  // Additive contract annotations (agent-result v1.x optional fields) from
  // drivers that declare them — claude has none, so its output is unchanged.
  // Computed AFTER the run, never before (stage 15, issue #36): a driver may
  // only annotate an artifact PATH once the run has had its chance to write it,
  // or a failed run advertises a file that does not exist. Every result path
  // below this point is post-run, so nothing about which runs get annotated
  // changes.
  const notes = {
    ...(provider.annotate ? provider.annotate({ role, logDir }) : {}),
    // Which ADR-0011 guarantee actually applied, surfaced for the operator on
    // every run of a provider that HAS tiers. Claude has none, so its result
    // stays byte-identical.
    ...(supportsWorkspace ? { containment_tier: containmentTier } : {}),
    ...(appliedGaps.length > 0 ? { enforcement_gaps_acknowledged: appliedGaps } : {}),
  };

  // Post-run containment, checked on every exit path (a timeout kill or a
  // malformed transcript is no reason to skip it). enforced() folds any
  // violation into whatever result we were about to return: loud, never a
  // silent pass. Order matters — the tier-2 gate owns the propagation
  // decision, and the tier-1 invariants then confirm the real checkout is
  // exactly as the gate left it.
  const verdict =
    before !== null && typeof provider.checkInvariants === 'function'
      ? provider.checkInvariants(before, policy)
      : null;
  // ADR-0012, the second half: turn the role's file changes into history.
  // Deliberately the LAST thing that happens to a result, and gated on the
  // result being a genuine success — a containment rejection or an enforcement
  // violation has already turned `out.outcome` into `failed` by the time this
  // sees it, so a rejected tier-2 path can never reach the commit. The change
  // SOURCE differs by tier: the gated accepted set at tier 2, the working-tree
  // diff at tier 1 (agents/git-lifecycle.cjs owns both).
  const committed = (out) => {
    if (gitRun === null) {
      return out; // no Verity-performed git on this run — nothing added, nothing changed
    }
    if (out.outcome !== 'success') {
      return {
        ...out,
        git_lifecycle: provider.skipGit(
          gitRun,
          `nothing was committed: the run ended '${out.outcome}'`,
        ),
      };
    }
    const done = provider.finishGit(gitRun, cwd, merge === null ? {} : { merged: merge.merged });
    if (done.error !== null) {
      // Verity promised to perform git and could not. That is a LOUD run
      // failure — never a success whose history silently does not exist.
      stderr(`verity-agent-exec: git-lifecycle-failed: ${done.error}`);
      return {
        ...out,
        outcome: 'failed',
        error: out.error ? `${done.error}; ${out.error}` : done.error,
        git_lifecycle: done,
      };
    }
    return {
      ...out,
      git_lifecycle: done,
      // The PR Verity opened is a GitHub object this run created, so it belongs
      // in the frozen `artifacts` field the worker already reads (§3.3).
      ...(done.pr === null ? {} : { artifacts: { ...(out.artifacts || {}), pr: done.pr } }),
    };
  };

  const enforced = (res) => {
    let out = res;
    if (merge !== null && merge.error !== null) {
      stderr(`verity-agent-exec: containment-rejected: ${merge.error}`);
      out = {
        ...out,
        outcome: out.outcome === 'infra_error' ? 'infra_error' : 'failed',
        error: out.error ? `${merge.error}; ${out.error}` : merge.error,
        containment_rejected: merge.rejected,
      };
    } else if (merge !== null && merge.merged.length > 0) {
      // Attribution: exactly which paths deterministic Verity code propagated.
      out = { ...out, containment_merged: merge.merged };
    }
    if (verdict === null || verdict.violations.length === 0) {
      return committed(out);
    }
    stderr(`verity-agent-exec: enforcement-violation: ${verdict.error}`);
    return committed({
      ...out,
      // A containment breach outranks a role's own claim of success. An
      // infra_error stays infra_error so the exit code keeps matching the
      // stderr slug line already printed for it.
      outcome: out.outcome === 'infra_error' ? 'infra_error' : 'failed',
      error: out.error ? `${verdict.error}; ${out.error}` : verdict.error,
      enforcement_violations: verdict.violations,
      enforcement_reverted: verdict.reverted,
    });
  };

  if (run.error && run.error.code === 'ETIMEDOUT') {
    // ADR-0008: the deadline killed the child. The partial transcript stays
    // on disk; the outcome is a normalized FAILURE with timed_out: true —
    // never a success, never a silent no-op.
    return enforced(
      result('failed', {
        ...notes,
        timed_out: true,
        tool_calls: provider.countToolCalls(transcript),
        error: `agent timed out after ${timeoutSecs}s — child killed, partial transcript retained: ${transcript}`,
      }),
    );
  }
  if (run.error) {
    return enforced(infra('spawn-failed', `failed to run ${bin}: ${run.error.message}`));
  }

  // -- result parsing (transcript grammar + classification live in the driver) --
  // Drivers signal unrecoverable wire problems (malformed JSONL, invalid or
  // inconsistent structured results) as AgentExecError → infra_error here.
  let final;
  let usage;
  let normalized;
  try {
    final = provider.parseTranscript(transcript);
    if (final !== null) {
      usage = provider.normalizeUsage(final);
      normalized = provider.normalizeResult(final, { maxTurns });
    }
  } catch (err) {
    if (err instanceof AgentExecError) {
      return enforced(infra(err.slug || 'malformed-output', err.message));
    }
    throw err;
  }
  if (final === null) {
    const hint = firstLine(run.stderr) || `agent exit ${run.status}`;
    return enforced(
      infra(
        'malformed-output',
        `agent emitted no parseable result object (${hint}); transcript: ${transcript}`,
      ),
    );
  }
  const { tokens, est_usd: estUsd, ...usageExtra } = usage;
  const toolCalls = provider.countToolCalls(transcript);
  const { outcome, error, artifacts } = normalized;
  return enforced(
    result(outcome, {
      tokens,
      est_usd: estUsd,
      tool_calls: toolCalls,
      artifacts,
      error,
      ...notes,
      ...usageExtra,
    }),
  );
}

// Stage 31 (ADR-0014): re-read a PARKED completed result from the run's log
// directory — ~/.verity/logs/<run-id>/ — with the SAME driver parsing the
// original dispatch used (transcript digest + `<role>.final.json` fallback +
// normalizeResult's fail-closed rules), so the worker's resume re-enters the
// post-role path with a result normalized IDENTICALLY to the one the human
// read when they approved. Zero provider spawns: this touches only the disk.
// Returns { outcome, artifacts, error } — the T05 slice the worker consumes —
// or null when nothing is persisted for that run/role. Malformed/invalid
// persisted output throws AgentExecError exactly as a live dispatch would
// (never a guessed success); the caller's fallback owns what happens next.
// run-id and role commonly arrive from a worker-authored GitHub comment, so
// they are validated as path components here, at the boundary, not trusted.
function readParkedResult(flags = {}) {
  const runId = flags['run-id'] ?? flags.runId;
  const role = flags.role;
  if (typeof runId !== 'string' || !SAFE_ID.test(runId)) {
    throw new AgentExecError(`invalid --run-id '${runId}' — ${USAGE}`, 'usage');
  }
  if (typeof role !== 'string' || !SAFE_ID.test(role)) {
    throw new AgentExecError(`invalid role '${role}' — ${USAGE}`, 'usage');
  }
  const provider = getProvider(flags.agent || DEFAULT_AGENT);
  if (
    typeof provider.parseTranscript !== 'function' ||
    typeof provider.normalizeResult !== 'function'
  ) {
    return null; // this provider persists no re-readable result — not resumable
  }
  const transcript = path.join(
    os.homedir(),
    '.verity',
    'logs',
    runId,
    provider.transcriptFilename(role),
  );
  const final = provider.parseTranscript(transcript);
  if (final === null) {
    return null; // neither the transcript nor the final-message file exists
  }
  const normalized = provider.normalizeResult(final, { maxTurns: DEFAULT_MAX_TURNS });
  return { outcome: normalized.outcome, artifacts: normalized.artifacts, error: normalized.error };
}

// The public entry point: run the dispatch, then undo whatever it did to the
// operator's checkout. A `finally` (not a call at the end of runDispatch) on
// purpose — it must run after EVERY return path, including the usage errors that
// throw and any unexpected exception, and it runs AFTER the returned result has
// been fully computed, so the Verity-performed commit still lands on the stage
// branch before the checkout moves back. Providers without the git-lifecycle
// hooks register nothing, so their path is byte-identical.
function dispatch(args, flags) {
  const session = { restore: null };
  try {
    return runDispatch(args, flags, session);
  } finally {
    if (session.restore !== null) {
      session.restore();
    }
  }
}

// The historic export surface is preserved verbatim (worker/index.cjs and the
// pre-stage-7 tests depend on it); Claude-specific entries are re-exports from
// the extracted driver / contract modules.
module.exports = {
  AgentExecError,
  DEFAULT_MAX_TURNS,
  MIN_CLAUDE_VERSION: claude.MIN_CLAUDE_VERSION,
  RESULT_CONTRACT,
  SCHEMA,
  checkAgentVersion: claude.checkVersion,
  compareVersions,
  countToolCalls: claude.countToolCalls,
  dispatch,
  exitCodeFor,
  extractMarker,
  parseVersion,
  readAllowlist: claude.readAllowlist,
  readParkedResult,
  renderPrompt: claude.renderPrompt,
  resolveRole,
};
