/**
 * Resolve the label shown in an assistant chat header — kept pure so vitest can
 * cover the fallback chain without mounting the RN component tree.
 *
 * Precedence: the name stored on the message (set per-agent at insert time),
 * then the active agent's name passed by the screen, then the literal
 * "Assistant" so the header is never blank.
 */
export function resolveAgentDisplayName(message: any, agentName: any) {
    return message?.agent_name || agentName || 'Assistant';
}
