// OpenAI Codex CLI provider driver (ADR-0005, stage 8) — the ONLY module that
// knows the Codex wire format. Mirrors the claude.cjs reference interface;
// agent-exec.cjs stays a runtime-neutral coordinator and reaches this driver
// through the ./index.cjs registry, only on an explicit `--agent codex`
// (the default agent remains claude — worker selection is stage 9).
//
// Invocation shape (codex-support.md §9.4; ADR-0007 explicit-config rule):
//   codex exec --json --sandbox <from policy> --output-last-message <file>
//     --cd <repo root> -c approval_policy="never" [-c ignore_user_config=true] -
// with the rendered prompt delivered over STDIN (§9.3 — no argv length limits,
// no prompt in process listings). The real Codex CLI is not available in CI,
// so these spellings are pinned by the stub-driven suite and MUST be
// re-verified against the pinned release in the manual canary
// (docs/dev/codex-headless-canary.md) before any real-traffic use.
//
// Limits (ADR-0008): NO --max-turns — a Codex "turn" is not a portable unit
// and a silently-ignored cap is worse than none; agent-exec rejects the flag
// for this driver (supportsMaxTurns: false). Runs are bounded by the
// provider-neutral --timeout-secs subprocess deadline and worker limits.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Shared version-probe helpers (stage 1): parse/compare/probe logic lives in
// doctor.cjs so `verity doctor` and the drivers can never drift apart.
const { checkBinary } = require('../doctor.cjs');

// Shared role-prompt pipeline (stage 2, ADR-0002) with the stage-6 codex host
// pass: headless prompts carry the same preambles + codex transforms as
// installed SKILL.md files — one system, never two copies.
const { CODEX_ARGUMENTS_PLACEHOLDER, renderRole } = require('../install.cjs');

const {
  AgentExecError,
  OUTCOMES,
  RESULT_CONTRACT,
  extractMarker,
  isPlainObject,
  validateRoleOutcome,
} = require('./result-contract.cjs');
const { applyOverrides: applyPolicyOverrides, loadPolicy } = require('./policy.cjs');

const PKG = require('../../../../package.json');

// Pinned against the Codex CLI release line feature-tested for the flags this
// driver depends on — `exec`, `--json`, `--sandbox`, `--output-last-message`,
// `login status` (codex-support.md §9.2) — not against "today's version".
// The manual canary re-verifies the pin on every release that touches this file.
const MIN_CODEX_VERSION = PKG.verity?.codexMinVersion || '0.42.0';
const DEFAULT_BINARY = 'codex';

// Deterministic tool-call counting (codex-support.md §9.6): count the START of
// each actionable tool item exactly once — never start + completion as two.
// Items that only ever appear as completions (agent_message, reasoning) are
// not tool calls and are never counted.
const TOOL_ITEM_TYPES = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'];

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

// Binary override precedence (codex-support.md §8.5, same ladder as claude):
//   1. explicit CLI flag        — none exists yet; reserved for a future stage
//   2. VERITY_CODEX_BIN         — provider-specific override
//   3. VERITY_AGENT_BIN         — legacy override, preserved (the test seam)
//   4. `codex`                  — the provider default, resolved via PATH
function resolveBinary(env = process.env) {
  return env.VERITY_CODEX_BIN || env.VERITY_AGENT_BIN || DEFAULT_BINARY;
}

// Fail-fast preflight: binary present, `codex --version` ≥ the pin, and
// `codex login status` succeeds. Auth uses Codex's own status command as the
// oracle — Verity never reads or parses credential files (§9.1). Never throws.
function checkVersion(bin, opts = {}) {
  const check = checkBinary(bin, { exec: opts.exec, minVersion: MIN_CODEX_VERSION });
  if (!check.present) {
    return {
      ok: false,
      slug: 'agent-missing',
      error: `agent binary not runnable: ${bin} (${check.output})`,
    };
  }
  if (check.why === 'unparsable') {
    return {
      ok: false,
      slug: 'agent-missing',
      error: `could not parse \`${bin} --version\` output: ${check.output}`,
    };
  }
  if (check.why === 'too-old') {
    return {
      ok: false,
      slug: 'version-too-old',
      error: `Codex CLI ${check.version} is below the pinned minimum ${MIN_CODEX_VERSION} — upgrade the Codex CLI`,
    };
  }
  const exec = opts.exec || spawnSync;
  const auth = exec(bin, ['login', 'status'], { encoding: 'utf8' });
  if (auth.error || auth.status !== 0) {
    const why = auth.error ? auth.error.code || auth.error.message : `exit ${auth.status}`;
    return {
      ok: false,
      slug: 'agent-unauthenticated',
      error: `codex is not authenticated (\`codex login status\` failed: ${why}) — run \`codex login\``,
    };
  }
  return { ok: true, version: check.version };
}

