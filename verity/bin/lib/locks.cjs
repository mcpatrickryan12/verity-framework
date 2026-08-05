// Lock protocol (T09, SKETCH §4.3) — GitHub-native item locks for the worker.
//
// State lives entirely on the GitHub item (issue OR pull request) as:
//   - the `verity:in-progress` label (vocabulary from labels.cjs, T02), and
//   - machine-parsable comments. Exact formats (frozen — §4.4 failure counting
//     greps `unlock:<id> outcome:failed*`):
//       lock comment:   "lock:<run-id> expires:<iso8601>"            (acquire)
//                       "lock:<run-id> expires:<iso8601> reclaimed:<old-run-id>"
//                                                                    (stale reclaim)
//       unlock comment: "unlock:<run-id> outcome:<outcome>"          (release)
//     Parsing is anchored at the START of the comment body, so run-summary or
//     human comments that merely *mention* lock:/unlock: never match. No other
//     module may post comments whose body starts with "lock:" or "unlock:".
//
// Protocol (SKETCH §4.3, §8 invariants):
//   acquire  — re-fetch the item; abort {acquired:false, reason:'fresh-lock'}
//              if the verity:in-progress label is present with a FRESH lock
//              comment (expires > now). Otherwise add the label and comment
//              "lock:<run-id> expires:<now + ttlMinutes*1.5>". A present label
//              whose last lock comment has expires < now (or is unparseable,
//              or is missing entirely) is STALE → proceed and note the reclaim
//              in the lock comment. The re-fetch→label race window is accepted
//              for v1 (single worker per repo; Actions `concurrency:` covers
//              the Actions driver).
//   release  — remove the label and comment "unlock:<run-id> outcome:<...>".
//              Designed to run in `finally`: it NEVER throws (errors are
//              swallowed into {released:false, errors} + one stderr log line)
//              and is idempotent-ish (label-already-absent is success). Do NOT
//              call release after acquire returned {acquired:false} — that
//              would clobber the other run's lock; the caller exits 0 "locked".
//
// Issue vs PR: every pull request IS an issue in GitHub's REST API, so all
// label/comment/read operations here go through `gh api repos/<r>/issues/<n>/…`
// — one uniform code path for both kinds (no gh issue/pr subcommand fork, and
// no dependency on `gh issue comment` happening to accept PR numbers).
//
// All gh access goes through the shared layer (gh.cjs, T07: retry on
// 5xx/secondary-rate-limit, uniform logging). Clock is injectable via
// opts.now (ms number or () => ms) so stale-lock tests never touch Date.now.
//
// Public surface (T08 scanner + T10 run loop consume):
//   acquire(item, {runId, ttlMinutes, now, repo, ...ghOpts})
//   release(item, {runId, outcome, repo, ...ghOpts})        // never throws
//   isFreshlyLocked(item, {now, comments, repo, ...ghOpts}) -> boolean
//   countFailures(item, {comments, repo, ...ghOpts})        -> number
//   readComments(item, {repo, ...ghOpts})                   -> comment[]
// `item` = number | {number, repo?, ...}. `comments` (pre-fetched array of
// comment objects or body strings) lets the scanner decide without N+1 fetches.
// Pure helpers exported for tests/consumers: parseLockEvent, lockState,
// lockCommentBody, unlockCommentBody, LOCK_LABEL, TTL_FACTOR.
const gh = require('./gh.cjs');
const { LABELS } = require('./labels.cjs');

const LOCK_LABEL = (() => {
  const label = LABELS.find((l) => l.name === 'verity:in-progress');
  if (!label) {
    throw new Error('locks.cjs: verity:in-progress missing from label vocabulary');
  }
  return label.name;
})();

// SKETCH §4.3: expires = now + max_wall_clock * 1.5. Callers pass the policy's
// limits.max_wall_clock_min as ttlMinutes; the 1.5 headroom lives here.
const TTL_FACTOR = 1.5;
const PER_PAGE = 100;
const MAX_PAGES = 50;

const LOCK_RE = /^lock:(\S+)\s+expires:(\S+)(?:\s+reclaimed:(\S+))?/;
const UNLOCK_RE = /^unlock:(\S+)\s+outcome:(\S+)/;

function nowMs(opts) {
  const n = opts?.now;
  if (typeof n === 'function') {
    return n();
  }
  return n ?? Date.now();
}

function itemNumber(item) {
  if (Number.isInteger(item)) {
    return item;
  }
  if (item && Number.isInteger(item.number)) {
    return item.number;
  }
  throw new TypeError('locks: item must be a number or have an integer .number');
}

