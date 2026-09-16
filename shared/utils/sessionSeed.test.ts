import { describe, expect, it } from 'vitest';
import { buildEmailSessionSeed, buildTodoSessionSeed } from './sessionSeed';

describe('buildEmailSessionSeed', () => {
  it('includes subject, headers, link, and prefers full body over snippet', () => {
    const seed = buildEmailSessionSeed({
      subject: 'Q3 planning',
      from: 'alice@example.com',
      to: 'me@example.com',
      snippet: 'short snippet',
      bodyText: 'Full body text here.',
      deepLink: 'https://mail.google.com/mail/u/0/#all/abc',
    });
    expect(seed).toContain('**Subject:** Q3 planning');
    expect(seed).toContain('**From:** alice@example.com');
    expect(seed).toContain('**To:** me@example.com');
    expect(seed).toContain('**Link:** https://mail.google.com/mail/u/0/#all/abc');
    expect(seed).toContain('Full body text here.');
    expect(seed).not.toContain('short snippet');
  });

  it('falls back to the snippet when there is no body', () => {
    const seed = buildEmailSessionSeed({ subject: 'Hi', snippet: 'just a snippet' });
    expect(seed).toContain('just a snippet');
  });

  it('omits empty header lines and uses a subject fallback', () => {
    const seed = buildEmailSessionSeed({ from: '', to: null, snippet: 'body' });
    expect(seed).toContain('**Subject:** (no subject)');
    expect(seed).not.toContain('**From:**');
    expect(seed).not.toContain('**To:**');
    expect(seed).not.toContain('**Link:**');
  });

  it('clamps a very long body', () => {
    const seed = buildEmailSessionSeed({ subject: 'x', bodyText: 'a'.repeat(20_000) });
    // Header lines + clamped body stay well under the 8k body cap plus headers.
    expect(seed.length).toBeLessThan(8_200);
    expect(seed.endsWith('…')).toBe(true);
  });
});

describe('buildTodoSessionSeed', () => {
  it('includes title, notes, and origin', () => {
    const seed = buildTodoSessionSeed({
      title: 'Reply to Bob',
      notes: 'He asked about the invoice.',
      originLabel: 'From email',
      deepLink: 'https://mail.google.com/mail/u/0/#all/xyz',
    });
    expect(seed).toContain('**Todo:** Reply to Bob');
    expect(seed).toContain('**Origin:** From email — https://mail.google.com/mail/u/0/#all/xyz');
    expect(seed).toContain('He asked about the invoice.');
  });

  it('omits origin and notes when absent and falls back on an empty title', () => {
    const seed = buildTodoSessionSeed({ title: '', notes: '' });
    expect(seed).toContain('**Todo:** Untitled todo');
    expect(seed).not.toContain('**Origin:**');
  });

  it('renders origin with only a label when there is no deep link', () => {
    const seed = buildTodoSessionSeed({ title: 'x', originLabel: 'From calendar' });
    expect(seed).toContain('**Origin:** From calendar');
    expect(seed).not.toContain(' — ');
  });
});
