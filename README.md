# Agent Hub

A full-stack command center for AI agent orchestration. Manage, monitor, and interact with AI agents (Claude Code, Cursor Agent) through real-time chat, automated tasks, project-scoped knowledge bases, and kanban-style task boards — across web, mobile, and desktop.

## Features

- **Real-time Chat** — Stream responses from AI agents via WebSocket with persistent session history
- **Multi-Engine Support** — Unified interface for Claude Code and Cursor Agent with per-agent model configuration
- **Project Organization** — Group agents, tasks, and knowledge under projects with dedicated workspaces
- **Kanban Boards** — Per-project task tracking with epics, labels, priorities, and autonomous dispatch
- **Wiki Knowledge Base** — Full-text searchable documentation per project, injected into agent context
- **Scheduled Tasks** — Cron jobs and heartbeat check-ins with configurable prompts
- **GitHub Integration** — Webhook-driven PR lifecycle, automated reviews, and CI monitoring
- **Slack Bot** — Multi-agent Slack integration for team communication
- **Cross-Platform** — Web (React), mobile (React Native/Expo), and desktop (Electron) clients

## Architecture

```mermaid
graph TB
    subgraph Clients
        WEB["Web Client<br/>React + Vite<br/>:3050"]
        MOB["Mobile App<br/>React Native + Expo"]
        DESK["Desktop App<br/>Electron"]
    end

    subgraph Server["Express Server :3051"]
        REST[REST API]
        WS[WebSocket]
        PROMPT[Prompt Builder]
        CRON[Cron Scheduler]
        HB[Heartbeat System]
        WH[Webhook Receiver]
    end

    subgraph Storage
        DB[(SQLite + WAL)]
        FS[Agent Workspaces]
    end

    subgraph External
        CLAUDE[Claude Code CLI]
        CURSOR[Cursor Agent CLI]
        GH[GitHub API]
        SLACK[Slack API]
    end

    WEB & MOB & DESK -->|HTTP + WS| Server
    REST & WS --> DB
    WS --> PROMPT --> CLAUDE & CURSOR
    PROMPT --> FS
    CRON & HB --> CLAUDE
    WH -.->|HMAC verify| GH
    GH -->|Webhooks| WH
    SLACK --> CLAUDE
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Server | Node.js, Express, ES Modules |
| Database | SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)), WAL mode |
| Real-time | [ws](https://github.com/websockets/ws) (WebSocket) |
| Web Client | React 18, Vite, Tailwind CSS |
| Mobile | React Native, Expo |
| Desktop | Electron |
| Scheduling | node-cron |
| Slack | @slack/bolt |
| Testing | Vitest, supertest |
| Deployment | EC2, Nginx, PM2 |

## Prerequisites

- **Node.js** v18+
- **npm**
- **Claude Code CLI** and/or **Cursor Agent CLI** installed and accessible
- **gh CLI** (optional — for webhook registration and PR workflows)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/speakmanra/agent-hub.git
cd agent-hub

# Install all dependencies (root, server, client, mobile)
npm run install:all

# Start the full stack (client + server)
npm run dev
```

