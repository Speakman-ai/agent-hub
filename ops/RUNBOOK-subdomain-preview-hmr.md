# Runbook: Restore subdomain preview mode (live HMR previews)

**Symptom:** Session previews don't hot-reload / don't show branch changes live.
Every project sharing the Hub's ALB is affected at once (agent-hub, surveytracker,
field, …) because subdomain mode is **Hub-wide**.

## Why this happens

Live HMR requires **subdomain preview mode**. Without it the Hub serves previews
under a path prefix (`…/preview/proxy/`) and the proxy *strips* that prefix before
forwarding to the app, while injecting `<base href>`. That only rescues *relative*
URLs; a dev server (Vite, `ng serve`) emits *absolute* asset/HMR URLs
(`/@vite/client`) that ignore `<base href>` → 404 → white screen. So in path mode
every project is forced onto a static, rebuild-to-see-changes preview.

Subdomain mode serves each preview at `<sessionId>.preview.<alb_fqdn>`, the app
renders at `/`, and dev-server HMR Just Works.

Subdomain mode needs **all three** layers below. If any one is missing, previews
fall back to static and HMR is dead:

| Layer | Required | How to check |
|---|---|---|
| Wildcard cert + DNS + ALB listener | `*.preview.<alb_fqdn>` ACM cert, Route 53 alias, listener cert attachment | `dig +short x.preview.<alb_fqdn>` resolves; ALB cert SAN includes `*.preview.<alb_fqdn>` |
| Hub env var | `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE=preview.<alb_fqdn>` in `/home/agenthub/agent-hub/.env` | `docker exec agenthub-server printenv AGENT_HUB_PREVIEW_SUBDOMAIN_BASE` |
| Terraform toggle | `enable_preview_subdomain = true` | live tfvars / `terraform output preview_subdomain_base` |

**Known regression (2026-06):** a `terraform apply` ran with
`enable_preview_subdomain` back at its default `false`, which destroyed the
wildcard cert + Route 53 alias + listener attachment; the `.env` separately lost
`AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`. Result: all projects dropped to static
previews. Diagnosed by: `*.preview.agenthub.surveytracker.io` did not resolve and
the ALB cert had only the apex SAN.

## Restore steps

### 1. Re-provision infra (Terraform — needs AWS apply)

Preconditions (already true on the agenthub.surveytracker.io deploy): the apex
ACM cert + ALB exist, so `enable_dedicated_alb = true` and a Route 53 zone for
`base_domain` are in place. Set the toggle in the **live** tfvars (external /
gitignored — NOT committed; `terraform.tfvars.example` documents it):

```hcl
enable_preview_subdomain = true
```

```bash
cd ops/terraform
terraform plan    # expect: +aws_acm_certificate.preview_wildcard,
                  #         +aws_route53_record.preview_wildcard_{cert_validation,alias},
                  #         +aws_lb_listener_certificate.preview_wildcard
terraform apply
terraform output preview_subdomain_base   # -> preview.agenthub.surveytracker.io
```

DNS + ACM DNS-01 validation propagation takes a few minutes. Verify:

```bash
dig +short test.preview.agenthub.surveytracker.io          # resolves to the ALB
echo | openssl s_client -servername x.preview.agenthub.surveytracker.io \
  -connect agenthub.surveytracker.io:443 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName                # SAN includes *.preview.…
```

### 2. Re-arm the Hub (operator)

```bash
# /home/agenthub/agent-hub/.env  — add:
AGENT_HUB_PREVIEW_SUBDOMAIN_BASE=preview.agenthub.surveytracker.io

sudo systemctl restart agenthub-server
docker exec agenthub-server printenv AGENT_HUB_PREVIEW_SUBDOMAIN_BASE   # confirm
```

The cert/DNS without the env var (or vice-versa) is a no-op — both are required.

### 3. Switch each project's preview to a dev server (per repo)

Only after steps 1–2 verify green. In path mode this step white-screens the
preview, which is why it must come last. Each repo's `compose.preview.yml` entry
service runs its dev server, and `.agent-hub/preview.json` sets
`compose.entryWorkdir` (+ `entrySourceDir`, `shadowDirs`) so the Hub live-mounts
the worktree (the runtime translates the bind to the host path and writes the
override). HMR file-watching then sees agent edits directly.

**agent-hub** (`client` service → Vite dev server):

```yaml
# compose.preview.yml  (client service)
  client:
    image: ${AGENT_HUB_SERVER_IMAGE:-public.ecr.aws/h9t4v7h0/agent-hub:main}
    working_dir: /app/client
    command: ['sh', '-c', 'exec node_modules/.bin/vite --host 0.0.0.0 --port 80']
    environment:
      - FRONTEND_PORT=${FRONTEND_PORT:-80}
    depends_on:
      server:
        condition: service_healthy
    expose:
      - '80'
```

```jsonc
// .agent-hub/preview.json  (prEnv.preview.compose)
"entryWorkdir": "/app",      // live-mount the worktree here
"entrySourceDir": ".",       // mount the worktree root
"shadowDirs": []             // worktree already carries client/node_modules (vite)
```

In subdomain mode the app renders at `/`, so Vite needs **no** `base`/HMR-proxy
wiring — its defaults work. (`vite.config.js` already binds `0.0.0.0` and proxies
`/api` in dev; confirm the proxy target points at the `server` service when run in
the preview container.)

- **surveytracker** → `frontend` runs `ng serve --host 0.0.0.0` (drop the static
  `dockerfile.preview`/nginx path), same `entryWorkdir` mount.
- **field** → its dev server, same pattern.

## Guardrail (so it can't silently regress again)

`enable_preview_subdomain` and `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE` must move
together. Consider a Terraform `check` block (see `ops/terraform/checks.tf`) or a
Hub startup warning that logs loudly when the wildcard cert exists but the env var
is unset (or vice-versa) — the half-configured state is what produced silent
static fallback here.
