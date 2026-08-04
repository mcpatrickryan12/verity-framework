---
name: verity:example
description: Example — golden fixture role.
allowed-tools:
  - Bash
---
Runtime fallback: `node "$HOME/.claude/verity/bin/verity.cjs" ...` if `verity` is off PATH.

<objective>
Golden fixture role for the ADR-0002 transform pipeline. The body mentions the
engine path "$HOME/.claude/verity" once so the OpenCode rewrite is exercised.
</objective>

<process>
1. Run `verity slug "$ARGUMENTS"`.
</process>
