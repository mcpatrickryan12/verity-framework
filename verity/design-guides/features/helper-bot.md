---
title: In-App Help Agent
id: helper-bot
topic: feature
applies-to: new, existing
---

# Drop-in Feature: In-App Help Agent

> Feature #1 in the catalog. An *application* feature Verity can scaffold into the
> app being built (NOT a framework agent). The Architect offers it; if accepted,
> its stages fold into the Intake/Planner's backlog.

## What it is

A help surface inside the product: a restricted **mode of the app's own chat loop**,
isolated by a separate, read-only tool registry. It answers user questions with real
evidence, drafts GitHub issues (human-confirmed), and accretes a living FAQ.

## Applicability / prerequisites

- The app has (or will have) a chat/LLM loop and a web UI surface.
- Structured, queryable logs (or a place to add them).
- A GitHub repo (for issue drafting) and a CI/CD pipeline (Verity provides this).

## Architectural requirements (→ ADRs)

- Structured JSON logging the agent can read (`logs/app.log` or equivalent).
- A `?` help entry point opening an isolated help session (separate window/panel).
- A **separate, least-privilege tool registry** for help mode (security by construction).
- A baked **read-only source snapshot** (`git archive HEAD`) so the bot reasons from
  the *deployed* code — freshness becomes a build property, not a maintenance chore.

## Reusable pattern (parameterized by the app's log schema + repo)

- Help = restricted mode of the main chat loop (not a new service).
- Caller-scoped, **non-widenable** log reads (the model can't query other users).
- **Draft-then-confirm** external actions (issue filing is human-in-the-loop).
- A read/append markdown FAQ as lightweight institutional memory.

## Stages injected — new-app recipe

1. Structured JSON logging. 2. Architecture-doc/source-snapshot wiring. 3. Help UI
(`?` → isolated session). 4. Help-mode agent + restricted tool registry. 5. Draft
GitHub issue endpoint (auth + label + rate-limit + redact). 6. FAQ read/append + batch job.

## Stages injected — retrofit recipe

1. Point the agent at existing log output (add a formatter if unstructured).
2. Write the architecture/source grounding. 3. Drop in a floating help widget at the
app-shell level. 4. Backend wiring (agent + GitHub hook + FAQ) without touching app code.

## Conflicts / deps

- Depends on the CI/CD spine (Verity) for the source-snapshot bake at release.
- No conflicts with other catalog features.

## Config knobs

- `HELP_ENABLED` kill-switch (default off — ship dark, enable by flag).
- FAQ recency/TTL weighting.
