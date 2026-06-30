---
name: deploy-setup
description: >-
  Guided walkthrough for authoring `.agent-hub/deploy.yaml` deployment
  environments. Triggered by POST .../deploy/setup-wizard. Reads the target
  repo, asks which environments to configure, maps each environment to deploy
  commands and secrets, validates the schema, then commits the config locally.
version: 1.0.0
keep-coding-instructions: true
---

# Deploy Setup - Guided Walkthrough

You are a worktree-backed setup session. Author `.agent-hub/deploy.yaml` in
this session branch, validate it, commit it locally, and stop. Finalize Code
Changes handles review and push. Do not edit the primary project checkout.

## Bound Values

- `PROJECT_ID`, `PROJECT_CWD`, and `YOUR SESSION_ID` are in the kickoff prompt.
- `$AGENT_HUB_URL` and `$AGENT_HUB_API_KEY` are available for Hub API calls. If a
  Hub API call returns HTTP 401 or 403, halt and report the auth failure. Never
  ask the operator to paste a token into chat.

## Schema

`deploy.yaml` version 1:

```yaml
version: 1
environments:
  staging:
    runs-on: ubuntu-24.04
    timeout_minutes: 60
    steps:
      - name: deploy
        run: ./scripts/deploy-staging.sh
  production:
    approval: true
    runs-on: ubuntu-24.04
    timeout_minutes: 60
    steps:
      - name: deploy
        run: ./scripts/deploy-production.sh
```

Rules:

- `version` must be `1`.
- `environments` is a non-empty map.
- Each environment needs `steps`, a non-empty list.
- Each step needs EITHER a non-empty `run` string OR a `github_workflow` block
  (not both).
- `approval` is optional and defaults to false. Default production to true.
- `runs-on` defaults to `ubuntu-24.04`.
- `timeout_minutes` is optional, integer, 1 to 240.
- Unknown keys fail validation.

### github_workflow steps (dispatch + wait for a GitHub Action)

When a deploy should kick off a GitHub Actions workflow and WAIT for it to
succeed or fail (instead of returning the moment `gh workflow run` queues it),
use a `github_workflow` step. Agent Hub dispatches the workflow, polls the
resulting run to completion, fails the step (and the deploy, fail-fast) if the
run does not conclude `success`, and surfaces the run's URL + conclusion on the
Deployments page.

```yaml
steps:
  - name: Release
    github_workflow:
      workflow: release.yml # workflow file name or numeric id (required)
      ref: main # REQUIRED branch or tag to dispatch (NOT a commit SHA)
      inputs: # optional workflow_dispatch inputs
        bump: patch
      poll_interval_seconds: 10 # optional (default 10, 5 to 300)
```

`ref` is required and must be a **branch or tag name**. GitHub
`workflow_dispatch` only accepts a branch/tag for its ref — a commit SHA is
rejected — and a deploy's ref is frequently a resolved SHA, so there is
intentionally no deploy-ref default. Name the branch (or tag) the workflow
should run on.

The workflow must declare `on: workflow_dispatch`. The dispatch runs as the
triggering user (their GitHub token is injected) and targets the project's
configured GitHub repo, so this works even for self-hosted-forge projects.

## Walkthrough

1. Read the repo's README, package manifests, `.github/workflows/*`, deploy
   scripts, Docker files, Terraform or infra folders, and release docs.
2. Summarize how the repo ships today in 2 to 4 sentences.
3. Use fenced `agenthub:ask` to choose environments. Good defaults:
   `staging + production`, `dev + staging + production`, or `production only`.
4. For each environment, identify the deploy command and required secrets. If the
   repo has multiple plausible commands, ask with concrete options from the repo.
5. Create or edit `.agent-hub/deploy.yaml`.
6. Validate the YAML. For Agent Hub itself, run the deploy-config parser tests if
   practical. For other repos, run a lightweight parser check when the dependency
   is available.
7. Commit the config locally on this setup session branch. Do not push or open a
   PR.
8. Report the configured environments and the user-visible behavior change.

## Ask Blocks

Use only fenced `agenthub:ask` blocks. JSON must use `question`, `header`,
`options[].label`, and `options[].description`. Do not use `prompt`, `id`, or
`type`.

## Finish

Close the linked card only when `.agent-hub/deploy.yaml` is committed:

```xml
<agenthub:close-card>
{"reason": "already-done", "note": "deploy.yaml setup committed locally for Finalize."}
</agenthub:close-card>
```
