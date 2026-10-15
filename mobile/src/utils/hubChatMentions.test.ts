import { describe, expect, it } from 'vitest';
import { parseMentionNotices } from '@shared/utils/hubChat';
import { mergeNotices } from './hubChatMentions';

describe('mergeNotices', () => {
  it('shows a notice once when both the response and the live event carry it', () => {
    const fromResponse = parseMentionNotices(
      [{ agentId: 'docs', code: 'mention_not_eligible', message: '@Docs cannot answer.' }],
      { channelId: 'c1', messageId: 'm1' },
    );
    const live = parseMentionNotices({
      channelId: 'c1',
      messageId: 'm1',
      agentId: 'docs',
      code: 'mention_not_eligible',
      message: '@Docs cannot answer.',
    });
    const once = mergeNotices([], fromResponse);
    expect(once).toHaveLength(1);
    expect(mergeNotices(once, live)).toBe(once);
  });

  it('keeps notices for different posts', () => {
    const a = parseMentionNotices({ channelId: 'c1', messageId: 'm1', agentId: 'x', message: 'a' });
    const b = parseMentionNotices({ channelId: 'c1', messageId: 'm2', agentId: 'x', message: 'b' });
    expect(mergeNotices(a, b).map((n) => n.message)).toEqual(['a', 'b']);
  });
});
