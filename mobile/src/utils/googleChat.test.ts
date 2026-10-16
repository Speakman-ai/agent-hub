import { describe, expect, it } from 'vitest';
import { chatSenderLabel, chatSpaceLabel, sortChatMessages } from '@shared/utils/googleChat';

describe('googleChat labels', () => {
  it('uses a space name, then participants, then a type label', () => {
    expect(chatSpaceLabel({ id: 'AAA', displayName: 'Ops', spaceType: 'SPACE' })).toBe('Ops');
    expect(
      chatSpaceLabel({
        id: 'DM1',
        displayName: null,
        spaceType: 'DIRECT_MESSAGE',
        participants: ['Ada'],
      }),
    ).toBe('Ada');
    expect(chatSpaceLabel({ id: 'DM1', displayName: '  ', spaceType: 'DIRECT_MESSAGE' })).toBe(
      'Direct message · DM1',
    );
  });

  it('names a sender, and sorts messages oldest first', () => {
    expect(chatSenderLabel({ name: 'users/1', displayName: 'Ada', type: 'HUMAN' })).toBe('Ada');
    expect(chatSenderLabel(null)).toBe('Unknown sender');
    const sorted = sortChatMessages([
      { createTime: '2026-01-02T00:00:00Z' },
      { createTime: '2026-01-01T00:00:00Z' },
    ]);
    expect(sorted.map((m) => m.createTime)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    ]);
  });
});
