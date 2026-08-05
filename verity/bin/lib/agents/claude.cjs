// Claude Code provider driver (ADR-0005) — the ONLY module that knows the
// Claude wire format. Behavior-preserving extraction from agent-exec.cjs
// (stage 7): binary selection, the min-version gate, headless argv
// construction, the T06 allowlist loader, stream-json transcript parsing,
// tool-use counting, and usage/cost normalization all moved here verbatim,
// protected by the characterization suite in tests/agents.test.cjs.
// agent-exec.cjs stays a runtime-neutral coordinator and calls this driver
// through the ./index.cjs registry.
//
// Invocation shape (flag spellings verified against Claude Code 2.1.170 — see
// docs/dev/autonomy-pathmap.md "Claude Code headless interface"):
//   claude -p "<rendered prompt>" --output-format stream-json --verbose
//     --max-turns N --allowed-tools <each entry verbatim>
// stream-json (not json) is a deliberate deviation: one invocation streams the
// raw transcript AND ends with the same `type:"result"` object.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

// Shared version-probe helpers (stage 1): the parse/compare/probe logic lives
// in doctor.cjs so `verity doctor` and this driver can never drift apart.
const { checkBinary } = require('../doctor.cjs');

// Shared role-prompt pipeline (stage 2, ADR-0002): renderPrompt() consumes the
// SAME renderRole() that `verity install` writes to disk, so headless prompts
// carry the same preambles as installed files — one system, never two copies.
const { renderRole } = require('../install.cjs');

const { AgentExecError, RESULT_CONTRACT, extractMarker, isPlainObject } =
  require('./result-contract.cjs');

// Version floor from the IN-SUBTREE engine-meta.json (stage 35), not a top-level
// `require('../../../../package.json')` above the engine root (which crashed a
// copied engine at load). The hardcoded `'2.1.170'` stays the honest fallback
// for a stale pre-fix copy with no engine-meta.json.
const engineMeta = require('../engine-meta.cjs');

const MIN_CLAUDE_VERSION = engineMeta.load().verity?.claudeCodeMinVersion || '2.1.170';
const DEFAULT_BINARY = 'claude';

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

// Binary override precedence (codex-support.md §8.5, documented + tested):
//   1. explicit CLI flag        — none exists yet; reserved for a future stage
//   2. VERITY_CLAUDE_BIN        — provider-specific override (stage 7)
//   3. VERITY_AGENT_BIN         — legacy override, preserved (the test seam)
//   4. `claude`                 — the provider default, resolved via PATH
function resolveBinary(env = process.env) {
  return env.VERITY_CLAUDE_BIN || env.VERITY_AGENT_BIN || DEFAULT_BINARY;
}

// Fail-fast min-version check (SKETCH §3.3): missing binary or version below
// the pin → { ok:false, slug, error }; never throws. The probe itself is the
// shared doctor.checkBinary() (stage 1) — this wrapper only maps its result
// onto the agent-exec slugs/messages, which are unchanged.
function checkVersion(bin, opts = {}) {
  const check = checkBinary(bin, { exec: opts.exec, minVersion: MIN_CLAUDE_VERSION });
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
      error: `Claude Code ${check.version} is below the pinned minimum ${MIN_CLAUDE_VERSION} — run \`claude update\``,
    };
  }
  return { ok: true, version: check.version };
}

