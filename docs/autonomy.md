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

## Review verdicts (how a review routes)

The review role reports a verdict; the worker's deterministic code routes it.

| Verdict | Routes to | Merges? |
| --- | --- | --- |
| `approve` | The trust ladder above (may merge, may gate) | Only per the ladder |
| `request_changes` | Gates at `review:merge`; hand back to `/verity:build` | Never |
| `escalate` | Gates at `review:merge`. With `review.escalate_routing: true` it also **parks the work item** (`verity:needs-human`) and names `/verity:plan` for a contract/ADR amendment | Never |
| unknown / absent | Gates at `review:merge` (fail-closed) | Never |

`review.escalate_routing` defaults **false** (dark-launched): while off, an
`escalate` verdict routes exactly like `request_changes` — a plain gate, no
`verity:needs-human`. An escalation fails safe (worst case: an unnecessary human
look), so it never merges at any trust level.

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
- Run it from the repo clone — the files, git history, and the Verity-performed
  stage lifecycle (ADR-0012) live there. GitHub state, though, targets the
  `--repo` repository for every `gh` call the tick makes — never a cwd-derived
  remote — so a clone with no usable remote refuses truthfully as
  `git-unprovidable` instead of dying inside the circuit-breaker check.
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
`max_runs_per_day` (exit 30 `daily-limit`) — or once today's costs cannot be
verified at all (exit 30 `unknown-cost-budget`, see [Limits](#limits)).

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

## Self-authored requests are skipped (single-account setups)

The scanner's P4 tier **never picks up a `verity:request` authored by the bot
login itself** — the no-self-feeding rule. It exists because a worker that can
file requests and then work them has closed the loop the tiers are built to
keep open: it would be feeding itself work, which is exactly the runaway the
priority ladder and human-authored intake are there to prevent. The rule is
load-bearing and has no bypass knob.

The practical consequence bites in a **single-account setup** (you run the
worker under your own login instead of a bot account): every request you file
is, as far as GitHub is concerned, authored by the bot — so every request is
filtered, and the tick ends idle. Since stage 28 the worker says so instead of
staying silent: the tick prints
`verity-worker: note: skipped N self-authored request(s) (no self-feeding; see docs)`
on stderr, and an idle tick reads
`idle — no eligible work — skipped N self-authored request(s) …` rather than a
bare "no eligible work". Diagnostics only — the skipped issues are never
commented on.

If you see that note, you have two supported paths:

- **Use a second account** — the [bot-account setup](#bot-account-setup) above.
  Requests you file from your human account are then eligible; the worker's
  own login stays filtered, as designed.
- **Hand-seed stages instead of requests** — `verity stage new "<title>"`
  (what the canary runs did). Stage files need no author at all: the P5
  dependency engine picks them up regardless of login.

## Usage & cost tracking

Every run appends one row **per role invocation** to `.verity/usage.csv`
(`timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate`),
all rows of a run sharing its `run_id`, and commits them (`commit_usage: true`
by default). `gate` is the human gate the *run* ended paused at, if any — the
same value on every row of the run; it is how the startup breaker can tell an
unknown-cost run that already asked a human (parked at the `unknown-cost`
gate) from unknown spend that slipped through ungated. Pre-existing ledgers
keep working: the schema evolves additively-only, so old 9-column rows (one
per run, no `tool_calls`/`role`) and 11-column rows (no `gate`) parse and roll
up alongside new ones without migration. Inspect with:

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
(exit 30 `daily-limit`) until the UTC day rolls over. `est_usd` is **verified**
spend — runs whose cost the runtime never reported are counted separately as
`unknown_cost_runs` and never summed as $0 (see [Limits](#limits)).

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
  unknown_cost_behavior: gate # gate | allow_with_token_limit | fail
  # unverified_ci_behavior: gate   # gate (default, omit it) | allow_without_merge
```

A tripped per-run limit ends the tick with outcome `limit_hit` (exit 0, summary
posted); the remaining work simply waits for the next wake-up. Failures follow a
2-strike rule: the first failure retries next tick, the second labels the item
`verity:needs-human` and the worker skips it until a human clears the label.

**No progress is its own limit.** `verity next` is re-derived from GitHub every
iteration, so a state that never changes yields the same decision forever. If
the worker is about to dispatch the **same role at the same target** for the
third time in a row — counted across ticks from its own run-summary comments on
the item, plus within the current tick — it refuses *before* spending the model
run, labels the item `verity:needs-human`, and exits 20 with a summary saying
`no progress: …`. Two identical dispatches are still allowed, so a role keeps
its retry. Clear the label once you have fixed whatever was not advancing.

**Unknown cost is not $0** (ADR-0008). Some runtimes — Codex in particular —
report token usage but no dollar figure, so their ledger rows carry an *empty*
`est_usd` cell. That cell is never summed as zero: `verity usage` reports the
verified spend plus a count of unverifiable runs, and the daily budget breaker
refuses to certify a total it knows is incomplete. `unknown_cost_behavior`
decides what that costs you when `max_usd_per_day` is set and today's ledger
holds unknown-cost runs:

| value | effect on the budget breaker |
|---|---|
| `gate` *(default)* | the worker refuses to start — exit 30 `unknown-cost-budget` — because the ceiling cannot be checked; **approvable** when every unverifiable run ended parked at the `unknown-cost` gate (see below) |
| `fail` | same refusal (the value governs in-run handling; an unverifiable budget is never waved through, and `fail` has no approval mechanism) |
| `allow_with_token_limit` | the worker starts and logs that the USD breaker is **inert by consent** — you have accepted the token ceilings as the bound |

**Approving the `unknown-cost` gate actually resumes the run.** Under `gate`,
a run whose cost comes back unknown pauses at the `unknown-cost` gate and its
comment tells you how to approve. That approval is exactly the per-run human
decision ADR-0008 prices the knob at, so the startup breaker does not outrank
it: when *every* unverifiable run in today's ledger ended parked at that gate,
the refusal is deferred past the scan, and a pending single-use
`verity:approved` lets **that one run** proceed — the consumption is named in
the run's summary (`budget:` line), and the next unverifiable run gates again.
No approval pending (or any unknown-cost spend that never gated) and the
worker refuses exactly as before, before taking any lock or writing any label.

Genuine overspend is still reported as overspend: if the *verified* portion of
today's spend already meets `max_usd_per_day`, that is a plain `daily-limit`
trip regardless of this knob — no approval masks it.

## Unverified CI

**"No CI" is not "CI red."** A pull request's check rollup has three readings,
not two:

| reading | what Verity saw | what it means |
|---|---|---|
| **green** | checks reported, all acceptable | verified green — the only state that may merge |
| **red** | checks reported, at least one failing or pending | verified not-green |
| **unknown** | **no checks reported at all** | Verity cannot verify this PR *in either direction* |

Before this was distinguished, `unknown` was reported as red. On a repository
with no CI configured, that meant a stage could never leave `building`, so every
tick answered it with `role: build` and spent a full model run getting nowhere —
`test` and `review` were unreachable (issue #50, observed on the 2026-07-31
canary).

**Unknown is never treated as green.** Reading an empty check set as green would
be strictly worse than the bug it replaced, because the worker would then merge
on CI that nobody ever ran. Every consumer of the reading decides explicitly:

| call site | what it does with `unknown` |
|---|---|
| `ledger.rollupState()` | *produces* the three states; the boolean `rollupGreen()` is `=== green`, so unknown collapses to not-green |
| `ledger.deriveStatus()` | folds unknown in with red — the stage vocabulary has no word for "unverifiable", and it must not read `in-review` |
| `next.decide()` | **gates** at `ci:unverified` (or, under the knob below, advances to `review`) — this is where a model run would be spent, so this is where the third state is spent |
| `trust.checksGreen()` / `trust.decideMerge()` | not green → never merges. Deliberately still a boolean: the *only* question a merge gate may ask is "did Verity verify this is green?" |
| `review.canMerge()` / `verity review merge` | refuses, with a diagnostic naming the missing CI instead of a phantom failing check |
| `verity-worker` | takes the ordinary GATE_PAUSE path — label, comment, `⏸️ gated` summary — so the pause is visible in the run's outcome and in `verity next` |

So on a repository with no CI the chain runs `plan → build`, opens the PR, and
then **stops for a human** at gate `ci:unverified`: Verity cannot claim the
stage is green, so it does not pretend either way. Approving the gate
(`verity:approved`, or `/verity approve`) consents for that one run — the stage
advances to `review`, and the merge itself is still gated, because merging
requires a *verified* green reading that an unchecked PR can never produce.

If your repository legitimately has no CI and you do not want that pause every
time, opt in explicitly:

```yaml
limits:
  unverified_ci_behavior: allow_without_merge
```

| value | effect |
|---|---|
| *absent* / `gate` *(default)* | pause at the `ci:unverified` human gate |
| `allow_without_merge` | let the stage advance to `review` instead of looping on `build` |

The knob is **default-closed** — absence, and any value other than the exact
opt-in, gates. Neither value can merge on unverified CI.

## Unreadable state

**"We could not look" is not "there is nothing there."** Verity derives every
stage's status by correlating local stage specs with GitHub issues and PRs. When
that read fails, there is no honest answer to give.

Before this was distinguished, the ledger swallowed the failure whole — `gh`'s
stderr was discarded outright — and every unread list became an empty one. So an
unreachable GitHub produced a *confident falsehood*:

```
$ verity state stage 1                                   # gh working
{ "status": "building", "issue": 1, "pr": 2 }

$ PATH=<gh that exits 1> verity state stage 1
{ "status": "planned", "issue": null, "pr": null }       exit 0, stderr empty
```

That is worse than a failure, because every consumer believes it. On the
2026-07-31 canary the `review` role was told "no PR or linked issue exists"
while PR #2 was open: it could not review, failed twice, and burned a
no-progress strike — the root cause of that run's chain stall (issue #60).

**The snapshot now records whether it was observed.** `fetchSnapshot()` stamps
`verified`, and lists a `{ source, reason, detail }` for every read that failed;
a read that failed is `null`, never `[]`. **A partial answer counts as
unverified** — issues without PRs derives a stage that has "no PR", which is the
same falsehood in half.

| call site | what it does with an unverified snapshot |
|---|---|
| `verity state` (`view`/`next`/`stage`/`summary`/`graph`) | **refuses** — exit 30, nothing on stdout, the reason on stderr. This is the boundary a human and a role read, and there is no partial answer here a caller cannot misread; emitting an object at all is the invitation |
| `next.decide()` / `verity next` | **gates** at `state:unverified` (exit 10), checked before every other reading. Deliberately not `idle`: idle asserts Verity looked and found no work |
| `verity-worker` run loop | stops as `infra` (exit 30) **before dispatching** — a wasted model run against a state nobody verified is strictly worse than a clear stop. Not the GATE_PAUSE path: labeling and commenting would write to the very API that just failed |
| `verity-worker` startup | when the scan selects nothing, refuses with slug `state-unverified` (exit 30) rather than reporting `idle` — on a cron worker, an idle exit 0 reads as "all quiet" |
| `scanner` P5 | yields no item (only an `action: work` decision does), so nothing is locked or labeled |
| `ledger.project()` | derives, unchanged — it is the pure derive layer and its shape is byte-frozen by `verity state view`. Callers that turn a projection into an *answer* gate on `ledger.snapshotVerified()` first |
| `ledger.deriveStatus()`, `release`, `review`, `trust` | untouched. `release` reads git tags only; the merge gates run their own `gh` calls and already fail closed on any error |

There is **no opt-out knob.** `limits.unverified_ci_behavior` is a judgement
about a repository that legitimately has no CI; it is not a licence to dispatch
against a state nobody observed, and it cannot turn one into work.

**The diagnostic survives, the credential does not.** The failure reason is
classified into terms you can act on — `auth`, `network`, `rate-limit`,
`no-repo`, `gh-not-installed`, `no-target-dir` (the `--cwd` you named does not
exist — indistinguishable from a missing `gh` at the syscall, and only one of
them means "reinstall gh"), `http-<code>` — and the first line of `gh`'s
stderr travels with it, redacted: GitHub token shapes (`ghp_`/`gho_`/`ghu_`/
`ghs_`/`ghr_`, `github_pat_`, classic 40-hex) and anything following an
`Authorization`/`Bearer`/`token` keyword are replaced before the text is ever
printed, logged, or posted to a comment.

An injected snapshot (tests, embedders) carries no `verified` field and reads as
verified — the same rule `ciStateOf()` applies to the legacy CI boolean, so an
old-shaped snapshot can never manufacture the new state and no existing consumer
changes behavior.

## Contained roles: Verity talks to GitHub

**A role computes; Verity talks to GitHub** (ADR-0013, extending ADR-0012's
"the model edits files; Verity performs git"). The tier-1 sandbox denies a
codex role all network access by construction — that is the point of
containment (ADR-0011), and it is never widened — so a contained role can
neither run `verity state`/`gh` to read GitHub nor `gh pr comment` to write it.
The canary §4 re-run proved both halves fatal: review's own comment died on the
network, and build's first act was a (correctly) fail-closed state read.

**Reads move before the dispatch.** For a codex dispatch the worker asks
`verity next` to attach the facts the role's workflow needs — stage status,
the unblocked `next` list, dependency statuses, the PR and its three-state CI
reading — derived from the *same verified snapshot* the dispatch decision came
from, so the fail-closed rules above stay binding: an unverified snapshot
gates, and a gate dispatches nobody. The facts travel to `agent-exec` as
`--state-snapshot` and render into the prompt as the `verityPerformsGitHub`
preamble ("GitHub is Verity's job on this run") plus a
`<github-state-snapshot>` block. Snapshots are point-in-time: the role acts on
state as of dispatch, and the worker's post-run deterministic checks (trust
ladder, CI verification) remain the guard against staleness.

**Writes move after the result.** The T05 marker's `artifacts` gains one
additive, **default-closed** channel: `"effects"`. Absent field = nothing
performed. Recognized today: `findings_comment` — the review findings body the
role would have posted with `gh pr comment`; the worker posts it on the PR,
attributed to the run (`🔎 verity-worker <run-id> — … posted by Verity on the
role's behalf`). An effect the worker does not recognize is **ignored with a
logged note — never executed, never guessed at, never fatal**. Merge authority
is not an effect and never will be: the trust ladder stays the only merge path.

Claude (uncontained) dispatches are unaffected — the flag is rejected for the
claude driver rather than silently ignored, its prompts render byte-identically,
and its harness keeps performing its own GitHub reads.
