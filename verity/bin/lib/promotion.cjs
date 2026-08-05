// Promotion projection engine (stage 40, #107 Phase 1) — implements the frozen
// `production-projection` contract v1 (contracts/production-projection.md):
// deterministically transform the dev repo at a source ref into the file tree
// the production repo receives, plus a machine-readable projection report.
//
// Contract invariants enforced here (never weaken):
//   1. Empty tree start — staging dir is created empty; a non-empty --out is refused.
//   2. Public-only copy — a path is copied iff it resolves to bucket `public`
//      under the classification; private/generated are counted, never copied.
//   3. Fail closed — unclassified path, ambiguous tie, or a missing/unparsable
//      classification aborts non-zero. Under NO failure mode is the whole tree copied.
//   4. Secret scan — staged content is scanned before the projection is declared
//      built; a hit aborts. No secret value ever appears in a report or log.
//   5. Read-only on the repo — only `git rev-parse` / `ls-tree` / `show` are run;
//      never the working tree, never a write to index/refs/remotes.
//   6. Determinism — identical (source ref, classification content) yields an
//      identical staging tree and staging_digest (content-only, no timestamps).
//
// The allowlist derives DIRECTLY from .verity/production-content-classification.yml
// at CURRENT HEAD (present-day policy applied to historical trees) via the ONE
// shared matcher (classification.cjs) — there is no second manifest file.
//
// Exit codes (mapped by exitCodeFor, house 0/20/30 convention): 0 built,
// 20 contract violation, 30 infra failure. The projection report JSON is
// written even on failure; failed runs leave no half-usable staging tree.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const classification = require('./classification.cjs');
const promotionConfig = require('./promotion-config.cjs');
const ledger = require('./ledger.cjs');
const gh = require('./gh.cjs');
const { sanitize } = require('./changelog-sanitize.cjs');

const CLASSIFICATION_PATH = '.verity/production-content-classification.yml';

const EXIT_BUILT = 0;
const EXIT_CONTRACT = 20;
const EXIT_INFRA = 30;

// High-precision credential shapes only. The GitHub shapes are ported from the
// repo's hygiene tooling (ledger.cjs TOKEN_SHAPES); the rest are the standard
// unambiguous key prefixes for the providers this ecosystem actually touches —
// LLM API keys above all (docs/autonomy.md tells operators to configure
// ANTHROPIC_API_KEY, so an sk-ant- key is the single most probable secret
// here). Deliberately NOT ported from ledger.cjs: the bare 40-hex shape and
// the authorization-line shape — those are REDACTION patterns (over-matching
// is safe there) and would false-positive on legitimate public content
// (fixture commit SHAs in tests/, prose mentioning "token"). A scanner that
// can never pass is as useless as one that never fires. Reports carry path +
// pattern name ONLY — never the matched value.
const SECRET_PATTERNS = [
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ }, // ghp_/gho_/ghu_/ghs_/ghr_
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{16,}/ },
  { name: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'openai-api-key', re: /\bsk-proj-[A-Za-z0-9_-]{16,}/ },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

class PromotionError extends Error {
  constructor(message, exitCode, failures) {
    super(message);
    this.exitCode = exitCode;
    this.failures = failures;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Read-only git. Buffer output by default (blob contents are binary-safe);
// callers that want text call .toString('utf8').
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitFirstError(err) {
  const text = String(err.stderr || err.message || err);
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) || 'git failed with no diagnostic'
  );
}

// Invariant 1: the staging root starts EMPTY. --out must not exist (we create
// it) or be an existing empty directory; anything else is refused before a
// single byte is copied.
function prepareStaging(out) {
  if (!out) {
    return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'verity-projection-')), created: true };
  }
  const dir = path.resolve(out);
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length > 0) {
      throw new PromotionError(
        `staging dir must not exist or be an empty directory: ${dir}`,
        EXIT_CONTRACT,
      );
    }
    return { dir, created: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  return { dir, created: true };
}

// Failed runs leave no half-usable staging tree: remove everything we staged.
// A tmp/created dir is removed outright; a caller-supplied pre-existing (empty)
// dir is emptied back out but left in place.
function cleanupStaging(staging) {
  if (!staging) {
    return;
  }
  if (staging.created) {
    fs.rmSync(staging.dir, { recursive: true, force: true });
    return;
  }
  for (const entry of fs.readdirSync(staging.dir)) {
    fs.rmSync(path.join(staging.dir, entry), { recursive: true, force: true });
  }
}

