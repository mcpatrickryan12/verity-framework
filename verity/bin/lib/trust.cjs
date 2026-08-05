// Trust ladder — deterministic review-merge logic (T13, SKETCH §4.5).
//
// Merge authority lives HERE, in the worker — never in the review agent. The
// review role's tool allowlist (commands/verity/review.tools.json, T06) has no
// merge-capable tool; the agent only REPORTS a verdict (`artifacts.verdict` in
// the T05 result marker) and this module decides, with deterministic code and
// `gh` ground truth, whether the worker may merge:
//
//   trust 0 → NEVER merge, even on an approve verdict — gate for a human.
//   trust 1 → merge only when approve AND classify() says low-risk:
//             every changed file (gh pr diff --name-only) matches an
//             allowed_paths glob, NO file matches a protected_paths glob
//             (protected veto beats an allowed match), additions+deletions
//             (gh pr view) <= max_changed_lines (exactly equal = still low),
//             and — when require_ci_green — `gh pr checks` exits green.
//   trust 2 → merge on approve if checks are green; else gate.
//   anything else (unknown trust) → fail closed: gate.
//
// Auto-demotion on rollback attribution is T19 (Phase 4) — NOT implemented here.
//
// All GitHub access goes through the shared gh layer (gh.cjs); `ghOpts` is
// passed straight through, so tests inject `exec` and never touch the network.
const gh = require('./gh.cjs');

// ---------------------------------------------------------------------------
// Glob matcher — hand-rolled (zero-dep; no minimatch in this codebase).
//
// Supported syntax (a documented minimatch subset, enough for §2 policy paths):
//   - patterns and paths are '/'-separated; matching is segment-wise and
//     anchored at both ends (a pattern must cover the WHOLE path)
//   - `**` as a whole segment matches zero or more path segments
//     ('docs/**' matches 'docs/a.md' and 'docs/a/b.md'; '**/auth/**' matches
//     'auth/x.js' and 'src/auth/x.js')
//   - `*` inside a segment matches any run of non-'/' characters, including
//     the empty run ('scripts/deploy*' matches 'scripts/deploy-prod.sh' but
//     NOT 'scripts/deploy/prod.sh' — `*` never crosses a '/')
//   - `?` inside a segment matches exactly one non-'/' character
//   - everything else is a literal, case-sensitive character; dotfiles are
//     matched like any other name ('.github/**' must work)
//   NOT supported: braces {a,b}, extglobs, [...] character classes, negation,
//   escapes. A leading './' on the path is stripped before matching.
// ---------------------------------------------------------------------------

const SEGMENT_CACHE = new Map();

function segmentRegExp(segment) {
  let re = SEGMENT_CACHE.get(segment);
  if (re === undefined) {
    let src = '^';
    for (const c of segment) {
      if (c === '*') {
        src += '[^/]*';
      } else if (c === '?') {
        src += '[^/]';
      } else {
        src += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
      }
    }
    re = new RegExp(`${src}$`);
    SEGMENT_CACHE.set(segment, re);
  }
  return re;
}

