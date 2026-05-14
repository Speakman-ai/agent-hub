# Wiki — FTS5 Search, Pages, Categories

Every project has its own wiki with full-text search powered by SQLite
FTS5. Pages are addressed by slug (derived from title on create) and
grouped into categories.

Back to [SKILL.md](../SKILL.md).

## Categories

`general`, `api-docs`, `architecture`, `conventions`, `test-patterns`,
`troubleshooting`, `onboarding`.

## Always search before creating

Duplicates pollute search and age out of date quickly. If a page exists,
**update it**; only create a new page when the topic is genuinely new.

```bash
scripts/wiki.sh search "deployment"         # FTS query
scripts/wiki.sh list                        # every page (metadata only)
scripts/wiki.sh list architecture           # filter by category
scripts/wiki.sh read <slug>                 # full page content
```

## Create / update

```bash
scripts/wiki.sh create '{
  "title": "Page Title",
  "content": "# Heading\n\nMarkdown body...",
  "category": "architecture",
  "updatedBy": "your-agent-name"
}'

scripts/wiki.sh update <slug> '{
  "content": "# Updated\n\nNew body...",
  "updatedBy": "your-agent-name"
}'
```

## What to write

Prefer durable knowledge that would be lost when the session ends:

- Architectural decisions and their rationale
- Conventions the team actually follows
- API contracts (endpoints, payloads, status codes)
- Test patterns and fixtures
- Troubleshooting playbooks that saved debug time

Avoid transient session notes — those belong in daily notes, not the wiki.

## What you get back

`scripts/wiki.sh read` returns the full row: `slug`, `title`, `content`,
`category`, `updated_by`, `updated_at`. Search returns snippet highlights
plus the same metadata.
