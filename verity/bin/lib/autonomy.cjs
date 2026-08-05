// Autonomy policy — `.verity/autonomy.yml` loader + `verity autonomy` CLI
// (verity-autonomy-technical-sketch.md §2 schema, §3.2 CLI contract).
//
// Effective policy = file deep-merged over DEFAULTS, then HARD INVARIANTS applied
// in code (not just in schemas/autonomy.schema.json):
//   - review.low_risk.protected_paths ALWAYS includes '.github/**' and '.verity/**'
//     (merged back in even if the user's file omits or removes them)
//   - gates ALWAYS includes 'golive'
//   - mode 'manual' ⇒ the worker (T12) must exit 0 IMMEDIATELY with
//     WORKER_DISABLED_MESSAGE ("autonomy disabled") before touching anything —
//     manual mode is byte-identical to pre-feature behavior.
//
// Later tasks read the effective policy via loadPolicy(cwd) — see exports.
// Policy/contract violations throw PolicyError (exitCode 20, optional .line);
// the dispatcher in verity.cjs maps err.exitCode onto the process exit code.
//
// ZERO-DEPENDENCY YAML: this module ships its own minimal YAML-SUBSET parser,
// sufficient for the §2 schema and nothing more. Supported:
//   - maps with plain keys ([A-Za-z0-9_.-]), nested by space indentation
//   - scalars: plain, 'single-quoted', "double-quoted" (JSON escapes),
//     null|~|empty, true|false, integers and decimals
//   - lists of scalars: block style (`- item`) and flow style (`[a, b]`)
//   - full-line and trailing `#` comments; blank lines; CRLF
// NOT supported — rejected with a line number, never silently misparsed:
//   tabs in indentation, multi-line/folded scalars (| >), anchors/aliases/tags
//   (& * !), flow maps ({...}), nested lists, maps inside lists, multiple
//   documents (--- / ...), quoted or complex keys, duplicate keys, plain
//   scalars that look like nested mappings (`a: b: c`).
const fs = require('node:fs');
const path = require('node:path');

const adr = require('./adr.cjs');

class PolicyError extends Error {
  constructor(message, opts = {}) {
    super(opts.line === undefined ? message : `${message} (line ${opts.line})`);
    this.name = 'PolicyError';
    this.exitCode = 20;
    if (opts.line !== undefined) {
      this.line = opts.line;
    }
  }
}

// §2 defaults — the effective policy when .verity/autonomy.yml is empty/missing.
const DEFAULTS = {
  mode: 'manual',
  auto_advance: ['plan', 'build', 'test', 'docs'],
  gates: ['review:merge', 'ship:prod', 'golive'],
  review: {
    trust: 0,
    // Stage 36 (issue #91) — ADDITIVE and DEFAULT-OFF: when true, a review
    // `escalate` verdict PARKS the work item for a human (applies
    // verity:needs-human to the anchor + names the next role in the gate)
    // instead of routing like request_changes. Absent/false is the closed
    // state — an escalate verdict then gates exactly as request_changes, so the
    // feature dark-launches byte-identically to pre-stage-36 behavior.
    escalate_routing: false,
    low_risk: {
      max_changed_lines: 150,
      allowed_paths: ['docs/**', 'tests/**', '**/*.md'],
      protected_paths: ['**/auth/**', '.github/**', 'scripts/deploy*', '.verity/**'],
      require_ci_green: true,
    },
  },
  limits: {
    max_chained_roles: 6,
    max_tokens_per_run: 2000000,
    max_wall_clock_min: 45,
    max_runs_per_day: 24,
    max_usd_per_day: 25.0,
    // ADR-0008 (stage 9): what the worker does when a role reports UNKNOWN
    // cost (est_usd null — never $0). 'gate' pauses for a human (the default
    // until a provider's cost accounting is proven), 'fail' stops the run,
    // 'allow_with_token_limit' proceeds under the token ceilings alone.
    unknown_cost_behavior: 'gate',
  },
  notify: { mention: [], webhook: null },
  humans: [],
  // §3.4: worker commits .verity/usage.csv (`chore(verity): usage <run-id>`)
  // after each run. Not in the §2 schema listing but required by §3.4's
  // "repo policy commit_usage: true (default true)" — noted T11 deviation.
  commit_usage: true,
  // Stage 9 (ADR-0005/0007/0009, codex-support.md §11.1): which model runtime
  // the worker drives. Defaults keep every pre-existing policy Claude-backed;
  // codex autonomy requires an explicit `provider: codex` edit (dark launch).
  // sandbox/approval are codex-only overrides that may only NARROW a role's
  // .permissions.json projection (enforced fail-closed in agents/policy.cjs);
  // NO unrestricted-access value exists anywhere in this schema (ADR-0007).
  agent: {
    provider: 'claude',
    model: null,
    sandbox: null,
    approval: null,
    ignore_user_config: true,
    ignore_rules: false,
  },
};

