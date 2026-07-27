# Agents — Registry, Config, Sessions, Memory

The `agents` table is the per-project registry of AI agents: identity,
engine, default model, workspace `cwd`, and context-file paths. Sessions
attach to one agent; the `agent-hub-sessions` sub-skill covers the
session surface in depth.

Back to [SKILL.md](../SKILL.md).

**Endpoint contracts:** <https://speakman-ai.github.io/agent-hub/#tag/Agents>
(request/response shapes, every field). This page is the _how_.

## Contents

- [Listing agents](#listing-agents)
- [Agent row](#agent-row)
- [Engines & models](#engines--models)
- [Workspace & context files](#workspace--context-files)
- [Memory](#memory)
- [Session creation](#session-creation)
- [Roster (project-scoped)](#roster-project-scoped)
- [Spawn identity](#spawn-identity)

## Listing agents

```bash
scripts/server.sh agents     # GET /api/agents — every agent across projects
```

The response is an array of `Agent` rows scoped by your active org. Use
the `id` field everywhere downstream — names are display-only.

## Agent row

Notable columns (see `#tag/Agents` for the full shape):

- `id` — stable slug. Used by every other endpoint.
- `project_id` — owning project.
- `name`, `description`, `role` — human-readable identity.
- `engine` — `claude-code` | `cursor-agent` | `gemini-cli` | `codex-cli`.
- `model` — default model for new sessions; can be overridden per-card
  or per-session.
- `cwd` — absolute workspace directory. The agent's tools, context
  files, and skill imports resolve relative to this path.
- `system_prompt` — pre-enrichment baseline. The server enriches every
  spawn with workspace context (`AGENTS.md`, `SOUL.md`, …) and loaded
  skills on top of this.
- `enabled` — `0` excludes from autonomous pickup and chat dispatch.
- `owner_user_id` — spawn-identity lock; see
  [Spawn identity](#spawn-identity).

## Engines & models

`POST /api/agents/bulk-engine` flips the engine on multiple agents in
one call. Use it when migrating a project from one CLI to another
(e.g., switching a roster from `claude-code` to `cursor-agent`). The
endpoint validates each agent's current state — disabled or missing
agents are skipped with a per-id status, not a 4xx on the whole batch.

### Effective CLI model (`server/effective-model.ts`)

For an owned agent, model selection for spawned CLIs resolves in strict order:

1. **Explicit** model on the incoming request / session picker (when provided).
2. **Per-user agent override** `users.preferences_json.agentModelOverrides[agentId]`,
   when valid for the active engine.
3. **Fallback:** the active engine's configured default, or its first
   advertised model. The legacy top-level `defaultModel` and shared
   `agents.model` are not used for owned agent sessions.

Per-user _engine_ selection is layered on top by
`resolveEffectiveEngineAndModel`, which consults
`users.preferences_json.agentEngineOverrides[agentId]` (see the auth
reference for the REST surface). When an override applies the model
ladder above is walked through the override's engine, not the agent's
shared one. There is no longer a per-user "default model per engine"
preference — the legacy `engineDefaultModels` sub-map and its routes were
retired in favour of the per-agent override.

## Workspace & context files

Every agent has a `cwd`. The server reads these files from that
directory on each spawn and concatenates them into the system prompt
(in this order): `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
`TOOLS.md`, `MEMORY.md`. Missing files are silently skipped — the
server does not error on absence.

Skills are discovered under `<cwd>/skills/` via `SKILL.md` frontmatter.
Project-default skills (under `server/default-skills/`) are merged in
after agent-local skills.

## Memory

```bash
GET /api/agents/{agentId}/memory
```

Returns the contents of the agent's `memory/` directory: daily notes
(`YYYY-MM-DD.md`), `MEMORY.md` (long-term), and any other files the
agent has written. Used by the UI's Memory tab and by daily-note
hydration in enrichment.

The reciprocal write paths live in the heartbeat/cron flows and the
`scripts/log-tool-error.sh` wrapper — agents typically don't `PUT`
memory files directly; they edit them through `Edit` / `Write` tools
inside their own session and the filesystem watcher does the rest.

## Session creation

Creating a session belongs to the **Sessions** tag, not Agents:

```bash
POST /api/agents/{agentId}/sessions
```

See `agent-hub-sessions` (`references/sessions.md`) and
<https://speakman-ai.github.io/agent-hub/#tag/Sessions>. The endpoint
is listed under the agent's path namespace because session ownership
is per-agent, but the request/response shape lives under `Sessions`.

## Roster (project-scoped)

The **project roster** is a separate surface from the global agent
registry. It's the curated list of agents a project actively uses and
lives under the `Audit` tag, not `Agents`:

- `GET /api/projects/{projectId}/roster` — current roster.
- `GET /api/projects/{projectId}/roster/suggest` — heuristic suggestions
  based on the project's stack, code structure, and existing agents.
- `GET /api/projects/{projectId}/audit` — post-scaffold audit run that
  feeds the suggest endpoint.

See <https://speakman-ai.github.io/agent-hub/#tag/Audit> for the full
request/response shapes.

Wiki page: `post-scaffold-audit-agent-roster-act-iv` covers the
scaffolding loop.

## Spawn identity

`owner_user_id` ties the agent to a specific user account. When a
session spawns, the server resolves credentials (Claude / Cursor /
Gemini / Codex auth, skill credentials, per-user MCP servers, etc.)
through that owner. This is the universal reviewer lock — see the wiki
page `spawn-identity-isolation-universal-reviewer-lock` for the full
contract.

Practical consequence: cross-user agent spawning is intentionally not
supported. If you need a different identity, change `owner_user_id`
(Admin/Owner only) rather than impersonating from the caller side.

The `delegations` and `handoffs` tables exist in schema for historical
data only — the `<delegate>` / `<handoff>` sub-agent dispatch system was
removed; agents coordinate via plain chat and conference rooms. The CLI
engines handle their own internal sub-agent orchestration.
