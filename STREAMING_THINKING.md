# Streaming thinking & tool-use into chat — scoping doc

Status: **not yet implemented** — design only. Written 2026-04-05 as the follow-up to the active-task tracking + session-resume work. See `server/index.js`, `client/src/App.jsx`, `mobile/src/context/AppContext.js` for the current state the changes would land on top of.

## Problem

Agents currently stream only the final assistant text back to the chat UI, character by character. When an agent is doing real work — using the Bash tool, reading files, planning with TodoWrite, spawning subagents — the chat shows a spinner and nothing else until the response is assembled. The user has no visibility into *what* the agent is doing, and long tasks feel like black boxes.

We already know from the active-tasks work that long tasks are the exact scenario where users want the most feedback.

## Goal

Render the agent's work the way the real Claude Code UI does: interleaved thinking blocks, tool-use calls (collapsible), tool results, subagent activity, and final assistant text. Same for cursor-agent. Still persist one final "assistant" message to `messages` for history, but optionally persist the full event log for rich replay.

## Current state

- `server/index.js:813` spawns `claude --print ... --system-prompt <s> <prompt>` with no `--output-format` flag, so stdout is plain text.
- Stdout is streamed via `broadcast({ type: 'stream', chunk, content, ... })` on every chunk. The client accumulates `content` in a single string and renders it via `StreamingMessage`.
- Final result is saved as one row in `messages` with `role='assistant'` and plain text `content`.
- `active_tasks.streamed_output` also holds the same plain text for reattach-on-reconnect.

For cursor, same story — `-p` + default text format.

## Verified: Claude stream-json shape

`claude --print --output-format stream-json --include-partial-messages --verbose` emits newline-delimited JSON. Each line is one complete JSON object with a top-level `type` field. Real sample collected against Claude Haiku 4.5 2026-04-05:

Top-level types observed:

| type | purpose |
|---|---|
| `system` (subtype `init`) | One-time. Contains `cwd`, `model`, `session_id`, available `tools`, `skills`, `agents`, `plugins`. |
| `stream_event` | Wraps a raw Anthropic SSE event. `event.type` is one of `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. |
| `assistant` | Snapshot of the assembled assistant message at a point in time. Emitted when a content block completes. |
| `user` | Assembled user turn (tool results come through here as `role: user` + `content: [{type: 'tool_result', ...}]`). |
| `rate_limit_event` | Rate-limit / usage info. Informational. |
| `result` | Final terminal event. Has `result` (plain text of final answer), `is_error`, `duration_ms`, `total_cost_usd`, `usage`, `terminal_reason`, `num_turns`. |

Content-block types inside `stream_event`:

| content_block.type | delta.type | what it is |
|---|---|---|
| `thinking` | `thinking_delta` (+ `signature_delta`) | Extended thinking text. Render italicized/grayed, collapsible. |
| `text` | `text_delta` | Normal assistant text. Render as-is (current behavior). |
| `tool_use` | `input_json_delta` | Tool call. `content_block_start` carries `name` + `id`; deltas accumulate the tool input JSON. Render as a collapsible "used Bash" / "used Edit" etc. chip. |

`user` turns with `tool_result` content are how Claude surfaces tool output back into the conversation. Render as a collapsible child of the matching `tool_use` (match by `tool_use_id`).

`parent_tool_use_id` on `stream_event` is how you distinguish subagent activity (Task tool with a sub-claude). If non-null, the event belongs to a child agent; render nested under the parent Task block.

The full event log — from `system init` through `result` — is what the Claude Code UI replays to build its rich rendering. We'd save the same log.

## Cursor equivalent (not yet verified)

`agent -p ... --output-format stream-json --stream-partial-output` is the parallel flag set. Event taxonomy is slightly different from Anthropic's. Grab a sample with a real call before wiring cursor — don't assume parity. A reasonable scoping assumption: wrap cursor's events in our own normalized envelope so the client only has to learn one event schema.

## Proposed architecture

### Server (`server/index.js`)

1. Spawn claude with `--output-format stream-json --include-partial-messages --verbose`. The `--verbose` is required by `--include-partial-messages` per the help text.
2. New helper `parseJsonLines(stream)`: buffer stdout, split on `\n`, JSON.parse each complete line. Emit a normalized event (see below) for each.
3. Maintain per-task state: a running list of events (`eventLog`), a running assembled text result (`textResult`, fed from `result.result` or the `assistant` snapshot's text blocks), and optionally a cache of active tool calls keyed by `tool_use_id`.
4. Broadcast each normalized event as `{ type: 'stream-event', sessionId, messageId, event }`. Drop the existing `stream` event (or keep it as a degraded fallback).
5. On `result`: save assistant message as today (content = `result.result`), plus persist the full event log to a new column or table.
6. Update `active_tasks` to store the event log instead of (or alongside) `streamed_output`, so reconnecting clients can re-render the rich view.

### Normalized event envelope (proposal)

```ts
type StreamEvent =
  | { kind: 'system-init';  model: string; tools: string[]; cwd: string; }
  | { kind: 'thinking-start'; blockIndex: number; parentToolUseId?: string; }
  | { kind: 'thinking-delta'; blockIndex: number; text: string; parentToolUseId?: string; }
  | { kind: 'thinking-stop';  blockIndex: number; parentToolUseId?: string; }
  | { kind: 'text-start';  blockIndex: number; parentToolUseId?: string; }
  | { kind: 'text-delta';  blockIndex: number; text: string; parentToolUseId?: string; }
  | { kind: 'text-stop';   blockIndex: number; parentToolUseId?: string; }
  | { kind: 'tool-use-start'; blockIndex: number; toolUseId: string; name: string; parentToolUseId?: string; }
  | { kind: 'tool-use-input-delta'; blockIndex: number; toolUseId: string; json: string; parentToolUseId?: string; }
  | { kind: 'tool-use-stop';  blockIndex: number; toolUseId: string; parentToolUseId?: string; }
  | { kind: 'tool-result'; toolUseId: string; content: string; isError: boolean; parentToolUseId?: string; }
  | { kind: 'result'; text: string; isError: boolean; durationMs: number; usage: object; costUsd: number; }
  | { kind: 'error'; message: string; }
