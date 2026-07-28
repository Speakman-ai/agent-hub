# Runbook: Restore subdomain preview mode (live HMR previews)

**Symptom:** Session previews don't hot-reload / don't show branch changes live.
Every project sharing the Hub's ALB is affected at once because subdomain mode
is **Hub-wide**.

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
previews. Diagnosed by: `*.preview.agenthub.example.com` did not resolve and
the ALB cert had only the apex SAN.

## Restore steps

### 1. Re-provision infra (Terraform — needs AWS apply)

Preconditions (already true on the agenthub.example.com deploy): the apex
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
terraform output preview_subdomain_base   # -> preview.agenthub.example.com
```

DNS + ACM DNS-01 validation propagation takes a few minutes. Verify:

```bash
dig +short test.preview.agenthub.example.com          # resolves to the ALB
echo | openssl s_client -servername x.preview.agenthub.example.com \
  -connect agenthub.example.com:443 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName                # SAN includes *.preview.…
```

### 2. Re-arm the Hub (operator)

```bash
# /home/agenthub/agent-hub/.env  — add:
AGENT_HUB_PREVIEW_SUBDOMAIN_BASE=preview.agenthub.example.com

sudo systemctl restart agenthub-server
docker exec agenthub-server printenv AGENT_HUB_PREVIEW_SUBDOMAIN_BASE   # confirm
```

The cert/DNS without the env var (or vice-versa) is a no-op — both are required.

### 3. Switch each project's preview to a dev server (per repo)

Only after steps 1–2 verify green. In path mode this step white-screens the
preview, which is why it must come last. Each repo declares a `prEnv.devServer`
block: the Hub spawns `startCommand` as a managed long-lived process against the
session worktree and maps `portMap[]` out through the preview proxy. There is no
bind mount to arrange — the process reads the worktree directly, so HMR
file-watching sees agent edits without any `entryWorkdir`/`shadowDirs` wiring.

**agent-hub** (`.agent-hub/preview.json`, `prEnv.devServer`):

```jsonc
"startCommand": "export AGENT_HUB_PREVIEW=1 AGENT_HUB_PORT=3151 ...; exec npm run dev",
"portMap": [
  { "internalPort": 3050, "label": "client", "primary": true },
  { "internalPort": 3151, "label": "api" }
],
"healthPath": "/"
```

Three constraints that are easy to get wrong:

- **Bind `$PORT`, not the configured port.** The runtime announces the primary
  entry's mapping as `PORT` — a pool-allocated host port on the host session-env
  backend, the configured `internalPort` under sysbox. `client/vite.config.ts`
  reads it through `buildPreviewServerConfig` (gated on `AGENT_HUB_PREVIEW=1`).
- **Allow the upstream Host.** The proxy forwards
  `Host: $AGENT_HUB_PREVIEW_HEALTH_HOST`, which Vite 5 403s unless it is in
  `server.allowedHosts`. `resolvePreviewAllowedHosts` always appends it alongside
  the `.<subdomain-base>` entry.
- **Keep the nested API off 3051.** On the host session-env backend the dev
  server shares a network namespace with the Hub, which already owns 3051, so
  agent-hub pins `AGENT_HUB_PORT=3151` and points its data dir at
  `.agent-hub-preview/` — otherwise the nested Hub opens the host Hub's SQLite
  database.

- **An Angular app** → `startCommand: "ng serve --host 0.0.0.0 --port $PORT"`.
- **Any other project** → its own dev server, same `$PORT` contract.

## Guardrail (so it can't silently regress again)

`enable_preview_subdomain` and `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE` must move
together. Consider a Terraform `check` block (see `ops/terraform/checks.tf`) or a
Hub startup warning that logs loudly when the wildcard cert exists but the env var
is unset (or vice-versa) — the half-configured state is what produced silent
static fallback here.
