// Verity benchmark harness — `verity benchmark` (ADR-0025). The CHEAP,
// deterministic half of the harness skeleton (stage 55): read a `benchmark.json`
// config and PROVISION a fresh dated throwaway fixture repo by ORCHESTRATING the
// existing vision flow (identity → scaffold → git → gh). No model spend here;
// the run/collect half is stage 56.
//
// Dark / opt-in kill-switch (ADR-0025 §3): the whole surface is inert unless a
// valid `benchmark.json` with `enabled:true` is present — there is no separate
// flag. Absent or `enabled:false` ⇒ the command does nothing. A malformed config
// is surfaced honestly (never a silent default).
//
// Orchestrate, don't reimplement (ADR-0025 §1): provision SHELLS the existing
// verity surface + git/gh through an INJECTABLE spawn, so the whole thing is
// unit-testable with zero network — no real repo is created, no worker spawned.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Stage 56: the scorecard is Verity-observed (ADR-0025 §5) — collected from the
// fixture's usage ledger via usage.cjs (the SAME rollups the operator surface
// reads), and the per-role agent variant + caps are written through autonomy's
// own serializer. No new derivation is invented here; both are reused verbatim.
const usage = require('./usage.cjs');
const autonomy = require('./autonomy.cjs');
const { LABELS, ensureLabels } = require('./labels.cjs');
// Stage 83 (ADR-0029, first-customer wiring): the local delivery-substrate
// driver the benchmark orchestrates when the config selects `substrate: local`
// — stage-81 bare-origin provision + the stage-80 work-item record store
// (contract local-work-item v1, FROZEN). Orchestrate, don't reimplement
// (ADR-0025 §1): these are the SAME engine functions the worker/merge sites
// consume; the benchmark adds no local-only fork of their behavior.
const substrateLocal = require('./substrate-local.cjs');
// Stage 82's gate-definition reader, used ONLY to validate (fail-closed) that
// a local fixture ships a runnable committed gate definition — provision never
// synthesizes one (a default gate list would be a fabricated green, ADR-0028).
const gates = require('./gates.cjs');

// The intake label the scanner's P4 tier lists and the worker plans (SKETCH §1
// / §4.2): an OPEN issue labeled `verity:request` is selected as a P4 item, and
// the worker's run loop dispatches role `plan` on it as its first role — that is
// how a request BECOMES stages. Sourced from the shared label vocabulary, never
// hardcoded, so a rename can never silently unseat the seed.
const REQUEST_LABEL = LABELS.find((l) => l.name === 'verity:request').name;

// The verity CLI dispatcher we shell for identity/scaffold (the vision flow's
// provisioning primitives). Invoked via node so it works without a PATH install.
const VERITY_BIN = path.join(__dirname, '..', 'verity.cjs');

const ENV_CONFIG = 'VERITY_BENCHMARK_CONFIG';

// Resolve the config path: an explicit param wins, then the env override, then a
// conventional `benchmark.json` in cwd. Injectable so the suite never reads a
// real home file.
function resolveConfigPath(pathOrOpts) {
  let explicit;
  let cwd;
  if (typeof pathOrOpts === 'string') {
    explicit = pathOrOpts;
  } else if (pathOrOpts && typeof pathOrOpts === 'object') {
    explicit = pathOrOpts.path;
    cwd = pathOrOpts.cwd;
  }
  if (typeof explicit === 'string' && explicit !== '') {
    return explicit;
  }
  const env = process.env[ENV_CONFIG];
  if (typeof env === 'string' && env !== '') {
    return env;
  }
  return path.join(cwd || process.cwd(), 'benchmark.json');
}

