import { describe, expect, it } from 'vitest';
import {
  SESSION_FORWARD_BUILD_MODES,
  SESSION_FORWARD_WORKFLOW_MODES,
} from './extractForwardBlocks';
import {
  forwardCardMode,
  orchestrateLaunchMode,
  startedForwardMode,
} from './orchestrateForwardMode';

describe('forwardCardMode', () => {
  const build = SESSION_FORWARD_BUILD_MODES;

  it("uses the Orchestrate chat's Default build over the agent's suggestion", () => {
    expect(
      forwardCardMode({
        allowed: build,
        chosen: null,
        suggested: 'manual',
        orchestrating: true,
        railMode: 'push',
      }),
    ).toBe('push');
  });

  it('keeps a choice made on the card', () => {
    expect(
      forwardCardMode({
        allowed: build,
        chosen: 'review',
        suggested: 'manual',
        orchestrating: true,
        railMode: 'push',
      }),
    ).toBe('review');
  });

  it("keeps the agent's suggestion outside Orchestrate", () => {
    expect(
      forwardCardMode({
        allowed: build,
        chosen: null,
        suggested: 'merge',
        orchestrating: false,
        railMode: 'push',
      }),
    ).toBe('merge');
  });

  it('resolves to consult for a workflow target', () => {
    expect(orchestrateLaunchMode(SESSION_FORWARD_WORKFLOW_MODES, 'push')).toBe('consult');
    expect(
      forwardCardMode({
        allowed: SESSION_FORWARD_WORKFLOW_MODES,
        chosen: null,
        suggested: 'consult',
        orchestrating: true,
        railMode: 'merge',
      }),
    ).toBe('consult');
  });
});

describe('startedForwardMode', () => {
  it("prefers the server's started mode over the requested one", () => {
    expect(startedForwardMode('manual', 'push')).toBe('manual');
  });

  it('falls back to the request only when the server sent no usable mode', () => {
    expect(startedForwardMode(undefined, 'push')).toBe('push');
    expect(startedForwardMode('autopilot', 'push')).toBe('push');
  });
});
