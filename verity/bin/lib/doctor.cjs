// `verity doctor` — host-dependency preflight (stage 1; ADR-0001, RFC-V01 §04).
// One command reports the health of every external binary Verity leans on:
// present on PATH, version parses, version ≥ the configured minimum, and
// auth/daemon state where applicable (`gh auth status`).
//
// Output contract (additive-only once shipped): JSON by default — an ARRAY of
// per-dependency checks shaped {name, present, version, ok, detail} (plus
// `optional: true` on optional rows). `--quiet` = exit-code-only mode: nothing
// on stdout, exit 0 when every check is ok, 1 otherwise (mapped by
// exitCodeFor() in the dispatcher).
//
// The dependency registry is DATA, not code: one table row per binary (name,
// binary, version args, min-version key under package.json `verity.*`,
// optional auth-check command, optional flag). Adding `knowing` later
// (Stage 4) is a table row, not new logic.
//
// Optional-dependency semantics (ADR-0001 graceful absence): a registered-but-
// optional dependency that is absent reports {ok: true, present: false,
// optional: true} — absence of an optional dep is NEVER a failure. Anything
// else wrong with an optional dep (present but too old / failing its auth
// check) still fails, because a broken install is not graceful absence.
//
// checkBinary() is the shared low-level probe, extracted from agent-exec's
// checkAgentVersion() so version-parse logic lives in exactly one place —
// agent-exec (and, opportunistically, the worker) call it; doctor's report
// rows are built on top of it. Doctor itself degrades informatively, never
// fatally: every probe failure becomes a report row, not a thrown error.
//
// Stage 9 (`--agent claude|codex`, codex-support.md §10): doctor is
// runtime-selective — it checks the SELECTED runtime only, so a Codex-only
// machine can be green. Selection precedence without the flag: explicit
// `--agent` → `.verity/autonomy.yml` `agent.provider` (when the file names
// one) → install-state `harness` (~/.claude / ~/.agents) → the legacy default
// claude. The chosen runtime AND its source are printed to stderr (stdout
// stays the pipe-safe JSON array). Codex rows add environment checks beyond
// binaries: skill discovery under ~/.agents/skills, the engine fallback path,
// and stale install state — each failure carries a remediation command.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Version floors come from the IN-SUBTREE engine-meta.json (stage 35), not a
// top-level `require('../../../package.json')` that resolved above the engine
// root and crashed every command from a copied engine. checkDependency's
// `opts.pkg` seam is unchanged — this only swaps where the default reads from.
const PKG = require('./engine-meta.cjs').load();

// The Codex required-feature matrix (stage 12). Doctor names the FEATURE that
// motivates `verity.codexMinVersion` in its too-old diagnosis, so an operator
// told to upgrade also learns what the pin is buying. The matrix module is a
// leaf on purpose: the codex driver requires doctor (for checkBinary), so
// doctor must never require the driver back.
const codexFeatures = require('./agents/codex-features.cjs');

// --- shared version probe (used by agent-exec.cjs) ----------------------------

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

// "2.1.170 (Claude Code)" → [2, 1, 170]; null when no x.y.z is present.
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

