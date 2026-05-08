# AWS Profiles & Region Resolution

Back to [SKILL.md](../SKILL.md).

## Install AWS CLI v2

| Platform | Command |
|---|---|
| macOS | `brew install awscli` |
| Linux (x86_64) | `curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip && unzip /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install` |
| Windows | MSI from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |

Verify: `aws --version` → must show `aws-cli/2.x`

---

## Credential File Locations

| File | Purpose |
|---|---|
| `~/.aws/credentials` | Access Key ID + Secret (static credentials) |
| `~/.aws/config` | Profiles, regions, SSO config, role configs |

Example `~/.aws/credentials`:
```ini
[default]
aws_access_key_id     = AKIAxxxxxxxxxxxxxxxx
aws_secret_access_key = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

[staging]
aws_access_key_id     = AKIAyyyyyyyyyyyyyyyy
aws_secret_access_key = yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
```

Example `~/.aws/config`:
```ini
[default]
region = us-east-1
output = json

[profile staging]
region = us-west-2
output = json

[profile prod-sso]
sso_start_url  = https://my-org.awsapps.com/start
sso_region     = us-east-1
sso_account_id = 123456789012
sso_role_name  = AdministratorAccess
region         = us-east-1
output         = json
```

Note: The `credentials` file uses bare section names (`[staging]`); the `config`
file uses `[profile staging]` — the `profile ` prefix is required for non-default
profiles in `config`.

---

## Profile Resolution Order (`scripts/_common.sh`)

1. `AWS_CLI_PROFILE` — set by `--profile` flag in wrapper scripts
2. `AWS_PROFILE` — exported in shell or Agent Hub env
3. `AWS_DEFAULT_PROFILE` — legacy env var
4. `default` — fallback

## Region Resolution Order

1. `AWS_CLI_REGION` — set by `--region` flag
2. `AWS_REGION` — explicit env var
3. `AWS_DEFAULT_REGION` — legacy env var
4. `aws configure get region --profile <profile>` — profile config
5. `us-east-1` — final fallback

**Always state the resolved profile and region** in responses so the user knows
which account/region was targeted.

---

## Useful Commands

```bash
# List all configured profiles
aws configure list-profiles

# Show effective config for a profile
aws configure list --profile staging

# Set a value for a profile
aws configure set region eu-west-1 --profile staging

# Override profile for a single command
aws ec2 describe-instances --profile staging --region eu-west-1

# Environment variable override (applies to all aws calls in the shell)
export AWS_PROFILE=staging
export AWS_REGION=eu-west-1
aws ec2 describe-instances
```

---

## Environment Variable Reference

| Variable | Purpose |
|---|---|
| `AWS_PROFILE` | Active named profile |
| `AWS_DEFAULT_PROFILE` | Legacy alias for `AWS_PROFILE` |
| `AWS_REGION` | Override region |
| `AWS_DEFAULT_REGION` | Legacy alias for `AWS_REGION` |
| `AWS_ACCESS_KEY_ID` | Static key ID (overrides profile credentials) |
| `AWS_SECRET_ACCESS_KEY` | Static secret (overrides profile credentials) |
| `AWS_SESSION_TOKEN` | Temporary session token (required for assumed roles / SSO) |
| `AWS_CONFIG_FILE` | Custom path to config file (default: `~/.aws/config`) |
| `AWS_SHARED_CREDENTIALS_FILE` | Custom path to credentials file |

---

## Multiple Accounts / Regions

For multi-account work, use named profiles:

```bash
# Audit all regions for a service
for region in us-east-1 us-west-2 eu-west-1 ap-southeast-1; do
  echo "=== ${region} ==="
  aws ec2 describe-instances \
    --profile prod \
    --region "${region}" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name]' \
    --output table
done
```