// The Codex analogue of claude's readAllowlist: the fail-closed capability
// policy (ADR-0007). Missing/invalid `<role>.permissions.json` throws (exit
// 30) — no fallback sandbox, execution refused. `.tools.json` is NOT read
// here: it stays Claude's allowlist, untouched.
function readPolicy(resolved) {
  return { policy: loadPolicy(resolved.permissionsFile) };
}

// Worker/autonomy-policy overrides (stage 9): sandbox/approval from
// `.verity/autonomy.yml` projected onto the loaded role policy — narrow only,
// never widen; widening throws (exit 30, slug bad-override). The coordinator
// calls this only when an override was actually given.
function applyOverrides(policyBag, overrides) {
  return { policy: applyPolicyOverrides(policyBag.policy, overrides) };
}

// Transcript / final-message naming per contracts/agent-result.md §Consumes:
// Codex runs sit beside Claude's `<role>.jsonl` without colliding.
function transcriptFilename(role) {
  return `${role}.codex.jsonl`;
}

function finalMessageFilename(role) {
  return `${role}.final.json`;
}

function rulesFilename(role) {
  return `${role}.rules.json`;
}

// --- ADR-0007 enforcement projection (stage 9) --------------------------------
// "Generate Codex command rules from `.permissions.json`" — the sandbox alone
// is one blunt tier; these generated rules carry the per-role differentiation.
// Derivation is deterministic and capability-driven:
//   writable_roots            the repo root is the ONLY writable root under
//                             workspace-write (denial: writes outside the
//                             repo/work roots); read-only writes nothing
//   network                   straight from capabilities.network
//   denied_read_paths         credential-shaped locations, ALWAYS denied — no
//                             capability grants credential reads
//   denied_write_paths        the protected config roots (.github/, .verity/)
//                             unless the role explicitly holds the additive
//                             write_protected_paths capability
//   denied_command_prefixes   merge authority is ALWAYS denied (T13 — the
//                             worker merges, never a role), plus per-missing-
//                             capability denials: deploy covers the denied
//                             deploy commands AND the gate-bypassing
//                             later-lifecycle commands (`verity release`);
//                             git_write / github_write cover their mutations
// One rules document is written per invocation into the run log dir and
// delivered as `-c rules_file=<path>`. The delivery spelling is pinned by the
// stub suite; the manual canary MUST re-verify it against the pinned real
// release (rules may need to live under CODEX_HOME/rules instead — fix
// buildArgv + the stubs + the canary doc together, in one commit).
const MERGE_AUTHORITY_DENIALS = ['gh pr merge'];
const CAPABILITY_COMMAND_DENIALS = {
  deploy: ['gh release create', 'npm publish', 'scripts/deploy', 'verity release'],
  git_write: ['git commit', 'git push', 'git tag'],
  github_write: [
    'gh issue close',
    'gh issue comment',
    'gh issue create',
    'gh issue delete',
    'gh issue edit',
    'gh label create',
    'gh label delete',
    'gh label edit',
    'gh pr close',
    'gh pr comment',
    'gh pr create',
    'gh pr edit',
    'gh pr ready',
    'gh pr review',
    'gh release delete',
    'gh release edit',
  ],
};
const CREDENTIAL_READ_DENIALS = [
  '~/.aws',
  '~/.codex',
  '~/.config/gh',
  '~/.netrc',
  '~/.npmrc',
  '~/.ssh',
  '.env',
  '.netrc',
  '.npmrc',
];
const PROTECTED_WRITE_PATHS = ['.github/', '.verity/'];

