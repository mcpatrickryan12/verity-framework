// Verity deployment methods (framework-spec.md — deployment-target feature).
//
// TWO scopes, deliberately separate:
//
//   1. GLOBAL catalog — `~/.verity/deployment-methods.md`. Your private inventory
//      of where you CAN deploy (one per machine/user, reused across every project).
//      Seeded at `verity install`, edited with `verity deployment edit`, read by the
//      Architect with `verity deployment list`. Holds credential LOCATIONS, never
//      secret values. NOT in any repo.
//
//   2. PER-PROJECT access file — `.verity/deploy-access.md`. Written by the Architect
//      for ONE app: how to reach THAT app's host. Gitignored + shared out-of-band; a
//      secret-free pointer (`.verity/deploy-access.README.md`) IS committed so a
//      teammate without the file is told to get it from the project admin.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const identity = require('./identity.cjs');
const { render } = require('./core.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const ACCESS_FILE = '.verity/deploy-access.md'; // gitignored real file
const ACCESS_POINTER = '.verity/deploy-access.README.md'; // committed pointer

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

// --- GLOBAL catalog -------------------------------------------------------

// User-global, harness-independent, and OUTSIDE the install dir (which `verity
// install` clobbers on every reinstall). VERITY_HOME / opts.home override for tests.
function homeDir(opts = {}) {
  return opts.home || process.env.VERITY_HOME || path.join(os.homedir(), '.verity');
}

function globalPath(opts = {}) {
  return path.join(homeDir(opts), 'deployment-methods.md');
}

// Seed the catalog only if absent — NEVER clobber the user's edits.
function ensure(opts = {}) {
  const p = globalPath(opts);
  if (fs.existsSync(p)) {
    return { created: false, path: p };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, readTemplate('deployment-methods.md.tmpl'));
  return { created: true, path: p };
}

// Each method is a `## <id> — <Title>` section; `- **status:** <x>` tags it.
// status defaults to `active` when a user adds a method without one; the shipped
// samples are `example` so the Architect can tell "real option" from "placeholder".
function parseMethods(text) {
  const methods = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const head = line.match(/^##\s+([a-z0-9][a-z0-9-]*)\s+—\s+(.+)$/);
    if (head) {
      if (cur) {
        methods.push(cur);
      }
      cur = { id: head[1], title: head[2].trim(), status: 'active', content: line };
      continue;
    }
    if (cur) {
      cur.content += `\n${line}`;
      const st = line.match(/^-\s+\*\*status:\*\*\s*(.+)$/i);
      if (st) {
        cur.status = st[1].trim().toLowerCase();
      }
    }
  }
  if (cur) {
    methods.push(cur);
  }
  return methods;
}

function list(opts = {}) {
  const { path: p } = ensure(opts);
  const methods = parseMethods(fs.readFileSync(p, 'utf8')).map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
  }));
  const configured = methods.filter((m) => m.status !== 'example');
  return { path: p, methods, configured, hasConfigured: configured.length > 0 };
}

function show(id, opts = {}) {
  if (!id) {
    throw new Error('show requires a method id');
  }
  const { path: p } = ensure(opts);
  const method = parseMethods(fs.readFileSync(p, 'utf8')).find((m) => m.id === id);
  if (!method) {
    throw new Error(`no such deployment method: ${id}`);
  }
  return method;
}

// Open the catalog in $EDITOR when run interactively; otherwise just report the
// path (the agent edits via its own Write tool, not an interactive editor).
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

// --- PER-PROJECT access ---------------------------------------------------

function adminFor(cwd) {
  try {
    const { manifest } = identity.get(cwd);
    return manifest.owner || manifest.name || manifest.slug || '(project admin)';
  } catch (_e) {
    return '(project admin — lock identity first)';
  }
}

// Add a line to the project .gitignore if not already present. Returns whether the
// file changed (idempotent).
function ensureIgnored(cwd, line) {
  const gi = path.join(cwd, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === line)) {
    return false;
  }
  const prefix = text.length && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${text}${prefix}${line}\n`);
  return true;
}

// Set up the committed pointer + gitignore for a project's access file. Does NOT
// write the real access file — the Architect writes that with real host detail.
function initAccess(cwd) {
  fs.mkdirSync(path.join(cwd, '.verity'), { recursive: true });
  const admin = adminFor(cwd);
  const ignored = ensureIgnored(cwd, ACCESS_FILE);

  const pointer = path.join(cwd, ACCESS_POINTER);
  let pointerCreated = false;
  if (!fs.existsSync(pointer)) {
    fs.writeFileSync(pointer, render(readTemplate('deploy-access-pointer.md.tmpl'), { admin }));
    pointerCreated = true;
  }

  return {
    accessFile: ACCESS_FILE,
    accessPath: path.join(cwd, ACCESS_FILE),
    pointer: ACCESS_POINTER,
    pointerCreated,
    gitignoreUpdated: ignored,
    admin,
    next: `Write ${ACCESS_FILE} with how to reach this app's host — credential LOCATIONS only.`,
  };
}

// Report whether THIS machine has the (gitignored) access file; if not, name the
// admin to request it from.
function accessStatus(cwd) {
  const present = fs.existsSync(path.join(cwd, ACCESS_FILE));
  const admin = adminFor(cwd);
  return {
    present,
    accessFile: ACCESS_FILE,
    pointerPresent: fs.existsSync(path.join(cwd, ACCESS_POINTER)),
    admin,
    message: present
      ? `${ACCESS_FILE} is present.`
      : `${ACCESS_FILE} not found — request it from the project admin: ${admin}.`,
  };
}

function dispatch(args, flags) {
  const verb = args[0];
  const cwd = flags.cwd || process.cwd();
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
  if (verb === 'init-access') {
    return initAccess(cwd);
  }
  if (verb === 'access') {
    return accessStatus(cwd);
  }
  throw new Error(
    `unknown deployment verb: ${verb || '(none)'} — use list|show|path|edit|ensure|init-access|access`,
  );
}

module.exports = {
  homeDir,
  globalPath,
  ensure,
  parseMethods,
  list,
  show,
  edit,
  initAccess,
  accessStatus,
  dispatch,
  ACCESS_FILE,
  ACCESS_POINTER,
};
