# README media — shot list & capture runbook

The top-level `README.md` links here for the product walkthrough (annotated UI
screenshots + a short demo GIF). **Capturing these requires a running Agent Hub
instance with representative demo data and a human to drive it** — preview boot
inside Agent Hub is human-only, so an autonomous agent cannot produce these
assets. They are tracked as a human follow-up rather than committed as broken
image links.

When capturing, drop the files into this directory and reference them from the
**Screenshots & demo** section of `README.md` (e.g.
`![Kanban board](docs/media/kanban.png)`), replacing the interim
"run it locally" note.

## Required shots

| File           | View (web client)                          | What it should show                                                 | Notes                        |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------- | ---------------------------- |
| `hero.png`     | Dashboard / project home (`DashboardView`) | Web client dashboard / project home, dark theme                     | Above-the-fold hero          |
| `chat.png`     | `chat` view                                | Live agent chat with a streaming response                           | Show the engine picker       |
| `kanban.png`   | `kanban` view                              | A project kanban board with epics + an autonomously dispatched card | Core "issue tracking" claim  |
| `finalize.png` | `finalize` panel (open from a session)     | Finalize Code Changes panel mid-run on an isolated CI runner        | Core "CI gating" claim       |
| `replay.png`   | `replays` view                             | Session replay / RUM timeline with a frustration signal             | Replaces LogRocket/FullStory |
| `wiki.png`     | `wiki` view                                | Wiki page with FTS5 search results                                  | Knowledge base               |
| `demo.gif`     | kanban → chat/session → finalize           | The kanban → autonomous dispatch → Finalize loop, ~15–25s           | Headline demo                |

## Capture runbook (human)

Preview boot is human-only, so a person has to run these steps. Everything
below keeps real customer data out of the shots.

1. **Boot a clean instance with a throwaway data dir** so nothing real is
   visible:
   ```bash
   AGENT_HUB_DATA_DIR="$(mktemp -d)/agent-hub-demo" npm run dev
   ```
   Open <http://localhost:3050> and complete `/api/auth/setup` to create the
   first Owner account.
2. **Seed a demo project** named e.g. `Acme Demo` with a couple of agents
   (Dev / Reviewer). Use only fictional names — no real repos, customers, or
   tokens.
3. **Populate for each shot:**
   - _kanban_ — add an epic and 4–6 cards across columns; mark one card as
     autonomously dispatched (assigned to an agent).
   - _chat_ — start a session and send a prompt so a streaming response is
     visible; keep the engine picker in frame.
   - _finalize_ — open a session's **Finalize Code Changes** panel while a run
     is in progress (the isolated-runner step list should be visible).
   - _replays_ — open the `replays` view on a session that has a captured
     frustration signal (rage / dead / error click).
   - _wiki_ — open a wiki page and type a query so FTS5 results render.
4. **Capture:** dark theme (the app defaults to it — confirm `<html class="dark">`),
   crop tightly to app content with **no OS chrome**, PNG for stills.
5. **Demo GIF:** record the kanban → dispatch → Finalize loop end-to-end,
   ~15–25s. Keep `demo.gif` under ~8 MB (GitHub inlines it) — trim frame rate /
   dimensions if needed.
6. **Commit** the files here and update the README **Screenshots & demo**
   section to embed them.

## Guidance

- Use a seeded demo project so no real customer data appears.
- Prefer PNG for stills; keep `demo.gif` under ~8 MB (GitHub inlines it).
- Match the app's dark theme; crop to content, no OS chrome.
