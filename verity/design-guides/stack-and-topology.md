---
title: Stack & Topology Selection
topic: architecture
applies-to: new, existing
---

# Stack & Topology Selection

> A **recommendation**, not a mandate. Deviate when the project justifies it — and
> record the deviation as an ADR (`verity adr new`).

## Default lean

- **Boring, well-supported stacks** over novel ones. The cost of a production
  project is operations over years, not the first week of coding.
- **Server-rendered + progressive enhancement** before a SPA, unless the UX truly
  needs a rich client. Fewer moving parts, fewer build steps, fewer ways to ship a
  blank page (the "HTMX stub" class of failure).
- **Pin dependencies and commit the lockfile** from day one — non-reproducible
  builds are silent drift.

## Topology

- Start as a **modular monolith**. Split a service out only when there is a real
  reason (independent scaling, a hard team/ownership boundary, a different runtime).
- Every service you add multiplies the CI build matrix, the image set, and the
  deploy surface. The slug extends per-service: `ghcr.io/<owner>/<slug>-<service>`.

## Walking skeleton first

Before feature work, prove a **thinnest end-to-end slice** that is green in CI,
deployed, and UI-smoked. Wiring the real test/deploy environment first kills the
"9 stages done before CI ever ran green" failure at the root.

## When to deviate

If the team's expertise, an existing codebase, or a hard requirement points
elsewhere, choose it — and write the ADR capturing *guide said X, we chose Y, because Z*.