// Hard invariants (SKETCH §2) — enforced in code on every load, not just schema.
const FORCED_PROTECTED_PATHS = ['.github/**', '.verity/**'];
const FORCED_GATES = ['golive'];
// `mode: manual` ⇒ the worker exits 0 immediately with exactly this message.
const WORKER_DISABLED_MESSAGE = 'autonomy disabled';

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser (limits documented in the module header).
// ---------------------------------------------------------------------------

const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const UNSUPPORTED_LEAD = /^[&*!|>%@`?]/;

// Strip a `#` comment that is at line start or preceded by a space, outside quotes.
function stripComment(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !double) {
      single = !single;
    } else if (c === '"' && !single) {
      double = !double;
    } else if (c === '#' && !single && !double && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw, line) {
  const t = raw.trim();
  if (t === '' || t === 'null' || t === '~') {
    return null;
  }
  if (t.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(t);
    if (!m) {
      throw new PolicyError(`bad single-quoted scalar: ${t}`, { line });
    }
    return m[1].replace(/''/g, "'");
  }
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t); // JSON strings are a compatible subset of YAML double-quoting
      if (typeof v !== 'string') {
        throw new Error('not a string');
      }
      return v;
    } catch {
      throw new PolicyError(`bad double-quoted scalar: ${t}`, { line });
    }
  }
  if (UNSUPPORTED_LEAD.test(t)) {
    throw new PolicyError(`unsupported YAML feature (anchor/alias/tag/block scalar): ${t}`, {
      line,
    });
  }
  if (t === 'true') {
    return true;
  }
  if (t === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(t)) {
    return Number.parseInt(t, 10);
  }
  if (/^-?\d+\.\d+$/.test(t)) {
    return Number.parseFloat(t);
  }
  if (/:\s/.test(t) || t.endsWith(':')) {
    throw new PolicyError(`plain scalar looks like a nested mapping — quote it: ${t}`, { line });
  }
  return t;
}

function parseFlowList(raw, line) {
  const t = raw.trim();
  if (!t.endsWith(']')) {
    throw new PolicyError('flow list must open and close on the same line', { line });
  }
  const inner = t.slice(1, -1).trim();
  if (inner === '') {
    return [];
  }
  const parts = [];
  let cur = '';
  let single = false;
  let double = false;
  for (const c of inner) {
    if (c === "'" && !double) {
      single = !single;
      cur += c;
    } else if (c === '"' && !single) {
      double = !double;
      cur += c;
    } else if ((c === '[' || c === '{') && !single && !double) {
      throw new PolicyError('nested flow collections are not supported', { line });
    } else if (c === ',' && !single && !double) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => {
    if (p.trim() === '') {
      throw new PolicyError('empty flow list item', { line });
    }
    return parseScalar(p, line);
  });
}

