// Localhost act runner (stage 87, ADR-0030) — the first non-direct
// `gate_runner`: the engine executes the committed gate definition via
// nektos/act (Docker) on this machine. Same commands as the direct runner,
// graduation-fidelity environment — the workflow act executes is RENDERED
// from, and only from, the committed `.verity/gates.json` at the pinned sha
// (`git show <sha>:.verity/gates.json`, gates.cjs readGateDefinitionAt), into
// a temp directory, for one run. A workflow file lying in the working tree is
// never consulted: workflow YAML must never become an independent source of
// gate truth (ADR-0030 invariant; the templates/gates-workflow.yml.tmpl
// header repeats it inside every rendered file).
//
// This module replaces ONLY the "run the commands" middle of
// gates.runGatesForBranch. The stage-82 honesty protocol around it — SHA pin,
// dirty-tree refusal, mid-run head-move refusal, gates-modified-tree refusal,
// record-write bracketing — stays the SINGLE code path in gates.cjs; the
// honesty protocol is never forked per runner.
//
// Per-gate mapping (the stage-87 documented choice): act reports ONE exit
// code for the whole workflow run — it does not report a per-gate exit code
// for each committed gate, and inventing them would fabricate results the
// record's honesty rule then judges. So a localhost record's gates[] carries
// exactly ONE entry, named `act:gates` for the rendered workflow's single
// `gates` job (which replays every committed gate, in order, stopping at the
// first failure — the run-gates semantics), whose exit_code is act's REAL
// process exit code and whose command is the REAL act invocation. Every
// recorded exit_code is therefore truthful: 0 means act proved every gate
// green (a step failure fails the job fails act); nonzero is act's own
// verdict, never distributed onto gates act did not individually report.
// The frozen contract (local-work-item v1) admits this shape unchanged: a
// gates[] entry needs a string name and an integer exit_code, and the
// honesty rule (`sha` + every exit_code 0 ⇒ green) reads it exactly right.
//
// Preflight (fail-closed, byte-stable, thrown BEFORE anything runs, NO record
// ⇒ UNKNOWN downstream): Docker binary absent, Docker daemon unreachable, act
// binary absent, act version unparseable, workflow render failure. The engine
// NEVER silently degrades localhost→direct (ADR-0030: no implicit runner
// substitution).
//
// Binary overrides follow the VERITY_CODEX_BIN precedence convention:
// VERITY_DOCKER_BIN / VERITY_ACT_BIN name the executables (tests stub them;
// operators with off-PATH installs point at them). doctor.cjs probes the same
// two binaries under the same overrides when the resolved gate_runner is
// 'localhost'.
//
// Node built-ins only (zero-dependency repo).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { render } = require('./core.cjs');
// doctor is a leaf module (the agent drivers require it for checkBinary) —
// requiring it here keeps version-parse logic in exactly one place.
const doctor = require('./doctor.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const WORKFLOW_TEMPLATE = 'gates-workflow.yml.tmpl';

// The one gates[] entry a localhost record carries — named for the rendered
// workflow's `gates` job (see the per-gate mapping in the header).
const ACT_GATE_NAME = 'act:gates';

function dockerBin(env) {
  return (env || process.env).VERITY_DOCKER_BIN || 'docker';
}

function actBin(env) {
  return (env || process.env).VERITY_ACT_BIN || 'act';
}

// --- preflight: refuse BEFORE the run starts (never mid-run) -----------------

// Probe the localhost runner's host dependencies. Throws a byte-stable
// refusal on the first missing one; returns { docker, act, actVersion } when
// the machine can honestly execute. Called by gates.runGatesForBranch before
// any git read or command spawn (ADR-0030: refusals happen at preflight).
function preflight(opts = {}) {
  const env = opts.env || process.env;
  const docker = dockerBin(env);
  const act = actBin(env);

  // 1. Docker client binary — `docker --version` runs daemonless, so an
  //    error/nonzero here means the BINARY is the problem, not the daemon.
  const client = spawnSync(docker, ['--version'], { encoding: 'utf8' });
  if (client.error || client.status !== 0) {
    throw new Error(
      `gate_runner 'localhost' preflight: docker binary '${docker}' is not runnable — act executes the rendered gates workflow in Docker (ADR-0030); install Docker or point VERITY_DOCKER_BIN at it; no record is written and the branch stays UNKNOWN`,
    );
  }
  // 2. Daemon reachability — `docker info` exits nonzero when the daemon is
  //    down/unreachable (exit-code judged, never parsed output).
  const daemon = spawnSync(docker, ['info'], { encoding: 'utf8' });
  if (daemon.error || daemon.status !== 0) {
    throw new Error(
      `gate_runner 'localhost' preflight: the Docker daemon is not reachable (\`${docker} info\` exited nonzero) — act needs a running daemon to execute the gates workflow (ADR-0030); start Docker; no record is written and the branch stays UNKNOWN`,
    );
  }
  // 3. act present, with a version Verity can identify (doctor.checkBinary —
  //    the one shared x.y.z probe; `act --version` prints "act version x.y.z").
  const probe = doctor.checkBinary(act, {});
  if (!probe.present) {
    throw new Error(
      `gate_runner 'localhost' preflight: act binary '${act}' is not runnable — the localhost runner executes gates via nektos/act (ADR-0030); install act or point VERITY_ACT_BIN at it; no record is written and the branch stays UNKNOWN`,
    );
  }
  if (probe.version === null) {
    throw new Error(
      `gate_runner 'localhost' preflight: could not parse an act version from \`${act} --version\` — refusing to run gates under an act Verity cannot identify (fail closed); no record is written and the branch stays UNKNOWN`,
    );
  }
  return { docker, act, actVersion: probe.version };
}

// --- render: committed definition → one-run workflow YAML --------------------

// One workflow step per committed gate, in definition order — steps stop at
// the first failure exactly like runGateCommands, so act's exit code carries
// the same stop-at-first-failure truth. Names and commands are embedded as
// JSON strings (valid YAML double-quoted flow scalars), so a command carrying
// quotes/newlines/#-comments can never change the workflow's shape.
function renderWorkflow(gatesList, sha) {
  const steps = gatesList
    .map(
      (g) => `      - name: ${JSON.stringify(g.name)}\n        run: ${JSON.stringify(g.command)}`,
    )
    .join('\n');
  const tmpl = fs.readFileSync(path.join(TEMPLATES_DIR, WORKFLOW_TEMPLATE), 'utf8');
  return render(tmpl, { sha, steps });
}

// The workflow for a pinned sha — read via `git show <sha>:.verity/gates.json`
// and NOTHING else: an uncommitted gates.json edit, or a doctored workflow
// file in the working tree, can never shape what act executes (ADR-0030
// single-source invariant). Stage 89 reuses this on remote hosts.
function renderWorkflowAt(cwd, sha) {
  // Lazy require: gates.cjs requires this module for its middle dispatch, so a
  // load-time require back would be a cycle; at call time the export table is
  // complete. Definition errors (absent/invalid at the sha) propagate with
  // their own honest messages — they are a definition problem, not a render
  // failure, and runGatesForBranch has already validated the definition by
  // the time execution reaches here.
  const gatesMod = require('./gates.cjs');
  return renderWorkflow(gatesMod.readGateDefinitionAt(cwd, sha), sha);
}

// --- execute: act against the pinned-sha checkout, exit-code judged ----------

// Run act on the rendered workflow with the repo checkout (which
// runGatesForBranch has placed at, and verified clean against, the pinned
// sha) as the working directory. Returns the runGateCommands outcome shape
// { ok, gates } under the documented single-entry mapping. `--workflows` pins
// act to the rendered temp file, so the repo's own .github/workflows/ (if
// any) is never what runs. Judgment is act's exit code ONLY — stdio is
// inherited (or discarded via opts.stdio), never parsed (ADR-0028); a spawn
// that died without an integer status is recorded as 1 (fail closed).
function execute(cwd, sha, opts = {}) {
  const env = opts.env || process.env;
  const act = actBin(env);
  const yaml = renderWorkflowAt(cwd, sha);
  let tempDir;
  let workflowFile;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-act-'));
    workflowFile = path.join(tempDir, 'gates.yml');
    fs.writeFileSync(workflowFile, yaml);
  } catch (err) {
    throw new Error(
      `gate_runner 'localhost' preflight: failed to render the gates workflow for ${sha} to a temp location (${err.message}) — no record is written and the branch stays UNKNOWN`,
    );
  }
  try {
    const args = ['push', '--workflows', workflowFile];
    const run = spawnSync(act, args, { cwd, stdio: opts.stdio || 'inherit' });
    const exitCode = run.status === 0 ? 0 : Number.isInteger(run.status) ? run.status : 1;
    return {
      ok: exitCode === 0,
      // The documented mapping (module header): ONE truthful aggregate entry —
      // act's real exit code under act's real invocation, never fabricated
      // per-gate codes act did not report.
      gates: [{ name: ACT_GATE_NAME, command: `${act} ${args.join(' ')}`, exit_code: exitCode }],
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  ACT_GATE_NAME,
  actBin,
  dockerBin,
  execute,
  preflight,
  renderWorkflow,
  renderWorkflowAt,
};
