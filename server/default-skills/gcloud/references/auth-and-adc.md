# Auth & Application Default Credentials (ADC)

Three credential types cover the vast majority of GCP agent use-cases.
Pick the right one for the environment; never mix them.

Back to [SKILL.md](../SKILL.md).

---

## Contents

- [User credentials — interactive sessions](#user-credentials--interactive-sessions)
- [Service account keys — headless agents](#service-account-keys--headless-agents)
- [Application Default Credentials (ADC)](#application-default-credentials-adc)
- [Workload Identity — headless without key files](#workload-identity--headless-without-key-files)
- [Detecting expired credentials](#detecting-expired-credentials)
- [Masking secrets in logs](#masking-secrets-in-logs)

---

## User credentials — interactive sessions

Obtained via browser-based OAuth flow. Best for local development and
interactive agent sessions where a human can complete the login.

```bash
# Authenticate gcloud CLI (for gcloud commands)
gcloud auth login

# Authenticate Application Default Credentials (for client libraries + gcloud)
gcloud auth application-default login

# Verify active accounts
gcloud auth list

# Revoke credentials
gcloud auth revoke [ACCOUNT]
gcloud auth application-default revoke
```

**Detection:** If user credentials have expired, `gcloud auth list` will show
the account with status *(active)* but API calls return `401 Unauthorized` or
`ERROR: (gcloud…) Your credentials do not have permission…`.

Instruct the user to re-run `gcloud auth login` or
`gcloud auth application-default login`. **Do not auto-run these** —
they open a browser and require human interaction.

---

## Service account keys — headless agents

For cron jobs, heartbeats, and other non-interactive agent sessions, prefer
a **service account** with a downloaded JSON key file.

```bash
# 1. Activate a service account for gcloud
gcloud auth activate-service-account \
  --key-file=/path/to/sa-key.json \
  [SERVICE_ACCOUNT_EMAIL]

# 2. Set GOOGLE_APPLICATION_CREDENTIALS for ADC (client libraries)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json

# 3. Verify
gcloud auth list          # shows the service account as active
gcloud config list        # check project binding
```

**Per-user credential store:** Store the path to the SA key file in the
Agent Hub per-user skill credentials (key: `GOOGLE_APPLICATION_CREDENTIALS`)
rather than hardcoding it. The skill's `_common.sh` resolves this path
via the environment variable before falling back to well-known locations.

**Key rotation:** Service account keys should be rotated at least annually.
Check key age:
```bash
gcloud iam service-accounts keys list \
  --iam-account=SA_EMAIL@PROJECT.iam.gserviceaccount.com \
  --format="table(name.basename(),validAfterTime,validBeforeTime)"
```

---

## Application Default Credentials (ADC)

ADC is the recommended credential resolution strategy for agent code and
client libraries. The GCP SDK searches for credentials in this order:

1. `GOOGLE_APPLICATION_CREDENTIALS` environment variable → service account JSON
2. `gcloud auth application-default login` credentials
   (`~/.config/gcloud/application_default_credentials.json`)
3. Attached service account (Compute Engine / Cloud Run / GKE workload identity)

```bash
# Check which credentials ADC will use
gcloud auth application-default print-access-token   # success = ADC is configured
gcloud config list                                   # shows active project/account

# For scripts: test ADC before running bulk operations
if ! gcloud auth application-default print-access-token &>/dev/null; then
  echo "ADC not configured — set GOOGLE_APPLICATION_CREDENTIALS or run:" >&2
  echo "  gcloud auth application-default login" >&2
  exit 1
fi
```

---

## Workload Identity — headless without key files

For GKE pods, Cloud Run services, and Cloud Functions, **Workload Identity**
lets the workload act as a service account without downloading a key file.

This is the recommended production pattern; service account keys are a
security liability if leaked.

- **GKE Workload Identity:** Bind a Kubernetes service account to a GCP
  service account via annotation + IAM binding.
- **Cloud Run:** Assign the service account at deploy time
  (`--service-account=SA_EMAIL`); the runtime token is injected automatically.
- **Cloud Functions:** Same pattern — `--service-account=SA_EMAIL` at deploy.

Workload Identity configuration is out of scope for v1 of this skill but
the patterns above are the recommended follow-up for any production headless
agent workload.

---

## Detecting expired credentials

```bash
# Quick check — exits non-zero on auth failure
gcloud auth print-access-token &>/dev/null || {
  echo "gcloud user credentials expired — run: gcloud auth login" >&2
}

# ADC check
gcloud auth application-default print-access-token &>/dev/null || {
  echo "ADC expired — run: gcloud auth application-default login" >&2
  echo "  or set GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json" >&2
}
```

`scripts/gcloud-whoami.sh` runs these checks automatically and surfaces
actionable guidance.

---

## Masking secrets in logs

Never log or print:
- Service account JSON contents (contains `private_key`)
- OAuth refresh tokens (`refresh_token` field)
- Access tokens (short-lived but still sensitive)

The `mask_secrets()` function in `scripts/_common.sh` handles these patterns.
Always pipe output through it before printing to the user.

**Patterns masked:**
- `"private_key": "-----BEGIN RSA PRIVATE KEY-----…"` → `[REDACTED_PRIVATE_KEY]`
- `"refresh_token": "1//..."` → `[REDACTED_REFRESH_TOKEN]`
- `"access_token": "ya29.…"` → `[REDACTED_ACCESS_TOKEN]`
- `"client_secret": "…"` → `[REDACTED_CLIENT_SECRET]`