// T06: <role>.tools.json = non-empty JSON array of tool-permission strings
// (SKETCH §5 matrix), passed verbatim to the agent CLI after --allowed-tools.
// Deny-by-default: a MISSING allowlist does NOT fall back to the agent's
// default tool set — agent-exec refuses to invoke the agent at all (exit 30).
// Empty arrays are rejected too: "allow nothing" must be impossible to confuse
// with "forgot the file" / "flag omitted".
function readAllowlist(toolsFile) {
  if (!fs.existsSync(toolsFile)) {
    throw new AgentExecError(
      `deny-all: missing tool allowlist ${toolsFile} — every role needs a <role>.tools.json next to its command file (SKETCH §5)`,
      'missing-allowlist',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(toolsFile, 'utf8'));
  } catch (err) {
    throw new AgentExecError(`invalid allowlist ${toolsFile}: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((t) => typeof t !== 'string')) {
    throw new AgentExecError(
      `invalid allowlist ${toolsFile}: must be a non-empty JSON array of strings`,
    );
  }
  return parsed;
}

// Provider-neutral policy hook (stage 8): the coordinator asks every driver
// for its permission surface through readPolicy(resolved). For Claude that is
// the T06 allowlist, unchanged — `.tools.json` remains the operative Claude
// permission file (contracts/role-capability-policy.md §Claude migration).
function readPolicy(resolved) {
  return { allowlist: readAllowlist(resolved.toolsFile) };
}

// Transcript naming per contracts/agent-result.md §Consumes: Claude keeps the
// original `<role>.jsonl` (byte-identical paths — codex adds its own suffix).
function transcriptFilename(role) {
  return `${role}.jsonl`;
}

// Render the role command file the way Claude Code would run it as a slash
// command: pass it through the install-time pipeline (preamble injection is
// idempotent, so source files and already-installed copies both work), strip
// the YAML frontmatter, substitute $ARGUMENTS (the only placeholder the role
// files use), then append the headless result contract — the one block that
// stays headless-only by design (no human is present to fill the gap).
function renderPrompt(file, roleArgs) {
  let text = renderRole(file, {}, 'claude');
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  text = text.replace(/\$ARGUMENTS/g, roleArgs.join(' '));
  return `${text.trimEnd()}\n${RESULT_CONTRACT}`;
}

// The verified headless argv. Variadic --allowed-tools LAST so it can't
// swallow other args; entries verbatim (T06 — the caller guarantees a
// non-empty list via readAllowlist). The optional model override (stage 9 —
// the worker's `agent.model` knob) is omitted-in: without it the argv is
// byte-identical to the pre-stage-9 shape.
function buildArgv({ prompt, maxTurns, allowlist, model }) {
  const argv = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
  ];
  if (model) {
    argv.push('--model', model);
  }
  argv.push('--allowed-tools', ...allowlist);
  return argv;
}

// Run the agent with stdout going straight to the transcript file (true
// streaming — the kernel writes as the agent emits, even though this CLI is
// synchronous). Returns the raw spawnSync result; the coordinator maps
// run.error → spawn-failed. The optional provider-neutral --timeout-secs
// deadline (ADR-0008, stage 8) is enforced on the child process here; with no
// timeoutSecs the spawn options are exactly the pre-stage-8 ones.
function execute({ bin, prompt, maxTurns, allowlist, cwd, transcript, timeoutSecs, model }) {
  const argv = buildArgv({ prompt, maxTurns, allowlist, model });
  const fd = fs.openSync(transcript, 'w');
  try {
    return spawnSync(bin, argv, {
      cwd,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutSecs ? timeoutSecs * 1000 : undefined,
      killSignal: 'SIGKILL',
    });
  } finally {
    fs.closeSync(fd);
  }
}

// Last transcript line that is the agent CLI's final result object.
function parseTranscript(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t === '') {
      continue;
    }
    try {
      const obj = JSON.parse(t);
      if (isPlainObject(obj) && obj.type === 'result') {
        return obj;
      }
    } catch {
      // non-JSON noise — keep scanning upward
    }
  }
  return null;
}

// Count tool-use events in the stream-json transcript: every `tool_use`
// content block inside an assistant message is one tool call (stage 3 usage
// telemetry — the per-role tool_calls column). Non-JSON noise and an unreadable
// transcript count as zero; the count must never fail the invocation.
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
      continue; // non-JSON noise — same tolerance as parseTranscript
    }
    if (!isPlainObject(obj) || obj.type !== 'assistant') {
      continue;
    }
    const content = obj.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (isPlainObject(block) && block.type === 'tool_use') {
        count += 1;
      }
    }
  }
  return count;
}

// Fold Claude's usage fields into the frozen v1 totals: tokens.in includes
// cache-creation and cache-read input tokens; est_usd comes from
// total_cost_usd and stays null when absent (null means UNKNOWN — writing 0
// for unknown cost is a contract violation, ADR-0008).
function normalizeUsage(final) {
  const usage = isPlainObject(final.usage) ? final.usage : {};
  return {
    tokens: {
      in:
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0),
      out: usage.output_tokens || 0,
    },
    est_usd: typeof final.total_cost_usd === 'number' ? final.total_cost_usd : null,
  };
}

// Outcome detection (unchanged semantics): the role's in-band marker wins; no
// marker → infer from the CLI result (is_error:false/subtype:success →
// success, else failed with the best available reason).
function normalizeResult(final, { maxTurns }) {
  const marker = extractMarker(final.result);
  if (marker !== null) {
    const outcome = marker.outcome;
    return {
      outcome,
      artifacts: isPlainObject(marker.artifacts) ? marker.artifacts : {},
      error:
        outcome === 'failed'
          ? typeof marker.reason === 'string'
            ? marker.reason
            : 'role reported failure'
          : null,
    };
  }
  if (final.is_error === false && final.subtype === 'success') {
    return { outcome: 'success', artifacts: {}, error: null };
  }
  return {
    outcome: 'failed',
    artifacts: {},
    error:
      final.subtype === 'error_max_turns'
        ? `max turns (${maxTurns}) exhausted`
        : firstLine(final.result) || `agent error (${final.subtype || 'unknown'})`,
  };
}

module.exports = {
  id: 'claude',
  displayName: 'Claude Code',
  binaryEnvVar: 'VERITY_CLAUDE_BIN',
  defaultBinary: DEFAULT_BINARY,
  MIN_CLAUDE_VERSION,
  supportsMaxTurns: true,
  buildArgv,
  checkVersion,
  countToolCalls,
  execute,
  normalizeResult,
  normalizeUsage,
  parseTranscript,
  readAllowlist,
  readPolicy,
  renderPrompt,
  resolveBinary,
  transcriptFilename,
};
