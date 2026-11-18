import {
  SESSION_FORWARD_MODES,
  initialSessionForwardMode,
  type SessionForwardMode,
} from './extractForwardBlocks';

/**
 * The ship level an Orchestrate chat's Default build resolves to for one
 * card. A workflow target only takes consult, so it resolves to consult there.
 */
export function orchestrateLaunchMode(
  allowed: readonly SessionForwardMode[],
  railMode: SessionForwardMode,
): SessionForwardMode {
  return initialSessionForwardMode(allowed, railMode === 'consult' ? 'manual' : railMode);
}

/**
 * The mode a forward card's dropdown shows and a press dispatches. A choice
 * made on the card wins. Otherwise an Orchestrate chat's Default build applies
 * (the same level Auto start would use), and any other chat keeps the agent's
 * suggestion.
 */
export function forwardCardMode(args: {
  allowed: readonly SessionForwardMode[];
  chosen: SessionForwardMode | null;
  suggested: SessionForwardMode;
  orchestrating: boolean;
  railMode: SessionForwardMode;
}): SessionForwardMode {
  const { allowed, chosen, suggested, orchestrating, railMode } = args;
  if (chosen) return initialSessionForwardMode(allowed, chosen);
  if (orchestrating) return orchestrateLaunchMode(allowed, railMode);
  return initialSessionForwardMode(allowed, suggested);
}

/**
 * The mode to remember for a card after dispatch. The server reports the mode
 * the session actually started with, which differs from the request when
 * another tab or device started the card first. Only a server that predates
 * that field leaves the requested mode as the answer.
 */
export function startedForwardMode(
  reported: string | null | undefined,
  requested: SessionForwardMode,
): SessionForwardMode {
  return typeof reported === 'string' &&
    (SESSION_FORWARD_MODES as readonly string[]).includes(reported)
    ? (reported as SessionForwardMode)
    : requested;
}