// Probe one binary: run `<bin> <versionArgs>`, parse an x.y.z triple from
// stdout, compare against an optional minimum. Never throws. Returns:
//   { present, version, ok, why, output }
//   - present  the binary ran the version command successfully (exit 0)
//   - version  'x.y.z' string, or null when no triple was parseable
//   - ok       present, version parsed, and ≥ minVersion (when one is given)
//   - why      failure discriminator: 'missing' | 'unparsable' | 'too-old' | null
//   - output   first non-empty stdout line (for 'missing': the spawn error
//              code or exit status — whichever explains the failure)
// Test seam: opts.exec replaces spawnSync (same convention as agent-exec).
function checkBinary(bin, opts = {}) {
  const exec = opts.exec || spawnSync;
  const versionArgs = opts.versionArgs || ['--version'];
  const res = exec(bin, versionArgs, { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.code || res.error.message : `exit ${res.status}`;
    return { present: false, version: null, ok: false, why: 'missing', output: why };
  }
  const found = parseVersion(res.stdout);
  if (!found) {
    return {
      present: true,
      version: null,
      ok: false,
      why: 'unparsable',
      output: firstLine(res.stdout) || '(empty)',
    };
  }
  const version = found.join('.');
  const min = opts.minVersion ? parseVersion(opts.minVersion) : null;
  if (min && compareVersions(found, min) < 0) {
    return { present: true, version, ok: false, why: 'too-old', output: firstLine(res.stdout) };
  }
  return { present: true, version, ok: true, why: null, output: firstLine(res.stdout) };
}

// --- dependency registry (data, not code) -------------------------------------

// One row per host dependency:
//   name          report row name
//   binary        executable looked up on PATH
//   versionArgs   argv for the version probe (default ['--version'])
//   minVersionKey key under package.json `verity.*` holding the pinned minimum
//                 (absent = any parseable version is fine)
//   authCheck     argv for an auth/daemon-state probe, run only when the
//                 version check passes (e.g. `gh auth status`)
//   optional      absent-is-ok (ADR-0001 graceful absence)
//   remedies      optional { missing, 'too-old', auth } remediation commands
//                 appended to the failing detail as "Run: <cmd>" (stage 9 —
//                 rows without it are byte-identical to their stage-1 output)
//   minVersionMotivation
//                 optional one-line rationale appended to the TOO-OLD detail,
//                 naming the required feature(s) the minimum is derived from
//                 (stage 12 — rows without it stay byte-identical)
const DEPENDENCIES = [
  { name: 'git', binary: 'git', versionArgs: ['--version'] },
  { name: 'gh', binary: 'gh', versionArgs: ['--version'], authCheck: ['auth', 'status'] },
  {
    name: 'claude',
    binary: 'claude',
    versionArgs: ['--version'],
    minVersionKey: 'claudeCodeMinVersion',
  },
  // knowing (Stage 4 spike; optional — ADR-0001 graceful absence). The real
  // binary (github.com/blackwell-systems/knowing) rejects `--version`; the
  // probe is `knowing version` → "knowing x.y.z (commit: …)". Health probe is
  // `knowing stats` (exit 0 iff the binary runs and can open its store) — NOT
  // `daemon status`, which exits 1 when the daemon is merely not running, and
  // a stopped daemon is normal for on-demand CLI/stdio-MCP use, not a broken
  // install.
  {
    name: 'knowing',
    binary: 'knowing',
    versionArgs: ['version'],
    minVersionKey: 'knowingMinVersion',
    authCheck: ['stats'],
    optional: true,
  },
];

// The codex-selected registry (stage 9, codex-support.md §10.3): git + gh are
// runtime-neutral prerequisites; claude is deliberately ABSENT — a Codex-only
// machine must be green. Auth uses Codex's own status command as the oracle
// (credential files are never read, §9.1); every failure mode names its
// remediation command. The non-binary environment rows (skills, engine,
// install state) are built by codexEnvironmentChecks below.
const CODEX_DEPENDENCIES = [
  DEPENDENCIES[0], // git
  DEPENDENCIES[1], // gh (+ auth status)
  {
    name: 'codex',
    binary: 'codex',
    versionArgs: ['--version'],
    minVersionKey: 'codexMinVersion',
    // Stage 12: the pin is feature-derived, so the too-old diagnosis says which
    // features it is derived FROM. "codex 0.42.0 is too old" with no reason is
    // exactly the unauditable claim this stage removed.
    minVersionMotivation: codexFeatures.pinMotivation(),
    authCheck: ['login', 'status'],
    remedies: {
      missing: 'npm install -g @openai/codex',
      'too-old': 'npm install -g @openai/codex@latest',
      auth: 'codex login',
    },
  },
];

// The grok-selected registry (the CODEX_DEPENDENCIES pattern): git + gh are
// runtime-neutral prerequisites; claude and codex are deliberately ABSENT — a
// Grok-Build-only machine must be green. Grok Build documents no CLI auth
// status probe suitable for scripting (auth is browser-based on first launch),
// so the row is version-gated only; a signed-out binary surfaces at run time.
const GROK_DEPENDENCIES = [
  DEPENDENCIES[0], // git
  DEPENDENCIES[1], // gh (+ auth status)
  {
    name: 'grok',
    binary: 'grok',
    versionArgs: ['--version'],
    minVersionKey: 'grokBuildMinVersion',
    remedies: {
      missing: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      'too-old': 'curl -fsSL https://x.ai/cli/install.sh | bash',
    },
  },
];

// --- per-dependency report rows -----------------------------------------------

// One registry row → one report row {name, present, version, ok, detail}
// (+ optional). Never throws — every failure mode is a row that says why.
function checkDependency(dep, opts = {}) {
  const exec = opts.exec || spawnSync;
  const pkg = opts.pkg || PKG;
  const minVersion = dep.minVersionKey ? pkg.verity?.[dep.minVersionKey] || null : null;
  const probe = checkBinary(dep.binary, { exec, versionArgs: dep.versionArgs, minVersion });
  // Rows with a `remedies` table get the fix appended to a failing detail;
  // rows without one (all the pre-stage-9 registry) are byte-identical.
  const remedy = (why, detail) =>
    dep.remedies?.[why] ? `${detail} — Run: ${dep.remedies[why]}` : detail;
  const row = {
    name: dep.name,
    present: probe.present,
    version: probe.version,
    ok: probe.ok,
    detail: '',
  };
  if (dep.optional) {
    row.optional = true;
  }
  if (!probe.present) {
    if (dep.optional) {
      row.ok = true; // graceful absence: an absent optional dep is never a failure
      row.detail = `optional dependency not installed (${probe.output}) — skipped`;
    } else {
      row.detail = remedy(
        'missing',
        `${dep.binary} not runnable (${probe.output}) — is it installed and on PATH?`,
      );
    }
    return row;
  }
  if (probe.why === 'unparsable') {
    row.detail = `could not parse \`${dep.binary} ${(dep.versionArgs || ['--version']).join(' ')}\` output: ${probe.output}`;
    return row;
  }
  if (probe.why === 'too-old') {
    // The motivation clause sits BEFORE the remedy so the message reads
    // "too old — because X — Run: <fix>"; rows without one are unchanged.
    const why = dep.minVersionMotivation ? ` — ${dep.minVersionMotivation}` : '';
    row.detail = remedy(
      'too-old',
      `${dep.name} ${probe.version} is below the configured minimum ${minVersion} (package.json verity.${dep.minVersionKey})${why}`,
    );
    return row;
  }
  // Version check passed — run the auth/daemon-state probe when the row has one.
  if (dep.authCheck) {
    const label = `${dep.binary} ${dep.authCheck.join(' ')}`;
    const auth = exec(dep.binary, dep.authCheck, { encoding: 'utf8' });
    if (auth.error || auth.status !== 0) {
      const why = auth.error
        ? auth.error.code || auth.error.message
        : firstLine(auth.stderr) || firstLine(auth.stdout) || `exit ${auth.status}`;
      row.ok = false;
      row.detail = remedy(
        'auth',
        `${dep.name} ${probe.version} present but \`${label}\` failed: ${why}`,
      );
      return row;
    }
    row.detail = `${dep.name} ${probe.version} — \`${label}\` ok`;
    return row;
  }
  row.detail = `${dep.name} ${probe.version}`;
  return row;
}

// --- codex environment rows (stage 9) ------------------------------------------
// Beyond the binaries, a working Codex install needs the Verity pieces that
// `verity install --codex` writes: the verity-* skills under ~/.agents/skills,
// the engine internals the skills fall back to, and a matching install state.
// Each row reuses the {name, present, version, ok, detail} shape; every
// failing detail names its distinct diagnosis AND the remediation command.

// User-scoped Codex host root — mirrors install.cjs codexDir(): Codex
// documents no config-dir env var, so ~/.agents it is (opts.home is the seam).
function codexRoot(opts = {}) {
  return path.join(opts.home || os.homedir(), '.agents');
}

// How many verity-* skills a full install ships = the packaged role count.
function packagedRoleCount() {
  const dir = path.join(__dirname, '..', '..', '..', 'commands', 'verity');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function codexEnvironmentChecks(opts = {}) {
  const root = codexRoot(opts);
  const rows = [];

  // Skill discovery: verity-* directories carrying a SKILL.md.
  const skillsDir = path.join(root, 'skills');
  const expected = packagedRoleCount();
  let count = 0;
  try {
    count = fs
      .readdirSync(skillsDir)
      .filter(
        (n) => n.startsWith('verity-') && fs.existsSync(path.join(skillsDir, n, 'SKILL.md')),
      ).length;
  } catch {
    // no skills dir at all — count stays 0
  }
  rows.push({
    name: 'codex-skills',
    present: count > 0,
    version: null,
    ok: count === expected && expected > 0,
    detail:
      count === expected && expected > 0
        ? `${count}/${expected} verity-* skills discovered under ${skillsDir}`
        : `Verity skills missing: ${count}/${expected} verity-* skills under ${skillsDir} — Run: verity install --codex`,
  });

  // Engine fallback path: installed skills invoke this when `verity` is not
  // on PATH — skills without it discover fine and then cannot act.
  const engine = path.join(root, 'verity', 'bin', 'verity.cjs');
  const engineOk = fs.existsSync(engine);
  rows.push({
    name: 'codex-engine',
    present: engineOk,
    version: null,
    ok: engineOk,
    detail: engineOk
      ? `engine fallback present at ${engine}`
      : `engine internals missing (${engine}) — skills cannot reach the deterministic CLI — Run: verity install --codex`,
  });

  // Install state: written by installCodex; a missing file or a harness that
  // is not 'codex' means this ~/.agents tree was not (or is no longer) a
  // Verity Codex install — stale state, reinstall to reconcile.
  const stateFile = path.join(root, 'verity', 'install-options.json');
  let state = null;
  let stateDetail = `no Codex install state (${stateFile}) — Run: verity install --codex`;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    stateDetail =
      state.harness === 'codex'
        ? `install state ok (harness codex, ${stateFile})`
        : `stale install state: harness is '${state.harness}', expected 'codex' (${stateFile}) — Run: verity install --codex`;
  } catch {
    // missing/unparsable — stateDetail already says stale/missing
  }
  rows.push({
    name: 'codex-install-state',
    present: state !== null,
    version: null,
    ok: state !== null && state.harness === 'codex',
    detail: stateDetail,
  });

  return rows;
}

// The full report: one row per registry entry, always all of them (a broken
// dependency never hides the state of the others). The registry is selected
// by the runtime (stage 9): claude keeps the stage-1 registry byte-identical;
// codex checks the selected runtime ONLY (no claude row — a Codex-only
// machine can be green) plus its environment rows.
// Stage 85 (ADR-0029; operator-smoke finding): on the LOCAL substrate `gh` is
// NOT a dependency — the whole point of the substrate — so probing it is wrong
// three ways: a host without gh must not fail local health, `gh --version` was
// residual gh spawn noise in the real-model zero-gh smoke, and the row's
// `gh auth status` probe CALLS GitHub. The row does not silently vanish: it is
// REPLACED by an explicitly-skipped row in the contract's own vocabulary
// (unobserved values are null — present/version were not probed; ok:true means
// "this check cannot fail local health"; the detail says exactly why). Every
// other substrate is byte-identical (the row probes exactly as before).
function localSubstrateSkipRow(dep) {
  return {
    name: dep.name,
    present: null,
    version: null,
    ok: true,
    detail:
      'skipped on the local substrate: gh is not a dependency of substrate: local (ADR-0029, stage 85) — not probed (its auth probe would call GitHub), and its absence never fails local health',
  };
}

function checkOrSkip(dep, opts) {
  if (opts.substrate === 'local' && dep.name === 'gh') {
    return localSubstrateSkipRow(dep);
  }
  return checkDependency(dep, opts);
}

// Stage 87 (ADR-0030): the localhost gate runner's host-dependency rows —
// probed ONLY when the project's RESOLVED gate_runner is 'localhost'
// (runChecks below); stage 88 adds the `remote:<name>` rows on the same
// machinery (remoteGateRunnerChecks below); every other resolved runner adds
// nothing, so an unconfigured project's report is byte-identical and needs no
// new dependencies (ADR-0030 Consequences: new host dependencies only when
// configured). Two localhost rows, both on the existing registry-row
// machinery:
//   docker  present via `--version` (daemonless), daemon reachable via the
//           row's authCheck slot (`docker info` — exit-code judged, so a
//           stopped daemon reads "present but `docker info` failed")
//   act     present + a parseable version (no configured minimum — the
//           gates-act.cjs preflight enforces the same two shapes at run time)
// Binaries honor VERITY_DOCKER_BIN / VERITY_ACT_BIN (the VERITY_CODEX_BIN
// override convention) so doctor probes exactly the executables the runner
// would spawn.
function gateRunnerChecks(opts = {}) {
  const env = opts.env || process.env;
  // Stage 88 (ADR-0030): remote:<name> gets its own four rows — catalog
  // resolution + over-SSH probes — and 'localhost' stays byte-identical.
  if (typeof opts.gateRunner === 'string' && opts.gateRunner.startsWith('remote:')) {
    return remoteGateRunnerChecks(opts);
  }
  return [
    checkDependency(
      {
        name: 'docker',
        binary: env.VERITY_DOCKER_BIN || 'docker',
        versionArgs: ['--version'],
        authCheck: ['info'],
      },
      opts,
    ),
    checkDependency(
      { name: 'act', binary: env.VERITY_ACT_BIN || 'act', versionArgs: ['--version'] },
      opts,
    ),
  ];
}

// Stage 88 (ADR-0030): the `remote:<name>` gate runner's preflight rows. Four
// rows, in dependency order, each gated on the one before it — a probe that
// cannot honestly run (no resolved target, no SSH reachability) reads
// "not probed" (present: null — the unobserved-value vocabulary from the
// stage-85 skip row) with ok: false, so doctor still fails loudly without
// hammering a dead SSH channel three times:
//   gate-runner-catalog  the name resolves against ~/.verity/gate-runners.md
//                        (gate-runners.resolveRemote — a failure's detail IS
//                        the resolver's fail-closed message: catalog path +
//                        known entry names)
//   ssh                  reachability: `ssh -o BatchMode=yes <target> true` —
//                        BatchMode forbids interactive prompts (doctor must
//                        never hang on a password), exit-code judged only
//   remote-docker        `ssh … <target> docker info` — exit-code judged; a
//                        remote stopped daemon or absent docker both fail
//   remote-act           `ssh … <target> act --version` — exit 0 AND a
//                        parseable x.y.z (the stage-87 act shape, remotely)
// All probes run over the operator's EXISTING SSH context (their config,
// agent, keys) — Verity never reads, passes, or logs credential contents; the
// only catalog material echoed is the entry name, the target (host/user the
// operator wrote), and the catalog path. The ssh binary honors VERITY_SSH_BIN
// (the VERITY_DOCKER_BIN/VERITY_ACT_BIN override convention) so tests stub it
// and off-PATH installs work. Row names are distinct from the localhost rows
// ('remote-docker'/'remote-act', not 'docker'/'act'): these rows assert the
// REMOTE host's provisioning, and the local machine needs neither binary.
function remoteGateRunnerChecks(opts = {}) {
  const env = opts.env || process.env;
  const exec = opts.exec || spawnSync;
  const ssh = env.VERITY_SSH_BIN || 'ssh';
  const name = opts.gateRunner.slice('remote:'.length);
  const rows = [];

  let resolved = null;
  let catalogDetail;
  try {
    // Lazy require (the doctor-stays-a-leaf convention): gate-runners pulls in
    // autonomy/deployment, which the agent drivers requiring doctor never need.
    resolved = require('./gate-runners.cjs').resolveRemote(name, opts);
    catalogDetail = `entry '${name}' resolves to ${resolved.target} (${resolved.path})`;
  } catch (err) {
    catalogDetail = err.message;
  }
  rows.push({
    name: 'gate-runner-catalog',
    present: resolved !== null,
    version: null,
    ok: resolved !== null,
    detail: catalogDetail,
  });

  const skipped = (rowName, why) => ({
    name: rowName,
    present: null,
    version: null,
    ok: false,
    detail: `not probed: ${why}`,
  });
  if (resolved === null) {
    rows.push(
      skipped('ssh', 'the catalog entry did not resolve (see gate-runner-catalog)'),
      skipped('remote-docker', 'the catalog entry did not resolve (see gate-runner-catalog)'),
      skipped('remote-act', 'the catalog entry did not resolve (see gate-runner-catalog)'),
    );
    return rows;
  }

  // One probe shape for all three remote rows: exit-code judged, never parsed
  // for judgment (ADR-0028); spawn errors name the LOCAL ssh binary problem.
  const probe = (remoteArgv) =>
    exec(ssh, ['-o', 'BatchMode=yes', resolved.target, ...remoteArgv], { encoding: 'utf8' });
  const failWhy = (res) =>
    res.error
      ? res.error.code || res.error.message
      : firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.status}`;
  const label = (cmd) => `\`${ssh} -o BatchMode=yes ${resolved.target} ${cmd}\``;

  const reach = probe(['true']);
  const reachable = !reach.error && reach.status === 0;
  rows.push({
    name: 'ssh',
    present: !reach.error, // the LOCAL ssh binary ran (reachability is `ok`)
    version: null,
    ok: reachable,
    detail: reachable
      ? `${label('true')} ok`
      : `${label('true')} failed: ${failWhy(reach)} — no interactive prompts (BatchMode); fix SSH access to '${name}' or point VERITY_SSH_BIN at your ssh`,
  });
  if (!reachable) {
    rows.push(
      skipped('remote-docker', `SSH to ${resolved.target} is not reachable (see ssh)`),
      skipped('remote-act', `SSH to ${resolved.target} is not reachable (see ssh)`),
    );
    return rows;
  }

  const docker = probe(['docker', 'info']);
  const dockerOk = !docker.error && docker.status === 0;
  rows.push({
    name: 'remote-docker',
    present: dockerOk,
    version: null,
    ok: dockerOk,
    detail: dockerOk
      ? `remote \`docker info\` ok on ${resolved.target}`
      : `remote \`docker info\` failed on ${resolved.target}: ${failWhy(docker)} — is Docker installed there and the daemon running?`,
  });

  const act = probe(['act', '--version']);
  const actRan = !act.error && act.status === 0;
  const actVersion = actRan ? (parseVersion(act.stdout)?.join('.') ?? null) : null;
  rows.push({
    name: 'remote-act',
    present: actRan,
    version: actVersion,
    ok: actRan && actVersion !== null,
    detail:
      actRan && actVersion !== null
        ? `remote act ${actVersion} on ${resolved.target}`
        : actRan
          ? `could not parse a version from remote \`act --version\` on ${resolved.target}: ${firstLine(act.stdout) || '(empty)'}`
          : `remote \`act --version\` failed on ${resolved.target}: ${failWhy(act)} — is nektos/act installed there?`,
  });
  return rows;
}

