// Dev-side promotion state (stage 42, ADR-0022 §3): `.verity/promotion.json`
// drives the authoritative-tag guard in `release cut` and (stage 43, ADR-0023)
// the promotion tree construction in `promotion propose`. Schema 1:
//   { "schema": 1, "split_active": <bool>, "prod_repo": <string|null>,
//     "prod_owned": [<glob>, ...] }
// (additive growth: `prod_repo` arrived with Phase 2, `prod_owned` with
// stage 43 — prod-HEAD paths matching these globs survive a promotion).
//
// Kill-switch semantics — the file's PRESENCE is the opt-in:
//   - absent            → { split_active: false }: every existing Verity
//                         consumer is unaffected (guard inert, default OFF);
//   - well-formed       → the file's values;
//   - malformed / wrong → HARD ERROR, exit 20. A guard that silently disarms
//     schema                is worse than none — fail closed, never silently off.
const fs = require('node:fs');
const path = require('node:path');

const PROMOTION_CONFIG_PATH = '.verity/promotion.json';
const EXIT_CONTRACT = 20;

class PromotionConfigError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT_CONTRACT;
  }
}

function fail(detail) {
  throw new PromotionConfigError(
    `${PROMOTION_CONFIG_PATH} is unusable (${detail}) — the split guard must never be silently off; fix the file or remove it to opt out`,
  );
}

function read(cwd) {
  const p = path.join(cwd, PROMOTION_CONFIG_PATH);
  if (!fs.existsSync(p)) {
    return { present: false, split_active: false, prod_repo: null, prod_owned: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    fail(`malformed JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('top level must be an object');
  }
  if (parsed.schema !== 1) {
    fail(`unsupported schema ${JSON.stringify(parsed.schema)} — this Verity understands schema 1`);
  }
  if (typeof parsed.split_active !== 'boolean') {
    fail('split_active must be a boolean');
  }
  if (parsed.prod_repo !== null && typeof parsed.prod_repo !== 'string') {
    fail('prod_repo must be a string or null');
  }
  // prod_owned (stage 43, ADR-0023): globs for prod-HEAD paths that survive a
  // promotion. Absent → [] (additive field); anything but an array of strings
  // is a HARD ERROR — a malformed allowlist silently read as empty would let a
  // promotion delete prod-owned furniture, so fail closed like the guard does.
  let prodOwned = [];
  if (parsed.prod_owned !== undefined) {
    if (
      !Array.isArray(parsed.prod_owned) ||
      parsed.prod_owned.some((g) => typeof g !== 'string' || g.length === 0)
    ) {
      fail('prod_owned must be an array of non-empty strings');
    }
    prodOwned = parsed.prod_owned;
  }
  return {
    present: true,
    split_active: parsed.split_active,
    prod_repo: parsed.prod_repo,
    prod_owned: prodOwned,
  };
}

module.exports = { PROMOTION_CONFIG_PATH, PromotionConfigError, read };
