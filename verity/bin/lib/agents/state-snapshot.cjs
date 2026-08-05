// Stage 24 (ADR-0013 — the model computes, Verity talks to GitHub): the
// PRE-DISPATCH state snapshot. A contained role cannot reach GitHub by
// construction (the sandbox denies network, ADR-0011 — and we do NOT widen
// it), yet its workflow opens with GitHub reads: `verity state stage N`,
// `verity state next`, the PR's CI state. Stage 20 made those reads honest
// (fail-closed), which surfaced the design gap — an in-sandbox read can only
// ever refuse. So the READ moves, not the honesty: Verity gathers the facts a
// role's workflow needs OUTSIDE the sandbox, from the SAME verified snapshot
// the dispatch decision derives from, and renders them into the role's prompt.
//
// Two halves, deliberately split so each side stays testable:
//   build(proj, snapshot, decision)  — worker-side DATA: the facts object a
//     `verity next` work decision carries (additively, only when asked — see
//     next.dispatch opts.withFacts). Pure derivation over inputs someone
//     already verified; this module never fetches anything, so it can never
//     soften stage 20's refusal — an unverified snapshot never produces a
//     decision to attach facts to.
//   renderFacts(facts)               — prompt-side TEXT: the deterministic
//     block the contained render interpolates into the ADR-0013 preamble
//     (verity/templates/preamble-verity-github.md.tmpl). Tolerant of partial
//     facts (a CLI caller may hand agent-exec any JSON object): a missing
//     field renders as absent, never as a crash mid-dispatch.
//
// Like agents/git-lifecycle.cjs this module is provider-NEUTRAL: it names no
// runtime, and a provider opts in by declaring `supportsStateSnapshot` and
// consuming `ctx.state` in its renderPrompt.
const ledger = require('../ledger.cjs');

// The facts a dispatched role's workflow needs (spec: stage status,
// `verity state next`, dependency/PR/CI state). `decision` is the `verity
// next` work decision the worker is about to act on; its first role arg names
// the stage for the build/review workflows (a P4 plan dispatch never comes
// through here — it is synthesized before the dependency engine runs).
function build(proj, snapshot, decision) {
  const stageNumber = Number((decision.args || [])[0]);
  const s = proj.stages.find((st) => st.number === stageNumber);
  const facts = {
    schema: 1,
    as_of: new Date().toISOString(),
    reason: decision.reason ?? null,
    next: [...proj.next],
    stages: proj.stages.map((st) => ({ number: st.number, title: st.title, status: st.status })),
    stage: null,
  };
  if (s !== undefined) {
    const prRecord =
      s.pr === null ? undefined : (snapshot.prs || []).find((p) => p.number === s.pr);
    facts.stage = {
      number: s.number,
      title: s.title,
      status: s.status,
      depends_on: s.dependsOn.map((d) => ({
        number: d,
        status: proj.stages.find((x) => x.number === d)?.status ?? 'unknown',
      })),
      issue: s.issue,
      pr: s.pr,
      // Three-state CI (stage 19), never a boolean: a PR record the verified
      // snapshot somehow lacks reads as 'unknown' — absence of data is not a
      // green light, and not a red one either.
      ci:
        s.pr === null
          ? null
          : prRecord === undefined
            ? ledger.CI_UNKNOWN
            : ledger.ciStateOf(prRecord),
    };
  }
  return facts;
}

// The deterministic prompt block. It names the reads it replaces so a role
// following its written workflow finds the answer where the command would
// have been — mirroring the stage-17 preamble's "the branch already exists".
function renderFacts(facts = {}) {
  const next = Array.isArray(facts.next) ? facts.next : [];
  const stages = Array.isArray(facts.stages) ? facts.stages : [];
  const lines = [
    `Read from GitHub by Verity at ${facts.as_of || '(unknown time)'}, outside this sandbox — the answers the \`verity state\` reads in your steps would have given:`,
    `- unblocked stages (\`verity state next\`): ${JSON.stringify(next)}`,
  ];
  const st = facts.stage;
  if (st !== null && st !== undefined && typeof st === 'object') {
    const deps =
      Array.isArray(st.depends_on) && st.depends_on.length > 0
        ? st.depends_on.map((d) => `stage ${d.number} (${d.status})`).join(', ')
        : 'none';
    const issue = st.issue === null || st.issue === undefined ? '(none)' : `#${st.issue}`;
    const pr = st.pr === null || st.pr === undefined ? '(none)' : `#${st.pr} (CI: ${st.ci})`;
    lines.push(
      `- this run's stage: stage ${st.number} (${st.title}) — status: ${st.status} · depends on: ${deps} · work-item issue: ${issue} · PR: ${pr}`,
    );
  }
  if (stages.length > 0) {
    lines.push(
      `- all stages: ${stages.map((s) => `#${s.number} ${s.title} — ${s.status}`).join('; ')}`,
    );
  }
  if (typeof facts.reason === 'string' && facts.reason !== '') {
    lines.push(`- dispatch reason: ${facts.reason}`);
  }
  return lines.join('\n');
}

module.exports = { build, renderFacts };
