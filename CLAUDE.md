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
- **Centralized config** - `server/config.json` holds port, CLI binary paths (`claudeBin`, `cursorBin`), and `defaultCwd`. Edit here rather than hardcoding.
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

- **Claude Code CLI** and **Cursor Agent CLI** paths are configured in `server/config.json` (`claudeBin` / `cursorBin`). The committed defaults point at a Linux host (`/home/ryan/...`); update them for your local environment if running the server directly on this Mac.
- **Slack Bot Framework**: `@slack/bolt` for multi-agent Slack integration
- **Cron Scheduling**: `node-cron` for automated task execution

## Development Notes

- The server runs as an ES module (`"type": "module"`)
- SQLite WAL mode enabled for concurrent access
- WebSocket handles chat streaming, cancellation, and real-time updates
- Agent configurations are stored in `server/agents.json` and auto-saved
- No README files exist - this CLAUDE.md serves as the primary documentation