// `git ls-tree -r -z <sha>` entries: "<mode> <type> <oid>\t<path>".
function parseLsTree(text) {
  const out = [];
  for (const entry of text.split('\u0000')) {
    if (entry === '') {
      continue;
    }
    const m = /^(\d{6}) (\S+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!m) {
      throw new PromotionError(`unparsable ls-tree entry: ${entry}`, EXIT_INFRA);
    }
    out.push({ mode: m[1], type: m[2], path: m[4] });
  }
  return out;
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

// The result envelope: the contract report shape plus CLI conveniences.
function envelope(report, stagingDir, reportPath, exitCode, rawSuffix) {
  const raw =
    report.verdict === 'built'
      ? `built: ${report.files_projected} files → ${stagingDir}`
      : `failed: ${rawSuffix}`;
  return { ...report, staging_dir: stagingDir, report_path: reportPath, exit_code: exitCode, raw };
}

// project(sourceRef, opts) — build the projection. opts: cwd (repo dir),
// out (staging dir), report (report path). Returns the result envelope in all
// outcome cases (verdict + exit_code); throws only on programmer misuse.
function project(sourceRef, opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const report = {
    schema: 1,
    source_ref: String(sourceRef),
    source_commit: null,
    classification_digest: null,
    staging_digest: null,
    files_projected: 0,
    files_omitted: { private: 0, generated: 0 },
    verdict: 'failed',
    failures: [],
  };
  let staging = null;
  let reportPath = opts.report ? path.resolve(opts.report) : null;

  try {
    staging = prepareStaging(opts.out);
    if (!reportPath) {
      reportPath = `${staging.dir}.report.json`;
    }

    // 1. Resolve the source ref to a full commit SHA (read-only).
    let sha;
    try {
      sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${sourceRef}^{commit}`])
        .toString('utf8')
        .trim();
    } catch (err) {
      throw new PromotionError(
        `cannot resolve source ref ${sourceRef}: ${gitFirstError(err)}`,
        EXIT_INFRA,
      );
    }
    report.source_commit = sha;

    // 2. Classification at CURRENT HEAD (contract "Consumes" §2 — present-day
    //    policy applied to historical trees; NEVER the working tree).
    let classificationBytes;
    try {
      classificationBytes = git(cwd, ['show', `HEAD:${CLASSIFICATION_PATH}`]);
    } catch (_err) {
      throw new PromotionError(
        `classification missing at HEAD (${CLASSIFICATION_PATH}) — failing closed`,
        EXIT_CONTRACT,
      );
    }
    report.classification_digest = `sha256:${sha256(classificationBytes)}`;
    let matchers;
    try {
      const compiled = classification.compile(
        classification.parseClassification(classificationBytes.toString('utf8')),
      );
      if (compiled.rules.length === 0) {
        throw new Error('rules list is empty');
      }
      matchers = compiled.matchers;
    } catch (err) {
      throw new PromotionError(
        `classification unusable: ${err.message} — failing closed`,
        EXIT_CONTRACT,
      );
    }

    // 3. Enumerate the source TREE at the ref and classify EVERY path before
    //    copying anything (invariants 2 + 3: one unresolvable path fails the
    //    whole projection, and nothing has been staged yet when it does).
    const entries = parseLsTree(git(cwd, ['ls-tree', '-r', '-z', sha]).toString('utf8'));
    const publicFiles = [];
    const problems = [];
    for (const e of entries) {
      if (e.mode !== '100644' && e.mode !== '100755') {
        problems.push({ path: e.path, reason: `unsupported tree entry (mode ${e.mode})` });
        continue;
      }
      const r = classification.resolve(matchers, e.path);
      if (r.error) {
        problems.push({ path: e.path, reason: r.error });
      } else if (r.bucket === 'public') {
        publicFiles.push(e);
      } else if (r.bucket === 'private' || r.bucket === 'generated') {
        report.files_omitted[r.bucket] += 1;
      } else {
        problems.push({ path: e.path, reason: `unknown bucket ${JSON.stringify(r.bucket)}` });
      }
    }
    if (problems.length > 0) {
      throw new PromotionError(
        `${problems.length} unresolvable path(s) — failing closed`,
        EXIT_CONTRACT,
        problems,
      );
    }

    // 4. Materialize public paths into the (empty) staging dir, digesting and
    //    secret-scanning each blob as staged (invariant 4).
    const digests = [];
    const secretHits = [];
    for (const e of publicFiles) {
      const content = git(cwd, ['show', `${sha}:${e.path}`]);
      const dest = path.join(staging.dir, e.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, { mode: e.mode === '100755' ? 0o755 : 0o644 });
      digests.push([e.path, sha256(content)]);
      const haystack = content.toString('latin1');
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(haystack)) {
          // Path + pattern name ONLY — the matched value must never surface.
          secretHits.push({ path: e.path, reason: `secret scan hit: ${p.name}` });
        }
      }
    }
    if (secretHits.length > 0) {
      throw new PromotionError('secret scan failed', EXIT_CONTRACT, secretHits);
    }

    // 5. staging_digest = sha256 over the sorted (path, per-file sha256) pairs
    //    (contract schema) — content-only, so it is timestamp/environment-free.
    digests.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const h = crypto.createHash('sha256');
    for (const [p, d] of digests) {
      h.update(`${p}\u0000${d}\n`);
    }
    report.staging_digest = `sha256:${h.digest('hex')}`;
    report.files_projected = digests.length;
    report.verdict = 'built';
    writeReport(reportPath, report);
    return envelope(report, staging.dir, reportPath, EXIT_BUILT);
  } catch (err) {
    const exitCode = Number.isInteger(err.exitCode) ? err.exitCode : EXIT_INFRA;
    report.verdict = 'failed';
    report.failures =
      Array.isArray(err.failures) && err.failures.length > 0
        ? err.failures
        : [{ path: null, reason: err.message }];
    cleanupStaging(staging);
    if (!reportPath) {
      reportPath = opts.out
        ? `${path.resolve(opts.out)}.report.json`
        : path.join(
            os.tmpdir(),
            `verity-projection-failed-${process.pid}-${Date.now()}.report.json`,
          );
    }
    try {
      writeReport(reportPath, report);
    } catch (_writeErr) {
      reportPath = null; // report best-effort on failure; the envelope still carries everything
    }
    return envelope(report, null, reportPath, exitCode, err.message);
  }
}

// --- stage 41: verify — prove the projection is a working product ------------
//
// verify(stagingDir, opts) extends the production-projection contract v1
// ADDITIVELY: it reads the projection report (when present), runs the staged
// tree's own quality gates from scratch, inspects the packed tarball's content,
// optionally byte-compares against the published npm artifact, and writes a
// `verify` block into the report. It NEVER changes the `project`-owned fields.
//
//   - In-staging gates (offline, always): npm ci (npm install downgrade only
//     for a structural reason, reported explicitly) → npm run lint → npm test →
//     npm pack. cwd is the STAGING DIR for every gate, never the dev repo.
//   - Pack-content inspection: every tarball entry (stripped of the package/
//     prefix) must exist in the staging tree, and none may resolve to a
//     private/generated bucket under the classification (the ONE shared
//     matcher, classification.cjs — same authority as `project`).
//   - Baseline byte-match (NETWORK, opt-in): only with --baseline <version>
//     AND VERITY_PROMOTION_BASELINE_TEST=1 — the house pattern for network
//     lanes (cf. VERITY_REAL_CODEX_TEST). When the flag is unset the baseline
//     is SKIPPED LOUDLY (stderr message + {skipped, reason} in the report);
//     the exit code then reflects only the offline gates.
//
// Exit codes: 0 gates pass (and baseline matches when actually run) /
// 20 gate failure, pack-content violation, or baseline mismatch / 30 infra.

const BASELINE_GATE = 'VERITY_PROMOTION_BASELINE_TEST';

function sha1File(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

// Baseline comparator — pure bytes, no network. Exported for unit tests.
function compareTarballs(localTarball, fetchedTarball) {
  const local_shasum = sha1File(localTarball);
  const fetched_shasum = sha1File(fetchedTarball);
  return { local_shasum, fetched_shasum, match: local_shasum === fetched_shasum };
}

// Run npm/tar inside the staging tree. spawnSync (not execFileSync) so a
// non-zero exit is data, not an exception — gate failures are reported, and
// only a missing binary is an infra error.
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    throw new PromotionError(`cannot run ${cmd}: ${r.error.message}`, EXIT_INFRA);
  }
  return r;
}

// Brief per-gate summary: the last few non-empty output lines, truncated —
// enough to name the failure, never a full log dump into the report. On
// success stdout alone is preferred (npm tooling chatters on stderr even when
// green); ANSI escapes are stripped so the report stays readable.
function summarize(r) {
  const pick = (text) =>
    String(text || '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI color escapes requires matching ESC
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  let lines = r.status === 0 ? pick(r.stdout) : [...pick(r.stdout), ...pick(r.stderr)];
  if (lines.length === 0) {
    lines = pick(`${r.stdout || ''}\n${r.stderr || ''}`);
  }
  return lines.slice(-3).join(' | ').slice(0, 300) || '(no output)';
}

// Pack-content inspection — exported for unit tests. Lists the REAL tarball
// (tar -t, not npm's own claim), strips the package/ prefix, and checks each
// entry (a) exists in the staging tree and (b) does not resolve to a
// private/generated bucket under the classification.
function inspectPack(tarballPath, stagingDir, matchers) {
  const r = run('tar', ['-tzf', tarballPath]);
  if (r.status !== 0) {
    throw new PromotionError(`tar -tzf failed on ${tarballPath}: ${summarize(r)}`, EXIT_INFRA);
  }
  const entries = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith('/'))
    .map((l) => l.replace(/^package\//, ''));
  const problems = [];
  for (const entry of entries) {
    if (!fs.existsSync(path.join(stagingDir, entry))) {
      problems.push({ path: entry, reason: 'tarball entry missing from staging tree' });
      continue;
    }
    const resolved = classification.resolve(matchers, entry);
    if (resolved.bucket === 'private' || resolved.bucket === 'generated') {
      problems.push({
        path: entry,
        reason: `tarball entry resolves ${resolved.bucket} under the classification (${resolved.pattern})`,
      });
    }
  }
  return { entries, problems };
}

// Compile the classification at the dev repo's HEAD — same authority and same
// failure semantics as project() (fail closed on missing/unusable).
function loadClassification(cwd) {
  let bytes;
  try {
    bytes = git(cwd, ['show', `HEAD:${CLASSIFICATION_PATH}`]);
  } catch (_err) {
    throw new PromotionError(
      `classification missing at HEAD (${CLASSIFICATION_PATH}) — failing closed`,
      EXIT_CONTRACT,
    );
  }
  try {
    const compiled = classification.compile(
      classification.parseClassification(bytes.toString('utf8')),
    );
    if (compiled.rules.length === 0) {
      throw new Error('rules list is empty');
    }
    return compiled.matchers;
  } catch (err) {
    throw new PromotionError(
      `classification unusable: ${err.message} — failing closed`,
      EXIT_CONTRACT,
    );
  }
}

// verify(stagingDir, opts) — opts: cwd (dev repo, classification authority),
// report (projection report path to extend; default <stagingDir>.report.json),
// baseline (published version to byte-compare against, network + opt-in).
// Returns the result envelope in all outcome cases, like project().
function verify(stagingDir, opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const gates = { install: null, lint: null, test: null, pack: null };
  const verifyBlock = { gates, pack_shasum: null, baseline: null, verdict: 'failed' };
  let base = { schema: 1 };
  let reportPath = null;
  const tmpDirs = [];

  const finish = (exitCode, rawSuffix, failures) => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    if (failures && failures.length > 0) {
      verifyBlock.failures = failures;
    }
    verifyBlock.verdict = exitCode === EXIT_BUILT ? 'passed' : 'failed';
    // ADDITIVE on the projection report: every project-owned field is carried
    // through untouched; verify only ever writes the `verify` key.
    const merged = { ...base, verify: verifyBlock };
    if (reportPath) {
      try {
        writeReport(reportPath, merged);
      } catch (_err) {
        reportPath = null;
      }
    }
    const raw =
      exitCode === EXIT_BUILT
        ? `verify passed: install ✓ lint ✓ test ✓ pack ✓${verifyBlock.baseline?.match ? ` baseline ${verifyBlock.baseline.version} ✓` : ''}`
        : `verify failed: ${rawSuffix}`;
    return {
      ...merged,
      staging_dir: path.resolve(String(stagingDir)),
      report_path: reportPath,
      exit_code: exitCode,
      raw,
    };
  };

  try {
    const dir = path.resolve(String(stagingDir));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new PromotionError(`staging dir not found: ${dir}`, EXIT_INFRA);
    }
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      throw new PromotionError(`no package.json in staging dir: ${dir}`, EXIT_INFRA);
    }
    reportPath = opts.report ? path.resolve(opts.report) : `${dir}.report.json`;
    if (fs.existsSync(reportPath)) {
      try {
        base = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch (_err) {
        base = { schema: 1 }; // unreadable prior report: extend a fresh envelope, never guess
      }
    }
    const matchers = loadClassification(cwd);

    // --- gate: install (npm ci from the projected lockfile; npm install only
    // as an explicitly reported structural downgrade) ------------------------
    let installArgs = ['ci', '--no-audit', '--no-fund'];
    let downgrade = null;
    if (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
      downgrade = 'package-lock.json missing from staging tree — npm ci impossible';
      installArgs = ['install', '--no-audit', '--no-fund'];
    }
    let ir = run('npm', installArgs, dir);
    if (ir.status !== 0 && !downgrade && /EUSAGE/i.test(`${ir.stdout}\n${ir.stderr}`)) {
      // Structural npm ci refusal (not a dependency-resolution failure):
      // downgrade to npm install and say so in the report.
      downgrade = `npm ci failed structurally (${summarize(ir)}) — downgraded to npm install`;
      installArgs = ['install', '--no-audit', '--no-fund'];
      ir = run('npm', installArgs, dir);
    }
    gates.install = {
      ok: ir.status === 0,
      command: `npm ${installArgs[0]}`,
      summary: summarize(ir),
    };
    if (downgrade) {
      gates.install.downgraded = true;
      gates.install.reason = downgrade;
    }
    if (!gates.install.ok) {
      return finish(EXIT_CONTRACT, 'install gate failed');
    }

    // --- gates: lint, test (the staged tree's own scripts, in the staging
    // tree, never the dev repo) ---------------------------------------------
    for (const [name, args] of [
      ['lint', ['run', 'lint']],
      ['test', ['test']],
    ]) {
      const r = run('npm', args, dir);
      gates[name] = { ok: r.status === 0, command: `npm ${args.join(' ')}`, summary: summarize(r) };
      if (!gates[name].ok) {
        return finish(EXIT_CONTRACT, `${name} gate failed`);
      }
    }

    // --- gate: pack + content inspection ------------------------------------
    const packDest = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-verify-pack-'));
    tmpDirs.push(packDest);
    const pr = run('npm', ['pack', '--json', '--pack-destination', packDest], dir);
    if (pr.status !== 0) {
      gates.pack = { ok: false, command: 'npm pack', summary: summarize(pr) };
      return finish(EXIT_CONTRACT, 'pack gate failed');
    }
    const tarballs = fs.readdirSync(packDest).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new PromotionError(
        `expected exactly one packed tarball, found ${tarballs.length}`,
        EXIT_INFRA,
      );
    }
    const tarball = path.join(packDest, tarballs[0]);
    verifyBlock.pack_shasum = sha1File(tarball);
    const inspection = inspectPack(tarball, dir, matchers);
    gates.pack = {
      ok: inspection.problems.length === 0,
      command: 'npm pack',
      summary:
        inspection.problems.length === 0
          ? `${tarballs[0]}: ${inspection.entries.length} entries, all present in staging and none private/generated`
          : inspection.problems
              .map((p) => `${p.path}: ${p.reason}`)
              .join(' | ')
              .slice(0, 500),
    };
    if (!gates.pack.ok) {
      return finish(EXIT_CONTRACT, 'pack-content inspection failed', inspection.problems);
    }

    // --- baseline byte-match (network, opt-in) ------------------------------
    if (opts.baseline) {
      const version = String(opts.baseline);
      if (process.env[BASELINE_GATE] !== '1') {
        // LOUD skip — visible even under --json (stderr), recorded in the
        // report, and never readable as a pass or a match.
        const reason = `baseline byte-match is a NETWORK lane and is opt-in: set ${BASELINE_GATE}=1 to fetch and compare the published tarball`;
        process.stderr.write(`promotion verify: baseline ${version} SKIPPED — ${reason}\n`);
        verifyBlock.baseline = { version, skipped: true, reason };
      } else {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const spec = `${pkg.name}@${version}`;
        const fetchDest = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-verify-baseline-'));
        tmpDirs.push(fetchDest);
        const fr = run('npm', ['pack', spec, '--json', '--pack-destination', fetchDest], dir);
        if (fr.status !== 0) {
          throw new PromotionError(`cannot fetch published ${spec}: ${summarize(fr)}`, EXIT_INFRA);
        }
        const fetched = fs.readdirSync(fetchDest).filter((f) => f.endsWith('.tgz'));
        if (fetched.length !== 1) {
          throw new PromotionError(
            `expected exactly one fetched tarball for ${spec}, found ${fetched.length}`,
            EXIT_INFRA,
          );
        }
        const vr = run('npm', ['view', spec, 'dist.shasum'], dir);
        if (vr.status !== 0) {
          throw new PromotionError(
            `npm view ${spec} dist.shasum failed: ${summarize(vr)}`,
            EXIT_INFRA,
          );
        }
        const published_shasum = vr.stdout.trim();
        const cmp = compareTarballs(tarball, path.join(fetchDest, fetched[0]));
        verifyBlock.baseline = {
          version,
          published_shasum,
          local_shasum: cmp.local_shasum,
          match: cmp.match && cmp.fetched_shasum === published_shasum,
        };
        if (!verifyBlock.baseline.match) {
          return finish(EXIT_CONTRACT, `baseline ${version} byte-match FAILED`);
        }
      }
    }

    return finish(EXIT_BUILT);
  } catch (err) {
    const exitCode = Number.isInteger(err.exitCode) ? err.exitCode : EXIT_INFRA;
    return finish(exitCode, err.message, err.failures);
  }
}

// --- stage 43: propose — the promotion PR into prod with provenance ----------
//
// propose(version, opts) turns a VERIFIED projection into an open promotion PR
// in the production repo, plus both provenance records of the frozen
// `promotion-records` contract v1 (contracts/promotion-records.md):
//   - public RELEASE-MANIFEST.json at the promotion tree root, and
//   - private .verity/promotions/PROM-####.yml in the dev repo.
// Every digest/shasum in both records is COPIED from the projection report
// (production-projection contract v1) — never recomputed here.
//
// The promotion tree is CONSTRUCTED, never merged (ADR-0023):
//   promotion tree = (projection, verbatim) ∪ (prod-HEAD files matching
//                     prod_owned globs) — anything in neither set is absent,
//   so deletions fall out naturally. A projection path matching a prod_owned
//   glob violates the disjointness rule and fails closed naming the path.
//   RELEASE-MANIFEST.json is prod-owned but written fresh BY propose.
//
// Preconditions (fail closed, exit 20): prod_repo configured; the projection
// report carries a PASSING verify block (unverified staging is not
// proposable); <version> is semver and > prod's latest tag. Exit codes:
// 0 proposed (or dry-run preview) / 20 contract violation, precondition,
// disjointness / 30 infra (network, clone, push, gh).
//
// --dry-run stops after tree construction + the manifest: it reports what
// WOULD be pushed (tree counts + manifest + kept tree dir) and pushes
// NOTHING — no branch, no PR, no PROM record, no dev commit.
//
// No tagging, no merging, no npm action anywhere in this verb — those are
// `finalize` (stage 44) and human/worker authority.

const PROMOTIONS_DIR = '.verity/promotions';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function semverParts(v) {
  return String(v)
    .replace(/^v/, '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
}

function semverGreater(a, b) {
  const ka = semverParts(a);
  const kb = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((ka[i] || 0) !== (kb[i] || 0)) {
      return (ka[i] || 0) > (kb[i] || 0);
    }
  }
  return false;
}

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

// Next PROM number from the existing .verity/promotions/ files (append-only
// numbering per the contract): 0001 first, then max+1.
function nextPromotionId(cwd) {
  const dir = path.join(cwd, PROMOTIONS_DIR);
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^PROM-(\d{4})\.yml$/.exec(f);
      if (m) {
        max = Math.max(max, Number.parseInt(m[1], 10));
      }
    }
  }
  return `PROM-${String(max + 1).padStart(4, '0')}`;
}

// The dev repo slug (owner/repo) from the origin remote — the PROM record's
// development.repository field. Fail closed when underivable: a provenance
// record that cannot name its own development repository is not a record.
function devRepoSlug(cwd) {
  let url;
  try {
    url = git(cwd, ['remote', 'get-url', 'origin']).toString('utf8').trim();
  } catch (err) {
    throw new PromotionError(
      `cannot determine the dev repository (git remote get-url origin: ${gitFirstError(err)}) — the PROM record must name it`,
      EXIT_CONTRACT,
    );
  }
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) {
    throw new PromotionError(
      'cannot parse a GitHub owner/repo slug from the origin remote — the PROM record must name the dev repository',
      EXIT_CONTRACT,
    );
  }
  return { slug: m[1], url };
}

// Latest semver tag of the prod repo via `git ls-remote --tags` — tag NAMES
// are all propose needs (the "shallow-but-tagged" clone requirement satisfied
// without deepening the clone itself). Read-only against prod.
function prodLatestTag(cwd, prodUrl) {
  let out;
  try {
    out = git(cwd, ['ls-remote', '--tags', prodUrl]).toString('utf8');
  } catch (err) {
    throw new PromotionError(`cannot list tags of ${prodUrl}: ${gitFirstError(err)}`, EXIT_INFRA);
  }
  const names = [];
  for (const line of out.split('\n')) {
    const m = /\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (m && !m[2] && SEMVER_RE.test(m[1].replace(/^v/, ''))) {
      names.push(m[1]);
    }
  }
  return ledger.latestTag(names);
}

// Load the projection report and enforce the verified-staging precondition:
// a built projection whose verify block PASSED, carrying every field the
// promotion records copy. Fail closed on anything less.
function loadVerifiedReport(stagingDir, reportPath) {
  if (!fs.existsSync(stagingDir) || !fs.statSync(stagingDir).isDirectory()) {
    throw new PromotionError(`staging dir not found: ${stagingDir}`, EXIT_CONTRACT);
  }
  if (!fs.existsSync(reportPath)) {
    throw new PromotionError(
      `projection report not found: ${reportPath} — only a verified projection is proposable`,
      EXIT_CONTRACT,
    );
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    throw new PromotionError(`projection report unparsable: ${err.message}`, EXIT_CONTRACT);
  }
  if (report.verdict !== 'built') {
    throw new PromotionError(
      `projection report verdict is ${JSON.stringify(report.verdict)}, not "built" — refusing to propose`,
      EXIT_CONTRACT,
    );
  }
  if (!report.verify || typeof report.verify !== 'object') {
    throw new PromotionError(
      'projection report has no verify block — unverified staging is not proposable (run `verity promotion verify` first)',
      EXIT_CONTRACT,
    );
  }
  if (report.verify.verdict !== 'passed') {
    throw new PromotionError(
      `projection verify verdict is ${JSON.stringify(report.verify.verdict)}, not "passed" — refusing to propose`,
      EXIT_CONTRACT,
    );
  }
  for (const field of ['source_commit', 'classification_digest', 'staging_digest']) {
    if (typeof report[field] !== 'string' || report[field].length === 0) {
      throw new PromotionError(
        `projection report is missing ${field} — the promotion records copy it verbatim`,
        EXIT_CONTRACT,
      );
    }
  }
  if (typeof report.verify.pack_shasum !== 'string' || report.verify.pack_shasum.length === 0) {
    throw new PromotionError(
      'projection verify block is missing pack_shasum — the promotion records copy it verbatim',
      EXIT_CONTRACT,
    );
  }
  if (!Number.isInteger(report.files_projected)) {
    throw new PromotionError(
      'projection report is missing files_projected — propose cannot check the staging tree against it',
      EXIT_CONTRACT,
    );
  }
  return report;
}

// Write git blobs of prod HEAD matching the prod_owned globs into the tree dir.
function carryProdOwned(workdir, treeDir, prodOwnedMatchers) {
  const entries = parseLsTree(git(workdir, ['ls-tree', '-r', '-z', 'HEAD']).toString('utf8'));
  const carried = [];
  for (const e of entries) {
    if (!prodOwnedMatchers.some((m) => m.re.test(e.path))) {
      continue;
    }
    if (e.mode !== '100644' && e.mode !== '100755') {
      throw new PromotionError(
        `prod-owned path ${e.path} has unsupported tree entry mode ${e.mode} — failing closed`,
        EXIT_CONTRACT,
      );
    }
    const content = git(workdir, ['show', `HEAD:${e.path}`]);
    const dest = path.join(treeDir, e.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, { mode: e.mode === '100755' ? 0o755 : 0o644 });
    carried.push(e.path);
  }
  return { carried, prodHeadPaths: entries.map((e) => e.path) };
}

// Writers for the two promotion-records v1 shapes. Every digest/shasum is the
// report's value verbatim; baseline is the matched version or null (a skipped
// or absent baseline is null, never a claimed match).
function baselineOf(report) {
  const b = report.verify.baseline;
  return b && b.match === true ? b.version : null;
}

function buildManifest(version, promotionId, report, promotedAt) {
  return {
    schema: 1,
    version,
    promotion_id: promotionId,
    development_commit: report.source_commit,
    classification_digest: report.classification_digest,
    staging_digest: report.staging_digest,
    package_shasum: report.verify.pack_shasum,
    verify: { gates: 'all-pass', baseline: baselineOf(report) },
    promoted_at: promotedAt,
  };
}

function yamlScalar(v) {
  return v === null ? 'null' : String(v);
}

// The private PROM record (dev side). production.commit / production.tag /
// timestamps.finalized_at are null at propose time — finalize (stage 44) sets
// them; status moves forward only (contract rule).
function buildPromRecord(ctx) {
  return [
    `promotion_id: ${ctx.promotionId}`,
    `version: ${ctx.version}`,
    'status: proposed',
    'development:',
    `  repository: ${ctx.devSlug}`,
    `  commit: ${ctx.report.source_commit}`,
    `  staging_digest: ${ctx.report.staging_digest}`,
    `  classification_digest: ${ctx.report.classification_digest}`,
    'production:',
    `  repository: ${ctx.prodRepo}`,
    `  pull_request: ${yamlScalar(ctx.prNumber)}`,
    '  commit: null',
    '  tag: null',
    'verification:',
    '  gates: all-pass',
    `  package_shasum: ${ctx.report.verify.pack_shasum}`,
    `  baseline: ${yamlScalar(baselineOf(ctx.report))}`,
    'timestamps:',
    `  proposed_at: ${ctx.proposedAt}`,
    '  finalized_at: null',
    '',
  ].join('\n');
}

// Sanitization guard for PUBLIC surfaces (manifest, PR body, prod commit
// message): the dev repo's slug or origin URL must never appear. The record
// fields never carry them by construction; this check makes a future
// regression loud instead of silent.
function assertNoDevIdentifiers(text, dev, what) {
  for (const needle of [dev.slug, dev.url]) {
    if (needle && text.includes(needle)) {
      throw new PromotionError(
        `${what} would leak the dev repository identifier — sanitization failed closed`,
        EXIT_CONTRACT,
      );
    }
  }
}

function buildPrBody(manifest, tree, dev) {
  const body = sanitize(
    [
      `Promotion \`${manifest.promotion_id}\`: Verity v${manifest.version}, constructed per the promotion policy — the new projection verbatim, plus prod-owned paths carried from prod HEAD; everything else is replaced.`,
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Development commit | \`${manifest.development_commit}\` |`,
      `| Staging digest | \`${manifest.staging_digest}\` |`,
      `| Classification digest | \`${manifest.classification_digest}\` |`,
      `| Package shasum | \`${manifest.package_shasum}\` |`,
      '',
      '| Gate | Result |',
      '| --- | --- |',
      '| install / lint / test / pack | all-pass |',
      `| baseline byte-match | ${manifest.verify.baseline ? `matched v${manifest.verify.baseline}` : 'not run'} |`,
      '',
      `Tree: ${tree.projected} projected file(s), ${tree.prod_owned} prod-owned file(s) carried, ${tree.deleted} deleted.`,
      '',
    ].join('\n'),
  );
  assertNoDevIdentifiers(body, dev, 'PR body');
  return body;
}

// propose(version, opts) — opts: cwd (dev repo), staging (verified staging
// dir), report (projection report path; default <staging>.report.json),
// dryRun, prodUrl (clone/push URL override — tests point it at a local bare
// fixture), gh (injectable gh runner, house pattern), commitRecord (default
// true: commit the PROM record to the current dev branch).
// Returns the result envelope in all outcome cases, like project()/verify().
function propose(version, opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const ghRun = opts.gh || ((args) => gh.run(args));
  const result = {
    schema: 1,
    version: String(version),
    promotion_id: null,
    branch: null,
    dry_run: Boolean(opts.dryRun),
    prod_repo: null,
    tree: null,
    manifest: null,
    pull_request: null,
    pr_url: null,
    record_path: null,
    record_committed: false,
  };
  const tmpDirs = [];
  let keepTreeDir = null;

  const finish = (exitCode, rawSuffix, failures) => {
    for (const d of tmpDirs) {
      if (d !== keepTreeDir) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
    if (failures && failures.length > 0) {
      result.failures = failures;
    }
    let raw;
    if (exitCode !== EXIT_BUILT) {
      raw = `propose failed: ${rawSuffix}`;
    } else if (result.dry_run) {
      raw =
        `dry-run: would propose v${result.version} → ${result.prod_repo} as ${result.branch} ` +
        `(${result.promotion_id}): ${result.tree.projected} projected + ${result.tree.prod_owned} prod-owned, ` +
        `${result.tree.deleted} deleted — nothing pushed`;
    } else {
      raw = `proposed v${result.version} → ${result.prod_repo} PR ${result.pull_request ?? '?'} (${result.promotion_id})`;
    }
    return { ...result, exit_code: exitCode, raw };
  };

  try {
    // --- preconditions (fail closed, exit 20) -------------------------------
    if (!SEMVER_RE.test(String(version))) {
      throw new PromotionError(
        `version must be semver X.Y.Z, got ${JSON.stringify(String(version))}`,
        EXIT_CONTRACT,
      );
    }
    let cfg;
    try {
      cfg = promotionConfig.read(cwd);
    } catch (err) {
      throw new PromotionError(err.message, EXIT_CONTRACT);
    }
    if (!cfg.prod_repo) {
      throw new PromotionError(
        `prod_repo is not configured in ${promotionConfig.PROMOTION_CONFIG_PATH} — propose has no production repository to target`,
        EXIT_CONTRACT,
      );
    }
    result.prod_repo = cfg.prod_repo;
    const prodOwnedMatchers = cfg.prod_owned.map((p) => ({
      pattern: p,
      re: classification.globToRegExp(p), // the ONE shared glob compiler
    }));

    const stagingDir = path.resolve(String(opts.staging || ''));
    const reportPath = opts.report ? path.resolve(opts.report) : `${stagingDir}.report.json`;
    const report = loadVerifiedReport(stagingDir, reportPath);

    const promotionId = nextPromotionId(cwd);
    result.promotion_id = promotionId;
    result.branch = `promote/v${version}`;
    const dev = devRepoSlug(cwd);

    const prodUrl = opts.prodUrl || `https://github.com/${cfg.prod_repo}.git`;
    const latest = prodLatestTag(cwd, prodUrl);
    if (latest && !semverGreater(version, latest)) {
      throw new PromotionError(
        `version ${version} is not greater than prod's latest tag ${latest}`,
        EXIT_CONTRACT,
      );
    }

    // --- clone prod (shallow; tags already read via ls-remote) --------------
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-promotion-prod-'));
    tmpDirs.push(workdir);
    try {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', prodUrl, workdir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new PromotionError(`cannot clone ${prodUrl}: ${gitFirstError(err)}`, EXIT_INFRA);
    }
    const prodDefaultBranch = git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])
      .toString('utf8')
      .trim();

    // --- ADR-0023: construct the tree from empty ----------------------------
    // The projection is copied file-by-file, verbatim — EXCLUDING node_modules,
    // which is not projection content: the verified-staging precondition means
    // `verify` has run its install gate INSIDE this dir, leaving npm's install
    // tree behind. The remaining file set must then match the report's
    // files_projected exactly; any other drift between staging and its report
    // fails closed (count check only — digests are cited, never recomputed).
    const treeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-promotion-tree-'));
    tmpDirs.push(treeDir);
    const projectionFiles = walkFiles(stagingDir).filter(
      (p) => p !== 'node_modules' && !p.startsWith('node_modules/'),
    );
    if (projectionFiles.length !== report.files_projected) {
      throw new PromotionError(
        `staging tree has ${projectionFiles.length} projection file(s) but the report says files_projected: ${report.files_projected} — staging no longer matches its report, refusing to propose`,
        EXIT_CONTRACT,
      );
    }
    for (const p of projectionFiles) {
      const dest = path.join(treeDir, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(path.join(stagingDir, p), dest); // verbatim, mode preserved
    }

    // Disjointness: a projection path matching a prod_owned glob is a
    // configuration error — the two sets must be disjoint by construction.
    const collisions = projectionFiles
      .map((p) => ({ path: p, m: prodOwnedMatchers.find((m) => m.re.test(p)) }))
      .filter((c) => c.m);
    if (collisions.length > 0) {
      throw new PromotionError(
        `disjointness violation: ${collisions.length} projection path(s) match a prod_owned glob — first: ${collisions[0].path} (glob ${collisions[0].m.pattern})`,
        EXIT_CONTRACT,
        collisions.map((c) => ({
          path: c.path,
          reason: `projected path matches prod_owned glob ${c.m.pattern}`,
        })),
      );
    }

    const { carried, prodHeadPaths } = carryProdOwned(workdir, treeDir, prodOwnedMatchers);
    const inTree = new Set([...projectionFiles, ...carried]);
    const deleted = prodHeadPaths.filter((p) => !inTree.has(p));

    // --- RELEASE-MANIFEST.json (fields COPIED from the report) --------------
    const promotedAt = new Date().toISOString();
    const manifest = buildManifest(String(version), promotionId, report, promotedAt);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    assertNoDevIdentifiers(manifestText, dev, 'RELEASE-MANIFEST.json');
    fs.writeFileSync(path.join(treeDir, 'RELEASE-MANIFEST.json'), manifestText);
    result.manifest = manifest;
    result.tree = {
      projected: projectionFiles.length,
      prod_owned: carried.length,
      deleted: deleted.length,
      total: walkFiles(treeDir).length,
    };

    // --- dry-run: stop here; push NOTHING, write NOTHING in dev -------------
    if (opts.dryRun) {
      keepTreeDir = treeDir;
      result.tree_dir = treeDir;
      return finish(EXIT_BUILT);
    }

    // --- branch + the single promotion commit (parent = prod HEAD only) -----
    try {
      git(workdir, ['checkout', '-q', '-b', result.branch]);
      git(workdir, ['config', 'user.name', 'verity-promotion']);
      git(workdir, ['config', 'user.email', 'verity-promotion@users.noreply.github.com']);
      git(workdir, ['config', 'commit.gpgsign', 'false']);
      for (const entry of fs.readdirSync(workdir)) {
        if (entry !== '.git') {
          fs.rmSync(path.join(workdir, entry), { recursive: true, force: true });
        }
      }
      fs.cpSync(treeDir, workdir, { recursive: true });
      git(workdir, ['add', '-A']);
      const title = `Promote Verity v${version} (dev@${report.source_commit.slice(0, 12)})`;
      const body = sanitize(
        [
          `${promotionId} | staging ${report.staging_digest} | gates all-pass | package ${report.verify.pack_shasum}`,
        ].join('\n'),
      );
      assertNoDevIdentifiers(`${title}\n${body}`, dev, 'promotion commit message');
      git(workdir, ['commit', '-q', '-m', title, '-m', body]);
    } catch (err) {
      if (err instanceof PromotionError) {
        throw err;
      }
      throw new PromotionError(`promotion commit failed: ${gitFirstError(err)}`, EXIT_INFRA);
    }
    try {
      git(workdir, ['push', '--quiet', 'origin', result.branch]);
    } catch (err) {
      throw new PromotionError(
        `cannot push ${result.branch} to ${prodUrl}: ${gitFirstError(err)}`,
        EXIT_INFRA,
      );
    }

    // --- the PR (gh, injectable) --------------------------------------------
    const prBody = buildPrBody(manifest, result.tree, dev);
    let prOut;
    try {
      prOut = ghRun([
        'pr',
        'create',
        '--repo',
        cfg.prod_repo,
        '--base',
        prodDefaultBranch,
        '--head',
        result.branch,
        '--title',
        `Promote Verity v${version}`,
        '--body',
        prBody,
      ]);
    } catch (err) {
      throw new PromotionError(`gh pr create failed: ${err.message}`, EXIT_INFRA);
    }
    const prMatch = /\/pull\/(\d+)/.exec(String(prOut));
    result.pr_url = String(prOut).trim().split('\n').pop() || null;
    result.pull_request = prMatch ? Number.parseInt(prMatch[1], 10) : null;

    // --- the private PROM record (dev side) ---------------------------------
    const recordText = buildPromRecord({
      promotionId,
      version: String(version),
      devSlug: dev.slug,
      prodRepo: cfg.prod_repo,
      prNumber: result.pull_request,
      report,
      proposedAt: promotedAt,
    });
    const recordRel = `${PROMOTIONS_DIR}/${promotionId}.yml`;
    const recordAbs = path.join(cwd, recordRel);
    fs.mkdirSync(path.dirname(recordAbs), { recursive: true });
    fs.writeFileSync(recordAbs, recordText);
    result.record_path = recordAbs;
    if (opts.commitRecord !== false) {
      try {
        git(cwd, ['add', recordRel]);
        git(cwd, [
          'commit',
          '-q',
          '-m',
          `chore(promotion): record ${promotionId} — propose v${version} (prod PR ${result.pull_request ?? 'unknown'})`,
        ]);
        result.record_committed = true;
      } catch (err) {
        throw new PromotionError(
          `PROM record written to ${recordRel} but the dev commit failed: ${gitFirstError(err)}`,
          EXIT_INFRA,
        );
      }
    }
    return finish(EXIT_BUILT);
  } catch (err) {
    const exitCode = Number.isInteger(err.exitCode) ? err.exitCode : EXIT_INFRA;
    return finish(exitCode, err.message, err.failures);
  }
}

// --- stage 44: finalize — prod-side tag + release from a merged promotion PR --
//
// finalize(version, opts) completes a promotion after its PR merges in prod:
// the ONLY place authoritative version tags are born post-split (ADR-0019).
//   1. Locate the PROM record for <version> (status MUST be `proposed` —
//      `released` refuses as the idempotence guard, the status machine moves
//      forward only) and the promotion PR it names; the PR must be MERGED in
//      prod (an OPEN PR refuses with exit 20 naming the review/merge step).
//   2. VERIFY BEFORE TAGGING (promotion-records contract rule): the merged
//      tree's RELEASE-MANIFEST.json must match the PROM record field-for-field
//      (version + every digest), and `npm pack` of the merged tree must
//      reproduce the record's package_shasum. ANY mismatch aborts, tags
//      NOTHING, and leaves the record status untouched.
//   3. Annotated tag `v<version>` on the merge commit, pushed to PROD (never
//      dev — finalize runs no git write against the dev repo besides the
//      record commit); GitHub Release with a sanitized body embedding the
//      manifest.
//   4. Complete the PROM record: status `released`, production.commit/tag,
//      timestamps.finalized_at — committed to dev with a chore(promotion)
//      message.
//   5. npm publish is NOT executed (O4 publish auth unresolved): finalize
//      prints the exact manual publish instruction with the expected shasum
//      and records `published: pending-O4` in its envelope.
// Exit codes: 0 finalized / 20 wrong status, unmerged PR, verification
// mismatch / 30 infra (network, clone, push, gh).

// Minimal reader for the exact two-level YAML shape buildPromRecord writes
// (promotion-records v1). Not a general YAML parser — fail closed on any
// line it does not recognize rather than guess.
function parsePromRecord(text, file) {
  const out = {};
  let section = null;
  const scalar = (v) => {
    if (v === 'null') {
      return null;
    }
    return /^\d+$/.test(v) ? Number.parseInt(v, 10) : v;
  };
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const child = /^ {2}([a-z_]+): (.*)$/.exec(line);
    const top = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (child && section) {
      out[section][child[1]] = scalar(child[2]);
    } else if (top && !/^ /.test(line)) {
      if (top[2] === '') {
        section = top[1];
        out[section] = {};
      } else {
        out[top[1]] = scalar(top[2]);
        section = null;
      }
    } else {
      throw new PromotionError(`unparsable PROM record line in ${file}: ${line}`, EXIT_CONTRACT);
    }
  }
  return out;
}

