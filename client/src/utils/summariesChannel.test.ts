import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHubChatSession, resetHubChatSessionForTests } from './hubChatSession';
import { openSummariesChannel } from './summariesChannel';

describe('openSummariesChannel', () => {
  beforeEach(() => resetHubChatSessionForTests());

  it('selects the Summaries channel the server returns', async () => {
    const open = vi.fn().mockResolvedValue({ channel: { id: 'sum-1' } });
    await expect(openSummariesChannel(open)).resolves.toBe('sum-1');
    expect(getHubChatSession().selectedId).toBe('sum-1');
    expect(getHubChatSession().focus).toEqual({ channelId: 'sum-1', messageId: null });
  });

  it('leaves the chat selection alone when the lookup fails', async () => {
    const open = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(openSummariesChannel(open)).resolves.toBeNull();
    expect(getHubChatSession().selectedId).toBeNull();
  });
});