// `gh api` resolves {owner}/{repo} from the cwd's git remote; an explicit
// "owner/name" on the item or opts (the worker's --repo) takes precedence.
function apiBase(item, opts) {
  const repo = item?.repo || opts?.repo || '{owner}/{repo}';
  return `repos/${repo}/issues/${itemNumber(item)}`;
}

// Forward only the gh.cjs seams — lock-level opts (now, runId, …) stay here.
function ghOpts(opts = {}) {
  const out = {};
  for (const key of ['cwd', 'retries', 'exec', 'sleep', 'random', 'log']) {
    if (opts[key] !== undefined) {
      out[key] = opts[key];
    }
  }
  return out;
}

function fetchItem(item, opts) {
  return gh.json(['api', apiBase(item, opts)], ghOpts(opts));
}

// Issue-comments REST endpoint returns ascending by created_at; paginate
// manually (no --slurp, so no gh-version constraint) — the LAST lock/unlock
// event decides, so we must see every page.
function fetchComments(item, opts) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = gh.json(
      ['api', `${apiBase(item, opts)}/comments?per_page=${PER_PAGE}&page=${page}`],
      ghOpts(opts),
    );
    all.push(...batch);
    if (batch.length < PER_PAGE) {
      break;
    }
  }
  return all;
}

// The paginated comment stream for an item, exposed so a consumer that needs
// the item's own history (stage 19's no-progress strike reads the worker's §7
// run summaries) does not re-implement pagination or bypass the gh layer. Pure
// read: no labels, no comments, no lock semantics.
function readComments(item, opts = {}) {
  return fetchComments(item, opts);
}

function lockCommentBody(runId, expiresIso, reclaimedFrom) {
  const note = reclaimedFrom ? ` reclaimed:${reclaimedFrom}` : '';
  return `lock:${runId} expires:${expiresIso}${note}`;
}

function unlockCommentBody(runId, outcome) {
  return `unlock:${runId} outcome:${outcome}`;
}

// One comment body -> lock event | unlock event | null (not a lock comment).
function parseLockEvent(body) {
  const text = String(body ?? '');
  const lock = text.match(LOCK_RE);
  if (lock) {
    return { kind: 'lock', runId: lock[1], expires: lock[2], reclaimed: lock[3] || null };
  }
  const unlock = text.match(UNLOCK_RE);
  if (unlock) {
    return { kind: 'unlock', runId: unlock[1], outcome: unlock[2] };
  }
  return null;
}

// Fold the comment stream (ascending) down to the LAST lock/unlock event.
// Last event unlock (or no events) -> not locked. Last event lock -> locked;
// fresh iff expires parses AND is in the future — an unparseable expires is
// stale by design so a malformed lock can never deadlock an item.
function lockState(comments, opts = {}) {
  const now = nowMs(opts);
  let last = null;
  for (const comment of comments || []) {
    const event = parseLockEvent(typeof comment === 'string' ? comment : comment?.body);
    if (event) {
      last = event;
    }
  }
  if (!last || last.kind === 'unlock') {
    return { locked: false, fresh: false, runId: last ? last.runId : null, expires: null };
  }
  const expiresAt = Date.parse(last.expires);
  return {
    locked: true,
    fresh: Number.isFinite(expiresAt) && expiresAt > now,
    runId: last.runId,
    expires: last.expires,
  };
}

// The scanner/worker skip predicate (§4.2 "excluding items whose last lock:
// comment is fresh"). Pass opts.comments to decide from already-fetched data.
function isFreshlyLocked(item, opts = {}) {
  const comments = opts.comments ?? fetchComments(item, opts);
  const state = lockState(comments, opts);
  return state.locked && state.fresh;
}

// §4.4 failure counting for T10's 2-strike rule: `unlock:<id> outcome:failed*`
// — counts outcomes failed, failed_once, … ; success/gated/limit/infra do not.
function countFailures(item, opts = {}) {
  const comments = opts.comments ?? fetchComments(item, opts);
  let count = 0;
  for (const comment of comments || []) {
    const event = parseLockEvent(typeof comment === 'string' ? comment : comment?.body);
    if (event && event.kind === 'unlock' && event.outcome.startsWith('failed')) {
      count += 1;
    }
  }
  return count;
}

function addLockLabel(item, opts) {
  gh.run(
    ['api', '-X', 'POST', `${apiBase(item, opts)}/labels`, '-f', `labels[]=${LOCK_LABEL}`],
    ghOpts(opts),
  );
}

