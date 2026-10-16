import { describe, it, expect } from 'vitest';
import {
  chatDigestAgents,
  chatDigestDraftFrom,
  chatDigestDraftReady,
  chatDigestSaveBody,
  chatDigestStatusText,
  describeDigestSchedule,
  splitDigestCron,
  type ChatDigest,
} from './chatDigest.js';

const fmt = (iso: string) => iso.slice(0, 16);

describe('chatDigestStatusText', () => {
  it('reports no digest, not-yet-run, posted and skipped runs', () => {
    expect(chatDigestStatusText(null)).toBe('No digest scheduled.');
    const base = { enabled: true, lastRunAt: null, lastStatus: null, lastError: null };
    expect(chatDigestStatusText(base, fmt)).toBe('Not run yet.');
    expect(
      chatDigestStatusText(
        { ...base, lastRunAt: '2026-10-14T09:00:00Z', lastStatus: 'posted' },
        fmt,
      ),
    ).toBe('Last run 2026-10-14T09:00: posted a digest.');
    expect(
      chatDigestStatusText(
        { ...base, enabled: false, lastRunAt: '2026-10-14T09:00:00Z', lastStatus: 'skipped' },
        fmt,
      ),
    ).toBe('Paused. Last run 2026-10-14T09:00: nothing new, skipped posting.');
  });

  it('surfaces the failure reason', () => {
    expect(
      chatDigestStatusText(
        { enabled: true, lastRunAt: null, lastStatus: 'error', lastError: 'no engine' },
        fmt,
      ),
    ).toBe('Last run failed: no engine');
  });
});

describe('describeDigestSchedule', () => {
  it('describes the cron and names the zone', () => {
    expect(describeDigestSchedule('0 9 * * *', 'UTC')).toContain('(UTC)');
    expect(describeDigestSchedule('not a cron', '')).toBe('not a cron');
  });
});

describe('splitDigestCron', () => {
  it('splits on | and normalizes each expression', () => {
    expect(splitDigestCron(' 0  8 * * * |30 9 * * *| ')).toEqual(['0 8 * * *', '30 9 * * *']);
    expect(splitDigestCron('0 9 * * 1-5')).toEqual(['0 9 * * 1-5']);
  });

  it('describes every expression of a joined schedule', () => {
    const text = describeDigestSchedule('0 8 * * * | 30 9 * * *', 'UTC');
    expect(text.split('; ')).toHaveLength(2);
    expect(text).toContain('(UTC)');
  });
});

describe('chatDigestAgents', () => {
  it('leaves out roles that cannot host a session', () => {
    const agents = [
      { id: 'dev' },
      { id: 'rev', role: 'reviewer' },
      { id: 'docs', role: ' Docs ' },
      { id: 'ops', role: 'ops' },
    ];
    expect(chatDigestAgents(agents).map((a) => a.id)).toEqual(['dev', 'ops']);
    expect(chatDigestAgents(undefined)).toEqual([]);
  });
});

describe('agent digest drafts', () => {
  const saved: ChatDigest = {
    id: 'd1',
    channelId: 'c1',
    name: 'Daily',
    enabled: true,
    cron: '0 9 * * *',
    timeZone: 'UTC',
    scope: 'project',
    projectIds: ['web', 'api'],
    prompt: null,
    agentId: null,
    skills: [],
    ownerUserId: 'u1',
    windowStart: 'x',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastMessageId: null,
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('a new draft is an agent digest that needs a project, agent and prompt', () => {
    const draft = chatDigestDraftFrom(null, 'web');
    expect(draft.scope).toBe('agent');
    expect(draft.projectId).toBe('web');
    expect(chatDigestDraftReady(draft)).toBe(false);
    const filled = { ...draft, agentId: 'web-dev', prompt: 'Check the logs', skills: ['logs'] };
    expect(chatDigestDraftReady(filled)).toBe(true);
    expect(chatDigestSaveBody(filled)).toMatchObject({
      scope: 'agent',
      projectIds: ['web'],
      agentId: 'web-dev',
      skills: ['logs'],
      prompt: 'Check the logs',
    });
    expect(chatDigestDraftReady({ ...filled, prompt: '   ' })).toBe(false);
  });

  it('a built-in digest saves under its own scope until an agent is picked', () => {
    const draft = chatDigestDraftFrom(saved, 'web');
    expect(draft.projectId).toBe('');
    expect(chatDigestDraftReady(draft)).toBe(true);
    expect(chatDigestSaveBody(draft)).toMatchObject({
      scope: 'project',
      projectIds: ['web', 'api'],
    });
    const converted = { ...draft, projectId: 'web', agentId: 'web-dev', prompt: 'Do it' };
    expect(chatDigestSaveBody(converted)).toMatchObject({
      scope: 'agent',
      projectIds: ['web'],
      agentId: 'web-dev',
    });
  });
});