// --- grok environment rows ------------------------------------------------------
// Beyond the binaries, a working Grok Build install needs what `verity install
// --grok` writes: the flattened verity-*.md commands under ~/.grok/commands,
// the engine internals they fall back to, and a matching install state. Same
// row shape and remediation discipline as the codex rows.

// User-scoped Grok Build host root — mirrors install.cjs grokDir() (GROK_HOME
// is Grok Build's own relocation variable; opts.home is the seam).
function grokRoot(opts = {}) {
  const env = opts.env || process.env;
  return env.GROK_HOME || path.join(opts.home || os.homedir(), '.grok');
}

function grokEnvironmentChecks(opts = {}) {
  const root = grokRoot(opts);
  const rows = [];

  // Command discovery: flat verity-*.md files under <root>/commands.
  const commandsDir = path.join(root, 'commands');
  const expected = packagedRoleCount();
  let count = 0;
  try {
    count = fs
      .readdirSync(commandsDir)
      .filter((n) => n.startsWith('verity-') && n.endsWith('.md')).length;
  } catch {
    // no commands dir at all — count stays 0
  }
  rows.push({
    name: 'grok-commands',
    present: count > 0,
    version: null,
    ok: count === expected && expected > 0,
    detail:
      count === expected && expected > 0
        ? `${count}/${expected} verity-*.md commands discovered under ${commandsDir}`
        : `Verity commands missing: ${count}/${expected} verity-*.md under ${commandsDir} — Run: verity install --grok`,
  });

  // Engine fallback path: installed commands invoke this when `verity` is not
  // on PATH — commands without it discover fine and then cannot act.
  const engine = path.join(root, 'verity', 'bin', 'verity.cjs');
  const engineOk = fs.existsSync(engine);
  rows.push({
    name: 'grok-engine',
    present: engineOk,
    version: null,
    ok: engineOk,
    detail: engineOk
      ? `engine fallback present at ${engine}`
      : `engine internals missing (${engine}) — commands cannot reach the deterministic CLI — Run: verity install --grok`,
  });

  // Install state: written by installGrok; a missing file or a harness that is
  // not 'grok' means this ~/.grok tree was not (or is no longer) a Verity
  // Grok Build install — stale state, reinstall to reconcile.
  const stateFile = path.join(root, 'verity', 'install-options.json');
  let state = null;
  let stateDetail = `no Grok Build install state (${stateFile}) — Run: verity install --grok`;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    stateDetail =
      state.harness === 'grok'
        ? `install state ok (harness grok, ${stateFile})`
        : `stale install state: harness is '${state.harness}', expected 'grok' (${stateFile}) — Run: verity install --grok`;
  } catch {
    // missing/unparsable — stateDetail already says stale/missing
  }
  rows.push({
    name: 'grok-install-state',
    present: state !== null,
    version: null,
    ok: state !== null && state.harness === 'grok',
    detail: stateDetail,
  });

  return rows;
}