function commandRules(policy, { cwd }) {
  const caps = policy.capabilities;
  const denied = new Set(MERGE_AUTHORITY_DENIALS);
  for (const [capability, prefixes] of Object.entries(CAPABILITY_COMMAND_DENIALS)) {
    if (caps[capability] !== true) {
      for (const prefix of prefixes) {
        denied.add(prefix);
      }
    }
  }
  return {
    schema: 1,
    sandbox: policy.codex.sandbox,
    writable_roots: policy.codex.sandbox === 'workspace-write' ? [cwd] : [],
    network: caps.network === true,
    denied_command_prefixes: [...denied].sort(),
    denied_read_paths: [...CREDENTIAL_READ_DENIALS],
    denied_write_paths: caps.write_protected_paths === true ? [] : [...PROTECTED_WRITE_PATHS],
  };
}

// Additive contract annotations (agent-result v1.x optional fields) merged
// into the emitted result object by the coordinator. Claude has no annotate()
// so its output stays byte-identical.
function annotate({ role, logDir }) {
  return {
    provider: 'codex',
    timed_out: false,
    transcript_path: path.join(logDir, transcriptFilename(role)),
    final_message_path: path.join(logDir, finalMessageFilename(role)),
  };
}

// Render the role for headless Codex: the ADR-0002 pipeline with the stage-6
// codex host pass, frontmatter stripped, role args resolved (the codex pass
// rewrites $ARGUMENTS to its named placeholder — headless execution resolves
// that placeholder here, exactly as agent-exec resolves $ARGUMENTS for
// claude), then the shared headless result-contract footer.
function renderPrompt(file, roleArgs) {
  let text = renderRole(file, {}, 'codex');
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const args = roleArgs.join(' ');
  text = text.split(CODEX_ARGUMENTS_PLACEHOLDER).join(args);
  text = text.replace(/\$ARGUMENTS/g, args);
  return `${text.trimEnd()}\n${RESULT_CONTRACT}`;
}

// The headless argv (§9.4). Approval policy is set EXPLICITLY (`never` — no
// human is present) and, per ADR-0007's explicit-config rule, user-config
// isolation is passed explicitly rather than inherited. The prompt is NOT
// here: `-` reads it from stdin. Claude-only flags (--allowed-tools,
// --max-turns, --output-format stream-json) never appear. Stage-9 additions:
// the generated command-rules document (rulesPath) and an optional model
// override — both omitted-in, so stage-8 argv is unchanged without them.
function buildArgv({ policy, finalMessagePath, rulesPath, cwd, model }) {
  const argv = [
    'exec',
    '--json',
    '--sandbox',
    policy.codex.sandbox,
    '--output-last-message',
    finalMessagePath,
    '--cd',
    cwd,
    '-c',
    `approval_policy=${JSON.stringify(policy.codex.approval)}`,
  ];
  if (policy.codex.ignore_user_config) {
    argv.push('-c', 'ignore_user_config=true');
  }
  if (rulesPath) {
    argv.push('-c', `rules_file=${JSON.stringify(rulesPath)}`);
  }
  if (model) {
    argv.push('--model', model);
  }
  argv.push('-');
  return argv;
}

