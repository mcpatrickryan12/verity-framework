// Grok Build provider driver — the ONLY module that knows the Grok Build wire
// format. Modeled on claude.cjs (the reference driver): Grok Build's
// `--output-format streaming-messages-json` deliberately emits the Messages
// API stream-json wire format — `assistant` messages whose content[] holds
// text/thinking/tool_use blocks and a terminal `type:"result"` object with
// is_error/subtype/usage/total_cost_usd — so transcript parsing, tool-use
// counting, and usage/cost normalization are shared with the reference driver
// by construction, not by coincidence (grok-build user-guide
// 14-headless-mode.md §streaming-messages-json).
//
// Invocation shape (flag spellings verified against xai-org/grok-build
// docs/user-guide/14-headless-mode.md, Grok Build ≥1.0.0):
//   grok -p "<rendered prompt>" --verbatim --output-format
//     streaming-messages-json --max-turns N --allow <entry> [--allow ...]
//
// Permission surface: Grok Build's --allow rules use the SAME
// `ToolPrefix(pattern)` grammar as the T06 allowlist entries, and its rule
// matcher explicitly accepts Claude's `Bash(cmd:*)` prefix form — so entries
// travel VERBATIM, one --allow per entry. Deny-by-default holds because the
// driver never passes --yolo / --always-approve / --permission-mode: headless
// runs cannot prompt, so a tool call no --allow rule covers fails closed
// instead of executing (22-permissions-and-safety.md).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

// Shared version-probe helpers: the parse/compare/probe logic lives in
// doctor.cjs so `verity doctor` and this driver can never drift apart.
const { checkBinary } = require('../doctor.cjs');

// Shared role-prompt pipeline (ADR-0002): renderPrompt() consumes the SAME
// renderRole() that `verity install --grok` writes to disk, so headless
// prompts carry the same preambles as installed files.
const { renderRole } = require('../install.cjs');

const { AgentExecError, RESULT_CONTRACT, isPlainObject, extractMarker } =
  require('./result-contract.cjs');

const engineMeta = require('../engine-meta.cjs');

// Version floor: Grok Build left beta at v1.0 (2026-08-07); the headless flag
// set this driver spawns (--verbatim, --output-format
// streaming-messages-json, --max-turns, repeatable --allow) is the v1.0
// surface. Same fallback discipline as the reference driver: the hardcoded
// floor covers a stale engine copy with no engine-meta.json.
const MIN_GROK_VERSION = engineMeta.load().verity?.grokBuildMinVersion || '1.0.0';
const DEFAULT_BINARY = 'grok';

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

// Binary override precedence (the claude.cjs convention):
//   1. explicit CLI flag        — none exists yet; reserved
//   2. VERITY_GROK_BIN          — provider-specific override
//   3. VERITY_AGENT_BIN         — legacy override, preserved (the test seam)
//   4. `grok`                   — the provider default, resolved via PATH
function resolveBinary(env = process.env) {
  return env.VERITY_GROK_BIN || env.VERITY_AGENT_BIN || DEFAULT_BINARY;
}

// Fail-fast min-version check: missing binary or version below the pin →
// { ok:false, slug, error }; never throws. The probe is the shared
// doctor.checkBinary(); this wrapper only maps its result onto the agent-exec
// slugs/messages.
function checkVersion(bin, opts = {}) {
  const check = checkBinary(bin, { exec: opts.exec, minVersion: MIN_GROK_VERSION });
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
      error: `Grok Build ${check.version} is below the pinned minimum ${MIN_GROK_VERSION} — reinstall via https://x.ai/cli`,
    };
  }
  return { ok: true, version: check.version };
}

// T06: <role>.tools.json = non-empty JSON array of tool-permission strings,
// passed verbatim to `--allow` (one flag per entry). Deny-by-default: a
// MISSING allowlist does NOT fall back to the agent's default permission
// behavior — agent-exec refuses to invoke the agent at all (exit 30). Same
// loader semantics as the reference driver, same error slugs.
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

function readPolicy(resolved) {
  return { allowlist: readAllowlist(resolved.toolsFile) };
}

