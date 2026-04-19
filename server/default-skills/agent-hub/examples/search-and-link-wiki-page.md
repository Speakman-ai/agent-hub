# Example: Search the Wiki and Link the Page into a Card Comment

**Scenario:** a user asks a question whose answer lives in the project wiki.
You FTS-search for the relevant page, read it, and drop the link into a card
comment so future searches of the board surface the context.

Back to [README](README.md) · See [`references/wiki.md`](../references/wiki.md).

---

## Input (user message)

> On card `36d919a9` — what does the deployment doc say about `ALLOWED_ORIGINS`
> for production? Link the wiki page in the card comments so the team doesn't
> have to dig.

## Walk-through

### 1. FTS search for the relevant page

```bash
PROJECT_ID=agent-hub scripts/wiki-search.sh "ALLOWED_ORIGINS deployment"
```

Expected output (abbreviated):

```json
{
  "pages": [
    {
      "slug": "deployment-guide",
      "title": "Deployment Guide",
      "category": "general",
      "snippet": "…CORS — <mark>ALLOWED_ORIGINS</mark>… Set the ALLOWED_ORIGINS env var to a comma-separated list…",
      "updated_at": "2026-04-18T01:16:08.000Z"
    }
  ]
}
```

### 2. Read the full page before quoting from it

```bash
PROJECT_ID=agent-hub scripts/wiki.sh read deployment-guide \
  | python3 -c "import json,sys; p=json.load(sys.stdin); print(p['content'])" \
  | grep -A3 "ALLOWED_ORIGINS"
```

Expected output (abbreviated excerpt):

```
## CORS — ALLOWED_ORIGINS
- Set `ALLOWED_ORIGINS` to a comma-separated list of origins (no trailing slash).
- Production (`ecosystem.config.cjs`): `https://hub.example.com` — override per-deploy.
```

### 3. Comment on the card with a link + short quote

Link format: `/projects/<PROJECT_ID>/wiki/<slug>` — the web UI resolves this to
the wiki page.

```bash
PROJECT_ID=agent-hub scripts/board.sh comment "36d919a9" '{
  "author": "agent-hub-backend",
  "content": "See the **Deployment Guide** wiki page for the canonical answer: [/projects/agent-hub/wiki/deployment-guide](/projects/agent-hub/wiki/deployment-guide).\n\nKey excerpt:\n> Set `ALLOWED_ORIGINS` to a comma-separated list of origins (no trailing slash). Production default in `ecosystem.config.cjs` is `https://hub.example.com` — override per deploy with `ALLOWED_ORIGINS=https://hub.your-domain pm2 restart agent-hub`."
}'
```

Expected output:

```json
{
  "id": "c8d1…",
  "card_id": "36d919a9",
  "author": "agent-hub-backend",
  "content": "See the **Deployment Guide** wiki page…",
  "created_at": "2026-04-19T05:52:11.000Z"
}
```

### 4. (If the wiki is stale) Update rather than duplicate

If step 2 shows the page is missing the info the user needs, **update the
existing page** — don't create a second one. See `wiki-upsert.sh` slug rules:

```bash
# Pull the current content, edit locally, then upsert.
PROJECT_ID=agent-hub scripts/wiki.sh read deployment-guide \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'])" \
  > /tmp/deployment-guide.md

# …edit /tmp/deployment-guide.md…

PROJECT_ID=agent-hub scripts/wiki-upsert.sh deployment-guide /tmp/deployment-guide.md \
  --category general \
  --by agent-hub-backend
```

Expected output (update, not create):

```json
{"slug":"deployment-guide","title":"Deployment Guide","category":"general","updated_at":"2026-04-19T05:54:02.000Z","updated_by":"agent-hub-backend"}
```

---

## Copy-paste checklist

- [x] FTS search via `scripts/wiki-search.sh` **first**
- [x] Read the page before quoting from it
- [x] Comment the link in the form `/projects/<id>/wiki/<slug>`
- [x] If stale, **update** via `wiki-upsert.sh` (don't create a duplicate)

## Gotchas

- **Slugs are derived from titles server-side.** `wiki-upsert.sh` refuses if
  `slugify(title) != <slug>`. Either fix the H1, pass `--title`, or pick a
  matching slug.
- **Categories are a closed set:** `general`, `api-docs`, `architecture`,
  `conventions`, `test-patterns`, `troubleshooting`, `onboarding`. Unknown
  values get coerced to `general`.
- **FTS5 tokenizes on word boundaries.** Multi-word queries should be passed
  as a single argument (`scripts/wiki-search.sh "ALLOWED_ORIGINS deployment"`,
  not two words).
- **Snippets contain `<mark>` tags.** Strip them before displaying to users if
  you're synthesizing a plain-text answer.
