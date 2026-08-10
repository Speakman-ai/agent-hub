/**
 * Sidechain stream events are frames the CLI produced for an inner subagent it
 * spawned through its own `Task`/`Agent` tool, rather than for the agent the
 * user is talking to. The server tags them with `parentToolUseId`
 * (`server/stream-parser.ts`, from Claude Code's `parent_tool_use_id`).
 *
 * They belong to the subagent card identified by that id. Rendering them in the
 * top-level tail turns one subagent's research into pages of chat the user
 * never asked for, so both clients filter them out of the main block stream.
 */
export interface SidechainStreamEventLike {
  parentToolUseId?: string | null;
}

/** True when this event came from an inner subagent, not the parent turn. */
export function isSidechainStreamEvent(
  event: SidechainStreamEventLike | null | undefined,
): boolean {
  return typeof event?.parentToolUseId === 'string' && event.parentToolUseId !== '';
}
