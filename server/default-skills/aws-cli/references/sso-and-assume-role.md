# SSO & Assume-Role Runbook

Back to [SKILL.md](../SKILL.md).

## IAM Identity Center (SSO)

### One-time setup

1. Configure the SSO profile in `~/.aws/config`:

```ini
[profile my-sso]
sso_start_url  = https://my-org.awsapps.com/start
sso_region     = us-east-1
sso_account_id = 123456789012
sso_role_name  = AdministratorAccess
region         = us-east-1
output         = json
```

2. Log in (opens browser for the device-code grant):

```bash
aws sso login --profile my-sso
```

3. Verify:

```bash
aws sts get-caller-identity --profile my-sso
```

### Expired session detection

The agent checks for `ExpiredToken` / `ExpiredTokenException` in the STS
output (`scripts/aws-whoami.sh`). When detected, it surfaces:

```
error: AWS session token has expired.
Run: aws sso login --profile my-sso
```

When the project has Hub-managed AWS profiles (`AGENT_HUB_AWS_PROFILE_NAMES`),
use the Hub API to start browser-less SSO and return the device URL to the user
(see `SKILL.md` → Project-configured profiles). Otherwise the agent **does not**
run `aws sso login` directly without user involvement.

### Refresh tokens

SSO tokens expire after the portal session duration (typically 8–12 hours).
Re-login with `aws sso login --profile my-sso`.

To list active SSO tokens:
```bash
ls ~/.aws/sso/cache/
```

---

## Assume Role

### Direct assume-role (CLI)

```bash
# Assume a role and export credentials into the current shell
CREDS="$(aws sts assume-role \
  --role-arn arn:aws:iam::123456789012:role/MyRole \
  --role-session-name agent-session \
  --duration-seconds 3600 \
  --query 'Credentials' \
  --output json)"

export AWS_ACCESS_KEY_ID="$(echo "${CREDS}"     | jq -r '.AccessKeyId')"
export AWS_SECRET_ACCESS_KEY="$(echo "${CREDS}" | jq -r '.SecretAccessKey')"
export AWS_SESSION_TOKEN="$(echo "${CREDS}"     | jq -r '.SessionToken')"
```

After this, all `aws` calls in the shell use the assumed role until the session
expires or the env vars are unset.

### Profile-based assume-role

Define a role profile in `~/.aws/config`:

```ini
[profile cross-account-admin]
role_arn       = arn:aws:iam::999888777666:role/AdminRole
source_profile = default
region         = us-east-1
```

Then call:
```bash
aws sts get-caller-identity --profile cross-account-admin
# AWS CLI auto-calls sts:AssumeRole and caches the credentials
```

### MFA-protected assume-role

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::123456789012:role/MfaRole \
  --role-session-name mfa-session \
  --serial-number arn:aws:iam::123456789012:mfa/my-device \
  --token-code 123456
```

---

## Token Duration

| Credential type | Default duration | Max |
|---|---|---|
| SSO session | 8 hours | 12 hours (portal config) |
| `sts:AssumeRole` | 1 hour | 12 hours (role trust policy) |
| IAM user access key | Permanent | N/A (revoke to expire) |
| EC2 instance role | Rotated by EC2 | N/A |

---

## Chained Roles

```bash
# Source profile → intermediate role → target role
[profile chain-final]
role_arn       = arn:aws:iam::TARGET:role/FinalRole
source_profile = intermediate-role

[profile intermediate-role]
role_arn       = arn:aws:iam::INTERMEDIATE:role/IntermediateRole
source_profile = default
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `ExpiredTokenException` | SSO/role session expired | `aws sso login --profile <p>` or re-assume |
| `NoCredentialProviders` | No credentials at all | `aws configure` or `aws sso login` |
| `AccessDenied` | Missing IAM permission | Review role's IAM policy |
| `InvalidClientTokenId` | Wrong access key ID | Check `AWS_ACCESS_KEY_ID` or profile |
| `AuthFailure` | Wrong secret / key deleted | Regenerate or reconfigure credentials |
