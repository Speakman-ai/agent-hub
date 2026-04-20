/**
 * Bug-report reroute helpers.
 *
 * Policy: only the project's "intake" agent (role: 'intake') is allowed to
 * create kanban cards from user-request payloads. Any message that looks like
 * a bug report arriving at a non-intake agent should be redirected to that
 * project's intake agent in a fresh session so the target agent's transcript
 * stays clean.
 *
 * The REST endpoint `POST /api/bug-reports` already dispatches to the intake
 * agent. This module is the belt-and-suspenders guard on the websocket/chat
 * path, where a user (or another agent) might paste the bug-report payload
 * into a non-intake chat directly.
 */
import type { Agent, Project } from './types.js';

/**
 * Detect whether a chat message body is a bug-report payload produced by
 * `buildBugReportPrompt` (or any client pasting the same structured header).
 *
 * Matches the literal header emitted at the top of the prompt:
 *   "## Bug Report"
 *
 * We only inspect the first ~500 chars so a long body with an incidental
 * header later on isn't treated as one.
 */
export function isBugReportPayload(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  const head = content.slice(0, 500);
  return /^\s*##\s+Bug Report\b/m.test(head);
}

/**
 * Pull the title line out of a bug-report payload. Returns null if the
 * expected `**Title:** …` line isn't present.
 */
export function extractBugReportTitle(content: string): string | null {
  if (typeof content !== 'string') return null;
  const head = content.slice(0, 2000);
  const m = head.match(/^\*\*Title:\*\*\s*(.+?)\s*$/m);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Decide whether an inbound chat message should be rerouted to the project's
 * intake agent. Returns the target intake `Agent` when a reroute is required,
 * or `null` when the message should proceed to the originally-addressed
 * agent.
 *
 * Reroute fires when ALL of:
 *   - content is a bug-report payload (see `isBugReportPayload`)
 *   - the addressed agent's role is not already `intake`
 *   - the project has an agent with role `intake`
 *   - the message has not already been rerouted once (avoids loops)
 *   - the message is not being replayed from the per-session queue (queue
 *     replays go to their original agent; reroute happens on first arrival)
 */
export function resolveBugReportReroute(
  project: Project,
  addressedAgent: Agent,
  content: string,
  flags: { fromQueue?: boolean; alreadyRerouted?: boolean } = {},
): Agent | null {
  if (flags.fromQueue) return null;
  if (flags.alreadyRerouted) return null;
  if (addressedAgent.role === 'intake') return null;
  if (!isBugReportPayload(content)) return null;
  const intake = (project.agents || []).find((a) => a.role === 'intake');
  return intake || null;
}
