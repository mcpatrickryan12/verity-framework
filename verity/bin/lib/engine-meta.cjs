// Engine metadata reader (stage 35) — the self-contained, IN-SUBTREE source of
// the version floors the drivers and `verity doctor` need.
//
// Before this stage doctor.cjs / agents/claude.cjs / agents/codex.cjs each did
// a top-level `require('../../../package.json')`, resolving ABOVE the engine
// root. The engine is deployed as ONLY the `verity/` subtree (install.cjs
// copyInternals), so a copy has no package.json there — Node threw
// `Cannot find module` at MODULE LOAD, crashing EVERY command from a copied
// engine (canary run 5, defect N6). This module reads `verity/engine-meta.json`
// instead — a sibling INSIDE the subtree, stamped from package.json at
// install/copy time — via a relative path that never climbs above verity/.
//
// Honest fallback, never a crash, never a silent stub (framework never-false-
// green rule): if engine-meta.json is absent (e.g. a stale copy deployed BEFORE
// this fix), load() returns an empty `verity` block, warns ONCE on stderr, and
// each call site falls back to the hardcoded floor it already carries
// (claude.cjs `'2.1.170'`, codex.cjs `features.verifiedFloor()`). The operator
// is told to re-stamp with `verity install` rather than silently trusting a
// substituted value.
const fs = require('node:fs');
const path = require('node:path');

// verity/bin/lib → verity/engine-meta.json. Two `..` reach the engine root
// exactly; this NEVER climbs above verity/ (that is the whole point).
const META_PATH = path.join(__dirname, '..', '..', 'engine-meta.json');

let cached; // one read per process — the three consumers share it.
let warned = false;

// Fallback shape: no version, no floors. Consumers keep their own `|| <floor>`,
// so the honest hardcoded minimum is what actually gets used.
function fallback() {
  return { version: null, verity: {}, present: false };
}

// opts.file / opts.stderr are test seams; supplying either bypasses the cache
// so tests stay isolated. Real callers pass nothing and share the cached read.
function load(opts = {}) {
  const useCache = !opts.file && !opts.stderr;
  if (useCache && cached !== undefined) {
    return cached;
  }
  const file = opts.file || META_PATH;
  let result;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    result = { version: parsed.version ?? null, verity: parsed.verity || {}, present: true };
  } catch (err) {
    warnMissing(opts.stderr || process.stderr, file, err, useCache);
    result = fallback();
  }
  if (useCache) {
    cached = result;
  }
  return result;
}

function warnMissing(stderr, file, err, dedupe) {
  if (dedupe && warned) {
    return;
  }
  if (dedupe) {
    warned = true;
  }
  stderr.write(
    `verity: engine-meta.json not readable (${file}: ${err.code || err.message}) — using built-in version floors; run \`verity install\` to re-stamp this engine copy\n`,
  );
}

module.exports = { load, META_PATH };