// Parse the YAML subset into plain objects/arrays/scalars. Root is always a map.
function parseYaml(text) {
  const root = {};
  const stack = [{ indent: 0, node: root }];
  let pending = null; // a `key:` with no value yet — children decide map vs list
  const lines = String(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = i + 1;
    const visible = stripComment(lines[i]);
    if (visible.trim() === '') {
      continue;
    }
    const lead = /^[ \t]*/.exec(visible)[0];
    if (lead.includes('\t')) {
      throw new PolicyError('tabs are not allowed in indentation', { line });
    }
    const indent = lead.length;
    const content = visible.trim();
    if (content === '---' || content === '...') {
      throw new PolicyError('multi-document YAML is not supported', { line });
    }

    if (pending) {
      if (indent > pending.indent) {
        const node = content.startsWith('-') ? [] : {};
        pending.parent[pending.key] = node;
        stack.push({ indent, node });
      } else {
        pending.parent[pending.key] = null; // `key:` with no children = null
      }
      pending = null;
    }

    while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (indent !== top.indent) {
      throw new PolicyError('bad indentation', { line });
    }

    if (content === '-' || content.startsWith('- ')) {
      if (!Array.isArray(top.node)) {
        throw new PolicyError('list item outside a list', { line });
      }
      const item = content === '-' ? '' : content.slice(2).trim();
      if (item === '') {
        throw new PolicyError('empty list item', { line });
      }
      if (item.startsWith('-') || item.startsWith('[')) {
        throw new PolicyError('nested lists are not supported', { line });
      }
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(item) || item.startsWith('{')) {
        throw new PolicyError('maps inside lists are not supported (lists of scalars only)', {
          line,
        });
      }
      top.node.push(parseScalar(item, line));
      continue;
    }

    if (Array.isArray(top.node)) {
      throw new PolicyError('expected a `- item` list entry', { line });
    }
    const m = /^([^:]+):(.*)$/.exec(content);
    if (!m) {
      throw new PolicyError('expected `key: value`', { line });
    }
    const key = m[1].trim();
    if (!PLAIN_KEY.test(key)) {
      throw new PolicyError(`unsupported key syntax: ${m[1].trim()}`, { line });
    }
    const rest = m[2];
    if (rest !== '' && !rest.startsWith(' ')) {
      throw new PolicyError('missing space after `:`', { line });
    }
    if (Object.prototype.hasOwnProperty.call(top.node, key)) {
      throw new PolicyError(`duplicate key: ${key}`, { line });
    }
    const value = rest.trim();
    if (value === '') {
      pending = { key, parent: top.node, indent };
    } else if (value.startsWith('{')) {
      throw new PolicyError('flow maps are not supported', { line });
    } else if (value.startsWith('[')) {
      top.node[key] = parseFlowList(value, line);
    } else {
      top.node[key] = parseScalar(value, line);
    }
  }
  if (pending) {
    pending.parent[pending.key] = null;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Serializer (for `verity autonomy set`). Clean rewrite — comments are NOT
// preserved (no comment-preserving YAML lib exists in this zero-dep codebase).
// ---------------------------------------------------------------------------

function needsQuote(s) {
  if (s === '' || ['true', 'false', 'null', '~'].includes(s) || /^-?\d/.test(s)) {
    return true;
  }
  return !/^[A-Za-z0-9_.][A-Za-z0-9_.:/*?-]*$/.test(s);
}

function scalarToYaml(v) {
  if (v === null) {
    return 'null';
  }
  if (typeof v === 'boolean' || typeof v === 'number') {
    return String(v);
  }
  const s = String(v);
  return needsQuote(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

function toYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v)) {
      lines.push(`${pad}${k}:`, toYaml(v, indent + 2));
    } else if (Array.isArray(v)) {
      lines.push(`${pad}${k}: [${v.map(scalarToYaml).join(', ')}]`);
    } else {
      lines.push(`${pad}${k}: ${scalarToYaml(v)}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation — hand-rolled mirror of schemas/autonomy.schema.json (zero-dep).
// ---------------------------------------------------------------------------

const SPEC = {
  mode: { type: 'enum', values: ['manual', 'supervised', 'autonomous'] },
  auto_advance: { type: 'stringList' },
  gates: { type: 'stringList' },
  review: {
    type: 'map',
    keys: {
      trust: { type: 'int', min: 0, max: 2 },
      // Stage 36 (issue #91): route an `escalate` review verdict to a human
      // (verity:needs-human on the anchor) instead of a generic gate. Default
      // false (see DEFAULTS) — a dark-launched kill-switch.
      escalate_routing: { type: 'boolean' },
      low_risk: {
        type: 'map',
        keys: {
          max_changed_lines: { type: 'int', min: 0 },
          allowed_paths: { type: 'stringList' },
          protected_paths: { type: 'stringList' },
          require_ci_green: { type: 'boolean' },
        },
      },
    },
  },
  limits: {
    type: 'map',
    keys: {
      max_chained_roles: { type: 'int', min: 1 },
      max_tokens_per_run: { type: 'int', min: 1 },
      max_wall_clock_min: { type: 'int', min: 1 },
      max_runs_per_day: { type: 'int', min: 1 },
      max_usd_per_day: { type: 'number', min: 0 },
      unknown_cost_behavior: {
        type: 'enum',
        values: ['gate', 'allow_with_token_limit', 'fail'],
      },
      // Stage 19 (issue #50) — ADDITIVE and DEFAULT-ABSENT, like
      // agent.acknowledged_enforcement_gaps and agent.containment_tier: it is
      // deliberately NOT in DEFAULTS, so absence is the closed state and every
      // pre-stage-19 policy behaves identically. What the worker does when a
      // PR's CI is UNVERIFIABLE (GitHub reports no checks at all — the
      // repository may have no CI). Absent/'gate' pauses at the ci:unverified
      // human gate; 'allow_without_merge' lets the stage advance to review for
      // repositories that legitimately have no CI. Neither value can merge on
      // unverified CI — the merge gate demands a VERIFIED green reading.
      unverified_ci_behavior: {
        type: 'enum',
        values: ['gate', 'allow_without_merge'],
      },
    },
  },
  notify: {
    type: 'map',
    keys: {
      mention: { type: 'stringList' },
      webhook: { type: 'stringOrNull' },
    },
  },
  humans: { type: 'stringList' },
  commit_usage: { type: 'boolean' },
  // Stage 9: sandbox/approval enums deliberately have NO unrestricted value —
  // 'danger-full-access' is not representable in this schema (ADR-0007).
  agent: {
    type: 'map',
    keys: {
      provider: { type: 'enum', values: ['claude', 'codex'] },
      model: { type: 'stringOrNull' },
      sandbox: { type: 'enumOrNull', values: ['read-only', 'workspace-write'] },
      approval: { type: 'enumOrNull', values: ['untrusted', 'on-request', 'never'] },
      ignore_user_config: { type: 'boolean' },
      ignore_rules: { type: 'boolean' },
      // Stage 11 (ADR-0011 capability honesty rule) — ADDITIVE and
      // DEFAULT-ABSENT: the operator's explicit, auditable acknowledgement
      // that a capability the role restricts has NO enforcing mechanism on
      // the selected provider (today: `network`). Absent = nothing
      // acknowledged = such a role is REFUSED (exit 30
      // `unenforceable-policy`), which is the fail-closed default. Listing a
      // capability here does not grant it — it records that Verity does not
      // enforce its denial, and the run's result carries that admission.
      acknowledged_enforcement_gaps: { type: 'stringList' },
      // Stage 14 (ADR-0011 tier 2) — ADDITIVE and DEFAULT-ABSENT: which
      // containment tier the worker demands of every codex dispatch. Absent =
      // tier 1 (credential stripping + post-run invariants), the guarantee
      // already shipped and proven; `2` additionally runs each role in a
      // disposable shaped workspace and gates what may propagate back.
      // UNATTENDED codex autonomy (`mode: autonomous`) is REFUSED below 2.
      containment_tier: { type: 'enum', values: [1, 2] },
    },
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkLeaf(value, spec, keyPath, errors) {
  switch (spec.type) {
    case 'enum':
      if (!spec.values.includes(value)) {
        errors.push(
          `${keyPath}: must be one of ${spec.values.join('|')}, got ${JSON.stringify(value)}`,
        );
      }
      break;
    case 'enumOrNull':
      if (value !== null && !spec.values.includes(value)) {
        errors.push(
          `${keyPath}: must be null or one of ${spec.values.join('|')}, got ${JSON.stringify(value)}`,
        );
      }
      break;
    case 'stringList':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        errors.push(`${keyPath}: must be a list of strings`);
      }
      break;
    case 'int':
      if (
        !Number.isInteger(value) ||
        value < spec.min ||
        (spec.max !== undefined && value > spec.max)
      ) {
        const range =
          spec.max === undefined ? `>= ${spec.min}` : `between ${spec.min} and ${spec.max}`;
        errors.push(`${keyPath}: must be an integer ${range}, got ${JSON.stringify(value)}`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min) {
        errors.push(`${keyPath}: must be a number >= ${spec.min}, got ${JSON.stringify(value)}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${keyPath}: must be true or false, got ${JSON.stringify(value)}`);
      }
      break;
    case 'stringOrNull':
      if (value !== null && typeof value !== 'string') {
        errors.push(`${keyPath}: must be a string or null, got ${JSON.stringify(value)}`);
      }
      break;
    default:
      errors.push(`${keyPath}: internal spec error`);
  }
}

function walk(value, keys, prefix, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${prefix || 'policy'}: must be a map`);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    const spec = keys[k];
    if (!spec) {
      errors.push(`${keyPath}: unknown key`);
    } else if (spec.type === 'map') {
      walk(v, spec.keys, keyPath, errors);
    } else {
      checkLeaf(v, spec, keyPath, errors);
    }
  }
}

// Validate a (merged) policy object against the §2 schema. Returns error strings.
function validatePolicy(policy) {
  const errors = [];
  walk(policy, SPEC, '', errors);
  // Stage 9 cross-field rule: sandbox/approval are codex projection overrides
  // with no Claude meaning. A config the operator believes exists but doesn't
  // is the ADR-0008 failure mode — rejected, never silently ignored.
  const agent = policy.agent;
  if (isPlainObject(agent) && agent.provider !== 'codex') {
    for (const knob of ['sandbox', 'approval']) {
      if (agent[knob] !== undefined && agent[knob] !== null) {
        errors.push(
          `agent.${knob}: only meaningful with agent.provider codex — set the provider first or remove the override`,
        );
      }
    }
    // Same rule for the stage-11 acknowledgement knob: claude's restrictions
    // are enforced by its own harness allowlist, so it has no gap to
    // acknowledge and a non-empty list would be a config the operator
    // believes does something. An empty list is the default-absent state.
    if (
      Array.isArray(agent.acknowledged_enforcement_gaps) &&
      agent.acknowledged_enforcement_gaps.length > 0
    ) {
      errors.push(
        'agent.acknowledged_enforcement_gaps: only meaningful with agent.provider codex — claude restrictions are enforced by its own harness allowlist (ADR-0011)',
      );
    }
    // Same rule for the tier knob (stage 14): claude has no containment tiers,
    // so any value here would be a config the operator believes did something.
    if (agent.containment_tier !== undefined && agent.containment_tier !== null) {
      errors.push(
        'agent.containment_tier: only meaningful with agent.provider codex — claude has no ADR-0011 containment tiers (its write-time restriction is enforced by its own harness allowlist)',
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Loader — defaults merge + hard invariants. This is the API later tasks use.
// ---------------------------------------------------------------------------

function policyPath(cwd) {
  return path.join(cwd, '.verity', 'autonomy.yml');
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Apply the hard invariants to a structurally valid policy (mutates + returns).
function enforceInvariants(policy) {
  for (const gate of FORCED_GATES) {
    if (!policy.gates.includes(gate)) {
      policy.gates.push(gate);
    }
  }
  const lowRisk = policy.review.low_risk;
  for (const p of FORCED_PROTECTED_PATHS) {
    if (!lowRisk.protected_paths.includes(p)) {
      lowRisk.protected_paths.push(p);
    }
  }
  return policy;
}

// Raw user file → plain object ({} when missing). Throws PolicyError(+line) on
// YAML outside the supported subset.
function readUserPolicy(cwd) {
  const file = policyPath(cwd);
  if (!fs.existsSync(file)) {
    return { exists: false, path: file, data: {} };
  }
  return { exists: true, path: file, data: parseYaml(fs.readFileSync(file, 'utf8')) };
}

// EFFECTIVE policy: defaults ⊕ file, validated, invariants enforced.
// Throws PolicyError (exitCode 20) on malformed YAML or schema violations.
// This is the single entry point for T08/T10/T12/T13.
function loadPolicy(cwd) {
  const user = readUserPolicy(cwd);
  const merged = deepMerge(clone(DEFAULTS), user.data);
  const errors = validatePolicy(merged);
  if (errors.length > 0) {
    throw new PolicyError(`invalid autonomy policy (${user.path}): ${errors.join('; ')}`);
  }
  return enforceInvariants(merged);
}

// ---------------------------------------------------------------------------
// CLI verbs (SKETCH §3.2): show | set | validate
// ---------------------------------------------------------------------------

const FILE_HEADER = [
  '# .verity/autonomy.yml — Verity autonomy policy (all keys optional; defaults apply).',
  '# Rewritten by `verity autonomy set`; manual comments are not preserved.',
].join('\n');

function writeUserPolicy(cwd, data) {
  const file = policyPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${FILE_HEADER}\n${toYaml(data)}\n`);
  return file;
}

function specAt(dotted) {
  let node = { type: 'map', keys: SPEC };
  for (const part of dotted.split('.')) {
    if (node.type !== 'map' || !Object.prototype.hasOwnProperty.call(node.keys, part)) {
      return null;
    }
    node = node.keys[part];
  }
  return node;
}

function coerce(spec, raw, dotted) {
  switch (spec.type) {
    case 'enum':
      if (!spec.values.includes(raw)) {
        throw new PolicyError(`${dotted}: must be one of ${spec.values.join('|')}, got '${raw}'`);
      }
      return raw;
    case 'enumOrNull':
      if (raw === 'null') {
        return null;
      }
      if (!spec.values.includes(raw)) {
        throw new PolicyError(
          `${dotted}: must be null or one of ${spec.values.join('|')}, got '${raw}'`,
        );
      }
      return raw;
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        throw new PolicyError(`${dotted}: expected an integer, got '${raw}'`);
      }
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new PolicyError(`${dotted}: expected a number, got '${raw}'`);
      }
      return n;
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') {
        return raw === 'true';
      }
      throw new PolicyError(`${dotted}: expected true or false, got '${raw}'`);
    case 'stringOrNull':
      return raw === 'null' ? null : raw;
    case 'stringList':
      if (raw === '' || raw === '[]') {
        return [];
      }
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    default:
      throw new PolicyError(`${dotted}: internal spec error`);
  }
}

function setAt(obj, dotted, value) {
  const parts = dotted.split('.');
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) {
      node[part] = {};
    }
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

// Record the trust increase as an ADR via the existing decision mechanism
// (verity adr → docs/adr/NNNN-slug.md), with the template placeholders filled in.
function trustAdr(cwd, from, to) {
  const rec = adr.create(cwd, `Raise autonomy review trust to ${to}`, { status: 'Accepted' });
  const body = fs
    .readFileSync(rec.path, 'utf8')
    .replace(
      '(Why is this decision needed? What forces are at play?)',
      `\`verity autonomy set review.trust ${to} --confirm\` was run. Raising the trust ladder expands the reviewer's autonomous merge authority and must be an auditable decision (verity-autonomy-technical-sketch.md §3.2).`,
    )
    .replace(
      '(What did we decide?)',
      `Raise \`review.trust\` from ${from} to ${to} in \`.verity/autonomy.yml\` (0 = none, 1 = low-risk auto-merge, 2 = full).`,
    );
  fs.writeFileSync(rec.path, body);
  return { number: rec.number, path: rec.path };
}

function setValue(cwd, dotted, rawValue, flags = {}) {
  if (!dotted || rawValue === undefined || rawValue === true) {
    throw new PolicyError('usage: verity autonomy set <path> <value> [--confirm]');
  }
  const spec = specAt(dotted);
  if (spec === null) {
    throw new PolicyError(`unknown policy key: ${dotted}`);
  }
  if (spec.type === 'map') {
    throw new PolicyError(`${dotted} is a section, not a settable value`);
  }
  const value = coerce(spec, String(rawValue), dotted);

  // Trust ladder guard: raising review.trust is a deliberate, confirmed, ADR'd act.
  let trustRaise = null;
  if (dotted === 'review.trust') {
    const current = loadPolicy(cwd).review.trust;
    if (value > current) {
      if (!flags.confirm) {
        throw new PolicyError(
          `raising review.trust (${current} → ${value}) expands autonomous merge authority — re-run with --confirm to record the decision`,
        );
      }
      trustRaise = { from: current, to: value };
    }
  }

  const user = readUserPolicy(cwd);
  setAt(user.data, dotted, value);
  const merged = deepMerge(clone(DEFAULTS), user.data);
  const errors = validatePolicy(merged);
  if (errors.length > 0) {
    throw new PolicyError(`refusing to write invalid policy: ${errors.join('; ')}`);
  }
  const file = writeUserPolicy(cwd, user.data);
  const adrRecord = trustRaise === null ? null : trustAdr(cwd, trustRaise.from, trustRaise.to);
  return { ok: true, key: dotted, value, path: file, adr: adrRecord, raw: `${dotted}=${value}` };
}

// Stage 26 (ADR-0011): the roles the WORKER can dispatch — P4 synthesizes
// 'plan' (worker/index.cjs), the dependency engine plans 'build'/'review'
// (next.cjs). `validate` cross-checks THIS set because "valid" is a statement
// about what the worker will do with the policy, and the canary caught it
// blessing a codex policy every one of these dispatches then refused.
const WORKER_DISPATCH_ROLES = ['build', 'plan', 'review'];

// The validate-time half of the capability honesty rule. The DISPATCH gate
// (agents/policy.cjs assertEnforceable, exit 30 `unenforceable-policy`) is the
// authority; this check exists so `verity autonomy validate` never contradicts
// it — a codex policy whose worker-dispatchable roles declare a restriction no
// mechanism enforces, without the operator's acknowledgement, is flagged HERE
// instead of discovered one refused dispatch at a time. Returns error strings
// in validatePolicy's format.
function enforcementGapErrors(cwd, policy) {
  const agent = policy.agent;
  if (!isPlainObject(agent) || agent.provider !== 'codex') {
    return []; // claude restrictions are enforced by its own harness allowlist
  }
  const acknowledged = Array.isArray(agent.acknowledged_enforcement_gaps)
    ? agent.acknowledged_enforcement_gaps
    : [];
  // Lazy requires, same as doctor.cjs: only this verb needs the role-policy
  // machinery, and the module's zero-heavy-import load path stays unchanged.
  const { resolveRole } = require('./agent-exec.cjs');
  const rolePolicy = require('./agents/policy.cjs');
  const byGap = new Map();
  for (const role of WORKER_DISPATCH_ROLES) {
    const resolved = resolveRole(cwd, role);
    if (resolved === null) {
      continue;
    }
    let loaded;
    try {
      loaded = rolePolicy.loadPolicy(resolved.permissionsFile);
    } catch {
      // A missing/invalid role policy is the dispatch path's own fail-closed
      // refusal (exit 30 missing-policy/bad-policy) — not this check's claim.
      continue;
    }
    for (const gap of rolePolicy.enforcementGaps(loaded)) {
      if (acknowledged.includes(gap)) {
        continue;
      }
      if (!byGap.has(gap)) {
        byGap.set(gap, []);
      }
      byGap.get(gap).push(role);
    }
  }
  return [...byGap.keys()].sort().map((gap) => {
    const roles = byGap.get(gap).sort().join(', ');
    return `agent.acknowledged_enforcement_gaps: role(s) ${roles} declare ${gap}: false, which NO mechanism enforces on codex — the worker would refuse every such dispatch (exit 30 unenforceable-policy) rather than appear to enforce it (ADR-0011); acknowledge the gap explicitly with agent.acknowledged_enforcement_gaps: [${gap}] to run anyway, with the gap recorded in each run's result`;
  });
}

function validateFile(cwd) {
  const user = readUserPolicy(cwd); // PolicyError(+line) on malformed YAML → exit 20
  const merged = deepMerge(clone(DEFAULTS), user.data);
  const errors = validatePolicy(merged);
  // The honesty cross-check runs only on a structurally valid policy — a
  // schema violation is already a refusal, and gap analysis of a malformed
  // agent block would be noise on top of it.
  if (errors.length === 0) {
    errors.push(...enforcementGapErrors(cwd, merged));
  }
  if (errors.length > 0) {
    throw new PolicyError(`invalid autonomy policy (${user.path}): ${errors.join('; ')}`);
  }
  return { valid: true, path: user.path, exists: user.exists, raw: 'valid' };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'show') {
    return loadPolicy(cwd); // the EFFECTIVE policy object, nothing else (pipe-safe with --json)
  }
  if (verb === 'set') {
    return setValue(cwd, args[1], args[2], flags);
  }
  if (verb === 'validate') {
    return validateFile(cwd);
  }
  throw new Error(`unknown autonomy verb: ${verb || '(none)'} — use show|set|validate`);
}

module.exports = {
  DEFAULTS,
  FORCED_GATES,
  FORCED_PROTECTED_PATHS,
  WORKER_DISABLED_MESSAGE,
  PolicyError,
  policyPath,
  parseYaml,
  toYaml,
  validatePolicy,
  enforceInvariants,
  loadPolicy,
  setValue,
  dispatch,
};
