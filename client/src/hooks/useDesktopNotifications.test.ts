import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendDesktopNotification } from './useDesktopNotifications';

describe('sendDesktopNotification', () => {
  let originalElectronAPI: any;
  let originalNotification: any;

  beforeEach(() => {
    originalElectronAPI = window.electronAPI;
    originalNotification = window.Notification;
  });

  afterEach(() => {
    window.electronAPI = originalElectronAPI;
    (window as any).Notification = originalNotification;
  });

  describe('Electron path', () => {
    it('calls electronAPI.showNotification when in Electron', () => {
      const mockShow = vi.fn();
      window.electronAPI = { isElectron: true, showNotification: mockShow };

      const result = sendDesktopNotification({ title: 'Test', body: 'Hello' });

      expect(result!).toBe(true);
      expect(mockShow!).toHaveBeenCalledWith({
        title: 'Test',
        body: 'Hello',
        type: 'info',
        silent: false,
      });
    });

    it('passes type and silent options through', () => {
      const mockShow = vi.fn();
      window.electronAPI = { isElectron: true, showNotification: mockShow };

      sendDesktopNotification({ title: 'Error', body: 'Fail', type: 'error', silent: true });

      expect(mockShow!).toHaveBeenCalledWith({
        title: 'Error',
        body: 'Fail',
        type: 'error',
        silent: true,
      });
    });
  });

  describe('Browser Notifications API path', () => {
    it('creates a Notification when permission is granted', () => {
      window.electronAPI = undefined;
      const instances: any[] = [];
      (window as any).Notification = class MockNotification {
        constructor(title: any, options: any) {
          instances.push({ title, ...options });
        }
        static permission = 'granted';
      };

      const result = sendDesktopNotification({ title: 'Browser', body: 'Test' });

      expect(result!).toBe(true);
      expect(instances!).toHaveLength(1);
      expect(instances[0].title).toBe('Browser');
      expect(instances[0].body).toBe('Test');
    });

    it('requests permission when not yet decided', () => {
      window.electronAPI = undefined;
      const requestPermission = vi.fn().mockResolvedValue('denied');
      (window as any).Notification = class MockNotification {
        constructor() {}
        static permission = 'default';
        static requestPermission = requestPermission;
      };

      const result = sendDesktopNotification({ title: 'Ask', body: 'Permission' });

      expect(result!).toBe(false); // pending
      expect(requestPermission!).toHaveBeenCalled();
    });

    it('returns false when permission is denied', () => {
      window.electronAPI = undefined;
      (window as any).Notification = class MockNotification {
        constructor() {}
        static permission = 'denied';
      };

      const result = sendDesktopNotification({ title: 'Denied', body: 'Nope' });

      expect(result!).toBe(false);
    });
  });

  describe('fallback', () => {
    it('returns false when neither Electron nor browser notifications are available', () => {
      window.electronAPI = undefined;
      delete (window as any).Notification;

      const result = sendDesktopNotification({ title: 'Nowhere', body: 'No API' });

      expect(result!).toBe(false);
    });
  });
});
