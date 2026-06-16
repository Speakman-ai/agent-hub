import { describe, it, expect, vi } from 'vitest';
import { sortTickets, resolveReplayUrl, resolveUploadUrl } from './supportTickets';

vi.mock('./config', () => ({
  getServerBaseUrl: () => 'https://hub.example.com',
}));

function ticket(o) {
  return { id: o.id, severity: o.severity, created_at: o.created_at };
}

describe('sortTickets', () => {
  it('orders by severity (critical → low) then newest first', () => {
    const sorted = sortTickets([
      ticket({ id: 'low', severity: 'low', created_at: '2026-06-14 12:00:00' }),
      ticket({ id: 'crit', severity: 'critical', created_at: '2026-06-14 09:00:00' }),
      ticket({ id: 'high', severity: 'high', created_at: '2026-06-14 11:00:00' }),
      ticket({ id: 'med-old', severity: 'medium', created_at: '2026-06-14 08:00:00' }),
      ticket({ id: 'med-new', severity: 'medium', created_at: '2026-06-14 13:00:00' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['crit', 'high', 'med-new', 'med-old', 'low']);
  });

  it('does not mutate the input array', () => {
    const input = [
      ticket({ id: 'a', severity: 'low', created_at: '1' }),
      ticket({ id: 'b', severity: 'critical', created_at: '2' }),
    ];
    sortTickets(input);
    expect(input.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('treats unknown severities as least urgent', () => {
    const sorted = sortTickets([
      ticket({ id: 'weird', severity: 'bogus', created_at: '2' }),
      ticket({ id: 'low', severity: 'low', created_at: '1' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['low', 'weird']);
  });
});

describe('resolveReplayUrl', () => {
  it('passes absolute URLs through unchanged', () => {
    expect(resolveReplayUrl('https://x.test/r.json')).toBe('https://x.test/r.json');
    expect(resolveReplayUrl('http://x.test/r.json')).toBe('http://x.test/r.json');
  });

  it('prefixes server-relative paths with the server base', () => {
    expect(resolveReplayUrl('/uploads/r.json')).toBe('https://hub.example.com/uploads/r.json');
    expect(resolveReplayUrl('uploads/r.json')).toBe('https://hub.example.com/uploads/r.json');
  });

  it('returns null for an empty ref', () => {
    expect(resolveReplayUrl(null)).toBe(null);
    expect(resolveReplayUrl('')).toBe(null);
  });
});

describe('resolveUploadUrl', () => {
  it('resolves screenshot refs the same way (and is what resolveReplayUrl aliases)', () => {
    expect(resolveUploadUrl('/uploads/support-screenshot-abc.png')).toBe(
      'https://hub.example.com/uploads/support-screenshot-abc.png',
    );
    expect(resolveUploadUrl('https://cdn.test/shot.png')).toBe('https://cdn.test/shot.png');
    expect(resolveUploadUrl(null)).toBe(null);
    expect(resolveReplayUrl).toBe(resolveUploadUrl);
  });
});
