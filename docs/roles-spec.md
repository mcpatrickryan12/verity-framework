# Clean-room SDD successor — roles spec (working doc)

> Living design doc. We talk through each role; locked decisions land here.
> Framework is a **clean-room build** that borrows concepts from SDD 1.4.
> Pillars: **GitHub-native** · **CI/CD as the spine** · **beyond-MVP / production lifecycle** · multi-agent collaboration emergent from PR+CI.

---

## ROLE MAP v2 (re-drawn 2026-06-07, post-interview)

**Macro-model = three arcs, not a one-pass line:**
```
 ① ONE-PASS BOOTSTRAP          ②  LOOPING STREAM (per feature)        ③ CONTINUOUS OPERATE
 Vision / Retrofit                 ┌───────────────────────────────┐    Release/Deploy Operator
   → Architect (freeze            │ intake/assess → build → CI →   │    SRE · Security · Tech Writer
     contracts) → Designer        │ review → merge → release →     │    pre-go-live gate
   → WALKING SKELETON (Stage 0)   │ deploy → UI-smoke VERIFY →     │
   [green+deployed+smoked or      │ STATUS update                  │
    features are blocked]         └──────────────▲────────┬────────┘
                                  └─────── loop ──────────┘
 ALWAYS-ON SUBSTRATE: CI/CD spine · GitHub (Issues/PRs/tags/Milestones) · DERIVED state ·
                      STATUS.md · capability registry · contracts · ADRs
 HUMAN/OPERATOR GATE: once before Stage 0 (provision) + "env available?" before every deploy
```
Only arc ① is linear and runs once. Arc ② is the bulk (feature-stage loop over a constant pipeline). Arc ③ runs continuously alongside ②.

**Roster (tags: carried / changed / NEW / absorbed):**
- **① Bootstrap:** Vision Assistant `[carried+]` · Retrofit Planner `[changed → retrofit the SPINE onto existing code]` · Architect `[carried+ → freeze contracts + own Stage-0 skeleton]` · UI/UX Designer `[carried+, optional]` · *Gate:* Walking Skeleton `[NEW]`
- **② Stream:** Feature Manager `[changed → loop's front door]` · Project Planner `[changed]` · Stage Manager (+Executor) `[changed → done = PR + CI green]` · Reviewer/Integrator `[NEW → security+contract review, owns merge]` · Merge Manager `[changed → de-emphasized by derive-state]` · Project Tester `[carried → CI tiers]`
- **Verify:** Handoff Tester `[changed → independent eyeball + re-verify-on-live, even single-agent]` · *Gate:* UI-Smoke verification `[NEW]`
- **③ Operate:** Release/Deploy Operator `[NEW → absorbs 1.4 Deployer; owns tag→digest→deploy→verify→STATUS]` · SRE `[carried]` · Security Auditor `[carried+, elevated]` · Technical Writer `[changed+ → docs + handoff briefs + arch narrative]` · *Gate:* Pre-go-live/first-real-data `[NEW]`
- **Cross-cutting:** Codebase Mapper `[carried, any-time]` · Operator (human) — not a role; assignee of blocked-on-human work-items

**Overlaps — LOCKED (2026-06-07):**
1. **Planner + Feature Manager → MERGED into one "Intake/Planner"** that runs at the head of every stage. First run emits the initial backlog (many stages); later runs assess one request → one (or a few) stages. Same artifacts, same assessment shape. **The only place stages are born.**
2. **Reviewer/Integrator → distinct role, NOT a hat.** Structurally adversarial to the builder (same logic as the tester wall, H4): the builder never reviews their own merge. Owns security-invariant + contract-conformance review + the merge decision.
3. **Release/Deploy Operator vs SRE → split.** Operator = the deploy act + release loop (tag→build→digest→deploy→verify→STATUS), absorbs 1.4's Project Deployer. SRE = steady-state health/monitoring/rollback-drills/intermittent-env.
4. **Artifact ownership → LOCKED:** `STATUS.md` → Release/Deploy Operator; handoff briefs + arch narrative → Technical Writer; ADRs → each role at decision time; specs (stage-instructions + contracts + assessments) → Intake/Planner.

---

## Cross-cutting asset — Standard feature catalog (drop-in features)
- **Definition:** a drop-in feature = a pre-packaged **stage-set** + the **architectural prerequisites** it imposes. *Offered, not mandated* (same philosophy as design guides).
- **Location:** `design-guides/features/` (sibling to the guides). Ships **sample specs**; org overrides/extends via config (bring-your-own, same model as guides). A **catalog index** lists available features; **one spec file per feature**.
- **Feature-spec schema** (prototype = `helper-bot-feat.md`):
  - `id/slug`, one-line description
  - **applicability + prerequisites** (stack assumptions, what must already exist)
  - **architectural requirements** it forces (→ become ADRs)
  - **stages injected** — a **new-app recipe** AND a **retrofit recipe** (helper-bot already splits these)
  - **conflicts / deps** with other features
  - **config knobs**
- **"Drop-in" = recipe, not copy-paste code.** The build implements the spec per chosen stack (logging/UI/cron differ by stack). Shipping actual per-stack code templates is a possible *future*, heavier lift. **LOCKED: recipe-only to start** (code templates a possible future).
- **Plug-in points (NOT a new role):** Architect **surfaces the catalog** (architecture-time) → chosen features' requirements → architecture doc/ADRs; their stages → **Planner's** stage list; **Stage Manager** builds them like any stage.
- **Feature #1 = helper bot** (`helper-bot-feat.md`). It is an *application* feature, not a framework-coordination agent.

