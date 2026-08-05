// Usage ledger — `.verity/usage.csv` + `verity usage` CLI (T11, SKETCH §3.4)
// and the daily-limit rollup the worker's §4.1 startup check consumes.
//
// CSV contract (§3.4, extended by stages 3 and 21): header row REQUIRED,
// append-only, one row PER ROLE INVOCATION (rows of one worker run share a
// run_id):
//
//   timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate
//
// Field encodings:
//   - timestamp  ISO-8601 UTC (new Date().toISOString())
//   - roles      role names joined with '+' (e.g. plan+build+review) so the
//                cell never needs CSV quoting; '' when no roles ran. On a
//                per-invocation row this is just that invocation's role (kept
//                for old readers — additive-only evolution, see below)
//   - est_usd    decimal (≤4 places); '' when the run had no cost estimate.
//                '' means UNKNOWN, not $0 (ADR-0008) — readers surface it as
//                null and rollups count it, never sum it as zero
//   - outcome    on a per-invocation row: THAT invocation's outcome
//                (success/gated/failed/infra_error); a run with zero role
//                invocations still writes one row carrying the run outcome
//   - tool_calls integer count of tool-use events in the invocation's
//                stream-json transcript (agent-exec counts them); 0 when unknown
//   - role       the single role this row is attributed to; '' on legacy rows
//                and on the zero-invocation fallback row
//   - gate       stage 21: the gate the RUN ended paused at (the run-level
//                outcome — every row of the run carries the same value); ''
//                when the run did not end gated and on pre-stage-21 rows. The
//                worker's startup breaker reads it to tell an unknown-cost run
//                that is PARKED at the unknown-cost gate (a human was asked)
//                from one that slipped through without a gate (nobody was).
//                Stage 25: a run whose role FAILED with unknown cost carries
//                the stamp too — the failure path parks at the same gate, so
//                a failed row can coexist with a gate cell; the stamp means
//                "a human was asked", not "the run ended gated"
//   - all cells  RFC-4180 escaped anyway (quoted iff containing , " or newline)
//
// ADDITIVE-ONLY EVOLUTION: pre-stage-3 files (9 columns, one row per run) and
// pre-stage-21 files (11 columns, no gate) are still valid — readers accept
// all three headers and all three row widths; missing trailing columns read as
// tool_calls=0, role='', gate=''. Because a run may span several rows, rollups
// count `runs` as DISTINCT run_id values (identical to row-count on legacy
// files, where every row had its own run_id) so `checkDailyLimits` semantics
// are unchanged across formats.
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
// UNKNOWN COST (ADR-0008, stage 18 / #51): an empty est_usd cell is UNKNOWN —
// a provider that reports no dollar figure (codex) writes it on every row. It
// is NOT zero, and nothing downstream may treat it as zero: rows carry
// est_usd: null, rollups sum only the KNOWN spend into `est_usd` and count the
// rest into `unknown_cost_runs` / `unknown_cost_rows`, and checkDailyLimits
// refuses to clear a budget it cannot see all of. A non-empty but unparsable
// cell is a MALFORMED row exactly as before — "unknown" never means "corrupt".
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
  'gate',
];
const HEADER = COLUMNS.join(',');
// Pre-stage-21 files: 11 columns, no gate. Still readable forever.
const STAGE3_COLUMNS = COLUMNS.slice(0, 11);
const STAGE3_HEADER = STAGE3_COLUMNS.join(',');
// Pre-stage-3 files: 9 columns, no tool_calls/role. Still readable forever.
const LEGACY_COLUMNS = COLUMNS.slice(0, 9);
const LEGACY_HEADER = LEGACY_COLUMNS.join(',');

// The worker's unknown-cost gate name (worker/index.cjs UNKNOWN_COST_GATE reads
// this — single source, because checkDailyLimits below matches gate cells
// against it). ADR-0008.
const UNKNOWN_COST_GATE = 'unknown-cost';
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
    gate: summary.gate || '',
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
    // The RUN's terminal gate, not the invocation's — see the header note.
    gate: summary.gate || '',
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

// The bot identity the ledger commit attributes itself to. This commit is the
// WORKER's own action, so it carries a stable non-human identity rather than
// depending on ambient git config — which is UNSET on a fresh CI runner (the
// generated verity-worker.yml sets none), where the commit would otherwise die
// with "Author identity unknown" and the priced audit ledger would silently
// never be committed (#3). The email is a GitHub noreply address: safe and
// non-routable. A single `-c user.name`/`-c user.email` pair sets BOTH the
// author and the committer, and `-c` scopes it to this one command — it never
// mutates the user's git config.
const COMMIT_AUTHOR_NAME = 'verity-worker';
const COMMIT_AUTHOR_EMAIL = 'verity-worker@users.noreply.github.com';