// Run codex with stdout streaming straight to the transcript file and the
// rendered prompt on stdin. The provider-neutral --timeout-secs deadline is
// enforced HERE, on the child process (ADR-0008): on expiry Node kills the
// child (SIGKILL — no second chance) and the coordinator normalizes the
// partial transcript into a failure with timed_out: true.
function execute({ bin, prompt, policy, cwd, transcript, logDir, role, timeoutSecs, model }) {
  const finalMessagePath = path.join(logDir, finalMessageFilename(role));
  // ADR-0007: the enforcement projection travels with every invocation — the
  // rules document is regenerated from the (possibly narrowed) policy each
  // run, never cached, so it can't drift from what was actually loaded.
  const rulesPath = path.join(logDir, rulesFilename(role));
  fs.writeFileSync(rulesPath, `${JSON.stringify(commandRules(policy, { cwd }), null, 2)}\n`);
  const argv = buildArgv({ policy, finalMessagePath, rulesPath, cwd, model });
  const fd = fs.openSync(transcript, 'w');
  try {
    return spawnSync(bin, argv, {
      cwd,
      input: prompt,
      stdio: ['pipe', fd, 'pipe'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutSecs ? timeoutSecs * 1000 : undefined,
      killSignal: 'SIGKILL',
    });
  } finally {
    fs.closeSync(fd);
  }
}

// Tolerant line-by-line JSONL digest (§9.6). Recognizes the lifecycle events
// the pinned CLI emits (thread/turn/item/error), tolerates unknown event
// types and extra fields, and skips blank lines. A truncated FINAL line is
// expected debris after a timeout kill and is tolerated; malformed JSON
// anywhere else is a grammar break → AgentExecError naming the line number
// (never echoing line content — transcripts can carry secrets).
// Returns null only when neither the transcript nor the final-message file is
// readable; otherwise a digest the normalize* functions consume.
function parseTranscript(transcriptPath) {
  let raw = null;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    // fall through — the final-message file may still exist
  }
  const finalMessagePath = transcriptPath.replace(/\.codex\.jsonl$/, '.final.json');
  let finalMessageText = null;
  try {
    finalMessageText = fs.readFileSync(finalMessagePath, 'utf8');
  } catch {
    // no structured final message — the marker/lifecycle fallbacks apply
  }
  if (raw === null && finalMessageText === null) {
    return null;
  }
  const digest = {
    transcriptPath,
    finalMessagePath,
    finalMessageText,
    lastAgentMessage: null,
    failure: null,
    usage: null,
    sawCompletion: false,
    truncated: false,
  };
  const lines = raw === null ? [] : raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '') {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (err) {
      const isFinalLine = lines.slice(i + 1).every((l) => l.trim() === '');
      if (isFinalLine) {
        digest.truncated = true;
        break;
      }
      throw new AgentExecError(
        `malformed JSONL in codex transcript at line ${i + 1} (${transcriptPath}): ${err.message}`,
        'malformed-output',
      );
    }
    if (!isPlainObject(obj) || typeof obj.type !== 'string') {
      continue; // tolerate unknown shapes — never crash on a future event
    }
    if (obj.type === 'item.completed' && isPlainObject(obj.item)) {
      if (obj.item.item_type === 'agent_message' && typeof obj.item.text === 'string') {
        digest.lastAgentMessage = obj.item.text;
      }
    } else if (obj.type === 'turn.completed') {
      digest.sawCompletion = true;
      if (isPlainObject(obj.usage)) {
        digest.usage = obj.usage; // last usage event wins — duplicates never double-count
      }
    } else if (obj.type === 'turn.failed') {
      digest.failure =
        (isPlainObject(obj.error) && typeof obj.error.message === 'string' && obj.error.message) ||
        'turn failed';
    } else if (obj.type === 'error') {
      digest.failure = typeof obj.message === 'string' ? obj.message : 'provider error';
    }
    // thread.started / turn.started / item.started / item.updated / unknown:
    // lifecycle noise here — counting lives in countToolCalls().
  }
  return digest;
}

// Count actionable tool items from the retained transcript (stage 3 usage
// telemetry). Item STARTS only (TOOL_ITEM_TYPES); tolerant of noise and an
// unreadable file — the count must never fail the invocation.
function countToolCalls(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // non-JSON noise — same tolerance as claude's counter
    }
    if (!isPlainObject(obj) || obj.type !== 'item.started' || !isPlainObject(obj.item)) {
      continue;
    }
    if (TOOL_ITEM_TYPES.includes(obj.item.item_type)) {
      count += 1;
    }
  }
  return count;
}

// Fold Codex usage into the frozen v1 totals. Codex reports
// {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
// total_tokens} where cached/reasoning are SUBSETS of input/output (OpenAI
// usage semantics) — so folding is the identity on the two headline fields,
// and the raw detail travels in the additive usage_detail block.
// est_usd is ALWAYS null: Codex reports no exact per-run dollar cost, and
// null means UNKNOWN — writing 0 would tell the budget breaker the run was
// free (ADR-0008 contract violation).
function normalizeUsage(final) {
  const usage = isPlainObject(final.usage) ? final.usage : null;
  if (usage === null) {
    return { tokens: { in: 0, out: 0 }, est_usd: null };
  }
  const detail = {};
  for (const key of [
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ]) {
    if (typeof usage[key] === 'number') {
      detail[key] = usage[key];
    }
  }
  return {
    tokens: { in: usage.input_tokens || 0, out: usage.output_tokens || 0 },
    est_usd: null,
    usage_detail: detail,
  };
}

// The whole trimmed text parsed as ONE plain JSON object, or null.
function wholeJsonObject(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) {
    return null;
  }
  try {
    const obj = JSON.parse(t);
    return isPlainObject(obj) ? obj : null;
  } catch {
    return null;
  }
}

