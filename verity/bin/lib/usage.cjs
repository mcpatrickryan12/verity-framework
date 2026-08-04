// Usage ledger — `.verity/usage.csv` + `verity usage` CLI (T11, SKETCH §3.4)
// and the daily-limit rollup the worker's §4.1 startup check consumes.
//
// CSV contract (§3.4, extended by stage 3): header row REQUIRED, append-only,
// one row PER ROLE INVOCATION (rows of one worker run share a run_id):
//
//   timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role
//
// Field encodings:
//   - timestamp  ISO-8601 UTC (new Date().toISOString())
//   - roles      role names joined with '+' (e.g. plan+build+review) so the
//                cell never needs CSV quoting; '' when no roles ran. On a
//                per-invocation row this is just that invocation's role (kept
//                for old readers — additive-only evolution, see below)
//   - est_usd    decimal (≤4 places); '' when the run had no cost estimate
//   - outcome    on a per-invocation row: THAT invocation's outcome
//                (success/gated/failed/infra_error); a run with zero role
//                invocations still writes one row carrying the run outcome
//   - tool_calls integer count of tool-use events in the invocation's
//                stream-json transcript (agent-exec counts them); 0 when unknown
//   - role       the single role this row is attributed to; '' on legacy rows
//                and on the zero-invocation fallback row
//   - all cells  RFC-4180 escaped anyway (quoted iff containing , " or newline)
//
// ADDITIVE-ONLY EVOLUTION: pre-stage-3 files (9 columns, one row per run) are
// still valid — readers accept both the legacy and current header and both row
// widths; missing trailing columns read as tool_calls=0, role=''. Because a
// run may now span several rows, rollups count `runs` as DISTINCT run_id
// values (identical to row-count on legacy files, where every row had its own
// run_id) so `checkDailyLimits` semantics are unchanged across formats.
//
// TIMEZONE: all day-windowing ("today", `--days N`) is UTC calendar days —
// the ledger stores UTC timestamps and the worker may run from any machine or
// CI runner, so local time would make the daily budget depend on where the
// worker happens to wake up. `--days N` = the last N UTC calendar days
// INCLUDING today (so `--days 1` = today UTC).
//
// MALFORMED INPUT: a missing usage.csv is an empty ledger; malformed rows
// (wrong column count, unparsable numbers/timestamp) are SKIPPED with a
// warning rather than failing the command — the ledger is append-only
// bookkeeping and one corrupt line must not brick `verity usage` or the
// worker's startup check (which would otherwise fail CLOSED and halt
// autonomy over a typo).
//
// The optional git commit (`chore(verity): usage <run-id>`, policy
// `commit_usage: true`, default true) commits ONLY the csv path and NEVER
// throws — a failed commit (not a repo, no git identity, etc.) is reported in
// the return value for the caller to log; the run's outcome must not change.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COLUMNS = [
  'timestamp',
  'run_id',
  'repo',
  'roles',
  'tokens_in',
  'tokens_out',
  'est_usd',
  'wall_secs',
  'outcome',
  'tool_calls',
  'role',
];
const HEADER = COLUMNS.join(',');
// Pre-stage-3 files: 9 columns, no tool_calls/role. Still readable forever.
const LEGACY_COLUMNS = COLUMNS.slice(0, 9);
const LEGACY_HEADER = LEGACY_COLUMNS.join(',');
const CSV_REL_PATH = path.join('.verity', 'usage.csv');

function usagePath(cwd) {
  return path.join(cwd, CSV_REL_PATH);
}

// --- CSV encode/decode (RFC 4180 subset; zero-dep) ---------------------------

function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Split one CSV line into cells, honoring double-quoted cells with "" escapes.
// Returns null when the line is structurally broken (unterminated quote).
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"' && cur === '') {
      quoted = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (quoted) {
    return null;
  }
  cells.push(cur);
  return cells;
}

// --- append (write side) ------------------------------------------------------