The web client opens at [http://localhost:3050](http://localhost:3050) and the API server runs on port 3051.

## Configuration

Create or edit `server/config.json` to match your environment:

```json
{
  "port": 3051,
  "claudeBin": "/usr/local/bin/claude",
  "cursorBin": "/usr/local/bin/agent",
  "defaultCwd": "/home/youruser"
}
```

Configuration resolves in priority order: **environment variables** > **config.json** > **built-in defaults**.

| Environment Variable | config.json Key | Default | Description |
|---------------------|-----------------|---------|-------------|
| `AGENT_HUB_PORT` | `port` | `3051` | Server port |
| `CLAUDE_BIN` | `claudeBin` | `/usr/local/bin/claude` | Path to Claude Code CLI |
| `CURSOR_BIN` | `cursorBin` | `/usr/local/bin/agent` | Path to Cursor Agent CLI |
| `AGENT_HUB_DEFAULT_CWD` | `defaultCwd` | `$HOME` | Fallback working directory |
| `AGENT_HUB_API_KEY` | `apiKey` | `null` | API key for remote access |
| `AGENT_HUB_PUBLIC_URL` | `publicUrl` | `null` | Public URL for webhook callbacks |

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start client and server concurrently |
| `npm run dev:client` | Start React client on port 3050 |
| `npm run dev:server` | Start Express server on port 3051 |
| `npm run build` | Build the client for production |
| `npm run install:all` | Install deps for all packages |
| `npm run mobile` | Start Expo dev server for mobile |
| `npm run electron:dev` | Start Electron desktop app in dev mode |
| `npm test` | Run server tests |
| `npm run test:watch` | Run tests in watch mode |

## Project Structure

```
agent-hub/
├── client/                 # React + Vite web frontend
│   └── src/
│       ├── App.jsx         # Root component with all state management
│       ├── components/     # 18 UI components
│       │   ├── Sidebar.jsx
│       │   ├── KanbanBoard.jsx
│       │   ├── WikiBrowser.jsx
│       │   ├── SettingsPage.jsx
│       │   └── ...
│       ├── hooks/          # useWebSocket.js for real-time connection
│       └── utils/          # API client, time formatting, exports
├── server/                 # Express.js backend
│   ├── index.ts            # All REST + WebSocket routes (Express + WebSocket bootstrap)
│   ├── db.js               # SQLite setup with auto-migrations
│   ├── config.js           # Centralized configuration resolution
│   ├── auth.js             # API key authentication middleware
│   ├── wiki.js             # Wiki CRUD + FTS5 full-text search
│   ├── heartbeat.js        # Cron and heartbeat scheduling
│   ├── slack.js            # Multi-agent Slack bot
│   ├── stream-parser.js    # CLI output stream parsing
│   ├── worktree.js         # Git worktree management
│   └── project-paths.js    # Workspace path resolution
├── mobile/                 # React Native + Expo mobile app
│   ├── App.js              # Entry point with navigation
│   └── src/                # Screens, components, utils
├── electron/               # Electron desktop wrapper
│   ├── main.js             # Main process
│   └── preload.cjs         # Preload script
├── CLAUDE.md               # Developer documentation (for AI agents)
└── package.json            # Root scripts and Electron build config
```

## Core Concepts

### Projects and Agents

**Projects** are the top-level organizational unit. Each project has a working directory (`cwd`), an Agent Hub workspace (`ahw`) for context files, and a color. **Agents** belong to projects and can be configured with different engines (Claude Code / Cursor Agent), models, and custom instructions.

### Enriched Prompts

Before every agent invocation, the server builds an enriched prompt by combining:
1. Agent's base configuration and custom instructions
2. Context files from the workspace (`AGENTS.md`, `SOUL.md`, `MEMORY.md`, etc.)
3. Matching skills from the `skills/` directory
4. Wiki page summaries for the project
5. Daily memory notes

This gives agents persistent project knowledge without manually managing conversation history.

### Real-time Communication

All real-time features use WebSocket:
1. REST endpoint performs a mutation
2. On success, the server broadcasts an event to all connected clients
3. Clients receive the event and refetch relevant data

Events use the format `{ type: 'feature_action', projectId, ...data }`.

### Agent Workspaces

Each agent workspace can contain context files that are automatically injected into prompts:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent role definitions and team structure |
| `SOUL.md` | Personality, behavioral guidelines, coding standards |
| `IDENTITY.md` | Identity and background context |
| `USER.md` | User preferences and context |
| `TOOLS.md` | Available tools and usage instructions |
| `MEMORY.md` | Persistent memory across sessions |

## API Overview

The server exposes a RESTful API at `http://localhost:3051/api`. Key resource groups:

| Resource | Endpoints | Description |
|----------|-----------|-------------|
| Projects | `/api/projects` | CRUD for projects and their agents |
| Sessions | `/api/sessions` | Chat session management |
| Messages | `/api/sessions/:id/messages` | Message history |
| Kanban | `/api/projects/:id/board` | Boards, columns, cards, epics, comments |
| Wiki | `/api/projects/:id/wiki` | Knowledge base with full-text search |
| Webhooks | `/api/webhooks` | GitHub webhook configuration |
| Crons | `/api/crons` | Scheduled task management |
| Heartbeats | `/api/agents/:id/heartbeat` | Agent health check scheduling |
| Config | `/api/config` | Server configuration |

Authentication is optional. When `apiKey` is set in config, include `X-API-Key` header or `?apiKey=` query parameter.

## Database

Agent Hub uses **SQLite with WAL mode** for zero-ops persistence. Key tables:

```mermaid
erDiagram
    PROJECTS ||--o{ AGENTS : contains
    AGENTS ||--o{ SESSIONS : has
    SESSIONS ||--o{ MESSAGES : contains
    PROJECTS ||--|| KANBAN_BOARDS : has
    KANBAN_BOARDS ||--o{ KANBAN_COLUMNS : has
    KANBAN_COLUMNS ||--o{ KANBAN_CARDS : contains
    PROJECTS ||--o{ WIKI_PAGES : has
    PROJECTS ||--o{ WEBHOOK_CONFIGS : has
    AGENTS ||--o{ HEARTBEAT_LOGS : produces
    CRONS ||--o{ CRON_LOGS : produces
```

The database file lives at `server/agent-hub.db` (or in `dataDir` if configured). Tables are auto-created on first server start.

## Deployment

### Production (EC2 + Nginx + PM2)

```bash
ssh ubuntu@your-server
cd ~/agent-hub
git pull
npm run build
pm2 restart agent-hub
```

- **Nginx** reverse proxies port 80 to localhost:3051
- **PM2** manages the Node.js process with auto-restart
- **Port 3051** is localhost-only; all external traffic routes through Nginx

### Monitoring

```bash
pm2 status           # Process status
pm2 logs agent-hub   # Live logs
pm2 monit            # CPU/memory dashboard
```

## Git Workflow

All feature work uses **worktree-first development**:

1. Branch from `main` with a descriptive name
2. Work entirely on the feature branch
3. Push and open a PR via `gh pr create`
4. Wait for CI checks and code review
5. Human merges to `main` — agents never self-merge

Never commit directly to `main`. Never push to `main` for feature work.

## Contributing

1. Pull latest `main`: `git checkout main && git pull`
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes following existing code patterns
4. Ensure the build passes: `npm run build`
5. Run tests: `npm test`
6. Push your branch and open a PR: `gh pr create`
7. Wait for CI and review — humans merge to `main`

### Code Conventions

- **ES Modules** throughout (`import`/`export`, no `require`)
- **TypeScript on the server** (`server/`) — strict mode, run with `tsx`; **client and mobile** stay **JavaScript** with JSX
- **PascalCase** for React components, **camelCase** for functions/variables, **kebab-case** for file names
- **Tailwind CSS** utility classes, dark theme by default
- **Raw SQL** with prepared statements via better-sqlite3 (no ORM)
- **Single-file server** — all routes live in `server/index.ts`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `better-sqlite3` build fails | Ensure build tools are installed: `sudo apt install build-essential python3` (Linux) or `xcode-select --install` (macOS) |
| WebSocket connection refused | Verify the server is running on port 3051 and no firewall is blocking it |
| CLI binary not found | Update `claudeBin`/`cursorBin` in `server/config.json` or set `CLAUDE_BIN`/`CURSOR_BIN` env vars |
| `npm run install:all` fails | Try deleting `node_modules` in root, client, server, and mobile, then retry |

## License

This project is private and proprietary.
