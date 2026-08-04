---
name: verity:deploy-setup
description: Deployment Methods — interview the user about where they deploy apps, then build their global deployment-methods catalog (locations, never secrets).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - AskUserQuestion
---
<objective>
Run the Deployment Methods role: interview the user about where they deploy apps and
write their **global** catalog at `~/.verity/deployment-methods.md` — one
`## <id> — <Title>` block per method. This is the reusable menu the Architect
(`/verity:architect`) later reads with `verity deployment list` to choose a target for
each app.

Scope: the GLOBAL catalog only (across all projects). Do NOT touch any repo or write a
per-app `.verity/deploy-access.md` — choosing a target for a specific app, and writing
its access file, is the Architect's job. Hand off to it at the end.

🔒 Hard rule: record credential **LOCATIONS** only — a key file path, an SSO/CLI profile
name, a secret-store entry. **Never** read, ask for, paste, or write an actual key,
password, or token.
</objective>

<process>
1. **Show the current catalog** so the user sees what's already there:
   ```bash
   verity deployment path           # where the catalog lives (~/.verity/deployment-methods.md)
   verity deployment list           # existing methods (two seeded examples on a fresh install)
   ```
   If the file doesn't exist yet, `verity deployment ensure` seeds it first.

2. **Ask what they want to do** and which provider(s). Offer this menu (multi-select):
   - **AWS** · **GCP** · **Azure** · **Self-hosted / LAN** · **Managed PaaS**
     (Render, Fly.io, Vercel, Railway, Heroku…) · **Generic VM over SSH** ·
     **Kubernetes** · **Other**
   Also ask whether to **replace/delete the two seeded examples** (`aws-ec2`,
   `local-server`) once real targets exist.

3. **Per chosen provider, ask only the access questions that matter** (branch on
   provider). In every case capture: a kebab-case **id**, a short **Title**, and how you
   **reach/authenticate** — by reference only.
   - **AWS** — region; service (EC2 / ECS / Lightsail / Elastic Beanstalk / S3+CloudFront);
     auth (named profile in `~/.aws/credentials`, an SSO profile, or an instance/IAM role);
     for EC2: host/Elastic IP, SSH user, and key-file *location*.
   - **GCP** — project id; region; service (Compute Engine / Cloud Run / GKE / App Engine);
     auth (gcloud ADC, a service-account key-file *location*, or workload identity);
     service/host identifier.
   - **Azure** — subscription; resource group; region; service (VM / App Service /
     Container Apps / AKS); auth (`az login` account, or a service-principal *reference*);
     host identifier.
   - **Self-hosted / LAN** — hostname or IP; SSH user; key-file *location*; reachability
     (LAN-only / VPN). 
   - **Managed PaaS** — which platform; app/service name; how deploys trigger (git push vs
     CLI); where the API token *lives* (secret-store entry — not the token itself).
   - **Generic VM over SSH** — host; user; port; key-file *location*.
   - **Kubernetes** — cluster name; context; namespace; kubeconfig *location*; image registry.
   - **Other** — free-form: capture host, how to reach it, and where credentials live.

4. **Build the config.** Open the catalog file (the path from step 1) and, for each method,
   add or replace a block in the documented format — preserving every other entry:
   ```markdown
   ## <id> — <Title>
   - **status:** active
   - **provider:** <AWS | GCP | Azure | self-hosted | Render | …>
   - **host:** `<host-or-identifier>`
   - **user:** `<user-if-applicable>`
   - **access:** `<command or how-to-reach>` — reference the key/profile *location* only
   - **notes:** <region, ports, VPN-only, deploy trigger, anything the Architect should know>
   ```
   Editing an existing **id** replaces that block (idempotent); never duplicate ids. Delete
   the `example`-status blocks only if the user agreed in step 2. **Confirm before
   overwriting or deleting** any existing entry.

5. **Validate** that it parses and read it back:
   ```bash
   verity deployment list
   verity deployment show <id>      # for each method you added
   ```
   Surface anything that didn't parse and fix the formatting.

6. **Report and hand off.** Summarize the methods now in the catalog. Tell the user: to use
   one in a project, run **`/verity:architect`** — it reads this catalog, helps choose a
   target for that app, records the choice as an ADR, and sets up the per-app access file.
   This role wrote nothing into any repo and stored no secrets.
</process>
