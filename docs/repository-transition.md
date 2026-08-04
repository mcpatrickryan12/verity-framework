# Repository transition — the dev/prod split

**As of 2026-08-04**, this repository is the **production home** of Verity. Its
history begins at the `v1.1.0` production baseline, which is byte-identical to
the npm package `verity-framework@1.1.0` published earlier from the original
repository (tarball sha1 `02d01b07b80fd98c29f4c62bf867f90dcf4758a4`).

What changed:

- Verity's development — planning, stages, reviews, and engineering evidence —
  continues in a **private development repository**. Earlier public releases
  (v0.1.0 through v1.1.0) were cut from that original history, which remains
  intact there; it has not been erased from the internet, but it is no longer
  the public face of the project.
- Each future release lands here as **one promoted commit** produced by a
  deterministic, fail-closed projection of the development repository
  (`verity promotion project` / `verify` — part of the shipped product), then
  tagged and published from this repository.
- Changelog references of the form `dev#NN` point at issues/PRs in the private
  development repository; issue numbers in THIS repository are unrelated to
  them.

Where to go:

- **Report bugs or request features:** open an issue here — issues are the
  production repo's front door and flow into development triage.
- **Code contributions:** this repository does not accept code pull requests;
  source changes travel through the development repository and arrive as
  promoted releases. (See CONTRIBUTING.md — its contributor-workflow sections
  will be revised for this model in the next release.)
- **Install:** `npm i -g verity-framework` — unchanged.
