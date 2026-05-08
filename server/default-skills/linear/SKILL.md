---
name: linear
description: >-
  Query and manage Linear issues, projects, cycles, and comments via the
  GraphQL API. TRIGGER when: the user mentions "Linear", references a
  "LIN-<number>" issue identifier (e.g. LIN-42), asks to file, create, update,
  close, move, comment on, or search a Linear ticket or issue, asks about a
  Linear team, project, cycle, or workflow state, or says "log this in Linear"
  / "create a Linear issue". DO NOT TRIGGER on: "linear algebra", "linear
  regression", "linear interpolation", "linear programming", "linear scale",
  "linear gradient", or any unrelated mathematical / CSS / scientific usage of
  the word "linear" — only trigger when "Linear" clearly refers to the
  Linear.app project-management tool.
category: integration
version: 1.0.0
keep-coding-instructions: true
credentials:
  - name: LINEAR_API_KEY
    label: Linear API Key
    description: >-
      Personal API key from Linear (Settings → API → Personal API keys).
      Stored encrypted in Agent Hub — never paste into chat.
    required: false
    type: secret
    docs_url: https://linear.app/settings/api
---

# Linear

Use this skill to interact with your Linear workspace — query issues, create
tickets, comment, transition states, manage projects, and more.

## Prerequisites

Set `LINEAR_API_KEY` under **Settings → Skills → Credentials** and it will be
injected automatically into every agent session. Alternatively, export it in
the host shell before spawning the agent:

```bash
export LINEAR_API_KEY="lin_api_xxxxxxxxxxxxxxxx"
```

To mint a key: **Linear → Settings → API → Personal API keys → Create key**.

The wrapper scripts require **`python3`** (3.7+) and **`curl`** on `$PATH`.
These are present by default on macOS, standard Linux distros, and the
Agent Hub EC2 host.

## Safety Model — Read-default, Write-on-confirm

**Read operations** (list, get, search) run immediately.
**Write operations** (create, update, comment, transition) should be confirmed
with the user before executing, unless the user has already given explicit
approval ("go ahead", "do it", "create it").

Show a brief summary of what will change before running any mutation.

> **This is a behavioural contract on the agent, not a runtime guard in the
> scripts.** The wrappers will execute a mutation the moment they are invoked —
> the agent is responsible for asking first. Never call `issue create`,
> `issue update`, or `issue comment` without prior user confirmation or an
> explicit instruction to proceed.

## Quick Reference

```bash
# All commands below are implemented in scripts/linear.sh
# Source scripts/_common.sh for auth + the linear_gql() helper

# List teams
scripts/linear.sh team list

# List projects (optionally filter by team)
scripts/linear.sh project list [--team <teamId>]

# List workflow states for a team
scripts/linear.sh state list --team <teamId>

# List cycles for a team
scripts/linear.sh cycle list --team <teamId>

# List issues
scripts/linear.sh issue list [--team <teamId>] [--state <stateName>] [--limit <n>]

# Get a single issue
scripts/linear.sh issue get <LIN-42 | issueId>

# Search issues
scripts/linear.sh issue search "<query>"

# Create an issue (prompts for confirmation first)
scripts/linear.sh issue create --title "Bug: login fails" --team <teamId> \
  [--description "..."] [--state <stateName>] [--priority urgent|high|medium|low|no]

# Update an issue (show plan, then execute)
scripts/linear.sh issue update <issueId> [--title "..."] [--state <stateName>] \
  [--assignee <userId>] [--priority urgent|high|medium|low|no]

# Add a comment
scripts/linear.sh issue comment <issueId> --body "LGTM, merging."

# List comments on an issue
scripts/linear.sh issue comments <issueId>
```

## Full Reference

- **[references/api-overview.md](references/api-overview.md)** — GraphQL endpoint,
  pagination, common queries & mutations, error handling
- **[references/auth.md](references/auth.md)** — API key vs OAuth, per-user
  credential resolution, how to mint a key
- **[references/webhooks.md](references/webhooks.md)** — webhook registration,
  event payloads, HMAC verification

## Guardrails

- Never log or surface the API key in chat, daily notes, or card descriptions.
- Respect team-level issue visibility (private teams require membership).
- Rate limits apply (≈1 500 req / min queries; 100 req / min mutations) — back off
  on `429` responses and retry with exponential jitter.
