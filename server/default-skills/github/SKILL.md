---
name: github
description: >-
  Bash / gh CLI workflows against GitHub (issues, PRs, API) using the caller's PAT.
category: automation
version: 1.0.0
keep-coding-instructions: true
credentials:
  - name: GH_TOKEN
    label: GitHub personal access token
    description: >-
      Fine-grained or classic PAT with repo scope. Stored in Agent Hub Settings — never paste into chat.
      See https://github.com/settings/tokens
    required: false
    type: secret
    docs_url: https://github.com/settings/tokens
---

# GitHub

Use this skill when work targets **GitHub** (repos, PRs, issues, Actions, `gh` CLI).

## Prerequisites

When `GH_TOKEN` is configured under **Skills → Credentials**, it is injected into the agent shell automatically. Otherwise rely on signed-in GitHub from Settings or host `gh auth`.

Prefer `gh` for CLI operations; fall back to `curl` against `api.github.com` when needed.

## Guardrails

- Do not paste tokens into chat, daily notes, or kanban descriptions.
- Honour repository visibility and organisation policies.
