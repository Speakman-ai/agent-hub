# Wiki — FTS5 Search, Pages, Categories

Every project has its own wiki with full-text search powered by SQLite
FTS5. Pages are addressed by slug (derived from title on create) and
grouped into categories.

Back to [SKILL.md](../SKILL.md).

**Endpoint contracts:** <https://speakman-ai.github.io/agent-hub/#tag/Wiki>
(request/response shapes, search params, category enum). This page is the
*how*.

## Categories

`general`, `api-docs`, `architecture`, `conventions`, `test-patterns`,
`troubleshooting`, `onboarding`, `documents` (text extracted from uploaded files).

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

## Uploaded files (SOPs, runbooks, reference docs)

Users can upload documents into folders from the wiki **Files** view. Each
upload's text is extracted (PDF, DOCX, Markdown, HTML, plain text, CSV, JSON,
YAML) into a linked page with category `documents`, so normal wiki search and
RAG already find it. Read the extracted text with `wiki.sh read <slug>`; the
file row's `page_slug` names the page.

```bash
scripts/wiki.sh files                        # every file, with folder + page_slug
scripts/wiki.sh files "SOPs/Safety"          # one folder
scripts/wiki.sh upload ./lockout.pdf "SOPs/Safety"   # same name + folder replaces
```

An upload can return 503 `busy` when the server's upload slots are full; wait the `Retry-After` seconds and retry. Pages generated from files are read-only: `wiki.sh update` on one returns 409 `file_backed_page`. Change the text by re-uploading the file.

## What to write

Prefer durable knowledge that would be lost when the session ends:

- Architectural decisions and their rationale
- Conventions the team actually follows
- API contracts (endpoints, payloads, status codes)
- Test patterns and fixtures
- Troubleshooting playbooks that saved debug time

Avoid transient session notes — those belong in daily notes, not the wiki.
Do not mint one page per ticket. On merge the Hub starts a docs-agent
review when the linked card is still undocumented. Historical cards stay
queued until an operator runs `wiki.sh document-backfill`.

## What you get back

`scripts/wiki.sh read` returns the full row: `slug`, `title`, `content`,
`category`, `updated_by`, `updated_at`. Search returns snippet highlights
plus the same metadata.
