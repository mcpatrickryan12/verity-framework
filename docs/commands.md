# Command Reference

Verity runs a project as a sequence of specialized AI roles. You invoke each role
as a slash command in your AI assistant (Claude Code or OpenCode) after installing:

```bash
npm i -g verity-framework
verity install --claude                  # or: --opencode
```

There are **15 role commands**. The command name is short; the *role* it runs is
named in the table — `/verity:ship` runs the Release/Deploy Operator,
`/verity:verify` runs the Handoff Tester, `/verity:build` runs the Stage Manager,
and so on. Start any new project with [`/verity:vision`](#design).

> The commands are the public surface. Underneath, each one calls the deterministic
> `verity` CLI (run `verity help` to see it) — but you rarely touch the CLI directly.

---

## Design

Lock what you're building before any code is written.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:vision` | Vision | Clarify the idea, lock the project identity, and scaffold the repo with an honest hygiene CI. **Start here.** |
| `/verity:architect` | Architect | Turn the locked identity + vision into a technical design — stack & topology, frozen interface contracts, ADRs, the deployment target (from your `verity deployment` catalog) — and own the walking skeleton. |
| `/verity:deploy-setup` | Deployment Methods | Interview you about where you deploy apps (AWS / GCP / Azure / LAN / PaaS / SSH / k8s…) and build your **global** `~/.verity/deployment-methods.md` catalog — locations, never secrets. A setup helper run once (or when your targets change); the Architect reads what it writes. |

## Plan & Build

Stages are the unit of work. They are born in the Planner, built in isolation, and
merged only through review.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:plan` | Intake / Planner | Assess a request and write the stage spec + work-item. The **only** place stages are born — both the initial backlog and the recurring request stream. |
| `/verity:build <stage-number>` | Stage Manager | Build one stage in isolation, open a green PR, and hand off to review. **Never merges.** |
| `/verity:review <stage-number> [pr-number]` | Reviewer / Integrator | Adversarially review a stage's PR against the source, then merge. The integration gate — you did *not* write this code. |
| `/verity:test` | Project Tester | Guardian of test honesty: real, CI-like tests plus bug fixes, so "done = green" actually means something. |

## Quality Gates

Defined once, enforced on every change.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:security` | Security Auditor | Define the security invariants the Reviewer enforces per-PR, and run periodic deep audits. |
| `/verity:docs` | Technical Writer | Own the human-readable layer: public/developer docs, the architecture narrative, and handoff briefs that let another agent pick up a feature. |

## Release & Operate

Take accrued merges all the way to production — and keep it healthy.

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:ship` | Release / Deploy Operator | Cut a release, deploy to staging, UI-smoke verify, promote to prod, and update `STATUS.md`. |
| `/verity:verify` | Handoff Tester | Adversarial end-user testing on the **live** app, and re-verify-on-live after each deploy — finding what scripted smokes can't. |
| `/verity:golive` | Pre-Go-Live Gate | **Blocking** gate before the project accepts real data or users: force-close the "fine for now" list (Security Auditor + SRE jointly). |
| `/verity:sre` | SRE | Steady-state operations: recovery/backup readiness, intermittent-env handling, secret rotation, and monitoring. |
| `/verity:autonomy-setup` | Autonomy Deployment | Interview you about how to run the headless `verity-worker` (cron / Actions / manual), then generate the tailored deployment — `.verity/autonomy.yml`, the cron line and/or Actions workflow, bot + secrets checklists, and a `DEPLOYMENT.md`. A setup helper run once (or when your deployment changes). |

## Any time

| Command | Role | What it does |
| --- | --- | --- |
| `/verity:map` | Codebase Mapper | Generate an on-demand, structural code map (distinct from the Planner's schedule) — generated, never hand-maintained. |

---

## A typical lifecycle

```
vision → architect → plan → build → review → test → security → docs
       → ship → verify → golive → sre
```

`/verity:map` is available at any point. You don't have to run every role on every
project — Verity tracks dependencies, so `/verity:next` (and each role on completion)
points you at what can run next. `/verity:deploy-setup` (where your apps ship) and
`/verity:autonomy-setup` (how the worker runs) are one-time (or when-things-change)
setup helpers, run independently of any single project's lifecycle.

## See also

- [Overview](verity-overview.html) — what Verity is and the mental model
- [Usage](verity-usage.html) — install + command-by-command recipes
- [Flows](verity-flows.html) — new project vs. existing project, side by side
- [Framework spec](framework-spec.md) · [Roles spec](roles-spec.md) — full architecture and rationale
