import { describe, it, expect, vi } from 'vitest';
import {
  canReceivePush,
  resolveExpoProjectId,
  buildDeviceRegistrationBody,
  registerForPushNotifications,
  presentLocalNotification,
} from './push.js';

describe('canReceivePush', () => {
  it('rejects simulators / missing Device', () => {
    expect(canReceivePush(undefined)).toBe(false);
    expect(canReceivePush(null)).toBe(false);
    expect(canReceivePush({ isDevice: false })).toBe(false);
  });
  it('accepts real devices', () => {
    expect(canReceivePush({ isDevice: true })).toBe(true);
  });
});

describe('resolveExpoProjectId', () => {
  it('prefers expoConfig.extra.eas.projectId', () => {
    expect(
      resolveExpoProjectId({ expoConfig: { extra: { eas: { projectId: 'abc' } } } }),
    ).toBe('abc');
  });
  it('falls back to legacy manifest shapes', () => {
    expect(
      resolveExpoProjectId({ manifest: { extra: { eas: { projectId: 'legacy1' } } } }),
    ).toBe('legacy1');
    expect(
      resolveExpoProjectId({
        manifest2: { data: { extra: { eas: { projectId: 'legacy2' } } } },
      }),
    ).toBe('legacy2');
  });
  it('returns undefined when nothing matches', () => {
    expect(resolveExpoProjectId({})).toBeUndefined();
    expect(resolveExpoProjectId()).toBeUndefined();
  });
});

describe('buildDeviceRegistrationBody', () => {
  it('produces the exact body shape the server expects', () => {
    expect(buildDeviceRegistrationBody('ExponentPushToken[x]', 'ios')).toEqual({
      token: 'ExponentPushToken[x]',
      platform: 'ios',
    });
  });
});

describe('registerForPushNotifications', () => {
  const baseNotifications = () => ({
    getPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
    requestPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
    getExpoPushTokenAsync: vi.fn().mockResolvedValue({ data: 'ExponentPushToken[T]' }),
  });

  it('returns unsupported when not a real device (no fetch)', async () => {
    const api = { registerDeviceToken: vi.fn() };
    const result = await registerForPushNotifications({
      api,
      Notifications: baseNotifications(),
      Device: { isDevice: false },
      Constants: {},
    });
    expect(result).toEqual({ token: null, permissionStatus: 'unsupported' });
    expect(api.registerDeviceToken).not.toHaveBeenCalled();
  });

  it('requests permission when not granted; bails when still denied', async () => {
    const api = { registerDeviceToken: vi.fn() };
    const Notifications = baseNotifications();
    Notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    Notifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const result = await registerForPushNotifications({
      api,
      Notifications,
      Device: { isDevice: true },
    });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(result).toEqual({ token: null, permissionStatus: 'denied' });
    expect(api.registerDeviceToken).not.toHaveBeenCalled();
  });

  it('registers the token with the server on success', async () => {
    const api = { registerDeviceToken: vi.fn().mockResolvedValue({ ok: true }) };
    const Notifications = baseNotifications();
    const result = await registerForPushNotifications({
      api,
      Notifications,
      Device: { isDevice: true },
      Constants: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
      Platform: { OS: 'android' },
    });
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(api.registerDeviceToken).toHaveBeenCalledWith('ExponentPushToken[T]', 'android');
    expect(result).toEqual({ token: 'ExponentPushToken[T]', permissionStatus: 'granted' });
  });

  it('omits projectId when none is configured', async () => {
    const api = { registerDeviceToken: vi.fn().mockResolvedValue({ ok: true }) };
    const Notifications = baseNotifications();
    await registerForPushNotifications({
      api,
      Notifications,
      Device: { isDevice: true },
      Constants: {},
      Platform: { OS: 'ios' },
    });
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith();
    expect(api.registerDeviceToken).toHaveBeenCalledWith('ExponentPushToken[T]', 'ios');
  });

  it('returns the token even if the server registration rejects so the UI can retry', async () => {
    const api = {
      registerDeviceToken: vi.fn().mockRejectedValue(new Error('server down')),
    };
    const Notifications = baseNotifications();
    const log = vi.fn();
    const result = await registerForPushNotifications({
      api,
      Notifications,
      Device: { isDevice: true },
      Platform: { OS: 'ios' },
      log,
    });
    expect(result.token).toBe('ExponentPushToken[T]');
    expect(log).toHaveBeenCalled();
  });

  it('swallows getExpoPushTokenAsync errors so the app keeps booting', async () => {
    const api = { registerDeviceToken: vi.fn() };
    const Notifications = baseNotifications();
    Notifications.getExpoPushTokenAsync.mockRejectedValue(new Error('no push service'));
    const log = vi.fn();
    const result = await registerForPushNotifications({
      api,
      Notifications,
      Device: { isDevice: true },
      log,
    });
    expect(result).toEqual({ token: null, permissionStatus: 'granted' });
    expect(api.registerDeviceToken).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});

describe('presentLocalNotification', () => {
  it('schedules a trigger-less notification', async () => {
    const Notifications = {
      scheduleNotificationAsync: vi.fn().mockResolvedValue('id-1'),
    };
    const id = await presentLocalNotification(
      { Notifications },
      { title: 'T', body: 'B', data: { k: 1 } },
    );
    expect(id).toBe('id-1');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'T', body: 'B', data: { k: 1 } },
      trigger: null,
    });
  });
  it('returns null on scheduler errors', async () => {
    const Notifications = {
      scheduleNotificationAsync: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const id = await presentLocalNotification({ Notifications }, { title: 'T', body: 'B' });
    expect(id).toBeNull();
  });
  it('no-ops gracefully when the module is missing', async () => {
    const id = await presentLocalNotification({}, { title: 'T', body: 'B' });
    expect(id).toBeNull();
  });
});
