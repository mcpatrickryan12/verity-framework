// Scanner (T08, SKETCH §4.2) — ranked work selection for the worker (T10).
//
// Public surface:
//   scan(opts) -> selected work item or null (idle).
//     Runs the §4.2 tiers in order (P1..P5); the FIRST non-empty tier wins;
//     FIFO (oldest createdAt first) within a tier. Returned item shape:
//       { tier: 'P1'..'P5', kind: 'issue'|'pr'|'stage', number, title,
//         labels: [lowercased names], createdAt, author, headRefName,
//         decision? }            // decision only on P5 (the `verity next` object)
//
//   opts (all optional unless noted):
//     botLogin     — the bot's GitHub login. P4 hard rule: skip items where
//                    author.login == botLogin (no self-feeding). When absent,
//                    no P4 author filtering happens (the worker MUST pass it).
//     warn         — `(message) => void`, DEFAULT silent (the usage.cjs
//                    opts.warn precedent — a library never writes to a stream
//                    uninvited). Called ONCE per scan, with the skipped count,
//                    when the P4 no-self-feeding rule drops ≥1 request
//                    (stage 28): the filter is by design, but its silence made
//                    a single-account operator's `verity:request` read as
//                    plain "no eligible work". Diagnostics only — the caller
//                    decides where it surfaces (the worker: stderr + the idle
//                    line); it never becomes a GitHub comment.
//     isLocked     — injectable lock predicate `(item) => boolean`. Items for
//                    which it returns true are skipped in every tier. DEFAULT:
//                    () => false (no filtering). This is the seam for the §4.3
//                    lock protocol: T10 wires it to T09's locks.cjs ("last
//                    lock: comment is fresh") — scanner deliberately does NOT
//                    implement lock parsing itself.
//     nextDecision — injectable P5 source `() => decision` returning the
//                    `verity next --json` object. DEFAULT: next.dispatch (the
//                    module API of T03 — no shell-out).
//     cwd, exec, sleep, random, log, retries — passed through to the shared
//                    gh layer (gh.cjs); `exec` is the test seam for stubbed gh.
//
// Tier queries are the §4.2 frozen contract verbatim, with one field-list
// deviation: `createdAt` is appended everywhere (needed for FIFO) and `labels`
// is appended to P2/P4 (needed for the needs-human filter). All tiers drop
// items labeled `verity:needs-human` (§1: worker never works those) — P5
// included: since the dependency engine's decision carries no labels, P5
// fetches the target's labels (one gh view) and skips escalated items,
// failing CLOSED (idle) when the fetch errors (#4).
// P5 trusts the dependency engine: only a decision with action == 'work'
// yields an item; gated/idle yield nothing (so "ship gated" never selects).
//
// Exported for tests (internal, not a stability contract): TIER_QUERIES,
// normalize, byCreatedAt, NEEDS_HUMAN_LABEL.
const gh = require('./gh.cjs');
const next = require('./next.cjs');

const NEEDS_HUMAN_LABEL = 'verity:needs-human';

// Exact §4.2 commands (args for gh.run). Field-list additions noted above.
const TIER_QUERIES = {
  P1: [
    {
      kind: 'issue',
      args: [
        'issue',
        'list',
        '--label',
        'verity:approved',
        '--state',
        'open',
        '--json',
        'number,labels,title,createdAt',
      ],
    },
    {
      kind: 'pr',
      args: [
        'pr',
        'list',
        '--label',
        'verity:approved',
        '--state',
        'open',
        '--json',
        'number,labels,title,createdAt',
      ],
    },
  ],
  P2: [
    {
      kind: 'pr',
      args: [
        'pr',
        'list',
        '--label',
        'verity:awaiting-review',
        '--state',
        'open',
        '--json',
        'number,headRefName,title,labels,createdAt',
      ],
    },
  ],
  P3: [
    {
      kind: 'issue',
      args: [
        'issue',
        'list',
        '--label',
        'verity:ready',
        '--state',
        'open',
        '--json',
        'number,title,labels,createdAt',
      ],
    },
  ],
  P4: [
    {
      kind: 'issue',
      args: [
        'issue',
        'list',
        '--label',
        'verity:request',
        '--state',
        'open',
        '--json',
        'number,title,author,labels,createdAt',
      ],
    },
  ],
};

function labelNames(raw) {
  return (raw.labels || []).map((l) =>
    String(typeof l === 'string' ? l : l.name || '').toLowerCase(),
  );
}

function normalize(raw, kind, tier) {
  return {
    tier,
    kind,
    number: raw.number,
    title: raw.title ?? null,
    labels: labelNames(raw),
    createdAt: raw.createdAt ?? null,
    author: raw.author?.login ?? null,
    headRefName: raw.headRefName ?? null,
  };
}