function removeLockLabel(item, opts) {
  gh.run(
    ['api', '-X', 'DELETE', `${apiBase(item, opts)}/labels/${encodeURIComponent(LOCK_LABEL)}`],
    ghOpts(opts),
  );
}

function postComment(item, body, opts) {
  gh.run(
    ['api', '-X', 'POST', `${apiBase(item, opts)}/comments`, '-f', `body=${body}`],
    ghOpts(opts),
  );
}

// acquire(item, {runId, ttlMinutes, now?, repo?, ...ghOpts})
//   -> { acquired: true, runId, expires, reclaimed: null | {runId, expires} }
//   -> { acquired: false, reason: 'fresh-lock', holder: {runId, expires} }
// Throws GhError on GitHub failures (caller's finally-release cleans up any
// partial acquire) and TypeError on bad arguments.
function acquire(item, opts = {}) {
  const { runId, ttlMinutes } = opts;
  if (typeof runId !== 'string' || runId.length === 0 || /\s/.test(runId)) {
    throw new TypeError('locks.acquire: runId must be a non-empty string without whitespace');
  }
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new TypeError('locks.acquire: ttlMinutes must be a positive number');
  }
  const now = nowMs(opts);

  // Re-fetch (never trust the scanner's possibly-stale snapshot).
  const fetched = fetchItem(item, opts);
  const labels = (fetched.labels || []).map((l) => (typeof l === 'string' ? l : l?.name));
  const hasLabel = labels.includes(LOCK_LABEL);
  const state = lockState(fetchComments(item, opts), { now });

  // §4.3 abort condition, literally: label present AND fresh lock comment.
  if (hasLabel && state.locked && state.fresh) {
    return {
      acquired: false,
      reason: 'fresh-lock',
      holder: { runId: state.runId, expires: state.expires },
    };
  }

  // Label without a fresh lock = stale → reclaim (note it in the new lock
  // comment). Label with NO lock comment at all is treated as reclaimable too
  // ('unknown' holder) — a bare label must never deadlock an item forever.
  let reclaimed = null;
  if (hasLabel) {
    reclaimed = state.locked
      ? { runId: state.runId, expires: state.expires }
      : { runId: 'unknown', expires: null };
  }

  const expires = new Date(now + ttlMinutes * TTL_FACTOR * 60_000).toISOString();
  addLockLabel(item, opts);
  postComment(item, lockCommentBody(runId, expires, reclaimed ? reclaimed.runId : null), opts);
  return { acquired: true, runId, expires, reclaimed };
}

function firstLine(err) {
  return String(err?.message || err).split('\n')[0];
}

// release(item, {runId, outcome, repo?, ...ghOpts})
//   -> { released: true } | { released: false, errors: [string] }
// MUST be safe in `finally`, even after a partial acquire: never throws,
// label-already-gone (HTTP 404) counts as success, and the unlock comment is
// still attempted when label removal fails. Failures are logged as one
// greppable stderr line (override with opts.log).
function release(item, opts = {}) {
  const runId = typeof opts.runId === 'string' && opts.runId ? opts.runId : 'unknown';
  const outcome = typeof opts.outcome === 'string' && opts.outcome ? opts.outcome : 'unknown';
  const log = opts.log || ((line) => process.stderr.write(`${line}\n`));
  const errors = [];
  let number = '?';
  try {
    number = itemNumber(item);
    try {
      removeLockLabel(item, opts);
    } catch (err) {
      if (err?.reason !== 'http-404') {
        errors.push(`remove-label: ${firstLine(err)}`);
      }
    }
    try {
      postComment(item, unlockCommentBody(runId, outcome), opts);
    } catch (err) {
      errors.push(`unlock-comment: ${firstLine(err)}`);
    }
  } catch (err) {
    errors.push(firstLine(err));
  }
  if (errors.length > 0) {
    try {
      log(
        `verity:locks status=release-error item=${number} run=${runId} errors="${errors.join('; ')}"`,
      );
    } catch {
      // logging must never break a finally block either
    }
    return { released: false, errors };
  }
  return { released: true };
}

module.exports = {
  acquire,
  release,
  isFreshlyLocked,
  countFailures,
  readComments,
  // pure helpers / constants (used by tests and by T08/T10 for parsing)
  parseLockEvent,
  lockState,
  lockCommentBody,
  unlockCommentBody,
  LOCK_LABEL,
  TTL_FACTOR,
};
