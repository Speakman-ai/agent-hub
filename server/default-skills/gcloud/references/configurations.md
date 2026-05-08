# Configurations — Multi-Project & Multi-Account Switching

`gcloud` configurations are named profiles that bundle a project, account,
compute region/zone, and other properties. Use them to switch between
environments (dev/staging/prod) or GCP projects without re-specifying flags
on every command.

Back to [SKILL.md](../SKILL.md).

---

## Contents

- [List and inspect configurations](#list-and-inspect-configurations)
- [Create and activate a configuration](#create-and-activate-a-configuration)
- [Configuration resolution in scripts](#configuration-resolution-in-scripts)
- [CLOUDSDK_ACTIVE_CONFIG_NAME env var](#cloudsdk_active_config_name-env-var)
- [Per-command project override](#per-command-project-override)
- [Common configuration properties](#common-configuration-properties)

---

## List and inspect configurations

```bash
# All configurations with active flag
gcloud config configurations list

# Which config is currently active?
gcloud config configurations list --filter="is_active=true" --format="value(name)"

# Show all properties of the active config
gcloud config list

# Show a specific config's properties
gcloud config configurations describe staging
```

---

## Create and activate a configuration

```bash
# Create a new named configuration
gcloud config configurations create staging

# Activate it
gcloud config configurations activate staging

# Set properties on it
gcloud config set core/project my-staging-project
gcloud config set core/account me@example.com
gcloud config set compute/region us-central1
gcloud config set compute/zone us-central1-a

# Go back to default
gcloud config configurations activate default
```

---

## Configuration resolution in scripts

The `scripts/_common.sh` helper resolves the active configuration in this
priority order:

1. `--config <name>` flag passed to the script (sets `GCLOUD_CLI_CONFIG`)
2. `CLOUDSDK_ACTIVE_CONFIG_NAME` environment variable
3. Currently active configuration from `gcloud config configurations list`
4. `default` as the final fallback

The resolved configuration determines the project and account used in all
subsequent `gcloud` calls via `--configuration <name>`.

```bash
# _common.sh exposes these after sourcing:
#   RESOLVED_CONFIG   → configuration name
#   RESOLVED_PROJECT  → core/project from that config (or CLOUDSDK_CORE_PROJECT)
#   RESOLVED_ACCOUNT  → core/account from that config
```

---

## CLOUDSDK_ACTIVE_CONFIG_NAME env var

Set this in the shell or in a `.env` file to force a specific configuration
without touching the global active configuration:

```bash
export CLOUDSDK_ACTIVE_CONFIG_NAME=staging
gcloud compute instances list    # uses staging config

# Or per-command
CLOUDSDK_ACTIVE_CONFIG_NAME=prod gcloud projects list
```

This is safer than `gcloud config configurations activate` in multi-session
environments because it does not mutate the global state on disk.

---

## Per-command project override

```bash
# Override project without switching configuration
gcloud --project=other-proj compute instances list

# In gcloud-q.sh
scripts/gcloud-q.sh --project=other-proj compute instances list
```

---

## Common configuration properties

| Property | Description | Set via |
|---|---|---|
| `core/project` | Default GCP project ID | `gcloud config set core/project <id>` |
| `core/account` | Active account / SA email | `gcloud config set core/account <email>` |
| `compute/region` | Default Compute Engine region | `gcloud config set compute/region <region>` |
| `compute/zone` | Default Compute Engine zone | `gcloud config set compute/zone <zone>` |
| `run/region` | Default Cloud Run region | `gcloud config set run/region <region>` |
| `container/cluster` | Default GKE cluster | `gcloud config set container/cluster <name>` |
| `container/use_client_certificate` | Use client cert for GKE | `gcloud config set container/use_client_certificate false` |

View all settable properties: `gcloud topic configurations`
