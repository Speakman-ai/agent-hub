import { describe, expect, it } from 'vitest';
import {
  browserScreencastSurfaceOf,
  previewBrowserRegistryId,
  resolveChatBrowserScreencastTarget,
} from './browser-screencast-target.js';

function resolve(
  live: Array<'web' | 'preview'>,
  extras: {
    previewOps?: number;
    webOps?: number;
    lastDriven?: 'web' | 'preview' | null;
  } = {},
) {
  const has = new Set(live);
  return resolveChatBrowserScreencastTarget('chat-1', {
    hasSession: (id) =>
      (id === 'chat-1' && has.has('web')) || (id === 'preview:chat-1' && has.has('preview')),
    agentOpsInFlight: (id) => {
      if (id === 'preview:chat-1') return extras.previewOps ?? 0;
      if (id === 'chat-1') return extras.webOps ?? 0;
      return 0;
    },
    lastDriven: extras.lastDriven,
  });
}

describe('previewBrowserRegistryId', () => {
  it('prefixes the chat session id', () => {
    expect(previewBrowserRegistryId('abc')).toBe('preview:abc');
    expect(browserScreencastSurfaceOf('preview:abc')).toBe('preview');
    expect(browserScreencastSurfaceOf('abc')).toBe('web');
  });
});

describe('resolveChatBrowserScreencastTarget', () => {
  it('returns null when neither Chromium is live', () => {
    expect(resolve([])).toBeNull();
  });

  it('follows the only live surface', () => {
    expect(resolve(['preview'])).toEqual({ targetId: 'preview:chat-1', surface: 'preview' });
    expect(resolve(['web'])).toEqual({ targetId: 'chat-1', surface: 'web' });
  });

  it('prefers the surface with an in-flight agent op over last-driven / idle preview', () => {
    expect(resolve(['web', 'preview'], { webOps: 1, lastDriven: 'preview' })).toEqual({
      targetId: 'chat-1',
      surface: 'web',
    });
    expect(resolve(['web', 'preview'], { previewOps: 1, lastDriven: 'web' })).toEqual({
      targetId: 'preview:chat-1',
      surface: 'preview',
    });
  });

  it('stays on last-driven when both are idle', () => {
    expect(resolve(['web', 'preview'], { lastDriven: 'web' })).toEqual({
      targetId: 'chat-1',
      surface: 'web',
    });
  });

  it('prefers preview when both are idle with no last-driven hint', () => {
    expect(resolve(['web', 'preview'])).toEqual({
      targetId: 'preview:chat-1',
      surface: 'preview',
    });
  });
});