```

One schema, both engines. Cursor's events get translated into the same shape server-side.

### Database

Option A (simple): Add `messages.event_log TEXT` nullable column, store JSON array of normalized events on the assistant message. Old plain-text messages still render fine because `content` is still the canonical text.

Option B (richer): Separate `message_events` table keyed by `message_id` with one row per event + `seq` ordering. Better for incremental updates during streaming, but more code.

Recommendation: **Option A**. Write the full log at the end on `result`. During streaming, the live view comes from the WS broadcast; persistence only matters for replay-after-reload, and the full log is small enough to store as JSON.

Drop `active_tasks.streamed_output`, replace with `active_tasks.event_log TEXT` holding the JSON array being built up. Append on every event (SQLite handles this at local-disk speed fine for normal traffic).

### Client (web + mobile)

1. New `MessageContent` component that renders from `event_log` if present, else falls back to plain `content` string. Maps each event to a React element:
   - thinking blocks → italic gray collapsible section ("Thinking...")
   - text blocks → current markdown renderer
   - tool-use blocks → collapsible chip with tool name + parsed JSON input, and a linked `tool-result` child rendered below it
   - subagent blocks (events with `parentToolUseId`) → nested under the parent Task tool chip
2. Live streaming path: replace `streamingContent` (a string) with `streamingEvents` (the in-progress event array). On each `stream-event` WS message, append to the array. Render the same way a finished message renders.
3. `ChatMessage` reads `event_log` from persisted messages and renders identically. If `event_log` is null (legacy messages), render `content` as today.
4. Sidebar "running" dot stays as-is — logic is unchanged.

### Heartbeats & crons

`runHeartbeat` and `runCronJob` in `server/heartbeat.js` use the same spawn pattern. They currently capture stdout into `result`. Optionally flip them to stream-json too, so the heartbeat log viewer can show the same rich format. Can be deferred; out of scope for the first pass.

## Open questions

1. **Tool-use input rendering.** `input_json_delta` streams a JSON string incrementally. On the client, do we render the partial JSON live (messy, flickers), buffer until `content_block_stop` (clean, but feels static), or both (show "running" spinner while partial, then render parsed JSON on stop)? Recommended: buffer until stop, show spinner during.
2. **Subagent nesting depth.** Task tools can spawn sub-claudes that spawn their own tools. Decide on a max visual depth (probably 2) and collapse deeper levels.
3. **Backfill.** What happens to old messages with no `event_log`? Current behavior: plain text render (no change). No backfill needed.
4. **Cursor event translation.** Define the mapping table once cursor stream-json output is sampled. Defer.
5. **Persist thinking to DB?** Claude's API returns a `signature` on thinking blocks that's required to replay the exact thinking content in later API calls. Our DB storage isn't used to replay turns (claude's own session file is), so we can safely drop `signature` when persisting to save space. Store `thinking.text` only.
6. **Streaming of heartbeat/cron output.** Out of scope for v1 — plain text is fine there. Revisit after chat UI is done.
7. **Cancel behavior.** When user cancels mid-stream, the persisted `event_log` should be marked partial. Add a `cancelled: true` field on the final `result`-equivalent event, or a `result-cancelled` event kind.

## Implementation order

Sized roughly largest → smallest. Each step is independently testable.

1. **Server parser + normalized envelope.** Ship first. Switch claude spawn to stream-json, build `parseJsonLines`, build normalization, replace the existing `stream` broadcast with `stream-event` broadcasts. Keep the final `done` event firing with the plain `result.result` text so the existing client keeps working (it'll just stop seeing mid-stream content). Verify with a console-logging client.
2. **DB: `messages.event_log` column + persistence on result.** Save full event log. Still no client rendering changes.
3. **Client `MessageContent` rendering from `event_log`.** Renders the finished log richly on reload. Still uses old plain `streamingContent` for live stream.
4. **Client live rendering from `streamingEvents`.** Switch live stream from string to event array. This is the user-facing "wow" moment.
5. **Mobile parity.** Mirror 3 + 4 in the mobile client. React Native markdown rendering for tool-use blocks may be fiddly.
6. **Cursor stream-json.** Sample real output, write cursor translator, wire it in.
7. **(Optional) Heartbeat/cron streaming.** Later.

## What's NOT in scope

- Changes to the active-task tracking, reconciliation, or session-resume plumbing — those are already done and should not move.
- Changes to `heartbeat.js` or `slack.js` message flows (unless step 7 is taken up).
- A real-time collaboration layer — multiple clients can watch the same stream, but we're not building cursors/presence/conflict resolution.
- Exposing the event log via HTTP API (future: `GET /api/messages/:id/events`).
- Rendering the `system` init block to the user. Capture it for debugging but don't display.

## Estimated sizing

Not committing to hours, but for reference: this is roughly 3–5× the line count of the active-task + resume change we just landed. Mostly in client rendering logic, not server plumbing. The server parser and DB work are ~200 lines total; most of the rest is UI.
