// Design guides + drop-in feature catalog (framework-spec.md §4.5).
// Guides are RECOMMENDATIONS the Architect reviews; features are pre-packaged
// stage-sets the Architect can offer. Both ship as sample content under
// design-guides/ and are read-only discovery here (org override is future config).
const fs = require('node:fs');
const path = require('node:path');

// Ships inside the package internals (verity/design-guides) so it travels with
// `verity install` and npm publish.
const GUIDES_DIR = path.join(__dirname, '..', '..', 'design-guides');
const FEATURES_DIR = path.join(GUIDES_DIR, 'features');

function parseFrontmatter(text) {
  const meta = {};
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }
  return meta;
}

function listDir(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const meta = parseFrontmatter(fs.readFileSync(path.join(dir, name), 'utf8'));
      return { id: name.replace(/\.md$/, ''), title: meta.title || name, ...meta };
    });
}

function showFile(dir, id) {
  if (!id) {
    throw new Error('show requires an id');
  }
  const file = path.join(dir, `${id}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`not found: ${id}`);
  }
  return { id, content: fs.readFileSync(file, 'utf8') };
}

function guidesDispatch(args) {
  const verb = args[0];
  if (verb === 'list') {
    return { guides: listDir(GUIDES_DIR) };
  }
  if (verb === 'show') {
    return showFile(GUIDES_DIR, args[1]);
  }
  throw new Error(`unknown guides verb: ${verb || '(none)'} — use list|show`);
}

function featureDispatch(args) {
  const verb = args[0];
  if (verb === 'list') {
    return { features: listDir(FEATURES_DIR) };
  }
  if (verb === 'show') {
    return showFile(FEATURES_DIR, args[1]);
  }
  throw new Error(`unknown feature verb: ${verb || '(none)'} — use list|show`);
}

module.exports = {
  GUIDES_DIR,
  FEATURES_DIR,
  parseFrontmatter,
  listDir,
  guidesDispatch,
  featureDispatch,
};
