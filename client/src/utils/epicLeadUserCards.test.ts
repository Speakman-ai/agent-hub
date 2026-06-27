import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveCurrentUserId,
  shouldPromptLeadUserCardAssign,
  maybePromptAssignLeadToEpicCards,
} from './epicLeadUserCards';

vi.mock('./auth.js', () => ({
  getAuthRecord: vi.fn(),
}));

vi.mock('./api.js', () => ({
  api: {
    assignEpicLeadToCards: vi.fn(),
  },
}));

import { getAuthRecord } from './auth';
import { api } from './api';

describe('epicLeadUserCards', () => {
  beforeEach(() => {
    vi.mocked(getAuthRecord).mockReturnValue(null);
    vi.mocked(api.assignEpicLeadToCards).mockReset();
  });

  it('resolveCurrentUserId prefers cached user id', () => {
    vi.mocked(getAuthRecord).mockReturnValue({
      token: 't',
      user: { id: 'u1', username: 'ryan' },
    } as any);
    expect(resolveCurrentUserId([{ id: 'u2', username: 'alex' }])).toBe('u1');
  });

  it('shouldPromptLeadUserCardAssign when self becomes lead', () => {
    expect(shouldPromptLeadUserCardAssign(null, 'u1', 'u1')).toBe(true);
    expect(shouldPromptLeadUserCardAssign('u2', 'u1', 'u1')).toBe(true);
    expect(shouldPromptLeadUserCardAssign('u1', 'u1', 'u1')).toBe(false);
    expect(shouldPromptLeadUserCardAssign(null, 'u1', 'u2')).toBe(false);
  });

  it('maybePromptAssignLeadToEpicCards calls bulk assign when confirmed', async () => {
    vi.mocked(getAuthRecord).mockReturnValue({
      token: 't',
      user: { id: 'u1', username: 'ryan' },
    } as any);
    vi.mocked(api.assignEpicLeadToCards).mockResolvedValue({ updatedCount: 3 });

    const confirm = vi.fn(() => true);
    const count = await maybePromptAssignLeadToEpicCards({
      projectId: 'p1',
      epicId: 'e1',
      previousUserId: null,
      nextUserId: 'u1',
      cardCount: 3,
      confirm,
    });

    expect(confirm).toHaveBeenCalled();
    expect(api.assignEpicLeadToCards).toHaveBeenCalledWith('p1', 'e1');
    expect(count).toBe(3);
  });

  it('maybePromptAssignLeadToEpicCards skips when declined', async () => {
    vi.mocked(getAuthRecord).mockReturnValue({
      token: 't',
      user: { id: 'u1', username: 'ryan' },
    } as any);

    const count = await maybePromptAssignLeadToEpicCards({
      projectId: 'p1',
      epicId: 'e1',
      previousUserId: null,
      nextUserId: 'u1',
      cardCount: 2,
      confirm: () => false,
    });

    expect(api.assignEpicLeadToCards).not.toHaveBeenCalled();
    expect(count).toBeNull();
  });
});
