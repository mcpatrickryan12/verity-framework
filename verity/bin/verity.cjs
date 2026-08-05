#!/usr/bin/env node
// Verity CLI dispatcher — the deterministic "notebook" layer (framework-spec.md §9).
// READ-ONLY w.r.t. integration state; performs framework-conventional acts and
// authors the few writable artifacts. JSON by default; --raw for plain values;
// --cwd to target another project directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./lib/core.cjs');
const config = require('./lib/config.cjs');
const identity = require('./lib/identity.cjs');
const scaffold = require('./lib/scaffold.cjs');
const install = require('./lib/install.cjs');
const adr = require('./lib/adr.cjs');
const contract = require('./lib/contract.cjs');
const catalog = require('./lib/catalog.cjs');
const stage = require('./lib/stage.cjs');
const ledger = require('./lib/ledger.cjs');
const next = require('./lib/next.cjs');
const autonomy = require('./lib/autonomy.cjs');
const agentExec = require('./lib/agent-exec.cjs');
const usage = require('./lib/usage.cjs');
const review = require('./lib/review.cjs');
const release = require('./lib/release.cjs');
const status = require('./lib/status.cjs');
const security = require('./lib/security.cjs');
const handoff = require('./lib/handoff.cjs');
const map = require('./lib/map.cjs');
const recovery = require('./lib/recovery.cjs');
const golive = require('./lib/golive.cjs');
const smoke = require('./lib/smoke.cjs');
const deployment = require('./lib/deployment.cjs');
const doctor = require('./lib/doctor.cjs');
const promotion = require('./lib/promotion.cjs');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--raw') {
      flags.raw = true;
    } else if (a === '--json') {
      flags.json = true;
    } else if (a === '--cwd') {
      i += 1;
      flags.cwd = argv[i];
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        i += 1;
        flags[key] = next;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function emit(result, flags) {
  if (flags.raw) {
    const raw = result && typeof result === 'object' && 'raw' in result ? result.raw : result;
    let text = '';
    if (raw === null || raw === undefined) {
      text = '';
    } else if (typeof raw === 'object') {
      // A structured result with no scalar `raw` — emit compact JSON, never "[object Object]".
      text = JSON.stringify(raw);
    } else {
      text = String(raw);
    }
    process.stdout.write(`${text}\n`);
    return;
  }
  const json = JSON.stringify(result, null, 2);
  // Large payloads spill to a tempfile (the 1.4 convention) so we never blow a
  // consumer's buffer; the caller reads the @file: path.
  if (json.length > 50000) {
    const tmp = path.join(os.tmpdir(), `verity-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, json);
    process.stdout.write(`@file:${tmp}\n`);
    return;
  }
  process.stdout.write(`${json}\n`);
}

const COMMANDS = {
  slug(rest) {
    const slug = core.generateSlug(rest.join(' '));
    return { slug, validation: core.validateSlug(slug), raw: slug };
  },
  timestamp() {
    const ts = new Date().toISOString();
    return { timestamp: ts, raw: ts };
  },
  'verify-path'(rest, flags) {
    const base = flags.cwd || process.cwd();
    const target = path.resolve(base, rest[0] || '');
    const exists = fs.existsSync(target);
    return { path: target, exists, raw: String(exists) };
  },
  config(rest, flags) {
    return config.dispatch(rest, flags);
  },
  identity(rest, flags) {
    return identity.dispatch(rest, flags);
  },
  scaffold(rest, flags) {
    return scaffold.dispatch(rest, flags);
  },
  install(rest, flags) {
    return install.dispatch(rest, flags);
  },
  adr(rest, flags) {
    return adr.dispatch(rest, flags);
  },
  contract(rest, flags) {
    return contract.dispatch(rest, flags);
  },
  guides(rest) {
    return catalog.guidesDispatch(rest);
  },
  feature(rest) {
    return catalog.featureDispatch(rest);
  },
  stage(rest, flags) {
    return stage.dispatch(rest, flags);
  },
  state(rest, flags) {
    return ledger.dispatch(rest, flags);
  },
  // Autonomy dispatch decision (SKETCH §3.1). Human mode = the usual pretty JSON
  // envelope; --json = exactly one compact object on stdout (pipe-safe). Exit code
  // 10 when gated (set in main()), 0 for work/idle — never nonzero for "no work".
  next(rest, flags) {
    return next.dispatch(rest, flags);
  },
  // Autonomy policy (SKETCH §2, §3.2): show effective policy / set a key /
  // validate .verity/autonomy.yml. Policy violations (malformed YAML, schema
  // errors, unconfirmed trust raise) throw PolicyError with exitCode 20, which
  // the catch in main() maps onto the process exit code.
  autonomy(rest, flags) {
    return autonomy.dispatch(rest, flags);
  },
  // Headless single-role execution (SKETCH §3.3) — the ONLY place an AI agent
  // is invoked. Emits the result object; outcome → exit code 0/10/20/30 is
  // mapped in main(). Usage/infra errors throw AgentExecError (exitCode 30).
  'agent-exec'(rest, flags) {
    return agentExec.dispatch(rest, flags);
  },
  // Usage ledger rollups (SKETCH §3.4): totals over the last --days N UTC
  // calendar days from .verity/usage.csv — runs, tokens, est USD, outcomes.
  usage(rest, flags) {
    return usage.dispatch(rest, flags);
  },
  review(rest, flags) {
    return review.dispatch(rest, flags);
  },
  release(rest, flags) {
    return release.dispatch(rest, flags);
  },
  status(rest, flags) {
    return status.dispatch(rest, flags);
  },
  security(rest, flags) {
    return security.dispatch(rest, flags);
  },
  handoff(rest, flags) {
    return handoff.dispatch(rest, flags);
  },
  map(rest, flags) {
    return map.dispatch(rest, flags);
  },
  recovery(rest, flags) {
    return recovery.dispatch(rest, flags);
  },
  golive(rest, flags) {
    return golive.dispatch(rest, flags);
  },
  smoke(rest, flags) {
    return smoke.dispatch(rest, flags);
  },
  deployment(rest, flags) {
    return deployment.dispatch(rest, flags);
  },
  // Dev→prod projection builder + verifier + proposer + finalizer (stages
  // 40–44, contracts/production-projection.md + contracts/promotion-records.md).
  // `promotion project <ref>` builds the projection; `promotion verify
  // <staging-dir> [--report <path>] [--baseline <version>]` proves it
  // (in-staging gates, pack-content inspection, opt-in published-tarball
  // byte-match) and extends the report additively; `promotion propose
  // <version> --staging <dir> [--dry-run]` turns a verified projection into
  // the promotion PR in prod plus both provenance records; `promotion
  // finalize <version>` verifies the MERGED promotion tree against the PROM
  // record, then mints the authoritative tag + GitHub Release in prod and
  // completes the record (npm publish NOT executed — O4). Verdicts map onto
  // exit codes 0 / 20 contract violation / 30 infra (set in main()).
  promotion(rest, flags) {
    return promotion.dispatch(rest, flags);
  },
  // Host-dependency preflight (stage 1): one JSON report row per external
  // binary Verity leans on (git, gh + auth, claude + min version). --quiet =
  // exit-code-only; exit 0 iff every check is ok (mapped in main()).
  doctor(rest, flags) {
    return doctor.dispatch(rest, flags);
  },
};

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const noun = positional[0];

  if (!noun || noun === 'help') {
    emit(
      {
        commands: Object.keys(COMMANDS),
        usage: 'verity <command> [args] [--raw] [--cwd <dir>]',
      },
      flags,
    );
    return;
  }

  const handler = COMMANDS[noun];
  if (!handler) {
    process.stderr.write(
      `${JSON.stringify({ error: `unknown command: ${noun}`, commands: Object.keys(COMMANDS) })}\n`,
    );
    process.exit(1);
  }

  try {
    const result = handler(positional.slice(1), flags);
    if (noun === 'next') {
      // SKETCH §3.1 contract: with --json, stdout is exactly ONE compact JSON
      // object and nothing else (pipe-safe — `verity next --json | jq ...`).
      // Exit 10 only when gated; work/idle exit 0 ("no work" is never an error).
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        emit(result, flags);
      }
      process.exitCode = next.exitCodeFor(result);
      return;
    }
    if (noun === 'agent-exec') {
      // SKETCH §3.3: stdout carries the result object (--json = exactly one
      // compact object, pipe-safe like `next --json`); the outcome maps onto
      // exit codes 0 success / 10 gated / 20 failed / 30 infra_error.
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        emit(result, flags);
      }
      process.exitCode = agentExec.exitCodeFor(result);
      return;
    }
    if (noun === 'promotion') {
      // Stage 40 contract: with --json, stdout is exactly ONE compact JSON
      // object (pipe-safe, the `next --json` convention). The result envelope
      // carries the projection verdict; 0 built / 20 contract violation /
      // 30 infra — the report file is written even on failure.
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        emit(result, flags);
      }
      process.exitCode = promotion.exitCodeFor(result);
      return;
    }
    if (noun === 'doctor') {
      // Stage 1 contract: JSON array of per-dependency checks by default;
      // --quiet suppresses stdout entirely and reports via exit code only
      // (0 = every check ok, 1 = something needs attention).
      if (!flags.quiet) {
        emit(result, flags);
      }
      process.exitCode = doctor.exitCodeFor(result);
      return;
    }
    if ((noun === 'autonomy' || noun === 'usage') && flags.json) {
      // SKETCH §3.2 `autonomy show --json` / §3.4 `usage --json`: exactly one
      // compact JSON object on stdout (pipe-safe), same convention as `next --json`.
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    emit(result, flags);
  } catch (err) {
    const payload = { error: err.message };
    if (err.line !== undefined) {
      payload.line = err.line;
    }
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    // Typed errors (e.g. autonomy PolicyError → 20) carry their own exit code;
    // everything else keeps the historical exit 1.
    process.exit(Number.isInteger(err.exitCode) ? err.exitCode : 1);
  }
}

main();
