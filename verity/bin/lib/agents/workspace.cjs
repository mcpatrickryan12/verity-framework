// Disposable shaped workspace + gated merge-back (stage 14, ADR-0011 TIER 2) —
// the containment level required before ANY unattended codex autonomy.
//
// Tier 1 (stage 11) makes credentials absent and catches violations after the
// fact. Tier 2 moves enforcement from WRITE time — where `codex exec` gives us
// no hook at all (docs/dev/codex-enforcement-spike-0.146.0.md F1) — to
// PROPAGATION time, which Verity fully owns:
//
//   1. the role runs against a throwaway workspace in which the paths it may
//      not touch are PHYSICALLY ABSENT ("cannot modify .github/**" becomes a
//      topological fact, not a permission check);
//   2. deterministic Verity code — never the model — decides which changed
//      paths propagate back into the real repository. A path outside the
//      role's declared writable set is a LOUD run failure naming the path,
//      never a silent drop, and NOTHING propagates on rejection.
//
// Provider-NEUTRAL by construction, exactly like agents/invariants.cjs: this
// module knows about a repository, a loaded role capability policy, and the
// protected roots the caller hands it. Any driver can opt in by exporting the
// two coordinator hooks (agent-exec.cjs drives them); only codex does today.
//
// MECHANISM DECISION (the spec asks for this to be recorded here). We use
// `git worktree add --detach --no-checkout` + `git sparse-checkout set
// --no-cone` with the protected roots negated, rather than a full worktree
// with the roots deleted afterwards. Why:
//   - a worktree shares the object database, so materializing one is cheap
//     even for a large repository, and it is `git worktree remove --force`
//     away from being gone — no bespoke copy/restore bookkeeping to get wrong;
//   - `--detach` means the role's own commits land on a detached HEAD that is
//     DISCARDED with the workspace: no branch, tag, or remote of the real
//     repository can move because the role committed;
//   - sparse-checkout leaves `git status` CLEAN in the workspace. Deleting the
//     roots instead would show every protected file as a pending deletion,
//     which both confuses the role and buries the model's real changes in
//     noise the gate would then have to special-case.
// Sparse exclusion is NOT trusted as the change oracle, though. A sparse
// entry carries the SKIP_WORKTREE bit, and how git reports a file that
// reappears at a skipped path has varied across releases — so `git status` is
// the oracle for everything else, and the withheld roots additionally get an
// explicit filesystem scan (scanWithheld below). Every path in the workspace
// is therefore covered by one of the two: no version-dependent silence.
//
// KNOWN, DELIBERATE LIMITATION (documented rather than papered over): the
// workspace is derived from HEAD, and merge-back propagates FILE CHANGES only.
// A commit the role makes inside the workspace does not propagate — the
// detached HEAD is discarded — and uncommitted work in the real checkout is
// not visible to the role. That is why tier 2 is OPT-IN and default OFF, and
// why unattended tier-2 autonomy still needs its own real-binary canary pass
// (docs/dev/codex-headless-canary.md §5) before anyone relies on it.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { AgentExecError } = require('./result-contract.cjs');

// Why a rejected path was rejected. These strings travel into the result
// object and the run's error line, so they are part of what an operator reads.
const REJECTION_REASONS = ['out-of-root', 'read-only-role', 'protected-path', 'new-dotfile'];

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: res.stdout || '', stderr: res.stderr || String(res.error || '') };
  }
  return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function unavailable(detail) {
  return new AgentExecError(
    `fail-closed: cannot materialize a tier-2 shaped workspace: ${detail} — refusing the run rather than executing against the real checkout (ADR-0011 tier 2)`,
    'workspace-unavailable',
  );
}

// '.github/' and '.github' are one root; the leading segment is what every
// gate rule below compares against.
function rootName(p) {
  return String(p)
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+$/, '');
}

function firstSegment(rel) {
  return String(rel).split('/')[0];
}

// A candidate path must resolve INSIDE the workspace root. `git status` never
// emits anything else, but the gate must not depend on that: an absolute path,
// a `..` escape, or a symlinked detour is rejected on its own merits.
function inside(root, rel) {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  return back !== '' && !back.startsWith('..') && !path.isAbsolute(back);
}

// --- 1. materialize the shaped workspace ----------------------------------------

