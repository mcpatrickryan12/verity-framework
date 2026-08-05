// OpenAI Codex CLI provider driver (ADR-0005, stage 8) — the ONLY module that
// knows the Codex wire format. Mirrors the claude.cjs reference interface;
// agent-exec.cjs stays a runtime-neutral coordinator and reaches this driver
// through the ./index.cjs registry, only on an explicit `--agent codex`
// (the default agent remains claude — worker selection is stage 9).
//
// Invocation shape (codex-support.md §9.4; ADR-0007 explicit-config rule;
// stage 10 CDX-002/003 realignment to the documented CLI; stage 15 #34 removed
// --output-schema — see buildArgv):
//   codex exec --json --sandbox <from policy> --output-last-message <file>
//     --cd <repo root>
//     -c approval_policy="never" [--ignore-user-config] [--ignore-rules] -
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
// The required-feature matrix (stage 12) — the evidence the version pin is
// DERIVED from, shared with doctor.cjs so a diagnosis can name the feature that
// motivates the minimum instead of just quoting a number.
const features = require('./codex-features.cjs');
const gitLifecycle = require('./git-lifecycle.cjs');
const invariants = require('./invariants.cjs');
const stateSnapshotLib = require('./state-snapshot.cjs');
const {
  applyOverrides: applyPolicyOverrides,
  assertEnforceable,
  loadPolicy,
} = require('./policy.cjs');
const workspace = require('./workspace.cjs');

// Version floor from the IN-SUBTREE engine-meta.json (stage 35), not a top-level
// `require('../../../../package.json')` above the engine root (which crashed a
// copied engine at load). engine-meta.json is stamped from package.json at
// install/copy time, so the operator-visible knob is still package.json.
const engineMeta = require('../engine-meta.cjs');

// FEATURE-DERIVED, not historical (stage 12). The pin is the highest VERIFIED
// row of the required-feature matrix (./codex-features.cjs) — the newest release
// where a feature this driver depends on was actually observed working. It is
// conservative BY EVIDENCE: the spike never bisected backwards, so older
// releases may work fine; Verity just does not claim what it has not seen. The
// package.json key stays the operator-visible knob; the matrix is the reason it
// holds the value it does, and a test pins the two together so neither drifts.
// `features.verifiedFloor()` stays the honest fallback for a stale pre-fix copy
// with no engine-meta.json.
const MIN_CODEX_VERSION = engineMeta.load().verity?.codexMinVersion || features.verifiedFloor();
const DEFAULT_BINARY = 'codex';

// Deterministic tool-call counting (codex-support.md §9.6): count the START of
// each actionable tool item exactly once — never start + completion as two.
// Items that only ever appear as completions (agent_message, reasoning) are
// not tool calls and are never counted.
const TOOL_ITEM_TYPES = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'];

// --- provider failure text (stage 15, issue #35) ---------------------------------
// Every provider failure reaches the result through failureText(). It replaced
// a firstLine() that took the first PHYSICAL line of the provider's message —
// fine for the one-line messages the doc-derived fixtures carry, useless for
// what the real API actually returns. The 400 that broke every codex run
// (issue #34) is pretty-printed JSON whose first line is `{`, so the emitted
// result was literally `error: "{"`: the defect breaking the path reported
// itself as a lone brace, with nothing an operator could act on.
//
// Rules: a message that parses as JSON surfaces its meaningful field
// (`.error.message`, else `.message`) — and again if THAT is itself JSON,
// which the real `error` event does; anything else collapses whitespace into
// one bounded line. A lone punctuation character is never emitted.
const FAILURE_TEXT_MAX = 400;
// How many times a message-in-a-message may be unwrapped. The real payload
// needs one hop; the bound just stops a pathological transcript from looping.
const FAILURE_UNWRAP_LIMIT = 3;

