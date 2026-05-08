# op run Recipes — Safe Secret Injection

`op run` is the safest way to inject secrets into a subprocess: secrets are
passed as env vars directly to the child process and never appear in the shell
history, model context, or logs.

Back to [SKILL.md](../SKILL.md).

Docs:
- `op run`: https://developer.1password.com/docs/cli/secret-references/#use-op-run-to-inject-secrets-into-environment-variables
- `op inject`: https://developer.1password.com/docs/cli/secrets-config-files

## Contents

- [op run — basics](#op-run--basics)
- [Loading from a .env template](#loading-from-a-env-template)
- [CI/CD recipes](#cicd-recipes)
- [Cron/heartbeat patterns](#cronheartbeat-patterns)
- [Debugging without leaking values](#debugging-without-leaking-values)

## op run — basics

```bash
# Inject specific env vars by referencing secrets inline
OP_AWS_KEY=op://Personal/AWS/access_key_id \
OP_AWS_SECRET=op://Personal/AWS/secret_access_key \
  op run -- aws s3 ls

# The child process sees AWS_KEY and AWS_SECRET resolved to plaintext.
# The agent's shell history only shows the op:// references, not values.
```

When `op run` sees a variable whose value starts with `op://`, it resolves
the secret before exec-ing the child command. Variables that don't start with
`op://` are passed through unchanged.

Agent Hub wrapper:

```bash
# Forward all remaining args to op run
scripts/op-run.sh -- npm run deploy

# With extra env vars (op:// refs are resolved; others pass through)
DB_URL=op://Shared/Prod DB/connection_string \
  scripts/op-run.sh -- rails db:migrate
```

## Loading from a .env template

For commands that need many secrets, define them in a template file and use
`--env-file`:

```env
# .env.tpl (committed to repo — contains only op:// references, no values)
DATABASE_URL=op://Shared/Production DB/connection_string
REDIS_URL=op://Shared/Redis/url
API_KEY=op://Team/My Service/credential
```

```bash
# op resolves all op:// references and injects them before exec
op run --env-file .env.tpl -- node server.js

# Agent Hub wrapper
scripts/op-run.sh --env-file .env.tpl -- node server.js
```

> **Commit `.env.tpl`, not `.env`.**  
> The template contains only symbolic references (safe to commit). The resolved
> file never touches disk.

## CI/CD recipes

### GitHub Actions (Service Account)

```yaml
env:
  OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}

steps:
  - uses: 1password/install-cli-action@v1
  - run: op run --env-file .env.tpl -- ./deploy.sh
```

### Docker / docker-compose (op inject)

Generate a resolved `.env` file ephemerally, then delete it:

```bash
op inject -i .env.tpl -o /tmp/deploy.env
docker-compose --env-file /tmp/deploy.env up -d
rm -f /tmp/deploy.env
```

### Makefile recipe

```makefile
deploy: .env.tpl
    op run --env-file $< -- $(MAKE) _do_deploy

_do_deploy:
    ./scripts/deploy.sh
```

## Cron/heartbeat patterns

Cron and heartbeat sessions have `OP_SERVICE_ACCOUNT_TOKEN` injected
automatically when it's stored in Agent Hub's credential store. You can
use `op run` in a cron prompt like any other session:

```bash
# In a cron prompt script
op run --env-file /path/to/.env.tpl -- python3 /opt/jobs/sync.py
```

If `OP_SERVICE_ACCOUNT_TOKEN` is missing in a cron context, `scripts/_common.sh`
exits with an actionable error pointing to the Service Account setup guide —
it will not silently fall back to an interactive session.

## Debugging without leaking values

```bash
# Check which identity op is using (no secrets in output)
op whoami

# List items to confirm vault access (no field values returned)
op item list --vault Personal

# Dry-run: verify op can resolve the references without actually running the command
op run --dry-run -- echo "Would run with injected env"
```

Never use `op read` in a context where the output is captured by the model or
logged. Use `scripts/op-read.sh` instead, which pipes output through the
redaction helper before any agent sees it.
