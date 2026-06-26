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
- Each step needs a non-empty `run` string.
- `approval` is optional and defaults to false. Default production to true.
- `runs-on` defaults to `ubuntu-24.04`.
- `timeout_minutes` is optional, integer, 1 to 240.
- Unknown keys fail validation.

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