// Create the disposable workspace for one role run. Throws AgentExecError
// (exit 30, slug workspace-unavailable) when the guarantee cannot be provided
// — no repository, no HEAD, a worktree git refuses to create. Fail closed:
// tier 2 never silently degrades to running against the real checkout.
//
// `dir` is chosen by the caller and MUST live outside /tmp (spike F5: /tmp is
// writable from inside the Codex sandbox, so a workspace sited there is not a
// boundary at all, and Codex additionally refuses to create helper binaries
// under a temporary dir). agent-exec sites it beside the run's transcripts,
// under the Verity state root.
function prepare({ cwd, dir, policy, protectedPaths = [], keep = false }) {
  if (!git(cwd, ['rev-parse', '--git-dir']).ok) {
    throw unavailable(`${cwd} is not a git repository`);
  }
  if (!git(cwd, ['rev-parse', '--verify', 'HEAD']).ok) {
    throw unavailable(`${cwd} has no commits (unborn HEAD) — nothing to derive a workspace from`);
  }
  const caps = policy.capabilities || {};
  const allowProtected = caps.write_protected_paths === true;
  // The roots WITHHELD from the workspace: the protected roots, unless the
  // role's policy grants writes to them. Shaping is derived from policy — it
  // is never a hardcoded list of what "feels" dangerous.
  const withheld = allowProtected ? [] : protectedPaths.map(rootName);

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true }); // a stale dir would fail the add
  const add = git(cwd, ['worktree', 'add', '--detach', '--no-checkout', dir, 'HEAD']);
  if (!add.ok) {
    throw unavailable(`git worktree add failed: ${add.stderr.trim().split('\n')[0]}`);
  }
  const ws = {
    path: dir,
    root: cwd,
    withheld,
    protectedRoots: withheld,
    allowProtected,
    // The role's declared writable set, provider-neutrally: a role without
    // write_repository may propagate NOTHING (contracts/role-capability-policy
    // v1 — absence never grants anything).
    writable: caps.write_repository === true,
    keep,
    retained: false,
  };
  try {
    if (withheld.length > 0) {
      // --no-cone takes gitignore-style patterns, so the shape is "everything,
      // except these roots" — expressible in one call and readable in the
      // worktree's own sparse-checkout file if a human goes looking.
      const patterns = ['/*', ...withheld.map((r) => `!/${r}/`)];
      const sparse = git(dir, ['sparse-checkout', 'set', '--no-cone', ...patterns]);
      if (!sparse.ok) {
        throw unavailable(`git sparse-checkout failed: ${sparse.stderr.trim().split('\n')[0]}`);
      }
    }
    const checkout = git(dir, ['checkout', '--']);
    if (!checkout.ok) {
      throw unavailable(`git checkout failed: ${checkout.stderr.trim().split('\n')[0]}`);
    }
  } catch (err) {
    cleanup(ws, { force: true }); // never leave a half-shaped workspace behind
    throw err;
  }
  return ws;
}

// --- 2. the changed-path set ----------------------------------------------------

// `git status --porcelain=v1 -z` paths, rename/copy origins included. The
// workspace starts CLEAN (a fresh checkout of HEAD), so everything here was
// done by the run — no pre-existing dirt to subtract.
function statusPaths(ws) {
  const res = git(ws.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = new Set();
  if (!res.ok) {
    return paths;
  }
  const fields = res.stdout.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1; // the ORIGIN path follows in its own NUL field — it changed too
      if (fields[i] !== undefined && fields[i] !== '') {
        paths.add(fields[i]);
      }
    }
  }
  return paths;
}

// Explicit filesystem scan of the withheld roots. Their index entries carry
// SKIP_WORKTREE, so `git status` is not a guarantee there (module header) —
// and these are precisely the paths a misbehaving role is most likely to
// target. Anything found is a change by definition: the root was ABSENT when
// the workspace was handed over.
function scanWithheld(ws) {
  const found = new Set();
  const walk = (root, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(ws.path, root, rel), { withFileTypes: true });
    } catch {
      return; // absent, as shaped — nothing to report
    }
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(root, child);
      } else {
        found.add(`${root}/${child}`);
      }
    }
  };
  for (const root of ws.withheld) {
    walk(root, '');
  }
  return found;
}

// What kind of change a path underwent, decided from the workspace itself
// rather than from a porcelain status code: present + known to HEAD is a
// modification, present + unknown is a creation, absent is a deletion. This is
// the shape merge-back needs (copy vs delete) and it is code-spelling-agnostic.
function changeFor(ws, rel) {
  if (!fs.existsSync(path.join(ws.path, rel))) {
    return 'deleted';
  }
  return git(ws.path, ['cat-file', '-e', `HEAD:${rel}`]).ok ? 'modified' : 'added';
}

