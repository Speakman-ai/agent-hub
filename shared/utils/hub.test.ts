import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HUB_PANE,
  HUB_ASSISTANT_AGENT_ID,
  HUB_PROJECT_ID,
  hubPaneFromLegacyView,
  isHubAssistantAgentId,
  isHubAssistantRole,
  isHubProjectId,
  isHubSystemProject,
  isInternalSystemProject,
  isOrganizationSystemProject,
  isSummariesPaneAlias,
  parseHubPane,
} from './hub';

describe('hub constants', () => {
  it('keeps the hidden project and assistant ids stable', () => {
    expect(HUB_PROJECT_ID).toBe('__hub__');
    expect(HUB_ASSISTANT_AGENT_ID).toBe('__hub_assistant__');
  });

  it('recognizes the Hub project, system kind, and assistant role', () => {
    expect(isHubProjectId('__hub__')).toBe(true);
    expect(isHubProjectId('agent-hub')).toBe(false);
    expect(isHubSystemProject({ id: HUB_PROJECT_ID })).toBe(true);
    expect(isHubSystemProject({ id: 'other', kind: 'system' })).toBe(true);
    expect(isHubSystemProject({ id: 'agent-hub' })).toBe(false);
    expect(isHubAssistantRole('hub-assistant')).toBe(true);
    expect(isHubAssistantRole('Hub-Assistant')).toBe(true);
    expect(isHubAssistantRole('dev')).toBe(false);
    expect(isHubAssistantAgentId('__hub_assistant__')).toBe(true);
  });

  it('parses workspace panes and maps retired top-level views', () => {
    expect(parseHubPane('org')).toBe('org');
    // The Daily Summary pane is gone; links to it are an alias for Summaries.
    expect(parseHubPane('summary')).toBe(DEFAULT_HUB_PANE);
    expect(isSummariesPaneAlias('summary')).toBe(true);
    expect(isSummariesPaneAlias('chat')).toBe(false);
    expect(parseHubPane('support')).toBe('support');
    expect(parseHubPane('troubleshoot')).toBe(DEFAULT_HUB_PANE);
    expect(parseHubPane('nope')).toBe(DEFAULT_HUB_PANE);
    expect(hubPaneFromLegacyView('home')).toBe('today');
    expect(hubPaneFromLegacyView('dashboard')).toBe('org');
    expect(hubPaneFromLegacyView('gmail')).toBe('mail');
    // The org-wide support overview is now a Hub tab, not a standalone section.
    expect(hubPaneFromLegacyView('support-overview')).toBe('support');
    expect(hubPaneFromLegacyView('chat')).toBeNull();
  });
  it('classifies organization workspaces separately from the Hub singleton on every client', () => {
    const project = {
      id: 'organization-workspace',
      kind: 'system',
      workspaceKind: 'organization',
      organizationId: 'business',
    };
    expect(isHubSystemProject(project)).toBe(false);
    expect(isOrganizationSystemProject(project)).toBe(true);
    expect(isInternalSystemProject(project)).toBe(true);
    expect(isOrganizationSystemProject({ organizationId: 'business' })).toBe(true);
    expect(isOrganizationSystemProject({ workspaceKind: 'hub' })).toBe(false);
    expect(isOrganizationSystemProject(null)).toBe(false);
  });
});
