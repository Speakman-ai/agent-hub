import { describe, it, expect } from 'vitest';
import {
  effectiveBrowserToolsEnabled,
  effectiveComputerToolEnabled,
  resolveBrowserSessionOptions,
} from './browser-agent-settings.js';
import type { Agent, Project } from './types.js';
import { DEFAULT_TIMEOUT_MS, DEFAULT_VIEWPORT } from './browser.js';

describe('browser-agent-settings', () => {
  it('effectiveComputerToolEnabled is off unless the agent opts in', () => {
    expect(effectiveComputerToolEnabled({} as Agent)).toBe(false);
    expect(effectiveComputerToolEnabled({ computerToolEnabled: false } as Agent)).toBe(false);
    expect(effectiveComputerToolEnabled({ computerToolEnabled: true } as Agent)).toBe(true);
  });

  it('effectiveComputerToolEnabled lets each session override the agent default', () => {
    const off = {} as Agent;
    const on = { computerToolEnabled: true } as Agent;
    expect(effectiveComputerToolEnabled(off, { computer_tool_enabled: 1 })).toBe(true);
    expect(effectiveComputerToolEnabled(on, { computer_tool_enabled: 0 })).toBe(false);
    expect(effectiveComputerToolEnabled(on, { computer_tool_enabled: null })).toBe(true);
    expect(effectiveComputerToolEnabled(off, { computer_tool_enabled: null })).toBe(false);
    expect(effectiveComputerToolEnabled(off, null)).toBe(false);
  });

  it('effectiveBrowserToolsEnabled prefers explicit agent flag', () => {
    const proj = { browserToolsDefaultEnabled: false } as Pick<
      Project,
      'browserToolsDefaultEnabled'
    >;
    expect(effectiveBrowserToolsEnabled({ browserToolsEnabled: true } as Agent, proj)).toBe(true);
    expect(effectiveBrowserToolsEnabled({ browserToolsEnabled: false } as Agent, proj)).toBe(false);
  });

  it('effectiveBrowserToolsEnabled inherits project when agent omits flag', () => {
    expect(
      effectiveBrowserToolsEnabled({} as Agent, {
        browserToolsDefaultEnabled: false,
      }),
    ).toBe(false);
    expect(
      effectiveBrowserToolsEnabled({} as Agent, {
        browserToolsDefaultEnabled: true,
      }),
    ).toBe(true);
  });

  it('effectiveBrowserToolsEnabled defaults on when neither side sets', () => {
    expect(effectiveBrowserToolsEnabled({} as Agent, undefined)).toBe(true);
    expect(effectiveBrowserToolsEnabled({} as Agent, {} as Project)).toBe(true);
  });

  it('resolveBrowserSessionOptions merges agent over project defaults', () => {
    const project = {
      browserViewportWidth: 1000,
      browserViewportHeight: 800,
      browserPageLoadTimeoutMs: 20_000,
    } as Project;
    const agent = {
      browserViewportWidth: 1024,
      browserViewportHeight: undefined as unknown as number,
      browserPageLoadTimeoutMs: undefined as unknown as number,
    } as Agent;
    const o = resolveBrowserSessionOptions(agent, project);
    expect(o.viewport).toEqual({ width: 1024, height: 800 });
    expect(o.timeoutMs).toBe(20_000);
  });

  it('resolveBrowserSessionOptions falls back to built-in defaults', () => {
    const o = resolveBrowserSessionOptions({} as Agent, undefined);
    expect(o.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(o.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  // Settings no longer exposes a browser opt-out control, but the agent/project
  // APIs still accept and persist browserToolsEnabled / browserToolsDefaultEnabled.
  // The dispatch-time gate MUST keep honoring a stored `false` so hiding the UI
  // never silently re-enables Chromium for agents an operator disabled.
  it('honors a persisted opt-out even though the UI control is hidden', () => {
    expect(effectiveBrowserToolsEnabled({ browserToolsEnabled: false } as Agent)).toBe(false);
    expect(effectiveBrowserToolsEnabled({} as Agent, { browserToolsDefaultEnabled: false })).toBe(
      false,
    );
  });
});
