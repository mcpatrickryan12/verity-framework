// Production content classification — the ONE shared matcher (stage 40, #107).
//
// The matching semantics of .verity/production-content-classification.yml
// (documented in that file's header, frozen into contracts/production-projection.md)
// are implemented exactly once, here, and consumed by BOTH:
//   - the CI gate (tests/production-classification.test.cjs), and
//   - the promotion projection engine (promotion.cjs).
// A second implementation is the mirror-drift bug class the dev/prod split
// assessment structurally excludes — do not fork this logic.
//
// Semantics:
//   - `**` matches any characters including `/`; `*` matches any except `/`.
//   - A pattern with no wildcard matches exactly one path.
//   - Precedence: among matching rules, the LONGEST literal prefix (characters
//     before the first wildcard) wins. A tie between two matching rules is an
//     error, as is a path matching no rule — the caller fails closed on both.

const BUCKETS = ['public', 'private', 'generated'];

// --- minimal strict parser for the classification's YAML shape ---------------
// Supports exactly: top-level `key: value` / `key:`, and a list of flat maps
// (`- key: value` items with 4-space-indented continuation keys). Comments and
// blank lines are skipped; anything else throws. Deliberately no general YAML.

function stripComment(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !double) {
      single = !single;
    } else if (c === '"' && !single) {
      double = !double;
    } else if (c === '#' && !single && !double && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw, line) {
  const t = raw.trim();
  if (t.startsWith('"')) {
    const v = JSON.parse(t); // JSON strings are a compatible subset of YAML double-quoting
    if (typeof v !== 'string') {
      throw new Error(`line ${line}: expected a string scalar`);
    }
    return v;
  }
  if (/^-?\d+$/.test(t)) {
    return Number.parseInt(t, 10);
  }
  return t;
}

function parseClassification(text) {
  const doc = {};
  let list = null; // the array currently receiving `- ` items
  let item = null; // the map currently receiving continuation keys
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const n = i + 1;
    const visible = stripComment(lines[i]);
    if (visible.trim() === '') {
      continue;
    }
    let m = /^(\w[\w.-]*):\s*(.*)$/.exec(visible);
    if (m) {
      // top level: `key: value` or `key:` opening a list
      item = null;
      if (m[2] === '') {
        list = [];
        doc[m[1]] = list;
      } else {
        list = null;
        doc[m[1]] = parseScalar(m[2], n);
      }
      continue;
    }
    m = /^ {2}- (\w[\w.-]*): (.+)$/.exec(visible);
    if (m) {
      if (!list) {
        throw new Error(`line ${n}: list item outside a list`);
      }
      item = { [m[1]]: parseScalar(m[2], n) };
      list.push(item);
      continue;
    }
    m = /^ {4}(\w[\w.-]*): (.+)$/.exec(visible);
    if (m) {
      if (!item) {
        throw new Error(`line ${n}: continuation key outside a list item`);
      }
      if (Object.prototype.hasOwnProperty.call(item, m[1])) {
        throw new Error(`line ${n}: duplicate key ${m[1]}`);
      }
      item[m[1]] = parseScalar(m[2], n);
      continue;
    }
    throw new Error(`line ${n}: unsupported syntax: ${visible.trim()}`);
  }
  return doc;
}

// --- glob matching -----------------------------------------------------------
// `**` matches anything including `/`; `*` matches anything except `/`.

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// Precedence metric: literal prefix length (characters before the first `*`).
function specificity(pattern) {
  const idx = pattern.indexOf('*');
  return idx === -1 ? pattern.length : idx;
}

// Compile a parsed classification document into matchers ready for resolve().
function compile(doc) {
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  const matchers = rules.map((r) => ({
    rule: r,
    re: globToRegExp(String(r.pattern || '')),
    spec: specificity(String(r.pattern || '')),
  }));
  return { rules, matchers };
}

// Resolve one path against compiled matchers. Returns { file, bucket, pattern }
// on a unique winner, or { file, error } on no match / an ambiguous tie —
// callers MUST treat `error` as fatal (fail closed), never as a default bucket.
function resolve(matchers, file) {
  const matches = matchers.filter((m) => m.re.test(file));
  if (matches.length === 0) {
    return { file, error: 'unclassified' };
  }
  const max = Math.max(...matches.map((m) => m.spec));
  const winners = matches.filter((m) => m.spec === max);
  if (winners.length > 1) {
    return {
      file,
      error: `ambiguous at equal specificity: ${winners.map((w) => w.rule.pattern).join(' vs ')}`,
    };
  }
  return { file, bucket: winners[0].rule.bucket, pattern: winners[0].rule.pattern };
}

module.exports = { BUCKETS, parseClassification, globToRegExp, specificity, compile, resolve };
