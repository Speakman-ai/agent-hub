# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Development Server
- `npm run dev` - Start both client and server in development mode concurrently
- `npm run dev:client` - Start only the React client on port 3050
- `npm run dev:server` - Start only the Node.js server on port 3051

### Build Commands  
- `npm run build` - Build the client React application
- `npm install:all` - Install dependencies for root, server, client, and mobile

### Individual Component Commands
- **Client**: `cd client && npm run dev` (Vite dev server on port 3050)
- **Server**: `cd server && npm start` (Express server on port 3051)
- **Mobile**: `npm run mobile` or `cd mobile && expo start` (Expo dev server)

## Architecture Overview

This is a full-stack Agent Hub application that manages and interfaces with AI agents (Claude Code and Cursor Agent).

### Core Components

**Server (`/server`)**
- **Express.js** backend with WebSocket support for real-time chat
- **SQLite database** (`better-sqlite3`) for sessions, messages, heartbeats, crons
- **Project→Agent hierarchy** - Projects are top-level entities (with `cwd`, `ahw` workspace, color); each project contains one or more agents. Defined in `server/projects.json`.
- **Centralized config** - `~/.agent-hub/data/config.json` holds port, CLI binary paths (`claudeBin`, `cursorBin`), and `defaultCwd`. Falls back to `server/config.json` (legacy) if the data-dir copy doesn't exist. Edit here rather than hardcoding.
- **Agent management** - CRUD operations for AI agent configurations
- **Session management** - Persistent chat sessions with message history
- **Heartbeat system** - Scheduled agent check-ins with configurable prompts
- **Cron jobs** - Automated tasks (dependabot merging, job search monitoring)
- **Skills system** - Agent-specific skill discovery from workspace directories
- **Memory system** - Daily notes and context files (AGENTS.md, SOUL.md, etc.)
- **Slack integration** - Multi-agent Slack bot support

**Client (`/client`)**
- **React + Vite** frontend with Tailwind CSS
- **WebSocket connection** for real-time chat streaming
- **Agent selection** and configuration interface
- **Session management** with persistent chat history
- **Skills browser** - View and manage agent-specific skills
- **Settings pages** - Configure agents, heartbeats, cron jobs
- **Memory interface** - View and edit agent memory files

**Mobile (`/mobile`)**
- **React Native + Expo** mobile app (iOS & Android)
- **1:1 feature parity** with the web client
- **Drawer navigation** for agent/session sidebar (swipe to open)
- **Real-time chat** via WebSocket with streaming responses
- **Skills & Context** - Browse skills and edit context files
- **Settings** - Heartbeats, cron jobs, Slack bots, agent configuration
- **Auto-connects** to local server using Expo's dev host detection
- **Dark theme** matching the web app's color palette

### Key Architecture Patterns

1. **Multi-Engine Support**: Supports both Claude Code and Cursor Agent with different CLI invocation patterns
2. **Agent-Workspace Binding**: Each agent has a configurable workspace directory with context files and skills
3. **Enriched System Prompts**: Automatically builds prompts from agent config + workspace context files + skills + memory
4. **Real-time Streaming**: WebSocket-based chat with live response streaming
5. **SQLite-Backed Persistence**: All sessions, messages, and agent data stored in local SQLite database

### Database Schema

- **sessions**: Chat sessions linked to agents with engine/model info
- **messages**: Individual chat messages with role (user/assistant) 
- **heartbeat_logs**: Scheduled agent check-in results
- **crons**: Automated task definitions and execution logs
- **slack_messages**: Slack bot interaction history

### File Structure Conventions

