# Contract: agent-result

- **Status:** frozen v1
- **Owner:** `verity/bin/lib/agents/result-contract.cjs` (provider drivers produce
  it; `agent-exec.cjs` emits it; the worker consumes it)
- **Related:** ADR-0005 §"one seam", ADR-0008 (null cost), SKETCH §3.3

The single object every provider driver must return and the ONLY thing that
crosses from a model runtime back into deterministic Verity. Provider events,
JSONL grammars, and CLI exit conventions never leak past this shape.

**v1 freezes the current, already-shipped `agent-exec` result object** (the
shape the worker, usage ledger, and tests depend on today). Codex fields are
additive on top of it.

## Exposes

One JSON object on `agent-exec` stdout per invocation — emitted for role
outcomes AND infra failures alike, so callers always get exactly one parseable
object. Exit-code mapping is part of the contract: `success` → 0, `gated` → 10,
`failed` → 20, `infra_error` → 30.

## Consumes

- The provider's raw transcript (retained verbatim on disk — Claude:
  `~/.verity/logs/<run-id>/<role>.jsonl`; Codex adds
  `<role>.codex.jsonl` + `<role>.final.json` per ADR-0005/§19.2 naming).
- The role's in-band outcome marker
  (`{"verity":1,"outcome":"success|gated|failed","gate":…,"artifacts":…,"reason":…}`,
  last line of the final message — the existing RESULT_CONTRACT footer) OR a
  provider structured-output file validated against
  `schemas/agent-result.schema.json`. Both normalize into this contract;
  neither consumer-visible shape changes.

## Schema / wire

v1 fields (all REQUIRED, exactly as shipped today):

```json
{
  "schema": 1,
  "role": "plan",
  "outcome": "success | gated | failed | infra_error",
  "tokens": { "in": 0, "out": 0 },
  "est_usd": null,
  "wall_secs": 12,
  "tool_calls": 7,
  "artifacts": {},
  "error": null
}
```

Semantics that are part of the freeze:

- `tokens.in` includes cache-creation and cache-read input tokens (the
  existing Claude normalization); providers must fold their own usage fields
  into these two totals.
- `est_usd` is `number | null`. **`null` means unknown — writing `0` for
  unknown cost is a contract violation** (ADR-0008: zero means free, and the
  budget breaker believes it).
- `artifacts` is a plain object of GitHub objects created/updated (best
  effort); `error` is `string | null` and non-null iff `outcome` is `failed`
  or `infra_error`.
- Infra failures also print one machine-parsable stderr line:
  `verity-agent-exec: 30 <slug>: <message>`.

Additive v1.x fields (OPTIONAL — consumers must tolerate their absence, and
their presence, without behavior change when absent):

```json
{
  "provider": "claude | codex",
  "timed_out": false,
  "transcript_path": ".../plan.codex.jsonl",
  "final_message_path": ".../plan.final.json",
  "usage_detail": {
    "input_tokens": 1234,
    "cached_input_tokens": 500,
    "output_tokens": 450,
    "reasoning_output_tokens": 200,
    "total_tokens": 1884
  }
}
```

Fail-closed normalization rules (binding on every driver): invalid JSON,
schema-invalid structured output, a missing result file, or a completed
process with no valid result all normalize to `infra_error` — never to
`success`, never to a silent no-op. A timeout is a `failed`/`infra_error`
with `timed_out: true`, never `success`.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
