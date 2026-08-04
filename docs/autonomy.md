# Autonomy Guide

Verity autonomy lets a headless **worker** (`verity-worker`) advance your project
on its own: it picks up labeled work from GitHub, runs the same Verity roles you
would invoke by hand, and pauses at human gates. This guide covers everything an
operator needs — starting with how to stop it.

---

## Kill switch (read this first)

Two ways to halt the worker. Both take effect at its **next wake-up** (the worker
is stateless between ticks; there is no long-running process to kill in cron mode):

1. **Open the circuit breaker** — add the label `verity:circuit-open` to any open
   issue in the repo (create a fresh issue for it if you like):

   ```bash
   gh issue create --title "HALT autonomy" --label verity:circuit-open
   ```

   Every subsequent worker start fails fast with exit 30 `circuit-open` and does
   nothing else — no scanning, no locks, no comments. Close the issue (or remove
   the label) to resume.

2. **Turn autonomy off in policy** — from the repo:

   ```bash
   verity autonomy set mode manual
   ```

   `mode: manual` is the default and means "autonomy disabled": the worker exits 0
   immediately with the message `autonomy disabled`, and every other Verity command
   behaves exactly as it did before autonomy existed.

A mid-run worker that you `kill -9` is also safe: its GitHub lock expires
(`expires:` timestamp in the lock comment, 1.5× `max_wall_clock_min`), and the
next tick reclaims it cleanly. This is exercised by the integration test
(`scripts/integration-autonomy.cjs`).

---

## What autonomy is

Without autonomy, you drive Verity's roles by hand (`/verity:plan`,
`/verity:build`, `/verity:review`, …). With autonomy, `verity-worker --once`
performs **one tick**:

1. **Startup checks** (fail fast, read-only): policy valid, mode ≠ manual, daily
   usage limits not exceeded, `gh` authenticated, bot identity is not a listed
   human, circuit breaker closed.
2. **Scan** for the highest-priority eligible work item (approved resumes first,
   then PRs awaiting review, ready stages, new `verity:request` issues, then
   whatever the dependency engine says is next).
3. **Lock** the item (label `verity:in-progress` + a `lock:<run-id> expires:<ts>`
   comment — state lives in GitHub, the worker keeps none).
4. **Loop**: ask `verity next --json` what to do, run that role headlessly via
   `verity agent-exec` (the only place an AI agent is invoked), repeat — until
   idle, a human gate, a failure, or a per-run limit.
5. **Summarize**: one audit comment per run (roles, outcome, tokens, est. cost,
   wall time), one `.verity/usage.csv` row appended per role invocation (all
   sharing the run id), lock released — always, even on crash paths.

Every action the worker takes is bot-attributed, comment-audited, and priced.

## Modes

Set in `.verity/autonomy.yml` (`verity autonomy show` prints the effective
policy, defaults merged):

| Mode | Behavior |
| --- | --- |
| `manual` (default) | Autonomy off. Worker exits 0 immediately. Zero behavior change for existing users. |
| `supervised` | Worker advances work and chains roles (`auto_advance`), but every gate (`review:merge`, `ship:prod`, `golive`) pauses for a human. The recommended starting mode. |
| `autonomous` | Same machinery with higher trust settings doing more on its own. Only after a successful supervised canary. |

```bash
verity autonomy set mode supervised
verity autonomy validate          # schema-check the file, exit 0/20
```

## Trust ladder (who merges)

Merge authority lives in the **worker's deterministic code**, never in the review
agent — the review role's tool allowlist contains no merge-capable tool; it only
reports a verdict.

| `review.trust` | After a review verdict of "approve" |
| --- | --- |
| `0` (default) | Never merges. Gates at `review:merge`; a human merges the PR. Enable branch protection ("require 1 review") as the backstop. |
| `1` | Auto-merges only **low-risk** PRs: every changed file matches `low_risk.allowed_paths`, none matches `protected_paths` (a protected hit always vetoes), `additions+deletions ≤ max_changed_lines`, and checks are green when `require_ci_green`. Everything else gates. |
| `2` | Merges any approved PR with green checks. |

`protected_paths` always includes `.github/**` and `.verity/**` — the loader
forces them back in even if the file removes them. Raising trust requires
`verity autonomy set review.trust <n> --confirm` and records an ADR.

## Label vocabulary

`verity install` creates these eight labels (idempotently — colors/descriptions
are updated in place, labels are never deleted):

