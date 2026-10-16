import type { Agent, Project, SessionRow } from './types.js';
import { resolveComputerToolEnabled } from '../shared/utils/computerTool.js';
import { DEFAULT_TIMEOUT_MS, DEFAULT_VIEWPORT } from './browser.js';
import type { BrowserSessionOptions } from './browser.js';

/**
 * Resolved browser enablement: explicit per-agent flag wins; otherwise the
 * project default; otherwise enabled (backward compatible).
 */
export function effectiveBrowserToolsEnabled(
  agent: Pick<Agent, 'browserToolsEnabled'>,
  project?: Pick<Project, 'browserToolsDefaultEnabled'> | null,
): boolean {
  if (agent.browserToolsEnabled !== undefined) {
    return agent.browserToolsEnabled;
  }
  if (project?.browserToolsDefaultEnabled !== undefined) {
    return project.browserToolsDefaultEnabled;
  }
  return true;
}

/**
 * Whether the `computer` tool is on for a session. The session's own switch
 * wins; NULL/absent falls back to the agent default, which is off unless the
 * agent sets `computerToolEnabled: true`.
 */
export function effectiveComputerToolEnabled(
  agent: Pick<Agent, 'computerToolEnabled'>,
  session?: Pick<SessionRow, 'computer_tool_enabled'> | null,
): boolean {
  return resolveComputerToolEnabled(agent.computerToolEnabled, session?.computer_tool_enabled);
}

function clampInt(n: number, min: number, max: number): number {
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** Pick first finite positive dimension from agent, then project, then fallback. */
function pickViewportDim(
  agentVal: unknown,
  projectVal: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof agentVal === 'number' && Number.isFinite(agentVal)) {
    return clampInt(agentVal, min, max);
  }
  if (typeof projectVal === 'number' && Number.isFinite(projectVal)) {
    return clampInt(projectVal, min, max);
  }
  return fallback;
}

/**
 * Merge agent + project browser tuning into opts for {@link launchBrowserSession}.
 * Unset dimensions fall back to project then {@link DEFAULT_VIEWPORT}.
 */
export function resolveBrowserSessionOptions(
  agent: Pick<Agent, 'browserViewportWidth' | 'browserViewportHeight' | 'browserPageLoadTimeoutMs'>,
  project?: Pick<
    Project,
    'browserViewportWidth' | 'browserViewportHeight' | 'browserPageLoadTimeoutMs'
  > | null,
): BrowserSessionOptions {
  const width = pickViewportDim(
    agent.browserViewportWidth,
    project?.browserViewportWidth,
    DEFAULT_VIEWPORT.width,
    320,
    3840,
  );
  const height = pickViewportDim(
    agent.browserViewportHeight,
    project?.browserViewportHeight,
    DEFAULT_VIEWPORT.height,
    240,
    2160,
  );
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (
    typeof agent.browserPageLoadTimeoutMs === 'number' &&
    Number.isFinite(agent.browserPageLoadTimeoutMs)
  ) {
    timeoutMs = clampInt(agent.browserPageLoadTimeoutMs, 1000, 120_000);
  } else if (
    typeof project?.browserPageLoadTimeoutMs === 'number' &&
    Number.isFinite(project.browserPageLoadTimeoutMs)
  ) {
    timeoutMs = clampInt(project.browserPageLoadTimeoutMs, 1000, 120_000);
  }
  return {
    viewport: { width, height },
    timeoutMs,
  };
}

/**
 * Add the owner's saved browser profile to launch options for the public-web
 * agent browser. Sessions without an owner (API-key or system spawns) or
 * without a project browse with a fresh context.
 */
export function withBrowserProfile(
  opts: BrowserSessionOptions,
  scope: { ownerUserId: string | null; agentId: string; projectId: string | null },
): BrowserSessionOptions {
  if (!scope.ownerUserId || !scope.agentId || !scope.projectId) return opts;
  return {
    ...opts,
    profile: { userId: scope.ownerUserId, agentId: scope.agentId, projectId: scope.projectId },
  };
}
