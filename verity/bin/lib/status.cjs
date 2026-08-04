// Release/Deploy Operator — runtime-truth artifact (framework-spec.md §4.6 / D6).
// `.verity/runtime.json` is the structured single-writer (Operator) store; STATUS.md
// is the committed human-readable rendering of it. Records secret LOCATIONS only —
// never values ("a map to secrets, not a copy").
const fs = require('node:fs');
const path = require('node:path');

const { getAt, setAt, coerce } = require('./config.cjs');

const DEFAULTS = {
  version: null,
  deployed_at: null,
  rollback_from: null,
  environments: {},
  secret_locations: [],
  notes: [],
};

function runtimePath(cwd) {
  return path.join(cwd, '.verity', 'runtime.json');
}

function read(cwd) {
  const p = runtimePath(cwd);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { ...DEFAULTS };
}

function write(cwd, data) {
  fs.mkdirSync(path.dirname(runtimePath(cwd)), { recursive: true });
  fs.writeFileSync(runtimePath(cwd), `${JSON.stringify(data, null, 2)}\n`);
}

function section(title, items) {
  const out = [`## ${title}`];
  if (items && items.length > 0) {
    for (const x of items) {
      out.push(`- ${x}`);
    }
  } else {
    out.push('- (none)');
  }
  out.push('');
  return out;
}

function render(cwd, data) {
  const envItems = Object.entries(data.environments || {}).map(
    ([k, v]) => `**${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`,
  );
  const lines = [
    '# Status & Handoff',
    '',
    '> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`',
    '> by the Release/Deploy Operator. Secret LOCATIONS only — never values.',
    '',
    `**Live version:** ${data.version || '(none)'}`,
    `**Deployed at:** ${data.deployed_at || '(not deployed)'}`,
    `**Rollback from:** ${data.rollback_from || '(n/a)'}`,
    '',
    ...section('Environments', envItems),
    ...section(
      'Secret locations (names + on-disk locations only, never values)',
      data.secret_locations,
    ),
    ...section('Coordination notes', data.notes),
  ];
  fs.writeFileSync(path.join(cwd, 'STATUS.md'), `${lines.join('\n').trim()}\n`);
}

function show(cwd) {
  return { runtime: read(cwd) };
}

function set(cwd, field, rawValue) {
  if (!field) {
    throw new Error('status set requires a field');
  }
  const data = read(cwd);
  setAt(data, field, coerce(rawValue));
  write(cwd, data);
  render(cwd, data);
  return { field, value: getAt(data, field), runtime: runtimePath(cwd) };
}

function append(cwd, listField, value) {
  const data = read(cwd);
  const list = Array.isArray(data[listField]) ? data[listField] : [];
  list.push(value);
  data[listField] = list;
  write(cwd, data);
  render(cwd, data);
  return { field: listField, count: list.length };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0] || 'show';
  if (verb === 'show') {
    return show(cwd);
  }
  if (verb === 'set') {
    return set(cwd, args[1], args[2]);
  }
  if (verb === 'note') {
    return append(cwd, 'notes', args.slice(1).join(' '));
  }
  if (verb === 'secret') {
    return append(cwd, 'secret_locations', args.slice(1).join(' '));
  }
  if (verb === 'render') {
    render(cwd, read(cwd));
    return { rendered: path.join(cwd, 'STATUS.md') };
  }
  throw new Error(`unknown status verb: ${verb} — use show|set|note|secret|render`);
}

module.exports = { DEFAULTS, runtimePath, read, render, show, set, append, dispatch };
