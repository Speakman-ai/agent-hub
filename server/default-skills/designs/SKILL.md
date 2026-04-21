---
name: designs
description: >-
  Read-only access to Agent Hub's Design Studio artifacts (HTML/CSS/JS
  produced inside a Design session) for regular agents — list designs in
  the active org, inspect their file trees, and fetch raw file contents
  over HTTP. TRIGGER when: the user mentions "design", "designs", "Design
  Studio", "mockup", "prototype", "landing page", or asks the agent to
  look at / reference / port / screenshot a design by name or ID. DO NOT
  TRIGGER inside a Design Studio session itself (that session uses the
  separate `design` skill to AUTHOR artifacts; this skill is READ-ONLY
  cross-session). DO NOT TRIGGER on generic design-system or Figma/Sketch
  discussions unrelated to an Agent Hub design artifact.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Designs — Cross-Session Read Access

Agent Hub hosts "designs" as a distinct session type: a Claude-Design-style
canvas where an agent writes HTML/CSS/JS into an artifact directory that's
rendered live in an iframe. **Regular agents (like you) don't own those
artifacts and can't edit them**, but you CAN read them — this skill wraps
the HTTP API so you can:

- List every design in the active org
- Inspect a design's metadata (name, linked projects, timestamps)
- Walk its file tree (recursively, including `assets/`)
- Fetch any file's raw bytes (HTML/CSS/JS/images)
- Replay its message history

Use cases:

- The user asks you to port a Design Studio mockup into a real React page
- The user wants you to reference a design's layout/colors while writing code
- A lead agent is reviewing a design session's output
- You're generating documentation that embeds a screenshot / snippet

## Environment

All scripts inherit the standard Agent Hub env:

| Variable            | Default                 | Notes                                     |
| ------------------- | ----------------------- | ----------------------------------------- |
| `AGENT_HUB_URL`     | `http://localhost:3051` | API base                                  |
| `AGENT_HUB_API_KEY` | (injected by server)    | Sent as `x-api-key`; scoped to active org |

Designs are **org-scoped**: `GET /api/designs` returns designs for the
server's active org only. Cross-org reads 404 — don't try to bypass.

## Available Scripts

All scripts live in `scripts/` next to this file. They source
`../agent-hub/scripts/ah-api.sh` for auth resolution, so the same API key
resolution (env → `$AGENT_HUB_DATA_DIR/config.json` → `~/.agent-hub/data/config.json`)
applies.

### List every design

```bash
scripts/designs-list.sh
```

Returns a JSON array of `{ id, name, linkedProjects: [{id, name}, ...], created_at, updated_at }`.
Use this first — you'll almost always need the `id` for the other scripts.

### Fetch one design's metadata

```bash
scripts/designs-get.sh <designId>
```

### List the files in a design's artifact dir (recursive)

```bash
scripts/designs-files.sh <designId>
```

Prints one path per line, relative to the artifact root. Example output:

```
index.html
styles.css
app.js
assets/hero.png
```

### Read a file's contents

```bash
scripts/designs-read.sh <designId> <path>
```

Example:

```bash
scripts/designs-read.sh 0b1e… index.html
scripts/designs-read.sh 0b1e… assets/hero.png > /tmp/hero.png
```

Works for text or binary; the script passes bytes through unchanged.

### Replay the design's chat history

```bash
scripts/designs-messages.sh <designId>
```

Returns the full user/assistant/system transcript as JSON — useful when the
user asks "what was the Design Studio told to build?".

## Workflow — referencing a design while coding

1. `scripts/designs-list.sh` — find the design ID by name
2. `scripts/designs-files.sh <id>` — see what's inside
3. `scripts/designs-read.sh <id> index.html` — pull the markup you need
4. Port / extract / adapt inside the real project

## What you CAN'T do here

- **Write to a design.** This skill is strictly read-only. Writes happen
  inside a dedicated Design Studio session via the separate `design` skill.
- **Cross-org reads.** Designs outside the active org return 404 by design.
- **Rename / delete / relink.** Those are web-UI / PATCH/DELETE operations;
  outside this skill's scope on purpose (we don't want a regular agent
  mutating a Design Studio artifact without explicit UI action).

If the user asks you to edit a design, tell them to open the Design Studio
session for that design — you can point them at the `id` but you can't hand
control off into the design-chat loop from here.

## Path-traversal note

The server's `/design-files/:id/*` mount (which this skill's read script
uses) has a path-traversal guard: requests that escape the per-design root
get a 404. Don't try to craft paths with `..`; they won't work and you'll
just waste a turn.
