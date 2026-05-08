# --format and --filter Recipes

Stop parsing tabular output. Use `--format=value(...)` projections and
`--filter=...` to get exactly the data you need without fragile text parsing.

Back to [SKILL.md](../SKILL.md).

---

## Contents

- [--format basics](#--format-basics)
- [value() — extract a single field](#value--extract-a-single-field)
- [table() — structured table output](#table--structured-table-output)
- [json and yaml — structured dumps](#json-and-yaml--structured-dumps)
- [Field transformations in projections](#field-transformations-in-projections)
- [--filter basics](#--filter-basics)
- [Filter operators](#filter-operators)
- [Combining --format and --filter](#combining---format-and---filter)
- [--filter on nested fields](#--filter-on-nested-fields)
- [Common recipes](#common-recipes)

---

## --format basics

```bash
gcloud <service> <command> --format=FORMAT_STRING
```

Format strings:

| Format | Notes |
|---|---|
| `json` | Full JSON output — pipe to `jq` for further filtering |
| `yaml` | Human-readable YAML |
| `text` | Key-value pairs |
| `table(...)` | Columnar table with selected fields |
| `value(...)` | Single-column output — best for scripting |
| `csv(...)` | CSV with headers |
| `csv[no-heading](...)` | CSV without header row |
| `flattened` | Dot-path key=value pairs |

---

## value() — extract a single field

Use `value()` when you need a single column for scripting (no header noise).

```bash
# List project IDs (one per line, no header)
gcloud projects list --format="value(projectId)"

# List instance names
gcloud compute instances list --format="value(name)"

# List bucket names from gsutil
gsutil ls -p PROJECT_ID   # note: gsutil does not use --format

# Multiple fields (tab-separated)
gcloud compute instances list --format="value(name,zone,status)"

# Nested field
gcloud compute instances list \
  --format="value(networkInterfaces[0].networkIP)"
```

---

## table() — structured table output

```bash
# Basic table
gcloud compute instances list \
  --format="table(name,zone,status,machineType.basename())"

# With column aliases
gcloud compute instances list \
  --format="table(name:label=INSTANCE, zone:label=ZONE, status)"

# Nested arrays — first element
gcloud compute instances list \
  --format="table(name, networkInterfaces[0].networkIP:label=INTERNAL_IP)"

# GKE clusters
gcloud container clusters list \
  --format="table(name,zone,currentNodeCount,status,currentMasterVersion)"
```

---

## json and yaml — structured dumps

```bash
# Full JSON — pipe to jq
gcloud compute instances list --format=json | jq '.[].name'
gcloud compute instances list --format=json | jq '.[] | select(.status=="RUNNING") | .name'

# Single resource
gcloud compute instances describe my-instance --format=json
gcloud compute instances describe my-instance --format=yaml

# Extract nested field via jq after --format=json
gcloud iam service-accounts list --format=json \
  | jq '.[].email'
```

---

## Field transformations in projections

`gcloud` supports Python-like transforms in format strings:

| Transform | Example | Effect |
|---|---|---|
| `.basename()` | `machineType.basename()` | Last path segment (`n1-standard-4` → `n1-standard-4`) |
| `.date()` | `createTime.date()` | ISO date string |
| `.list()` | `tags.items.list()` | Join list elements with `,` |
| `.yesno(yes, no)` | `autoUpgrade.yesno(yes=enabled,no=disabled)` | Boolean display |
| `[N]` | `networkInterfaces[0].networkIP` | Array indexing |

```bash
# Machine type basename
gcloud compute instances list \
  --format="table(name, machineType.basename():label=TYPE)"

# First network interface IP
gcloud compute instances list \
  --format="value(name, networkInterfaces[0].accessConfigs[0].natIP)"
```

---

## --filter basics

```bash
# Equality
gcloud compute instances list --filter="status=RUNNING"

# String prefix / substring (colon = HAS operator)
gcloud compute instances list --filter="zone:us-central1"

# Negation
gcloud compute instances list --filter="NOT status=RUNNING"
```

---

## Filter operators

| Operator | Syntax | Meaning |
|---|---|---|
| `=` | `status=RUNNING` | Exact match |
| `:` | `zone:us-central1` | Contains / prefix match |
| `!=` | `status!=RUNNING` | Not equal |
| `<`, `>`, `<=`, `>=` | `diskSizeGb>100` | Numeric comparison |
| `AND` | `status=RUNNING AND zone:us-east1` | Logical AND |
| `OR` | `status=RUNNING OR status=STAGING` | Logical OR |
| `NOT` | `NOT status=TERMINATED` | Logical NOT |

---

## Combining --format and --filter

```bash
# Running instances in us-central1 — extract names only
gcloud compute instances list \
  --filter="status=RUNNING AND zone:us-central1" \
  --format="value(name)"

# GKE clusters in a specific project that are RUNNING
gcloud --project=my-proj container clusters list \
  --filter="status=RUNNING" \
  --format="table(name,zone,currentNodeCount)"

# Cloud Run services with a specific label
gcloud run services list \
  --platform=managed \
  --region=us-central1 \
  --filter="metadata.labels.env=production" \
  --format="table(metadata.name,status.url)"
```

---

## --filter on nested fields

```bash
# Instances with a specific tag
gcloud compute instances list \
  --filter="tags.items=web-server"

# Instances with a specific metadata key
gcloud compute instances list \
  --filter="metadata.items.key=environment AND metadata.items.value=prod"

# IAM bindings containing a specific member
gcloud projects get-iam-policy PROJECT_ID \
  --format=json \
  | jq '.bindings[] | select(.members[] | contains("user:alice@example.com"))'
```

---

## Common recipes

```bash
# All RUNNING instances across a project, names only
gcloud compute instances list \
  --filter="status=RUNNING" \
  --format="value(name)"

# All GCS buckets in a project
gsutil ls -p PROJECT_ID

# All BigQuery datasets
bq ls --project_id=PROJECT_ID

# List all IAM roles granted to a member
gcloud projects get-iam-policy PROJECT_ID \
  --format=json \
  | jq --arg m "user:alice@example.com" \
       '.bindings[] | select(.members[] | contains($m)) | .role'

# Cloud Run services and their URLs
gcloud run services list --platform=managed --region=us-central1 \
  --format="table(metadata.name, status.url)"

# GKE clusters with node count
gcloud container clusters list \
  --format="table(name,zone,currentNodeCount,status)"
```