// Locate the PROM record for a version: the HIGHEST-numbered record naming it
// (a superseding promotion is a new record per the contract, so the newest one
// is the live attempt). No record at all → fail closed.
function findPromRecord(cwd, version) {
  const dir = path.join(cwd, PROMOTIONS_DIR);
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^PROM-\d{4}\.yml$/.test(f))
        .sort()
    : [];
  for (const f of files.reverse()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const record = parsePromRecord(text, f);
    if (String(record.version) === String(version)) {
      return { file: f, rel: `${PROMOTIONS_DIR}/${f}`, text, record };
    }
  }
  throw new PromotionError(
    `no PROM record for version ${version} in ${PROMOTIONS_DIR}/ — run \`verity promotion propose\` first`,
    EXIT_CONTRACT,
  );
}

// Complete the record by exact-line rewriting (the file is immutable after
// finalize, so this is the one write it ever receives). Each expected line
// must appear EXACTLY once — anything else means the record does not match
// the contract shape, and guessing would corrupt the evidence trail.
function completePromRecord(text, { mergeCommit, tag, finalizedAt }) {
  let out = text;
  for (const [from, to] of [
    ['status: proposed', 'status: released'],
    ['  commit: null', `  commit: ${mergeCommit}`],
    ['  tag: null', `  tag: ${tag}`],
    ['  finalized_at: null', `  finalized_at: ${finalizedAt}`],
  ]) {
    const count = out.split(`\n${from}\n`).length - 1 + (out.startsWith(`${from}\n`) ? 1 : 0);
    if (count !== 1) {
      throw new PromotionError(
        `PROM record line ${JSON.stringify(from)} appears ${count} time(s), expected exactly 1 — refusing to rewrite the record`,
        EXIT_CONTRACT,
      );
    }
    out = out.replace(`${from}\n`, `${to}\n`);
  }
  return out;
}

