# README media — shot list & capture runbook

The top-level `README.md` embeds the screenshots in this directory. The stills
below are captured and committed; a short demo GIF is still an open follow-up.

When adding or replacing a shot, drop the file here and reference it from
`README.md` (e.g. `![Kanban board](docs/media/kanban.png)`).

## Shots

| File              | View (web client)                     | Shows                                                    | Status      |
| ----------------- | ------------------------------------- | -------------------------------------------------------- | ----------- |
| `dashboard.png`   | Project activity / home               | Activity feed: PR reviews, running tests, support issues | ✅ committed |
| `chat.png`        | `chat` view                           | Live agent chat with the engine picker + ask panel       | ✅ committed |
| `kanban.png`      | `kanban` view                         | Project board with epics + an autonomously dispatched card | ✅ committed |
| `finalize.png`    | `finalize` panel (open from a session) | Finalize Code Changes review + checks on a CI runner     | ✅ committed |
| `replay.png`      | `replays` view                        | Session replay / RUM list with linked tickets            | ✅ committed |
| `security.png`    | `security` view                       | Per-commit secret / vulnerability findings               | ✅ committed |
| `deployments.png` | `deployments` view                    | A deployment run with live stream + release changes      | ✅ committed |
| `support.png`     | `support` view                        | Customer support ticket with replay + convert-to-card    | ✅ committed |
| `demo.gif`        | kanban → chat/session → finalize      | The kanban → autonomous dispatch → Finalize loop, ~15–25s | ⏳ follow-up |

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
