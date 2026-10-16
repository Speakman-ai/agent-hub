import { describe, expect, it } from 'vitest';
import {
  BROWSER_PANE_RECORDING_IDLE,
  browserPaneRecordingSavedNotice,
  browserPaneSavedRecordingId,
  formatRecordingRemaining,
  parseBrowserPaneRecording,
} from './browserPaneRecording';

describe('browser pane recording helpers', () => {
  it('parses active state and treats anything else as idle', () => {
    expect(
      parseBrowserPaneRecording({ active: true, startedAt: 1, endsAt: 600_001, steps: 3.7 }),
    ).toEqual({
      active: true,
      startedAt: 1,
      endsAt: 600_001,
      steps: 3,
    });
    expect(parseBrowserPaneRecording({ active: false, steps: 9 })).toBe(
      BROWSER_PANE_RECORDING_IDLE,
    );
    expect(parseBrowserPaneRecording(null)).toBe(BROWSER_PANE_RECORDING_IDLE);
  });

  it('formats the time left before the cap', () => {
    const rec = parseBrowserPaneRecording({
      active: true,
      startedAt: 0,
      endsAt: 600_000,
      steps: 0,
    });
    expect(formatRecordingRemaining(rec, 0)).toBe('10:00');
    expect(formatRecordingRemaining(rec, 599_001)).toBe('0:01');
    expect(formatRecordingRemaining(rec, 700_000)).toBe('0:00');
  });

  it('words the saved notice by stop reason', () => {
    expect(browserPaneRecordingSavedNotice({ steps: 1, stopReason: 'stopped' })).toBe(
      'Recording saved to Artifacts (1 step).',
    );
    expect(browserPaneRecordingSavedNotice({ steps: 4, stopReason: 'time_limit' })).toContain(
      '10 minute limit',
    );
  });
});

describe('browserPaneSavedRecordingId', () => {
  it('reads the saved artifact id and rejects malformed payloads', () => {
    expect(browserPaneSavedRecordingId({ artifact: { id: 'art-1' } })).toBe('art-1');
    expect(browserPaneSavedRecordingId({ artifact: { id: '' } })).toBeNull();
    expect(browserPaneSavedRecordingId({})).toBeNull();
    expect(browserPaneSavedRecordingId(null)).toBeNull();
  });
});
