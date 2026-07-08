# README media — shot list

The top-level `README.md` links here for the product walkthrough (annotated UI
screenshots + a short demo GIF). Capturing these requires a **running Agent Hub
instance with representative demo data** and a human to drive the preview, so
they are tracked as a follow-up rather than committed as broken image links.

When capturing, drop files into this directory and reference them from the
**Screenshots & demo** section of `README.md` (e.g.
`![Kanban board](docs/media/kanban.png)`).

## Required shots

| File           | What it should show                                                 | Notes                        |
| -------------- | ------------------------------------------------------------------- | ---------------------------- |
| `hero.png`     | Web client dashboard / project home, dark theme                     | Above-the-fold hero          |
| `chat.png`     | Live agent chat with a streaming response                           | Show the engine picker       |
| `kanban.png`   | A project kanban board with epics + an autonomously dispatched card | Core "issue tracking" claim  |
| `finalize.png` | Finalize Code Changes panel mid-run on an isolated CI runner        | Core "CI gating" claim       |
| `replay.png`   | Session replay / RUM timeline with a frustration signal             | Replaces LogRocket/FullStory |
| `wiki.png`     | Wiki page with FTS5 search results                                  | Knowledge base               |
| `demo.gif`     | The kanban → autonomous dispatch → Finalize loop, ~15–25s           | Headline demo                |

## Guidance

- Use a seeded demo project so no real customer data appears.
- Prefer PNG for stills; keep `demo.gif` under ~8 MB (GitHub inlines it).
- Match the app's dark theme; crop to content, no OS chrome.
