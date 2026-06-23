import { describe, it, expect } from 'vitest';
import { formatReplayDuration, formatBytes, formatPageUrl } from './replayFormat';

describe('formatReplayDuration', () => {
  it('formats sub-minute spans as seconds', () => {
    expect(formatReplayDuration(0)).toBe('0s');
    expect(formatReplayDuration(900)).toBe('1s');
    expect(formatReplayDuration(45_000)).toBe('45s');
  });
  it('formats minute+ spans as m s', () => {
    expect(formatReplayDuration(60_000)).toBe('1m 0s');
    expect(formatReplayDuration(125_000)).toBe('2m 5s');
  });
  it('treats negative / non-finite as 0s', () => {
    expect(formatReplayDuration(-5)).toBe('0s');
    expect(formatReplayDuration(null)).toBe('0s');
    expect(formatReplayDuration(undefined)).toBe('0s');
    expect(formatReplayDuration(NaN)).toBe('0s');
  });
});

describe('formatBytes', () => {
  it('scales through units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(300 * 1024)).toBe('300 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB');
  });
  it('handles missing values', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});

describe('formatPageUrl', () => {
  it('reduces an absolute URL to host + path', () => {
    expect(formatPageUrl('https://app.example.com/orders/new?x=1')).toBe(
      'app.example.com/orders/new',
    );
    expect(formatPageUrl('https://app.example.com/')).toBe('app.example.com');
  });
  it('passes through non-URLs and blanks', () => {
    expect(formatPageUrl('not a url')).toBe('not a url');
    expect(formatPageUrl('')).toBe('—');
    expect(formatPageUrl(null)).toBe('—');
  });
});
