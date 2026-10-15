import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNotificationChannelEnabled } from './notificationPrefsStore';
import { desktopNoticeForNotificationCreated, toastAllowed } from './notificationDesktop';

(vi as any).mock('./notificationPrefsStore.js', () => ({
  isNotificationChannelEnabled: vi.fn(() => true),
}));

const event = (over: Record<string, unknown> = {}, notification: Record<string, unknown> = {}) => ({
  type: 'notification_created',
  desktop: true,
  notification: {
    id: 'n1',
    category: 'awaiting_feedback',
    title: 'Waiting on you',
    body: '"Fix bug" needs input',
    ...notification,
  },
  ...over,
});

describe('desktopNoticeForNotificationCreated', () => {
  it('turns a desktop-enabled inbox row into notice copy', () => {
    expect(desktopNoticeForNotificationCreated(event())).toEqual({
      title: 'Waiting on you',
      body: '"Fix bug" needs input',
      category: 'awaiting_feedback',
    });
  });

  it('stays quiet when the recipient turned desktop off for the category', () => {
    expect(desktopNoticeForNotificationCreated(event({ desktop: false }))).toBeNull();
    expect(desktopNoticeForNotificationCreated(event({ desktop: undefined }))).toBeNull();
  });

  it('notifies for DMs and mentions outside the open channel', () => {
    const dm = event({}, { category: 'dm', title: 'bob', data: { channelId: 'c1' } });
    expect(desktopNoticeForNotificationCreated(dm)?.category).toBe('dm');
    expect(
      desktopNoticeForNotificationCreated(dm, { isViewingChannel: (id) => id === 'c2' }),
    ).not.toBeNull();
  });

  it('suppresses a DM or mention for the channel on screen', () => {
    const viewing = { isViewingChannel: (id: string) => id === 'c1' };
    for (const category of ['dm', 'mention']) {
      const e = event({}, { category, data: { channelId: 'c1' } });
      expect(desktopNoticeForNotificationCreated(e, viewing)).toBeNull();
    }
  });

  it('respects the desktop flag for chat categories too', () => {
    const e = event({ desktop: false }, { category: 'mention', data: { channelId: 'c1' } });
    expect(desktopNoticeForNotificationCreated(e)).toBeNull();
  });

  it('ignores malformed events', () => {
    expect(desktopNoticeForNotificationCreated(null)).toBeNull();
    expect(desktopNoticeForNotificationCreated({ desktop: true })).toBeNull();
    expect(desktopNoticeForNotificationCreated(event({}, { title: undefined }))).toBeNull();
  });
});

describe('toastAllowed', () => {
  beforeEach(() => vi.mocked(isNotificationChannelEnabled).mockReset());

  it('reads the in_app channel for the category', () => {
    vi.mocked(isNotificationChannelEnabled).mockReturnValue(false);
    expect(toastAllowed('session_completed')).toBe(false);
    expect(isNotificationChannelEnabled).toHaveBeenCalledWith('session_completed', 'in_app');
  });
});
