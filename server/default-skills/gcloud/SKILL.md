---
name: gcloud
description: >-
  General-purpose Google Cloud CLI skill — query any GCP service via gcloud,
  gsutil, and bq; resolve active configurations and Application Default
  Credentials; apply --format/--filter projections; and (with explicit user
  confirmation) run write/mutating operations. TRIGGER when: the user mentions
  "GCP", "Google Cloud", a gs:// URI, BigQuery, Cloud Run, GKE, Cloud
  Functions, Cloud Build, Artifact Registry, Compute Engine, VPC/firewall in a
  GCP context, Cloud IAM, Cloud Logging, or invokes gcloud/gsutil/bq. DO NOT
  TRIGGER on: Google Workspace, Google Drive, Gmail, Google Docs/Sheets/Slides,
  or Google Maps (those are separate APIs and belong to a future Workspace
  skill); generic cloud-provider comparisons with no GCP specifics; AWS or
  Azure only.
category: integration
version: 1.0.0
keep-coding-instructions: true
---

# Google Cloud CLI (gcloud / gsutil / bq)

**TRIGGER:** GCP / Google Cloud, `gs://` URIs, BigQuery, Cloud Run, GKE, Cloud
Functions, Compute Engine, Cloud IAM, Cloud Logging, or any `gcloud`/`gsutil`/`bq` command.

**DO NOT TRIGGER:** Google Workspace, Google Drive, Gmail, Google Docs/Sheets/Slides
(those belong to a future Workspace skill), AWS, Azure, or generic cloud comparisons
with no GCP specifics.

Use this skill to interact with **any GCP service** via the `gcloud` CLI,
`gsutil` for Cloud Storage, and `bq` for BigQuery — read resources, filter
output, manage configurations, handle credentials, and (after confirmation)
run write operations.

## Prerequisites

### Google Cloud SDK

All scripts require **`gcloud`** on `$PATH`.

- macOS: `brew install --cask google-cloud-sdk`
- Linux: See [Install guide](https://cloud.google.com/sdk/docs/install) or
  `curl https://sdk.cloud.google.com | bash`
- Verify: `gcloud version`

### gsutil and bq

Both ship with the Cloud SDK. Verify:
```bash
gsutil version
bq version
```

### jq (recommended)

Some recipes pipe through **`jq`** for JSON filtering.

- macOS: `brew install jq`
- Linux: `sudo apt-get install jq` / `sudo yum install jq`

---

## Safety Model — Read-Default, Write-on-Confirm

**Read operations** (list, describe, get, query, ls) run immediately.

**Write / mutating operations** (create, delete, update, deploy, enable,
disable, patch, set-iam-policy, add-iam-policy-binding, remove-iam-policy-binding)
**must be confirmed by the user first** — show the exact command and the
resources that will change.

**Destructive-specific rules:**
- Never run `delete`, `destroy`, or `remove` without a user-typed confirmation
  *in the current turn*.
- For bulk operations (e.g. deleting all objects in a bucket), list affected
  resources first, then ask for confirmation.
- Always prefer `--dry-run` where supported (e.g. `gsutil cp --dry-run`).

**Never print credentials.** Mask OAuth refresh tokens, service-account JSON,
and private keys. See `scripts/_common.sh:mask_secrets()`.

> **This is a behavioural contract on the agent, not a runtime guard.**
> The wrapper scripts execute mutations the moment they are invoked — the
> agent is responsible for confirming with the user first.

---

## Active Configuration & Project

```bash
# Who am I? Which project/account/config?
scripts/gcloud-whoami.sh                    # auth list + config summary
scripts/gcloud-whoami.sh --config staging   # target a named configuration
scripts/gcloud-whoami.sh --project my-proj  # override project for this call
```

**Every response must state the resolved configuration, active project, and
active account.**

---

## Generic Query Helper

```bash
# Run any read command with config/project baked in
scripts/gcloud-q.sh compute instances list
scripts/gcloud-q.sh storage buckets list
scripts/gcloud-q.sh container clusters list

# Add --format for structured output
scripts/gcloud-q.sh compute instances list --format="json"
scripts/gcloud-q.sh compute instances list \
  --format="table(name,zone,status,machineType.basename())"

# Add --filter to narrow results
scripts/gcloud-q.sh compute instances list --filter="status=RUNNING"
scripts/gcloud-q.sh compute instances list \
  --filter="zone:us-central1 AND status=RUNNING"

# Pass through arbitrary flags (config/project are injected automatically)
scripts/gcloud-q.sh functions list --regions=us-central1
scripts/gcloud-q.sh run services list --platform=managed --region=us-central1
```

`scripts/gcloud-q.sh` prepends `--configuration` and `--project` resolved
from the environment. See `references/configurations.md`.

---

## Configuration Resolution

Resolved in this order (see `scripts/_common.sh:resolve_config()`):
1. `--config <name>` flag passed to the script
2. `CLOUDSDK_ACTIVE_CONFIG_NAME` env var
3. Current `gcloud config configurations list --filter=is_active=true`
4. `default`

Project follows: explicit `--project` flag → `CLOUDSDK_CORE_PROJECT` env var →
active configuration's `core/project` property.

**Every response must state the resolved config and project.**

Full details: `references/configurations.md`

---

## Authentication

```bash
# Check current auth state
gcloud auth list
gcloud auth application-default print-access-token 2>&1 | head -5

# Interactive login (user credentials — not for headless agents)
gcloud auth login
gcloud auth application-default login

# Service account (headless / cron) — set GOOGLE_APPLICATION_CREDENTIALS
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"

# Check ADC
gcloud auth application-default print-access-token
```

Full auth reference: `references/auth-and-adc.md`

---

## Output Formatting

Always prefer `--format=value(...)` or `--format=json` over parsing tabular
output — it's more reliable and scriptable.

```bash
# Extract a single field
gcloud compute instances list --format="value(name)"
gcloud projects list --format="value(projectId)"

# Table with selected columns
gcloud compute instances list \
  --format="table(name,zone,status,networkInterfaces[0].networkIP)"

# JSON (for jq processing)
gcloud compute instances list --format=json | jq '.[].name'

# YAML (for human reading)
gcloud compute instances describe my-instance --format=yaml
```

Full reference with recipes: `references/format-and-filter.md`

---

## Service Reference

Key recipes for every major GCP service: `references/common-services.md`

Covers: Compute Engine, Cloud Storage (gsutil), BigQuery (bq), IAM,
GKE, Cloud Run, Cloud Functions, Cloud Build, Artifact Registry,
Cloud Logging.

---

## Multi-Project Queries

```bash
# List all accessible projects
gcloud projects list --format="table(projectId,name,projectNumber)"

# Loop across projects (always use --format=value to avoid header noise)
for proj in $(gcloud projects list --format="value(projectId)"); do
  echo "=== $proj ==="
  gcloud --project="$proj" container clusters list --format="table(name,zone,status)"
done

# Or with gcloud-q.sh for profile injection:
scripts/gcloud-q.sh --project=proj-a container clusters list
scripts/gcloud-q.sh --project=proj-b container clusters list
```

---

## Available Scripts

| Script | Purpose |
|---|---|
| `scripts/gcloud-whoami.sh` | Auth list + resolved config/project/account |
| `scripts/gcloud-q.sh` | Generic read-query helper with config/project injection |
| `scripts/_common.sh` | Config resolution, secret masking, error helpers |
