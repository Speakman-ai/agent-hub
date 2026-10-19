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

/** Effective Computer switch for a session plus where the value came from. */
export interface ComputerToolSetting {
  enabled: boolean;
  /** True when the session has its own on/off value instead of following the agent. */
  overridden: boolean;
  agentDefault: boolean;
}

export function describeComputerToolSetting(
  agentDefault: unknown,
  sessionValue: unknown,
): ComputerToolSetting {
  return {
    enabled: resolveComputerToolEnabled(agentDefault, sessionValue),
    overridden: sessionValue === 0 || sessionValue === 1,
    agentDefault: agentDefault === true,
  };
}

/** "Agent default" or "This chat", for the label next to the On/Off value. */
export function computerToolSourceLabel(setting: ComputerToolSetting): string {
  return setting.overridden ? 'This chat' : 'Agent default';
}

/** Text for the action that drops the session override. */
export function computerToolResetLabel(setting: ComputerToolSetting): string {
  return `Use agent default (${setting.agentDefault ? 'On' : 'Off'})`;
}

/**
 * Message for a failed session Computer change. A 403 means the agent's tool
 * scope excludes Computer; chat itself keeps working either way.
 */
export function computerToolErrorMessage(err: unknown): string {
  const e = err as { status?: unknown; message?: unknown } | null;
  if (e?.status === 403)
    return "Computer isn't allowed for this agent. An organization admin can add the Computer tool in the agent's settings.";
  const text = typeof e?.message === 'string' ? e.message.trim() : '';
  return text || 'Could not change the Computer setting. Chat still works; try again.';
}
