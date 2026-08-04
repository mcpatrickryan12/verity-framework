# Verity — Quickstart (zero → running)

The fast path from a fresh machine to a Verity project that's moving — by hand, or on its
own. If you want the full mental model first, read the [Overview](docs/verity-overview.html);
if you just want to *go*, start here.

Verity carries a project from idea to **proven-in-production** by running it as a sequence
of specialized AI roles, with **GitHub as the single source of truth**. You can drive those
roles yourself, or let the **autonomy worker** drive them for you and pause at human gates.

---

## 1. Install (2 minutes)

**Prerequisites:** a GitHub account · Node ≥16 · `git` and the GitHub CLI (`gh`) installed
**and signed in**.

```bash
# preflight — all three should answer without error:
node -v && git --version && gh auth status

npm i -g verity-framework

# connect it to your assistant:
verity install --claude        # or: --opencode
```

> Autonomy is opt-in and off by default — you get the hand-driven roles out of
> the box; enable the headless worker later with `/verity:autonomy-setup`.
> See [the autonomy layer](docs/whats-different.md).

`verity install` also creates the eight `verity:*` GitHub labels (idempotently) that the
autonomy worker uses as its state machine — harmless if you never turn autonomy on.

---

## 2. Pick your path

### Path A — drive it yourself

In your AI assistant, start a project and walk the arcs by hand:

```
/verity:vision      → clarify the idea, name it, scaffold the repo
/verity:architect   → design the stack, choose where it deploys, prove a walking skeleton
/verity:plan        → turn a request into a stage
/verity:build       → implement it, open a green PR
/verity:review      → adversarial review, then merge
/verity:ship        → release + deploy
/verity:verify      → confirm it observably works on the live app
```

The [Usage guide](docs/verity-usage.html) has command-by-command recipes. This is all you
need — autonomy is optional.

### Path B — let it run itself (autonomy)

The headless **`verity-worker`** picks up labeled work from GitHub, runs those same roles,
and pauses at every human gate. Three things make this safe to try:

> **Kill switch, first.** Two instant stops, both effective at the worker's next wake-up:
> label any open issue `verity:circuit-open` (worker halts, does nothing), or
> `verity autonomy set mode manual` (worker exits immediately). Prove one works *before*
> you go live.

**B1. Generate your deployment by interview.** Instead of hand-writing config, run the
guided setup — it asks how you want the worker to run and generates everything:

```
/verity:autonomy-setup
```

(`verity install --claude` already put this command in place.) It walks you through **driver**
(cron / Actions / manual), **mode**, **bot identity**, **trust**, and **budget**, then
writes a tailored `.verity/autonomy.yml`, the cron line and/or the Actions workflow, the
bot + secrets checklists, and a `DEPLOYMENT.md` recording your choices.

**B2. Start conservative.** Take the interview's recommended defaults: `mode: supervised`,
`review.trust: 0` (worker never merges — it gates every PR for you), the default
$25/day cap.

**B3. Give it work.** Open a GitHub issue describing something to build and label it
`verity:request`. The next tick plans it → builds it → opens a PR → gates at
`review:merge`. The worker leaves a comment telling you exactly how to approve: **apply the
`verity:approved` label**, and the next tick resumes.

**B4. Document the first run.** Stand up the **friction kit**
([`docs/dev/friction-kit/`](docs/dev/friction-kit/)) and run the first ticks with a Claude
Code session as cockpit — it journals every snag and maps it to the part of the framework
that owns it, so you can smooth the rough edges afterward.

**B5. Watch the cost.** Every run posts an audit comment (roles, outcome, tokens, est. $,
wall time) and appends to `.verity/usage.csv`:

```bash
verity usage --days 7
```

Full operator reference: the [Autonomy guide](docs/autonomy.md).

---

## 3. Deployment options at a glance

How the **worker** runs (the `/verity:autonomy-setup` interview generates whichever you pick):

| Driver | What it is | Good when |
|---|---|---|
| **Cron** | One crontab line on a server with the repo cloned and `gh` as the bot | You have a always-on box; want full control |
| **GitHub Actions** | `verity install --actions` scaffolds a workflow GitHub hosts; runs on schedule **and** on issue/PR/comment events | No server; want approvals picked up in seconds |
| **Manual** | You run `verity-worker --repo owner/name --once` by hand | Trying it out; one tick at a time |
| **Both** | Cron + Actions together | Belt and braces — the GitHub lock protocol and the workflow's concurrency group prevent double-work |

Separately, **where your *app* deploys** is its own deliberate choice — the
deployment-methods catalog (`verity deployment list`); the Architect picks a target with you
and records it as an ADR. See the [README](README.md#deployment-methods).

---

## 4. The safety rails (always on)

- **Kill switch** — `verity:circuit-open` label or `mode: manual`.
- **Daily allowance** — `max_usd_per_day` / `max_runs_per_day`; exceeded → worker won't start.
- **Permanent gates** — `golive` always pauses for a human; can't be removed.
- **Two strikes** — a task that fails twice gets `verity:needs-human` and is skipped, no loops.
- **Deterministic merge** — only code decides merges via the trust ladder; the review AI has
  no merge tool.
- **Bot-attributed & audited** — a dedicated machine user does the work; every action leaves
  a comment and a ledger row.

---

## Where to go next

- [**Autonomy guide**](docs/autonomy.md) — kill switch, modes, trust ladder, labels, approvals, cron + Actions + bot setup, cost tracking
- [**Deploy kit**](docs/dev/deploy-kit/) — the `/verity:autonomy-setup` interview
- [**Friction kit**](docs/dev/friction-kit/) — document your first run and capture friction
- [**Usage guide**](docs/verity-usage.html) · [**Command reference**](docs/commands.md) — all 15 `/verity:*` roles
- [**Canary checklist**](docs/dev/autonomy-canary-checklist.md) — the 2-week supervised run before trusting it more