// `git add` + `git commit` of ONLY the csv path, message
// `chore(verity): usage <run-id>`, authored by the bot identity above so it
// succeeds regardless of the ambient git config. Never throws: returns
// { committed: true } or { committed: false, error } — callers log and continue
// (a broken git setup must never fail the run).
function commitUsage(cwd, runId) {
  const message = `chore(verity): usage ${runId}`;
  try {
    execFileSync('git', ['-C', cwd, 'add', '--', CSV_REL_PATH], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        `user.name=${COMMIT_AUTHOR_NAME}`,
        '-c',
        `user.email=${COMMIT_AUTHOR_EMAIL}`,
        'commit',
        '-m',
        message,
        '--',
        CSV_REL_PATH,
      ],
      { stdio: 'pipe' },
    );
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
    if (line === HEADER || line === STAGE3_HEADER || line === LEGACY_HEADER) {
      sawHeader = true; // header row (required on line 1; tolerated if repeated)
      continue;
    }
    if (i === 0) {
      warn(`usage.csv line 1: expected header '${HEADER}' — parsing rows anyway`);
    }
    const cells = splitCsvLine(line);
    // Additive-only evolution: 9-column (pre-stage-3) and 11-column
    // (pre-stage-21) rows are as valid as current ones — the missing trailing
    // cells read as tool_calls=0, role='', gate=''.
    if (
      cells === null ||
      (cells.length !== COLUMNS.length &&
        cells.length !== STAGE3_COLUMNS.length &&
        cells.length !== LEGACY_COLUMNS.length)
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
    // '' is UNKNOWN cost (null), never 0 — see the header note. Anything else
    // that fails to parse stays malformed and skips the row, as it always has.
    const estUsd = row.est_usd === '' ? null : Number(row.est_usd);
    const wallSecs = Number(row.wall_secs);
    const toolCalls = row.tool_calls === '' ? 0 : Number(row.tool_calls);
    if (
      Number.isNaN(ts) ||
      !Number.isFinite(tokensIn) ||
      !Number.isFinite(tokensOut) ||
      (estUsd !== null && !Number.isFinite(estUsd)) ||
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
      gate: row.gate,
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

// `est_usd` is the VERIFIED spend — the sum of rows that reported a cost.
// Unknown-cost rows are never summed as $0 (ADR-0008); they are counted
// separately so no consumer can read "unknown" as "zero":
//   unknown_cost_runs  DISTINCT run_ids with at least one unknown-cost row
//   unknown_cost_rows  those rows themselves (one per role invocation)
// Both are 0 on any ledger whose provider reports real costs, which is what
// keeps the claude path's numbers exactly what they have always been.
// Stage 21 adds unknown_cost_gated_runs: how many of the unknown-cost runs
// ended PARKED at the unknown-cost gate (every unknown-cost row of the run
// carries gate 'unknown-cost' — fail closed: one unstamped row and the run
// does not count). Those runs already asked a human for the ADR-0008 decision;
// the worker's startup breaker uses the count to tell an approvable pause from
// spend that slipped through ungated.
function rollup(rows) {
  const totals = {
    runs: 0,
    tokens_in: 0,
    tokens_out: 0,
    est_usd: 0,
    unknown_cost_runs: 0,
    unknown_cost_rows: 0,
    unknown_cost_gated_runs: 0,
    tool_calls: 0,
    outcomes: {},
  };
  // A run may span several per-invocation rows (shared run_id) since stage 3,
  // so `runs` counts DISTINCT run_ids — identical to row-count on legacy files.
  const runIds = new Set();
  const unknownRunIds = new Set();
  const ungatedUnknownRunIds = new Set();
  for (const r of rows) {
    runIds.add(r.run_id);
    totals.tokens_in += r.tokens_in;
    totals.tokens_out += r.tokens_out;
    if (r.est_usd === null) {
      unknownRunIds.add(r.run_id);
      totals.unknown_cost_rows += 1;
      if (r.gate !== UNKNOWN_COST_GATE) {
        ungatedUnknownRunIds.add(r.run_id);
      }
    } else {
      totals.est_usd += r.est_usd;
    }
    totals.tool_calls += r.tool_calls;
    totals.outcomes[r.outcome] = (totals.outcomes[r.outcome] || 0) + 1;
  }
  totals.runs = runIds.size;
  totals.unknown_cost_runs = unknownRunIds.size;
  totals.unknown_cost_gated_runs = [...unknownRunIds].filter(
    (id) => !ungatedUnknownRunIds.has(id),
  ).length;
  totals.est_usd = Number(totals.est_usd.toFixed(4)); // keep float noise out of output
  return totals;
}

// Per-role attribution over the same rows: role → { rows, tokens_in,
// tokens_out, est_usd, unknown_cost_rows, tool_calls }, keys sorted for stable
// output. `est_usd` is verified spend here too, with the unknown-cost rows
// counted beside it — a group is rows, not runs, so rows is the honest unit
// here. Legacy rows have no role column; they group under their joined roles
// string (e.g. 'plan+build' — pre-stage-3 runs cannot be split honestly), or
// '(unattributed)' when even that is empty.
function rollupByRole(rows) {
  const groups = {};
  for (const r of rows) {
    const key = r.role || r.roles.join('+') || '(unattributed)';
    if (!groups[key]) {
      groups[key] = {
        rows: 0,
        tokens_in: 0,
        tokens_out: 0,
        est_usd: 0,
        unknown_cost_rows: 0,
        tool_calls: 0,
      };
    }
    const g = groups[key];
    g.rows += 1;
    g.tokens_in += r.tokens_in;
    g.tokens_out += r.tokens_out;
    if (r.est_usd === null) {
      g.unknown_cost_rows += 1;
    } else {
      g.est_usd += r.est_usd;
    }
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
// { ok: true, totals } or { ok: false, slug, message, totals } for the worker
// to turn into `verity-worker: 30 <slug>: <message>`. T12's remaining startup
// checks can reuse this as-is.
//
// Stage 18 (ADR-0008): the USD breaker may only speak for spend it can SEE.
// When a ceiling is configured AND today's window contains unknown-cost runs,
// the total is knowingly incomplete, so "under the limit" is not a statement
// this function is entitled to make. `limits.unknown_cost_behavior` — the knob
// ADR-0008 already defines — decides what that costs:
//   gate (default) / fail   → not ok, slug `unknown-cost-budget`, message
//                             naming how many runs were unverifiable
//   allow_with_token_limit  → ok, because the operator explicitly accepted the
//                             token ceilings as the bound; `note` records that
//                             the USD breaker is inert BY CONSENT rather than
//                             letting the caller mistake est_usd for a
//                             verified total
// Genuine overspend is still genuine overspend: the known-spend trip is
// checked FIRST, so a real breach reports `daily-limit`, not doubt.
//
// Stage 21 (#58): under 'gate', a refusal whose every unverifiable run ended
// PARKED at the unknown-cost gate is additionally marked `approvable: true` —
// the gate already asked a human for exactly the decision ADR-0008 prices the
// knob at ("one human approval per run"), so the WORKER may honour a pending
// single-use `verity:approved` instead of wedging on its own question. This
// function still answers not-ok (it cannot see GitHub and never should); the
// caller resolves the approval. Default-closed: any unknown-cost run that did
// NOT pass through the gate (pre-stage-21 rows included — their gate cell is
// empty) leaves `approvable` false, and 'fail' has no approval mechanism at
// all, so nothing changes for stage 18's refusals.
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
  // Below the verified-spend trip: the ceiling was not met by what we can see.
  // Whether that means "under budget" depends on whether we saw everything.
  const unknownRuns = totals.unknown_cost_runs;
  const unverifiable = typeof limits.max_usd_per_day === 'number' && unknownRuns > 0;
  const behavior = limits.unknown_cost_behavior || 'gate';
  const runWord = unknownRuns === 1 ? 'run' : 'runs';
  const verified = `$${totals.est_usd.toFixed(2)}`;
  if (unverifiable && behavior !== 'allow_with_token_limit') {
    const approvable = behavior !== 'fail' && totals.unknown_cost_gated_runs === unknownRuns;
    return {
      ok: false,
      slug: 'unknown-cost-budget',
      approvable,
      message: `daily budget cannot be verified: ${unknownRuns} ${runWord} today (UTC) reported unknown cost (est_usd null), so ${verified} is a floor, not a total — max_usd_per_day ${limits.max_usd_per_day} is unenforceable under unknown_cost_behavior '${behavior}' (ADR-0008)${
        approvable
          ? ' — every unverifiable run ended parked at the unknown-cost gate; a single-use `verity:approved` on the gated item lets exactly one run proceed'
          : ''
      }`,
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
  if (unverifiable) {
    // Reached only under allow_with_token_limit: ok, but say WHY it is ok.
    return {
      ok: true,
      totals,
      note: `USD breaker inert by consent: ${unknownRuns} ${runWord} today (UTC) reported unknown cost, so ${verified} is verified spend only and max_usd_per_day ${limits.max_usd_per_day} was not checked — unknown_cost_behavior 'allow_with_token_limit' makes the token ceilings the bound (ADR-0008)`,
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
  // est_usd is VERIFIED spend. When some of the window's runs reported no cost
  // (ADR-0008), the one-liner must not read as a confident total: the figure
  // gets a `+unknown` suffix and the count of unverifiable runs rides beside
  // it. With nothing unknown — every claude ledger — the line is unchanged.
  const unknown =
    summary.unknown_cost_runs > 0 ? `+unknown unknown_cost_runs=${summary.unknown_cost_runs}` : '';
  return {
    ...summary,
    raw: `runs=${summary.runs} tokens_in=${summary.tokens_in} tokens_out=${summary.tokens_out} est_usd=${summary.est_usd.toFixed(2)}${unknown} days=${summary.days}`,
  };
}

module.exports = {
  COLUMNS,
  CSV_REL_PATH,
  HEADER,
  LEGACY_COLUMNS,
  LEGACY_HEADER,
  STAGE3_COLUMNS,
  STAGE3_HEADER,
  UNKNOWN_COST_GATE,
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