// The GitHub Release body: sanitized summary + the manifest embedded verbatim
// (the release IS the public provenance surface).
function buildReleaseBody(manifestText, manifest, dev) {
  const body = sanitize(
    [
      `Verity v${manifest.version} — promotion \`${manifest.promotion_id}\`.`,
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Development commit | \`${manifest.development_commit}\` |`,
      `| Staging digest | \`${manifest.staging_digest}\` |`,
      `| Classification digest | \`${manifest.classification_digest}\` |`,
      `| Package shasum | \`${manifest.package_shasum}\` |`,
      `| Gates | ${manifest.verify?.gates ?? 'unknown'} |`,
      `| Baseline | ${manifest.verify?.baseline ? `matched v${manifest.verify.baseline}` : 'not run'} |`,
      '',
      '## RELEASE-MANIFEST.json',
      '',
      '```json',
      manifestText.trimEnd(),
      '```',
      '',
    ].join('\n'),
  );
  assertNoDevIdentifiers(body, dev, 'release body');
  return body;
}

// The manual publish instruction (O4 open: finalize NEVER runs npm publish).
// Carries the expected shasum so the operator can verify their own pack —
// and nothing else: no tokens, no dev identifiers, no secret locations.
function buildPublishInstruction(prodRepo, tag, expectedShasum) {
  return [
    'npm publish NOT executed (open decision O4: publish auth is unresolved — published: pending-O4).',
    'To publish manually from the authoritative tag:',
    `  git clone https://github.com/${prodRepo}.git verity-${tag} && cd verity-${tag}`,
    `  git checkout ${tag}`,
    '  npm publish',
    `Expected tarball shasum (verify with \`npm pack --json\`): ${expectedShasum}`,
  ].join('\n');
}

