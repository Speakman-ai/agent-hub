import { describe, expect, it } from 'vitest';
import { buildBugReportTicketBody } from './routes/bug-reports.js';
import { redactCardDescriptionForGit } from './pr-body-redaction.js';

const BUG_CARD = [
  'Sessions pause mid-run and restart.',
  '',
  '---',
  '',
  '### Reporter Context',
  '- **Source URL:** https://hub.internal.example/#/chat',
  '- **User Agent:** Mozilla/5.0',
  '- **Reported From Agent:** private-project-dev',
  '- **Session Replay:** `/uploads/replay-abc.json` (trailing window)',
  '',
  '---',
  'Converted from support ticket `ae201208` (bug, medium).',
].join('\n');

describe('redactCardDescriptionForGit', () => {
  it('removes the Reporter Context block and keeps the rest', () => {
    const out = redactCardDescriptionForGit(BUG_CARD);
    expect(out).not.toMatch(/Reporter Context|Source URL|hub\.internal|private-project|replay-abc/);
    expect(out).toContain('Sessions pause mid-run and restart.');
    expect(out).toContain('Converted from support ticket');
  });

  it('strips the block the bug-report route actually generates', () => {
    const body = buildBugReportTicketBody({
      title: 't',
      description: 'Button does nothing',
      severity: 'medium',
      sourceUrl: 'https://hub.internal.example/#/x',
      userAgent: 'UA',
      currentAgentId: 'private-project-dev',
    } as Parameters<typeof buildBugReportTicketBody>[0]);
    const out = redactCardDescriptionForGit(body);
    expect(out).toBe('Button does nothing');
  });

  it('leaves descriptions without a Reporter Context section unchanged', () => {
    const plain = '**Problem:** x\n\n---\n\n## Acceptance\n- [ ] y';
    expect(redactCardDescriptionForGit(plain)).toBe(plain);
  });

  it('handles null/empty', () => {
    expect(redactCardDescriptionForGit(null)).toBe('');
    expect(redactCardDescriptionForGit('')).toBe('');
  });
});
