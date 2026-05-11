# Preview Model — Worktree Previews Only

**Status:** Canonical as of 2026-05-11 (epic *Strip PR Environments — In-Session Worktree Previews Only*).

This page is the answer to: **"When I'm working in Agent Hub, how do I see the change I just made?"** It also answers: **"How do I show stakeholders a preview of an open PR?"** — and the answer to the second question is no longer Agent Hub's responsibility.

---

## TL;DR

| Question | Answer |
|----------|--------|
| Preview an in-progress change inside a chat session? | **Yes** — Agent Hub spins up a per-session preview against the active worktree (`<agenthub:preview>`). |
| Preview an open PR on a public URL? | **No** — wire your CI provider's preview-deploy feature (Vercel, Netlify, Render, Fly, Cloudflare Pages). |
| Per-PR container pool, wildcard ACM cert, DNS-01 preview hostnames? | **Removed.** All of the PR-environments subsystem was stripped in this epic. |

---

## What Agent Hub ships

### Worktree previews (`<agenthub:preview>`)

When an agent emits `<agenthub:preview>` in a chat turn, the per-session **PreviewRuntime** boots the project's dev server (`prEnv.preview.startScript`, defaulting to `npm run dev`) inside the session's git worktree, allocates a host port in the `4100–4999` range, and returns a URL the chat client can render in an iframe.

Targets:

- **`client`** — boots the frontend dev server (Vite, CRA, Storybook).
- **`server`** — boots the backend in the worktree.

No `fullstack` target. Full-stack verification rides the normal PR review flow plus whatever preview-deploy the team has configured at the CI layer (see below).

Operational details — port range, idle TTL, reaper, SIGTERM-to-process-group teardown — live at [`worktree-previews-per-session-preview-runtime-reaper`](/projects/agent-hub/wiki/worktree-previews-per-session-preview-runtime-reaper).

### What this gives you

- A live preview tied to the **current edit state** — no commit, no push, no PR required.
- One preview per session; replaced if `startPreview()` is called again.
- Auto-reaped after idle TTL (default 600 s) or session-end.
- Zero per-deploy infrastructure on the Agent Hub host (no ACM certs, no DNS-01, no container pool, no preview hostname).

---

## What Agent Hub no longer ships

The PR-environments subsystem (sometimes called "PR envs" or "container pool") was removed in this epic. Specifically gone:

| Subsystem | What it did | Replacement |
|-----------|-------------|-------------|
| Per-PR preview hostnames (`pr-123.preview.example.com`) | DNS-01 wildcard ACM cert + Route53 `*.preview` zone | CI provider's preview-deploy URL (Vercel/Netlify/Render/Fly/Cloudflare Pages) |
| Container pool (`server/container-pool/*`) | Pre-warmed Docker containers for incoming PRs | Same — your CI builder produces ephemeral preview env |
| Provisioning wizard (Settings → PR Environments) | One-click prereq check + IAM/cert/Reviewer setup | Wizard is gone; wire CI provider in your repo settings |
| `<agenthub:preview target="fullstack">` | Drafted a PR and polled the PR-env container pool | Removed — open a real PR, let CI build a preview |
| Terraform: wildcard ACM cert, preview A-record, `pr_env_*` IAM, 3100–3999 SG ingress, host nginx bootstrap | Per-PR ingress on the EC2 host | Removed in PR #886 — operator runs `terraform apply` to destroy live state |

Archived wiki pages (banner-marked, kept for historical context):

- [`pr-environments-out-of-box-contract`](/projects/agent-hub/wiki/pr-environments-out-of-box-contract)
- [`pr-environments-ui-configuration-secret-store`](/projects/agent-hub/wiki/pr-environments-ui-configuration-secret-store)
- [`pr-environments-provisioning-wizard-v1-spec`](/projects/agent-hub/wiki/pr-environments-provisioning-wizard-v1-spec)
- [`pr-environments-per-project-config-wizard-script-mode-builder`](/projects/agent-hub/wiki/pr-environments-per-project-config-wizard-script-mode-builder)
- [`container-pool-pr-envs-scaffolding`](/projects/agent-hub/wiki/container-pool-pr-envs-scaffolding)
- [`container-pool-w4-observability-metrics-alerts-dashboard`](/projects/agent-hub/wiki/container-pool-w4-observability-metrics-alerts-dashboard)
- [`runbook-container-pool-top-5-failures`](/projects/agent-hub/wiki/runbook-container-pool-top-5-failures)
- [`worktree-previews-fullstack-target-draft-pr-pr-env-container`](/projects/agent-hub/wiki/worktree-previews-fullstack-target-draft-pr-pr-env-container)

