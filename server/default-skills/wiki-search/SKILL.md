---
name: wiki-search
description: >-
  Search the project wiki for relevant documentation, conventions, API docs,
  and architecture notes. TRIGGER when: user asks about documentation,
  conventions, architecture, or says "search wiki", "check wiki", "wiki".
version: 1.0.0
keep-coding-instructions: true
---

# Wiki Search

Search your project's wiki knowledge base for relevant information.

## Usage

When you need to find project-specific knowledge (API docs, conventions, architecture patterns, test patterns, troubleshooting notes), search the wiki first before making assumptions.

## How to Search

Use the Agent Hub API to search the wiki:

```bash
# Search by keyword
curl -s "$AGENT_HUB_URL/api/projects/$PROJECT_ID/wiki?q=authentication" | jq

# Get a specific page
curl -s "$AGENT_HUB_URL/api/projects/$PROJECT_ID/wiki/api-authentication" | jq

# List all pages
curl -s "$AGENT_HUB_URL/api/projects/$PROJECT_ID/wiki" | jq

# Filter by category
curl -s "$AGENT_HUB_URL/api/projects/$PROJECT_ID/wiki?category=api-docs" | jq
```

## When to Update the Wiki

After completing significant work, document what you learned:

```bash
# Create a new wiki page
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/wiki" \
  -H "Content-Type: application/json" \
  -d '{"title": "Page Title", "content": "# Content\n...", "category": "conventions", "updatedBy": "agent-name"}'

# Update an existing page
curl -s -X PUT "$AGENT_HUB_URL/api/projects/$PROJECT_ID/wiki/page-slug" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Updated content\n...", "updatedBy": "agent-name"}'
```

## Categories

- `general` - General project notes
- `api-docs` - API documentation
- `architecture` - Architecture decisions and patterns
- `conventions` - Code conventions and style guides
- `test-patterns` - Testing patterns and approaches
- `troubleshooting` - Known issues and solutions
- `onboarding` - Getting started guides
