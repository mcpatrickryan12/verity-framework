// contracts/agent-result.md v1 (FROZEN) — the normalized result object every
// provider driver produces and `agent-exec` emits; the ONLY thing that crosses
// from a model runtime back into deterministic Verity. This module owns the
// provider-neutral pieces of that contract:
//   - the §3.3 result-object builder (exact field set, emitted for role
//     outcomes AND infra failures alike),
//   - the RESULT_CONTRACT prompt footer + the marker parser for the in-band
//     outcome marker it asks for,
//   - the outcome → exit-code map (success 0, gated 10, failed 20, infra 30),
//   - AgentExecError, the classified infra error (exit 30 + stderr slug).
// Provider wire details (event grammars, usage fields, CLI subtypes) do NOT
// belong here — they live in the sibling drivers (ADR-0005).
const SCHEMA = 1;
const OUTCOMES = ['success', 'gated', 'failed'];

// Appended to every rendered role prompt: how a headless role reports back.
const RESULT_CONTRACT = `
<headless-result-contract>
You are running headless under \`verity agent-exec\` — no human is present.
Never wait for user input or ask questions. If progress requires a human
decision, approval, or gate, stop working and report the outcome "gated".
The very LAST line of your final message MUST be exactly one single-line JSON
object (no code fence on that line), shaped like:
{"verity":1,"outcome":"success","gate":null,"artifacts":{"pr":114,"issues":[98]},"reason":"one line"}
- outcome "success": the role's goal is fully done.
- outcome "gated": a human gate/approval/decision blocks further progress
  (set "gate" to the gate name, e.g. "review:merge").
- outcome "failed": you could not complete the role's goal (set "reason").
"artifacts" lists GitHub objects you created/updated (best effort).
</headless-result-contract>
`;

class AgentExecError extends Error {
  constructor(message, slug) {
    super(message);
    this.name = 'AgentExecError';
    this.exitCode = 30;
    this.slug = slug || null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// §3.3 result object, exact field set — v1 fields are all REQUIRED, so the
// builder always emits every one (extras fill in the measured values).
function buildResult(role, t0, outcome, extra = {}) {
  return {
    schema: SCHEMA,
    role,
    outcome,
    tokens: { in: 0, out: 0 },
    est_usd: null,
    wall_secs: Math.round((Date.now() - t0) / 1000),
    tool_calls: 0,
    artifacts: {},
    error: null,
    ...extra,
  };
}

// Last line of the role's final message that parses as the outcome marker.
function extractMarker(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (!t.startsWith('{') || !t.endsWith('}')) {
      continue;
    }
    try {
      const obj = JSON.parse(t);
      if (isPlainObject(obj) && OUTCOMES.includes(obj.outcome)) {
        return obj;
      }
    } catch {
      // not JSON — keep scanning upward
    }
  }
  return null;
}

function exitCodeFor(result) {
  const map = { success: 0, gated: 10, failed: 20, infra_error: 30 };
  const code = map[result?.outcome];
  return code === undefined ? 30 : code;
}

// --- provider structured final output (schemas/agent-result.schema.json) -----
// The role-outcome shape a provider's structured final message must satisfy
// before it is trusted: {verity, outcome, gate, artifacts, reason, summary}.
// Hand-rolled validation (zero-dep policy — no JSON-schema library); the
// schema file is the published contract artifact this code must match.
// Fail-closed: anything not explicitly valid is invalid (never "probably ok").

const ROLE_OUTCOMES = ['completed', 'gated', 'failed', 'no-op'];
const ROLE_RESULT_KEYS = ['verity', 'outcome', 'gate', 'artifacts', 'reason', 'summary'];

// Artifact entries are RELATIVE repo paths: absolute paths (POSIX or Windows)
// and any `..` traversal segment are rejected outright.
function isSafeArtifactPath(p) {
  if (typeof p !== 'string' || p.trim() === '') {
    return false;
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) {
    return false;
  }
  return !p.split(/[\\/]/).includes('..');
}

// Validate one parsed structured result. Returns { ok: true } or
// { ok: false, error } — error text never echoes field VALUES that could
// carry sensitive content (artifact paths are referenced by index only).
function validateRoleOutcome(obj) {
  const invalid = (error) => ({ ok: false, error });
  if (!isPlainObject(obj)) {
    return invalid('not a JSON object');
  }
  for (const key of Object.keys(obj)) {
    if (!ROLE_RESULT_KEYS.includes(key)) {
      return invalid(`unexpected property '${key}'`);
    }
  }
  for (const key of ROLE_RESULT_KEYS) {
    if (!(key in obj)) {
      return invalid(`missing required property '${key}'`);
    }
  }
  if (obj.verity !== 1) {
    return invalid(`verity must be 1, got ${JSON.stringify(obj.verity)}`);
  }
  if (!ROLE_OUTCOMES.includes(obj.outcome)) {
    return invalid(
      `unknown outcome ${JSON.stringify(obj.outcome)} (expected ${ROLE_OUTCOMES.join(' | ')})`,
    );
  }
  if (obj.gate !== null && typeof obj.gate !== 'string') {
    return invalid('gate must be a string or null');
  }
  if (obj.outcome === 'gated' && (typeof obj.gate !== 'string' || obj.gate.trim() === '')) {
    return invalid("outcome 'gated' requires a non-empty gate name");
  }
  if (obj.reason !== null && typeof obj.reason !== 'string') {
    return invalid('reason must be a string or null');
  }
  if (obj.outcome === 'failed' && (typeof obj.reason !== 'string' || obj.reason.trim() === '')) {
    return invalid("outcome 'failed' requires a non-empty reason");
  }
  if (!Array.isArray(obj.artifacts)) {
    return invalid('artifacts must be an array of relative paths');
  }
  for (let i = 0; i < obj.artifacts.length; i += 1) {
    if (!isSafeArtifactPath(obj.artifacts[i])) {
      return invalid(`artifacts[${i}] must be a relative path with no '..' traversal`);
    }
  }
  if (typeof obj.summary !== 'string') {
    return invalid('summary must be a string');
  }
  return { ok: true };
}

module.exports = {
  AgentExecError,
  OUTCOMES,
  RESULT_CONTRACT,
  ROLE_OUTCOMES,
  SCHEMA,
  buildResult,
  exitCodeFor,
  extractMarker,
  isPlainObject,
  isSafeArtifactPath,
  validateRoleOutcome,
};