- **Agent workspaces** contain:
  - Context files: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`
  - Skills directory: `skills/` with `SKILL.md` frontmatter files
  - Memory directory: `memory/` with daily note files

### Integration Points

- **Claude Code CLI** and **Cursor Agent CLI** paths are configured in `~/.agent-hub/data/config.json` (`claudeBin` / `cursorBin`). Falls back to `server/config.json` if the data-dir copy doesn't exist. The built-in defaults point at `/usr/local/bin/claude`; update in config.json for your environment.
- **Slack Bot Framework**: `@slack/bolt` for multi-agent Slack integration
- **Cron Scheduling**: `node-cron` for automated task execution

## Git Workflow — Worktree-First Development

**All feature work MUST happen in worktrees. Never commit directly to main.**

### Standard Flow
1. **Pull from main** → `git checkout main && git pull origin main` to get the latest
2. **Create a feature branch** → `git checkout -b feature/<short-description>`
3. **Build the environment** → `npm install` (or equivalent) if needed
4. **Implement** — all edits, builds, and tests happen on the feature branch
5. **Commit** to the feature branch — not to main
6. **Push** the branch: `git push -u origin <branch-name>`
7. **Open a PR** via `gh pr create`
8. **Wait for checks to pass** and for the lead agent to review
9. **Resolve any review comments** — fix, commit, push, repeat until clean
10. **Human merges** — do NOT merge PRs yourself. A human will merge once satisfied.

### Rules
- When the user says "commit and push", commit to the **current feature branch** and push it — do NOT push to main
- When the user says "make a PR", push the feature branch and create a PR against main
- If no worktree exists yet for the current task, create one before making changes
- Sub-agents (delegated work) must edit files in the **worktree directory**, not the main repo
- **Never merge your own PR** — only humans merge to main
- If you are the lead implementing a change, start a **separate self-review session** to review your own PR

### What NOT to Do
- `git push origin main` for feature work
- Editing files in the main repo and copying them around
- Committing directly to main (only merge commits from PRs)
- Merging PRs — leave that for the human

## Testing

**Every feature, bugfix, and refactor should include at least one test.** PRs without tests for new logic will be flagged in review.

### Framework
- **Vitest** for all unit/integration tests
- **Playwright** for E2E tests (in `e2e/`)

### Running Tests
- `npm test` — Run all server unit tests
- `npm run test:server` — Server tests only
- `npm run test:client` — Client tests only
- `cd server && npx vitest --watch` — Watch mode for server

### Where Tests Go
- **Server**: Co-located as `server/<module>.test.js` (e.g., `stream-parser.test.js`) or in `server/test/` for API integration tests
- **Client**: Co-located as `client/src/**/*.test.js` (e.g., `utils/humanCron.test.js`)
- **E2E**: In `e2e/tests/*.spec.js`

### Test Patterns
- Use `describe`, `it`, `expect` from Vitest (globals enabled)
- Server API tests use `supertest` with the Express app from `server/test/setup.js`
- Client utility tests are pure function tests — no React component rendering needed for utils
- Mock external dependencies (CLI spawning, file system) when testing server logic

### What to Test
- **New utility functions**: Unit test inputs/outputs and edge cases
- **New API endpoints**: Integration test with supertest (request → response)
- **Bug fixes**: Write a test that would have caught the bug before fixing it
- **Complex logic**: State machines, parsers, data transformations

### What NOT to Test
- Simple CRUD wiring with no logic (e.g., a route that just calls a prepared statement and returns the result)
- UI layout/styling (that's E2E territory)

## Development Notes

- The server runs as an ES module (`"type": "module"`)
- SQLite WAL mode enabled for concurrent access
- WebSocket handles chat streaming, cancellation, and real-time updates
- Agent configurations are stored in `server/agents.json` and auto-saved
- See `README.md` for general project documentation; this CLAUDE.md provides AI agent-specific guidance

## Deployment

### EC2 Server
- **Host**: `3.22.232.193` (user: `agenthub`, SSH via `ubuntu`)
- **Nginx** reverse proxy on port 80 → localhost:3051
- **PM2** manages the Node.js process
- **Port 3051** is localhost-only — all external traffic goes through Nginx
- Deploy: `ssh → git pull → npm run build → pm2 restart agent-hub`