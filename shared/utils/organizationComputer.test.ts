import { describe, expect, it } from 'vitest';
import { organizationComputerOwnerLabel, organizationComputerStatus } from './organizationComputer';

const scope = (tools: string[], extra: Record<string, unknown> = {}) => ({
  enabled: true,
  archivedAt: null,
  projects: 'all-linked' as const,
  tools,
  ...extra,
});
const assistant = { computerToolEnabled: true, organizationScope: scope(['computer']) };
const custom = { computerToolEnabled: false, organizationScope: scope(['computer']) };
const available = { available: true };

describe('organizationComputerStatus', () => {
  it('inherits the default-on Assistant setting', () => {
    const s = organizationComputerStatus({
      agent: assistant,
      sessionValue: null,
      runtime: available,
    });
    expect(s.state).toBe('ready');
    expect(s.setting).toEqual({ enabled: true, overridden: false, agentDefault: true });
    expect(s.detail).toMatch(/same desktop/);
  });

  it('inherits the default-off custom agent setting until the chat turns it on', () => {
    const off = organizationComputerStatus({
      agent: custom,
      sessionValue: null,
      runtime: available,
    });
    expect(off.state).toBe('off');
    expect(off.canToggle).toBe(true);
    const on = organizationComputerStatus({ agent: custom, sessionValue: 1, runtime: available });
    expect(on.state).toBe('ready');
    expect(on.setting.overridden).toBe(true);
  });

  it('lets a chat override turn the Assistant default off', () => {
    const s = organizationComputerStatus({ agent: assistant, sessionValue: 0, runtime: available });
    expect(s.state).toBe('off');
    expect(s.setting).toEqual({ enabled: false, overridden: true, agentDefault: true });
  });

  it('reports an unavailable backend without blocking chat', () => {
    const s = organizationComputerStatus({
      agent: assistant,
      sessionValue: null,
      runtime: { available: false, reason: 'Firecracker is not registered.' },
    });
    expect(s.state).toBe('unavailable');
    expect(s.detail).toContain('Firecracker is not registered.');
    expect(s.detail).toMatch(/Chat still works/);
  });

  it('blocks archived, disabled and tool-less agents regardless of the session switch', () => {
    const archived = {
      ...assistant,
      organizationScope: scope(['computer'], { archivedAt: 'now' }),
    };
    const disabled = { ...assistant, organizationScope: scope(['computer'], { enabled: false }) };
    const noTool = { ...assistant, organizationScope: scope(['projects:read']) };
    for (const [agent, state, title] of [
      [archived, 'agent-inactive', 'Agent archived'],
      [disabled, 'agent-inactive', 'Agent disabled'],
      [noTool, 'not-permitted', 'Not allowed'],
    ] as const) {
      const s = organizationComputerStatus({ agent, sessionValue: 1, runtime: available });
      expect(s).toMatchObject({ state, title, canToggle: false });
      expect(s.setting.enabled).toBe(false);
    }
  });
});

describe('organizationComputerOwnerLabel', () => {
  it('names the agent, organization and signed-in user', () => {
    expect(
      organizationComputerOwnerLabel({
        organizationName: 'Acme',
        agentName: 'Organization Assistant',
        user: { email: 'ana@example.com' },
      }),
    ).toBe('Organization Assistant in Acme · private to ana@example.com');
    expect(
      organizationComputerOwnerLabel({ organizationName: '', agentName: null, user: null }),
    ).toBe('Organization agent in this organization · private to you');
  });
});
