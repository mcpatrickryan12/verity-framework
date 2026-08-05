// Stage 42 (ADR-0022 §1): the changelog sanitizer — `#NN` prose refs become
// plain-text `dev#NN` so the projected CHANGELOG cannot autolink to prod's
// unrelated issue numbers. The discipline under test: rewrite only what is
// provably a prose ref; leave URLs, link targets, code, entities, and existing
// `dev#NN` untouched; report (never guess at) spans it cannot prove safe.
const fs = require('node:fs');
const path = require('node:path');
const {
  sanitize,
  findBare,
  findUnsanitized,
  scan,
} = require('../verity/bin/lib/changelog-sanitize.cjs');

// --- the two rewrite forms ---
test('sanitize rewrites parenthesized refs: (#41) -> (dev#41)', () => {
  assertEqual(sanitize('fixed the gate (#41).'), 'fixed the gate (dev#41).');
});

test('sanitize rewrites bare refs: #41 -> dev#41', () => {
  assertEqual(sanitize('see #41 for details'), 'see dev#41 for details');
  assertEqual(sanitize('#41 opens the line'), 'dev#41 opens the line');
});

test('sanitize handles multiple refs on one line, slash-separated', () => {
  assertEqual(sanitize('issues #40/#42/#43 — found'), 'issues dev#40/dev#42/dev#43 — found');
});

test('sanitize handles hyphen-prefixed refs (issue-#28 form)', () => {
  assertEqual(sanitize('the issue-#28 liveness rule'), 'the issue-dev#28 liveness rule');
});

// --- non-targets: provably safe, byte-for-byte untouched ---
test('existing dev#NN is never touched', () => {
  const text = 'already sanitized dev#41 and (dev#107) stay put';
  assertEqual(sanitize(text), text);
});

test('idempotence: sanitize(sanitize(x)) === sanitize(x)', () => {
  const x = 'mixed: #41, (#42), dev#43, https://ex.com/a#44, `#45`, and repo#46';
  assertEqual(sanitize(sanitize(x)), sanitize(x));
});

test('#NN inside an http(s) URL is untouched', () => {
  const a = 'see https://github.com/x/y/issues#41 and http://ex.com/page#42 frag';
  assertEqual(sanitize(a), a);
  assertEqual(
    scan(a)
      .map((t) => t.status)
      .join(','),
    'url,url',
  );
});

test('#NN inside a markdown link target is untouched (relative target)', () => {
  const a = 'see [the section](docs/guide.md#41) for more';
  assertEqual(sanitize(a), a);
  assertEqual(scan(a)[0].status, 'link-target');
});

test('HTML numeric entities (&#41;) are not refs and are untouched', () => {
  const a = 'a close paren is &#41; in HTML';
  assertEqual(sanitize(a), a);
});

test('#NN followed by a word character is not a ref (#123abc untouched)', () => {
  const a = 'anchor #123abc stays';
  assertEqual(sanitize(a), a);
});

// --- unprovable spans: left alone AND reported ---
test('inline code spans are left alone and reported by findUnsanitized', () => {
  const a = 'run `git show #41` to inspect';
  assertEqual(sanitize(a), a);
  const rep = findUnsanitized(a);
  assertEqual(rep.length, 1);
  assertEqual(rep[0].status, 'code-span');
  assertEqual(rep[0].token, '#41');
});

test('fenced code blocks are left alone and reported', () => {
  const a = 'before #1\n```\nlog line about #41\n```\nafter #2';
  assertEqual(sanitize(a), 'before dev#1\n```\nlog line about #41\n```\nafter dev#2');
  assertEqual(findUnsanitized(a).length, 1);
});

test('word-prefixed refs (repo#41 cross-repo shape) are left alone and reported', () => {
  const a = 'the verity-auto#41 collision';
  assertEqual(sanitize(a), a);
  const rep = findUnsanitized(a);
  assertEqual(rep.length, 1);
  assertEqual(rep[0].status, 'word-prefixed');
});

// --- the real CHANGELOG: the historical pass is complete and stays complete ---
test('the real CHANGELOG.md contains zero bare #NN tokens (historical pass complete)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assertEqual(findBare(text).length, 0, 'no autolink-hazard tokens remain');
  assertEqual(sanitize(text), text, 'sanitize is the identity on the sanitized file');
  assertEqual(findUnsanitized(text).length, 0, 'no unprovable spans were skipped silently');
});