// finalize(version, opts) — opts: cwd (dev repo), prodUrl (clone/push URL
// override — tests point it at a local bare fixture), gh (injectable gh
// runner, house pattern), commitRecord (default true: commit the completed
// PROM record to the current dev branch).
// Returns the result envelope in all outcome cases, like project()/verify()/
// propose().
function finalize(version, opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const ghRun = opts.gh || ((args) => gh.run(args));
  const result = {
    schema: 1,
    version: String(version),
    promotion_id: null,
    prod_repo: null,
    pull_request: null,
    merge_commit: null,
    tag: null,
    release_created: false,
    verification: null,
    record_path: null,
    record_committed: false,
    published: 'pending-O4',
    publish_instruction: null,
  };
  const tmpDirs = [];

  const finish = (exitCode, rawSuffix, failures) => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    if (failures && failures.length > 0) {
      result.failures = failures;
    }
    const raw =
      exitCode === EXIT_BUILT
        ? `finalized v${result.version}: tag ${result.tag} on ${String(result.merge_commit).slice(0, 12)} in ${result.prod_repo}, release created, ${result.promotion_id} → released (publish: pending-O4)`
        : `finalize failed: ${rawSuffix}`;
    return { ...result, exit_code: exitCode, raw };
  };

  try {
    // --- preconditions (fail closed, exit 20) -------------------------------
    if (!SEMVER_RE.test(String(version))) {
      throw new PromotionError(
        `version must be semver X.Y.Z, got ${JSON.stringify(String(version))}`,
        EXIT_CONTRACT,
      );
    }
    let cfg;
    try {
      cfg = promotionConfig.read(cwd);
    } catch (err) {
      throw new PromotionError(err.message, EXIT_CONTRACT);
    }
    if (!cfg.prod_repo) {
      throw new PromotionError(
        `prod_repo is not configured in ${promotionConfig.PROMOTION_CONFIG_PATH} — finalize has no production repository to tag`,
        EXIT_CONTRACT,
      );
    }
    result.prod_repo = cfg.prod_repo;
    const dev = devRepoSlug(cwd);

    // --- the PROM record: status machine (forward only) ---------------------
    const found = findPromRecord(cwd, version);
    const record = found.record;
    result.promotion_id = record.promotion_id;
    result.record_path = path.join(cwd, found.rel);
    if (record.status === 'released') {
      throw new PromotionError(
        `${record.promotion_id} is already released (tag ${record.production?.tag ?? '?'}) — finalize is not repeatable; a superseding promotion is a NEW record`,
        EXIT_CONTRACT,
      );
    }
    if (record.status !== 'proposed') {
      throw new PromotionError(
        `${record.promotion_id} has status ${JSON.stringify(record.status)}, not "proposed" — finalize only completes a proposed promotion`,
        EXIT_CONTRACT,
      );
    }
    if (record.production?.repository !== cfg.prod_repo) {
      throw new PromotionError(
        `${record.promotion_id} names production repository ${JSON.stringify(record.production?.repository)} but ${promotionConfig.PROMOTION_CONFIG_PATH} says ${JSON.stringify(cfg.prod_repo)} — refusing to tag under drift`,
        EXIT_CONTRACT,
      );
    }
    const prNumber = record.production?.pull_request;
    if (!Number.isInteger(prNumber)) {
      throw new PromotionError(
        `${record.promotion_id} carries no promotion PR number — cannot locate the merged PR`,
        EXIT_CONTRACT,
      );
    }
    result.pull_request = prNumber;

    // --- the PR must be MERGED in prod (gh, injectable) ---------------------
    let pr;
    try {
      pr = JSON.parse(
        String(
          ghRun([
            'pr',
            'view',
            String(prNumber),
            '--repo',
            cfg.prod_repo,
            '--json',
            'state,mergeCommit',
          ]),
        ),
      );
    } catch (err) {
      throw new PromotionError(
        `cannot read promotion PR ${prNumber} in ${cfg.prod_repo}: ${err.message}`,
        EXIT_INFRA,
      );
    }
    if (pr.state !== 'MERGED') {
      const step =
        pr.state === 'OPEN'
          ? 'it must be reviewed and merged in prod (the review/merge step) before finalize'
          : 'a closed-unmerged PR cannot be finalized — propose a new promotion';
      throw new PromotionError(
        `promotion PR ${prNumber} in ${cfg.prod_repo} is ${pr.state}, not MERGED — ${step}`,
        EXIT_CONTRACT,
      );
    }
    const mergeCommit = pr.mergeCommit?.oid;
    if (typeof mergeCommit !== 'string' || mergeCommit.length === 0) {
      throw new PromotionError(
        `gh reports PR ${prNumber} MERGED but carries no merge commit oid`,
        EXIT_INFRA,
      );
    }
    result.merge_commit = mergeCommit;
    const tag = `v${version}`;

    // --- clone prod at the merge commit -------------------------------------
    const prodUrl = opts.prodUrl || `https://github.com/${cfg.prod_repo}.git`;
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-finalize-prod-'));
    tmpDirs.push(workdir);
    try {
      execFileSync('git', ['clone', '--quiet', prodUrl, workdir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new PromotionError(`cannot clone ${prodUrl}: ${gitFirstError(err)}`, EXIT_INFRA);
    }
    if (git(workdir, ['tag', '-l', tag]).toString('utf8').trim() !== '') {
      throw new PromotionError(
        `tag ${tag} already exists in ${cfg.prod_repo} — finalize will not re-tag`,
        EXIT_CONTRACT,
      );
    }
    try {
      git(workdir, ['cat-file', '-e', `${mergeCommit}^{commit}`]);
    } catch (_err) {
      try {
        git(workdir, ['fetch', '--quiet', 'origin', mergeCommit]);
      } catch (err2) {
        throw new PromotionError(
          `merge commit ${mergeCommit} not reachable in ${prodUrl}: ${gitFirstError(err2)}`,
          EXIT_INFRA,
        );
      }
    }
    try {
      git(workdir, ['checkout', '--quiet', '--detach', mergeCommit]);
    } catch (err) {
      throw new PromotionError(
        `cannot check out merge commit ${mergeCommit}: ${gitFirstError(err)}`,
        EXIT_INFRA,
      );
    }

    // --- VERIFY BEFORE TAGGING (contract rule) ------------------------------
    // Manifest-vs-record first (version + every digest), then npm pack of the
    // merged tree vs the record's package_shasum. ALL mismatches are gathered
    // and reported together; any mismatch tags NOTHING, status untouched.
    const manifestPath = path.join(workdir, 'RELEASE-MANIFEST.json');
    if (!fs.existsSync(manifestPath)) {
      throw new PromotionError(
        `merged tree has no RELEASE-MANIFEST.json at ${mergeCommit.slice(0, 12)} — not a promotion merge, tagging nothing`,
        EXIT_CONTRACT,
      );
    }
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      throw new PromotionError(
        `merged RELEASE-MANIFEST.json is unparsable (${err.message}) — tagging nothing`,
        EXIT_CONTRACT,
      );
    }
    const mismatches = [];
    const check = (field, manifestValue, recordValue) => {
      if (manifestValue !== recordValue) {
        mismatches.push({
          path: field,
          reason: `manifest ${JSON.stringify(manifestValue)} != record ${JSON.stringify(recordValue)}`,
        });
      }
    };
    check('version', manifest.version, String(version));
    check('promotion_id', manifest.promotion_id, record.promotion_id);
    check('development_commit', manifest.development_commit, record.development?.commit);
    check('staging_digest', manifest.staging_digest, record.development?.staging_digest);
    check(
      'classification_digest',
      manifest.classification_digest,
      record.development?.classification_digest,
    );
    check('package_shasum', manifest.package_shasum, record.verification?.package_shasum);
    if (mismatches.length === 0) {
      // Pack only when the record fields agree — a field mismatch already
      // aborts, and packing a tree we know is wrong proves nothing.
      const packDest = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-finalize-pack-'));
      tmpDirs.push(packDest);
      const pr2 = run('npm', ['pack', '--json', '--pack-destination', packDest], workdir);
      if (pr2.status !== 0) {
        throw new PromotionError(
          `npm pack of the merged tree failed: ${summarize(pr2)}`,
          EXIT_INFRA,
        );
      }
      const tarballs = fs.readdirSync(packDest).filter((f) => f.endsWith('.tgz'));
      if (tarballs.length !== 1) {
        throw new PromotionError(
          `expected exactly one packed tarball, found ${tarballs.length}`,
          EXIT_INFRA,
        );
      }
      const packed = sha1File(path.join(packDest, tarballs[0]));
      if (packed !== record.verification?.package_shasum) {
        mismatches.push({
          path: 'package_shasum (npm pack)',
          reason: `merged tree packs to ${packed} but the record says ${record.verification?.package_shasum}`,
        });
      } else {
        result.verification = { manifest: 'match', pack_shasum: packed };
      }
    }
    if (mismatches.length > 0) {
      throw new PromotionError(
        `verification mismatch (${mismatches.map((m) => m.path).join(', ')}) — tagging NOTHING, record status untouched`,
        EXIT_CONTRACT,
        mismatches,
      );
    }

    // --- annotated tag on the merge commit, pushed to PROD ------------------
    const tagMessage = sanitize(
      [
        `Verity ${tag} (${record.promotion_id})`,
        '',
        `staging ${record.development.staging_digest} | package ${record.verification.package_shasum}`,
      ].join('\n'),
    );
    assertNoDevIdentifiers(tagMessage, dev, 'tag message');
    try {
      git(workdir, ['config', 'user.name', 'verity-promotion']);
      git(workdir, ['config', 'user.email', 'verity-promotion@users.noreply.github.com']);
      git(workdir, ['config', 'tag.gpgsign', 'false']);
      git(workdir, ['tag', '-a', tag, '-m', tagMessage, mergeCommit]);
      git(workdir, ['push', '--quiet', 'origin', `refs/tags/${tag}`]);
    } catch (err) {
      if (err instanceof PromotionError) {
        throw err;
      }
      throw new PromotionError(
        `cannot create/push tag ${tag} to ${prodUrl}: ${gitFirstError(err)}`,
        EXIT_INFRA,
      );
    }
    result.tag = tag;

    // --- the GitHub Release (gh, injectable) --------------------------------
    const releaseBody = buildReleaseBody(manifestText, manifest, dev);
    try {
      ghRun([
        'release',
        'create',
        tag,
        '--repo',
        cfg.prod_repo,
        '--title',
        tag,
        '--notes',
        releaseBody,
      ]);
    } catch (err) {
      if (err instanceof PromotionError) {
        throw err;
      }
      throw new PromotionError(`gh release create failed: ${err.message}`, EXIT_INFRA);
    }
    result.release_created = true;

    // --- complete the PROM record in dev ------------------------------------
    const finalizedAt = new Date().toISOString();
    const completed = completePromRecord(found.text, { mergeCommit, tag, finalizedAt });
    fs.writeFileSync(result.record_path, completed);
    if (opts.commitRecord !== false) {
      try {
        git(cwd, ['add', found.rel]);
        git(cwd, [
          'commit',
          '-q',
          '-m',
          `chore(promotion): record ${record.promotion_id} — finalize v${version} released (prod tag ${tag})`,
        ]);
        result.record_committed = true;
      } catch (err) {
        throw new PromotionError(
          `PROM record completed at ${found.rel} but the dev commit failed: ${gitFirstError(err)}`,
          EXIT_INFRA,
        );
      }
    }

    // --- manual publish instruction (O4 open — NEVER executed here) ---------
    result.publish_instruction = buildPublishInstruction(
      cfg.prod_repo,
      tag,
      record.verification.package_shasum,
    );
    process.stderr.write(`${result.publish_instruction}\n`);
    return finish(EXIT_BUILT);
  } catch (err) {
    const exitCode = Number.isInteger(err.exitCode) ? err.exitCode : EXIT_INFRA;
    return finish(exitCode, err.message, err.failures);
  }
}

