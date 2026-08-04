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
//   2. Look up the provider driver (--agent, default claude) in the registry;
//      fail fast (exit 30) if the driver's binary is missing or below its
//      pinned minimum version.
//   3. driver.execute() invokes the agent with cwd = repo root; the raw
//      transcript streams kernel-side to ~/.verity/logs/<run-id>/<role>.jsonl
//      ($HOME-relative via os.homedir(), so tests can redirect it).
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
  'usage: verity agent-exec <role> [args...] --run-id <id> [--max-turns N] [--timeout-secs N] [--agent claude|codex] [--model M] [--sandbox S] [--approval A]';

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

// Role → command file + permission files (Claude's `.tools.json` allowlist and
// the runtime-neutral `.permissions.json` capability policy — the resolved
// driver reads its own via readPolicy), preferring the target repo's installed
// copies over the packaged ones. Returns null when the role does not exist.
function resolveRole(cwd, role) {
  const dirs = [
    path.join(cwd, 'commands', 'verity'),
    path.join(cwd, '.claude', 'commands', 'verity'),
    path.join(__dirname, '..', '..', '..', 'commands', 'verity'),
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

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const t0 = Date.now();
  const stderr = (line) => process.stderr.write(`${line}\n`);

  // §3.3 result object, exact field set — infra problems still emit it (with
  // outcome infra_error) so callers (T10) always get one parseable object.
  const result = (outcome, extra = {}) => buildResult(args[0] || null, t0, outcome, extra);
  const infra = (slug, message) => {
    stderr(`verity-agent-exec: 30 ${slug}: ${message}`);
    return result('infra_error', { error: message });
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
  if (!SAFE_ID.test(role)) {
    return infra('unknown-role', `invalid role name '${role}'`);
  }
  const resolved = resolveRole(cwd, role);
  if (resolved === null) {
    return infra('unknown-role', `no command file for role '${role}' (commands/verity/${role}.md)`);
  }
  const bin = provider.resolveBinary(process.env);
  const version = provider.checkVersion(bin);
  if (!version.ok) {
    return infra(version.slug, version.error);
  }
  // Driver-owned permission surface, fail closed (Claude: the T06 `.tools.json`
  // allowlist; Codex: the ADR-0007 `.permissions.json` capability policy).
  // Whatever the driver refuses, the agent is never invoked — exit 30.
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

  // -- invocation (argv construction + spawn live in the driver) --
  const prompt = provider.renderPrompt(resolved.file, roleArgs);
  const logDir = path.join(os.homedir(), '.verity', 'logs', runId);
  fs.mkdirSync(logDir, { recursive: true });
  const transcript = path.join(logDir, provider.transcriptFilename(role));
  // Additive contract annotations (agent-result v1.x optional fields) from
  // drivers that declare them — claude has none, so its output is unchanged.
  const notes = provider.annotate ? provider.annotate({ role, logDir }) : {};

  const run = provider.execute({
    bin,
    prompt,
    maxTurns,
    cwd,
    transcript,
    logDir,
    role,
    timeoutSecs,
    model,
    ...policy,
  });
  if (run.error && run.error.code === 'ETIMEDOUT') {
    // ADR-0008: the deadline killed the child. The partial transcript stays
    // on disk; the outcome is a normalized FAILURE with timed_out: true —
    // never a success, never a silent no-op.
    return result('failed', {
      ...notes,
      timed_out: true,
      tool_calls: provider.countToolCalls(transcript),
      error: `agent timed out after ${timeoutSecs}s — child killed, partial transcript retained: ${transcript}`,
    });
  }
  if (run.error) {
    return infra('spawn-failed', `failed to run ${bin}: ${run.error.message}`);
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
      return infra(err.slug || 'malformed-output', err.message);
    }
    throw err;
  }
  if (final === null) {
    const hint = firstLine(run.stderr) || `agent exit ${run.status}`;
    return infra(
      'malformed-output',
      `agent emitted no parseable result object (${hint}); transcript: ${transcript}`,
    );
  }
  const { tokens, est_usd: estUsd, ...usageExtra } = usage;
  const toolCalls = provider.countToolCalls(transcript);
  const { outcome, error, artifacts } = normalized;
  return result(outcome, {
    tokens,
    est_usd: estUsd,
    tool_calls: toolCalls,
    artifacts,
    error,
    ...notes,
    ...usageExtra,
  });
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
  renderPrompt: claude.renderPrompt,
  resolveRole,
};