// Delivery-substrate narrowing (ADR-0029): identical rule set to the
// reference driver — on the LOCAL substrate no role invokes `gh` and no role
// needs the network, so every gh/network-granting entry is stripped from the
// exact strings passed to --allow. Grok Build's permission engine then
// enforces the narrowed surface (headless deny-by-default), which is what
// makes this an honest restriction rather than theater (ADR-0011). Narrowing
// ONLY: entries are removed, never added or rewritten; any substrate that is
// not exactly 'local' returns the INPUT OBJECT untouched.
const LOCAL_SUBSTRATE_DENIED_TOOLS = [
  /^\s*Bash\(\s*gh([\s:)]|$)/, // any gh invocation grant
  /^\s*WebFetch\s*(\(|$)/,
  /^\s*WebSearch\s*(\(|$)/,
];

function narrowForSubstrate(policy, substrate) {
  if (substrate !== 'local') {
    return policy; // same reference — github/absent stays byte-identical
  }
  const allowlist = policy.allowlist.filter(
    (t) => !LOCAL_SUBSTRATE_DENIED_TOOLS.some((re) => re.test(t)),
  );
  if (allowlist.length === 0) {
    throw new AgentExecError(
      "--substrate local strips every gh/network-granting tool from this role's allowlist, leaving NO tools at all — refusing the dispatch rather than running a role whose surface Verity cannot honestly narrow (ADR-0029)",
      'unenforceable-policy',
    );
  }
  return { ...policy, allowlist };
}

// Transcript naming per contracts/agent-result.md §Consumes: like codex, this
// driver suffixes its provider id so a role's Claude transcript is never
// clobbered by a Grok run of the same role in the same log dir.
function transcriptFilename(role) {
  return `${role}.grok.jsonl`;
}

// Render the role command file the way Grok Build would run it as a slash
// command: the install-time pipeline with the 'grok' host pass, frontmatter
// stripped, $ARGUMENTS substituted, headless result contract appended — the
// same recipe as the reference driver, through the same renderRole().
function renderPrompt(file, roleArgs) {
  let text = renderRole(file, {}, 'grok');
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  text = text.replace(/\$ARGUMENTS/g, roleArgs.join(' '));
  return `${text.trimEnd()}\n${RESULT_CONTRACT}`;
}

// Grok's rule-parser prefix vocabulary, verified against the source
// (xai-org/grok-build crates/codegen/xai-grok-workspace/src/permission/
// rules.rs `tool_name_to_filter`: Write folds into Edit, Glob into Grep;
// bare `mcp__…` spellings are the recognized MCP rule form). Headless mode
// parses --allow/--deny STRICTLY (headless.rs parse_permission_rules_strict)
// — ONE unrecognized prefix aborts the whole invocation — so entries outside
// the vocabulary must be dropped before argv construction, never passed
// through. Dropping is narrowing only: the uncovered tool call then fails
// closed at runtime (headless answers un-ruled permission requests with
// Cancelled outside yolo mode), it is never silently allowed. `Task` is the
// one packaged T06 entry this touches today, and it loses nothing: Grok
// subagents are not permission-gated (spawning is governed by
// --disallowed-tools Agent, which this driver never passes).
const GROK_RULE_PREFIXES =
  /^(Bash|Read|Edit|Write|MCPTool|Grep|Glob|WebFetch|WebSearch|AgentMessage|SendSubagentMessage|SendAgentMessage)\s*(\(|$)/;

function projectAllowlist(allowlist) {
  const kept = allowlist.filter((t) => {
    const trimmed = t.trim();
    return GROK_RULE_PREFIXES.test(trimmed) || trimmed.startsWith('mcp__');
  });
  if (kept.length === 0) {
    throw new AgentExecError(
      "no entry in this role's allowlist is expressible as a Grok Build permission rule — refusing the dispatch rather than launching a role with no enforceable surface (Grok's strict headless rule parser rejects unknown prefixes, so nothing could be granted)",
      'unenforceable-policy',
    );
  }
  return kept;
}

// The verified headless argv. --verbatim keeps the rendered role text from
// being re-interpreted as slash-command/attachment syntax (the prompt IS the
// program — expansion would corrupt it). Variadic --allow entries LAST, one
// flag per entry (--allow is repeatable, not comma-joined; entries verbatim
// after the vocabulary projection above — T06, the caller guarantees a
// non-empty list via readAllowlist). The optional model override
// (`agent.model`) is omitted-in.
function buildArgv({ prompt, maxTurns, allowlist, model }) {
  const argv = [
    '-p',
    prompt,
    '--verbatim',
    '--output-format',
    'streaming-messages-json',
    '--max-turns',
    String(maxTurns),
  ];
  if (model) {
    argv.push('--model', model);
  }
  for (const entry of projectAllowlist(allowlist)) {
    argv.push('--allow', entry);
  }
  return argv;
}

// Run the agent with stdout going straight to the transcript file (true
// streaming). Returns the raw spawnSync result; the coordinator maps
// run.error → spawn-failed. The provider-neutral --timeout-secs deadline
// (ADR-0008) is enforced on the child process here.
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

// Last transcript line that is the agent CLI's final result object. Grok
// Build's terminal line is `type:"result"` in the Messages wire shape — the
// same scan as the reference driver. (The docs warn the init/result lines may
// omit placeholder fields rather than zero-filling them; the scan keys only
// on `type`, so omitted fields cost nothing here.)
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

// Count tool-use events: every `tool_use` content block inside an assistant
// message is one tool call. Identical to the reference driver — Grok Build
// groups a model response's blocks into one `assistant` line the same way.
// Non-JSON noise and an unreadable transcript count as zero; the count must
// never fail the invocation.
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

// Fold Grok Build's usage fields into the frozen v1 totals. Grok's
// `input_tokens` is uncached-only (token field policy, 14-headless-mode.md),
// so tokens.in = input + cache_creation + cache_read — the same formula as
// the reference driver, and here it is exactly the full prompt sum by the
// documented identity. est_usd comes from total_cost_usd and stays null when
// absent (null means UNKNOWN, ADR-0008) — Grok omits ALL cost floats when
// cost is partial, so a present total_cost_usd is a complete bill.
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

// Outcome detection: the role's in-band marker wins; no marker → infer from
// the CLI result. Grok Build's terminal result carries the same
// is_error/subtype pair on the success path; on max-turns the turn stop
// reason is `max_turn_requests` (stop_reason), surfaced here with the same
// operator-facing message as the reference driver.
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
  const maxTurnsHit =
    final.subtype === 'error_max_turns' || final.stop_reason === 'max_turn_requests';
  return {
    outcome: 'failed',
    artifacts: {},
    error: maxTurnsHit
      ? `max turns (${maxTurns}) exhausted`
      : firstLine(final.result) || `agent error (${final.subtype || 'unknown'})`,
  };
}

module.exports = {
  id: 'grok',
  displayName: 'Grok Build',
  binaryEnvVar: 'VERITY_GROK_BIN',
  defaultBinary: DEFAULT_BINARY,
  MIN_GROK_VERSION,
  supportsMaxTurns: true,
  buildArgv,
  checkVersion,
  projectAllowlist,
  countToolCalls,
  execute,
  narrowForSubstrate,
  normalizeResult,
  normalizeUsage,
  parseTranscript,
  readAllowlist,
  readPolicy,
  renderPrompt,
  resolveBinary,
  transcriptFilename,
};