// loadConfig — read + validate `benchmark.json`.
//   absent file                 ⇒ { enabled:false }              (DARK)
//   enabled not truthy          ⇒ { enabled:false }              (DARK — off)
//   bad JSON / bad shape        ⇒ { enabled:false, valid:false, reason }  (SURFACED)
//   valid + enabled:true        ⇒ the parsed config
// A malformed config is NEVER silently defaulted — it is reported.
function loadConfig(pathOrOpts) {
  const p = resolveConfigPath(pathOrOpts);
  if (!fs.existsSync(p)) {
    return { enabled: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { enabled: false, valid: false, reason: `invalid benchmark.json (${err.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { enabled: false, valid: false, reason: 'benchmark.json must be a JSON object' };
  }
  // Off is off — a disabled config is dark, not "malformed", regardless of the
  // rest of its shape (the kill-switch must never fail-open into an error path).
  if (!parsed.enabled) {
    return { enabled: false };
  }
  // Enabled ⇒ the shape must actually be provisionable, or it is surfaced.
  if (typeof parsed.owner !== 'string' || parsed.owner === '') {
    return {
      enabled: false,
      valid: false,
      reason: 'benchmark.json: `owner` must be a non-empty string',
    };
  }
  if (!parsed.fixtures || typeof parsed.fixtures !== 'object' || Array.isArray(parsed.fixtures)) {
    return { enabled: false, valid: false, reason: 'benchmark.json: `fixtures` must be an object' };
  }
  // Stage 58 (ADR-0025): a fixture may declare an OPTIONAL `seed_dir` — a
  // repo-relative directory of committed docs (architecture.md + docs/adr/*)
  // provision copies into the scaffold. Validate it is a string when present;
  // a malformed config is surfaced, never silently defaulted.
  // Stage 60 (ADR-0025): a fixture may instead declare an OPTIONAL `stages_dir`
  // — a repo-relative directory of a COMMITTED stage backlog (architecture.md +
  // docs/adr/* + stage-instructions/stage-N-*.md) provision copies verbatim and
  // whose `[stage N]` issues it regenerates (in-flight mode). Validate it is a
  // string when present, exactly like seed_dir; a malformed config is surfaced.
  for (const [id, def] of Object.entries(parsed.fixtures)) {
    if (def && def.seed_dir !== undefined && typeof def.seed_dir !== 'string') {
      return {
        enabled: false,
        valid: false,
        reason: `benchmark.json: fixture '${id}' seed_dir must be a string`,
      };
    }
    if (def && def.stages_dir !== undefined && typeof def.stages_dir !== 'string') {
      return {
        enabled: false,
        valid: false,
        reason: `benchmark.json: fixture '${id}' stages_dir must be a string`,
      };
    }
  }
  // Optional `repo_visibility` — the visibility of the dated throwaway repo the
  // harness creates (default `private`). A `public` value lets a seed identity
  // that is not a repo collaborator open the intake issue (paired with
  // `seed_token_env` below); still validated so a typo fails closed.
  if (
    parsed.repo_visibility !== undefined &&
    !['public', 'private', 'internal'].includes(parsed.repo_visibility)
  ) {
    return {
      enabled: false,
      valid: false,
      reason: 'benchmark.json: `repo_visibility` must be "public", "private", or "internal"',
    };
  }
  // Optional `seed_token_env` — the NAME of an env var holding a GitHub token for
  // a DIFFERENT identity than the worker, used ONLY for the greenfield seed so the
  // scanner's no-self-feeding rule does not drop the request. The token itself is
  // never stored here — only the env var's name.
  if (
    parsed.seed_token_env !== undefined &&
    (typeof parsed.seed_token_env !== 'string' || parsed.seed_token_env === '')
  ) {
    return {
      enabled: false,
      valid: false,
      reason: 'benchmark.json: `seed_token_env` must be a non-empty string (an env var name)',
    };
  }
  return parsed;
}

// Stage 83 (ADR-0029): ONE resolution of the config's delivery substrate,
// shared by writeVariant (stage 79 — writes the value into the provisioned
// repo's .verity/autonomy.yml), provision (selects the local provisioning
// path) and run (selects the local intake path). The variant wins over the
// top-level key, exactly as writeVariant resolved it since stage 79 —
// provision/run MUST read the SAME value the fixture policy will carry, or
// the two halves could disagree about the substrate. Absent ⇒ undefined
// (github path, byte-identical — the default-OFF kill-switch of this stage).
function configSubstrate(config) {
  const variant = config.variant || {};
  return variant.substrate !== undefined ? variant.substrate : config.substrate;
}

// The committed stage-backlog parse the in-flight replay uses (stage 60),
// EXTRACTED in stage 83 so the gh `[stage N]` issue replay and the local
// work-item RECORD replay share ONE parser — same file filter, same H1/Type
// regexes ledger.parseStageFile keys on, same mandatory `[stage N]` title
// convention (ledger.isStageIssue matches it), ordered by N ascending. Never
// duplicated per substrate.
function readBacklogStages(repoDir) {
  const stageFilesDir = path.join(repoDir, 'stage-instructions');
  let names = [];
  try {
    names = fs.readdirSync(stageFilesDir).filter((n) => /^stage-\d+-/.test(n) && n.endsWith('.md'));
  } catch {
    names = [];
  }
  return names
    .map((name) => {
      const filePath = path.join(stageFilesDir, name);
      const text = fs.readFileSync(filePath, 'utf8');
      const h1 = (text.match(/^#\s+Stage\s+\d+:\s+(.+)$/m) || [])[1];
      const type = (text.match(/\*\*Type:\*\*\s*(\w+)/) || [])[1] || 'feature';
      const number = Number(name.match(/^stage-(\d+)-/)[1]);
      return { name, number, filePath, type, title: `[stage ${number}] ${(h1 || name).trim()}` };
    })
    .sort((a, b) => a.number - b.number);
}

// Two-digit / four-digit zero pad.
function pad(n, width) {
  return String(n).padStart(width, '0');
}

// datedSlug — `<fixtureId>-<YYYYMMDD-HHMMSS>` from an INJECTED clock (a `now`
// Date), UTC so it is deterministic and comparable across runs/hosts.
function datedSlug(fixtureId, now) {
  const d = now instanceof Date ? now : new Date();
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `-${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
  // Lowercase the fixture id: the slug becomes a repo/package name, and Verity
  // slugs must be lowercase (container/package registries require it) — an
  // uppercase `D-…` is rejected by `identity lock` at provision. The record's
  // `fixture` field keeps the canonical uppercase id; only the slug lowercases.
  return `${String(fixtureId).toLowerCase()}-${stamp}`;
}

// Default spawn: spawnSync, success == exit 0. Injectable via opts.spawn so the
// suite records the call sequence and NO real git/gh/verity runs.
function defaultSpawn(cmd, args, options) {
  return spawnSync(cmd, args, { stdio: 'pipe', ...options });
}

// A spawn result is a success iff the process launched and exited 0. A spawn
// error (ENOENT) or a non-zero status is a FAILURE — surfaced, never ignored.
function ok(res) {
  return Boolean(res) && res.error == null && (res.status === 0 || res.status === undefined);
}

// Extract a short, human-usable failure detail from a spawn result — the stderr
// (or stdout / spawn error) the failing step printed — so a provision failure
// reports WHY, not just WHICH step (the live canary showed "failed at 'gh'" alone
// is not actionable). Bounded so a runaway log can't bloat the record.
function failDetail(res) {
  if (!res) {
    return '';
  }
  const raw = res.stderr || res.stdout || res.error?.message || '';
  return String(raw).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
}

// Resolve the env for the greenfield seed. When the config names `seed_token_env`,
// the seed `gh issue create` runs under THAT env var's token — a DIFFERENT GitHub
// identity than the worker — so the scanner's no-self-feeding rule does not drop
// the request (the requester must differ from the worker's botLogin). The token is
// read from the named env var and NEVER stored in the config, the record, or a
// reason string; a named-but-missing/empty var FAILS CLOSED rather than silently
// seeding as the worker (which would re-trigger no-self-feeding). Returns
// { ok:true, spawnEnv } where spawnEnv is undefined ⇒ no override (ambient identity),
// or { ok:false, reason } naming only the ENV VAR (never the token).
function seedSpawnEnv(config, env) {
  const name = config.seed_token_env;
  if (name === undefined) {
    return { ok: true, spawnEnv: undefined };
  }
  const token = env[name];
  if (typeof token !== 'string' || token === '') {
    return {
      ok: false,
      reason: `benchmark seed identity env var '${name}' is unset or empty — export it with a GitHub token for a DIFFERENT identity than the worker (no-self-feeding), or remove seed_token_env from benchmark.json`,
    };
  }
  return { ok: true, spawnEnv: { ...env, GH_TOKEN: token } };
}

// A synchronous blocking sleep — run()'s pipeline is spawnSync-based (no async).
// Atomics.wait on a throwaway buffer blocks without a subprocess; injectable so
// tests pass a no-op (no real delay).
function blockingSleep(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

// GitHub's read path can trail a write by a few seconds (eventual consistency).
// The greenfield seed labels the intake issue in a SEPARATE `gh issue edit` call
// (the seed-identity override especially — the create identity may not label), so
// an IMMEDIATE `gh issue list --label` — the EXACT primary query the scanner's P4
// tier uses (scanner.cjs) — can miss the just-labeled request and the plan tick
// then finds "no eligible work". So before spending the (expensive, agent-backed)
// plan tick, POLL that same query until the seeded issue appears, bounded, with an
// injectable sleep. Returns true once visible; false if it never appears in budget
// (⇒ a grounded seed-verify, never a wasted plan tick or a misread empty run).
function waitForRequestVisible(ctx) {
  const { spawn, repo, dir, seededNum, attempts, delayMs, sleep } = ctx;
  for (let i = 0; i < attempts; i += 1) {
    const res = spawn(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--label',
        REQUEST_LABEL,
        '--state',
        'open',
        '--json',
        'number',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    if (ok(res) && typeof res.stdout === 'string') {
      let list = [];
      try {
        list = JSON.parse(res.stdout || '[]');
      } catch {
        list = [];
      }
      if (Array.isArray(list) && list.some((it) => String(it.number) === String(seededNum))) {
        return true;
      }
    }
    if (i < attempts - 1) {
      sleep(delayMs);
    }
  }
  return false;
}

// provision — the deterministic half. Resolve the fixture + its seed spec from
// config, compute the dated slug, then SHELL the vision flow in order:
//   1. verity identity lock "<name>" <slug> --owner <owner>
//   2. verity scaffold init --description "<desc>"
//   3. (seed the fixture spec into the repo — fs, not a shell step)
//   4. git init  /  git add -A  /  git commit -m <msg>
//   5. gh repo create <owner>/<slug> --source=. --push
// Returns the run-manifest entry { fixture, repo, url, created_at } (with ok:true)
// on success. A failing shell step is SURFACED as { ok:false, reason, step } —
// never a half-provisioned silent success. No model spend anywhere.
function provision(fixtureId, opts = {}) {
  const fixture = fixtureId || 'D';
  const config = opts.config || loadConfig(opts.configPath);
  if (!config.enabled) {
    return {
      ok: false,
      reason: config.reason || 'benchmark is dark — no valid benchmark.json with enabled:true',
    };
  }
  const fixtureDef = config.fixtures[fixture];
  if (!fixtureDef || typeof fixtureDef !== 'object') {
    return { ok: false, reason: `unknown benchmark fixture '${fixture}'` };
  }

  // Stage 60 (ADR-0025): a fixture with `stages_dir` provisions as IN-FLIGHT
  // (plan already done) rather than greenfield — it commits a copied stage
  // backlog and provision regenerates the `[stage N]` issues from it. In-flight
  // and greenfield are MUTUALLY EXCLUSIVE: an in-flight fixture writes NO
  // spec.md and needs no spec. Declaring BOTH `stages_dir` and the greenfield
  // `spec` is a config error, surfaced before any provision step (never a silent
  // precedence). Absent `stages_dir` ⇒ byte-identical greenfield.
  const inFlight = fixtureDef.stages_dir !== undefined;
  if (inFlight && fixtureDef.spec !== undefined) {
    return {
      ok: false,
      step: 'replay',
      reason: `fixture '${fixture}' declares BOTH stages_dir and spec — in-flight (stages_dir) and greenfield (spec) are mutually exclusive`,
    };
  }
  if (!inFlight && typeof fixtureDef.spec !== 'string') {
    return { ok: false, reason: `unknown benchmark fixture '${fixture}' (or it has no spec path)` };
  }

  // The fixture spec path in config is repo-relative (e.g.
  // "benchmark/fixtures/repo-d/spec.md"); resolve it against the directory the
  // command runs in (the framework repo root in real use), injectable as
  // opts.repoRoot for tests. Deliberately NOT a climb above verity/ — that would
  // be the module-escape the engine-selfcontained guard forbids. Skipped in
  // in-flight mode (no spec seeded).
  const repoRoot = opts.repoRoot || opts.cwd || process.cwd();
  let specPath = null;
  if (!inFlight) {
    specPath = path.resolve(repoRoot, fixtureDef.spec);
    if (!fs.existsSync(specPath)) {
      return { ok: false, reason: `fixture spec not found at ${specPath}` };
    }
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const owner = config.owner;
  const slug = datedSlug(fixture, now);
  const repo = `${owner}/${slug}`;
  const spawn = opts.spawn || defaultSpawn;

  // A fresh working directory for the throwaway repo — injectable so tests keep
  // it inside a scratch dir; defaults to a unique temp dir.
  const workdir = opts.workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'verity-benchmark-'));
  const repoDir = path.join(workdir, slug);
  fs.mkdirSync(repoDir, { recursive: true });
  const childOpts = { cwd: repoDir };

  // The ordered vision-flow sequence. Each entry is { step, cmd, args }.
  const description = `Benchmark fixture ${fixture} (control app), provisioned ${now.toISOString()}`;
  const commitMessage = `chore: seed benchmark fixture ${fixture} (${slug})`;
  const identitySteps = [
    {
      step: 'identity',
      cmd: process.execPath,
      args: [VERITY_BIN, 'identity', 'lock', `Benchmark ${fixture}`, slug, '--owner', owner],
    },
    {
      step: 'scaffold',
      cmd: process.execPath,
      args: [VERITY_BIN, 'scaffold', 'init', '--description', description],
    },
  ];

  for (const s of identitySteps) {
    const res = spawn(s.cmd, s.args, childOpts);
    if (!ok(res)) {
      const detail = failDetail(res);
      return {
        ok: false,
        reason: `benchmark provision failed at '${s.step}'${detail ? `: ${detail}` : ''}`,
        step: s.step,
      };
    }
  }

  // Optional seed-set (stage 58, ADR-0025): a fixture may declare a `seed_dir`
  // (repo-relative) — a directory of committed docs (architecture.md +
  // docs/adr/*) copied VERBATIM, preserving relative layout, into the scaffold
  // so a greenfield-from-decided-architecture run (fixture A) is faithful: the
  // plan role decomposes a committed architecture, not a bare request body.
  // Resolved against repoRoot exactly like `spec`, existsSync-guarded, and
  // path-traversal-refused (fixture-author input — the engine-selfcontained
  // discipline). Copied HERE, before the git add/commit below, so the seed set
  // is staged and committed WITH the scaffold and BEFORE the request issue the
  // run half creates. fs-only, fail-surfaced as step:'seed-set' — never a
  // partial silent seed. Absent seed_dir ⇒ byte-identical to today.
  if (fixtureDef.seed_dir !== undefined) {
    if (typeof fixtureDef.seed_dir !== 'string' || fixtureDef.seed_dir === '') {
      return {
        ok: false,
        step: 'seed-set',
        reason: `fixture '${fixture}' seed_dir must be a non-empty string`,
      };
    }
    const seedDir = path.resolve(repoRoot, fixtureDef.seed_dir);
    const rel = path.relative(repoRoot, seedDir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        ok: false,
        step: 'seed-set',
        reason: `fixture '${fixture}' seed_dir escapes the repo root: ${fixtureDef.seed_dir}`,
      };
    }
    if (!fs.existsSync(seedDir)) {
      return { ok: false, step: 'seed-set', reason: `fixture seed_dir not found at ${seedDir}` };
    }
    try {
      // Recurse into subdirectories, preserving layout (docs/adr/…). Copied
      // into repoDir so the seed set merges alongside the scaffold.
      fs.cpSync(seedDir, repoDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        step: 'seed-set',
        reason: `failed to seed fixture seed_dir: ${err.message}`,
      };
    }
  }

  // In-flight backlog copy (stage 60, ADR-0025): a fixture may declare a
  // `stages_dir` — a repo-relative directory of a COMMITTED stage backlog
  // (architecture.md + docs/adr/* + stage-instructions/stage-N-*.md). Copied
  // VERBATIM, preserving layout, into the scaffold with the SAME guards as
  // seed_dir (existsSync + path-traversal refusal), so a fixture provisions as
  // if its plan were already done. Copied HERE, before the git add/commit below,
  // so the backlog is committed WITH the scaffold. The `[stage N]` ISSUES are
  // regenerated AFTER the repo is created (below). fs-only, fail-surfaced as
  // step:'replay' — never a partial silent seed.
  if (inFlight) {
    if (typeof fixtureDef.stages_dir !== 'string' || fixtureDef.stages_dir === '') {
      return {
        ok: false,
        step: 'replay',
        reason: `fixture '${fixture}' stages_dir must be a non-empty string`,
      };
    }
    const stagesDir = path.resolve(repoRoot, fixtureDef.stages_dir);
    const rel = path.relative(repoRoot, stagesDir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        ok: false,
        step: 'replay',
        reason: `fixture '${fixture}' stages_dir escapes the repo root: ${fixtureDef.stages_dir}`,
      };
    }
    if (!fs.existsSync(stagesDir)) {
      return { ok: false, step: 'replay', reason: `fixture stages_dir not found at ${stagesDir}` };
    }
    try {
      fs.cpSync(stagesDir, repoDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        step: 'replay',
        reason: `failed to seed fixture stages_dir: ${err.message}`,
      };
    }
  }

  // Seed the authored fixture spec into the new repo so the run half (stage 56)
  // can open it as the body of the `verity:request` intake issue the worker
  // plans. Written AFTER the seed-set copy so `spec` authoritatively defines the
  // request-issue body even when a seed_dir also carries a spec.md. fs, not a
  // shell step. SKIPPED in in-flight mode: an in-flight fixture is not greenfield
  // — it writes no spec.md and its run half creates no `verity:request` issue.
  if (!inFlight) {
    try {
      fs.writeFileSync(path.join(repoDir, 'spec.md'), fs.readFileSync(specPath, 'utf8'));
    } catch (err) {
      return { ok: false, reason: `failed to seed fixture spec: ${err.message}`, step: 'seed' };
    }
  }

  // Stage 83 (ADR-0029, first-customer wiring): the resolved delivery
  // substrate — the SAME config value writeVariant (stage 79) plumbs into the
  // provisioned repo's .verity/autonomy.yml, so provision and the run half can
  // never disagree about the substrate. 'local' replaces the three GitHub
  // steps below (`gh repo create --source=. --push`, ensureLabels, the
  // in-flight `[stage N]` issue replay) with their ADR-0029 equivalents:
  // stage-81 bare-origin provision + work-item RECORD seeding per contract
  // local-work-item v1 (frozen). Absent / 'github' ⇒ every step is
  // byte-identical to before this stage (default-OFF, regression-pinned).
  const local = configSubstrate(config) === 'local';

  if (local) {
    // Stage-82 review carry-forward (the red-by-design hazard): a fresh
    // scaffold has NO committed gate definition, so every local stage branch
    // would honestly read UNKNOWN (contract honesty rule: no definition ⇒
    // never green) and nothing would ever merge. A local fixture MUST
    // therefore ship a real, runnable `.verity/gates.json` (stage 82 format)
    // in its committed assets (seed_dir / stages_dir) — validated here,
    // fail-closed, BEFORE the initial commit so it lands in the scaffold
    // commit and is present in every stage branch's tree. Provision never
    // synthesizes one: a default gate list that exercises nothing would be a
    // fabricated green (ADR-0028 test honesty).
    try {
      gates.readGateDefinition(repoDir);
    } catch (err) {
      return {
        ok: false,
        step: 'gates',
        reason: `local-substrate provision for fixture '${fixture}' has no runnable committed gate definition: ${err.message} — ship a real ${gates.GATES_FILE} in the fixture's committed assets (seed_dir/stages_dir); without one every local stage honestly reads UNKNOWN and nothing ever merges (stage 83, ADR-0029 §4)`,
      };
    }
    // Local runs write the usage ledger INTO the working repo (there is no
    // separate CI machine); the stage-82 gate runner refuses on ANY dirty
    // tree (SHA-pinned record honesty). Ignore the ledger so a mid-run
    // usage.csv can never turn every later gate run into a refusal — the
    // provision-side fix; the runner's honesty check is never weakened.
    fs.appendFileSync(
      path.join(repoDir, '.gitignore'),
      '\n# Verity local substrate (stage 83, ADR-0029): the run ledger is runtime\n# state, not committed work — it must never dirty a SHA-pinned gate run.\n.verity/usage.csv\n',
    );
  }

  const gitSteps = [
    { step: 'git-init', cmd: 'git', args: ['init'] },
    { step: 'git-add', cmd: 'git', args: ['add', '-A'] },
    { step: 'git-commit', cmd: 'git', args: ['commit', '-m', commitMessage] },
  ];
  if (!local) {
    // A visibility flag is REQUIRED: `gh repo create` refuses without one when not
    // attached to a TTY (it is spawned here). Default `private`; `repo_visibility:
    // "public"` lets a non-collaborator seed identity open the intake issue.
    gitSteps.push({
      step: 'gh',
      cmd: 'gh',
      args: [
        'repo',
        'create',
        repo,
        '--source=.',
        '--push',
        `--${config.repo_visibility || 'private'}`,
      ],
    });
  }

  for (const s of gitSteps) {
    const res = spawn(s.cmd, s.args, childOpts);
    if (!ok(res)) {
      const detail = failDetail(res);
      return {
        ok: false,
        reason: `benchmark provision failed at '${s.step}'${detail ? `: ${detail}` : ''}`,
        step: s.step,
      };
    }
  }

  // --- stage 83 (ADR-0029): the LOCAL substrate's provisioning tail ----------
  // Everything below this block is the GitHub tail (stage-77 set-head quirks,
  // ensureLabels, the `[stage N]` issue replay) — gh-shaped, skipped entirely
  // on 'local', where each piece has its ADR-0029 equivalent:
  //   - work-item records are seeded FIRST (committed by the stage-80 store,
  //     worker-owned commits per ADR-0026) so the initial push carries them;
  //   - labels need NO provisioning: records carry their label strings
  //     directly (contract local-work-item v1) — there is no label registry;
  //   - provisionBareOrigin (stage 81) then replaces `gh repo create` AND the
  //     stage-77 fetch/set-head tail: it pushes the default branch to a bare
  //     sibling repo and performs the SAME fetch-then-explicit-set-head
  //     sequence, so resolveBase rung 1 (`refs/remotes/origin/HEAD`) serves
  //     build-through base freshness identically on both substrates.
  if (local) {
    try {
      if (inFlight) {
        // One record per copied stage file — the SAME parse + mandatory
        // `[stage N]` title convention as the gh issue replay below
        // (readBacklogStages, extracted stage 83 so the two replays can never
        // drift), ordered by N ascending so record numbers land exactly as
        // fresh GitHub issue numbers would. The record's label is the stage
        // file's Type, carried on the record itself.
        for (const st of readBacklogStages(repoDir)) {
          substrateLocal.createWorkItem(
            repoDir,
            { title: st.title, labels: [st.type] },
            { now: now.getTime() },
          );
        }
      } else {
        // Greenfield: the `verity:request` intake BECOMES a record — the same
        // title the gh run-half seed gives its intake issue; the request BODY
        // is the committed spec.md (records carry no body; the repo does).
        substrateLocal.createWorkItem(
          repoDir,
          { title: `Benchmark fixture ${fixture}: ${slug}`, labels: [REQUEST_LABEL] },
          { now: now.getTime() },
        );
      }
    } catch (err) {
      return {
        ok: false,
        step: 'work-items',
        reason: `local-substrate provision failed seeding work-item records for fixture '${fixture}': ${err.message}`,
      };
    }
    let origin;
    try {
      origin = substrateLocal.provisionBareOrigin(repoDir);
    } catch (err) {
      return {
        ok: false,
        step: 'origin',
        reason: `local-substrate provision failed wiring the bare origin for fixture '${fixture}': ${err.message}`,
      };
    }
    return {
      ok: true,
      fixture,
      repo,
      // No GitHub URL exists on this substrate: the record points at the bare
      // origin the run's merges land in (stage 83 — result/usage recording
      // must never assume a github.com URL).
      url: origin.barePath,
      created_at: now.toISOString(),
      dir: repoDir,
      // Additive local-substrate fields (github entries are byte-identical
      // without them): the bare origin path + the pushed default branch.
      bare: origin.barePath,
      default_branch: origin.branch,
      substrate: 'local',
    };
  }

  // Stage 77: record the remote's default branch as `refs/remotes/origin/HEAD` so
  // a build-through stage forks off the FRESH `origin/<default>` (git-lifecycle
  // resolveBase rung 1, refreshed by its pre-branch fetch) instead of the LOCAL
  // default branch, which the worker never fast-forwards after a remote merge. A
  // `gh repo create --source=. --push` repo (unlike a clone) has NO origin/HEAD,
  // so without this every stage forks off the frozen scaffold and re-implements
  // its predecessors → merge conflicts. Two GitHub-specific quirks, both proven
  // against a real fresh repo: (1) `set-head --auto` FAILS right after create
  // ("Cannot determine remote HEAD" — GitHub cannot answer the HEAD query yet),
  // so set it EXPLICITLY from the branch we just pushed — no remote query needed;
  // (2) `gh repo create --push` does NOT reliably leave the `origin/<branch>`
  // tracking ref in this non-interactive env, so `git fetch origin` FIRST to
  // materialize it (an explicit set-head needs its target ref to exist). All
  // best-effort: on any failure resolveBase falls back to the checkout ref, no
  // worse than today.
  spawn('git', ['fetch', 'origin'], childOpts);
  // encoding:'utf8' so stdout is a STRING (defaultSpawn returns a Buffer otherwise,
  // and .trim() would throw — the codebase reads stdout with this flag, e.g. the
  // label list below).
  const head = spawn('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    ...childOpts,
    encoding: 'utf8',
  });
  const defaultBranch = ok(head) && head.stdout ? String(head.stdout).trim() : '';
  if (defaultBranch) {
    spawn('git', ['remote', 'set-head', 'origin', defaultBranch], childOpts);
  }

  // The freshly-created repo has ONLY GitHub's default labels — provision the
  // Verity label set (the SAME `ensureLabels` the onboarding/install flow uses)
  // BEFORE any issue is created, or the `verity:request` seed (run half) and the
  // in-flight `[stage N]` type labels below cannot resolve (`gh issue create
  // --label` fails on an unknown label). Adapt the injectable `spawn` to
  // ensureLabels' `run(args, cwd)` shape (returns stdout, throws on non-zero).
  const labelRun = (largs, cwd) => {
    const res = spawn('gh', ['label', ...largs], { cwd, encoding: 'utf8' });
    if (!ok(res)) {
      throw new Error(failDetail(res) || `gh label ${largs[0]} failed`);
    }
    return res.stdout || '';
  };
  const labelResult = ensureLabels(repoDir, labelRun);
  if (labelResult && labelResult.ok === false) {
    const why = labelResult.error || labelResult.failed?.[0]?.error || '';
    return {
      ok: false,
      step: 'labels',
      reason: `benchmark provision failed at 'labels': could not ensure the Verity labels on ${repo}${why ? `: ${why}` : ''}`,
    };
  }

  // In-flight issue replay (stage 60, ADR-0025): the committed stage files alone
  // yield an empty `next` — ledger.project derives next/queue by matching local
  // `stage-instructions/stage-N-*.md` files to `[stage N]` GitHub issues
  // (ledger.cjs:27,59), and the ISSUE state is NOT in git. So AFTER the repo
  // exists (gh repo create above), regenerate one `[stage N]` issue per copied
  // stage file — the SAME stage-file→issue convention /verity:plan uses. N and
  // the H1 title / Type label are parsed exactly as ledger.parseStageFile does;
  // the `[stage N]` title prefix is MANDATORY (ledger.isStageIssue matches it) or
  // the issue is unmatched and `next` stays empty. Ordered by N ascending. Each
  // is guarded like every provision step — any non-zero exit ⇒ step:'replay',
  // never a partial silent seed.
  if (inFlight) {
    // Parse via the SHARED backlog parser (readBacklogStages — stage 83
    // extraction): the same files, H1/Type regexes, `[stage N]` titles and
    // N-ascending order as before, now also feeding the local record replay
    // above so the two substrates can never drift.
    for (const st of readBacklogStages(repoDir)) {
      const res = spawn(
        'gh',
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          st.title,
          '--label',
          st.type,
          '--body-file',
          st.filePath,
        ],
        childOpts,
      );
      if (!ok(res)) {
        return {
          ok: false,
          step: 'replay',
          reason: `benchmark replay failed creating '${st.title}' issue in ${repo}`,
        };
      }
    }
  }

  return {
    ok: true,
    fixture,
    repo,
    url: `https://github.com/${repo}`,
    created_at: now.toISOString(),
    // Stage 56: the local checkout dir. The run half writes the fixture's
    // .verity/autonomy.yml here and reads its usage ledger from here — additive
    // to the stage-55 manifest entry (no existing field changes).
    dir: repoDir,
  };
}

// --- run / collect (stage 56, ADR-0025 §4–5) --------------------------------
// The meaty half: for each ENABLED fixture × config.runs, PROVISION a fresh
// dated repo (stage 55), APPLY the per-role agent variant + caps to its policy,
// SEED the backlog, DRIVE the pipeline via `verity-worker --once` + `operator
// snapshot`, then COLLECT a Verity-observed scorecard into a results record.
// Everything that spends, creates a repo, or hits the network is behind an
// injectable seam (provision / spawn / snapshotReader / ledgerReader / clock),
// so the suite drives a FAKE pipeline with zero real effect.

const DEFAULT_MAX_TICKS = 50;
// Stage 68 (ADR-0027): the bounded wait the drive loop takes between ticks while
// the snapshot reports `waiting_for_ci` — a just-opened PR whose CI GitHub has
// not registered yet. Without it the loop would spawn `--once` ticks back-to-
// back and burn the whole tick budget spinning while CI is in flight (each tick
// idles cleanly — `next.decide` defers the gate within the registration grace).
// A few seconds lets GitHub register the checks; injectable for tests.
const DRIVE_CI_WAIT_MS = 5000;

// Which fixtures a run targets: `--fixture X` narrows to that one; otherwise
// every fixture in config, minus any explicitly toggled `enabled:false`. A
// fixture without an `enabled` key is on (matches provision's stage-55 shape).
function selectFixtures(config, only) {
  const all = config.fixtures || {};
  const isOn = (id) => Boolean(all[id]) && all[id].enabled !== false;
  if (typeof only === 'string' && only !== '') {
    return isOn(only) ? [only] : [];
  }
  return Object.keys(all).filter(isOn);
}

// Write the fixture's `.verity/autonomy.yml` from the config's variant (ADR-0025
// §4.2): the per-role `agent` block (ADR-0024) verbatim + the policy caps, so an
// autonomous build self-limits. Serialized through autonomy's OWN toYaml — the
// harness authors the file the worker will later load, it does not reimplement
// the policy shape. Caps read from config.limits (fallback variant.limits).
function writeVariant(dir, config) {
  const variant = config.variant || {};
  const caps = config.limits || variant.limits || {};
  const policy = {};
  // A benchmark run IS an autonomous measurement — default `mode` to `autonomous`
  // so a variant that omits it is not silently DISABLED (the engine default is
  // mode:manual = the worker exits "autonomy disabled"). An explicit
  // variant.mode/config.mode still wins (e.g. 'supervised' to measure with gates).
  policy.mode = variant.mode || config.mode || 'autonomous';
  if (variant.agent && typeof variant.agent === 'object') {
    policy.agent = variant.agent;
  }
  // Stage 75: plumb the variant's review trust into the policy so an autonomous
  // run can build the WHOLE backlog (the T13 trust ladder auto-merges each green,
  // approved stage and chains to the next). Passed through VERBATIM (like
  // `policy.agent`) — the autonomy schema (`review.trust` int, 0..2) is the sole
  // validator, so an out-of-range value surfaces as ITS load error, not a silent
  // coercion here. Absent ⇒ NO `review` block written: the provisioned repo keeps
  // the engine default `review.trust: 0` (gate at review:merge after stage 1) —
  // byte-identical to pre-stage output, the default-OFF / no-regression guarantee.
  if (variant.review && typeof variant.review === 'object' && variant.review.trust !== undefined) {
    policy.review = { trust: variant.review.trust };
  }
  // Stage 79 (ADR-0029): plumb the variant's delivery substrate through VERBATIM
  // (variant wins over config, like `mode` above) — the autonomy schema
  // (`substrate`, github|local) is the sole validator, so a junk value surfaces
  // as ITS fail-closed load error, not a silent coercion here. Absent ⇒ NO key
  // written: the provisioned repo resolves the engine default (github) —
  // byte-identical output, the default-OFF / no-regression guarantee. Stage 83
  // wired the driver end-to-end: provision/run read the SAME resolution
  // (configSubstrate) so the written policy and the provisioning path agree.
  const substrate = configSubstrate(config);
  if (substrate !== undefined) {
    policy.substrate = substrate;
  }
  const limits = {};
  if (caps.max_runs_per_day !== undefined) {
    limits.max_runs_per_day = caps.max_runs_per_day;
  }
  if (caps.max_usd_per_day !== undefined) {
    limits.max_usd_per_day = caps.max_usd_per_day;
  }
  // Claude (and any provider without VERIFIED cost) reports UNKNOWN cost
  // (ADR-0008). The engine default `unknown_cost_behavior: 'gate'` PAUSES the run
  // at a human gate on the FIRST such role — which stalls every autonomous claude
  // benchmark at plan. A benchmark bounds spend by its token/run caps instead, so
  // default to 'allow_with_token_limit' (overridable via variant/limits to 'gate'
  // or 'fail' to measure with the pause).
  limits.unknown_cost_behavior =
    variant.unknown_cost_behavior || caps.unknown_cost_behavior || 'allow_with_token_limit';
  policy.limits = limits;
  const file = path.join(dir, '.verity', 'autonomy.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${autonomy.toYaml(policy)}\n`);
  return { path: file, policy };
}

// Default snapshot reader: shell `verity operator snapshot --repo <r> --json`
// and parse the one compact object it prints. An unreadable/failed read is an
// honest online:false (never a fabricated all-clear). Injectable so the suite
// drives a fake pipeline with zero network.
//
// Stage 85 (ADR-0029; stage-83 review carry-forward 4): substrate-aware. On a
// LOCAL-substrate entry the snapshot must target the LOCAL repo — the cwd the
// spawn already carries — not a github owner/slug: the manifest repo id names
// no GitHub repository there (operator.snapshot on local nulls `repository`
// and must never be dressed by a --repo), so the local read DROPS the flag and
// lets the repo's committed `substrate: local` policy resolve the acquirer.
// The substrate is resolved from that same committed policy
// (substrateLocal.resolveSubstrate over ctx.cwd — absent/unreadable ⇒ github),
// so the real drive loop needs no test-only override. github: byte-identical
// argv, spawn-arg pinned.
function defaultSnapshotReader(repo, ctx = {}) {
  const spawn = ctx.spawn || defaultSpawn;
  const substrate =
    ctx.substrate === undefined
      ? substrateLocal.resolveSubstrate(ctx.cwd || process.cwd())
      : ctx.substrate;
  const args =
    substrate === 'local'
      ? [VERITY_BIN, 'operator', 'snapshot', '--json']
      : [VERITY_BIN, 'operator', 'snapshot', '--repo', repo, '--json'];
  const res = spawn(process.execPath, args, { cwd: ctx.cwd, encoding: 'utf8' });
  if (!ok(res) || !res.stdout) {
    return { online: false };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { online: false };
  }
}

// Classify one operator snapshot into the drive loop's stop signal, using ONLY
// the snapshot's own Verity/GitHub-observed fields (ADR-0025 §5 — nothing the
// operator surface does not already report):
//   gated   a human gate is present (needs_human / awaiting_approval bucket) —
//           the run stops HERE and never bypasses it (ADR-0025 §4)
//   done    no next action AND the active pipeline buckets are drained
//   working otherwise (including an offline/unknown read — keep driving until
//           the tick cap rather than call an unobserved queue "done")
function driveStatus(snap) {
  if (!snap || typeof snap !== 'object') {
    return 'working';
  }
  const q = snap.queue || {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  if (num(q.needs_human) > 0 || num(q.awaiting_approval) > 0) {
    return 'gated';
  }
  const active = num(q.ready) + num(q.in_progress) + num(q.waiting_for_ci);
  const noNext = snap.next === null || snap.next === undefined;
  if (noNext && active === 0 && snap.online !== false) {
    return 'done';
  }
  return 'working';
}

// The DRIVE loop (ADR-0025 §4). READ the snapshot, then either STOP (done /
// gated) or, if under the tick cap, spawn ONE `verity-worker --once` tick and
// read again. The snapshot is read BEFORE each tick, so a gate stops the loop
// with NO further worker spawned — the gate is a recorded outcome, not bypassed.
// `while (stopReason === null)` terminates: every non-terminal pass increments
// ticks toward maxTicks, which then trips 'max_ticks'.
//
// `ctx.firstSnap` (stage 57): the OBSERVED post-plan-tick snapshot run() already
// read is threaded in as the loop's FIRST snapshot, so the seed-verify check
// never costs an extra `operator snapshot` read. Absent, the loop reads every
// pass as before. `ctx.initialTicks` seeds the tick counter so the plan tick
// run() already spent counts against the same tick budget (default 0).
function drivePipeline(ctx) {
  const { repo, dir, spawn, snapshotReader, maxTicks } = ctx;
  // Stage 68 (ADR-0027): between-tick wait while CI is registering — injectable
  // (a no-op in the suite), a real bounded blocking sleep in production.
  const sleep = typeof ctx.sleep === 'function' ? ctx.sleep : blockingSleep;
  const waitMs = Number.isInteger(ctx.waitMs) && ctx.waitMs >= 0 ? ctx.waitMs : DRIVE_CI_WAIT_MS;
  let ticks = Number.isInteger(ctx.initialTicks) ? ctx.initialTicks : 0;
  let stopReason = null;
  let finalSnap = null;
  let pendingSnap = ctx.firstSnap;
  while (stopReason === null) {
    if (pendingSnap !== undefined) {
      finalSnap = pendingSnap;
      pendingSnap = undefined;
    } else {
      finalSnap = snapshotReader(repo, { spawn, cwd: dir });
    }
    const status = driveStatus(finalSnap);
    if (status === 'done') {
      stopReason = 'done';
    } else if (status === 'gated') {
      stopReason = 'gated';
    } else if (ticks >= maxTicks) {
      stopReason = 'max_ticks';
    } else {
      // Stage 68 (ADR-0027): the status is `working`. If it is working BECAUSE a
      // just-opened PR's CI is still registering (`waiting_for_ci > 0`), wait a
      // bounded interval before the next `--once` tick so GitHub can register
      // the checks — otherwise the loop spends its whole tick budget spinning
      // while CI is in flight. The gate is NEVER bypassed: a real gate stops the
      // loop above (`status === 'gated'`) before this branch is ever reached.
      const waiting = finalSnap?.queue;
      if (waiting && typeof waiting.waiting_for_ci === 'number' && waiting.waiting_for_ci > 0) {
        sleep(waitMs);
      }
      spawn('verity-worker', ['--repo', repo, '--once'], { cwd: dir, encoding: 'utf8' });
      ticks += 1;
    }
  }
  return { ticks, stopReason, finalSnap };
}

// The run's outcome (ADR-0025 §5 — read from the snapshot / final state). A gate
// or tick-cap is itself the terminal outcome; a done run reports the snapshot's
// Verity-observed worker outcome when present, else 'success'. Never inferred
// beyond what the stop reason and the final snapshot already establish.
function outcomeFrom(snap, stopReason) {
  if (stopReason === 'gated') {
    return 'gated';
  }
  if (stopReason === 'max_ticks') {
    return 'incomplete';
  }
  const observed = snap?.worker?.last_outcome;
  return typeof observed === 'string' && observed !== '' ? observed : 'success';
}

// ADR-0008: verified (known) spend from a role/total group. `knownSum` is the
// sum of rows that reported a cost; when NOTHING could be priced (every row
// unknown ⇒ knownSum 0 with unknown rows present) that is `null` — an honest
// unknown, NEVER a fabricated $0. A genuine verified $0 (no unknown rows) stays
// 0. A partial group keeps its known floor beside cost_unknown:true.
function knownCost(knownSum, unknownRows) {
  if (unknownRows > 0 && knownSum === 0) {
    return null;
  }
  return Number(knownSum.toFixed(4));
}

// The stable group key usage.rollupByRole uses (the row's role, else its joined
// roles, else unattributed) — so per-role provider/model telemetry lines up with
// the numeric rollup groups.
function roleKey(r) {
  return r.role || r.roles.join('+') || '(unattributed)';
}

// COLLECT the Verity-observed scorecard from the usage-ledger rows (ADR-0025 §5).
// Totals via usage.rollup; per-worker attribution via usage.rollupByRole (the
// SAME derivations the operator surface reads), enriched with the stage-53
// provider/model telemetry (first non-empty seen per role — never summed).
function collectScorecard(rows, timeSecs) {
  const totals = usage.rollup(rows);
  const byRoleRollup = usage.rollupByRole(rows);
  const meta = {};
  for (const r of rows) {
    const key = roleKey(r);
    if (!meta[key]) {
      meta[key] = { provider: '', model: '' };
    }
    if (!meta[key].provider && r.provider) {
      meta[key].provider = r.provider;
    }
    if (!meta[key].model && r.model) {
      meta[key].model = r.model;
    }
  }
  const by_role = Object.keys(byRoleRollup).map((role) => {
    const g = byRoleRollup[role];
    return {
      role,
      provider: meta[role]?.provider || null,
      model: meta[role]?.model || null,
      tokens_in: g.tokens_in,
      tokens_out: g.tokens_out,
      est_usd: knownCost(g.est_usd, g.unknown_cost_rows),
      tool_calls: g.tool_calls,
    };
  });
  const scorecard = {
    time_secs: timeSecs,
    tokens_in: totals.tokens_in,
    tokens_out: totals.tokens_out,
    est_usd: knownCost(totals.est_usd, totals.unknown_cost_rows),
    cost_unknown: totals.unknown_cost_rows > 0,
  };
  return { scorecard, by_role };
}

// Persist one results record as `<run_id>.json` under the results dir (default
// benchmark/results under the repo root; injectable as opts.resultsDir).
// Best-effort — a write failure never sinks the run, the record is still
// returned. Disable entirely with opts.write:false.
function writeRecord(record, opts, repoRoot) {
  if (opts.write === false) {
    return null;
  }
  const dirPath = opts.resultsDir || path.join(repoRoot, 'benchmark', 'results');
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const file = path.join(dirPath, `${record.run_id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
  } catch {
    return null;
  }
}

// run — the stage-56 command. For each enabled fixture × config.runs: provision,
// apply the variant + caps, seed the backlog, drive the pipeline to done/gate/
// cap, and collect a Verity-observed scorecard into a results record. Returns
// { ok, results, manifest }. Dark config ⇒ inert honest return (kill-switch).
function run(opts = {}) {
  const config = opts.config || loadConfig(opts.configPath);
  // The process env is injectable so the seed-identity override (seed_token_env)
  // is testable without touching the real environment.
  const env = opts.env || process.env;
  if (!config.enabled) {
    return {
      ok: false,
      enabled: false,
      reason: config.reason || 'benchmark is dark — no valid benchmark.json with enabled:true',
    };
  }
  const fixtures = selectFixtures(config, opts.fixture);
  if (fixtures.length === 0) {
    return {
      ok: false,
      reason:
        typeof opts.fixture === 'string' && opts.fixture !== ''
          ? `unknown or disabled benchmark fixture '${opts.fixture}'`
          : 'no enabled benchmark fixtures in config',
    };
  }

  const runsN = Number.isInteger(config.runs) && config.runs > 0 ? config.runs : 1;
  const maxTicks =
    Number.isInteger(opts.maxTicks) && opts.maxTicks >= 0 ? opts.maxTicks : DEFAULT_MAX_TICKS;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const provisionFn = opts.provision || provision;
  const spawn = opts.spawn || defaultSpawn;
  const snapshotReader = opts.snapshotReader || defaultSnapshotReader;
  const ledgerReader = opts.ledgerReader || ((dir) => usage.readUsage(dir));
  const repoRoot = opts.repoRoot || opts.cwd || process.cwd();
  // Stage 83 (ADR-0029): the run half reads the SAME substrate resolution
  // provision and writeVariant use (configSubstrate), so seed/drive/record can
  // never disagree with the provisioned repo's policy. 'local' reroutes ONLY
  // the intake pieces that were GitHub issues (seed + visibility) through the
  // stage-80 work-item store; absent/'github' is byte-identical.
  const local = configSubstrate(config) === 'local';

  const results = [];
  const manifest = [];

  for (const fixture of fixtures) {
    for (let i = 0; i < runsN; i += 1) {
      const startedAt = clock();
      const entry = provisionFn(fixture, {
        config,
        repoRoot,
        now: startedAt,
        spawn,
        cwd: opts.cwd,
        workdir: opts.workdir,
      });
      manifest.push(entry);
      if (!entry || !entry.ok) {
        results.push({
          run_id: `${fixture}-run${i + 1}`,
          fixture,
          repo: entry ? (entry.repo ?? null) : null,
          started_at: startedAt.toISOString(),
          completed_at: startedAt.toISOString(),
          variant: config.variant ?? null,
          outcome: 'infra_error',
          stop_reason: null,
          reason: entry ? entry.reason : 'provision returned nothing',
          scorecard: null,
          by_role: [],
          human_grade: null,
        });
        continue;
      }

      const dir = entry.dir;
      // Apply the per-role variant + caps to the fixture BEFORE driving, so the
      // autonomous build self-limits (ADR-0025 §4.2). Applies to BOTH modes —
      // the build role is capped the same whether the plan was just done here
      // (greenfield) or already committed (in-flight).
      writeVariant(dir, config);

      // Stage 83 (ADR-0029): on the local substrate the variant policy is part
      // of the repo's COMMITTED state — the stage-82 gate runner refuses on ANY
      // dirty tree (SHA-pinned record honesty), so an uncommitted
      // .verity/autonomy.yml would turn every gate run into a refusal. Commit
      // it (pathspec-only, stage-80 writer style) through the same injectable
      // spawn as every other step — fail-surfaced, never silent. github/absent:
      // no commit, byte-identical to before this stage.
      if (local) {
        const variantRel = path.join('.verity', 'autonomy.yml');
        // Stage 85 (operator-smoke runs 4/5 root cause): the variant commit
        // lands on the LOCAL default branch AFTER provision's initial push —
        // so without the push below, `origin/<default>`'s tree never carries
        // `substrate: local`, and every stage branch (stage-77/78 base
        // freshness forks off origin/<default>, git-lifecycle resolveBase
        // rung 1) checks out a tree WITHOUT the policy. The dispatched role's
        // cwd is that checkout, so every role-shelled engine command
        // (`verity state`, `verity stage pr`, `verity operator snapshot`)
        // resolved substrate 'github' from the policy-less tree and honestly
        // ran the github code paths — the smoke's leaked gh calls. INVARIANT:
        // by the time any stage branch can be cut, origin/<default>'s tree
        // carries the substrate policy — so the commit is PUSHED before the
        // first worker tick, through the same injectable spawn, fail-surfaced.
        // (The github run half has no such skew: writeVariant's policy stays
        // an UNCOMMITTED working-tree file there — never committed, never
        // pushed — and a branch checkout carries uncommitted files along, so
        // roles always see it; zero new spawns on github, byte-identical.)
        const branchName = entry.default_branch;
        const variantSteps = [
          ['add', '--', variantRel],
          [
            'commit',
            '-m',
            'chore: benchmark variant policy (stage 83, ADR-0029)',
            '--',
            variantRel,
          ],
          ...(typeof branchName === 'string' && branchName !== ''
            ? [['push', '--quiet', 'origin', branchName]]
            : []),
        ];
        for (const args of variantSteps) {
          const res = spawn('git', args, { cwd: dir, encoding: 'utf8' });
          if (!ok(res)) {
            const d = failDetail(res);
            return {
              ok: false,
              step: 'variant',
              reason: `benchmark run failed ${
                args[0] === 'push'
                  ? `pushing the variant policy to origin/${branchName} (stage 85: stage branches fork from origin/<default>, which must carry the substrate policy before any branch is cut)`
                  : 'committing the variant policy'
              } in ${dir}${d ? `: ${d}` : ''}`,
              results,
              manifest,
            };
          }
        }
      }

      // Fork the per-run body per fixture mode (stage 61, ADR-0025). Detect
      // in-flight the SAME way provision does — a committed stage backlog
      // (`stages_dir`), never a second signal. An in-flight fixture is ALREADY
      // planned: stage 60 copied its backlog and replayed the `[stage N]`
      // issues, so there is no request to seed and no plan tick to spend. A
      // greenfield fixture (no `stages_dir`) runs the byte-identical stage-56/57
      // seed → plan-tick → seed-verify sequence. Both modes converge on the
      // SAME drive → collect → record tail below.
      const fixtureDef = config.fixtures[fixture];
      const inFlight = fixtureDef && fixtureDef.stages_dir !== undefined;

      let drive;
      if (inFlight) {
        // BUILD-ONLY (stage 61). No `verity:request` seed, no plan tick, no
        // seed-verify — those are greenfield-only (there is no request to plan;
        // the backlog is already planned + replayed by provision). The build-
        // side analogue of seed-verify is backlog-verify below.
        //
        // backlog-verify (fail-closed): read the FIRST operator snapshot and
        // assert the replayed backlog is actually BUILD-DRIVABLE. If it reads
        // terminal-`done` (empty next / no pending stage) the replay did not
        // take — the `[stage N]` issues did not match the committed stage files
        // (title prefix / numbering) — so there is nothing to build. Fail LOUD,
        // grounded in what happened; never a scorecard for a run that built
        // nothing (the build-side of the silent-empty hazard #145).
        const firstSnap = snapshotReader(entry.repo, { spawn, cwd: dir });
        if (driveStatus(firstSnap) === 'done') {
          return {
            ok: false,
            step: 'backlog-verify',
            reason: `in-flight fixture ${fixture} produced no build-drivable stage in ${entry.repo} — the replayed [stage N] issues did not match the committed stage files (title prefix / numbering). Check the stages_dir backlog.`,
            results,
            manifest,
          };
        }

        // Drive the build directly from that observed first snapshot. NO plan
        // tick was spent, so the tick budget starts at 0 (initialTicks:0) —
        // greenfield uses 1 because its plan tick counts. Same stop conditions
        // (done / gated / max_ticks); the gate is NEVER bypassed.
        drive = drivePipeline({
          repo: entry.repo,
          dir,
          spawn,
          snapshotReader,
          maxTicks,
          firstSnap,
          initialTicks: 0,
          // Stage 68 (ADR-0027): the same injectable sleep the seed-verify poll
          // uses, so a fresh PR's CI-registration wait is a no-op in tests.
          sleep: typeof opts.sleep === 'function' ? opts.sleep : blockingSleep,
          waitMs: Number.isInteger(opts.driveWaitMs) ? opts.driveWaitMs : undefined,
        });
      } else {
        // GREENFIELD (stage 56/57) — byte-identical to before the fork.
        // Seed the backlog through the REAL intake path: create the GitHub
        // REQUEST ISSUE (label `verity:request`) from the fixture spec. That is
        // what the scanner's P4 tier lists and the worker plans — the driven
        // worker's own plan-role dispatch (KNOWN_AGENT_ROLES includes `plan`)
        // picks it up on the next tick. `verity plan` is NOT a CLI noun, and
        // provision only wrote `spec.md` as a file — a file is not a plannable
        // backlog, so the seed must create the issue. Injectable spawn — no
        // real gh/planning in the suite.
        //
        // GUARDED like every provision step: a failed seed HALTS with
        // { ok:false, step:'seed' } — never swallowed. Swallowing it (as the
        // pre-review code did with `verity plan`) meant nothing got planned, the
        // first snapshot read `done` on tick 0, and the record was emitted as an
        // outcome:'success' with an EMPTY scorecard — a fabricated all-clear.
        // Resolve the seed identity (seed_token_env). When overriding, the request
        // is CREATED under the seed token (author ≠ worker, so no-self-feeding does
        // not drop it) but the `verity:request` label is applied under the WORKER's
        // ambient identity — an external seed identity can open an issue on a public
        // repo but cannot LABEL it (labeling needs triage/write; GitHub silently
        // drops the label otherwise). With NO override, the single create-with-label
        // is byte-identical to before.
        //
        // Stage 83 (ADR-0029): on the LOCAL substrate the intake is the
        // committed `verity:request` work-item RECORD provision seeded
        // (contract local-work-item v1) — READ through the stage-80 local
        // driver, never gh. No seed-identity override applies (there is no
        // GitHub author, so no no-self-feeding rule to dodge) and NO
        // visibility poll: committed files are strongly consistent — GitHub's
        // search-index lag does not exist here. The plan-tick + seed-verify
        // sequence below is SHARED with the gh path, keyed on `seededNum`.
        let seededNum = null;
        if (local) {
          let intake = null;
          try {
            const localSnap = substrateLocal.fetchLocalSnapshot(dir);
            intake = (localSnap.issues || []).find(
              (it) => it.state === 'OPEN' && it.labels.includes(REQUEST_LABEL),
            );
          } catch {
            intake = null;
          }
          if (!intake) {
            return {
              ok: false,
              step: 'seed',
              reason: `benchmark seed failed for ${entry.repo}: no OPEN ${REQUEST_LABEL} work-item record found in ${dir} — stage-83 local provision seeds the intake record (contract local-work-item v1); re-provision the fixture`,
              results,
              manifest,
            };
          }
          seededNum = String(intake.number);
        } else {
          const seedEnv = seedSpawnEnv(config, env);
          if (!seedEnv.ok) {
            return { ok: false, step: 'seed', reason: seedEnv.reason, results, manifest };
          }
          const overriding = seedEnv.spawnEnv !== undefined;
          const createArgs = [
            'issue',
            'create',
            '--repo',
            entry.repo,
            '--title',
            `Benchmark fixture ${fixture}: ${entry.repo.split('/').pop()}`,
            '--body-file',
            path.join(dir, 'spec.md'),
          ];
          if (!overriding) {
            createArgs.push('--label', REQUEST_LABEL);
          }
          const seedRes = spawn('gh', createArgs, {
            cwd: dir,
            encoding: 'utf8',
            ...(overriding ? { env: seedEnv.spawnEnv } : {}),
          });
          if (!ok(seedRes)) {
            const d = failDetail(seedRes);
            return {
              ok: false,
              step: 'seed',
              reason: `benchmark seed failed for ${entry.repo}: could not create the ${REQUEST_LABEL} intake issue${d ? `: ${d}` : ''}`,
              results,
              manifest,
            };
          }
          if (overriding) {
            // Apply the label under the ambient (worker/owner) identity — the seed
            // token's identity may lack triage rights to label.
            const created =
              typeof seedRes.stdout === 'string' && seedRes.stdout.match(/\/issues\/(\d+)/);
            if (!created) {
              return {
                ok: false,
                step: 'seed',
                reason: `benchmark seed for ${entry.repo}: created the intake issue but could not parse its number from gh output to apply the ${REQUEST_LABEL} label`,
                results,
                manifest,
              };
            }
            const labelRes = spawn(
              'gh',
              ['issue', 'edit', created[1], '--repo', entry.repo, '--add-label', REQUEST_LABEL],
              { cwd: dir, encoding: 'utf8' },
            );
            if (!ok(labelRes)) {
              const d = failDetail(labelRes);
              return {
                ok: false,
                step: 'seed',
                reason: `benchmark seed for ${entry.repo}: created the intake issue but could not apply the ${REQUEST_LABEL} label (needs worker write access)${d ? `: ${d}` : ''}`,
                results,
                manifest,
              };
            }
          }

          // Before the plan tick, WAIT for the seeded request to be visible to the
          // scanner's `verity:request` list query — GitHub's read path lags the
          // label write by a few seconds, so an immediate plan tick can find "no
          // eligible work" on a perfectly good request. Poll the same primary query
          // (cheap) to gate the expensive plan tick; a request that never appears in
          // budget is a grounded seed-verify, not a wasted agent tick.
          const seededMatch =
            typeof seedRes.stdout === 'string' && seedRes.stdout.match(/\/issues\/(\d+)/);
          seededNum = seededMatch ? seededMatch[1] : null;
          if (seededNum !== null) {
            const visible = waitForRequestVisible({
              spawn,
              repo: entry.repo,
              dir,
              seededNum,
              attempts: Number.isInteger(opts.visibilityAttempts) ? opts.visibilityAttempts : 8,
              delayMs: Number.isInteger(opts.visibilityDelayMs) ? opts.visibilityDelayMs : 2000,
              sleep: typeof opts.sleep === 'function' ? opts.sleep : blockingSleep,
            });
            if (!visible) {
              return {
                ok: false,
                step: 'seed-verify',
                reason: `seeded #${seededNum} in ${entry.repo} did not become visible to the scanner's \`${REQUEST_LABEL}\` query within the wait budget — GitHub label-write propagation lag, or the seed's label step did not take. Re-run; if it persists, verify the intake issue carries the ${REQUEST_LABEL} label.`,
                results,
                manifest,
              };
            }
          }
        }

        // PLAN TICK, then OBSERVED-STATE PLANNABILITY (#145). A successful
        // `gh issue create` proves the intake issue EXISTS — not that the worker
        // planned it. And `operator snapshot`'s next/queue are STAGES-ONLY:
        // ledger.project derives them from local stage files matched to `[stage N]`
        // issues (ledger.cjs), so a bare `verity:request` is not a stage and a
        // PRE-plan snapshot ALWAYS reads terminal-idle at tick 0 — that is "not yet
        // planned", never "done". The worker turns a request INTO stages via
        // scanner.scan()'s P4 tier + its plan-role dispatch (worker/index.cjs),
        // NOT via the snapshot. So DRIVE THE FIRST (plan) TICK before concluding
        // anything, then judge from the OBSERVED post-plan state. This is also what
        // stops the drive loop from terminating at tick 0 for a real fresh request.
        const planTick = spawn('verity-worker', ['--repo', entry.repo, '--once'], {
          cwd: dir,
          encoding: 'utf8',
        });
        const postPlanSnap = snapshotReader(entry.repo, { spawn, cwd: dir });

        // If the snapshot is STILL terminal-idle AFTER the plan tick — no stages
        // materialized, not gated — the worker dispatched nothing OR the plan role
        // FAILED. Fail LOUD, grounded in the worker's ACTUAL output rather than a
        // single hard-coded hypothesis: the live canary showed this same idle state
        // has several real causes (missing labels, autonomy disabled, agent binary
        // not on PATH, expired agent auth) — no-self-feeding is only ONE of them,
        // and hard-asserting it misled every diagnosis. So surface the tick's own
        // stderr/exit, and name no-self-feeding as the likely cause ONLY when the
        // worker said nothing.
        if (driveStatus(postPlanSnap) === 'done') {
          // `seededNum` is substrate-agnostic (stage 83): the gh path parsed it
          // from the seed's issue URL, the local path read it off the record.
          const seededRef = seededNum !== null ? `#${seededNum}` : `the ${REQUEST_LABEL}`;
          const detail = failDetail(planTick);
          const cause = detail
            ? ` The plan-tick worker reported: ${detail}. Resolve that, then re-run.`
            : ` The worker produced no output — the likely cause is the scanner's no-self-feeding rule (a \`${REQUEST_LABEL}\` authored by the worker's own botLogin is dropped); seed the request under a different identity than the worker (see \`seed_token_env\`).`;
          return {
            ok: false,
            step: 'seed-verify',
            reason: `seeded ${seededRef} in ${entry.repo} produced no planned work after a plan tick.${cause}`,
            results,
            manifest,
          };
        }

        // Drive from the OBSERVED post-plan state. The plan tick already ran, so
        // it counts toward the tick budget (initialTicks:1); the post-plan read
        // is threaded as the loop's first snapshot, not re-read.
        drive = drivePipeline({
          repo: entry.repo,
          dir,
          spawn,
          snapshotReader,
          maxTicks,
          firstSnap: postPlanSnap,
          initialTicks: 1,
          // Stage 68 (ADR-0027): bounded CI-registration wait, injectable.
          sleep: typeof opts.sleep === 'function' ? opts.sleep : blockingSleep,
          waitMs: Number.isInteger(opts.driveWaitMs) ? opts.driveWaitMs : undefined,
        });
      }

      // SHARED TAIL (both modes). The path to the drive differed; the scorecard
      // + record are IDENTICAL — same wall-span, ledger read, collectScorecard,
      // record shape, and writeRecord discipline.
      const completedAt = clock();
      const timeSecs = Math.max(
        0,
        Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
      );

      const led = ledgerReader(dir);
      const rows = led && Array.isArray(led.rows) ? led.rows : [];
      const { scorecard, by_role } = collectScorecard(rows, timeSecs);

      const slug = entry.repo.split('/').pop();
      const record = {
        run_id: `${slug}-run${i + 1}`,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        variant: config.variant ?? null,
        fixture,
        repo: entry.repo,
        outcome: outcomeFrom(drive.finalSnap, drive.stopReason),
        stop_reason: drive.stopReason,
        scorecard,
        by_role,
        human_grade: null,
      };
      writeRecord(record, opts, repoRoot);
      results.push(record);
    }
  }

  return { ok: true, results, manifest };
}

