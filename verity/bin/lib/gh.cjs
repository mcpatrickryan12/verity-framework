// Shared `gh` CLI layer (T07, SKETCH §8.3) — the ONE place verity shells out to
// GitHub. All label/comment/pr/issue operations in autonomy code go through here
// so retries and logging are uniform.
//
// Public surface (keep small):
//   run(args, opts)  -> stdout string. Executes `gh <args...>` with the §8.3 retry
//                       policy: up to 3 retries with jittered exponential backoff,
//                       ONLY on transient failures (HTTP 5xx or GitHub secondary
//                       rate limit); 4xx and everything else fail fast. Throws
//                       GhError when attempts are exhausted or the error is
//                       non-transient.
//   json(args, opts) -> JSON.parse(run(args, opts)).
//   GhError          -> Error subclass: { args, exitCode, stderr, attempts,
//                       transient, reason }. message = first stderr line.
//
// opts (all optional): { cwd, input, retries=3, exec, sleep, random, log }
//   exec/sleep/random/log are injection points for tests — no real subprocess,
//   sleep, or randomness is required to unit-test the retry/backoff machinery.
//
// Logging: one greppable line per attempt on stderr, gated by VERITY_GH_LOG=1
// (the CLI is silent by default; the worker can flip it on). Format:
//   verity:gh status=<ok|retry|fail> attempt=<n>/<max> exit=<code> ms=<ms> reason=<r> cmd="gh ..."
//
// Exported for tests (internal, not a stability contract): backoffMs, classify.
const { execFileSync } = require('node:child_process');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

class GhError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'GhError';
    this.args = info.args;
    this.exitCode = info.exitCode;
    this.stderr = info.stderr;
    this.attempts = info.attempts;
    this.transient = info.transient;
    this.reason = info.reason;
  }
}

// Transient (retriable) = HTTP 5xx or a secondary rate limit, per SKETCH §8.3.
// gh does not encode HTTP status in its exit code, so classify from its output.
function classify(err) {
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  if (/secondary rate limit|submitted too quickly/i.test(text)) {
    return { transient: true, reason: 'secondary-rate-limit' };
  }
  const http = text.match(/HTTP (\d{3})/);
  if (http) {
    return http[1][0] === '5'
      ? { transient: true, reason: 'http-5xx' }
      : { transient: false, reason: `http-${http[1]}` };
  }
  return { transient: false, reason: 'error' };
}

// Jittered exponential backoff: 500ms doubling per retry, scaled by a random
// factor in [0.5, 1.5). `random` is injectable so tests never sleep for real.
// floor (not round) keeps the result in the half-open interval — rounding could
// push a near-1.0 draw up to the excluded upper bound (e.g. retry 2 → 1500).
function backoffMs(retry, random = Math.random) {
  return Math.floor(BASE_DELAY_MS * 2 ** (retry - 1) * (0.5 + random()));
}

// Synchronous sleep (the whole CLI is sync); no busy-wait, no dependency.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultLog(line) {
  if (process.env.VERITY_GH_LOG) {
    process.stderr.write(`${line}\n`);
  }
}

function logLine(status, attempt, maxAttempts, exitCode, ms, reason, args) {
  return (
    `verity:gh status=${status} attempt=${attempt}/${maxAttempts} exit=${exitCode} ` +
    `ms=${ms} reason=${reason || '-'} cmd="gh ${args.join(' ')}"`
  );
}

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

function defaultExec(args, opts) {
  return execFileSync('gh', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

function run(args, opts = {}) {
  const exec = opts.exec || defaultExec;
  const retries = opts.retries ?? MAX_RETRIES;
  const sleep = opts.sleep || sleepSync;
  const random = opts.random || Math.random;
  const log = opts.log || defaultLog;
  const maxAttempts = retries + 1;

  let lastErr;
  let lastClass;
  let attempt = 0;
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const out = exec(args, opts);
      log(logLine('ok', attempt, maxAttempts, 0, Date.now() - t0, null, args));
      return out;
    } catch (err) {
      lastErr = err;
      lastClass = classify(err);
      const exitCode = typeof err.status === 'number' ? err.status : 'spawn';
      const willRetry = lastClass.transient && attempt < maxAttempts;
      log(
        logLine(
          willRetry ? 'retry' : 'fail',
          attempt,
          maxAttempts,
          exitCode,
          Date.now() - t0,
          lastClass.reason,
          args,
        ),
      );
      if (!willRetry) {
        break;
      }
      sleep(backoffMs(attempt, random));
    }
  }

  const attempts = Math.min(attempt, maxAttempts);
  const message =
    firstLine(lastErr?.stderr) || firstLine(lastErr?.message) || `gh ${args.join(' ')} failed`;
  throw new GhError(message, {
    args,
    exitCode: typeof lastErr?.status === 'number' ? lastErr.status : null,
    stderr: String(lastErr?.stderr || ''),
    attempts,
    transient: lastClass.transient,
    reason: lastClass.reason,
  });
}

function json(args, opts = {}) {
  return JSON.parse(run(args, opts));
}

module.exports = { run, json, GhError, backoffMs, classify };
