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

### Installing the Cursor Agent CLI

To run sessions with `engine: cursor-agent`, install the CLI from Cursor's
official installer:

```bash
# Inspect the script first if you prefer:
# curl -fsS https://cursor.com/install | less
bash scripts/ensure-cursor-agent.sh
```

This wraps `curl -fsS https://cursor.com/install | bash` with an
idempotent check, so it's safe to re-run. The installer drops a symlink
at `~/.local/bin/agent`, which is also the server's default `cursorBin`
— no additional configuration needed. To override (e.g. system-wide
install at `/usr/local/bin/agent`), set the `CURSOR_BIN` env var or
`cursorBin` in `~/.agent-hub/data/config.json`.

On EC2 this is handled automatically:

- **New instances**: `ops/terraform/main.tf` `user_data` runs the
  official installer once at bootstrap.
- **Every deploy**: the dev/prod-2/release-prod workflows in
  `.github/workflows/` call `scripts/ensure-cursor-agent.sh` inside
  the SSM rollout, so the CLI stays present on subsequent deploys
  even if it was manually removed.

### Installing the Codex CLI

For `engine: codex-cli`, run:

```bash
bash scripts/ensure-codex.sh
```

This installs `@openai/codex` via npm and symlinks `codex` into
`~/.local/bin` so the Hub finds it via the same `COMMON_BIN_DIRS`
probe used for other engines (reliable under PM2 even when `PATH` is
minimal). Terraform bootstrap and the same deploy workflows also run
`npm install -g @openai/codex` (system Node) plus `ensure-codex.sh`
after the repo exists on PM2 hosts.

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

The API is **TypeScript** (`server/index.ts`) and must be started with **tsx** (same as `npm run dev:server`). Do **not** point PM2 at `server/index.js` — that file does not exist.

```bash
ssh ubuntu@your-server
cd ~/agent-hub
git pull
npm install
npm run build
cd server && npm install && cd ..
# First deploy, or after changing the process file:
pm2 start ecosystem.config.cjs
# Routine updates:
pm2 restart agent-hub
```

- **`ecosystem.config.cjs`** runs `node server/node_modules/tsx/dist/cli.mjs index.ts` with `cwd` set to `server/`.
- **Nginx** reverse proxies port 80 to localhost:3051. Keep `proxy_read_timeout` reasonable (e.g. 60s+); GitHub webhooks should get a quick `2xx` from `/api/webhooks/github` (the app responds before long-running work).
- **PM2** manages the Node.js process with auto-restart.
- **Port 3051** is localhost-only; all external traffic routes through Nginx.

**GitHub webhooks:** The **signing secret** configured on the GitHub side must **exactly match** the secret stored in Agent Hub’s webhook config for that repo. Mismatches produce `HMAC verification failed` in logs. The server verifies the raw request body (`express.json` `verify` hook); deploy current server code so HMAC uses the same bytes GitHub signed.

**`gh` CLI on the server:** For autonomous review features, install a recent [GitHub CLI](https://cli.github.com/). Older versions lack `gh pr view --json reviewThreads`; the server falls back to the GraphQL API when that field is missing.

### Monitoring

```bash
pm2 status           # Process status
pm2 logs agent-hub   # Live logs
pm2 monit            # CPU/memory dashboard
```

### Terraform Quickstart (EC2 + ALB + ECR Public)

The `ops/terraform/` module provisions a complete Agent Hub host: VPC, EC2,
dedicated ALB with TLS, IAM, and (by default) the per-PR preview environment
stack. To bring up a new environment from scratch:

```bash
cd ops/terraform
cp terraform.tfvars.example environments/<env>/<env>.tfvars
# edit <env>.tfvars: set name, public_fqdn, base_domain, cert_renewal_email
AWS_PROFILE=<profile> ./scripts/tf-init.sh <env>
AWS_PROFILE=<profile> terraform apply -var-file=environments/<env>/<env>.tfvars
```

### PR Environments — 30-second out-of-box quickstart

PR Environments (per-PR preview deployments) are **on by default** on a fresh
`terraform apply`. The full out-of-box contract — including the prereq flow
diagram, per-prereq remediation, and a troubleshooting matrix — is documented
in [`docs/architecture/pr-environments-out-of-box-contract.md`](docs/architecture/pr-environments-out-of-box-contract.md)
(also published to the project wiki as
**PR Environments — Out of Box Contract**). The short version is three steps:

1. **`terraform apply`** — `enable_pr_environments = true` is the default. A
   fresh apply provisions the wildcard ACM cert, the Route 53 IAM policy on
   the EC2 SSM role, host nginx + certbot + the sudoers allowlist + the
   docker-socket bind-mount, security-group ingress 3100-3999, and the
   Tier-3 `prEnv` block in `<dataDir>/config.json`. First boot also issues
   the wildcard Let's Encrypt cert via `certbot --dns-route53`.
2. **Settings → PR Environments → Register Reviewer App** — the panel runs a
   prerequisite check (Docker, nginx, wildcard cert, GitHub App, Route 53
   IAM, webhook). The GitHub App row stays red until you click **Register
   Reviewer App**, which walks the GitHub App manifest flow and persists
   `appId`, `installationId`, `privateKey`, `webhookSecret`, and
   `clientId`/`clientSecret` automatically — no copy-paste of secrets.
3. **Tick Enable** — the toggle is gated until validation is green. Save,
   open a PR on a webhook-installed repo, and the first preview URL
   (`https://pr-<n>.<pr_env_preview_subdomain>.<alb_fqdn>`) comes up
   automatically.

**Opt out:** set `enable_pr_environments = false` on hosts that will never
run previews. The fine-grained `enable_pr_env_wildcard_cert`,
`enable_pr_env_route53_iam`, and `enable_pr_env_host_nginx` variables remain
as nullable per-piece overrides (default `null` = follow the root flag) —
set them to `true` or `false` only when disabling a single piece for
testing. There is **no separate `AGENT_HUB_PR_ENV_ENABLED` env-var gate**;
the Settings toggle (DB row, with file-block fallback) is the single source
of truth.

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
