---
name: agent-hub-wiki
description: >-
  Agent Hub per-project wiki — SQLite FTS5 search, read, list, and upsert of
  wiki pages. Categories: general, api-docs, architecture, conventions,
  test-patterns, troubleshooting, onboarding. TRIGGER only on Agent Hub wiki
  signals: the words "wiki", "wiki page", "wiki search", "FTS", "FTS5"; the
  wrappers scripts/wiki.sh, scripts/wiki-search.sh, scripts/wiki-upsert.sh;
  or URLs under /api/projects/<slug>/wiki/. DO NOT TRIGGER on third-party
  wikis (Notion, Confluence, MediaWiki, Obsidian, BookStack, GitBook) — those
  are separate platforms. DO NOT TRIGGER on the verb "search" alone or on
  generic documentation questions without an Agent Hub wiki in view.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Wiki

Per-project wiki backed by SQLite FTS5. **Always search before creating** —
update existing pages rather than duplicating. Full reference:
**[references/wiki.md](references/wiki.md)**. Scripts live in the shared
core tree (`agent-hub/scripts/`).

```bash
# Deterministic wrappers:
scripts/wiki-search.sh "deployment"                     # FTS query
scripts/wiki-upsert.sh <slug> ./page.md --category architecture

# Subcommand-style wrapper:
scripts/wiki.sh read <slug>                             # single page
scripts/wiki.sh list [category]                         # all pages (filtered)
```

## Categories

`general`, `api-docs`, `architecture`, `conventions`, `test-patterns`,
`troubleshooting`, `onboarding`. Choose the narrowest one that fits — agents
filter by category often.

## Slug conventions

Slugs are auto-derived from the title on upsert; explicit slugs are accepted.
Keep them kebab-case and stable — they end up in URLs and cross-references.

## Search before write

The FTS5 index gets stale fast when agents duplicate pages. The order of
operations for any new doc is:

1. `scripts/wiki-search.sh "<topic>"` — confirm no existing page.
2. If a near-match exists, **upsert** the existing slug (`wiki-upsert.sh`).
3. Only create a new slug if no existing page covers the topic.

A `409` on create means a slug collision — use upsert instead. See the
core skill's `references/errors.md` for the recovery flow.

## See also

- Core skill `agent-hub` — env contract, auth, error self-reporting.
- `references/wiki.md` — full endpoint reference.