// CLI: `verity benchmark provision --config <path> [--fixture D]` and
// `benchmark run --config <path> [--fixture D] [--max-ticks N]`. The surface is
// dark/opt-in — a dark or malformed config is reported honestly, never crashed
// past.
function dispatch(rest = [], flags = {}) {
  const verb = rest[0];
  if (verb === 'provision') {
    const config = loadConfig({ path: flags.config, cwd: flags.cwd });
    if (!config.enabled) {
      return {
        ok: false,
        enabled: false,
        reason:
          config.reason ||
          'benchmark is dark — provide a benchmark.json with enabled:true (see ADR-0025)',
      };
    }
    return provision(flags.fixture || 'D', { config });
  }
  if (verb === 'run') {
    const config = loadConfig({ path: flags.config, cwd: flags.cwd });
    if (!config.enabled) {
      return {
        ok: false,
        enabled: false,
        reason:
          config.reason ||
          'benchmark is dark — provide a benchmark.json with enabled:true (see ADR-0025)',
      };
    }
    const maxTicks = flags['max-ticks'] !== undefined ? Number(flags['max-ticks']) : undefined;
    return run({ config, fixture: flags.fixture, maxTicks, cwd: flags.cwd });
  }
  return {
    ok: false,
    reason: `unknown benchmark verb: ${verb || '(none)'} — use provision or run`,
  };
}

module.exports = {
  loadConfig,
  datedSlug,
  provision,
  run,
  dispatch,
  resolveConfigPath,
  selectFixtures,
  writeVariant,
  drivePipeline,
  driveStatus,
  collectScorecard,
  // Stage 83 (ADR-0029): the shared substrate resolution + backlog parser —
  // exported so the suite pins that provision/run/writeVariant read ONE value
  // and that the gh replay and local record replay share ONE parse.
  configSubstrate,
  readBacklogStages,
  // Stage 85 (ADR-0029): exported so the suite proves the DEFAULT reader (the
  // real drive loop's reader, no test-only override) works against a
  // local-substrate repo with zero gh, and that the github argv stays pinned.
  defaultSnapshotReader,
};
