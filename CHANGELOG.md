# Changelog

All notable changes to **verity-framework** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions 0.3.x were developed in the `verity-auto` incubator fork (forked at
`0.2.2`, reunified in `0.4.0`). See [docs/whats-different.md](docs/whats-different.md)
for the autonomy layer those versions added.

## [Unreleased]

## [1.1.0] — 2026-07-29

### Added

- **Portable role policy, agent-aware doctor, worker provider selection**
  (stage 9, ADR-0005/0007/0008/0009 — the complete LOCAL-Codex autonomy
  surface; GitHub Actions for Codex stays deferred per ADR-0009 until its
  credential boundary ships):
  - `.verity/autonomy.yml` gains an additive `agent` block — `provider`
    (`claude|codex`, default `claude`: every pre-existing policy stays valid
    and Claude-backed; codex autonomy is an explicit policy edit), `model`,
    codex-only `sandbox`/`approval` overrides that may only NARROW a role's
    `.permissions.json` projection (widening refuses execution, exit 30 —
    `agents/policy.cjs applyOverrides`), `ignore_user_config`,
    `ignore_rules`. No unrestricted-access value is representable anywhere
    in the schema (ADR-0007).
  - `limits.unknown_cost_behavior: gate | allow_with_token_limit | fail`
    (default `gate`, ADR-0008): a role reporting unknown cost (`est_usd`
    null — never $0, and never counted against the daily budget breaker)
    pauses the run at the `unknown-cost` human gate by default, stops it
    under `fail`, or proceeds bounded by token ceilings alone.
  - The worker resolves ONE immutable effective agent config per run and
    passes it into every chained `agent-exec` dispatch: provider, model,
    sandbox/approval overrides, and the REMAINING wall-clock budget as a
    hard `--timeout-secs` subprocess deadline that shrinks monotonically
    across chained roles (also closing the latent hung-Claude gap). All
    existing guardrails are unchanged: manual-mode exit, kill switch, human
    gates, forced golive gate, trust ladder, protected paths,
    chained-role/runs-per-day/token limits, identity checks, deterministic
    merges.
  - `verity doctor --agent claude|codex` — runtime-selective preflight
    (a Codex-only machine can be green). Selection precedence without the
    flag: explicit `--agent` → `.verity/autonomy.yml` `agent.provider` →
    install-state `harness` → the legacy claude default, with the chosen
    runtime and its source printed on stderr. Codex checks: git, gh + auth,
    `codex --version` vs `verity.codexMinVersion`, `codex login status`,
    verity-* skill discovery under `~/.agents/skills`, the engine fallback
    path, and stale install state — every distinct failure diagnosis
    carries a remediation command.
  - ADR-0007 enforcement proof: the codex driver generates a per-invocation
    command-rules document from the role's `.permissions.json`
    (`codex.cjs commandRules` → `<role>.rules.json` in the run log dir,
    delivered as `-c rules_file=…`; the spelling is stub-pinned and
    canary-re-verified) — repo-root-only writable roots, always-denied
    credential reads and `gh pr merge` (merge authority is the worker's,
    never a role's), capability-derived deploy/git/gh denials, and
    protected-path (`.github/**`, `.verity/**`) write denials gated on the
    NEW additive capability key `write_protected_paths` (default false;
    granted to `autonomy-setup` only). The five negative tests
    (tests/enforcement.test.cjs) prove a restricted role cannot write
    outside the repo, read credentials, deploy, touch protected paths, or
    bypass a gate via `gh pr merge`/`verity release` — real-binary
    variants are the canary lane (docs/dev/codex-headless-canary.md).
  - `schemas/role-permissions.schema.json` — the published contract
    artifact for `<role>.permissions.json`, mirroring `agents/policy.cjs`
    exactly (contracts/role-capability-policy.md v1, additive only).
  - Optional additive knobs on `agent-exec`: `--model` (both drivers,
    omitted-in — Claude's argv is byte-identical without it) and
    `--sandbox`/`--approval` (capability-policy providers only; rejected
    with a clear error under `--agent claude`).
  - `autonomy-setup` role now offers the runtime choice (Claude Code /
    Codex CLI) and, for Codex, gathers only what Verity needs: local
    worker (Actions deferred, ADR-0009), model override, auth strategy
    (validated via `verity doctor --agent codex`, never a secret in a
    tracked file), trust level, and unknown-cost behavior.
  - Pipeline exit proof: a supervised trust-0 worker run under
    `agent.provider: codex` in a throwaway repo — plan → build → gated at
    review with no merge — runs in CI against the stub
    (tests/worker.test.cjs) and as the real-Codex supervised canary
    (docs/dev/codex-headless-canary.md §4).

- **Headless Codex executor path** (stage 8, ADR-0005/0007/0008):
  `verity agent-exec <role> [args] --run-id <id> --agent codex` executes a
  role non-interactively through the Codex CLI and emits the same normalized
  `contracts/agent-result.md` v1 object the worker already consumes (additive
  optional fields: `provider`, `timed_out`, `transcript_path`,
  `final_message_path`, `usage_detail`). New pieces:
  `verity/bin/lib/agents/codex.cjs` (driver: `VERITY_CODEX_BIN` →
  `VERITY_AGENT_BIN` → `codex`; version gate against the NEW package.json key
  `verity.codexMinVersion`; auth via `codex login status` — credential files
  are never read; invocation `codex exec --json --sandbox <from policy>
  --output-last-message <file> --cd <repo root> -` with the prompt over
  stdin, approval policy `never` and user-config isolation passed
  explicitly); `verity/bin/lib/agents/policy.cjs` + a
  `commands/verity/<role>.permissions.json` for all 15 roles
  (contracts/role-capability-policy.md v1 — fail closed: missing/invalid
  policy or `danger-full-access` refuses execution with exit 30, no fallback
  sandbox; `map` is `read-only`, everything else `workspace-write`;
  `.tools.json` untouched and still governs Claude);
  `schemas/agent-result.schema.json` (the structured role-outcome shape a
  Codex final message is validated against, hand-rolled zero-dep validator);
  provider-neutral `--timeout-secs N` on `agent-exec` (both drivers: kills
  the child on expiry, keeps the partial transcript, normalizes to a failure
  with `timed_out: true` — never a success). `--max-turns` with
  `--agent codex` is rejected with a usage error (ADR-0008 — never silently
  ignored); Codex `est_usd` is always `null` (unknown ≠ $0). Transcripts land
  at `~/.verity/logs/<run-id>/<role>.codex.jsonl` + `<role>.final.json`.
  **Dark-launched**: the default agent remains `claude`, codex runs only on
  an explicit `--agent codex`, and the worker cannot select it (autonomy
  schema unchanged — worker provider selection is stage 9). Claude headless
  behavior is byte-identical (stage 7 characterization suite green,
  generalized into a both-drivers provider-contract suite). Release canary:
  the documented manual check in `docs/dev/codex-headless-canary.md`
  (flag-spelling verification on the pinned Codex release + `npm pack`
  install + one real `agent-exec plan --agent codex` in a throwaway repo) —
  CI proves the path by stub only.
- **Interactive Codex support** (stage 6, ADR-0005/0006): `verity install
  --codex` renders all 15 canonical roles through the ADR-0002 pipeline into
  user-scoped Codex skills (`~/.agents/skills/verity-<role>/SKILL.md` +
  `agents/openai.yaml` with implicit invocation disabled) and copies the
  engine to `~/.agents/verity`. Roles are invoked explicitly:
  `$verity-vision`, `$verity-plan ISSUE-123`, … Harness flags
  (`--claude`/`--opencode`/`--codex`) are now mutually exclusive, and
  `verity install --codex --dry-run` prints the full install plan without
  writing. **Interactive only** — headless Codex execution
  (`agent-exec --agent codex`), worker selection, and GitHub Actions support
  are staged separately (ADR-0009) and are NOT part of this change. Release
  canary: after install, verify Codex lists the skills with `/skills`.

### Changed

- **Provider-driver seam** (stage 7, ADR-0005, chore — no intended behavior
  change): the entire Claude wire implementation moved out of
  `verity/bin/lib/agent-exec.cjs` into `verity/bin/lib/agents/` (`index.cjs`
  registry with `getProvider`/`listProviders`, `claude.cjs` driver,
  `result-contract.cjs` — the frozen `contracts/agent-result.md` v1 builder).
  `agent-exec` is now a runtime-neutral coordinator containing zero provider
  argv construction or event parsing, protected by a characterization suite
  written against the pre-refactor behavior (`tests/agents.test.cjs`). New:
  `VERITY_CLAUDE_BIN` provider-specific binary override — precedence is
  explicit flag (none yet) → `VERITY_CLAUDE_BIN` → legacy `VERITY_AGENT_BIN`
  (preserved) → `claude`. Cosmetic: the unsupported `--agent` error now names
  the registry's provider list.

## [1.0.1] — 2026-07-28

### Changed

- **Stage Executor lifetime is one stage** (ADR-0004). The role prompt now
  requires a **fresh executor per stage** — born at branch creation, dead at
  merge — and states that contracts are re-read from `contracts/`, never
  recalled. Resuming the executor *within* its own stage stays correct and
  unrestricted (red-CI loop, acceptance kick-back, a Reviewer's
  REQUEST-CHANGES); the boundary it must never cross is the next stage.

  The specs described the executor as "isolated" with its "own context window"
  but never said how long it lives — which a long-lived executor resumed stage
  after stage satisfies. Observed in a real run: one reused executor was
  starting each build with 300k+ tokens of accumulated transcript by stage 27.
  The cost is quadratic in stage count, but the load-bearing reason is
  correctness: a resumed executor recalls contracts as they stood N stages ago,
  and unversioned in-context memory of a contract defeats the frozen-contract
  discipline. Prompt-enforced, not code-enforced.

  Affects `commands/verity/build.md` (ships in the package) plus
  `docs/roles-spec.md` and `docs/framework-spec.md` (repo-only — `docs/` is not
  in `files`, so npm consumers get the rule and the reasoning stays on GitHub).

### Known issues (1.0.x fast-follows)

- Carried from 1.0.0: #3 worker usage-ledger commit lacks git author identity in
  Actions; #5 gated items re-post identical audit comments every scheduled tick.
- The ADR-0004 detection signature (`build`-role `tokens_in` climbing stage over
  stage in `verity usage --by-role`) exists but has never been read against real
  data — no project has populated `.verity/usage.csv`, which is why this went
  unnoticed for 27 stages.

## [1.0.0] — 2026-07-27

Verity's 1.0 certifies a **demonstrated** system, per the release gates set on
2026-07-25: remote CI green on the published 0.4.0 line, and one real
supervised autonomy cycle run from the published npm package on GitHub
Actions — build → PR → review → trust-0 gate → human approval → merge
(canary: seanerama/verity-skeleton-demo, 2026-07-26/27).

### Fixed

- **scanner: P5 honors `verity:needs-human`** (#4, canary finding). The
  dependency-engine fallback re-selected escalated items every wake-up; P5 now
  fetches issue/pr target labels (stage targets are exempt — a stage number is
  not an issue number), drops escalated items, and fails CLOSED with an
  unconditional warn when the fetch errors.

### Changed

- Generated `verity-worker.yml` installs `verity-framework@^1`.

### Known issues (1.0.x fast-follows)

- #3 worker usage-ledger commit lacks git author identity in Actions.
- #5 gated items re-post identical audit comments every scheduled tick.


## [0.4.0] — 2026-07-25

### Changed

- **Reunified with verity-framework.** The `verity-auto` fork (0.3.x) merged back into
  the canonical repo and npm package `verity-framework`; the incubator repo is archived.
  The package keeps both binaries (`verity`, `verity-worker`); autonomy remains opt-in
  and off by default.
- The generated `verity-worker.yml` Actions workflow now installs the worker from npm
  (`npm i -g verity-framework@^0.4`) instead of the bot-token GitHub URL; the bot token
  no longer needs read access to a second repo.

### Added

- `verity doctor` — host-dependency preflight (git, gh + auth, claude + min version,
  optional deps) with `--quiet` exit-code mode (stage 1).
- Per-role usage telemetry: `usage.csv` gains `tool_calls`/`role` columns, one row per
  role invocation, `verity usage --by-role`; additive, legacy rows still parse (stage 3).
- Install-time role-prompt transform pipeline (ADR-0002): shared preambles rendered at
  install, `verity install --dry-run <role>`, idempotent installs (stage 2).
- knowing Phase 0 spike report (`docs/dev/knowing-spike-report.md`): **NO-GO** at
  Gate 0; ADRs 0001–0003 record the outcome (stage 4).

## [0.3.2] — 2026-06-13

### Added

- **Subscription auth for the headless worker.** `verity install --actions --auth subscription`
  scaffolds the workflow to authenticate the agent with `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) instead of `ANTHROPIC_API_KEY`, so the worker runs on a Claude
  Pro/Max plan's monthly Agent SDK credit rather than pay-per-token. `--auth api-key`
  remains the default. The `/verity:autonomy-setup` interview now asks which to use, and
  `docs/autonomy.md` documents the trade-off (the worker stops when the monthly credit is
  exhausted; never set both secrets — an API key overrides the subscription token).

## [0.3.1] — 2026-06-13

### Added

- **`/verity:deploy-setup`** role — a guided interview that asks where you deploy apps
  (AWS / GCP / Azure / self-hosted / managed PaaS / SSH / Kubernetes) and builds your
  global `~/.verity/deployment-methods.md` catalog (locations, never secrets). Complements
  the Architect, which chooses a target from the catalog per app.
- **`/verity:autonomy-setup`** role — the worker-deployment interview, promoted from a
  copy-paste kit to a first-class command installed by `verity install`. Asks how the
  headless worker should run (cron / Actions / manual, mode, bot identity, trust, budget)
  and generates `.verity/autonomy.yml`, the cron line and/or Actions workflow, bot + secrets
  checklists, and a `DEPLOYMENT.md`. (Previously documented as `/verity-autonomy-setup`, a
  command that was never actually registered.) Brings the role count to 15.

### Fixed

- **Actions driver installed the wrong package.** `verity install --actions` generated a
  workflow that ran `npm i -g verity-framework` — the upstream package, which has no
  `verity-worker`. It now installs verity-auto from GitHub using the bot token
  (`git+https://x-access-token:${VERITY_BOT_TOKEN}@github.com/seanerama/verity-auto.git`);
  the bot account must have read access to the verity-auto repo. (Deviates from the frozen
  SKETCH §6, which predates the fork.)
- **Flaky retry-backoff bound.** `gh` layer backoff used `Math.round`, which could round a
  near-1.0 jitter draw up to the excluded upper bound (e.g. 1500 for retry 2). Now `Math.floor`,
  keeping the result in the documented half-open `[base/2, base·1.5)` interval.

- Docs swept to install verity-auto from source (command reference + HTML guides).

## [0.3.0] — 2026-06-13

The **autonomy release**: the Verity roles can now run headlessly, driven by a worker, and
merge low-risk work under a deterministic trust ladder — all bot-attributed, comment-audited,
and priced. Autonomy ships **off by default** (`mode: manual`), and with it off, behavior is
byte-identical to verity-framework (guarded by a snapshot regression test).

### Added

- **`verity-worker`** — the headless orchestrator (`--repo owner/name --once`): startup
  checks → ranked work scan → GitHub-native lock → run loop (`verity next` → `agent-exec`) →
  human gate or summarize. Stateless and crash-safe between ticks.
- **`verity autonomy show | set | validate`** — policy in `.verity/autonomy.yml`
  (schema `schemas/autonomy.schema.json`); effective policy is defaults merged with the file;
  raising `review.trust` requires `--confirm` and records an ADR.
- **`verity agent-exec <role>`** — the single headless entry point to the AI assistant
  (Claude Code, `--allowed-tools` per role); pins Claude Code ≥ 2.1.170 (fails fast below it).
- **`verity usage [--days N] [--json]`** — rollups from the append-only run ledger
  `.verity/usage.csv`.
- **`verity install --actions`** — scaffolds the GitHub Actions worker driver
  (`.github/workflows/verity-worker.yml`); idempotent, `actionlint`-clean.
- **`verity install`** now also creates the eight `verity:*` GitHub labels (idempotently).
- **Trust ladder** — deterministic merge authority in the worker (trust 0 never merges,
  1 auto-merges only low-risk PRs by path/size/checks, 2 merges any approved + green PR). The
  review role has no merge-capable tool.
- **Per-role tool allowlists** (`commands/verity/<role>.tools.json`) — deny-by-default.
- **Scanner**, **lock protocol**, and a **shared `gh` layer** (retry/backoff, uniform logging).
- **Circuit breakers** — per-run limits (chained roles, tokens, wall clock), daily caps
  (USD, runs), a 2-strike `needs-human` rule, and the `verity:circuit-open` kill switch.
- **Onboarding tooling** — [`QUICKSTART.md`](QUICKSTART.md), the
  [`/verity:autonomy-setup`](docs/dev/deploy-kit/) deployment interview, and the
  [friction kit](docs/dev/friction-kit/) for documenting a first run.
- **Docs** — [Autonomy guide](docs/autonomy.md), [what's different](docs/whats-different.md),
  canary checklist, and the frozen specs under `docs/dev/`.

### Changed

- **Repo identity** — renamed the package to `verity-auto`; `homepage`/`repository`/`bugs`
  now point at `seanerama/verity-auto`; README retitled with a fork banner. The upstream
  public npm package `verity-framework` remains the hand-driven subset.

### Unchanged

- All 13 `/verity:*` roles, the CLI surface, and the deployment-methods catalog carry over
  from verity-framework. `mode: manual` is byte-identical to upstream.

## [0.2.2] — fork point

Baseline inherited from [verity-framework](https://github.com/seanerama/verity-framework)
0.2.2 (restructured README + privacy cleanup). History before the fork lives in that repo.

[1.0.1]: https://github.com/seanerama/verity-framework/releases/tag/v1.0.1
[1.0.0]: https://github.com/seanerama/verity-framework/releases/tag/v1.0.0
[0.4.0]: https://github.com/seanerama/verity-framework/releases/tag/v0.4.0
[0.3.2]: https://github.com/seanerama/verity-auto/releases/tag/v0.3.2
[0.3.1]: https://github.com/seanerama/verity-auto/releases/tag/v0.3.1
[0.3.0]: https://github.com/seanerama/verity-auto/releases/tag/v0.3.0
[0.2.2]: https://github.com/seanerama/verity-framework/releases/tag/v0.2.2
