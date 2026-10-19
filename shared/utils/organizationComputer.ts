/** Computer status and ownership copy for organization agent chats, shared by web and mobile. */
import { describeComputerToolSetting, type ComputerToolSetting } from './computerTool';
import { organizationAgentStatus, type OrganizationAgent } from './organization-agents';

/** Subset of `GET /api/desktop/runtime` the chat surfaces read. */
export interface DesktopRuntimeInfo {
  available: boolean;
  reason?: string;
}

export type OrganizationComputerState =
  | 'agent-inactive'
  | 'not-permitted'
  | 'off'
  | 'unavailable'
  | 'ready';

export interface OrganizationComputerStatus {
  state: OrganizationComputerState;
  setting: ComputerToolSetting;
  /** Whether the session switch can be changed from this chat. */
  canToggle: boolean;
  title: string;
  detail: string;
}

type AgentLike = Partial<Pick<OrganizationAgent, 'computerToolEnabled' | 'organizationScope'>>;

/**
 * Effective Computer state for an organization agent chat. The server enforces
 * all of this again on every Computer operation; the client only explains it.
 * `runtime` is null while the backend status is still loading.
 */
export function organizationComputerStatus(input: {
  agent: AgentLike | null | undefined;
  sessionValue: unknown;
  runtime: DesktopRuntimeInfo | null;
}): OrganizationComputerStatus {
  const { agent, sessionValue, runtime } = input;
  const setting = describeComputerToolSetting(agent?.computerToolEnabled, sessionValue);
  const scope = agent?.organizationScope;
  if (scope && organizationAgentStatus(agent as OrganizationAgent) !== 'active') {
    const archived = Boolean(scope.archivedAt);
    return {
      state: 'agent-inactive',
      setting: { ...setting, enabled: false },
      canToggle: false,
      title: archived ? 'Agent archived' : 'Agent disabled',
      detail: `This agent is ${archived ? 'archived' : 'disabled'}, so its Computer can't start. Its desktop is kept.`,
    };
  }
  if (scope && !scope.tools.includes('computer')) {
    return {
      state: 'not-permitted',
      setting: { ...setting, enabled: false },
      canToggle: false,
      title: 'Not allowed',
      detail:
        "This agent doesn't have the Computer tool. An organization admin can add it in the agent's settings.",
    };
  }
  if (!setting.enabled) {
    return {
      state: 'off',
      setting,
      canToggle: true,
      title: 'Off',
      detail: 'The agent cannot use its desktop in this chat.',
    };
  }
  if (runtime && !runtime.available) {
    return {
      state: 'unavailable',
      setting,
      canToggle: true,
      title: 'Unavailable',
      detail: `The Computer backend is unavailable on this Server${
        runtime.reason ? `: ${runtime.reason}` : '.'
      } Chat still works.`,
    };
  }
  return {
    state: 'ready',
    setting,
    canToggle: true,
    title: 'On',
    detail:
      'Starts the first time the agent uses it. Reopening this chat returns to the same desktop.',
  };
}

/** Names the organization, agent and signed-in user a desktop belongs to. */
export function organizationComputerOwnerLabel(input: {
  organizationName: string | null | undefined;
  agentName: string | null | undefined;
  user: { name?: string | null; email?: string | null } | null | undefined;
}): string {
  const agent = input.agentName?.trim() || 'Organization agent';
  const organization = input.organizationName?.trim() || 'this organization';
  const user = input.user?.name?.trim() || input.user?.email?.trim() || 'you';
  return `${agent} in ${organization} · private to ${user}`;
}
