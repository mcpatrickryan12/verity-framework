---
description: Example — golden fixture role.
---
Runtime fallback: `node "${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/verity/bin/verity.cjs" ...` if `verity` is off PATH.

<objective>
Golden fixture role for the ADR-0002 transform pipeline. The body mentions the
engine path "${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/verity" once so the OpenCode rewrite is exercised.
</objective>

<process>
1. Run `verity slug "$ARGUMENTS"`.
</process>
