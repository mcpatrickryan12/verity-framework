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
//
// Stage 81 (ADR-0029 §3): the local delivery substrate reaches this module
// through the SAME `ghOpts` bag — an EXPLICIT `ghOpts.substrate === 'local'`
// (the worker stamps it from ctx.substrate, itself the stage-79
// policy.substrate) routes checksGreen's reading to the stage-80 snapshot and
// merge() to the engine-performed local merge. Anything else — absent,
// 'github', unknown — takes the gh path byte-identically (no policy read, no
// new I/O: fail toward today's engine, the stage-79 direction).
const gh = require('./gh.cjs');
const ledger = require('./ledger.cjs');
const substrateLocal = require('./substrate-local.cjs');

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
  // Stage 81 (ADR-0029 §3): on the local substrate the SAME boolean question
  // is answered from the stage-80 snapshot's synthesized rollup (contract
  // local-work-item honesty rule: green ONLY from a fresh all-zero gate-run
  // record). UNKNOWN and red both read false, exactly as the gh path's catch
  // does — the merge bar itself is not reimplemented, only the reading's source
  // moves (the ADR-0029 seam: acquisition, never decision).
  if (ghOpts.substrate === 'local') {
    return substrateLocal.localChecksGreen(ghOpts.cwd, pr);
  }
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
//
// Stage 84 (ADR-0029 consequence; operator-gate.md's evidence source): on the
// LOCAL substrate the same two evidence facts — changed files and changed
// lines — come from git itself (substrateLocal.localPrDiff's merge-base diff,
// the exact reading `gh pr diff`/`gh pr view` present for a PR), never from a
// gh call that never ran. The §4.5 policy RULES below are one code path for
// both substrates; only the evidence acquisition moves (the ADR-0029 seam:
// acquisition, never decision). checksGreen already routes local (stage 81).
function classify(pr, policy, ghOpts = {}) {
  const low = policy.review.low_risk;
  const reasons = [];

  let files;
  let changedLines;
  if (ghOpts.substrate === 'local') {
    const diff = substrateLocal.localPrDiff(ghOpts.cwd, pr);
    files = diff.files;
    changedLines = diff.changed_lines;
  } else {
    files = changedFiles(pr, ghOpts);
    const view = gh.json(['pr', 'view', String(pr), '--json', 'additions,deletions'], ghOpts);
    changedLines = (view.additions || 0) + (view.deletions || 0);
  }

  for (const file of files) {
    // Protected veto FIRST — it beats a simultaneous allowed_paths match.
    const protectedHit = matchAny(low.protected_paths, file);
    if (protectedHit !== null) {
      reasons.push(`${file} matches protected path ${protectedHit}`);
    } else if (matchAny(low.allowed_paths, file) === null) {
      reasons.push(`${file} is outside allowed_paths`);
    }
  }

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
//
// Stage 81 (ADR-0029 §3), the local-substrate path: the engine performs the
// merge itself (`git merge --no-ff` + push to the bare origin + close the
// stage's work-item record — ADR-0012/0013: Verity performs git, roles never
// do). `--no-ff` where GitHub squashes is an ACCEPTED, documented divergence:
// local keeps the stage's commits (the Fresh audit record); graduation may
// squash later. Before acting, the local path re-verifies the merge bar
// through the SAME checksGreen above (the stage-80 snapshot reading) — a belt
// on the one invariant no caller may relax: UNKNOWN never merges. decideMerge
// remains the decision; this refusal only guards the act, with the same error
// shape review.merge refuses with.
function merge(pr, ghOpts = {}) {
  if (ghOpts.substrate === 'local') {
    if (!checksGreen(pr, ghOpts)) {
      const state = substrateLocal.localCiStateFor(ghOpts.cwd, pr);
      throw new Error(
        state === ledger.CI_UNKNOWN
          ? `refusing to merge PR #${pr}: CI is UNVERIFIED — no gate-run record proves this branch's current head green (contracts/local-work-item.md honesty rule). Unverified is not green (the gate, even when branch protection is unavailable)`
          : `refusing to merge PR #${pr}: CI is not green (the gate, even when branch protection is unavailable)`,
      );
    }
    const done = substrateLocal.mergeLocalPr(ghOpts.cwd, pr);
    return { merged: true, pr, method: done.method };
  }
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