function runChecks(opts = {}) {
  // Stage 87 (ADR-0030): the resolved gate_runner travels beside the resolved
  // substrate — 'localhost' appends its Docker+act probe rows and (stage 88)
  // 'remote:<name>' its catalog+SSH probe rows to whichever registry the
  // runtime selected; anything else appends nothing (unconfigured projects
  // stay byte-identical).
  const remote = typeof opts.gateRunner === 'string' && opts.gateRunner.startsWith('remote:');
  const gateRows = opts.gateRunner === 'localhost' || remote ? gateRunnerChecks(opts) : [];
  if (opts.agent === 'codex') {
    const deps = opts.deps || CODEX_DEPENDENCIES;
    return [
      ...deps.map((dep) => checkOrSkip(dep, opts)),
      ...codexEnvironmentChecks(opts),
      ...gateRows,
    ];
  }
  if (opts.agent === 'grok') {
    const deps = opts.deps || GROK_DEPENDENCIES;
    return [
      ...deps.map((dep) => checkOrSkip(dep, opts)),
      ...grokEnvironmentChecks(opts),
      ...gateRows,
    ];
  }
  const deps = opts.deps || DEPENDENCIES;
  return [...deps.map((dep) => checkOrSkip(dep, opts)), ...gateRows];
}

// 0 = every check ok, 1 = at least one failing check (the `--quiet` contract).
function exitCodeFor(checks) {
  return Array.isArray(checks) && checks.every((c) => c.ok) ? 0 : 1;
}

