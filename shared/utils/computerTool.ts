/**
 * Whether the `computer` ReAct tool is on for a session. The session's own
 * switch (`sessions.computer_tool_enabled`: 1 on, 0 off) wins; NULL/absent
 * falls back to the agent's `computerToolEnabled` default, which is off
 * unless explicitly true.
 */
export function resolveComputerToolEnabled(agentDefault: unknown, sessionValue: unknown): boolean {
  if (sessionValue === 0 || sessionValue === 1) return sessionValue === 1;
  return agentDefault === true;
}
