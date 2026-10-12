# `.agent-hub/deploy.yaml`

`deploy.yaml` declares how a project ships. It has two independent parts:

- `environments`: named deploy targets (dev, staging, production), each an
  ordered list of steps the Deployment Module runs on a runner.
- `preview`: what a **PR environment** boots, the end-user-facing build of a
  pull request.

The parser lives in `server/deploy/deploy-config.ts` (`preview` in
`server/deploy/deploy-preview-config.ts`). Unknown keys anywhere are hard
errors, and every failure is a `DeployConfigError` with a stable `reason`.

## `environments`

```yaml
version: 1
environments:
  staging:
    steps:
      - name: deploy
        run: ./scripts/deploy-staging.sh
  production:
    approval: true
    steps:
      - run: ./scripts/deploy-production.sh
```

See the `deploy-setup` skill for the full environment and step reference
(`approval`, `runs-on`, `timeout_minutes`, `origin`, `readiness`,
`github_workflow` steps).

## `preview`

Session previews (`prEnv.devServer`) run a dev server with HMR for the agent
and the operator. That is the wrong thing to hand an end user, so a PR
environment boots the project's own compose stack instead, declared here.

| Key       | Required | Meaning                                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------------------- |
| `compose` | yes      | Compose file path, relative to the repo root. Absolute paths and `..` escapes are rejected. |
| `service` | yes      | Compose service whose port is exposed to the user.                                          |
| `port`    | yes      | Container port on `service` (integer, 1 to 65535).                                          |
| `health`  | no       | Health probe path on that port. Must start with `/`. Default `/`.                           |
| `steps`   | no       | Build or seed steps (`name`, `run`) run in order after `docker compose up`.                 |
| `secrets` | no       | Names of project preview secrets to inject as env.                                          |

`environments` may be omitted when `preview` is present, so a project can
declare its PR environment before it has any deploy targets.

### Lifecycle

Each pull request gets at most one environment, keyed by the PR (project,
source, number) and never by the chat session that wrote it, so any head
branch name works. The `preview:` block is read at the PR's head commit.

| Trigger                                                       | Effect                                         |
| ------------------------------------------------------------- | ---------------------------------------------- |
| PR opened or reopened                                         | Queue a build at the head commit               |
| New commits on the PR head                                    | Tear down and rebuild at the new commit        |
| PR merged or closed                                           | Tear down; status `stopped`                    |
| Head commit drops the `preview:` block                        | Tear down; status `stopped`                    |
| `POST /api/projects/{projectId}/pulls/{number}/preview/start` | Start or retry (rebuilds a failed/stopped one) |
| `POST .../preview/stop`                                       | Tear down; new commits do not restart it       |

Statuses are `queued`, `building`, `ready`, `failed`, and `stopped`. An environment
stays `queued` until a runner backend picks it up; the build itself is done
by the runtime registered with `setPrEnvironmentRuntime`
(`server/preview/pr-environments.ts`).
`GET .../preview/state` returns the row with its URL, error, and log tail;
the PR page on web and mobile renders the same.

PR environments cover Agent Hub-hosted PRs.

### Secrets

`secrets` lists names only. Values live in the project secrets store
(`server/preview/preview-secrets-store.ts`, the same encrypted store session
previews use) and are decrypted when the PR environment boots. Only the listed
names are read, and the audit log records the names, never the values.

A name that is not in the store fails validation with reason
`unknown_preview_secret`; the error lists the missing names. Names must be env
var identifiers and may not use the reserved namespace (`AGENT_HUB_*`,
`NODE_*`, `PATH`, `HOME`).

Two endpoints read the block:

- `GET /api/projects/{projectId}/deploy/preview` is the strict check. It
  returns the block only when every name resolves, and a 400 listing the
  missing names otherwise.
- `GET /api/projects/{projectId}/deploy/config` always returns the block with
  a `missingSecrets` array, so the Deployments page can flag gaps without
  failing.

### Worked example: app + Postgres + seed

`docker-compose.preview.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: app
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 2s
      retries: 30
  app:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/app
      STRIPE_SECRET_KEY: ${STRIPE_TEST_KEY}
    depends_on:
      db:
        condition: service_healthy
    expose:
      - '3000'
```

`.agent-hub/deploy.yaml`:

```yaml
version: 1
preview:
  compose: docker-compose.preview.yml
  service: app
  port: 3000
  health: /healthz
  steps:
    - name: migrate
      run: docker compose -f docker-compose.preview.yml exec -T app npm run db:migrate
    - name: seed
      run: docker compose -f docker-compose.preview.yml exec -T app npm run db:seed
  secrets:
    - POSTGRES_PASSWORD
    - STRIPE_TEST_KEY
environments:
  production:
    approval: true
    steps:
      - run: ./scripts/deploy-production.sh
```

`POSTGRES_PASSWORD` and `STRIPE_TEST_KEY` must exist in the project's secrets.
The compose file reads them through `${...}` interpolation, so no value is
committed to the repo. Use test-mode keys here: a PR environment is reachable
by whoever has the PR link.