// --- runtime selection (stage 9, codex-support.md §10.2) ------------------------

const SUPPORTED_AGENTS = ['claude', 'codex', 'grok'];

// Which runtime doctor checks, and WHY — precedence: explicit --agent flag →
// `.verity/autonomy.yml` agent.provider (only when the FILE names one; the
// merged default never masks the later sources) → install-state `harness`
// (exactly one supported harness across the known host roots) → the legacy
// default claude. Every non-flag source degrades informatively: a malformed
// policy or state file falls through to the next source rather than failing
// doctor (the `verity autonomy validate` / install paths own those errors).
function resolveAgent(flags = {}, opts = {}) {
  if (flags.agent !== undefined) {
    if (!SUPPORTED_AGENTS.includes(flags.agent)) {
      throw new Error(
        `--agent must be one of ${SUPPORTED_AGENTS.join('|')}, got '${flags.agent}' — verity doctor [--quiet] [--agent claude|codex|grok]`,
      );
    }
    return { agent: flags.agent, source: 'the --agent flag' };
  }

  const cwd = flags.cwd || process.cwd();
  const policyFile = path.join(cwd, '.verity', 'autonomy.yml');
  if (fs.existsSync(policyFile)) {
    try {
      // Lazy require: doctor is a leaf module for the drivers (claude/codex
      // require it) — pulling the policy loader in only when a file exists
      // keeps the import graph flat on every other path.
      const autonomy = require('./autonomy.cjs');
      const provider = autonomy.parseYaml(fs.readFileSync(policyFile, 'utf8'))?.agent?.provider;
      if (SUPPORTED_AGENTS.includes(provider)) {
        return { agent: provider, source: '.verity/autonomy.yml agent.provider' };
      }
    } catch {
      // malformed policy never breaks doctor — fall through
    }
  }

  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const roots = [
    env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    path.join(home, '.agents'),
    env.GROK_HOME || path.join(home, '.grok'),
  ];
  const found = new Map(); // harness → state file that declared it
  for (const root of roots) {
    const stateFile = path.join(root, 'verity', 'install-options.json');
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (SUPPORTED_AGENTS.includes(state.harness) && !found.has(state.harness)) {
        found.set(state.harness, stateFile);
      }
    } catch {
      // absent/unparsable install state — not a selection signal
    }
  }
  if (found.size === 1) {
    const [harness, stateFile] = [...found.entries()][0];
    return { agent: harness, source: `install state (${stateFile})` };
  }

  // Zero or ambiguous install states → the backward-compatible default.
  return { agent: 'claude', source: 'the legacy default' };
}

