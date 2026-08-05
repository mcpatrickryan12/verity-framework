// Changelog reference sanitizer (stage 42, ADR-0022 §1). After the dev/prod
// split, GitHub autolinks a bare `#41` in the projected CHANGELOG to *prod's*
// issue 41 — a different object than dev's #41. Sanitization is a DEV-SIDE
// operation: `#NN` becomes plain-text `dev#NN` (GitHub does not autolink that
// form) so the projection stays a pure byte-for-byte copy.
//
// Discipline (the spec's "when in doubt, leave bytes alone and report"):
//   - rewrite ONLY tokens provably in prose: `(#41)` and bare `#41` forms;
//   - NEVER touch existing `dev#NN` (idempotence), `#NN` inside an http(s) URL
//     or a markdown link target, HTML numeric entities (`&#41;`), or tokens
//     inside code fences / inline code spans;
//   - a token the sanitizer cannot prove safe (word-prefixed like `repo#41`,
//     or inside code) is LEFT AS-IS and surfaced by `findUnsanitized`.
//
// Pure text-in/text-out — no fs, no git — so `release prepare` (this stage) and
// Phase 2's `propose`/`finalize` reuse it unchanged.

const TOKEN = /#\d+/g;
const WORD = /[A-Za-z0-9_]/;

// Character ranges (as [start, end) offsets into `text`) that are code: fenced
// blocks (``` / ~~~ lines toggle, fence lines included) plus inline
// single-backtick spans on non-fence lines.
function codeRanges(text) {
  const ranges = [];
  let inFence = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      ranges.push([offset, offset + line.length]);
      inFence = !inFence;
    } else if (inFence) {
      ranges.push([offset, offset + line.length]);
    } else {
      const inline = /`[^`\n]*`/g;
      let m = inline.exec(line);
      while (m !== null) {
        ranges.push([offset + m.index, offset + m.index + m[0].length]);
        m = inline.exec(line);
      }
    }
    offset += line.length + 1; // the split-away '\n'
  }
  return ranges;
}

function inRanges(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

// Is the `#` at `index` inside an http(s) URL? True when the contiguous
// non-whitespace run containing it starts the scheme before the `#`.
function insideUrl(text, index) {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }
  return /https?:\/\//.test(text.slice(start, index));
}

// Is the `#` at `index` inside a markdown link target — `](…#41…)` with no
// whitespace or closing paren between the `](` and the token? Covers relative
// targets (`[a](docs/x.md#41)`) that the URL rule cannot see.
function insideLinkTarget(text, index) {
  for (let i = index - 1; i >= 1; i -= 1) {
    const c = text[i];
    if (/\s/.test(c) || c === ')') {
      return false;
    }
    if (c === '(' && text[i - 1] === ']') {
      return true;
    }
  }
  return false;
}

// Classify every `#NN` token. Statuses:
//   bare              — provably a prose issue ref: sanitize() rewrites it
//   already-sanitized — `dev#NN`: never touched (idempotence)
//   url / link-target — explicit link, cannot mislink: provably safe, untouched
//   html-entity       — `&#41;` numeric character reference: not a ref, untouched
//   word-suffixed     — `#123abc`-shaped (anchor/hex): not a ref shape, untouched
//   word-prefixed     — `repo#41`-shaped: cannot prove safe, untouched + reported
//   code-span         — inside a fence or inline code: untouched + reported
function scan(text) {
  const code = codeRanges(text);
  const tokens = [];
  TOKEN.lastIndex = 0;
  let m = TOKEN.exec(text);
  while (m !== null) {
    const index = m.index;
    const prev = index > 0 ? text[index - 1] : '';
    const next = text[index + m[0].length] || '';
    let status;
    if (insideUrl(text, index)) {
      status = 'url';
    } else if (insideLinkTarget(text, index)) {
      status = 'link-target';
    } else if (WORD.test(prev)) {
      status =
        text.slice(Math.max(0, index - 3), index) === 'dev' &&
        (index < 4 || !WORD.test(text[index - 4]))
          ? 'already-sanitized'
          : 'word-prefixed';
    } else if (prev === '&') {
      status = 'html-entity';
    } else if (WORD.test(next)) {
      status = 'word-suffixed'; // digits run into letters: an anchor/hex, not a `#NN` ref
    } else if (inRanges(code, index)) {
      status = 'code-span';
    } else {
      status = 'bare';
    }
    tokens.push({ index, token: m[0], status });
    m = TOKEN.exec(text);
  }
  return tokens;
}

// Rewrite every provably-bare `#NN` to `dev#NN`; every other byte is untouched.
// Idempotent by construction: a rewritten token is `dev`-prefixed on the next pass.
function sanitize(text) {
  const bare = scan(text).filter((t) => t.status === 'bare');
  let out = '';
  let cursor = 0;
  for (const t of bare) {
    out += `${text.slice(cursor, t.index)}dev${t.token}`;
    cursor = t.index + t.token.length;
  }
  return out + text.slice(cursor);
}

// Tokens sanitize() WOULD rewrite (autolink hazards still present in `text`).
function findBare(text) {
  return scan(text).filter((t) => t.status === 'bare');
}

// Tokens sanitize() left alone WITHOUT being able to prove them safe — the
// report half of "when in doubt, leave bytes alone and report the span".
function findUnsanitized(text) {
  return scan(text).filter((t) => t.status === 'word-prefixed' || t.status === 'code-span');
}

module.exports = { sanitize, findBare, findUnsanitized, scan };
