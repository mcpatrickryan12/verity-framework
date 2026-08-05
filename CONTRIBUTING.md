# Contributing to Verity

Thanks for your interest in improving Verity. This guide covers how changes
reach the project, the local setup, how to run the checks, and the conventions
that keep the codebase consistent.

## How changes reach Verity

The public repository ([seanerama/verity-framework](https://github.com/seanerama/verity-framework))
is Verity's **production home** — the front door of the project and the place
releases are tagged and published from.

- **Issues are the way in — and they're welcome.** Bug reports, feature
  requests, doc fixes, sharp questions: open an issue on the production repo.
  Issues flow directly into development triage, and a well-written one
  regularly becomes the next release's work. If you have a concrete change in
  mind, describing it (or sketching it) in an issue is the fastest way to get
  it shipped.
- **Code does not land via pull requests to the production repo.** Source
  changes travel through a separate development repository and arrive in the
  production repo as **promoted releases**: each release is a single commit
  produced by a deterministic, fail-closed projection of the development tree,
  then tagged and published. `RELEASE-MANIFEST.json` at the repo root carries
  each release's provenance (version, per-file digests, package shasum).
- Changelog references of the form `dev#NN` point at issues/PRs in the
  development repository; issue numbers in the production repo are unrelated
  to them.

Everything below serves anyone running the public tree locally — to reproduce
a bug before filing it, to verify a fix landed, or just to poke at the engine.

## Prerequisites

- **Node.js ≥ 16.7**
- **git** and the **GitHub CLI** (`gh`) — Verity is GitHub-native, and several
  roles shell out to `gh` at runtime.

```bash
node -v && git --version && gh --version
```

## Setup

```bash
git clone https://github.com/seanerama/verity-framework.git
cd verity-framework
npm install        # the only dependency is Biome (lint/format)
```

To try your local checkout as the global CLI:

```bash
npm link           # makes `verity` point at this checkout
verity help        # lists every CLI command
```

## Running the checks

Two checks gate every change — both must pass (they also run automatically on
`npm publish` via `prepublishOnly`):

```bash
npm test           # runs the test suite
npm run lint       # Biome formatter + linter (CI mode)
```

### Tests

The runner (`scripts/run-tests.cjs`) is deliberately zero-dependency: it discovers
every `tests/*.test.cjs`, injects three globals — `test`, `assert`, `assertEqual` —
runs them, and exits non-zero on any failure. It **refuses a vacuous pass**: if no
test files exist, it fails.

A test is just a file in `tests/` (useful for reproducing a bug locally —
include the failing test in your issue and it will likely ship with the fix):

```js
// tests/my-thing.test.cjs
const mything = require('../verity/bin/lib/mything.cjs');

test('does the thing', () => {
  assertEqual(mything.dispatch(['arg'], {}).raw, 'expected');
  assert(somethingTruthy, 'optional message');
});
```

No `require` of the runner, no imports of a framework — just call `test(...)`.

### Lint & format

Biome enforces 2-space indentation, single quotes, and a 100-character line width.
`docs/**`, all `*.md` files, and `verity/templates/**` are intentionally ignored
(see `biome.json`). To auto-fix locally:

```bash
npx biome check --write .
```

## Project layout

```
verity/
  bin/verity.cjs        CLI dispatcher — routes `verity <noun>` to a lib module
  bin/lib/*.cjs         one module per command (config, stage, ledger, release, …)
  templates/*.tmpl      files the scaffolder writes into a new project
  design-guides/*.md    built-in architecture guides the Architect role offers
commands/verity/*.md    the 15 role slash commands (the public surface)
docs/                   public docs and specs
tests/*.test.cjs        the suite
scripts/run-tests.cjs   the runner
```

## Conventions

- **The CLI is the deterministic layer.** `verity/bin/verity.cjs` emits JSON by
  default, supports `--raw` for plain scalar values, and is **read-only with
  respect to integration state** — it derives truth from GitHub rather than
  writing stale local files. Keep new commands in that spirit.
- **One module, one `dispatch`.** Each `verity/bin/lib/*.cjs` exports a
  `dispatch(rest, flags)` and is wired into the `COMMANDS` map in `verity.cjs`.
- **Role commands mirror the engine.** A slash command in `commands/verity/`
  orchestrates the human-facing role; the heavy, deterministic acts live behind
  `verity` CLI calls. See [`docs/commands.md`](docs/commands.md) for the full map.
- **No new runtime dependencies.** The package ships with zero runtime deps;
  please keep it that way unless there's a strong reason to discuss.

## Design background

For the reasoning behind the architecture, see
[`docs/framework-spec.md`](docs/framework-spec.md) (build-ready spec) and
[`docs/roles-spec.md`](docs/roles-spec.md) (full role rationale).

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