// Worker summary ({ runId, repo, outcome, roles, tokens:{in,out}, est_usd,
// wall_secs }) → ordered row object matching COLUMNS. This is the
// zero-invocation shape (run-level totals, role '', tool_calls from the
// summary when present).
function entryFromSummary(summary, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    run_id: summary.runId,
    repo: summary.repo,
    roles: (summary.roles || []).join('+'),
    tokens_in: summary.tokens?.in || 0,
    tokens_out: summary.tokens?.out || 0,
    est_usd: typeof summary.est_usd === 'number' ? Number(summary.est_usd.toFixed(4)) : '',
    wall_secs: summary.wall_secs || 0,
    outcome: summary.outcome,
    tool_calls: summary.tool_calls || 0,
    role: summary.role || '',
  };
}

// One role invocation ({ role, outcome, tokens:{in,out}, est_usd, wall_secs,
// tool_calls } — the agent-exec result plus the role name) → per-invocation
// row attributed to that role, sharing the run's run_id.
function entryFromInvocation(summary, inv, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    run_id: summary.runId,
    repo: summary.repo,
    roles: inv.role || '',
    tokens_in: inv.tokens?.in || 0,
    tokens_out: inv.tokens?.out || 0,
    est_usd: typeof inv.est_usd === 'number' ? Number(inv.est_usd.toFixed(4)) : '',
    wall_secs: inv.wall_secs || 0,
    outcome: inv.outcome,
    tool_calls: inv.tool_calls || 0,
    role: inv.role || '',
  };
}

function formatRow(entry) {
  return COLUMNS.map((c) => escapeCell(entry[c])).join(',');
}

