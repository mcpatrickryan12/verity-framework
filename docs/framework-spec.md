# Verity — a CI/CD-native, GitHub-native, production-lifecycle AI software delivery framework

*Tagline: **Prompt to production, proven.** · npm package: `verity-framework` (available as of 2026-06-07) · repo: `verity-framework`.*
*Clean-room successor to spec-driven-devops 1.4. Borrows concepts, not code. Build from this.*
*Status: design complete, pre-implementation (2026-06-07). Working log + rationale: `roles-spec.md`; ground-truth interview: `flow-interview-questions.md`; brand: `verity-marketing-layout.md`.*

### Internal subsystem vocabulary (adopted from the brand system — one package, not five)
- **Relay** = role orchestration + the stream loop + dependency engine.
- **Shipyard** = CI/CD spine + Release/Deploy Operator (build/release/deploy) + `STATUS.md` (runtime truth).
- **Ledger** = the state-derivation engine (§5) — GitHub-derived integration state, no stale files.
- **Gate** = Reviewer/Integrator + Security Auditor + the walking-skeleton / UI-smoke / pre-go-live gates.
- **Verify** = the UI-smoke "observably-works" gate + Handoff Tester (live verification).
*(Note vs marketing doc: STATUS.md is Shipyard's, not Ledger's; ship as one `verity-framework` package, sub-brands are internal subsystem names.)*

---

## 1. What it is

An AI runs a software project as a sequence of specialized roles — like 1.4 — but built for projects that go **beyond MVP** into real production. Three things make it different from 1.4:

1. **GitHub-native.** GitHub (Issues, PRs, Actions, tags, Milestones, Deployments) is the substrate, not an add-on.
2. **CI/CD is the spine.** "Done" means *proven green and observably working*, not "code written." The pipeline exists before features and gates everything.
3. **Production lifecycle, not one-pass.** The macro-shape is a *stream of feature-stages over an always-on pipeline*, plus continuous operations. Multi-agent collaboration falls out of PR+CI being the integration model — it's emergent, not a bolted-on subsystem.

## 2. Pillars

- **Brain vs Notebook.** The LLM (a role) makes judgment calls; a deterministic CLI performs file/GitHub operations. Reliability lives in the deterministic layer.
- **State is derived, never authored.** A state transition *is* a GitHub act (open/merge a PR, push a tag, close an issue), so "state" is a read-time projection — see §5.
- **Contracts are mandates; guides are recommendations; every deviation is an ADR.**
- **"Done = green."** A pipeline green only because it's empty is a lie; the gate accretes real checks as the project earns them.
- **The slug is the identity key**, locked once at the start (§6).

---

## 3. Macro-model: three arcs over an always-on substrate

```
 ① ONE-PASS BOOTSTRAP          ②  LOOPING STREAM (per feature)        ③ CONTINUOUS OPERATE
 Vision / Retrofit                 ┌───────────────────────────────┐    Release/Deploy Operator
   → Architect (freeze            │ intake/assess → build → CI →   │    SRE · Security · Tech Writer
     contracts) → Designer        │ review → merge → release →     │    pre-go-live gate
   → WALKING SKELETON (Stage 0)   │ deploy(→staging) → UI-smoke    │
   [green+deployed+smoked, or     │ VERIFY → (cut release→prod) →  │
    feature work is BLOCKED]      │ STATUS update                  │
                                  └──────────────▲────────┬────────┘
                                  └─────── loop ──────────┘
 ALWAYS-ON SUBSTRATE: CI/CD spine · GitHub (Issues/PRs/tags/Milestones/Deployments) · DERIVED state ·
                      STATUS.md · capability registry · contracts · ADRs · feature catalog
 HUMAN/OPERATOR GATE: once before Stage 0 (provision) + "env available?" before every deploy
```

- **① Bootstrap** runs once: establish identity, repo, scaffold, frozen contracts, and a *proven* spine (the walking skeleton). Only arc that's linear.
- **② Stream** is the bulk: a feature-stage loop riding the constant pipeline. Stages are born only at intake (`/plan`).
- **③ Operate** runs continuously alongside ②.

**CI/CD progressive gate timeline:** scaffold ships **hygiene CI** (lint, secret-scan, build, dep-pinning — honestly green on a near-empty repo) → the **walking skeleton** turns on the **test gate** → **deploy gate** (build/scan/digest) at release → the **UI-smoke "observably-works" gate** post-deploy. Branch-protection's required-checks list grows in lockstep — *and degrades to honor-system + CI-on-push-to-main when the platform tier can't enforce it.*