---

## Why we made this trade

Per-PR preview environments are a **deployment concern**, not an agent-workspace concern. The PR-env stack was duplicating what every modern CI provider already gives away for free, while forcing the Agent Hub host to act as a multi-tenant deploy target — wildcard ACM cert lifecycle, per-PR DNS, container saturation, eviction policy, IAM scoping. That overhead grew faster than the value: most users wanted a preview URL on a PR, not a bespoke deploy platform.

Agent Hub keeps the part that **no CI provider can give you**: a live preview against the agent's in-flight edits, before there's a commit to push. Everything past that point is downstream of `git push`, which is exactly where CI providers excel.

---

## Recommended user-side patterns

If you need per-PR preview URLs, wire one of these in your repo. None of them require anything from Agent Hub.

### Vercel

- **Best for:** Next.js, SvelteKit, Astro, Nuxt, React frontends.
- **Setup:** Install the Vercel GitHub App on the repo; Vercel auto-creates `preview` deployments for every PR and posts the URL as a status check.
- **Docs:** <https://vercel.com/docs/deployments/preview-deployments>

### Netlify

- **Best for:** Static sites, Gatsby, Hugo, Jekyll, plain React/Vue SPAs.
- **Setup:** Connect the repo in Netlify; **Deploy Previews** are on by default for every PR. URL appears as a check + a PR comment.
- **Docs:** <https://docs.netlify.com/site-deploys/deploy-previews/>

### Render

- **Best for:** Full-stack apps (Node/Python/Go services + Postgres + Redis), monorepos.
- **Setup:** In a service's settings enable **Preview Environments** and add a `render.yaml` blueprint describing the env. Render spins up an isolated copy per PR.
- **Docs:** <https://docs.render.com/preview-environments>

### Fly.io

- **Best for:** Containerized apps that need real network/region semantics, or already-Dockerized backends.
- **Setup:** Use the [`superfly/fly-pr-review-apps`](https://github.com/superfly/fly-pr-review-apps) GitHub Action to deploy a per-PR app instance on `pr-<number>-<app>.fly.dev`. Cleanup runs when the PR closes.
- **Docs:** <https://fly.io/docs/blueprints/review-apps-guide/>

### Cloudflare Pages

- **Best for:** Static sites, edge functions, hybrid SPA + Workers.
- **Setup:** Connect the repo; **Preview deployments** are automatic on every non-production branch and PR. URL is `<branch>.<project>.pages.dev`.
- **Docs:** <https://developers.cloudflare.com/pages/configuration/preview-deployments/>

### Rolling your own with GitHub Actions

If you have an existing Kubernetes / Nomad / Docker host you'd rather use, a simple pattern is:

1. `pull_request` workflow: `docker build` + `docker push` tagged with `pr-<number>`.
2. `helm upgrade --install pr-<number> ...` (or `nomad job run`, or `terraform apply` against a per-PR workspace).
3. `pull_request:closed` workflow: tear down the same release.
4. A `peter-evans/create-or-update-comment` step posts the preview URL on the PR.

The cost / scope of this is what Agent Hub used to take on with the PR-env subsystem. Outsourcing it to the team's CI provider — or to a dedicated GH Actions workflow you own — keeps the deployment concern off the agent platform.

---

## Migration checklist (for existing users)

If you were using the PR-environments feature:

1. **Disable any `prEnv.enabled` flags** in `projects.json` — they're now no-ops.
2. **Pick one of the CI patterns above** and wire it on the repos that need preview URLs.
3. **Update PR templates / docs** to point at the new preview URL instead of `pr-<n>.preview.your-host`.
4. **Operator only:** run `terraform apply` against your live state to destroy the wildcard cert + Route 53 records left over from PR #886's code-only teardown.
5. Keep the worktree-preview block (`<agenthub:preview target="client|server">`) for in-session previews — it still works and is the recommended way for agents to verify their edits.

---

## See also

- [`worktree-previews-per-session-preview-runtime-reaper`](/projects/agent-hub/wiki/worktree-previews-per-session-preview-runtime-reaper) — the runtime that backs in-session previews
- Archived pages above for historical context on the removed subsystem
