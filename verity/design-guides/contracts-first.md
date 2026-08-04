---
title: Contracts-First Design
topic: architecture
applies-to: new, existing
---

# Contracts-First Design

> A **recommendation** with one hard rule: once a contract is frozen, you do not
> break it.

## The rule

Define the interface contracts between components (wire format, auth, schema,
envelope) **early**, freeze them at **v1**, and make every later change **additive**.
A breaking change is a *new contract*, not an edit — so consumers never shift under
each other's feet.

## Why it carries production work

In a real multi-stage build, a frozen contract is what lets later stages — and
*other agents* — extend the system safely without re-litigating the core. Iteration
becomes "additive, contract-compatible stages" instead of risky re-architecture
against already-deployed code.

## How to apply

- For each seam between components, run `verity contract new <name>` and fill in
  Exposes / Consumes / Schema.
- Reviewer/Integrator verifies every PR against the frozen contracts.
- If a stage genuinely needs a new seam, the Intake/Planner issues a *new* contract;
  the existing one is never reopened.