// Append one §3.4 row; create the file (with the required header) and the
// .verity dir if missing. Append-only: never rewrites existing content.
function appendUsage(cwd, entry) {
  const file = usagePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${HEADER}\n`);
  }
  const row = formatRow(entry);
  fs.appendFileSync(file, `${row}\n`);
  return { path: file, row };
}

// `git add` + `git commit` of ONLY the csv path, message
// `chore(verity): usage <run-id>`. Never throws: returns
// { committed: true } or { committed: false, error } — callers log and continue
// (a broken git setup must never fail the run).
function commitUsage(cwd, runId) {
  const message = `chore(verity): usage ${runId}`;
  try {
    execFileSync('git', ['-C', cwd, 'add', '--', CSV_REL_PATH], { stdio: 'pipe' });
    execFileSync('git', ['-C', cwd, 'commit', '-m', message, '--', CSV_REL_PATH], {
      stdio: 'pipe',
    });
    return { committed: true, message };
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { committed: false, message, error: stderr.split('\n')[0] || err.message };
  }
}

// One-call write side for the worker: append one row per role invocation
// (summary.invocations, sharing the summary's run_id) — or the single
// run-level fallback row when the run invoked no roles — then commit ONCE
// when the policy says so. The append can throw (disk full etc. — caller's
// choice); the commit never does.
function record(cwd, summary, opts = {}) {
  const now = opts.now || new Date();
  const invocations = Array.isArray(summary.invocations) ? summary.invocations : [];
  const entries =
    invocations.length > 0
      ? invocations.map((inv) => entryFromInvocation(summary, inv, now))
      : [entryFromSummary(summary, now)];
  let appended;
  for (const entry of entries) {
    appended = appendUsage(cwd, entry);
  }
  const wantCommit = opts.commit !== false;
  const commit = wantCommit ? commitUsage(cwd, summary.runId) : { committed: false };
  return {
    path: appended.path,
    row: appended.row,
    rows: entries.length,
    committed: commit.committed,
    commitError: commit.error || null,
  };
}

// --- read / rollup (the CLI and the §4.1 daily-limit check) -------------------

// Parse usage.csv → { rows, skipped }. Missing file → empty ledger. Each
// malformed line is skipped and reported via opts.warn(message) (default:
// silent collection — the count is always in `skipped`).
function readUsage(cwd, opts = {}) {
  const warn = opts.warn || (() => {});
  const file = usagePath(cwd);
  if (!fs.existsSync(file)) {
    return { path: file, exists: false, rows: [], skipped: 0 };
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rows = [];
  let skipped = 0;
  let sawHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    if (line === HEADER || line === LEGACY_HEADER) {
      sawHeader = true; // header row (required on line 1; tolerated if repeated)
      continue;
    }
    if (i === 0) {
      warn(`usage.csv line 1: expected header '${HEADER}' — parsing rows anyway`);
    }
    const cells = splitCsvLine(line);
    // Additive-only evolution: legacy 9-column rows are as valid as current
    // ones — the missing trailing cells read as tool_calls=0, role=''.
    if (
      cells === null ||
      (cells.length !== COLUMNS.length && cells.length !== LEGACY_COLUMNS.length)
    ) {
      skipped += 1;
      warn(`usage.csv line ${i + 1}: malformed row skipped`);
      continue;
    }
    const row = {};
    for (let c = 0; c < COLUMNS.length; c += 1) {
      row[COLUMNS[c]] = cells[c] ?? '';
    }
    const ts = Date.parse(row.timestamp);
    const tokensIn = Number(row.tokens_in);
    const tokensOut = Number(row.tokens_out);
    const estUsd = row.est_usd === '' ? 0 : Number(row.est_usd);
    const wallSecs = Number(row.wall_secs);
    const toolCalls = row.tool_calls === '' ? 0 : Number(row.tool_calls);
    if (
      Number.isNaN(ts) ||
      !Number.isFinite(tokensIn) ||
      !Number.isFinite(tokensOut) ||
      !Number.isFinite(estUsd) ||
      !Number.isFinite(wallSecs) ||
      !Number.isFinite(toolCalls)
    ) {
      skipped += 1;
      warn(`usage.csv line ${i + 1}: malformed row skipped`);
      continue;
    }
    rows.push({
      timestamp: row.timestamp,
      ts,
      run_id: row.run_id,
      repo: row.repo,
      roles: row.roles === '' ? [] : row.roles.split('+'),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      est_usd: estUsd,
      wall_secs: wallSecs,
      outcome: row.outcome,
      tool_calls: toolCalls,
      role: row.role,
    });
  }
  if (!sawHeader && rows.length === 0 && skipped === 0) {
    warn('usage.csv: empty file without header — treating as empty ledger');
  }
  return { path: file, exists: true, rows, skipped };
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function rollup(rows) {
  const totals = { runs: 0, tokens_in: 0, tokens_out: 0, est_usd: 0, tool_calls: 0, outcomes: {} };
  // A run may span several per-invocation rows (shared run_id) since stage 3,
  // so `runs` counts DISTINCT run_ids — identical to row-count on legacy files.
  const runIds = new Set();
  for (const r of rows) {
    runIds.add(r.run_id);
    totals.tokens_in += r.tokens_in;
    totals.tokens_out += r.tokens_out;
    totals.est_usd += r.est_usd;
    totals.tool_calls += r.tool_calls;
    totals.outcomes[r.outcome] = (totals.outcomes[r.outcome] || 0) + 1;
  }
  totals.runs = runIds.size;
  totals.est_usd = Number(totals.est_usd.toFixed(4)); // keep float noise out of output
  return totals;
}

// Per-role attribution over the same rows: role → { rows, tokens_in,
// tokens_out, est_usd, tool_calls }, keys sorted for stable output. Legacy
// rows have no role column; they group under their joined roles string (e.g.
// 'plan+build' — pre-stage-3 runs cannot be split honestly), or
// '(unattributed)' when even that is empty.
function rollupByRole(rows) {
  const groups = {};
  for (const r of rows) {
    const key = r.role || r.roles.join('+') || '(unattributed)';
    if (!groups[key]) {
      groups[key] = { rows: 0, tokens_in: 0, tokens_out: 0, est_usd: 0, tool_calls: 0 };
    }
    const g = groups[key];
    g.rows += 1;
    g.tokens_in += r.tokens_in;
    g.tokens_out += r.tokens_out;
    g.est_usd += r.est_usd;
    g.tool_calls += r.tool_calls;
  }
  const sorted = {};
  for (const key of Object.keys(groups).sort()) {
    groups[key].est_usd = Number(groups[key].est_usd.toFixed(4));
    sorted[key] = groups[key];
  }
  return sorted;
}

// Totals over the last `days` UTC calendar days including today (UTC).
function summarizeUsage(cwd, opts = {}) {
  const days = opts.days ?? 7;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`--days must be a positive integer, got ${JSON.stringify(opts.days)}`);
  }
  const now = opts.now || new Date();
  const since = startOfUtcDay(now) - (days - 1) * 86_400_000;
  const ledger = readUsage(cwd, opts);
  const windowed = ledger.rows.filter((r) => r.ts >= since);
  const totals = rollup(windowed);
  const summary = {
    days,
    since: new Date(since).toISOString(),
    timezone: 'UTC',
    ...totals,
    skipped_rows: ledger.skipped,
    path: ledger.path,
  };
  if (opts.byRole) {
    summary.by_role = rollupByRole(windowed);
  }
  return summary;
}

// "Today" (UTC) totals — what the worker's §4.1 daily-limit startup check sums.
function todayTotals(cwd, opts = {}) {
  return summarizeUsage(cwd, { ...opts, days: 1 });
}

// §4.1 startup check: daily limits not already exceeded. Returns
// { ok: true, totals } or { ok: false, slug: 'daily-limit', message, totals }
// for the worker to turn into `verity-worker: 30 daily-limit: <message>`.
// T12's remaining startup checks can reuse this as-is.
function checkDailyLimits(cwd, limits, opts = {}) {
  const totals = todayTotals(cwd, opts);
  if (typeof limits.max_usd_per_day === 'number' && totals.est_usd >= limits.max_usd_per_day) {
    return {
      ok: false,
      slug: 'daily-limit',
      message: `daily budget reached: est $${totals.est_usd.toFixed(2)} spent today (UTC) >= max_usd_per_day ${limits.max_usd_per_day}`,
      totals,
    };
  }
  if (Number.isInteger(limits.max_runs_per_day) && totals.runs >= limits.max_runs_per_day) {
    return {
      ok: false,
      slug: 'daily-limit',
      message: `daily run cap reached: ${totals.runs} runs today (UTC) >= max_runs_per_day ${limits.max_runs_per_day}`,
      totals,
    };
  }
  return { ok: true, totals };
}

// --- CLI: `verity usage [--days 7] [--by-role] [--json]` (§3.4) ---------------

function dispatch(args, flags) {
  const usageLine = 'verity usage [--days 7] [--by-role] [--json]';
  if (args.length > 0) {
    throw new Error(`usage takes no positional arguments — ${usageLine}`);
  }
  const cwd = flags.cwd || process.cwd();
  let days = 7;
  if (flags.days !== undefined) {
    days = Number(flags.days);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error(`--days must be a positive integer, got '${flags.days}'`);
    }
  }
  if (flags['by-role'] !== undefined && flags['by-role'] !== true) {
    throw new Error(`--by-role takes no value — ${usageLine}`);
  }
  // Warnings go to stderr so `usage --json` stdout stays exactly one object.
  const summary = summarizeUsage(cwd, {
    days,
    byRole: flags['by-role'] === true,
    warn: (msg) => process.stderr.write(`verity usage: warn: ${msg}\n`),
  });
  if (flags.json) {
    return summary; // --json: exactly the totals object, no presentation extras
  }
  return {
    ...summary,
    raw: `runs=${summary.runs} tokens_in=${summary.tokens_in} tokens_out=${summary.tokens_out} est_usd=${summary.est_usd.toFixed(2)} days=${summary.days}`,
  };
}

module.exports = {
  COLUMNS,
  CSV_REL_PATH,
  HEADER,
  LEGACY_COLUMNS,
  LEGACY_HEADER,
  appendUsage,
  checkDailyLimits,
  commitUsage,
  dispatch,
  entryFromInvocation,
  entryFromSummary,
  formatRow,
  readUsage,
  record,
  rollup,
  rollupByRole,
  splitCsvLine,
  summarizeUsage,
  todayTotals,
  usagePath,
};
