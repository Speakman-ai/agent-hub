import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isNotificationChannelEnabled } from '../utils/notificationPrefsStore';
import { useDesktopNotifications } from './useDesktopNotifications';

(vi as any).mock('../utils/notificationPrefsStore.js', () => ({
  isNotificationChannelEnabled: vi.fn(() => true),
}));

describe('useDesktopNotifications prefs gate', () => {
  let originalElectronAPI: any;
  const show = vi.fn();

  beforeEach(() => {
    originalElectronAPI = window.electronAPI;
    window.electronAPI = { isElectron: true, showNotification: show } as any;
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    show.mockReset();
    vi.mocked(isNotificationChannelEnabled).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    window.electronAPI = originalElectronAPI;
    vi.restoreAllMocks();
  });

  it('skips a category whose desktop channel is off', () => {
    vi.mocked(isNotificationChannelEnabled).mockImplementation(
      (category, channel) => !(category === 'session_completed' && channel === 'desktop'),
    );
    const { result } = renderHook(() => useDesktopNotifications());
    result.current.notify({ title: 'Done', body: 'x', category: 'session_completed' });
    expect(show).not.toHaveBeenCalled();
    result.current.notify({ title: 'Waiting', body: 'y', category: 'awaiting_feedback' });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Waiting' }));
  });

  it('does not consult prefs for uncategorized notices', () => {
    vi.mocked(isNotificationChannelEnabled).mockReturnValue(false);
    const { result } = renderHook(() => useDesktopNotifications());
    result.current.notify({ title: 'Task Failed', body: 'z', type: 'error' });
    expect(show).toHaveBeenCalledTimes(1);
    expect(isNotificationChannelEnabled).not.toHaveBeenCalled();
  });

  it('stays quiet while the window has focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useDesktopNotifications());
    result.current.notify({ title: 'Waiting', category: 'awaiting_feedback' });
    expect(show).not.toHaveBeenCalled();
  });
});