| Label | Meaning |
| --- | --- |
| `verity:request` | Human-approved inbound work; the worker may plan it |
| `verity:ready` | Stage/work item ready for build |
| `verity:in-progress` | Locked by a worker run |
| `verity:awaiting-approval` | Paused at a human gate |
| `verity:approved` | Human approved; worker resumes (single-use — consumed on resume) |
| `verity:needs-human` | 2 failures; worker skips the item until cleared |
| `verity:circuit-open` | Budget/safety breaker tripped; worker halts entirely |
| `verity:trust-demoted` | Auto-demotion audit marker (v2) |

The worker never touches an item carrying `verity:needs-human`, and never starts
at all while any open issue carries `verity:circuit-open`.

## Approval flow

When a run hits a human gate, the worker:

- labels the gate's target (the PR for `review:merge`) `verity:awaiting-approval`,
- posts a ⏸️ comment saying exactly what is pending and how to approve,
- @mentions everyone in `notify.mention`,
- posts the run summary and releases the lock.

To approve, **apply the label `verity:approved`**. The next tick picks approved
items up first (P1), removes both labels (the token is single-use), and
continues. At trust 0 a `review:merge` gate still ends with a human pressing the
merge button — the approval label resumes the worker, it does not grant merge
authority.

> The gate comment also offers `/verity approve`. In v1 **the label is the only
> approval token the worker honors** — under the Actions driver a comment
> *wakes* the worker promptly (the workflow triggers on `issue_comment`), but
> nothing yet translates the comment text into an approval. Use the label.

## Running it: cron recipe

The v1 driver is one cron line on any machine with `git`, `gh` (authenticated as
the bot), and the repo cloned:

```cron
*/30 * * * * cd /path/to/repo && GH_TOKEN=$(cat ~/.verity-bot-token) verity-worker --repo owner/name --once >> ~/verity-worker.log 2>&1
```

Notes:

- `--once` does one tick and exits; overlap protection comes from the GitHub
  lock protocol (an accidental second start exits 0 "locked" within one scan).
- Run it from the repo clone — the worker resolves GitHub state from the
  working directory.
