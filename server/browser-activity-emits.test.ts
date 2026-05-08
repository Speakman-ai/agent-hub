import { describe, expect, it } from 'vitest';
import {
  buildBrowserActivityEndedEvent,
  buildBrowserActivityEndedThrowEvent,
  buildBrowserActivityScreenshotBroadcast,
  buildBrowserActivityStartedEvent,
} from './browser-activity-emits.js';

describe('browser-activity-emits', () => {
  it('ended hasScreenshot follows screenshotCaptured, not screenshotWsUrl', () => {
    const ended = buildBrowserActivityEndedEvent({
      actionId: 'a1',
      op: 'screenshot',
      label: '…',
      startedAtMs: 1,
      durationMs: 9,
      b: {
        markdown: '',
        hostExit: 0,
        ui: {
          summary: 'Screenshot captured',
          screenshotCaptured: true,
        },
      },
    });
    expect(ended.phase).toBe('ended');
    expect(ended.hasScreenshot).toBe(true);
  });

  it('ended hasScreenshot false when no screenshot was captured', () => {
    const ended = buildBrowserActivityEndedEvent({
      actionId: 'a1',
      op: 'navigate',
      label: '…',
      startedAtMs: 1,
      durationMs: 2,
      b: { markdown: '', hostExit: 0, ui: { summary: 'Opened https://example.com' } },
    });
    expect(ended.hasScreenshot).toBe(false);
  });

  it('screenshot WS broadcast omitted when URL missing', () => {
    expect(
      buildBrowserActivityScreenshotBroadcast({
        sessionId: 's',
        messageId: 'm',
        actionId: 'a',
        screenshotWsUrl: undefined,
      }),
    ).toBeNull();
  });

  it('screenshot WS broadcast forwards payload when URL present', () => {
    const u = 'data:image/jpeg;base64,QQ==';
    expect(
      buildBrowserActivityScreenshotBroadcast({
        sessionId: 's',
        messageId: 'm',
        actionId: 'a',
        screenshotWsUrl: u,
      }),
    ).toEqual({
      type: 'browser_activity_screenshot',
      sessionId: 's',
      messageId: 'm',
      actionId: 'a',
      screenshotDataUrl: u,
    });
  });

  it('pairs started and ended via shared actionId and phase sequencing', () => {
    const actionId = 'corr-1';
    const label = 'Taking screenshot…';
    const startedAtMs = 100;
    const started = buildBrowserActivityStartedEvent({
      actionId,
      op: 'screenshot',
      label,
      startedAtMs,
    });
    const ended = buildBrowserActivityEndedEvent({
      actionId,
      op: 'screenshot',
      label,
      startedAtMs,
      durationMs: 50,
      b: {
        markdown: '',
        hostExit: 0,
        ui: { summary: 'Screenshot captured', screenshotCaptured: true },
      },
    });
    expect(started).toMatchObject({
      phase: 'started',
      actionId,
      type: 'browser_tool_activity',
    });
    expect(ended).toMatchObject({
      phase: 'ended',
      actionId,
      type: 'browser_tool_activity',
    });
  });

  it('throw-ended event records failure without screenshot hint', () => {
    const ev = buildBrowserActivityEndedThrowEvent({
      actionId: 'x',
      op: 'click',
      label: '…',
      startedAtMs: 0,
      durationMs: 1,
      err: new Error('boom'),
    });
    expect(ev.ok).toBe(false);
    expect(ev.error).toBe('boom');
    expect(ev.summary).toBe('Browser step failed');
    expect(ev.hasScreenshot).toBe(false);
  });
});