function globMatch(pattern, filePath) {
  const pats = String(pattern).split('/');
  const segs = String(filePath).replace(/^\.\//, '').split('/');
  const seen = new Set(); // memo over (i,j) — keeps '**'-heavy patterns linear
  const walk = (i, j) => {
    const key = i * (segs.length + 1) + j;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    if (i === pats.length) {
      return j === segs.length;
    }
    if (pats[i] === '**') {
      // zero segments, or consume one and stay on the globstar
      return walk(i + 1, j) || (j < segs.length && walk(i, j + 1));
    }
    return j < segs.length && segmentRegExp(pats[i]).test(segs[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

// First pattern in `patterns` that matches `filePath`, or null.
function matchAny(patterns, filePath) {
  for (const p of patterns || []) {
    if (globMatch(p, filePath)) {
      return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Risk classification (§4.5, trust 1) — deterministic gh ground truth.
// ---------------------------------------------------------------------------

// `gh pr checks <n>` exit code IS the contract: 0 = all checks pass, nonzero =
// failing/pending. Any error (including "no checks") reads as NOT green —
// fail closed, never open.
//
// CALL SITE (stage 19 audit): deliberately still a BOOLEAN, and deliberately
// unchanged. This is the autonomous merge gate, and the only question it is
// allowed to answer is "did Verity VERIFY that this PR is green?" — for which
// unverified and failing are the same answer: no. The three-state reading
// (ledger.rollupState) exists so the DISPATCH decision can tell them apart and
// stop instead of looping; it must never travel to a merge decision, because
// there is no CI state other than verified-green that may merge.
function checksGreen(pr, ghOpts = {}) {
  try {
    gh.run(['pr', 'checks', String(pr)], ghOpts);
    return true;
  } catch {
    return false;
  }
}

// Changed files per `gh pr diff --name-only` (one path per line).
function changedFiles(pr, ghOpts = {}) {
  return gh
    .run(['pr', 'diff', String(pr), '--name-only'], ghOpts)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

// classify(pr, policy, ghOpts) → { risk: 'low'|'high', reasons, files,
// changed_lines, checks_green }. Low-risk requires ALL of (§4.5):
//   - every changed file matches an allowed_paths glob
//   - NO changed file matches a protected_paths glob (veto beats allowed)
//   - additions + deletions <= max_changed_lines (exactly equal = low)
//   - checks green, when require_ci_green (otherwise checks are not consulted)
// `reasons` lists every failed condition (empty ⇔ risk 'low').
function classify(pr, policy, ghOpts = {}) {
  const low = policy.review.low_risk;
  const reasons = [];

  const files = changedFiles(pr, ghOpts);
  for (const file of files) {
    // Protected veto FIRST — it beats a simultaneous allowed_paths match.
    const protectedHit = matchAny(low.protected_paths, file);
    if (protectedHit !== null) {
      reasons.push(`${file} matches protected path ${protectedHit}`);
    } else if (matchAny(low.allowed_paths, file) === null) {
      reasons.push(`${file} is outside allowed_paths`);
    }
  }

  const view = gh.json(['pr', 'view', String(pr), '--json', 'additions,deletions'], ghOpts);
  const changedLines = (view.additions || 0) + (view.deletions || 0);
  if (changedLines > low.max_changed_lines) {
    reasons.push(
      `${changedLines} changed lines exceeds max_changed_lines ${low.max_changed_lines}`,
    );
  }

  let green = null; // not consulted unless the policy requires it
  if (low.require_ci_green) {
    green = checksGreen(pr, ghOpts);
    if (!green) {
      reasons.push('checks are not green');
    }
  }

  return {
    risk: reasons.length === 0 ? 'low' : 'high',
    reasons,
    files,
    changed_lines: changedLines,
    checks_green: green,
  };
}

// ---------------------------------------------------------------------------
// Merge decision (§4.5 trust ladder) — pure, no I/O.
// ---------------------------------------------------------------------------

// decideMerge(verdict, trust, classification, checksGreen) → { merge, gate,
// reason }. Fail-closed at every branch: only an explicit 'approve' verdict
// can merge, trust 0 never merges, unknown trust levels gate.
function decideMerge(verdict, trust, classification, green) {
  if (verdict !== 'approve') {
    // Stage 36: `escalate` is a first-class non-approve verdict — an
    // architectural / frozen-contract blocker, not a code-rework request. It
    // GATES exactly like any other non-approve (this early branch runs before
    // the trust checks, so escalate can NEVER merge at any trust level), but is
    // TAGGED so the worker can route it to a human when review.escalate_routing
    // is ON. Every OTHER non-approve verdict (request_changes / unknown /
    // absent) keeps the byte-identical fail-closed default below — no `escalate`
    // field — so the dark-launch default is indistinguishable from today.
    if (verdict === 'escalate') {
      return {
        merge: false,
        gate: true,
        escalate: true,
        reason:
          "review verdict 'escalate' — architectural / frozen-contract blocker; human review required",
      };
    }
    return {
      merge: false,
      gate: true,
      reason: `review verdict '${verdict ?? '(none)'}' is not approve — human review required`,
    };
  }
  if (trust === 0) {
    return {
      merge: false,
      gate: true,
      reason: 'trust 0: autonomous merge is disabled — human merge required',
    };
  }
  if (trust === 1) {
    if (classification?.risk === 'low') {
      return { merge: true, gate: false, reason: 'trust 1: approve + low-risk classification' };
    }
    const why = classification ? classification.reasons.join('; ') : 'no risk classification';
    return { merge: false, gate: true, reason: `trust 1: high-risk — ${why}` };
  }
  if (trust === 2) {
    if (green === true) {
      return { merge: true, gate: false, reason: 'trust 2: approve + checks green' };
    }
    return { merge: false, gate: true, reason: 'trust 2: checks are not green — gating' };
  }
  return { merge: false, gate: true, reason: `unknown trust level ${trust} — failing closed` };
}

// The ONE merge call in the autonomy codepath (§4.5): squash, via the gh layer.
function merge(pr, ghOpts = {}) {
  gh.run(['pr', 'merge', String(pr), '--squash'], ghOpts);
  return { merged: true, pr, method: 'squash' };
}

module.exports = {
  globMatch,
  matchAny,
  checksGreen,
  changedFiles,
  classify,
  decideMerge,
  merge,
};
