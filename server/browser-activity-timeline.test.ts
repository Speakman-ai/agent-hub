// @ts-nocheck — timeline helpers are plain JS under `/shared` without typings.
import { describe, it, expect } from 'vitest';
import {
  deriveStreamingBrowserHint,
  mergeBrowserTimelineRows,
} from '../shared/utils/browserActivityTimeline.js';

describe('browserActivityTimeline', () => {
  it('deriveStreamingBrowserHint picks the last unmatched started label', () => {
    const timeline = [
      {
        seq: 1,
        event: {
          type: 'browser_tool_activity',
          actionId: 'a1',
          phase: 'started',
          label: 'Navigating to example.com…',
        },
      },
      {
        seq: 2,
        event: {
          type: 'browser_tool_activity',
          actionId: 'a2',
          phase: 'started',
          label: 'Taking screenshot…',
        },
      },
    ];
    expect(deriveStreamingBrowserHint(timeline)).toBe('Taking screenshot…');
  });

  it('deriveStreamingBrowserHint clears closed actions', () => {
    const timeline = [
      {
        seq: 1,
        event: { type: 'browser_tool_activity', actionId: 'a1', phase: 'started', label: 'Busy…' },
      },
      {
        seq: 2,
        event: {
          type: 'browser_tool_activity',
          actionId: 'a1',
          phase: 'ended',
          ok: true,
          summary: 'Done',
        },
      },
    ];
    expect(deriveStreamingBrowserHint(timeline)).toBeNull();
  });

  it('mergeBrowserTimelineRows folds start+end', () => {
    const timeline = [
      {
        seq: 1,
        event: {
          type: 'browser_tool_activity',
          actionId: 'x',
          phase: 'started',
          op: 'navigate',
          label: 'Nav…',
          startedAtMs: 1,
        },
      },
      {
        seq: 2,
        event: {
          type: 'browser_tool_activity',
          actionId: 'x',
          phase: 'ended',
          op: 'navigate',
          label: 'Nav…',
          startedAtMs: 1,
          ok: true,
          summary: 'Opened example.com',
          durationMs: 40,
        },
      },
    ];
    const rows = mergeBrowserTimelineRows(timeline);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('done');
    expect(rows[0].summary).toBe('Opened example.com');
  });
});
