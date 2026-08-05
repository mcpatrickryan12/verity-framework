// Post-run workspace invariants (stage 11, ADR-0011 layer 5) — MANDATORY, not a
// backstop. `codex exec` ignores per-path permission profiles
// (docs/dev/codex-enforcement-spike-0.146.0.md F1), so this checker is the only
// mechanism that can catch a protected-path mutation or a ref movement in the
// headless path today.
//
// Provider-NEUTRAL by construction: it knows nothing about Codex, only about a
// workspace, a loaded role capability policy, and the protected roots the
// caller hands it. The coordinator (agent-exec.cjs) drives it through the
// driver hooks a provider opts into — Claude, whose write-time restriction IS
// enforced by its own harness allowlist, opts out and its behavior is
// unchanged.
//
// Shape of the guarantee (ADR-0011's invariant, in the order it is checked):
//   1. protected roots (.github/**, .verity/**) unmodified unless the role
//      holds write_protected_paths — snapshotted from the FILESYSTEM, so it
//      holds for gitignored paths (.verity/usage.csv) too;
//   2. no branch/tag/HEAD movement without git_write;
//   3. nothing modified at all when the role's writable set is empty (a
//      read-only role); for a workspace-write role the workspace root IS the
//      writable set, and writes outside it are the one thing the coarse Codex
//      sandbox is PROVEN to block (F6).
// Honest scope of check 3: it reads `git status`, so in a workspace that is not
// a git worktree it does not run (`checkedGit: false`) — which is why
// write_repository maps to the `codex-sandbox` mechanism, not to this checker
// (agents/policy.cjs). A read-only role is stopped at WRITE time by
// `--sandbox read-only`; check 3 is a cross-check on top of that, never the
// thing the capability's claim rests on. Check 1 is a pure filesystem snapshot
// and always runs; check 2 asks git for the ref list, and a workspace with no
// repository has no refs that could move. Those two are the claims this module
// owns (write_protected_paths, git_write).
// On violation the caller fails the run loudly; this module first reverts what
// it can revert SAFELY: a file the run created is deleted, a file the run
// modified is restored from the pre-run bytes. Anything else (a ref rewind, a
// path that was already dirty before the run) is reported as NOT reverted —
// a half-done automatic repair would be worse than a named, loud failure.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Pre-run bytes are retained so a modification can be reverted exactly. The cap
// keeps a pathological protected tree from ballooning memory: past it a file is
// fingerprinted by size+mtime only, still DETECTED, just not revertible.
const MAX_RETAINED_BYTES = 2 * 1024 * 1024;

function digest(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

// Recursive file walk of one protected root. Missing root → {} (its absence is
// itself the pre-run state: a file appearing there is a creation).
function walk(root, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out; // absent or unreadable — nothing to record
  }
  for (const entry of entries) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    const full = path.join(root, child);
    if (entry.isDirectory()) {
      walk(root, child, out);
      continue;
    }
    if (!entry.isFile()) {
      continue; // sockets/fifos/symlinks: fingerprint nothing, claim nothing
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_RETAINED_BYTES) {
      out.set(child, { fingerprint: `size:${stat.size}:mtime:${stat.mtimeMs}`, bytes: null });
      continue;
    }
    try {
      const bytes = fs.readFileSync(full);
      out.set(child, { fingerprint: digest(bytes), bytes });
    } catch {
      // unreadable mid-walk — record its existence so a later delete is seen
      out.set(child, { fingerprint: 'unreadable', bytes: null });
    }
  }
  return out;
}

// Snapshot every protected root, keyed by repo-relative path.
function snapshotProtected(cwd, protectedPaths) {
  const files = new Map();
  for (const p of protectedPaths) {
    const rel = p.replace(/[/\\]+$/, ''); // '.github/' and '.github' are one root
    const sub = walk(path.join(cwd, rel), '', new Map());
    for (const [child, rec] of sub) {
      files.set(`${rel}/${child}`, rec);
    }
  }
  return files;
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return null;
  }
  return res.stdout;
}

// Every ref the workspace has, plus HEAD's commit — the git binary is the
// oracle (it handles packed refs and linked worktrees, which reading .git/refs
// by hand does not). No git / no repository → null: there are no refs to move,
// and the caller is told the sub-check did not run rather than told it passed.
function snapshotRefs(cwd) {
  if (git(cwd, ['rev-parse', '--git-dir']) === null) {
    return null;
  }
  const refs = new Map();
  const shown = git(cwd, ['show-ref']);
  for (const line of String(shown || '').split('\n')) {
    const m = /^([0-9a-f]+)\s+(\S+)$/.exec(line.trim());
    if (m !== null) {
      refs.set(m[2], m[1]);
    }
  }
  // A fresh repository has no commits: HEAD resolves to nothing, which is a
  // legitimate pre-run state and must compare equal to itself.
  const head = git(cwd, ['rev-parse', 'HEAD']);
  refs.set('HEAD', head === null ? '(unborn)' : head.trim());
  const symbolic = git(cwd, ['symbolic-ref', '-q', 'HEAD']);
  refs.set('HEAD(symbolic)', symbolic === null ? '(detached)' : symbolic.trim());
  return refs;
}

// `git status --porcelain` as a path → status map, or null when the workspace
// is not a git worktree (then the read-only sub-check cannot run and says so).
function snapshotStatus(cwd) {
  const raw = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (raw === null) {
    return null;
  }
  const status = new Map();
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    let file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1; // rename/copy: the ORIGIN path follows in its own NUL field
      file = `${fields[i]} -> ${file}`;
    }
    status.set(file, code);
  }
  return status;
}