// FIFO: oldest createdAt first (ISO-8601 compares lexically); missing
// createdAt sorts last; ties break on issue/PR number ascending.
function byCreatedAt(a, b) {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === null) {
      return 1;
    }
    if (b.createdAt === null) {
      return -1;
    }
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.number - b.number;
}

function scan(opts = {}) {
  const ghOpts = {
    cwd: opts.cwd,
    exec: opts.exec,
    sleep: opts.sleep,
    random: opts.random,
    log: opts.log,
    retries: opts.retries,
  };
  const isLocked = opts.isLocked || (() => false);
  const botLogin = opts.botLogin ? String(opts.botLogin).toLowerCase() : null;
  const warn = opts.warn || (() => {});

  for (const [tier, queries] of Object.entries(TIER_QUERIES)) {
    let items = queries.flatMap((q) =>
      gh.json(q.args, ghOpts).map((raw) => normalize(raw, q.kind, tier)),
    );
    items = items.filter((it) => !it.labels.includes(NEEDS_HUMAN_LABEL));
    if (tier === 'P4' && botLogin !== null) {
      // The no-self-feeding rule itself is untouched (a worker that feeds
      // itself work is the runaway the tiers exist to prevent) — but the drop
      // must not be silent (stage 28): say how much was filtered, once.
      const before = items.length;
      items = items.filter((it) => (it.author || '').toLowerCase() !== botLogin);
      const skipped = before - items.length;
      if (skipped > 0) {
        warn(`skipped ${skipped} self-authored request(s) (no self-feeding; see docs/autonomy.md)`);
      }
    }
    items = items.filter((it) => !isLocked(it));
    if (items.length > 0) {
      items.sort(byCreatedAt);
      return items[0];
    }
  }

  // P5 — `verity next` via its module API; trust the dependency engine for
  // WHAT to work, but not for escalation state: the decision is derived from
  // stage files + GitHub objects and carries no labels, so the needs-human
  // check (the contract "ALL tiers drop escalated items") must be enforced
  // here with one label fetch. Fail closed: if the fetch errors, skip the
  // item — never work something whose escalation state is unknown (#4).
  const decision = (opts.nextDecision || (() => next.dispatch([], { cwd: opts.cwd })))();
  if (decision && decision.action === 'work' && decision.target) {
    const item = {
      tier: 'P5',
      kind: decision.target.kind,
      number: decision.target.number,
      title: null,
      labels: fetchTargetLabels(decision.target, ghOpts),
      createdAt: null,
      author: null,
      headRefName: null,
      decision,
    };
    if (item.labels === null) {
      return null; // label fetch failed — fail closed, stay idle
    }
    if (item.labels.includes(NEEDS_HUMAN_LABEL)) {
      return null; // escalated — parked for a human, worker never works it
    }
    if (!isLocked(item)) {
      return item;
    }
  }
  return null; // idle
}

// One label fetch for a P5 target. Only issue/pr targets have GitHub labels —
// a `stage` target's number is a STAGE number, not an issue number (next.cjs
// emits it when a planned stage has no work-item issue yet), so fetching
// would read an unrelated issue's labels; stages get [] as before. Returns
// lowercased label names, or null when the fetch fails — the caller treats
// null as "state unknown" and skips the item rather than crashing the scan.
function fetchTargetLabels(target, ghOpts) {
  if (target.kind !== 'issue' && target.kind !== 'pr') {
    return [];
  }
  const noun = target.kind;
  try {
    const raw = gh.json([noun, 'view', String(target.number), '--json', 'labels'], ghOpts);
    return labelNames(raw);
  } catch (err) {
    // Unconditional warn: silent fail-closed would be indistinguishable from
    // genuine idle (never-false-green rule — same spirit as smoke's
    // gate:'skipped'). gh's own logging is opt-in via VERITY_GH_LOG.
    const warn = ghOpts.log || ((line) => process.stderr.write(`${line}\n`));
    warn(
      `scanner: P5 label fetch failed for ${noun} #${target.number} (${err.message || err}) — failing closed (idle)`,
    );
    return null;
  }
}

// `fetchTargetLabels` is additionally exported (stage 33) for the worker's
// deferred-refusal fresh-read fallback: it reads a SPECIFIC item's labels from
// the primary DB (`gh <noun> view N --json labels`), NOT the search index, so
// it reflects a just-applied label immediately — the exact property that lets a
// deferred unknown-cost refusal re-check a lagged P1 approval without a search.
module.exports = {
  scan,
  TIER_QUERIES,
  normalize,
  byCreatedAt,
  fetchTargetLabels,
  NEEDS_HUMAN_LABEL,
};