---

## 4. Cross-cutting assets

### 4.1 Identity manifest (locked at start, immutable)
One record fixing `{repo, slug (lowercase-canonical), image-prefix, registry-owner, dns, env names, secret names}`. **Decide registry-owner ↔ git-auth identity on day one.** Watch the casing trap (registries require lowercase). Rename later = migration, not edit. The whole scaffold is *generated from* this manifest.

### 4.2 State: derived (integration) + STATUS.md (runtime) — see §5.

### 4.3 Contracts & ADRs (two-tier)
- **Contracts** (`contracts/*.md`): wire/JWT/schema between components. **Mandates.** Frozen early; iteration is *additive contract-compatible stages*, never a contract break. A new seam = a new contract.
- **ADRs** (`docs/adr/NNNN-*.md`): every architectural decision/deviation, append-only, reasoned. (Authored by whichever role makes the call, at decision time.)

### 4.4 Capability registry
Roles **probe runtime capabilities with a real test** (availability ≠ works) and record verified flags; later roles read them deterministically. Instances: image-gen (Designer), sub-agent/Task support (Stage Manager).

### 4.5 Standard feature catalog (drop-in features)
- A drop-in feature = a pre-packaged **stage-set** + the **architectural prerequisites** it imposes. *Offered, not mandated.*
- Lives in `design-guides/features/` (sibling to the recommend-not-mandate design guides). Framework ships samples; org overrides/extends via config.
- **Spec schema** (prototype `helper-bot-feat.md`): `id/slug`, description, applicability+prereqs, architectural requirements (→ ADRs), **stages injected (new-app recipe + retrofit recipe)**, conflicts/deps, config knobs.
- **"Drop-in" = recipe, not copy-paste code** — the build implements it per chosen stack. (Code templates are a possible future.)
- **Offered by the Architect** (architecture-time) **and consumable at intake-time** (`/plan`).
- **Feature #1 = helper-bot**: pattern = "help = restricted mode of the main chat loop, isolated by a separate tool registry" + baked `git archive` source snapshot + caller-scoped non-widenable log reads + draft-then-confirm external action + read/append FAQ; parameterized by log schema + repo. It is an *application* feature, not a framework agent.

### 4.6 Artifact ownership
| Artifact | Owner | Mutable? |
|---|---|---|
| Identity manifest | Vision / Retrofit | locked |
| `contracts/*` | Intake/Planner (Architect/Retrofit freeze the core) | additive only |
| `docs/adr/*` | each role at decision time | append-only |
| `stage-instructions/*`, `feature-assessments/*` | Intake/Planner | per-stage |
| Integration state | **derived from GitHub** | not authored |
| `STATUS.md` (runtime truth) | **Release/Deploy Operator** | single-writer |
| `docs/`, `docs/handoff/*` (briefs + reading-order), arch narrative | Technical Writer | living |
| Security invariants/standards | Security Auditor | living |
| `codebase-map`, Gantt view | Codebase Mapper / Planner | generated on demand |

### 4.7 Gates
- **Walking Skeleton (Stage 0, BLOCKING):** thinnest vertical slice green in CI → built/scanned/digest-pushed → deployed to staging → UI-smoked. Blocks all feature stages.
- **UI-smoke "observably-works" (per staging deploy):** headless browser drives top user flows asserting *behavior*; gates "release verified." (Asset authored by Stage Executor, run by Operator.)
- **Pre-go-live / first-real-data (BLOCKING before real data):** secret rotation, remove throwaway accounts, cross-user isolation, backup coverage for ALL state, security sign-off. (Security Auditor + SRE.)
- **Provisioning (once, before first deploy):** operator runbook + blocked-on-human work-items for cloud/secrets/DNS.

---

## 4b. Runtime & model agnosticism

**Two axes, different answers:**
- **Harness-agnostic** (Claude Code / Codex / OpenCode / Gemini) — *plumbing*. Cleanly solvable.
- **Model-agnostic** (cloud Opus/GPT vs local via **Ollama**, which is a model server behind a harness like OpenCode, not a harness itself) — *quality*. Only partly solvable; be honest.

**Why the harness axis is ~free:** the brain/notebook split means the `verity` engine (git + gh + GitHub API) is deterministic and runtime-independent — ~90% of behavior lives there.

