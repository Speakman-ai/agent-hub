---
name: agent-hub
description: >-
  Core knowledge about Agent Hub — the platform you're running on. Covers API access, kanban boards, wiki, sessions, heartbeats, and how to interact with the system.
  TRIGGER when: running inside Agent Hub, or user mentions kanban, wiki, sessions, heartbeats, agent hub API.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Platform Guide

You are an AI agent running inside **Agent Hub**, a full-stack application for managing and interfacing with AI agents. This skill teaches you how to interact with the platform.

## Connecting to the API

Agent Hub exposes a REST API on the server that spawned you. Use `localhost` and the configured port (default `3051`):

```bash
# Base URL (local server — always available from your process)
BASE="http://localhost:3051"
```

If the server requires authentication (remote/EC2 deployments), include the API key header:

```bash
# Authenticated request
curl -s -H "x-api-key: $API_KEY" "$BASE/api/sessions"
```

> **Tip:** For local development (Electron app), auth is usually off. For remote servers, auth is required. If you get a `401`, you need the API key.

Your **project ID** is injected into your system prompt (look for references to `/api/projects/<id>/...` in your instructions). If you're unsure, list all projects:

```bash
curl -s "$BASE/api/projects" | jq '.[].id'
```

## Kanban Board

Every project has a kanban board for task tracking. Default columns: **Backlog, To Do, In Progress, Review, Done**.

### Read the board

```bash
# Get board with all columns and their IDs
curl -s "$BASE/api/projects/$PROJECT_ID/board" | jq

# List all cards
curl -s "$BASE/api/projects/$PROJECT_ID/board/cards" | jq
```

### Create a card

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/cards" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Short descriptive title",
    "description": "Details about the task",
    "columnId": "<column-uuid>",
    "priority": "high",
    "assignee": "your-agent-name",
    "labels": "bug,backend"
  }'
```

Priority values: `urgent`, `high`, `medium`, `low`

### Move a card between columns

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID/move" \
  -H "Content-Type: application/json" \
  -d '{"columnId": "<target-column-uuid>"}'
```

### Update a card

```bash
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID" \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated title", "description": "Updated details", "priority": "medium"}'
```

### Add a comment to a card

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID/comments" \
  -H "Content-Type: application/json" \
  -d '{"author": "your-agent-name", "content": "PR opened: #42. Waiting on CI."}'
```

### Epics

Cards can be grouped into epics. Epics with `autonomous: true` can drive automated task dispatch.

```bash
# List epics
curl -s "$BASE/api/projects/$PROJECT_ID/board/epics" | jq

# Create an epic
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/epics" \
  -H "Content-Type: application/json" \
  -d '{"name": "Epic Name", "description": "Goal", "color": "#3B82F6"}'

# Link a card to an epic
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID" \
  -H "Content-Type: application/json" \
  -d '{"epic_id": "<epic-uuid>"}'
```

## Wiki

Every project has a wiki with full-text search (FTS5). Use it to find and share knowledge.

### Search

```bash
curl -s "$BASE/api/projects/$PROJECT_ID/wiki?q=deployment" | jq
```

### Read a page

```bash
curl -s "$BASE/api/projects/$PROJECT_ID/wiki/page-slug" | jq
```

### List all pages (optionally filter by category)

```bash
curl -s "$BASE/api/projects/$PROJECT_ID/wiki" | jq
curl -s "$BASE/api/projects/$PROJECT_ID/wiki?category=api-docs" | jq
```

### Create a page

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/wiki" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Page Title",
    "content": "# Heading\n\nMarkdown content...",
    "category": "architecture",
    "updatedBy": "your-agent-name"
  }'
```

### Update a page

```bash
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/wiki/page-slug" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Updated\n\nNew content...", "updatedBy": "your-agent-name"}'
```

**Categories:** `general`, `api-docs`, `architecture`, `conventions`, `test-patterns`, `troubleshooting`, `onboarding`

> **Always search before creating** — update existing pages rather than creating duplicates.

## Sessions & Messages

You're running inside a chat session. You can also query other sessions if needed.

```bash
# List sessions for an agent
curl -s "$BASE/api/sessions?agentId=<agent-id>" | jq

# Get messages for a session
curl -s "$BASE/api/sessions/<session-id>/messages" | jq
```

## Skills Registry

Agent Hub has a central skills registry (marketplace). You can browse it:

```bash
# List all registry skills
curl -s "$BASE/api/skills/registry" | jq

# Search by category
curl -s "$BASE/api/skills/registry?category=development" | jq
```

## Server Info

```bash
# Get server config (port, models, auth status)
curl -s "$BASE/api/config" | jq

# List all projects
curl -s "$BASE/api/projects" | jq

# List agents for a project
curl -s "$BASE/api/projects/$PROJECT_ID" | jq '.agents'
```

## Self-Reporting Best Practices

As an agent on Agent Hub, you should:

1. **Track your work** — Create kanban cards when starting significant tasks, move them as you progress.
2. **Document knowledge** — After completing work, write/update wiki pages with decisions, patterns, and solutions.
3. **Comment on cards** — When you open a PR, hit a blocker, or finish a subtask, add a comment to the relevant card.
4. **Search before asking** — Check the wiki for existing documentation before making assumptions about the codebase.

## Architecture Quick Reference

| Component  | Stack                           | Location       |
| ---------- | ------------------------------- | -------------- |
| Server     | Express.js + SQLite + WebSocket | `server/`      |
| Web Client | React + Vite + Tailwind CSS     | `client/`      |
| Mobile     | React Native + Expo             | `mobile/`      |
| Desktop    | Electron wrapper                | `electron/`    |
| Deployment | Node.js host (Nginx + process manager recommended) | `<your-host>` — see `references/deployment-example.md` |

**Database:** SQLite with WAL mode (`better-sqlite3`). Tables include `sessions`, `messages`, `heartbeat_logs`, `crons`, `wiki_pages`, `kanban_boards`, `kanban_columns`, `kanban_cards`, `kanban_epics`, `skill_registry`, `webhook_configs`, `device_tokens`.

**Real-time:** WebSocket on the same port as HTTP. Events include `message`, `session_created`, `kanban_update`, `wiki_update`, `cron_session_update`, `auto_pr_created`.