// The full changed-path set of the workspace, sorted for determinism.
function changes(ws) {
  const all = new Set([...statusPaths(ws), ...scanWithheld(ws)]);
  return [...all].sort().map((rel) => ({ path: rel, change: changeFor(ws, rel) }));
}

// --- 3. the gate (the teeth) ----------------------------------------------------

// Accept ONLY what the role's declared writable set covers. Every other path
// is rejected with the reason named — deterministic Verity code decides, and
// the model's opinion never enters.
function gate(ws, changed) {
  const accepted = [];
  const rejected = [];
  for (const c of changed) {
    let reason = null;
    if (!inside(ws.path, c.path)) {
      reason = 'out-of-root';
    } else if (!ws.writable) {
      // A read-only role's writable set is EMPTY: it may propagate nothing at
      // all, whatever it managed to write inside its disposable copy.
      reason = 'read-only-role';
    } else if (ws.protectedRoots.includes(firstSegment(c.path))) {
      reason = 'protected-path';
    } else if (!ws.allowProtected && c.change === 'added' && firstSegment(c.path).startsWith('.')) {
      // A NEW top-level dotfile is config-shaped by convention (.env,
      // .npmrc, a new CI directory) and is not part of any role's ordinary
      // work — so it needs the same capability the named protected roots do.
      // Modifying one that is already tracked stays ordinary work.
      reason = 'new-dotfile';
    }
    if (reason === null) {
      accepted.push(c);
    } else {
      rejected.push({ ...c, reason });
    }
  }
  return { accepted, rejected };
}

// --- 4. apply what was accepted -------------------------------------------------

// Deterministic propagation: byte-for-byte file copies and deletions into the
// real checkout, applied in sorted order. Deliberately NOT a commit — a commit
// moves a ref, which is exactly what the `git_write` capability governs and
// what the worker's merge authority owns (T13). The result is an ordinary
// reviewable diff in the real repository, plus the merged path list in the run
// result so the change is attributable to the role that made it.
function apply(ws, accepted) {
  const merged = [];
  for (const c of accepted) {
    const from = path.join(ws.path, c.path);
    const to = path.join(ws.root, c.path);
    if (c.change === 'deleted') {
      fs.rmSync(to, { force: true });
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    merged.push(c.path);
  }
  return merged;
}

function describe(r) {
  return `${r.path} (${r.reason})`;
}

// The whole propagation step in one call: compute → gate → apply, or reject
// everything and hand the coordinator a loud single-line error. Returns
// { merged, rejected, changed, error } with error null when nothing was
// rejected (the common case, and the only quiet one).
function merge(ws, policy) {
  const changed = changes(ws);
  const { accepted, rejected } = gate(ws, changed);
  if (rejected.length > 0) {
    // ALL-OR-NOTHING on rejection. Propagating the acceptable half of a run
    // that also tried to touch `.github/**` would reward the attempt with
    // partial success; the run failed containment, so nothing crosses.
    return {
      merged: [],
      rejected,
      changed,
      error: `containment gate REJECTED ${rejected.length} path(s) outside the role's writable set (ADR-0011 tier 2): ${rejected
        .map(describe)
        .join('; ')} — NOTHING was propagated to ${ws.root}`,
    };
  }
  return { merged: apply(ws, accepted), rejected, changed, error: null };
}

// --- 5. disposal ----------------------------------------------------------------

// Remove the workspace. Called on EVERY exit path — success, failure, timeout
// — so a disposable workspace is never left lying around holding a checkout of
// the repository. `keep` (the explicit debug flag) retains it and says so.
// Never throws: a failed teardown is reported, not a second failure.
function cleanup(ws, opts = {}) {
  if (ws === null || ws === undefined) {
    return { removed: false, retained: false };
  }
  if (ws.keep === true && opts.force !== true) {
    ws.retained = true;
    return { removed: false, retained: true, path: ws.path };
  }
  git(ws.root, ['worktree', 'remove', '--force', ws.path]);
  try {
    fs.rmSync(ws.path, { recursive: true, force: true }); // belt: a partial add
  } catch {
    // best effort — the prune below still detaches it from the repository
  }
  git(ws.root, ['worktree', 'prune']);
  return { removed: !fs.existsSync(ws.path), retained: false, path: ws.path };
}

module.exports = {
  REJECTION_REASONS,
  apply,
  changes,
  cleanup,
  describe,
  gate,
  inside,
  merge,
  prepare,
};
