# Codex transcript fixtures — provenance

Every `codex-*.jsonl` fixture here is **DOC-DERIVED** (stage 10): hand-written
to the JSONL event shape the official Codex CLI documentation describes
(items carry their kind at `item.type`, e.g.
`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}`),
NOT captured from a real Codex run. JSONL cannot carry inline comments, so
this README is the provenance marker.

**Still true after stage 12.** Stage 12's agent-side half (feature matrix,
version pin, doctor, opt-in real-CLI lane, evidence template) shipped without
running a real Codex CLI, so nothing here has been replaced. Capturing real
fixtures requires the human-run canary
(`docs/dev/codex-headless-canary.md`), and they land only alongside a
committed `codex-headless-canary-results-<codex-version>.md`, each fixture
recording the Codex version it came from. Until that exists, treat every shape
below as *documented*, not *observed* — and never relabel a file as captured
without the run that captured it.

The one shape here that IS a real-CLI observation is the usage event asserted
in `tests/agents-codex.test.cjs` (issue #29 / spike F7): it is transcribed from
`docs/dev/codex-enforcement-spike-0.146.0.md` and lives inline in the test, not
as a fixture file, precisely so it cannot be mistaken for a captured transcript.

The one deliberate exception: `codex-legacy-item-type.jsonl` keeps the
pre-stage-10 stub shape (`item.item_type`) and exists solely to pin the
parser's explicitly-tested legacy fallback (codex.cjs `itemKind()`).

The `codex-final-*.json` files are structured role-outcome documents
(`schemas/agent-result.schema.json`), not transcripts — the same doc-derived
status applies.