- The headless agent (`verity agent-exec`) needs Anthropic auth in its environment —
  either `ANTHROPIC_API_KEY` (pay-per-token) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription).
  See [Agent auth: API key vs subscription](#agent-auth-api-key-vs-subscription).
- No machine handy? Use the GitHub Actions driver below instead.

## Running it: GitHub Actions

`verity install --actions` (run from the repo) scaffolds
`.github/workflows/verity-worker.yml` — a workflow that runs
`verity-worker --once` on a 30-minute schedule **and** whenever an issue/PR is
opened or labeled or a comment lands, so approvals are picked up within seconds
instead of waiting for the next cron tick.

Setup:

1. Scaffold and commit the workflow:

   ```bash
   verity install --actions --bot yourorg-verity-bot   # default login: verity-bot
   # add --auth subscription to run on a Claude plan instead of an API key
   git add .github/workflows/verity-worker.yml && git commit -m "chore: verity Actions driver"
   ```

   `--bot` templates the workflow's self-event guard
   (`if: github.actor != '<bot>'`) — it must be the **login of the bot account**
   that owns `VERITY_BOT_TOKEN`, or the bot's own labels/comments will
   re-trigger the workflow in a loop. The scaffold is idempotent (re-running it
   is a no-op); if the file has local edits it refuses to overwrite — re-run
   with `--force` to regenerate.

2. Create the bot machine account exactly as in
   [Bot-account setup](#bot-account-setup) below.

3. Add two **repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Purpose |
   | --- | --- |
   | `VERITY_BOT_TOKEN` | The bot account's token (repo write + `workflow` scope). Used for checkout and every `gh` call — keeps all worker actions bot-attributed. |
   | `ANTHROPIC_API_KEY` *(api-key auth)* | The headless agent's API key. This is the one that spends money. |
   | `CLAUDE_CODE_OAUTH_TOKEN` *(subscription auth)* | OAuth token from `claude setup-token`; runs the agent on a Claude plan instead. Add this **instead of** the API key when you scaffolded with `--auth subscription`. |

   Add **one** of the two agent secrets — whichever matches your `--auth` choice. Don't set
   both: an `ANTHROPIC_API_KEY` always wins over the OAuth token and forces pay-per-token.

4. Set the policy as usual (`mode: supervised`, `humans:`, limits) and make sure
   the labels exist (`verity install` creates them).

Budget guardrails are on by default: the job's `timeout-minutes: 50` hard-caps a
runaway run at the Actions level, and the worker's own startup checks refuse to
run once today's `.verity/usage.csv` totals exceed `limits.max_usd_per_day` /
`max_runs_per_day` (exit 30 `daily-limit`).

**Coexistence with cron — no double work.** The workflow's `concurrency` group
(`verity-<owner>/<repo>`, `cancel-in-progress: false`) serializes Actions runs:
when the schedule and an event fire together, GitHub queues the second run
instead of racing. Across drivers (an Actions run and a cron tick on another
machine), the worker's GitHub **lock protocol** is the fence — the second
instance exits 0 `locked` within one scan. Running both drivers is safe; it just
means more (cheap, idle) ticks.

The kill switch works identically: a `verity:circuit-open` label halts every
tick regardless of driver. To stop the Actions driver itself, disable the
workflow (`gh workflow disable verity-worker.yml`) or delete the file.

## Agent auth: API key vs subscription

The headless agent (`verity agent-exec`, which runs `claude -p`) needs Anthropic
credentials in its environment. There are two ways to provide them — pick one:

| | **API key** (default) | **Subscription** |
| --- | --- | --- |
| Env var | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Where it comes from | console.anthropic.com | `claude setup-token` (≈1-year token), on a box logged into your Claude Pro/Max plan |
| Billing | Pay-per-token, no ceiling | Draws from your plan's **monthly Agent SDK credit** ($20 Pro / $100 Max 5× / $200 Max 20×) |
| When the budget runs out | Keeps going (until `max_usd_per_day` halts the worker) | Worker **stops** until the next cycle — no silent fall-back to paid API |
| GitHub Actions | ✅ supported | ✅ supported (store the token as the `CLAUDE_CODE_OAUTH_TOKEN` secret) |
| `--auth` flag | `--auth api-key` (default) | `--auth subscription` |

**Use the API key** for unattended / high-volume / Actions runs where you don't
want the worker to pause when a credit runs out. **Use the subscription** to run
on the Claude plan you already pay for, accepting that the worker idles once the
monthly Agent SDK credit is spent.

> **Never set both.** If `ANTHROPIC_API_KEY` is present it takes precedence over
> `CLAUDE_CODE_OAUTH_TOKEN`, silently forcing pay-per-token billing even when you
> meant to use the subscription.

For a cron / manual worker, export the chosen var in the worker's environment
(a box already logged in via `claude login` can rely on its stored subscription
session, but an explicit `CLAUDE_CODE_OAUTH_TOKEN` survives session expiry and
won't break an unattended loop). For Actions, `verity install --actions
[--auth subscription]` wires the right secret into the generated workflow.

## Bot-account setup

Run the worker as a **dedicated machine user**, never as yourself:

1. Create a separate GitHub account (e.g. `yourorg-verity-bot`) and give it write
   access to the repo.
2. Mint a token for that account and export it as `GH_TOKEN` for the worker only.
3. List every human in `.verity/autonomy.yml` `humans:`. The worker refuses to
   start (exit 30 `bot-is-human`) if its token's login matches a listed human —
   this is what keeps bot actions attributable and stops the worker from
   treating a human's actions as its own (and vice versa: requests authored by
   the bot are never self-planned).
4. Add the bot to `notify.mention`? No — mention humans there; the bot is the
   one doing the mentioning.

## Usage & cost tracking

Every run appends one row **per role invocation** to `.verity/usage.csv`
(`timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role`),
all rows of a run sharing its `run_id`, and commits them (`commit_usage: true`
by default). Pre-existing ledgers keep working: the schema evolves
additively-only, so old 9-column rows (one per run, no `tool_calls`/`role`)
parse and roll up alongside new ones without migration. Inspect with:

```bash
verity usage --days 7            # runs, tokens, est USD, tool calls, outcomes histogram
verity usage --days 7 --json
verity usage --days 7 --by-role  # adds per-role totals (tokens, est USD, tool calls)
```

**Honest-measurement note:** this telemetry covers **headless runs only** —
role invocations that pass through `verity agent-exec` (i.e. the worker).
Interactive slash-command sessions (`/verity:build` etc. in a live Claude Code
session) never touch agent-exec, so their tokens and tool calls are not
measured here; measuring them is a host-side concern. Read exit-gate numbers
accordingly.

The worker reads the same ledger at startup: if today's totals already exceed
`limits.max_usd_per_day` or `limits.max_runs_per_day`, it refuses to start
(exit 30 `daily-limit`) until the UTC day rolls over.

## Limits

Per-run and per-day circuit breakers, all in `.verity/autonomy.yml` (defaults
shown):

```yaml
limits:
  max_chained_roles: 6        # roles chained within one tick
  max_tokens_per_run: 2000000
  max_wall_clock_min: 45      # also sets the lock TTL (×1.5)
  max_runs_per_day: 24
  max_usd_per_day: 25.00
```

A tripped per-run limit ends the tick with outcome `limit_hit` (exit 0, summary
posted); the remaining work simply waits for the next wake-up. Failures follow a
2-strike rule: the first failure retries next tick, the second labels the item
`verity:needs-human` and the worker skips it until a human clears the label.