// --- CLI: `verity doctor [--quiet] [--agent claude|codex]` ----------------------

function dispatch(args, flags = {}) {
  if (args.length > 0) {
    throw new Error(
      'doctor takes no positional arguments — verity doctor [--quiet] [--agent claude|codex|grok]',
    );
  }
  const selection = resolveAgent(flags);
  // stderr, not stdout: the report array on stdout stays pipe-safe, and
  // --quiet's "nothing on stdout" contract holds.
  process.stderr.write(
    `verity doctor: checking agent runtime '${selection.agent}' (selected by ${selection.source})\n`,
  );
  // Stage 85 (ADR-0029): the cwd's resolved delivery substrate travels into
  // the check pass so a `substrate: local` repo's gh row reads
  // skipped-for-substrate (see runChecks) — a role or operator running
  // `verity doctor` inside a local repo must not probe gh (nor call GitHub via
  // `gh auth status`). Lazy require: substrate-local requires autonomy, which
  // this module never requires at load time, but the lazy form keeps doctor a
  // leaf for the agent drivers exactly as before. github/unreadable-policy
  // resolves 'github' — byte-identical probes.
  const substrate = require('./substrate-local.cjs').resolveSubstrate(flags.cwd || process.cwd());
  // Stage 87 (ADR-0030): the resolved gate_runner is obtained the same way the
  // substrate is — from the cwd's loaded policy, lazily and degrade-informative:
  // 'localhost' adds the Docker+act probe rows (see gateRunnerChecks); any
  // other resolved value — including the absent-key native resolution and a
  // policy doctor cannot read (`verity autonomy validate` owns that error) —
  // adds nothing, keeping unconfigured projects byte-identical.
  let gateRunner;
  try {
    gateRunner = require('./autonomy.cjs').loadPolicy(flags.cwd || process.cwd()).gate_runner;
  } catch {
    gateRunner = undefined; // unreadable policy never breaks doctor
  }
  return runChecks({ agent: selection.agent, substrate, gateRunner });
}

module.exports = {
  CODEX_DEPENDENCIES,
  GROK_DEPENDENCIES,
  grokEnvironmentChecks,
  grokRoot,
  DEPENDENCIES,
  SUPPORTED_AGENTS,
  checkBinary,
  checkDependency,
  codexEnvironmentChecks,
  compareVersions,
  dispatch,
  exitCodeFor,
  firstLine,
  gateRunnerChecks,
  parseVersion,
  resolveAgent,
  runChecks,
};