// The pre-run capture. Cheap by design: the protected roots are small, the ref
// list is one git call, and `git status` is one more.
function capture(cwd, { protectedPaths }) {
  return {
    cwd,
    protectedPaths,
    protected: snapshotProtected(cwd, protectedPaths),
    refs: snapshotRefs(cwd),
    status: snapshotStatus(cwd),
  };
}

// The role's declared writable set (ADR-0011): under workspace-write the
// workspace ROOT is the writable set — writes outside it are what the coarse
// Codex sandbox is proven to block — and a read-only role may write nothing.
function writableSet(policy, cwd) {
  return policy.codex && policy.codex.sandbox === 'workspace-write' ? [cwd] : [];
}

function protectedViolations(before, after) {
  const violations = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const p of [...paths].sort()) {
    const was = before.get(p);
    const now = after.get(p);
    if (was === undefined) {
      violations.push({
        kind: 'protected-path',
        capability: 'write_protected_paths',
        path: p,
        change: 'created',
      });
    } else if (now === undefined) {
      violations.push({
        kind: 'protected-path',
        capability: 'write_protected_paths',
        path: p,
        change: 'deleted',
      });
    } else if (was.fingerprint !== now.fingerprint) {
      violations.push({
        kind: 'protected-path',
        capability: 'write_protected_paths',
        path: p,
        change: 'modified',
      });
    }
  }
  return violations;
}

function refViolations(before, after) {
  if (before === null || after === null) {
    return []; // no repository → no refs → nothing could have moved
  }
  const violations = [];
  const refs = new Set([...before.keys(), ...after.keys()]);
  for (const ref of [...refs].sort()) {
    const was = before.get(ref);
    const now = after.get(ref);
    if (was !== now) {
      violations.push({
        kind: 'ref-movement',
        capability: 'git_write',
        ref,
        change: was === undefined ? 'created' : now === undefined ? 'deleted' : 'moved',
      });
    }
  }
  return violations;
}

function statusViolations(before, after) {
  if (before === null || after === null) {
    return []; // not a git worktree — reported by `checkedGit: false`, never as a pass
  }
  const violations = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const p of [...paths].sort()) {
    if (before.get(p) !== after.get(p)) {
      violations.push({
        kind: 'outside-writable-set',
        capability: 'write_repository',
        path: p,
        change: after.has(p) ? after.get(p).trim() : 'restored',
      });
    }
  }
  return violations;
}

// Compare a pre-run capture against the live workspace. Returns the violation
// list ONLY — reverting and failing the run are the caller's, deliberately
// separate, steps.
function check(before, policy) {
  const caps = policy.capabilities || {};
  const after = capture(before.cwd, { protectedPaths: before.protectedPaths });
  const violations = [];
  if (caps.write_protected_paths !== true) {
    violations.push(...protectedViolations(before.protected, after.protected));
  }
  if (caps.git_write !== true) {
    violations.push(...refViolations(before.refs, after.refs));
  }
  if (writableSet(policy, before.cwd).length === 0) {
    violations.push(...statusViolations(before.status, after.status));
  }
  return {
    violations,
    after,
    checkedGit: before.status !== null && after.status !== null,
  };
}

// Hard revert, but only where "safe" is provable from the pre-run capture:
//   created by the run  → delete it;
//   modified by the run → write the pre-run bytes back;
//   deleted by the run  → write the pre-run bytes back;
// anything else (a ref movement, an oversized file we hold no bytes for, a
// path already dirty before the run) is returned in `unsafe` for the caller to
// report. Never throws — a failed repair is data, not a second failure.
function revert(before, violations) {
  const reverted = [];
  const unsafe = [];
  for (const v of violations) {
    if (v.kind !== 'protected-path') {
      unsafe.push(v);
      continue;
    }
    const full = path.join(before.cwd, v.path);
    const was = before.protected.get(v.path);
    try {
      if (was === undefined) {
        fs.rmSync(full, { force: true });
        reverted.push(v.path);
      } else if (was.bytes !== null) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, was.bytes);
        reverted.push(v.path);
      } else {
        unsafe.push(v);
      }
    } catch {
      unsafe.push(v);
    }
  }
  return { reverted, unsafe };
}

function describe(v) {
  if (v.kind === 'ref-movement') {
    return `${v.ref} ${v.change} without the git_write capability`;
  }
  if (v.kind === 'protected-path') {
    return `${v.path} ${v.change} without the write_protected_paths capability`;
  }
  return `${v.path} ${v.change} outside the role's writable set`;
}

// The whole post-run step in one call: check → revert what is safe → build the
// loud, single-line message the coordinator puts in the result `error`.
// Returns { violations, reverted, unsafe, checkedGit, error } with error null
// on a clean run (the overwhelmingly common case, and the only silent one).
function enforce(before, policy) {
  const { violations, checkedGit } = check(before, policy);
  if (violations.length === 0) {
    return { violations, reverted: [], unsafe: [], checkedGit, error: null };
  }
  const { reverted, unsafe } = revert(before, violations);
  const detail = violations.map(describe).join('; ');
  const repair =
    reverted.length > 0
      ? ` — reverted ${reverted.join(', ')}`
      : ' — nothing could be safely reverted';
  const manual =
    unsafe.length > 0 ? `; NOT reverted (manual review): ${unsafe.map(describe).join('; ')}` : '';
  return {
    violations,
    reverted,
    unsafe,
    checkedGit,
    error: `post-run enforcement violation (ADR-0011): ${detail}${repair}${manual}`,
  };
}

module.exports = {
  MAX_RETAINED_BYTES,
  capture,
  check,
  describe,
  enforce,
  revert,
  writableSet,
};
