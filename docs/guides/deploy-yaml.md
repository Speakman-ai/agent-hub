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

| Key                      | Required | Meaning                                                                                                                                                          |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose`                | yes      | Compose file path, relative to the repo root. Absolute paths and `..` escapes are rejected.                                                                      |
| `service`                | yes      | Compose service whose port is exposed to the user.                                                                                                               |
| `port`                   | yes      | Container port on `service` (integer, 1 to 65535).                                                                                                               |
| `health`                 | no       | Health probe path on that port. Must start with `/`. Default `/`.                                                                                                |
| `health_timeout_minutes` | no       | How long `health` may take to answer after `docker compose up` returns, 1 to 60. Default 5. Raise it when `health` points at an API that migrates on first boot. |
| `steps`                  | no       | Build or seed steps (`name`, `run`) run in order after `docker compose up`.                                                                                      |
| `secrets`                | no       | Names of project preview secrets to inject as env.                                                                                                               |

`environments` may be omitted when `preview` is present, so a project can
declare its PR environment before it has any deploy targets.

### Lifecycle

Each pull request gets at most one environment, keyed by the PR (project,
source, number) and never by the chat session that wrote it, so any head
branch name works. The `preview:` block is read at the PR's head commit.

Environments are opt-in. Opening a PR does not boot anything; someone clicks
**Start environment** on the PR page (or calls `preview/start`). The rows below
marked "once started" only apply to a PR that already has an environment.

| Trigger                                                                               | Effect                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Start environment** / `POST /api/projects/{projectId}/pulls/{number}/preview/start` | Start or retry (rebuilds a failed/stopped one) |
| PR opened                                                                             | Nothing                                        |
| New commits on the PR head (once started)                                             | Tear down and rebuild at the new commit        |
| PR reopened (once started)                                                            | Rebuild at the head commit                     |
| PR merged or closed                                                                   | Tear down; status `stopped`                    |
| Head commit drops the `preview:` block                                                | Tear down; status `stopped`                    |
| `POST .../preview/stop`                                                               | Tear down; new commits do not restart it       |

Statuses are `queued`, `building`, `ready`, `failed`, and `stopped`. An environment
stays `queued` until a runner backend picks it up; the build itself is done
by the runtime registered with `setPrEnvironmentRuntime`
(`server/preview/pr-environments.ts`).
`GET .../preview/state` returns the row with its URL, error, and log tail;
the PR page on web and mobile renders the same.

PR environments cover Agent Hub-hosted PRs.

### URL

With wildcard preview ingress configured (`AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`,
which Terraform sets when `enable_preview_subdomain = true`), each environment
is served at `https://pr-<n>--<project>.<previewBase>/`. The Hub proxies that
host to the environment's runner, so the app runs at `/` (absolute asset paths
work with no base-path config) and websockets are proxied. The URL is stable
across rebuilds of the same PR. A queued, building, failed, stopped, or unknown environment answers
with a status page instead of a proxy error. So does an app that does not send response headers within 55 seconds (just under
the ALB's 60-second idle timeout; override with `AGENT_HUB_PR_ENV_RESPONSE_TIMEOUT_MS`).
Only the headers are bounded; a response that has started can stream for as long as it needs.

Without a preview base (a local or dev Hub), the URL is the direct upstream,
`http://localhost:<port>`.

### GitHub-hosted projects

Projects whose PRs live on GitHub (`githubRepo` set, not hosted on Agent Hub)
get PR environments too. The build is the same; what differs is where PR
state comes from: the GitHub API, read with the token of a project Owner who
can reach the repo. There is no GitHub webhook into the Hub, so an
environment starts from the PR environment panel, and every 5 minutes the Hub
re-reads each running environment's PR: a new push rebuilds it, a merge or
close stops it. Share links work the same way; Admins and Owners manage them,
since a GitHub author is not a Hub user.

### Access and share links

Behind wildcard ingress an environment is private. Anyone without access gets
an access page, never the app:

- **Hub members** open it from the PR environment panel on the PR page. The
  Open link fetches a single-use ticket (60 seconds) and the browser gets a
  12-hour session for that environment.
- **People outside Agent Hub** use a share link. Admins, Owners, and the PR
  author create links from the same panel with an expiry of 1 to 30 days and
  an optional label. Project members can copy active links; Admins, Owners,
  the PR author, and the link's creator can revoke them.
  Opening a link sets an HttpOnly cookie on that environment's host only, and
  revoking it locks out browsers that already hold the cookie. A link opens
  exactly one environment and is not accepted by any Hub API route.
- **Project password (optional).** An Admin or Owner can set a share password
  for the project. Share-link visitors then enter it once per browser (12
  hours); members are not asked. Changing or removing it signs out everyone
  who unlocked with the old one.

The app never sees these credentials: the ingress strips its `ah_pr_env*`
cookies before proxying. The path `/__agent-hub/unlock` on an environment host
belongs to the ingress (the password form).

When an environment first becomes ready, Agent Hub posts a comment on the PR
with its URL and edits that same comment on every rebuild. On an Agent Hub-hosted
project this is a PR conversation comment; on a GitHub-hosted project it is a
GitHub issue comment posted with a project Owner's GitHub token (skipped when no
Owner's token can reach `githubRepo`).

On the runner fleet, the Hub reaches environments on the runners' private IPs.
Terraform opens Docker's ephemeral port range (32768-60999) on the runner
security group to the Hub's security group only
(`enable_pr_environment_ingress`, on by default with the fleet).

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