function collapse(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bounded(text) {
  return text.length > FAILURE_TEXT_MAX ? `${text.slice(0, FAILURE_TEXT_MAX)}…` : text;
}

function failureText(raw) {
  let text = raw;
  for (let hop = 0; hop < FAILURE_UNWRAP_LIMIT; hop += 1) {
    const obj = wholeJsonObject(text);
    if (obj === null) {
      break;
    }
    const inner =
      (isPlainObject(obj.error) && typeof obj.error.message === 'string' && obj.error.message) ||
      (typeof obj.message === 'string' && obj.message) ||
      null;
    if (inner === null) {
      break; // JSON without a message field — the collapsed blob is still legible
    }
    text = inner;
  }
  const flat = bounded(collapse(text));
  // Fail-safe on the never-a-lone-brace rule: if unwrapping produced something
  // with no substance, fall back to the whole original message rather than
  // emitting punctuation as an error.
  if (/[A-Za-z0-9]/.test(flat)) {
    return flat;
  }
  const whole = bounded(collapse(raw));
  return /[A-Za-z0-9]/.test(whole) ? whole : 'provider failure with no message text';
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
    // Name the FEATURE, not just the number (stage 12): "upgrade" without a
    // reason is the kind of pin nobody can audit — which is how 0.42.0 survived
    // three stages. Same rationale string `verity doctor --agent codex` prints.
    return {
      ok: false,
      slug: 'version-too-old',
      error: `Codex CLI ${check.version} is below the pinned minimum ${MIN_CODEX_VERSION} — upgrade the Codex CLI (${features.pinMotivation()})`,
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

// --- ADR-0011 tier-1 containment: policy DATA -----------------------------------
// These four tables used to be projected into a generated JSON denial document
// handed to Codex as a `-c` config key. The stage-11 spike proved that
// mechanism enforces NOTHING: the key is not one Codex defines (unknown `-c`
// keys are silently absorbed), and real execpolicy denials cannot match the
// `/bin/bash -lc '<cmd>'` form Codex actually runs commands as
// (docs/dev/codex-enforcement-spike-0.146.0.md F3). The generation is DELETED —
// shipping denials that never fire is security theater (ADR-0011).
//
// The tables survive as policy DATA for the mechanisms that do bind:
//   CREDENTIAL_READ_DENIALS   the credential-shaped locations no capability
//                             grants — documentation for the childEnv passlist
//                             below and the canary's read-denial probes; the
//                             tier-2 shaped workspace (stage 14) makes their
//                             absence topological.
//   PROTECTED_WRITE_PATHS     the roots the post-run invariant checker
//                             snapshots and reverts (agents/invariants.cjs).
//   MERGE_AUTHORITY_DENIALS   T13: merge authority lives in the worker, never
//   CAPABILITY_COMMAND_DENIALS  in a role. Neither is a Codex-side denial any
//                             more — merge authority is enforced by the
//                             worker's own gate plus the absence of a GitHub
//                             credential (childEnv), and the command families
//                             document which capability each credential set
//                             belongs to.
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

// --- credential stripping (ADR-0011 layer 2 — a PRIMARY mechanism) -------------
// Before stage 11 `execute()` passed no `env` to spawnSync, so the Codex child
// inherited the FULL parent environment — every token the operator (or CI) had
// exported. Nothing about that was visible in the policy. The child environment
// is now CONSTRUCTED: an enumerated baseline plus, per capability, exactly the
// credentials that capability grants. Everything else — including anything
// secret-shaped we have never heard of — is simply not there, and an absent
// credential cannot be misused by any command, wrapped or not.
//
// Baseline passlist. Every entry is here because a shell/git/node/codex
// toolchain cannot function without it; nothing is here "just in case".
const BASELINE_ENV_PASSLIST = [
  'PATH', // resolve the codex binary and everything the model runs
  'HOME', // git config, ~/.codex auth, tool caches
  'USER', // some tools refuse to run without an identity
  'LOGNAME', // ditto (git falls back to it for the author name)
  'SHELL', // Codex wraps model commands as `/bin/bash -lc` and reads this
  'LANG', // text encoding — wrong value corrupts non-ASCII diffs
  'LC_ALL', // ditto (overrides LANG)
  'LC_CTYPE', // ditto (macOS defaults set only this)
  'TERM', // terminal capabilities; absent TERM makes some tools hang
  'TMPDIR', // where the child may write scratch files
  'TMP', // TMPDIR's name on some platforms
  'TEMP', // TMPDIR's name on some platforms
  'CODEX_HOME', // Codex's own config/auth root (spike F5 — it carries auth)
  'XDG_CONFIG_HOME', // config discovery for git/gh/node tooling
  'XDG_CACHE_HOME', // cache location; absent, tools scatter into $HOME
  'XDG_DATA_HOME', // data location, same reason
  'SSL_CERT_FILE', // TLS trust store — without it the model API call fails
  'SSL_CERT_DIR', // ditto
  'NODE_EXTRA_CA_CERTS', // corporate TLS interception, same reason
  'HTTP_PROXY', // egress path to the model API on proxied networks
  'HTTPS_PROXY', // ditto
  'NO_PROXY', // ditto (exclusions)
  'http_proxy', // the lowercase spellings are what curl/git actually read
  'https_proxy', // ditto
  'no_proxy', // ditto
  'ALL_PROXY', // ditto
  'all_proxy', // ditto
  // The Codex runtime's OWN credential. The child IS Codex: stripping this
  // would refuse every run for API-key (rather than ChatGPT-login) users. It
  // grants model access, which the role has by definition — it grants nothing
  // about the repository, a remote, or any external system.
  'OPENAI_API_KEY',
];

// Credentials, keyed by the capability that grants them. A capability the role
// does not hold means the whole group is absent from the child environment.
const CAPABILITY_CREDENTIALS = {
  // GitHub write authority: without these `gh` cannot mutate anything on
  // GitHub, whatever command the model types (or wraps in a shell).
  github_write: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'],
  // Deploy / publish authority: cloud, registry, and PaaS credentials.
  deploy: [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TENANT_ID',
    'CLOUDFLARE_API_TOKEN',
    'DIGITALOCEAN_ACCESS_TOKEN',
    'DOCKER_PASSWORD',
    'DOCKER_USERNAME',
    'FLY_API_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'HEROKU_API_KEY',
    'NETLIFY_AUTH_TOKEN',
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'RENDER_API_KEY',
    'VERCEL_TOKEN',
  ],
};

// Build the child environment from the passlist + the capability-granted
// credential groups. Nothing else survives: this is an ALLOWLIST, so a
// credential Verity has never heard of is dropped by construction rather than
// by pattern-matching a name we guessed.
function childEnv(policy, parentEnv = process.env) {
  const caps = policy.capabilities || {};
  const allowed = [...BASELINE_ENV_PASSLIST];
  for (const [capability, names] of Object.entries(CAPABILITY_CREDENTIALS)) {
    if (caps[capability] === true) {
      allowed.push(...names);
    }
  }
  const env = {};
  for (const name of allowed) {
    if (parentEnv[name] !== undefined) {
      env[name] = parentEnv[name];
    }
  }
  return env;
}

// Additive contract annotations (agent-result v1.x optional fields) merged
// into the emitted result object by the coordinator. Claude has no annotate()
// so its output stays byte-identical.
//
// Called AFTER the run (stage 15, issue #36). It used to run before the spawn,
// which meant `final_message_path` was computed before anything could have
// written it: every failed run advertised a <role>.final.json that did not
// exist (the real canary observed only <role>.codex.jsonl on disk). The field
// is now emitted ONLY when the file is really there — explicitly permitted by
// contracts/agent-result.md v1, which lists these as additive OPTIONAL fields
// whose ABSENCE consumers must tolerate. `transcript_path` stays
// unconditional: the driver streams stdout into it, so it always exists and
// was always accurate.
function annotate({ role, logDir }) {
  const finalMessagePath = path.join(logDir, finalMessageFilename(role));
  return {
    provider: 'codex',
    timed_out: false,
    transcript_path: path.join(logDir, transcriptFilename(role)),
    ...(fs.existsSync(finalMessagePath) ? { final_message_path: finalMessagePath } : {}),
  };
}

// Render the role for headless Codex: the ADR-0002 pipeline with the stage-6
// codex host pass, frontmatter stripped, role args resolved (the codex pass
// rewrites $ARGUMENTS to its named placeholder — headless execution resolves
// that placeholder here, exactly as agent-exec resolves $ARGUMENTS for
// claude), then the shared headless result-contract footer.
//
// `ctx.git` (stage 17, ADR-0012) is the Verity-performed-git plan when there is
// one. It flips the OPTION-KEYED `verityPerformsGit` preamble block on, so the
// role is TOLD THE TRUTH about this run: the branch already exists, git is
// Verity's job, and its job is to make file changes. The block is keyed on an
// install option rather than on the host pass on purpose — an INSTALLED skill
// is invoked interactively with no Verity orchestrating anything, so the claim
// would be false there; keying it on the option also leaves every render golden
// fixture (this host's included) byte-identical. Absent ctx.git the render is
// exactly what it was before this stage.
//
// `ctx.state` (stage 24, ADR-0013) is the same mechanism one layer up: the
// Verity-gathered GitHub state snapshot, when the dispatcher provided one. It
// flips the `verityPerformsGitHub` preamble on — "GitHub is Verity's job on
// this run": the facts the role's state reads would have fetched are rendered
// in, and GitHub writes are declared in the result marker instead of
// performed. Absent ctx.state the render is exactly what it was before.
function renderPrompt(file, roleArgs, ctx = {}) {
  const git = ctx.git === undefined || ctx.git === null ? null : ctx.git;
  const state = ctx.state === undefined || ctx.state === null ? null : ctx.state;
  const options = {
    ...(git === null ? {} : { verityPerformsGit: true, branch: git.branch }),
    ...(state === null
      ? {}
      : { verityPerformsGitHub: true, stateSnapshot: stateSnapshotLib.renderFacts(state) }),
  };
  let text = renderRole(file, options, 'codex');
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
// --max-turns, --output-format stream-json) never appear. The stage-9
// generated-denial-document `-c` branch is GONE (stage 11, ADR-0011 — it set a key
// Codex does not define); `--model` remains omitted-in, so the argv without it
// is unchanged.
//
// --output-schema is GONE too (stage 15, issue #34 — P0). Stage 10 wired it as
// a "belt" on top of validateRoleOutcome, verified only by a stub. The real
// canary (codex-cli 0.146.0, 2026-07-31) proved it kills EVERY run: our
// schemas/agent-result.schema.json uses `allOf`, and the API answers HTTP 400
// `invalid_json_schema: … 'allOf' is not permitted` → turn.failed, zero tokens,
// zero tool calls. A/B on the real binary isolated the flag as the sole cause.
// Result handling is back on the proven path — the --output-last-message file
// parsed as structured JSON when present, else the RESULT_CONTRACT marker —
// and NOTHING about validation weakens: validateRoleOutcome was always the
// trust boundary, and the schema stays published as the contract artifact it
// mirrors. (A flattened, allOf-free CLI-side schema is a deferred follow-up,
// deliberately not attempted here.)
function buildArgv({ policy, finalMessagePath, cwd, model }) {
  const argv = [
    'exec',
    '--json',
    '--sandbox',
    policy.codex.sandbox,
    '--output-last-message',
    finalMessagePath,
    '--cd',
    cwd,
    // Spike-VERIFIED against codex-cli 0.146.0 (F6): `-c approval_policy=…`
    // is accepted and honored by `codex exec` — the real run executed its
    // commands with no prompt. The stage-10 SPIKE-UNVERIFIED marker is
    // resolved; the canary re-verifies it on each version bump.
    '-c',
    `approval_policy=${JSON.stringify(policy.codex.approval)}`,
  ];
  // Documented FLAGS, not `-c` keys (stage 10, CDX-002/003): the old
  // `-c ignore_user_config=true` set a nonexistent config key that Codex
  // silently absorbed — NO isolation. The `-c` spelling must never return
  // (regression-pinned); `ignore_rules` was validated but never emitted at
  // all until this stage.
  if (policy.codex.ignore_user_config) {
    argv.push('--ignore-user-config');
  }
  if (policy.codex.ignore_rules) {
    argv.push('--ignore-rules');
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
  const argv = buildArgv({ policy, finalMessagePath, cwd, model });
  const fd = fs.openSync(transcript, 'w');
  try {
    return spawnSync(bin, argv, {
      cwd,
      input: prompt,
      // ADR-0011 layer 2: the child environment is CONSTRUCTED, never
      // inherited. Passing no `env` here (what stage 8-10 did) handed the
      // model every credential the parent process held.
      env: childEnv(policy),
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

// --- ADR-0011 driver hooks the coordinator drives -------------------------------
// A provider OPTS IN to tier-1 containment by exporting these. Claude does not:
// its write-time restriction is enforced by its own harness allowlist, so its
// path through agent-exec is byte-identical to before this stage.

// Capability honesty (ADR-0011): refuse the run rather than appear to enforce a
// restriction no mechanism binds. Returns the acknowledgements that actually
// applied so the coordinator can surface them in the result.
function checkEnforceable(policyBag, { acknowledged = [] } = {}) {
  return assertEnforceable(policyBag.policy, acknowledged);
}

// Pre-run snapshot (protected roots + refs + worktree status). The protected
// roots come from THIS driver's policy data, so the checker itself stays
// provider-neutral.
function captureInvariants({ cwd }) {
  return invariants.capture(cwd, { protectedPaths: PROTECTED_WRITE_PATHS });
}

// Post-run: diff, hard-revert what is safely revertible, and hand the
// coordinator a loud one-line error (or null on a clean run). Under tier 2
// this runs against the REAL checkout AFTER merge-back — a cross-check that
// the gate let nothing through, never the primary guarantee.
function checkInvariants(before, policyBag) {
  return invariants.enforce(before, policyBag.policy);
}

// --- ADR-0011 TIER 2 hooks (stage 14) -------------------------------------------
// Declaring these is how a provider OPTS IN to the disposable shaped workspace
// + gated merge-back. Claude declares neither, so `--containment-tier` is
// rejected for it and its coordinator path is unchanged. The protected roots
// come from THIS driver's policy data, so agents/workspace.cjs stays
// provider-neutral.

// Materialize the throwaway workspace the role actually runs in (`--cd` points
// at it). Throws AgentExecError (exit 30 `workspace-unavailable`) rather than
// degrading to the real checkout — tier 2 fails closed.
function prepareWorkspace(policyBag, { cwd, dir, keep }) {
  return workspace.prepare({
    cwd,
    dir,
    keep,
    policy: policyBag.policy,
    protectedPaths: PROTECTED_WRITE_PATHS,
  });
}

// Decide — deterministically, never with the model's help — what propagates
// from the workspace back into the real repository.
function mergeWorkspace(ws, policyBag) {
  return workspace.merge(ws, policyBag.policy);
}

// Dispose of the workspace on every exit path (retained only under the
// explicit debug flag). Never throws.
function disposeWorkspace(ws) {
  return workspace.cleanup(ws);
}

// --- ADR-0012 Verity-performed stage lifecycle git (stage 17) --------------------
// Declaring these three is how a provider says "my runtime cannot let the model
// write under `.git`, so Verity performs the stage lifecycle git for it". The
// reference driver declares none of them — its harness performs its own git
// (ADR-0012 records the asymmetry deliberately) — so its coordinator path, its
// rendered prompts, and its result object are all unchanged.
//
// The probes behind this (docs/dev/codex-headless-canary-results-0.146.0.md):
// under `workspace-write`, `git status` is rc=0 but `git checkout -b` and
// `git commit` are rc=128 "Read-only file system". We do NOT widen that — see
// agents/git-lifecycle.cjs on why granting `.git` writes is a REJECTED option.

// Does this run need Verity-performed git, and on which branch? null = no
// (nothing about the run changes).
function planGit(policyBag, ctx) {
  return gitLifecycle.plan({ ...ctx, policy: policyBag.policy });
}

// Fail-closed provision check — git READS only, so a refusal mutates nothing.
function assertGitProvidable(plan, cwd) {
  return gitLifecycle.assertProvidable(cwd, plan);
}

// Create/check out the stage branch, in Verity's process, BEFORE dispatch.
function beginGit(plan, cwd) {
  return gitLifecycle.begin(cwd, plan);
}

// Commit the role's file changes on that branch, push, and open the PR.
function finishGit(started, cwd, opts) {
  return gitLifecycle.finish(cwd, started, opts);
}

// The report shape for a run that never reached the commit (failed, gated, or
// containment-rejected): the branch still exists and the reason is named.
function skipGit(started, reason) {
  return gitLifecycle.skipped(started, reason);
}

// Put the checkout back where the run found it. Never throws — a failed restore
// is data the coordinator reports, not a second failure.
function restoreGit(started, cwd) {
  return gitLifecycle.restore(cwd, started);
}

// Item-kind discriminator (stage 10, CDX-004): real Codex JSONL carries an
// item's kind at `item.type` (e.g. {"type":"item.completed","item":{"id":
// "item_0","type":"agent_message","text":…}}); the pre-stage-10 stub shape
// used `item.item_type`, retained here as an explicitly-tested legacy
// fallback. This helper reads the NESTED item object ONLY — the event-level
// `type` field ("item.completed" etc.) is a different axis and must never be
// consulted for the item kind.
function itemKind(item) {
  if (typeof item.type === 'string') {
    return item.type;
  }
  if (typeof item.item_type === 'string') {
    return item.item_type;
  }
  return null;
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
      if (itemKind(obj.item) === 'agent_message' && typeof obj.item.text === 'string') {
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
    if (TOOL_ITEM_TYPES.includes(itemKind(obj.item))) {
      count += 1;
    }
  }
  return count;
}

// Fold Codex usage into the frozen v1 totals. cached/reasoning counts are
// SUBSETS of input/output (OpenAI usage semantics) — so folding is the identity
// on the two headline fields, and the raw detail travels in the additive
// usage_detail block.
// est_usd is ALWAYS null: Codex reports no exact per-run dollar cost, and
// null means UNKNOWN — writing 0 would tell the budget breaker the run was
// free (ADR-0008 contract violation).
//
// The allowlist is what a REAL turn.completed event carries (spike F7, issue
// #29):
//   {"input_tokens":47180,"cached_input_tokens":43264,"cache_write_input_tokens":0,
//    "output_tokens":165,"reasoning_output_tokens":0}
// — note `cache_write_input_tokens`, which the pre-stage-12 allowlist dropped
// on the floor, and NO `total_tokens` at all. `total_tokens` stays listed
// because the allowlist copies only what is present: a documented/older shape
// that carries it still travels, and a real event that omits it simply has no
// such key. Nothing here touches tokens.in/out, so the headline numbers (and
// every budget decision built on them) are unchanged either way.
function normalizeUsage(final) {
  const usage = isPlainObject(final.usage) ? final.usage : null;
  if (usage === null) {
    return { tokens: { in: 0, out: 0 }, est_usd: null };
  }
  const detail = {};
  for (const key of [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
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
            `inconsistent result: role reported '${structured.outcome}' but the transcript recorded a failure (${failureText(final.failure)})`,
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
    return { outcome: 'failed', artifacts: {}, error: failureText(final.failure) };
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
  BASELINE_ENV_PASSLIST,
  CAPABILITY_COMMAND_DENIALS,
  CAPABILITY_CREDENTIALS,
  // The required-feature matrix, re-exported so the pin's evidence is reachable
  // from the driver surface itself (docs/dev/codex-feature-matrix.md renders it).
  CODEX_FEATURES: features.CODEX_FEATURES,
  CREDENTIAL_READ_DENIALS,
  MERGE_AUTHORITY_DENIALS,
  MIN_CODEX_VERSION,
  PROTECTED_WRITE_PATHS,
  TOOL_ITEM_TYPES,
  supportsMaxTurns: false,
  // Stage 24 (ADR-0013): this driver's runtime cannot reach GitHub, so it
  // consumes a Verity-gathered state snapshot in its rendered prompt. The
  // reference driver does not declare this — its harness performs its own
  // GitHub reads, and agent-exec REJECTS the flag for it (never a silently
  // ignored knob).
  supportsStateSnapshot: true,
  annotate,
  applyOverrides,
  assertGitProvidable,
  beginGit,
  buildArgv,
  captureInvariants,
  checkEnforceable,
  checkInvariants,
  checkVersion,
  childEnv,
  countToolCalls,
  disposeWorkspace,
  execute,
  finalMessageFilename,
  finishGit,
  mergeWorkspace,
  planGit,
  restoreGit,
  skipGit,
  itemKind,
  normalizeResult,
  normalizeUsage,
  parseTranscript,
  prepareWorkspace,
  readPolicy,
  renderPrompt,
  resolveBinary,
  transcriptFilename,
};