## Interview-driven additions to the role roster (2026-06-07)
Forensic interview of the real build (Switchboard) added these to the design. Detail in `flow-interview-questions.md`.
- **Stage 0 — Walking Skeleton gate (MANDATORY, blocks all feature stages).** Thinnest vertical slice green in CI → built/scanned/digest-pushed → deployed to staging → **UI smoke** passes. Proves the whole spine before any feature exists (C3/N5; the #1 lesson).
- **Verification / "observably-works" gate (highest-leverage new gate, N2).** A post-deploy **headless-browser UI smoke** of top user flows asserting *behavior* — distinct from CI and from `/health`. Every "done-but-broken" hotfix passed CI+health; the unguarded surface is "does the thing a user clicks actually work." Gate "release verified" on it.
- **Release/Deploy Operator role (biggest MISSING role, L4).** Owns the recurring loop: version-bump → tag → `release.yml` build/scan/digest → re-pin env digests → `deploy.sh` → `verify_deploy.sh` + UI smoke → update `STATUS.md`. Ran 18× unowned. Straddles 1.4's Deployer+SRE; make it first-class. Prefer **version derived from tag** + **auto-changelog from Conventional Commits** (E2: version.py lied for many releases).
- **Operator gates in exactly two places (J3), never in the build loop:** (1) a one-time **provisioning gate before Stage 0**; (2) a recurring **"environment available?" precheck at the head of every deploy** (intermittent env — VMs off nightly — is a NORMAL state). Model **blocked-on-human as a first-class work-item** with an explicit unblock signal (J2), not a synchronous chat wait.
- **Pre-go-live / first-real-data gate (N6).** Forces resolving the "fine for now" list before real data: secret rotation, throwaway-admin removal, cross-user visibility, backup coverage for non-DB volumes.
- **`STATUS.md` as a schema'd runtime-truth artifact with an owner (D6/G3).** Holds: live version+digest, rollback breadcrumb, topology/addresses, **secret LOCATIONS (never values — "a map to secrets")**, nightly-shutdown, coordination notes. Owned by the Release/Deploy Operator, updated every deploy.
- **Issue/work-item types (I5) + intake-time claiming (I2, genuine OPEN gap).** Separate templates for `bug` / `feature` / `chore-techdebt` (repro vs acceptance-criteria vs exit-state). `correlation_id` = the highest-value field (cross-service trace); `filed_by` = provenance. Add an intake-time **claim** (assignee + `in-progress` label, or auto-draft-PR) for true concurrent fixing — never existed; duplicate-work was avoided only structurally. Use **Milestones-per-release** for traceability (I4).
- **Handoff brief pattern (H1/H6):** prose-for-a-cold-reader in `docs/handoff/`, with a **"settled decisions — do NOT re-litigate" section** (highest-leverage element) + a **reading-order manifest** (what made zero-setup rejoin real).
- **Helper-bot catalog entry = the PATTERN (M1):** "help = restricted mode of the main chat loop, isolated by a separate tool registry" + baked `git archive` source snapshot + caller-scoped non-widenable log reads + draft-then-confirm external action + read/append FAQ. Parameterized by log schema + repo.
- **Other catalog-worthy features (M3), ranked:** CI/CD spine, structured+redacted logging w/ `correlation_id`, helper-bot, auth/role ladder, per-user token budgeting, frozen-contract sub-agent template.

## Cross-cutting principles (carried from 1.4 + the divergences log)
- **Brain vs Notebook split:** the LLM (role) decides; a deterministic CLI lays down files / talks to GitHub. Reliability lives in the deterministic layer.
- **Capability registry:** roles **probe runtime capabilities with a real test** (availability ≠ works — the D4 lesson) and record verified flags in state; later roles read them deterministically (don't re-probe). Instances so far: image-gen (Designer), sub-agent/Task support (Stage Manager). Treat as a shared mechanism, not one-off checks.
- **The slug is the identity key.** Threaded through repo name, package name, GHCR image path, branch names, CI workflow/job names, environment names, DNS, secret-naming. Locked once, immutable after (rename = migration).
- **"Done" = CI green** (D4). A pipeline that's green only because it's empty is a lie — scaffolded CI must be minimal-but-honest.
- **CI is a gate, not just tests; it accretes.** Separate *CI-the-gate* (runs whatever is meaningful now) from *tests* (one check, needs a testable service). Gate is born early as a **hygiene gate** (secret-scan/gitleaks, lint/format, build, dep-pinning + lockfile integrity — all honestly green on a near-empty repo), gains a **test gate** at the walking skeleton, gains a **deploy gate** at deploy. Branch-protection required-checks list grows in lockstep.
  - **Why not "no CI until a working service":** that overshoots into the D4 failure — unexercised work piles up and the first CI run is a big-bang surprise. Continuous hygiene CI keeps failures incremental.
- **Walking skeleton** = thinnest end-to-end slice that compiles, runs, has one real passing test, goes green through CI, and deploys. Explicit early deliverable (Architect / first stage). It's the moment the **test gate turns on** and the spine is *proven*, not assumed.

### CI/CD timeline
1. Vision/scaffold → governance + **hygiene CI** (honest-green).
2. Architect → **walking skeleton** → **test gate** on; protection requires it.
3. Stages → ride the proven pipeline; "done = green."
4. Deploy → **CD/deploy gate** added.
- **PR + CI is the integration spine** (D3). Direct-to-main only for the very first bootstrap commit, before branch protection is enabled.
- **State is DERIVED from GitHub, not a committed mutable file. [RESOLVED by interview G4/G5.]** SDD "state" (what's built/fixed/released) = a projection computed at read time from merged PRs / closed issues / tags / CI status. Evidence: `STATE.md` rotted to "Design, 44%" while prod shipped 18 releases; it was also the *sole* source of every merge conflict (G1/H3). Committed files survive ONLY for: (a) **runtime/ops truth** (`STATUS.md`), (b) **specs/intent** (stage-instructions, contracts, feature-assessments, ADRs). This kills drift AND the state-merge-conflict problem at once.
- **Macro-model = a STREAM of self-contained feature-stages over an always-on CI/CD substrate** — NOT a one-pass linear pipeline (interview L1: deploy interleaved with build across 18 deploys; test↔fix↔deploy looped). Linear order holds only *within* one feature-stage. The engine models "a loop of feature-stages riding a constant pipeline," not 1.4's terminal-deploy graph.
- **The integration gate must degrade gracefully.** Branch protection may be **unavailable** (private free-tier paywall — interview B5/D3). Fallback floor = honor-system merge discipline + **CI on push-to-main** (so even a bypassed merge gets a post-hoc signal). Never assume the platform enforces the gate.
- **Identity manifest, locked at vision time** (interview B1c/N5): one immutable record fixing `{repo, lowercase-canonical slug, image-prefix, registry-owner, dns, env names, secret names}`. Decide **registry-owner ↔ git-auth identity on day one** (the GHCR-owner-vs-`gh`-auth papercut). Watch the **casing trap** (GHCR requires lowercase); partial renames leave inconsistency debt (B2).
- **Two-tier mandate model** (interview M4): **contracts are MANDATES** (wire/JWT/schema — breaking them breaks others), **guides are RECOMMENDATIONS** (deviate with a logged reason). **Every deviation is an ADR** (separate append-only file — the divergences log proves it). Freeze the core contract early; iteration = *additive contract-compatible stages* (L5: frozen `subagent_contract/v1` never broke across 15 stages).
- **Role separation is valuable even within ONE agent** (interview H4/N3): "now act purely as an adversarial end-user who cannot see/edit the code" as an enforced *phase*. Don't tie role separation to machine separation — losing the independent tester eyeball (D8) caused the hotfix treadmill.
- **Dark-launch / kill-switch is standard discipline** (interview E4): net-new features ship behind a default-off env flag; flipping = redeploy. Feature-Manager intake *requires* a kill-switch as an acceptance condition.
- **Additive-only migrations** (interview F4/L5) are what make digest rollback safe (re-pin previous digests + re-run deploy; back up env before every deploy).

---

## Role 1 — Vision Assistant

**Inherited from 1.4:** collaboratively iron out the fuzzy idea into a clear spec.

**New responsibilities (this framework):**
1. **Mint identity:** decide a **display name** + **slug**.
   - Validate slug against the *union* of downstream constraints (lowercase, hyphen-separated, starts with a letter, no underscores, ≤ ~63 chars — DNS / container registry / package registry / repo-name safe).
   - **Availability check:** `gh repo view`, `npm view <slug>` (or stack registry), optional DNS check — surface conflicts before anyone builds.
   - **Lock** name + slug as canonical identity; rest of pipeline reads it, never re-derives. Changing later is a migration.
2. **Create the GitHub repo** (visibility from vision: public/private).
3. **Scaffold** the repo (see two-layer split below).
4. **Land the vision doc as the first commit**, then enable branch protection.

**Produces:** vision document (incl. locked name + slug + identity block).

**Two-layer scaffold (KEY DECISION):**
- **Layer 1 — process/governance scaffold (now, stack-agnostic):** README stub, LICENSE, .gitignore, CODEOWNERS, PR template, `.github/ISSUE_TEMPLATE/` bug-report form (the D2 defect channel, born day one), CI workflow *skeleton* (honest-green on empty repo), framework state/config dir (committed, holds locked identity), STATUS.md stub (D6).
- **Layer 2 — application/code scaffold (later, stack-dependent):** language/framework, directory layout, build tooling, real CI steps. **Deferred to the Architect** (or a dedicated scaffold step) once the stack is chosen.

**Gotchas flagged:**
- *CI timing:* Layer-1 scaffold ships only the **hygiene CI** (honest-green); the **test gate** arrives with the walking skeleton, not at scaffold. See CI/CD timeline above. **LOCKED: (a) progressive gate.**
- *Branch-protection ordering:* create repo → push initial scaffold+vision commit directly → THEN enable "require PR + green CI". Otherwise the first commit has nowhere to land.
- *Reliability:* the LLM decides identity; a deterministic `init/scaffold` command performs repo creation + file layout (brain/notebook split).

**LOCKED:**
- Vision *owns* the moment + decisions; calls a deterministic `scaffold`/`init` command to create the repo + lay files (reusable; brain/notebook split).
- CI: (a) progressive gate. Layer-1 scaffold = governance + hygiene CI only.

**Still open (revisit):** exact vision↔architect line for non-functionals (public/private decided at vision since repo is created here; scale/SLA likely architect).

---

## Role 2 — Architect

**Inherited from 1.4:** design the architecture + choose the tech stack.

**New responsibilities (this framework):**
1. **Service topology** — decide how many services (monolith / modular-monolith / multi-service). Feeds the CI build matrix, GHCR image names (`ghcr.io/<owner>/<slug>-<service>`), deploy targets, environments. Slug convention from Vision extends per-service.
2. **Design-guides–aware (recommend, NOT mandate):**
   - Framework ships **sample guides** in `design-guides/` (markdown + frontmatter: `topic`, `stack`, `applies-to`). Org can point at its own library via config (bring-your-own-guides).
   - Architect **selects relevant** guides (not dump-all); graduates to a retrieval index if the library grows large.
   - Reviews guides as context but **proposes viable alternatives**. Output is **ADR-shaped**: per major choice → *guide recommendation → alternatives → chosen + why*. (Same divergence-with-rationale discipline as this whole effort.)
3. **Walking skeleton + Layer-2 code scaffold** (from Role 1 handoff): thinnest end-to-end slice across the chosen topology (one service + real pipeline) that compiles, runs, has one real passing test, goes green in CI, deploys. This flips the **test gate** on.
4. **ALWAYS ASK: "Bake the help agent into this app?"** (an **application feature** — see `helper-bot-feat.md`). NOTE: this is a product capability shipped *in the built app*, NOT a participant in the framework's own agent/coordination layer.
   - It's a real architectural fork (invasive), not a late toggle — hence asked here.
   - **App-level synergies (not framework coordination):**
     - The app's help agent reads `docs/architecture.md` **at runtime** — same doc the Architect generates → that doc does double duty (planning artifact + shipped runtime dependency) and must stay current *within the app* (Technical Writer + optional CI drift check). Opting in buys this maintenance contract.
     - The help agent files issues into **the app's own repo** → reuses the repo's issue templates/labels. Convenience, not coordination.
   - If **in:** its build-steps become stages the Project Planner picks up — structured JSON logs (`logs/app.log`) → arch-doc contract (`docs/architecture.md`) → help UI (`?` separate window) → agent wiring (inject log tail + arch doc) → GitHub issue-draft hook → FAQ batch cron (`docs/faq.md`). If **out:** skipped cleanly.

**Produces:** architecture doc / project-plan (ADR-structured), deploy instructions, walking skeleton, helper-bot decision.

**RESOLVED by interview:**
- **ADRs = separate append-only files** (`docs/adr/NNNN-*.md`). The divergences log proves the pattern (M4).
- **Helper-bot freshness:** ground it on a **baked source snapshot** (`git archive HEAD`, refreshed each deploy), NOT a prose arch-doc → freshness is a build property (M2). If a prose arch-doc is used anywhere, give it a "last-verified-against-commit" stamp / CI check.
- **Architect must own contract-freezing early** + the walking skeleton (Stage 0). Iteration after = additive contract-compatible stages only.

**OPEN for this role:**
- Guide config mechanism (path/env to org library) + standard guide frontmatter schema — confirm.

---

## Role 3 — UI/UX Designer

**Inherited from 1.4:** define the visual/design system (`design-system.md`). Optional role.

**New responsibilities (this framework):**
1. **Probe image-gen capability with a REAL test** — attempt a throwaway generation against whatever the runtime exposes (nano-banana / Leonardo / pixellab / any plugin or MCP; tool-agnostic). Record verified result in the **capability registry**: available? which tool? formats/constraints?
2. **If available:** generate real assets and **commit them** (hero/icons/illustrations) into an assets dir + an **asset manifest** referenced by `design-system.md`.
3. Capability flag is read **downstream by the Planner** (deterministic; no re-probe).

**Produces:** `design-system.md`, committed image assets + manifest (if image-gen available), image-gen capability flag.

**Key consequence — generate-once-and-commit decouples from per-machine capability:** because images are committed artifacts, a *builder* (or rejoining agent) never needs image-gen access; it just consumes what's in the repo. Resolves multi-machine capability variance for free.

**Downstream (Planner):** if images exist → inject instructions for stages to **consume the committed images** (placement, HTML refs); else → placeholders/CSS fallback.

---

## Role 4 — Intake/Planner (merged Planner + Feature Manager)

**The only place stages are born.** Runs in two modes, same assessment shape + same artifacts:
- **Mode A — Initial decomposition** (once, after Stage-0 skeleton is green): decompose vision+architecture into the initial backlog of feature-stages, dependency-ordered.
- **Mode B — Single-feature intake** (recurring, the stream's front door): one request (GitHub feature-issue / handoff brief / user ask / catalog feature) → assess → emit one or a few stages.

**Inputs:** architecture doc + ADRs + **frozen contracts**; vision/identity manifest; design-system + image-gen capability flag; selected **catalog feature recipes**; **DERIVED state from GitHub** (what stages/PRs/issues/tags already exist); for Mode B, the request itself.

**Flow (brain = LLM judgment · notebook = deterministic CLI):**
1. **Load context** *(notebook)* — pull derived GitHub state + read architecture/ADRs/contracts/existing stage-instructions/catalog.
2. **Capture the request** *(notebook)* — from a feature-issue, `docs/handoff/*` brief, or user ask; if a catalog feature, load its recipe (prereqs + new-app/retrofit stage variant).
3. **Verify against the LIVE codebase** *(brain, MANDATORY anti-hallucination step)* — claim/reality table: do the request's assumptions hold against actual source? Flag mismatches before planning. (Interview L2 — the step that stops building on false premises.)
4. **Impact + contract-safety analysis** *(brain)* — which existing stages/files/contracts are touched; does it need a NEW contract or threaten a frozen one? **Default additive.** Scope/complexity + risk table.
5. **Decision** *(brain; gated)* — ACCEPT as Stage N / SPLIT / DEFER / REJECT. Architecture-affecting or contract-touching → **confirm gate (architect/human) + write an ADR**.
6. **Write the spec** *(brain+notebook)* — emit `stage-instructions/stage-N-instruct.md`: objectives · what to build · interface contracts (exposes/consumes) · testing requirements · **acceptance conditions** · **depends-on** (for ordering). Emit a new `contracts/contract-*.md` if a new seam. Emit the reasoning as `feature-assessments/*` (and an ADR if architectural).
7. **Register the work-item** *(notebook)* — create/link the GitHub feature-issue, attach **Milestone-per-release**, wire traceability (issue ↔ stage ↔ future PR), apply **intake-time claim** if multi-agent.
8. **Hand to Stage Manager** — stage instruction + contracts + branch name.

(Mode A = run steps 3–7 as a batch over the architecture, producing the dependency-ordered backlog; Stage 0 / walking skeleton is already Architect-owned.)

**MANDATORY acceptance conditions baked into every applicable stage spec (work-type-aware):**
- **Kill-switch / dark-launch** for net-new user-facing features (E4). *(Not for bug/chore.)*
- **UI-smoke / observably-works** criterion for anything user-facing (N2 — the #1 unguarded gap).
- **Additive migration only**; **existing suite stays green**; **CI all-green**.
- Work-type drives the shape: `feature` (acceptance criteria + kill-switch + UI-smoke), `bug` (repro + regression test), `chore/tech-debt` (exit-state). Ties to the per-type issue templates (I5).

**Principles:** reads DERIVED state, writes only **intent** (specs/contracts/assessments — durable), never mutable progress. Contracts additive-only; new seam → new contract; never reopen a frozen one. Consumes the feature catalog at intake-time too (not just architect-time).

**Produces:** `stage-instructions/stage-N-instruct.md`, `contracts/contract-*.md` (when a new seam), `feature-assessments/*`, linked GitHub feature-issue + Milestone.

**LOCKED:** command = **`/plan`**. Mode A emits a **thin initial backlog**, then **continuous re-intake** as the project learns (NOT a big upfront plan — interview L5).

**Gantt / plan view — ON DEMAND (`/plan --gantt`):**
- **Generated, read-time projection — never hand-maintained** (else it rots like STATE.md). Computed from: stage backlog + `depends-on` edges + **derived GitHub state** (done/in-progress/blocked) + **Milestones** (release per stage).
- **Actual dates only:** each **shipped** stage shows its real inclusion date/time (PR-merge / tag timestamp). Unshipped stages are listed in **dependency order with NO dates** (no future/planning dates anywhere). Grouped by Milestone.
- **Rendering:** Mermaid committed to markdown (dependency graph always; `gantt` for the dated/historical view — renders natively in GitHub); optional standalone interactive HTML for large projects.
- **Owner/trigger:** Planner-owned, on-demand only (distinct from Codebase Mapper, which visualizes code structure). Planner may *suggest* it once the backlog crosses a size threshold.

---

## Role 5 — Stage Manager (orchestrator) + Stage Executor (sub-agent)

**Inherited from 1.4 (shipped in 1.4.0):** orchestrator reads a stage instruction, creates the branch, delegates the build to ONE isolated sub-agent (own context window), verifies the return. Sequential.

**Executor lifetime = ONE STAGE (ADR-0004).** "Isolated, own context window" is *not* satisfied by a long-lived executor resumed stage after stage. The executor is **born at branch creation and dies at merge**: spawned fresh per stage, resumable without restriction *within* its own stage (red-CI loop, acceptance kick-back, a Reviewer's REQUEST-CHANGES), never across a stage boundary. Rationale: a resumed executor recalls contracts as they were N stages ago — unversioned memory defeating the frozen-contract discipline — and its context grows quadratically over the backlog. Everything it would retain is on disk and re-passed at spawn. **Contracts are re-read from `contracts/`, never recalled.** The inline fallback (no sub-agent support) inherits the same obligation: re-read contracts and standards per stage rather than trust what is already in the conversation.

**Changed for this framework:**
1. **"Done" = PR opened + CI all-green**, NOT merge-to-main. The Stage Manager **never merges** — it stops at a green PR and hands to the **Reviewer/Integrator** (adversarial separation: builder doesn't merge own work).
2. **Honors the Planner's baked-in acceptance conditions** per stage spec: kill-switch/dark-launch (features), UI-smoke test authored (user-facing), additive-migration-only, existing-suite-green, contract conformance.
3. **Contract-additive discipline:** executor respects frozen contracts; a needed new seam means the Planner should already have issued a new contract — the executor does NOT invent contract changes (flags back to Planner if one is needed).
4. **Writes code + intent, never progress** — the PR + CI run IS the signal; no state-file write (derived state).

**Flow (orchestrator = brain+notebook · executor = isolated sub-agent):**
1. **Load stage context** *(notebook)* — stage-instruction + relevant contracts + cross-cutting standards (architecture/ADRs) + design-system/committed assets + acceptance conditions. Confirm `depends-on` stages are merged (derived state) before starting.
2. **Create branch** *(notebook)* — `feat/stage-N-<slug>` off current `main` (includes all merged prior stages).
3. **Probe capability** *(notebook)* — sub-agent/Task support (capability registry)? yes → delegate; no → inline (1.4 fallback).
4. **Delegate to Stage Executor** *(isolated sub-agent, **spawned fresh for this stage** — ADR-0004)* — pass stage instruction + contracts + standards + branch name + acceptance conditions + executor rules. Executor:
   - implements code respecting **frozen contracts**;
   - writes unit/integration/contract tests **+ the UI-smoke test asset** if user-facing;
   - implements the **kill-switch flag (default off)** if a net-new feature;
   - consumes committed image assets if the image-gen flag is set;
   - runs tests locally to green;
   - works ONLY on the given branch — **no branch creation, no merge**;
   - returns ONLY: files changed, test results, deviations, "new contract needed?" (should be none), kill-switch name. **Never pastes file contents.**
5. **Verify the return** *(orchestrator)* — outputs exist, tests pass, acceptance conditions met (kill-switch present for features, smoke test authored, additive migration, contracts untouched). Breach/deviation → stop; kick back to executor or re-intake via Planner.
6. **Push branch + open PR** *(notebook)* — PR body = change summary + acceptance-condition checklist + `Closes #<issue>`. CI runs the full gate on the PR.
7. **Drive CI to green** *(notebook/derived)* — red → **this stage's** executor fixes on the branch (loop; resuming within the stage is correct). **Done = PR open + CI all-green.**
8. **Hand to Reviewer/Integrator** — does NOT merge.

**Concurrency payoff of derived state:** 1.4 was strictly sequential to avoid `STATE.md` conflicts; with state derived (no committed state file), **independent stages MAY parallelize across agents** (separate branches → separate PRs). **Dependent** stages still wait for the prerequisite's merge. Sequential remains the safe default; parallel is now *available* because the contended artifact is gone.

**Produces:** source + tests + UI-smoke asset on a branch; a green PR linked to its issue. (No state-file writes.)

**LOCKED:** branch convention = **`feat/stage-N-<slug>`** (conventional-commits-aligned: `feat/`/`fix/`/`chore/`). *(Single-agent review handoff resolved in Role 6: same agent, fresh skeptical sub-agent context, immediately.)*

---

## Role 6 — Reviewer/Integrator (NEW)

**Why it exists:** the per-PR gate, structurally **adversarial to the builder** (the builder never merges its own work — H4). With branch protection often **unavailable** (free-tier paywall, B5/D3), **the Reviewer's approval + confirmed-green CI IS the integration gate** — it's load-bearing, not ceremonial. Models the D9 review (this machine verified every security invariant *against source* before merging PR #51).

**Headline principle — verify against SOURCE, not the PR description.** The PR body's claims are hypotheses to check against the actual diff/code, never facts to trust. This is the single most important behavior (straight from D9).

**The checklist is pre-declared, not invented.** What the Reviewer verifies = the acceptance conditions the Planner baked into the stage spec + the **security invariants defined by the Security Auditor** (see boundary below) + the frozen contracts. Three-way loop: **Planner declares → Executor builds → Reviewer verifies the same list.**

**Boundary vs Security Auditor (resolves overlap #2):** Security Auditor *defines* the security invariants/standards + does periodic deep/whole-system audits (threat model, CVEs, pre-go-live). Reviewer/Integrator *enforces* those invariants on **every PR at merge**. Per-PR enforcement here; deep/periodic audit there.

**Boundary vs Tester:** Tester = "does it *work*" (tests pass, in CI). Reviewer = "is it *correct/safe/in-contract*" (verify against source) + owns the merge.

**Flow (fresh skeptical context · brain+notebook):**
1. **Load PR context** *(notebook)* — the green PR + its stage-instruction/acceptance conditions + the declared security checklist + touched contracts + derived state (is the base still current?).
2. **Confirm CI is actually green** *(notebook)* — the all-green floor; if not, bounce back.
3. **Adversarial review against source** *(brain, skeptical)* — for each acceptance condition + security invariant + contract, verify against the real diff (not the PR text). Build a verdict table: claim → checked-against-source → pass/fail.
4. **Scope/quality check** *(brain)* — stayed within the stage; no contract drift; no secrets committed; migration additive; kill-switch default-off; UI-smoke asset present.
5. **Verdict** *(brain)* — APPROVE / REQUEST-CHANGES (code bug, failing test, fixable config → Stage Manager/executor) / ESCALATE (frozen-contract conflict, ADR-level concern, or architecture mismatch → re-intake via `/plan` or architect gate; write an ADR). Headless, both REQUEST-CHANGES and ESCALATE GATE at `review:merge` (never merge); when `review.escalate_routing` is on, an ESCALATE additionally parks the work item with `verity:needs-human` and its gate names the next role. Default-off, ESCALATE routes exactly like REQUEST-CHANGES.
6. **Merge** *(notebook)* — squash + delete-branch (mind the **stacked-PR auto-close trap** — re-home over resolve, or merge base without `--delete-branch`), `Closes #N`, attach Milestone. Genuine conflict → hand to (de-emphasized) Merge Manager.
7. **Signal** — merged `main` becomes the base for dependent stages. **Merges accrue; the Reviewer does NOT deploy** — the Release/Deploy Operator later decides when to cut a release (batched or per-merge).

**Single-agent mode:** the same agent dons the Reviewer in a **fresh sub-agent/context with a skeptical prompt** ("you did not write this; distrust the PR description; verify each invariant against source") — preserving adversarial separation without a second machine.

**Produces:** a review verdict (table) on the PR; a merge to `main` (or a change-request / escalation). No state-file writes.

**LOCKED:** an ESCALATE needing a contract change **always round-trips through `/plan`** (impact + ADR + new/amended contract). Contracts stay single-sourced and assessed — never written from two paths.

---

## Role 7 — Release/Deploy Operator (NEW; absorbs 1.4 Project Deployer)

**Why it exists:** the recurring **version→tag→build→digest→deploy→verify→STATUS** loop ran **18× as unowned work** (L4) and is where the #1 pain lived ("merged ≠ works in the browser", N1/N2). Make it a first-class, event-driven role.

**Boundary vs SRE:** Operator = the **act** of releasing+deploying+verifying a specific version, and recording it (event-driven, per release). SRE = **steady-state** health/monitoring/alerts/recovery-drills/intermittent-env-operations *between* deploys (continuous).

**Owns:** `STATUS.md` (runtime-truth artifact), the release loop, the **UI-smoke "observably-works" gate**, rollback, and the one-time **provisioning gate**.

**Release loop (brain decides · notebook executes):**
1. **Decide the release** *(brain)* — accrued merges + a Milestone → cut release N (batched or per-merge).
2. **Pre-flight** *(notebook)* — **env-available precheck** (target reachable? if off, start it — intermittent env is NORMAL; if it can't be brought up → file a **blocked-on-human work-item** with an explicit unblock signal); confirm `main` green; **back up current env** (`.env.bak.pre-vN`).
3. **Version + tag** *(notebook)* — **version derived from the tag** (single source — kills the "binary lies about its version" bug, E2); **auto-generate changelog** from Conventional Commits; push tag → triggers `release.yml`.
4. **Build / scan / pin** *(notebook)* — `release.yml` builds images once, Trivy-scans HIGH/CRITICAL, emits digests; **auto-pin digests into the env** (automate the manual copy-paste seam, F2). Handle registry-owner ≠ git-auth identity (GHCR `read:packages`, B1b).
5. **Deploy to STAGING first** *(notebook)* — `deploy.sh`: pull → **additive migrate** → up → `verify_deploy.sh`. (Closes the no-staging gap, F1 — prod was the test bed.)
6. **UI-smoke verify (the observably-works GATE)** — headless browser drives top user flows, asserting *behavior* (not just `/health`). Gate "release-verified" on it. **Fail → stop; do not promote.** (The asset was authored by the Stage Executor; it's RUN here, live.)
7. **Promote to PROD** *(notebook)* — same byte-identical digests → deploy → verify → smoke the critical path.
8. **Flip flags if enabling** *(brain)* — kill-switch dark→enabled as a deliberate, separate step (E4: ship dark, enable next).
9. **Update `STATUS.md`** *(brain+notebook)* — live version + digest, rollback breadcrumb (`.env.bak.pre-vN`), what shipped, secret *locations* (never values), coordination notes.
10. **On failure → rollback** *(notebook)* — re-pin previous digests + re-run `deploy.sh`. Safe because migrations are additive-only (F4/L5).

**Provisioning gate (ONCE, before first deploy):** generate an operator runbook from the identity manifest (cloud/secrets/DNS/registry-visibility/branch-protection-if-available); file human-only prerequisites as **blocked-on-human work-items** with explicit unblock signals (J2). One of the two places operator interaction belongs (J3).

**Design-better-than-the-real-build (baked in):** auto-pin digests · version-from-tag · auto-changelog · staging-before-prod · UI-smoke gate · env-available precheck as a normal step. Each maps to a specific interview pain.

**Produces:** a tagged, scanned, digest-pinned release; a verified staging→prod deploy; updated `STATUS.md`; a changelog. (No mutable state-file; release facts live in tags + `STATUS.md`.)

**LOCKED:**
- **Continuous CD to staging on every merge** (staging always mirrors `main`; UI-smoke runs continuously). **Prod = a deliberate cut release.**
- **Prod promotion = human/Operator confirm-gate by default** (beyond-MVP; real build's deploys were human-initiated). **Config knob** to make it auto-after-staging-smoke.

---

## Role 8 — Project Tester (carried; re-scoped as guardian of test honesty)

**Inherited from 1.4:** test pipelines + fix bugs. **Re-scoped:** the role that makes **"done = green" actually MEAN something** — the K2/D4 lesson was "tests existed but had never run in a clean CI-like env, hiding both broken fixtures (#6) and a real prod bug."

**Boundary vs Stage Executor:** Executor writes the tests *for its own stage* (unit/integration/contract + UI-smoke asset). **Project Tester owns the test SYSTEM** — the harness, fixtures, the **CI-like environment** (ephemeral DB, migrations-from-zero, no shared state), cross-cutting test health (flakiness, the `conftest`-collision class), and **root-causing + fixing bugs** that aren't tied to a single stage.

**Mandate (the anti-D4 guarantees):**
- The suite must run **reproducibly from zero** — fresh ephemeral DB, `migrate`-from-empty, no dependence on a developer's pre-populated state. (Every D4 failure traced to this.)
- Tests must be **honest** — fixture isolation, no stale shared state; a passing suite means the behavior works, not that the assertions were skipped/masked.
- Owns the **pipeline-test** (`Pipeline Test: YES` stages) and cross-cutting **test-debt** issues (`chore/tech-debt`, e.g. the #6 async-fixture saga).
- Ties to **Stage 0**: the CI-like test environment is wired at the walking skeleton, so this debt can't accumulate across stages.

**Runs:** automated tiers execute on every PR (CI); the *role* is invoked for pipeline-test stages, test-infra build/repair, and bug root-cause+fix. Fixes land as normal PRs (→ Reviewer).

**Produces:** the test harness/fixtures/CI test-env; bug-fix PRs; strengthened tiers. (No state-file writes.)

---

## Role 9 — Handoff Tester (changed; the independent adversarial eyeball)

**Why it matters most:** it produced the **highest-signal defects** in the real build (K3), and **losing it at consolidation (D8) caused the entire C5 hotfix treadmill** (dead help button, cache-stale UI, HTMX stub — all found by a *human clicking*, none catchable by CI or `/health`).

**The wall, enforced even single-agent (H4):** acts **purely as an adversarial end-user who cannot see or edit the code** — fresh context, no source access. Tests from the *user's* side, not the author's. (The role boundary is valuable independent of whether a second machine plays it.)

**Two obligations:**
1. **Exploratory live testing** — open-endedly drive the deployed app to find NEW failure modes the scripted UI-smoke can't anticipate. Files structured GitHub issues (`bug`/`feature`/`chore` templates, `correlation_id`, `filed_by`).
2. **Re-verify-on-live after deploy** — re-drive each prior fix/feature on the *live* app post-deploy to confirm it observably works. This is the round-trip D8 lost (K3) — its absence is exactly the C5 treadmill.

**Boundary vs the UI-smoke gate (Operator-owned):** UI-smoke = **automated**, checks **known top flows**, runs every staging deploy (regression guard). Handoff Tester = **exploratory human/adversarial**, discovers **unknown** failures. **The loop that closes the gap:** a Handoff-found failure → issue → fix → **a new scripted smoke check is added** so it can never regress. Exploratory findings become permanent automated coverage.

**Boundary vs Reviewer:** Reviewer verifies **against source, pre-merge**; Handoff Tester verifies **against the live UI, post-deploy** — opposite ends of the loop.

**Produces:** `ux-feedback/` session notes; structured GitHub issues; a re-verify-on-live pass per relevant deploy; new smoke checks for found failures.

**LOCKED:** a Handoff-found user-facing failure → the Planner **automatically attaches "add a regression smoke"** as an acceptance condition on the fix stage. The coverage gap closes by default; no one has to remember.

---

## Role 10 — SRE (carried; elevated for beyond-MVP)

**Boundary vs Release/Deploy Operator:** Operator = the **event-driven act** ("ship this version, verify it deployed"). SRE = **continuous steady-state** ("keep it healthy over time, be ready to recover, know normal-vs-incident"). On rollback they split cleanly: **Operator owns the mechanism** (re-pin digests + redeploy); **SRE owns the readiness + the decision** (drills it, and calls *when* to invoke during an incident).

**Responsibilities:**
1. **Monitoring / alerting** — health signals, dashboards, alert channels; SLI/SLOs appropriate to scale (beyond `/health`).
2. **Recovery readiness** — rollback drills + **restore drills** (PITR), so "roll back prod" is never scary (the F4 discipline, made a standing practice).
3. **Backup contract for ALL persistent state (new, N6 gap)** — every persistent volume is either backed up or **explicitly marked ephemeral/acceptable-loss**. The real build backed up Postgres but silently NOT the FAQ volume / retained artifacts — SRE closes that by making coverage an explicit, audited list.
4. **Intermittent-environment operations (new, N6)** — model "env is off most nights" as a **NORMAL state**: start/stop procedures + an **"asleep vs incident" disambiguation runbook** (so a nightly outage isn't misread as an incident — F3/G3). The Operator's env-available precheck *consumes* this.
5. **Secret lifecycle / rotation (new, N6)** — track + enforce rotation; flag stale/leaked credentials (the never-rotated classic PAT, throwaway admin credentials). Feeds the pre-go-live gate.
6. **Incident response** — triage → mitigate (often: invoke Operator rollback) → file issue → post-incident note; maintains `recovery-plan.md`.
7. **Feeds operational truth into `STATUS.md`** — the "known live caveats" (Operator owns the file; SRE supplies the ops reality).

**Runs:** continuous + on-demand (incident-triggered; scheduled drills/rotations). Feeds the **pre-go-live gate** (backup coverage, secret rotation, throwaway-account removal) jointly with Security Auditor.

**Produces:** monitoring/alerting config + dashboards; `recovery-plan.md`; the backup-coverage contract; the secret-rotation schedule; the intermittent-env runbook; incident notes.

**LOCKED:** SRE is **both** — standing/on-demand for incidents + drills, AND a **periodic scheduled "ops-health" pass** (rotation reminders, backup-coverage audit, restore drill). The scheduled pass is what catches the never-rotated-secret class.

---

## Role 11 — Retrofit Planner (existing-project path; "retrofit the SPINE onto existing code")

**Most directly-validated role in the spec:** the real build WAS a retrofit (born at v0.1.0, ~50-file working app with NO CI/issue-templates/STATUS — B3), and **D4 was a botched retrofit** (9 stages "done" before CI ever ran; first run exploded with 4 failures + multi-day fixture debt). This role makes that impossible.

**Replaces Vision + Architect for the existing path** — but does NOT skip identity/contracts/scaffold/skeleton; it does the **retrofit-equivalent of each**, in order:

1. **Analyze the existing codebase** *(brain)* — structure, stack, topology, what works, what's missing; derive prior state from GitHub (commits/PRs/issues/tags).
2. **Reconcile + LOCK the identity manifest** *(brain+notebook)* — derive `{repo, slug, image-prefix, registry-owner, dns, env, secrets}` from what exists; **flag inconsistencies** (casing splits, owner-vs-auth mismatch, partial renames — B1/B2) and lock it forward.
3. **Extract + FREEZE contracts** *(brain)* — reverse-engineer the implicit interface contracts (wire/JWT/schema) from the running system into `contracts/`, then freeze. This is the backbone that made the real build's iteration safe (the frozen `subagent_contract/v1` never broke across 15 stages).
4. **Retrofit the SPINE** *(notebook, deterministic)* — add the missing coordination/quality machinery the app lacks: CI workflows (hygiene + test tiers), issue templates (bug/feature/chore), `STATUS.md`, `docs/handoff/`, CODEOWNERS, framework state/config, branch-protection-if-available. (The entire B4 wishlist, shipped NOW instead of late.)
5. **Bootstrap `STATUS.md` from reality** *(brain+notebook)* — if the app is already deployed, reverse-engineer the runtime truth (where it runs, current version/digest, secret *locations*) into `STATUS.md`.
6. **THE "FIRST GREEN ON LEGACY CODE" GATE (retrofit's Stage-0 equivalent, BLOCKING)** — get the **existing code green in a clean CI-like env** (ephemeral DB, migrate-from-zero, real lint/secret-scan) **before any feature stage**. Surfaces the latent failures (lint debt, no `DB_URL`, missing migration step, broken fixtures) **now, incrementally** — converting the D4 big-bang into a controlled up-front step. **Feature stages are blocked until legacy-code-green.**
7. **Emit the thin initial backlog** — typically **hardening-first** (fix what the first-green gate surfaced — the real build's Stages 1–9), then features → hand to `/plan` for the stream.

**The headline rule (anti-D4):** *you cannot start feature work until the existing code is green in a real CI environment.* This is the walking-skeleton-blocks-features rule, applied to legacy code — the single most validated decision in the spec.

**Boundary:** after retrofit completes, the normal stream arc (`/plan` → Stage Manager → Reviewer → Operator) runs identically to the greenfield path. Retrofit is just the existing-project on-ramp.

**Produces:** codebase analysis; locked identity manifest; extracted+frozen `contracts/`; the retrofitted spine (CI/templates/STATUS/handoff/config); a `STATUS.md` seeded from reality; a hardening-first initial backlog.

**LOCKED:** first-green failures are emitted as **hardening stages** through the normal build→PR→review loop (all code change rides one rail, even hardening — matches the real build's Stages 1–9).

---

## Role 12 — Security Auditor (carried; elevated)

**Boundary vs Reviewer (locked overlap #2):** Security Auditor **DEFINES** the invariants + does **periodic deep/whole-system** audits; Reviewer **ENFORCES** them on every PR. This role is the *source* of the security checklist the Reviewer verifies and the Planner bakes into acceptance conditions + handoff-brief "security checklist" sections.

**Responsibilities:**
1. **Author the security invariants/standards** — the canonical checklist (e.g. least-privilege tool registries, caller-scoping non-widenable, path confinement, draft-not-autonomous external actions, no-secrets-in-snapshot). These flow to the Reviewer (per-PR) and Planner (acceptance conditions).
2. **Periodic deep audit** — threat model, authn/authz surface, dependency CVEs (app-deps, complementing release.yml's Trivy image scan), secret handling.
3. **Per-feature consult at intake** — when `/plan` flags a new security surface, Security Auditor contributes invariants for that stage.
4. **Pre-go-live security sign-off** (feeds the gate below, with SRE).
5. **Security-relevant ADRs** (e.g. "draft-not-autonomous," "git-archive tracked-files-only excludes secrets").

**Produces:** the invariants/standards doc (canonical checklist), `security-report.md`, CVE/dependency audit, pre-go-live sign-off.

---

## Role 13 — Technical Writer (changed; owns the human-readable layer)

**Owns (locked artifact ownership #4):** the prose/explanatory artifacts — distinct from ADRs (Architect), specs (Planner), runtime truth (Operator).
1. **Public/user + developer docs** — README, `docs/`, usage guides.
2. **Handoff briefs** (`docs/handoff/*`) — the spec-for-a-cold-reader, with the **"settled decisions — do NOT re-litigate" section** (highest-leverage handoff element, H6) + the **reading-order manifest** (`docs/handoff/README.md` — what made zero-setup rejoin real, H5). First-class scaffold artifact.
3. **Architecture narrative** (`docs/ARCHITECTURE.md`, request-flow) — human orientation. NOT the helper-bot's source of truth (that's the baked source snapshot, M2), but the narrative humans/agents read.

**Freshness contract:** the prose arch-doc gets a **"last-verified-against-commit" stamp / CI drift check** (it's human-written and can drift, unlike the source snapshot).

**Runs:** optional/on-demand; refreshes docs as stages land; authors a handoff brief when a feature is delegated to another agent.

**Produces:** README/`docs/`, `docs/handoff/*` (briefs + reading-order manifest), `docs/ARCHITECTURE.md`.

---

## Gate — Pre-go-live / first-real-data (NEW; not a role)

**Why:** the real build accumulated a "fine until real data" list that never got forced closed (throwaway admin credentials, never-rotated PAT, cross-user visibility, un-backed-up volumes — N6). A **blocking gate** before the project accepts real/production data or users.

**Checklist (jointly owned: Security Auditor + SRE):**
- Secret **rotation** (rotate any dev/exposed creds).
- **Remove throwaway accounts** (the throwaway-credential class).
- **Cross-user data isolation** verified (no cross-user leakage).
- **Backup coverage for ALL persistent state** (SRE's contract — no silent gaps).
- **Security deep-audit sign-off** (Security Auditor).
- Every "fine for now" item **explicitly closed or accepted**.

**Behavior:** the framework surfaces this as a forced checklist before go-live; unresolved blockers stop the go-live.

---

## Role 14 — Codebase Mapper (carried; cross-cutting, any-time, optional)

**Unchanged in spirit:** generate an interactive **codebase structure** diagram on demand (distinct from the Planner's Gantt, which is plan/schedule). A generated artifact, regenerated — never hand-maintained.

**Useful for:** orientation (a joining agent, understanding a large/legacy codebase) — can feed the handoff reading-order manifest. May use image-gen capability if present, but is primarily a structural diagram.

**Produces:** `codebase-map.html` (or Mermaid markdown for GitHub-native rendering).

---

## STATE-DERIVATION ENGINE (the last real architecture piece)

**Principle (interview G5):** SDD "state" is a **read-time projection**, never a hand-maintained mutable file. Two sources, clean boundary:
- **Integration state** (planned / building / in-review / merged / released / CI status) → **DERIVED from GitHub** (issues, PRs, tags, Actions check-runs, Milestones) + the committed **spec files** (`stage-instructions/`, `contracts/`). Never written by an agent.
- **Runtime state** (what's actually deployed/live: version, digest, addresses, secret *locations*) → **`STATUS.md`**, the ONE legitimately-mutable committed artifact, **single-writer = Release/Deploy Operator**. GitHub can't know your VMs.

**The core inversion: a state transition IS a GitHub act, not a file edit.** (This is what kills the drift G4 + the merge-conflict G1/G2 at once — derived state has zero write-contention.)

| State transition | The act (who) | Derived from |
|---|---|---|
| stage planned | write `stage-instructions/stage-N-*.md` + open work-item issue (Planner) | spec file + issue exists |
| claimed | assignee + `in-progress` label (or draft PR) | issue assignee/label |
| building | branch `feat/stage-N-*` / draft PR (Stage Manager) | branch/PR exists |
| CI green | Actions run (automatic) | check-runs on the PR/commit |
| in-review | PR open + CI green | PR state |
| merged (=built/fixed) | squash-merge PR, `Closes #N` (Reviewer) | PR merged / issue closed |
| released | push tag `vX.Y.Z` (Operator) | tag exists |
| deployed staging/prod | GitHub **Deployment** record (Operator) | Deployments API *(fallback: `STATUS.md` if tier lacks it)* |
| verified | UI-smoke result recorded (Operator) | deployment status / `STATUS.md` |

**Mechanics (deterministic "notebook" layer — a `state` CLI like 1.4's sdd-tools, but READ-ONLY w.r.t. state):**
- On demand, query the GitHub API (`gh`) + read committed specs + `STATUS.md` → compute the projection → emit JSON (for roles) or a rendered view.
- **`graph next`** = read `depends-on` from stage-instructions × derived merged-status → unblocked stages.
- **GONE from 1.4:** `state update / complete-role / start-role` — nobody writes state; the *act* (PR/merge/tag/issue) is the transition.
- **Caching:** allowed but **never authoritative** — a disposable, regenerable, **gitignored/ephemeral** cache (NOT a committed file, else it drifts like STATE.md). Blow away + recompute anytime.

**Honest edge cases:** eventually-consistent with GitHub (API lag — fine); rate limits → local cache; **offline** → state can't be freshly derived (the bus IS GitHub; merged/tag facts are reconstructable from `git log`, but issues/CI/Deployments need the API) — last cache is a stale snapshot. Multi-agent: **no write contention** (both read the same GitHub truth) — the central payoff.

**Specs vs progress, never conflated:** a stage *exists* because its committed spec exists (intent, durable); its *status* comes from GitHub (progress, derived). Claiming is derived too (assignee/label), so even "who's on what" needs no separate file.

---

## ROSTER STATUS (as of 2026-06-07)
All roles designed. Bootstrap: Vision(1), Architect(2), Designer(3), Retrofit(11). Stream: Intake/Planner(4), Stage Manager+Executor(5), Reviewer/Integrator(6). Verify: Project Tester(8), Handoff Tester(9), UI-smoke gate. Operate: Release/Deploy Operator(7), SRE(10), Security Auditor(12), Technical Writer(13), pre-go-live gate. Cross-cutting: Codebase Mapper(14). Gates: Walking-Skeleton(Stage 0), UI-smoke, pre-go-live, provisioning.
**Next:** take stock of full roster / consolidate; then resolve remaining small OPENs; then decide build approach (clean-room implementation).
