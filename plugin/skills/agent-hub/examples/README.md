# Worked Examples — Happy-Path Recipes

Each file in this directory is a **concrete, copy-pasteable** walk-through that
shows how a common agent task maps to `scripts/` invocations. Read the matching
reference under [`../references/`](../references/) for full API surface; come
here when you want to see the exact script calls in sequence with their
expected output.

| File                                 | Scenario                                              |
| ------------------------------------ | ----------------------------------------------------- |
| [create-ticket-from-bug-report.md](create-ticket-from-bug-report.md) | User drops a bug report → triage into a kanban card   |
| [delegate-to-subagent.md](delegate-to-subagent.md)                   | Fan out a parallel audit to two specialist agents     |
| [post-heartbeat-summary.md](post-heartbeat-summary.md)               | End-of-heartbeat summary: log findings + drop cards   |
| [search-and-link-wiki-page.md](search-and-link-wiki-page.md)         | FTS5 wiki search + link page into a card comment      |
| [move-card-through-workflow.md](move-card-through-workflow.md)       | Walk a card To Do → In Progress → Review → Done |

## Conventions used in these examples

- `PROJECT_ID=agent-hub` — replace with your project slug.
- `$AGENT_HUB_SESSION_ID` — injected by the server at session start. Do not
  hard-code.
- `AGENT_HUB_URL` defaults to `http://localhost:3051`. The API key is resolved
  by `scripts/ah-api.sh` (checks env, then the on-disk Owner key).
- Expected output blocks abbreviate long fields (IDs, timestamps) with `…` —
  your real responses will contain full UUIDs and ISO-8601 timestamps.
- All `scripts/…` paths are relative to `plugin/skills/agent-hub/`. If you're
  running from the project root, prefix with `plugin/skills/agent-hub/`.

## Running an example end-to-end

Every snippet is pure bash — no templating. You can copy any numbered block
verbatim into a shell inside a live Agent Hub session. The only substitutions
you need to make are the IDs returned by earlier steps (the examples show
exactly which fields to capture).
