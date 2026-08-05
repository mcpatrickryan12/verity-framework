// Release/Deploy Operator — release half (framework-spec.md §6, Role 7 / Shipyard).
// version DERIVED from the latest tag (so the binary can't lie about its version) +
// changelog auto-generated from Conventional Commits. Tags/commits are injectable
// (opts.tags / opts.commits) so the logic is unit-testable without git.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ledger = require('./ledger.cjs');
const promotionConfig = require('./promotion-config.cjs');
const { sanitize } = require('./changelog-sanitize.cjs');

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function gitTags(cwd) {
  return git(cwd, ['tag']).split('\n').filter(Boolean);
}

function commitsSince(cwd, tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  return git(cwd, ['log', range, '--pretty=%s']).split('\n').filter(Boolean);
}

function parseVersion(tag) {
  return tag
    .replace(/^v/, '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
}

function nextVersion(currentTag, bump) {
  const [maj, min, pat] = currentTag ? parseVersion(currentTag) : [0, 0, 0];
  if (bump === 'major') {
    return `${(maj || 0) + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${maj || 0}.${(min || 0) + 1}.0`;
  }
  return `${maj || 0}.${min || 0}.${(pat || 0) + 1}`;
}

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;

function changelogFrom(commits, version) {
  const groups = { feat: [], fix: [], chore: [], other: [] };
  for (const c of commits) {
    const m = c.match(CONVENTIONAL);
    if (m && groups[m[1]]) {
      groups[m[1]].push(m[4]);
    } else {
      groups.other.push(c);
    }
  }
  const lines = [`## ${version}`, ''];
  const section = (title, arr) => {
    if (arr.length > 0) {
      lines.push(`### ${title}`);
      for (const s of arr) {
        lines.push(`- ${s}`);
      }
      lines.push('');
    }
  };
  section('Features', groups.feat);
  section('Fixes', groups.fix);
  section('Chores', groups.chore);
  section('Other', groups.other);
  return lines.join('\n').trim();
}

// Prepend a changelog section, returning a rollback that restores the file to its
// exact prior state (content, or non-existence) — so a later failure can undo it.
function prependChangelog(cwd, section) {
  const p = path.join(cwd, 'CHANGELOG.md');
  const existedBefore = fs.existsSync(p);
  const before = existedBefore ? fs.readFileSync(p, 'utf8') : null;
  const header = '# Changelog';
  const existing = before ? before.replace(header, '').trim() : '';
  const body = `${header}\n\n${section}\n\n${existing}`.trim();
  fs.writeFileSync(p, `${body}\n`);
  return () => {
    if (existedBefore) {
      fs.writeFileSync(p, before);
    } else {
      fs.rmSync(p, { force: true });
    }
  };
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

// The one derivation both `cut` and `prepare` share (extracted in stage 42 so
// the two verbs can never disagree): version from the latest tag, changelog
// from the Conventional Commits since it. Pure computation, no side effects.
function derive(cwd, opts = {}) {
  const tags = opts.tags || gitTags(cwd);
  const previous = ledger.latestTag(tags);
  const version = nextVersion(previous, opts.bump || 'patch');
  const tag = `v${version}`;
  const commits = opts.commits || commitsSince(cwd, previous);
  const changelog = changelogFrom(commits, version);
  return { version, tag, previous, changelog, commitCount: commits.length };
}

// A release has three side effects (tag, changelog edit, push) that must be
// all-or-nothing: a half-done release leaves either a dirty CHANGELOG.md with no
// tag, or a local tag that never pushed. We order them cheap-and-reversible-first
// (tag → changelog → push) and roll back the earlier steps if a later one throws.
// The git runner is injectable (opts.run) so partial failure is unit-testable.
function cut(cwd, opts = {}) {
  const { version, tag, previous, changelog, commitCount } = derive(cwd, opts);
  const result = { version, tag, previous, changelog, commitCount };
  if (opts.dryRun) {
    return { ...result, applied: false };
  }

  // The authoritative-tag guard (stage 42, ADR-0022 §3): once the dev/prod
  // split is active, vX.Y.Z tags are born in prod via the promotion flow —
  // habit-driven `release cut` in dev must refuse BEFORE any side effect.
  // Reading the config throws on a malformed file (exit 20, never silently
  // off); an absent file leaves cut byte-identical to today. --dry-run
  // returned above: the computation is harmless and stays available.
  if (promotionConfig.read(cwd).split_active) {
    const err = new Error(
      `release cut refused: ${promotionConfig.PROMOTION_CONFIG_PATH} has split_active: true — authoritative ${tag} tags are minted in the production repo by the promotion flow, not in dev. Use \`verity release prepare\` to compute the version and sanitized changelog section here (\`release cut --dry-run\` also still computes without tagging).`,
    );
    err.exitCode = 20;
    throw err;
  }

  const exec = opts.run || run;
  exec('git', ['-C', cwd, 'tag', tag]); // step 1 — if this throws, nothing changed yet

  let restoreChangelog;
  try {
    restoreChangelog = prependChangelog(cwd, changelog); // step 2
  } catch (err) {
    exec('git', ['-C', cwd, 'tag', '-d', tag]); // roll back step 1
    throw err;
  }

  if (opts.push !== false) {
    try {
      exec('git', ['-C', cwd, 'push', 'origin', tag]); // step 3
    } catch (err) {
      restoreChangelog(); // roll back step 2
      exec('git', ['-C', cwd, 'tag', '-d', tag]); // roll back step 1
      throw new Error(
        `release push failed — rolled back tag ${tag} and CHANGELOG.md, working tree is clean. Original error: ${err.message}`,
      );
    }
  }
  return { ...result, applied: true };
}

// `release prepare` (stage 42, ADR-0022 §2) — the dev-side release computation
// after the split: the SAME derivation as `cut` (shared `derive`, so the two
// can never disagree) with the changelog section already sanitized (`#NN` →
// `dev#NN`). It NEVER tags, commits, or pushes in any mode. Default is
// report-only (nothing touched); `--apply` prepends the sanitized section to
// CHANGELOG.md as a working-tree edit only.
function prepare(cwd, opts = {}) {
  const d = derive(cwd, opts);
  const changelog = sanitize(d.changelog);
  const result = {
    version: d.version,
    tag_candidate: d.tag,
    previous: d.previous,
    changelog,
    commitCount: d.commitCount,
    applied: false,
  };
  if (!opts.apply) {
    return result;
  }
  prependChangelog(cwd, changelog);
  return { ...result, applied: true };
}

function current(cwd) {
  const latest = ledger.latestTag(gitTags(cwd));
  return { latest, version: latest ? latest.replace(/^v/, '') : null, raw: latest || '' };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'current') {
    return current(cwd);
  }
  if (verb === 'changelog') {
    return cut(cwd, { bump: flags.bump, dryRun: true });
  }
  if (verb === 'cut') {
    return cut(cwd, {
      bump: flags.bump,
      dryRun: Boolean(flags['dry-run']),
      push: !flags['no-push'],
    });
  }
  if (verb === 'prepare') {
    return prepare(cwd, { bump: flags.bump, apply: Boolean(flags.apply) });
  }
  throw new Error(`unknown release verb: ${verb || '(none)'} — use cut|prepare|changelog|current`);
}

module.exports = { nextVersion, changelogFrom, cut, prepare, current, dispatch };