// Structured role outcome → the contract's outcome vocabulary. `completed`
// and `no-op` both mean the role finished its goal (a no-op did so with
// nothing to change); artifact PATHS (array) normalize into the v1 artifacts
// object under a `paths` key so the consumer-visible shape never changes.
function fromStructured(structured) {
  const outcome =
    structured.outcome === 'completed' || structured.outcome === 'no-op'
      ? 'success'
      : structured.outcome;
  return {
    outcome,
    artifacts: structured.artifacts.length > 0 ? { paths: structured.artifacts } : {},
    error: outcome === 'failed' ? structured.reason : null,
  };
}

function fromMarker(marker) {
  return {
    outcome: marker.outcome,
    artifacts: isPlainObject(marker.artifacts) ? marker.artifacts : {},
    error:
      marker.outcome === 'failed'
        ? typeof marker.reason === 'string'
          ? marker.reason
          : 'role reported failure'
        : null,
  };
}

// Outcome detection, fail-closed (contracts/agent-result.md bottom rules):
//   1. the --output-last-message file (falling back to the transcript's last
//      agent message) parsed as a structured role outcome and validated
//      against schemas/agent-result.schema.json — preferred;
//   2. a whole-message or last-line RESULT_CONTRACT marker;
//   3. an explicit turn.failed / error lifecycle event → failed;
//   4. anything else → AgentExecError (infra_error) — a completed process
//      with no valid result is NEVER a success, never a silent no-op.
// A structured success that contradicts a recorded transcript failure is
// inconsistent → infra_error, not a trusted success.
function normalizeResult(final, _opts = {}) {
  const text =
    typeof final.finalMessageText === 'string' && final.finalMessageText.trim() !== ''
      ? final.finalMessageText
      : final.lastAgentMessage;
  if (typeof text === 'string' && text.trim() !== '') {
    const structured = wholeJsonObject(text);
    if (structured !== null) {
      const check = validateRoleOutcome(structured);
      if (check.ok) {
        if (
          (structured.outcome === 'completed' || structured.outcome === 'no-op') &&
          final.failure !== null
        ) {
          throw new AgentExecError(
            `inconsistent result: role reported '${structured.outcome}' but the transcript recorded a failure (${firstLine(final.failure)})`,
            'invalid-result',
          );
        }
        return fromStructured(structured);
      }
      // A whole-message RESULT_CONTRACT marker is a recognized valid format
      // (the contract accepts marker OR structured output) — never treated as
      // failed structured output. But the rescue applies ONLY to objects that
      // are not an ATTEMPT at the structured shape: anything carrying the
      // structured-only `summary` key or an array `artifacts` chose the
      // schema and must satisfy it (fail closed — `gated`/`failed` exist in
      // both vocabularies, so shape is the discriminator).
      const looksStructured = 'summary' in structured || Array.isArray(structured.artifacts);
      if (!looksStructured && OUTCOMES.includes(structured.outcome)) {
        return fromMarker(structured);
      }
      throw new AgentExecError(
        `invalid structured role result (${final.finalMessagePath}): ${check.error}`,
        'invalid-result',
      );
    }
    const marker = extractMarker(text);
    if (marker !== null) {
      return fromMarker(marker);
    }
  }
  if (final.failure !== null) {
    return { outcome: 'failed', artifacts: {}, error: firstLine(final.failure) };
  }
  throw new AgentExecError(
    `agent completed with no valid role result (no structured final message, no outcome marker; transcript: ${final.transcriptPath}) — refusing to guess`,
    'invalid-result',
  );
}

module.exports = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  binaryEnvVar: 'VERITY_CODEX_BIN',
  defaultBinary: DEFAULT_BINARY,
  CAPABILITY_COMMAND_DENIALS,
  CREDENTIAL_READ_DENIALS,
  MERGE_AUTHORITY_DENIALS,
  MIN_CODEX_VERSION,
  PROTECTED_WRITE_PATHS,
  TOOL_ITEM_TYPES,
  supportsMaxTurns: false,
  annotate,
  applyOverrides,
  buildArgv,
  checkVersion,
  commandRules,
  countToolCalls,
  execute,
  finalMessageFilename,
  normalizeResult,
  normalizeUsage,
  parseTranscript,
  readPolicy,
  renderPrompt,
  resolveBinary,
  rulesFilename,
  transcriptFilename,
};
