# The autonomy layer

**Verity = the hand-driven role framework + an optional headless autonomy layer.**

The autonomy layer (incubated in the `verity-auto` fork, merged back in v0.4.0) adds the ability for the Verity roles
to run **on their own** — a headless worker picks up labeled work from GitHub, runs the same
roles you'd invoke by hand, merges low-risk work under a deterministic trust ladder, and
pauses at every human gate — all bot-attributed, comment-audited, and priced. Everything the
original Verity does, it still does, unchanged.

If you've never used Verity, start with [QUICKSTART.md](../QUICKSTART.md). This page is for
people who know verity-framework and want the delta.

---

## The one-liner

| | Autonomy off (default) | **Autonomy on** |
|---|---|---|
| How roles run | You invoke each `/verity:*` role by hand | Same roles, **or** a headless `verity-worker` runs them for you |
| Merge | A human merges every PR | Human merges, **or** a deterministic trust ladder auto-merges low-risk PRs |
| State | Derived from GitHub | Same — plus a GitHub **label state machine** + audit comments + a usage ledger |
| Cost | The AI assistant's normal usage | Same — plus a per-run **ledger and daily budget caps** for autonomous runs |

## What's added

**New CLI surface**

- **`verity-worker --repo owner/name --once`** — the orchestrator: startup checks → scan for
  work → lock → run roles → gate/summarize. One tick per invocation, stateless between ticks.
- **`verity autonomy show | set | validate`** — read/edit/validate the effective policy.
- **`verity agent-exec <role>`** — the single place an AI assistant is invoked headlessly
  (Claude Code, with a per-role tool allowlist).
- **`verity usage [--days N] [--json]`** — rollups from the run ledger.
- **`verity install --actions`** — scaffolds a GitHub Actions workflow driver.
- **`verity install`** now also creates the eight `verity:*` labels (idempotently).

**New machinery (deterministic, in the worker — not the LLM)**

- A **label state machine** (`verity:request` → `in-progress` → `awaiting-approval` →
  `approved` → …) that holds all run state in GitHub, so the worker is stateless and
  crash-safe.
- A **scanner** with ranked work selection (approved resumes → PRs to review → ready stages →
  new requests → dependency-engine next).
- A **GitHub-native lock protocol** (label + expiring lock comment) so a second worker is safe.
- A **trust ladder** — trust 0 never merges, 1 auto-merges only low-risk PRs (path globs, line
  count, green checks), 2 merges any approved+green PR. **Merge authority is deterministic
  code; the review AI has no merge tool.**
- **Per-role tool allowlists** (`commands/verity/<role>.tools.json`) — deny-by-default.
- **Circuit breakers**: per-run limits (chained roles, tokens, wall clock), daily caps
  (USD, runs), a 2-strike `needs-human` rule, and a `verity:circuit-open` kill switch.

**New deployment options**

- **Cron**, **GitHub Actions**, **manual**, or both — see the [Autonomy guide](autonomy.md)
  and the [`/verity:autonomy-setup`](../commands/verity/autonomy-setup.md) deployment interview.

**New roles**

- **`/verity:deploy-setup`** — a guided interview that builds your global
  `~/.verity/deployment-methods.md` catalog (AWS / GCP / Azure / LAN / PaaS / SSH /
  Kubernetes…), so the Architect has real targets to choose from.
- **`/verity:autonomy-setup`** — a guided interview that generates your worker deployment
  (`.verity/autonomy.yml`, the cron line and/or Actions workflow, bot + secrets checklists,
  and a `DEPLOYMENT.md`), so turning autonomy on is answer-a-few-questions, not hand-edit-YAML.

  (the classic framework had 13 roles; the autonomy layer adds these two → 15.)

**New onboarding tooling**

- [`docs/dev/deploy-kit/`](dev/deploy-kit/) — the deployment interview.
- [`docs/dev/friction-kit/`](dev/friction-kit/) — instrument and document a first run.
- [`QUICKSTART.md`](../QUICKSTART.md) — a zero→running first-start guide.

## What's unchanged

- **All 13 `/verity:*` roles** and the whole CLI surface from verity-framework.
- The **deployment-methods catalog** (`verity deployment …`) — where your *app* ships.
- The **state-from-GitHub** model, the CI hygiene gate, the docs and guides.
- **`mode: manual` is byte-identical to upstream.** Autonomy ships off by default; with it
  off, every command behaves exactly as it did before. A snapshot regression test (T01)
  enforces this — existing users see zero behavior change.

## New files / contract surface

| Path | What |
|---|---|
| `.verity/autonomy.yml` | Policy: mode, trust, gates, limits, humans, notify (schema: `schemas/autonomy.schema.json`) |
| `.verity/usage.csv` | Append-only run ledger (one row per run; `verity usage` reads it) |
| `~/.verity/logs/<run-id>/<role>.jsonl` | Per-role headless transcripts |
| `commands/verity/<role>.tools.json` | Per-role tool allowlists |
| `.github/workflows/verity-worker.yml` | The Actions driver (from `verity install --actions`) |
| `DEPLOYMENT.md` | Optional deployment record written by the deploy interview |

## New runtime requirements (for autonomy only)

- **Anthropic auth for the headless agent** — either **`ANTHROPIC_API_KEY`** (pay-per-token)
  or **`CLAUDE_CODE_OAUTH_TOKEN`** from `claude setup-token` to run on a Claude Pro/Max plan's
  monthly Agent SDK credit. See [Agent auth](autonomy.md#agent-auth-api-key-vs-subscription).
- **A dedicated bot GitHub account** + token — the worker runs as a machine user, never as
  you; its login must not appear in the policy's `humans:` list.
- **Claude Code ≥ 2.1.170** — pinned in `package.json` (`verity.claudeCodeMinVersion`);
  `verity agent-exec` fails fast below it.

(Driving the roles by hand needs none of these — they're upstream-unchanged.)

## Maturity

- **v1 (T01–T15): shipped.** The worker, policy, agent-exec, allowlists, gh layer, scanner,
  locks, run loop, usage ledger, startup checks, trust ladder, integration test + docs, and
  the Actions driver are all merged and tested. Frozen specs:
  [`docs/dev/verity-autonomy-project-plan.md`](dev/verity-autonomy-project-plan.md) and
  [`docs/dev/verity-autonomy-technical-sketch.md`](dev/verity-autonomy-technical-sketch.md).
- **Phase 4 (T16–T19): not started, needs sign-off.** A read-only `/verity:triage` role
  (T16), a `--watch` daemon driver (T17), OpenCode driver parity in `agent-exec` (T18), and
  trust auto-demotion on rollback attribution (T19).

## Relationship & lineage

verity-framework is a clean-room successor to
[spec-driven-devops](https://www.npmjs.com/package/spec-driven-devops) 1.4. The autonomy
layer was incubated in a fork named `verity-auto` (versions 0.3.x) and merged back into
verity-framework in v0.4.0; the archived fork repo preserves that history.
