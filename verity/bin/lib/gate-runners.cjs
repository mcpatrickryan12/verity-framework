// Gate-runner catalog (stage 88, ADR-0030) — `~/.verity/gate-runners.md`, the
// named inventory of machines a project's `gate_runner: remote:<name>` may
// execute gates on. Built on the deployment-methods precedent
// (deployment.cjs): GLOBAL scope (one per machine/user, reused across every
// project, seeded once, never clobbered), named markdown entries, credential
// LOCATIONS only (key file paths, SSH-config entry names) — NEVER secret
// values. Project config references the NAME only; host details, users, and
// IPs never enter any repo (ADR-0030: the engine is not welded to a machine —
// the operator's current box is merely the first catalog entry).
//
// Resolution (`resolveRemote`) is READ-ONLY configuration: it turns a name
// into an SSH target descriptor and nothing more — nothing HERE executes
// remotely (remote EXECUTION lives in gates-remote.cjs, stage 89, which
// consumes the descriptor this resolution returns — AFTER the name
// resolves). Fail-closed at config/preflight time, never mid-run: a missing
// catalog file, an unknown name, a still-`example` placeholder entry, or an
// entry with no host each throw an error naming the catalog path and the
// known entry names — so a typo'd name reads as the CONFIG error it is, not
// as an unimplemented feature. Error text echoes only what the resolution
// needs (name, catalog path, entry names): never key paths or note bodies, so
// nothing credential-shaped can travel into logs or committed records.
//
// Entry names are constrained to the stage-86 `remote:<name>` charset
// (autonomy.GATE_RUNNER_NAME_RE, single-sourced there): a name that validates
// at policy load can always be looked up here, and a heading this parser
// admits can always be configured there. Node built-ins only (zero-dependency
// repo).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const autonomy = require('./autonomy.cjs');
// The deployment catalog's home-dir convention (opts.home → VERITY_HOME →
// ~/.verity) is reused, not re-implemented — ONE answer to "where is the
// operator's global Verity config", shared by both catalogs.
const deployment = require('./deployment.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const TEMPLATE = 'gate-runners.md.tmpl';

const USAGE = 'use list|show|path|edit|ensure';

function globalPath(opts = {}) {
  return path.join(deployment.homeDir(opts), 'gate-runners.md');
}

// Seed the catalog only if absent — NEVER clobber the user's edits (the
// deployment.ensure contract, byte-for-byte the same shape).
function ensure(opts = {}) {
  const p = globalPath(opts);
  if (fs.existsSync(p)) {
    return { created: false, path: p };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, fs.readFileSync(path.join(TEMPLATES_DIR, TEMPLATE), 'utf8'));
  return { created: true, path: p };
}

// A field value like "`gpu.lan` — some trailing prose": the first `backtick
// span` when one leads, else the first whitespace-delimited token — hosts,
// users, and aliases are single tokens; trailing prose is commentary, and
// silently folding it into an SSH target would build a target the operator
// never wrote.
function fieldValue(raw) {
  const t = String(raw).trim();
  const tick = t.match(/^`([^`]*)`/);
  const v = (tick ? tick[1] : t.split(/\s+/)[0]).trim();
  return v === '' ? null : v;
}

// Each runner is a `## <name> — <Title>` section (the deployment-methods
// heading shape); `- **status:**` / `- **host:**` / `- **user:**` lines are
// structured, everything else is free-form notes (credential LOCATIONS live
// there — this parser deliberately never extracts them). status defaults to
// `active` when a user adds a runner without one; the shipped sample is
// `example` so resolution can tell "real host" from "placeholder".
//
// Charset enforcement: a heading whose name is outside the stage-86
// `remote:<name>` charset is NOT an entry — it could never be configured, so
// admitting it would create a runner no policy can name. It also TERMINATES
// the current entry (cur = null) rather than merging its section into the
// previous one: a host/user line under an invalid heading must never
// silently rewrite a neighboring entry's SSH target (that is a wrong-machine
// hazard, not a formatting nit).
function parseRunners(text) {
  const runners = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const head = line.match(/^##\s+(\S+)\s+—\s+(.+)$/);
    if (head) {
      if (cur) {
        runners.push(cur);
      }
      cur = autonomy.GATE_RUNNER_NAME_RE.test(head[1])
        ? {
            name: head[1],
            title: head[2].trim(),
            status: 'active',
            host: null,
            user: null,
            content: line,
          }
        : null;
      continue;
    }
    if (cur) {
      cur.content += `\n${line}`;
      const st = line.match(/^-\s+\*\*status:\*\*\s*(.+)$/i);
      if (st) {
        cur.status = st[1].trim().toLowerCase();
      }
      const host = line.match(/^-\s+\*\*host:\*\*\s*(.+)$/i);
      if (host) {
        cur.host = fieldValue(host[1]);
      }
      const user = line.match(/^-\s+\*\*user:\*\*\s*(.+)$/i);
      if (user) {
        cur.user = fieldValue(user[1]);
      }
    }
  }
  if (cur) {
    runners.push(cur);
  }
  return runners;
}

// The SSH target an entry describes: `user@host` when a user is named, else
// the bare host (an SSH-config alias carries its own user).
function targetFor(entry) {
  return entry.user ? `${entry.user}@${entry.host}` : entry.host;
}

function list(opts = {}) {
  const { path: p } = ensure(opts);
  const runners = parseRunners(fs.readFileSync(p, 'utf8')).map((r) => ({
    name: r.name,
    title: r.title,
    status: r.status,
    host: r.host,
    user: r.user,
  }));
  const configured = runners.filter((r) => r.status !== 'example');
  return { path: p, runners, configured, hasConfigured: configured.length > 0 };
}

function show(name, opts = {}) {
  if (!name) {
    throw new Error('show requires a runner name');
  }
  const { path: p } = ensure(opts);
  const runner = parseRunners(fs.readFileSync(p, 'utf8')).find((r) => r.name === name);
  if (!runner) {
    throw new Error(`no such gate runner: ${name}`);
  }
  return runner;
}

// Open the catalog in $EDITOR when run interactively; otherwise just report
// the path (the agent edits via its own Write tool, not an interactive
// editor) — deployment.edit's exact contract.
function edit(opts = {}) {
  const { path: p } = ensure(opts);
  const editor = opts.editor || process.env.VISUAL || process.env.EDITOR || 'nano';
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : Boolean(process.stdout.isTTY);
  if (!isTTY) {
    return { path: p, editor, opened: false, hint: `open it: ${editor} ${p}` };
  }
  const run = opts.spawn || ((cmd, a) => spawnSync(cmd, a, { stdio: 'inherit' }));
  run(editor, [p]);
  return { path: p, editor, opened: true };
}

// --- resolution: remote:<name> → { host, user, target } ----------------------

// Resolve one `remote:<name>` name against the catalog — called ONCE at run
// start (gates.cjs, before the stage-86 execution refusal) and by doctor's
// catalog probe row. READ-ONLY: deliberately no ensure() here — a gate run
// must never seed the operator's global catalog as a side effect; an absent
// file is the config error it appears to be. Every refusal names the catalog
// path and the KNOWN entry names (all parsed headings — literally the names
// the file knows) so the operator can see the typo; NOTHING else from the
// file (no hosts, no note bodies, no credential locations) enters error text
// that could travel into logs or committed records.
function resolveRemote(name, opts = {}) {
  const p = globalPath(opts);
  if (!fs.existsSync(p)) {
    throw new Error(
      `gate_runner 'remote:${name}': no gate-runner catalog at ${p} — seed and edit it with \`verity gate-runners edit\`, adding a '## ${name} — <title>' entry (ADR-0030: names resolve against the global catalog at preflight, never mid-run); no gates ran and no record is written`,
    );
  }
  const runners = parseRunners(fs.readFileSync(p, 'utf8'));
  const known = runners.map((r) => r.name);
  const knownText = known.length > 0 ? known.join(', ') : '(none)';
  const entry = runners.find((r) => r.name === name);
  if (!entry) {
    throw new Error(
      `gate_runner 'remote:${name}': no entry named '${name}' in the gate-runner catalog ${p} — known entries: ${knownText}; fix the name in .verity/autonomy.yml or add the entry with \`verity gate-runners edit\` (ADR-0030); no gates ran and no record is written`,
    );
  }
  if (entry.status === 'example') {
    // The shipped placeholder must never resolve as a real host: its fields
    // are angle-bracket samples, and SSHing at a sample is a wrong-machine
    // hazard. The deployment catalog's example/configured distinction exists
    // for exactly this "real option vs placeholder" call.
    throw new Error(
      `gate_runner 'remote:${name}': entry '${name}' in ${p} is still '- **status:** example' — a shipped placeholder never resolves as a real host (fail closed); set a real host and '- **status:** active' with \`verity gate-runners edit\``,
    );
  }
  if (!entry.host) {
    throw new Error(
      `gate_runner 'remote:${name}': entry '${name}' in ${p} has no '- **host:** <hostname-or-ssh-config-alias>' line — the SSH target must come from the catalog, never the repo (ADR-0030); add one with \`verity gate-runners edit\``,
    );
  }
  // Stage 90: an option-shaped target never leaves resolution. Every consumer
  // places the resolved target in `ssh -o BatchMode=yes <target> …` argv
  // (gates-remote sshCall, doctor's remote probes), where OpenSSH parses a
  // leading-'-' value as an OPTION, not a hostname (e.g. '-oProxyCommand=…'
  // runs a command) — so a host or user beginning with '-' refuses fail-closed
  // here, at the one chokepoint every consumer already goes through. Echoing
  // the operator's own catalog value is the stage-88 hygiene stance (catalog
  // content may appear in error/doctor text, never in records — this path
  // writes none). parseRunners stays permissive: `list`/`show` still display
  // such an entry so the operator can find and fix it.
  for (const field of ['host', 'user']) {
    const value = entry[field];
    if (typeof value === 'string' && value.startsWith('-')) {
      throw new Error(
        `gate_runner 'remote:${name}': entry '${name}' in ${p} has '- **${field}:** ${value}' beginning with '-' — ssh would parse it as an option, not a target (fail closed); fix the ${field} with \`verity gate-runners edit\``,
      );
    }
  }
  return { name, host: entry.host, user: entry.user, target: targetFor(entry), path: p };
}

// --- CLI (`verity gate-runners <verb>`) --------------------------------------

function dispatch(args, flags) {
  const verb = args[0];
  const opts = { home: flags.home };
  if (verb === 'list') {
    return list(opts);
  }
  if (verb === 'show') {
    return show(args[1], opts);
  }
  if (verb === 'path') {
    const p = globalPath(opts);
    return { path: p, raw: p };
  }
  if (verb === 'ensure') {
    return ensure(opts);
  }
  if (verb === 'edit') {
    return edit(opts);
  }
  throw new Error(`unknown gate-runners verb: ${verb || '(none)'} — ${USAGE}`);
}

module.exports = {
  dispatch,
  edit,
  ensure,
  globalPath,
  list,
  parseRunners,
  resolveRemote,
  show,
  targetFor,
};