function exitCodeFor(result) {
  return Number.isInteger(result?.exit_code) ? result.exit_code : 1;
}

function dispatch(args, flags) {
  const verb = args[0];
  if (verb === 'project') {
    const ref = args[1];
    if (!ref || flags.out === true || flags.report === true) {
      throw new Error(
        'usage: verity promotion project <ref> [--out <dir>] [--report <path>] [--json]',
      );
    }
    return project(ref, { cwd: flags.cwd, out: flags.out, report: flags.report });
  }
  if (verb === 'verify') {
    const dir = args[1];
    if (!dir || flags.report === true || flags.baseline === true) {
      throw new Error(
        'usage: verity promotion verify <staging-dir> [--report <path>] [--baseline <version>] [--json]',
      );
    }
    return verify(dir, { cwd: flags.cwd, report: flags.report, baseline: flags.baseline });
  }
  if (verb === 'propose') {
    const version = args[1];
    if (!version || !flags.staging || flags.staging === true || flags.report === true) {
      throw new Error(
        'usage: verity promotion propose <version> --staging <dir> [--report <path>] [--dry-run] [--json]',
      );
    }
    return propose(version, {
      cwd: flags.cwd,
      staging: flags.staging,
      report: flags.report,
      dryRun: Boolean(flags['dry-run']),
    });
  }
  if (verb === 'finalize') {
    const version = args[1];
    if (!version) {
      throw new Error('usage: verity promotion finalize <version> [--json]');
    }
    return finalize(version, { cwd: flags.cwd });
  }
  throw new Error(
    `unknown promotion verb: ${verb || '(none)'} — use project|verify|propose|finalize`,
  );
}

module.exports = {
  SECRET_PATTERNS,
  BASELINE_GATE,
  EXIT_BUILT,
  EXIT_CONTRACT,
  EXIT_INFRA,
  project,
  verify,
  propose,
  finalize,
  compareTarballs,
  inspectPack,
  exitCodeFor,
  dispatch,
};
