import { describe, expect, it } from 'vitest';
import {
  computerToolErrorMessage,
  computerToolResetLabel,
  computerToolSourceLabel,
  describeComputerToolSetting,
  resolveComputerToolEnabled,
} from './computerTool';

describe('resolveComputerToolEnabled', () => {
  it('is off unless the session or the agent default turns it on', () => {
    expect(resolveComputerToolEnabled(undefined, undefined)).toBe(false);
    expect(resolveComputerToolEnabled(undefined, null)).toBe(false);
    expect(resolveComputerToolEnabled(true, null)).toBe(true);
  });

  it('lets the session override the agent default either way', () => {
    expect(resolveComputerToolEnabled(undefined, 1)).toBe(true);
    expect(resolveComputerToolEnabled(true, 0)).toBe(false);
  });
});

describe('describeComputerToolSetting', () => {
  it('reports whether the value is inherited or a session override', () => {
    const inherited = describeComputerToolSetting(true, null);
    expect(inherited).toEqual({ enabled: true, overridden: false, agentDefault: true });
    expect(computerToolSourceLabel(inherited)).toBe('Agent default');

    const override = describeComputerToolSetting(true, 0);
    expect(override).toEqual({ enabled: false, overridden: true, agentDefault: true });
    expect(computerToolSourceLabel(override)).toBe('This chat');
    expect(computerToolResetLabel(override)).toBe('Use agent default (On)');
    expect(computerToolResetLabel(describeComputerToolSetting(false, 1))).toBe(
      'Use agent default (Off)',
    );
  });
});

describe('computerToolErrorMessage', () => {
  it('explains a 403 as a missing tool permission', () => {
    expect(computerToolErrorMessage({ status: 403, message: 'Forbidden' })).toMatch(
      /isn't allowed for this agent/,
    );
  });

  it('falls back to the server message, then to a generic one', () => {
    expect(computerToolErrorMessage(new Error('Session not found'))).toBe('Session not found');
    expect(computerToolErrorMessage(null)).toMatch(/Chat still works/);
  });
});
