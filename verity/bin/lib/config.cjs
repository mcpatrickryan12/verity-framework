// Verity project config — `.verity/config.json`. Carried pattern from 1.4.
// AUTHOR/DERIVE: writes/reads the project's config knobs (NOT integration state).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  version: '1.0',
  model_profile: 'balanced',
  // Release/Deploy Operator gate: confirm (human) by default, or auto. (spec §6)
  prod_promote: 'confirm',
};

function configPath(cwd) {
  return path.join(cwd, '.verity', 'config.json');
}

function readConfig(cwd) {
  const p = configPath(cwd);
  if (!fs.existsSync(p)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensure(cwd) {
  const p = configPath(cwd);
  if (fs.existsSync(p)) {
    return { created: false, path: p, config: readConfig(cwd) };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = { ...DEFAULTS };
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return { created: true, path: p, config: cfg };
}

function getAt(obj, dotted) {
  let node = obj;
  for (const key of dotted.split('.')) {
    if (node === null || node === undefined) {
      return undefined;
    }
    node = node[key];
  }
  return node;
}

function setAt(obj, dotted, value) {
  const keys = dotted.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (node[keys[i]] === null || typeof node[keys[i]] !== 'object') {
      node[keys[i]] = {};
    }
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

function coerce(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function get(cwd, key) {
  const cfg = readConfig(cwd) || { ...DEFAULTS };
  if (!key) {
    return { config: cfg };
  }
  const value = getAt(cfg, key);
  return {
    key,
    value,
    raw: value === null || value === undefined ? '' : String(value),
  };
}

function set(cwd, key, rawValue) {
  const { config: cfg } = ensure(cwd);
  const value = coerce(rawValue);
  setAt(cfg, key, value);
  fs.writeFileSync(configPath(cwd), `${JSON.stringify(cfg, null, 2)}\n`);
  return { key, value, path: configPath(cwd) };
}

function dispatch(args, flags) {
  const verb = args[0];
  const cwd = flags.cwd || process.cwd();
  if (verb === 'ensure') {
    return ensure(cwd);
  }
  if (verb === 'get') {
    return get(cwd, args[1]);
  }
  if (verb === 'set') {
    return set(cwd, args[1], args[2]);
  }
  throw new Error(`unknown config verb: ${verb || '(none)'} — use ensure|get|set`);
}

module.exports = {
  DEFAULTS,
  configPath,
  readConfig,
  ensure,
  get,
  set,
  dispatch,
  getAt,
  setAt,
  coerce,
};
