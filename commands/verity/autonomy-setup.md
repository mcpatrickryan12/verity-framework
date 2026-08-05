---
name: verity:autonomy-setup
description: Autonomy Deployment — interview the operator about how they want to run the Verity autonomy worker, then generate the tailored deployment (.verity/autonomy.yml, the cron line and/or Actions workflow, bot + secrets checklists, and a DEPLOYMENT.md recording the choices).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - AskUserQuestion
---

# /verity:autonomy-setup — Autonomy Deployment interview

You are conducting a **guided deployment interview** for the Verity autonomy worker,
in the operator's live session, from the root of the repo they want to automate. Your
job: ask the decisions that matter, branch on the answers, and at the end **generate a
ready-to-run deployment** plus a record of what was chosen. Do not lecture; ask, then build.

> Scope note: this configures how the **autonomy worker runs** (cron / Actions / manual).
> It is *not* the same as `/verity:deploy-setup` / `verity deployment` (the catalog of
> where the user's *app* ships). Keep them distinct if the user conflates them.

## 0. Preflight (run these yourself; don't ask — report findings)

```bash
node -v ; gh auth status ; verity --version 2>/dev/null || echo "verity: not found"
git remote -v ; git rev-parse --is-inside-work-tree 2>/dev/null
```

Confirm: Node ≥16, `gh` authenticated, `verity` on PATH, this is a git repo with a GitHub
`origin`. If anything is missing, surface it and stop — don't interview into a broken base.
Note the `owner/name` from the remote; you'll need it for the cron line and workflow.

## 1. Interview (use the question UI; branch as noted)

Ask these as a small number of clear questions. Skip a branch entirely when an earlier
answer makes it moot.

1. **Driver — where does the worker run?**
   - *Cron on a server* — one machine with the repo cloned, `gh` as the bot, a crontab line.
   - *GitHub Actions* — GitHub hosts it; runs on a schedule + on issue/PR/comment events.
   - *Manual only* — you run `verity-worker --once` by hand; no scheduler.
   - *Cron + Actions* — both; the lock protocol + concurrency group prevent double-work.
   → Actions/both ⇒ you'll need the **bot login** (Q3) for the workflow's self-event guard.
   → Cron/both ⇒ ask the **repo path on the server** and **where the bot token lives**
     (e.g. `~/.verity-bot-token`), and the **cron interval** (Q7).
   → Actions is **Claude-only today**: Codex-backed Actions autonomy is deferred until its
     credential boundary ships (ADR-0009) — if they want Codex (Q5), the worker runs
     locally (cron or manual). Say so plainly; don't improvise a Codex workflow.

2. **Posture — `mode`:**
   - *manual* — set everything up but leave autonomy OFF (worker exits 0). Safe first install.
   - *supervised* (recommended start) — worker advances work and chains roles, but every
     gate (`review:merge`, `ship:prod`, `golive`) waits for a human.
   - *autonomous* — only after a successful supervised canary. If chosen now, warn and
     suggest starting supervised; proceed only if they insist.

3. **Bot identity & login:**
   - *Separate machine user + PAT* (recommended) — dedicated GitHub account, repo write +
     `workflow` scope.
   - *GitHub App* — if they already have one.
   - *Run as myself* — warn firmly: the worker refuses to start if its login is in
     `humans:`, and self-attribution breaks the audit trail. Steer to a machine user.
   Then collect the **bot login** (default `verity-bot`) and the **human logins** who
   operate the repo (must include the operator, must exclude the bot).

4. **Trust — `review.trust` (who merges):**
   - *0* (recommended start) — worker never merges; gates every PR for a human.
   - *1* — auto-merges only low-risk PRs (allowed paths only, no protected-path hits,
     ≤ `max_changed_lines`, checks green); everything else gates.
   - *2* — merges any approved PR with green checks.
   Note that raising trust above 0 requires `--confirm` and writes an ADR.

5. **Runtime — which agent executes headless roles (`agent.provider`)?**
   - *Claude Code* (default) — the existing path; nothing extra to configure.
   - *OpenAI Codex CLI* — the worker drives `codex exec` under the role's portable
     capability policy: the coarse Codex sandbox, a child environment built from a
     passlist (credentials only where a capability grants them), and mandatory
     post-run invariants that revert and fail loudly (tier 1 containment, ADR-0011).
     Gather only what Verity needs:
     - **local worker only** — remind them Actions is deferred for Codex (ADR-0009); the
       driver from Q1 must be cron or manual.
     - **model override** (`agent.model`) — optional; null uses Codex's default.
     - **auth strategy** — `codex login` (ChatGPT subscription) on the worker machine, or
       an OpenAI API key in the worker's environment per Codex's own docs. Verity never
       reads or stores the credential; validation is `verity doctor --agent codex`.
     - **trust level** — same ladder as Q4; recommend starting supervised + trust 0 and
       point at the supervised Codex canary (docs/dev/codex-headless-canary.md).
     - **acknowledged enforcement gaps** (`agent.acknowledged_enforcement_gaps`) —
       ADR-0011's honesty rule: a restriction no mechanism enforces refuses the run
       (exit 30 `unenforceable-policy`). Today that is `network: false`, which
       `codex exec` cannot enforce, so a Codex worker needs
       `acknowledged_enforcement_gaps: [network]` or every dispatch is refused. Say
       plainly what it means — network access is NOT blocked, only unclaimed — and
       leave it absent for anyone unwilling to accept that.
     - **containment tier** (`agent.containment_tier`) — absent (the default) means
       tier 1: violations are caught and reverted AFTER they happen, which is adequate
       for supervised/trust-0. `2` additionally runs every role in a disposable shaped
       workspace (protected paths physically absent) with a gated merge-back deciding
       what may propagate back — the only tier under which UNATTENDED Codex autonomy
       (`mode: autonomous`) is permitted; below it the worker refuses at startup with
       `containment-tier-required`. Offer tier 2 ONLY to someone who has run the
       real-binary tier-2 canary (docs/dev/codex-headless-canary.md §5), and tell them
       its cost: the workspace is derived from HEAD, so a role's own commits and any
       uncommitted local work do not cross the boundary.
     - **unknown-cost behavior** (`limits.unknown_cost_behavior`) — Codex reports no exact
       per-run dollar cost, and unknown is never $0 (ADR-0008). Default `gate` pauses each
       run for a human until cost accounting is proven; `allow_with_token_limit` runs under
       token ceilings alone; `fail` stops the run. Recommend keeping `gate` for the canary.

6. **Agent auth — how the headless agent pays for tokens** (Claude runtime; for Codex the
   auth strategy was settled in Q5):
   - *API key* (default; recommended for unattended/Actions) — `ANTHROPIC_API_KEY` from
     console.anthropic.com. Pay-per-token, no usage ceiling. Required for GitHub Actions
     (there's no interactive login there). `limits.max_usd_per_day` is the spend guardrail.
   - *Subscription* — run `claude -p` against a Claude Pro/Max plan via an OAuth token from
     `claude setup-token`. Usage draws from the plan's **monthly Agent SDK credit**
     ($20 Pro / $100 Max 5× / $200 Max 20×); when that's exhausted the worker **stops** until
     the next cycle (no silent fall-back to paid API). Choose this to keep the worker on the
     subscription the operator already pays for. **Never set `ANTHROPIC_API_KEY` alongside it**
     — an API key takes precedence and silently forces pay-per-token billing.

7. **Guardrails:**
   - `limits.max_usd_per_day` — offer $10 / $25 (default) / $50 / custom. (On subscription
     auth this is a secondary fence; the Agent SDK credit is the real ceiling. On Codex,
     unknown cost never counts against it — that's what `unknown_cost_behavior` is for.)
   - `notify.mention` — GitHub logins to @-mention on gate/fail/circuit (free text; optional).

8. **Cadence** (cron/both only): cron interval — `*/30 * * * *` (default) / hourly / custom.

## 2. Generate the deployment (confirm before any outward action)

Do these in order. Anything that mutates GitHub or pushes commits → **confirm first** and
show exactly what you'll run.

1. **Labels:** `verity install` (idempotent — creates the 8 `verity:*` labels). Safe to
   re-run; do it unless they already have them.

2. **Policy file** — write `.verity/autonomy.yml` for the non-trust fields (mode, limits,
   humans, notify.mention, commit_usage, and — Codex only — the `agent` block and
   `limits.unknown_cost_behavior`), then **raise trust through the CLI so the ADR is
   recorded**:
   ```bash
   verity autonomy set mode <mode>
   verity autonomy set agent.provider codex          # Codex runtime only (default: claude)
   verity autonomy set agent.model <model>           # only if they chose an override
   verity autonomy set review.trust <n> --confirm   # only if n > 0
   verity autonomy validate                          # must exit 0
   verity autonomy show                              # show the effective policy back to them
   ```
   For Codex, also run the runtime preflight and show them the result:
   ```bash
   verity doctor --agent codex                       # binary, auth, skills, engine, state
   ```
   Don't hand-write `protected_paths`/`gates` — the loader forces `.github/**`, `.verity/**`,
   and the `golive` gate in regardless. Confirm `humans:` includes the operator and **not**
   the bot.

3. **Agent-auth prep (subscription only):** if they chose subscription auth, have them run
   `claude setup-token` once on a machine logged into their Claude plan — it prints a
   ~1-year OAuth token. That token (NOT the value in any committed file) becomes
   `CLAUDE_CODE_OAUTH_TOKEN` in the worker's environment. With API-key auth, skip this.

   > Throughout the rest of this step, **`<AGENT_SECRET>`** means whichever the operator
   > chose: `ANTHROPIC_API_KEY` (api-key) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription).
   > Pass `--auth subscription` to `verity install --actions` for the subscription variant.

4. **Driver artifacts:**
   - *Actions / both:*
     ```bash
     verity install --actions --bot <bot-login> [--auth subscription]   # omit --auth for api-key
     ```
     Then tell them to commit `.github/workflows/verity-worker.yml` and add the
     **repository secrets** in GitHub (Settings → Secrets and variables → Actions):
     `VERITY_BOT_TOKEN` (bot PAT, repo write + `workflow`) and `<AGENT_SECRET>`.
     The scaffold is idempotent; if the file has local edits (or a different `--auth`/`--bot`)
     it refuses to overwrite (re-run with `--force`).
   - *Cron / both:* print the exact line for their interval / repo path / token location:
     ```cron
     <interval> cd <repo-path> && GH_TOKEN=$(cat <token-file>) <AGENT_SECRET>=$(cat <agent-token-file>) verity-worker --repo <owner/name> --once >> ~/verity-worker.log 2>&1
     ```
     (On subscription auth, do **not** also export `ANTHROPIC_API_KEY` — it would override
     the subscription. A box already logged in via `claude login` can omit
     `CLAUDE_CODE_OAUTH_TOKEN`, but the explicit token survives session/credential expiry.)
   - *Manual:* give them the one command — `verity-worker --repo <owner/name> --once` —
     and the env it needs (`GH_TOKEN` as the bot, plus `<AGENT_SECRET>`).

4. **DEPLOYMENT.md** — write a record to the repo capturing every choice (driver, mode,
   trust, bot login, humans, limits, cadence, secret locations *by reference, never
   values*), the exact commands generated, and a dated "decided on" line. This is the
   deployment's ADR — future-you should be able to read it and reproduce the setup.

## 3. Hand-off checklist (always end with this)

- **Prove the kill switch before going live:** `gh issue create --title "HALT" --label
  verity:circuit-open`, run one tick, confirm it exits 30 `circuit-open` and does nothing,
  then close the issue. Also remind them: `verity autonomy set mode manual` is the instant off.
- **Start supervised + trust 0** unless they've already run a canary. Suggest a 2-week
  supervised canary (see `docs/dev/autonomy-canary-checklist.md`).
- **File the first work:** open an issue, label it `verity:request`, and let the next tick
  pick it up. To approve a gated PR later, apply the `verity:approved` label.
- **Watch the first run:** stand up the **friction kit** (`docs/dev/friction-kit/`) so the
  first ticks are documented. Read run summaries on the issue/PR and `verity usage --days 7`.
- **Secrets never touch git** — `DEPLOYMENT.md` references their *locations* only.

Keep the whole interview tight — a handful of questions, then a working, recorded deployment.