**Three layers:**
1. **Engine = fully agnostic.** **Node CommonJS** (DECIDED — reuse 1.4's CLI scaffolding); host deps = **Node ≥16 + `git` + `gh`**. Every harness drives it via shell, identically. *(Node is a broadly-available host assumption; keep open the option to compile to a standalone binary later if the Node dep limits reach.)*
2. **Roles = portable prompts + per-runtime adapters.** Role content is identical markdown; a **Runtime Adapter** packages it into each harness's format (slash command / skill / custom-instruction; tool-name + arg-placeholder mapping). **1.4's installer ALREADY IS this layer** — it does these exact transforms for Claude/OpenCode/Gemini/Codex; we extend it rather than rebuild.
3. **Optional capabilities = capability registry + documented degradation:**

| Capability | Claude Code | Codex | OpenCode | Gemini | Degradation |
|---|---|---|---|---|---|
| Sub-agents (isolation) | ✅ | ~ | ~ | ✗ | Stage Manager builds **inline** |
| Hooks | ✅ | ✗ | ~ | ✗ | CLI-invoked checks; manual status |
| Headless browser (UI-smoke) | host-dep | host-dep | host-dep | host-dep | UI-smoke → **manual Handoff-Tester step** |
| Image-gen | probed | probed | probed | probed | placeholders/CSS |
| MCP | ✅ | ✅ | ✅ | ~ | feature-specific |

**Model axis (honest):** role quality scales with the model. Each role **declares a reasoning demand** (low/med/high); the framework **warns** when the runtime's model likely can't meet it. Local Ollama models = fine for mechanical roles, risky for judgment roles (architecture, adversarial review). Positioning: *"runs everywhere; quality scales with the model"* — not parity.

**Build order:** agnostic engine (binary) → **Claude Code reference adapter** (richest = exercises every path) → Codex → OpenCode(+Ollama). The framework's own walking skeleton: prove agnostic-core + one adapter before fanning out.

---

## 5. State-derivation engine

**A state transition IS a GitHub act, not a file edit.** State is computed on read.

| Transition | Act (who) | Derived from |
|---|---|---|
| stage planned | `stage-instructions/stage-N-*.md` + work-item issue (Planner) | spec file + issue |
| claimed | assignee + `in-progress` label / draft PR | issue assignee/label |
| building | branch `feat/stage-N-*` / draft PR (Stage Manager) | branch/PR |
| CI green | Actions run | check-runs |
| in-review | PR open + green | PR state |
| merged (built/fixed) | squash-merge `Closes #N` (Reviewer) | PR merged / issue closed |
| released | push tag `vX.Y.Z` (Operator) | tag |
| deployed | GitHub Deployment record (Operator) | Deployments API *(fallback `STATUS.md`)* |
| verified | UI-smoke result (Operator) | deployment status / `STATUS.md` |

- **Two sources:** integration state = **derived from GitHub**; runtime state = **`STATUS.md`** (single-writer Operator).
- **Deterministic `state` CLI**, READ-ONLY w.r.t. state: queries GitHub + reads specs + `STATUS.md` → JSON/projection. `graph next` = `depends-on` × merged-status. No `state update/complete-role/start-role`.
- **Cache allowed, never authoritative** (ephemeral/gitignored, regenerable).
- **Payoffs:** no drift, no state merge-conflicts, no multi-agent write contention. **Limit:** offline = can't freshly derive (issues/CI/Deployments need the API).

---

## 6. The roles

### Arc ① Bootstrap (runs once)

**Vision Assistant** *(new-project on-ramp)* — ideate → **mint + validate + lock the identity manifest** (slug satisfies DNS/registry/package/repo constraints; availability-checked) → **create the repo** → **scaffold** (governance + hygiene CI) via a deterministic command → land the vision doc as first commit, then enable protection. *Owns moment + decisions; calls a deterministic `scaffold`.*

**Architect** — stack + **service topology** (→ CI matrix / image names / envs) · **design-guides-aware** (selects relevant guides, recommends viable alternatives, output is **ADR-shaped**) · **offers the feature catalog** · **freezes core contracts early** · owns the **walking skeleton (Stage 0)** + Layer-2 code scaffold.

**UI/UX Designer** *(optional)* — visual system · **probes image-gen with a real test** (capability registry) · if available, **generates + commits assets** + manifest. Generate-once-and-commit means builders never need image-gen access.

**Retrofit Planner** *(existing-project on-ramp; replaces Vision+Architect)* — analyze code → **reconcile + lock identity manifest** (flag casing/owner/rename inconsistencies) → **extract + freeze contracts** from the running system → **retrofit the spine** (CI/templates/STATUS/handoff/config) → **bootstrap `STATUS.md` from reality** → **"first green on legacy code" gate (BLOCKING)**: existing code green in a real CI env before any feature → emit hardening-first backlog. *The rule that makes the D4 disaster impossible.*

### Arc ② Stream (loops per feature)

**Intake/Planner** *(`/plan`; merged Planner + Feature Manager — the only place stages are born)* — Mode A initial **thin** decomposition; Mode B recurring single-feature intake. Flow: load derived state + architecture/contracts → capture request (issue / handoff brief / user / catalog feature) → **verify against the LIVE codebase** (claim/reality table) → impact + contract-safety analysis → decision (ACCEPT/SPLIT/DEFER/REJECT; arch-touching → confirm-gate + ADR) → write `stage-instructions/` (+ new `contracts/` if a seam) + `feature-assessments/` → register issue + Milestone + intake-claim → hand to Stage Manager. **Mandatory acceptance conditions (work-type-aware):** kill-switch/dark-launch (net-new features), UI-smoke criterion (user-facing), additive-migration-only, suite-stays-green. **On-demand Gantt** (`/plan --gantt`): generated projection; shipped stages on real dates, unshipped in dependency order (no future dates), grouped by Milestone.

**Stage Manager (+ Stage Executor sub-agent)** — orchestrator: load stage context + confirm deps merged → branch off `main` → probe sub-agent capability → delegate to an **isolated Stage Executor** — **spawned fresh per stage, never resumed across stages; lifetime = branch creation → merge; contracts re-read from disk, never recalled** (ADR-0004) — (implements respecting frozen contracts; writes unit/integration/contract tests **+ UI-smoke asset**; adds kill-switch default-off; consumes committed assets; runs tests green; **no branch creation, no merge**; returns only file list/results/deviations) → verify acceptance conditions → **push + open PR** (`Closes #N`) → **drive CI green** → **hand to Reviewer (never merges)**. **Done = green PR.** *Derived-state payoff: independent stages may now parallelize across agents; dependent stages wait for merge.*

**Reviewer/Integrator** *(adversarial to the builder; IS the gate when branch protection is unavailable)* — fresh skeptical context → load PR + acceptance conditions + security checklist + contracts → **confirm CI actually green** → **review against SOURCE not the PR description** (claim→checked→verdict table) → scope/quality (no contract drift, no secrets, additive migration, kill-switch default-off, smoke asset present) → verdict APPROVE / REQUEST-CHANGES / ESCALATE(→`/plan`+ADR) → **merge** (squash + delete-branch, mind the stacked-PR auto-close trap; `Closes #N`; Milestone). Does **not** deploy — merges accrue.

### Verify (per stage/release)

**Project Tester** *(guardian of test honesty)* — owns the test **system**: harness, fixtures, the **CI-like environment** (ephemeral DB, migrate-from-zero, no shared state), cross-cutting test-debt, bug root-cause+fix. Guarantee: the suite runs reproducibly from zero and green means behavior works. Wired at Stage 0.

**Handoff Tester** *(independent eyeball; the role D8 dropped → caused the hotfix treadmill)* — acts as an **adversarial end-user with no source access** (the wall, even single-agent). (1) **Exploratory live testing** → structured issues. (2) **Re-verify-on-live after deploy**. Found failures → issue → fix → **a new scripted UI-smoke check** so it can't regress (exploratory findings become permanent automated coverage).

### Arc ③ Operate (continuous)

**Release/Deploy Operator** *(absorbs 1.4 Deployer; owns `STATUS.md`, the release loop, the UI-smoke gate, rollback, provisioning gate)* — loop: decide release → **pre-flight** (env-available precheck — start if asleep, else blocked-on-human work-item; `main` green; back up env) → **version+tag** (version derived from tag; auto-changelog) → **build/scan/pin** (release.yml builds once + Trivy + emits digests; **auto-pin digests**) → **deploy to staging** → **UI-smoke verify (gate)** → **promote to prod (human confirm-gate by default; config knob)** → flip kill-switch if enabling → **update `STATUS.md`** → failure → **rollback** (re-pin previous digests + redeploy; safe via additive-only migrations). **Continuous CD to staging on every merge; prod = deliberate cut release.**

**SRE** *(steady-state; vs Operator = the deploy act)* — monitoring/alerting + SLOs · recovery/restore **drills** · **backup contract for ALL persistent state** (no silent gaps) · **intermittent-env operations** ("asleep vs incident" runbook; feeds the Operator precheck) · **secret lifecycle/rotation** · incident response + `recovery-plan.md`. On rollback: SRE owns *readiness + the decision*, Operator owns *the mechanism*.

**Security Auditor** *(defines; Reviewer enforces)* — author the **security invariants/standards** (flow to Reviewer per-PR + Planner acceptance conditions) · periodic **deep/whole-system audit** (threat model, CVEs, authz surface) · per-feature consult at intake · **pre-go-live sign-off** · security ADRs.

**Technical Writer** *(the human-readable layer)* — public/dev docs · **handoff briefs** (`docs/handoff/*` with the "settled decisions — do NOT re-litigate" section + the reading-order manifest) · **architecture narrative** (with a "last-verified-against-commit" freshness stamp).

### Cross-cutting

**Codebase Mapper** *(any-time, optional)* — on-demand generated **code-structure** diagram (distinct from the Gantt's plan/schedule); feeds handoff orientation.

---

## 7. Borrowed from 1.4 vs new

- **Borrowed (concepts):** brain/notebook split, role sequencing, sequential isolated Stage Executor delegation, retrofit on-ramp, the deterministic CLI pattern, contracts/stage-instructions/feature-assessment discipline, recommend-not-mandate guides.
- **New / changed:** derived state (no STATE.md); GitHub-native substrate; CI/CD-as-spine + progressive gate; walking-skeleton & UI-smoke & pre-go-live gates; Reviewer/Integrator; Release/Deploy Operator (absorbs Deployer); merged Intake/Planner; feature catalog; capability registry; identity manifest; "done = green & observably works"; stream-of-stages macro-model; multi-agent as emergent.

## 9. CLI surface (the deterministic "notebook" layer)

Binary name **`verity`**. Style inherited from 1.4 sdd-tools: `flow <noun> <verb> [args] [--flags]`, JSON by default + `--raw`, `--cwd`, large output → tempfile, exit 0/1. Wraps `gh` (must be authenticated) for all GitHub reads/acts; derive-commands hit the GitHub API and may cache.

**Three command classes — and the hard rule: the CLI NEVER writes integration state.**
- **DERIVE** (read-only): compute state projections from GitHub + specs + `STATUS.md`.
- **ACT**: perform framework-*conventional* GitHub operations (consistent branch/PR/claim/tag mechanics) — these are the state *transitions*.
- **AUTHOR**: write the few legitimately-writable artifacts (specs, `STATUS.md`, capability registry, identity manifest, config, generated views). Never a state file.

### `state` — DERIVE (read-only; replaces 1.4 state load/get/snapshot + graph)
| Command | Returns | Used by |
|---|---|---|
| `state view` | full projection: every stage + status (planned→building→in-review→merged→released→deployed→verified) + current release + what's live | all |
| `state stage <id>` | one stage's derived status (branch/PR/CI/merged/deployed/verified) | Stage Mgr, Reviewer |
| `state next` | unblocked stages (`depends-on` × merged-status) | Planner, Stage Mgr |
| `state graph` | the dependency DAG (from stage-instructions) | Planner, `view gantt` |
| `state summary` | one-line human progress (for hooks/status-line) | hooks |
*All accept `--refresh` (bypass cache). No `update`/`complete-role`/`start-role` — gone; the act is the transition.*

### `next` — DERIVE (autonomy dispatch decision; autonomy sketch §3.1)
| Command | Returns | Used by |
|---|---|---|
| `next` | ONE decision object `{schema:1, action: work\|gated\|idle, role, args, gate, target, reason}` derived from the ledger + the `verity:awaiting-approval`/`verity:approved` labels; exit `10` when gated, else `0` (never nonzero for "no work") | worker, humans |
| `next --json` | same object, compact, exactly one line on stdout (pipe-safe: `verity next --json \| jq -e '.schema==1'`) | worker run loop |

### `stage` — ACT/AUTHOR (work-item lifecycle)
| Command | Does | Class |
|---|---|---|
| `stage new <slug> [--depends-on …] [--type bug\|feature\|chore]` | author `stage-instructions/stage-N-<slug>.md` from template + open work-item issue + link Milestone | AUTHOR+ACT |
| `stage claim <id>` | assignee + `in-progress` label (or draft PR) — intake-time claim | ACT |
| `stage branch <id>` | create `feat/stage-N-<slug>` off `main` | ACT |
| `stage pr <id>` | open PR with conventional body (acceptance checklist + `Closes #N`) | ACT |

### `review` — ACT (Reviewer/Integrator)
| Command | Does |
|---|---|
| `review checklist <pr>` | emit the pre-declared checklist (stage acceptance conditions + Security invariants + touched contracts) the reviewer verifies against source |
| `review merge <pr>` | **refuse if CI not green**; squash + delete-branch (stacked-PR guard) + `Closes #N` + Milestone |
*(The review judgment — verify-against-source — is brain work; the CLI supplies the checklist + does the merge mechanics + the green-precondition.)*

### `release` / `deploy` — ACT/AUTHOR (Release/Deploy Operator)
| Command | Does |
|---|---|
| `release cut [--bump major\|minor\|patch]` | version derived from tags → bump → changelog from Conventional Commits → push tag (triggers `release.yml`) |
| `release digests <tag>` | read digests emitted by the release run (for pinning) |
| `release pin <env> <digests>` | auto-pin digests into the env file (kills the manual copy-paste seam) |
| `release rollback <env>` | re-pin previous digests + redeploy |
| `deploy precheck <env>` | env-available check (reachable? asleep? → suggests start / emits blocked-on-human) |
| `deploy run <env>` | invoke the project's `deploy.sh` (project-owned) + then `deploy record` |
| `deploy record <env> <tag> <status>` | create a GitHub **Deployment** record (the derive-source for deploy state) |
*(Container deploy logic lives in the project's generated `deploy.sh`; the CLI owns precheck, pinning, deployment-records, tag/changelog.)*

### `status` — AUTHOR/DERIVE (`STATUS.md`, single-writer = Operator)
| Command | Does |
|---|---|
| `status show` | read the schema'd runtime-truth artifact |
| `status update <fields>` | structured write (version, digest, rollback breadcrumb, secret *locations*, caveats) |

### `identity` — AUTHOR (Vision/Retrofit) · `scaffold` — AUTHOR · `capability` — AUTHOR/probe
| Command | Does |
|---|---|
| `identity check <slug>` | validate slug vs union constraints + availability (`gh repo`, package registry) |
| `identity lock <fields>` | validate + write the immutable manifest |
| `identity get [field]` | read |
| `scaffold init` | create repo + lay governance + hygiene CI from the manifest (greenfield) |
| `scaffold spine` | add missing spine onto existing code (Retrofit) |
| `scaffold feature <id>` | expand a catalog feature's recipe → stage-instructions |
| `capability probe <name>` | run a REAL test (image-gen/sub-agents…) + record verified flag |
| `capability get <name>` / `capability list` | read |

### `view` — AUTHOR (generated projections, on demand)
| Command | Does |
|---|---|
| `view gantt` | generate Gantt (Mermaid/HTML): shipped stages on real dates, unshipped in dependency order, grouped by Milestone |

### carried from 1.4
`config get/set/ensure` · `slug <text>` · `timestamp` · `verify-path`.

**Gone from 1.4:** `state update`, `state complete-role`, `state start-role`, `state record-session` — all replaced by GitHub acts that the DERIVE layer reads back.

---

## 8. Resolved decisions (2026-06-07)
- Branch convention = **`feat/stage-N-<slug>`** (conventional-commits prefixes).
- Reviewer ESCALATE with contract change → **always round-trips `/plan`** (single-sourced contracts + ADR).
- Handoff-found user-facing failure → Planner **auto-attaches a regression-smoke** acceptance condition.
- SRE = **standing/on-demand + a periodic scheduled ops-health pass** (rotation/backup audit/drill).
- Retrofit first-green failures → **emitted as hardening stages** (all change on the one rail).
- CLI binary = **`verity`**; package = **`verity-framework`**.

- Engine = **Node CommonJS**, reusing 1.4's CLI + installer scaffolding (installer = the Runtime Adapter layer). Host deps: Node≥16 + git + gh.
- Build order = **agnostic engine + Claude Code reference adapter first** → Codex → OpenCode(+Ollama). Roles declare a reasoning-demand; framework warns on model mismatch.

### Still open — implementation phase
- Exact `verity` CLI JSON shapes per command.
- GitHub Deployments API availability on free-tier private repos (preferred deploy-event source; `STATUS.md` fallback).
- First implementation slice (fittingly: Verity's own walking skeleton).
