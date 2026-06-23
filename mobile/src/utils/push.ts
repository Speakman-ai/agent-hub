/**
 * Expo push notification registration + foreground presentation helpers.
 *
 * At app start we:
 *  1. Request permission for remote notifications (if not already granted).
 *  2. Grab an ExpoPushToken via `expo-notifications`.
 *  3. Register the token with the backend via `POST /api/devices` so Expo
 *     pushes from the server reach this device.
 *
 * While the app is foregrounded, incoming broadcasts are converted to
 * locally-scheduled notifications so the user still sees a banner even
 * though Expo's remote push system typically suppresses foreground pushes
 * by default.
 *
 * The functional core (URL building, payload shaping) is pulled out of the
 * native-module calls so Vitest can exercise it without mocking Expo.
 *
 * TRIGGER order is:
 *   - `registerForPushNotifications({ api, Notifications, Device, Constants })`
 *     → returns { token, permissionStatus }
 *   - `presentLocalNotification({ Notifications }, { title, body, data })`
 */
/**
 * Returns true iff the platform can receive real push notifications.
 * Simulators/emulators cannot. Callers that pass a stub Device can test
 * the branching without RN imports.
 *
 * @param {{ isDevice?: boolean }} Device
 * @returns {boolean}
 */
export function canReceivePush(Device: any) {
    return !!Device && Device.isDevice === true;
}
/**
 * Extract the project ID that `getExpoPushTokenAsync` requires. Expo v49+
 * requires `projectId` when using the managed workflow; fall back to the
 * legacy `Constants.manifest` shape for older SDKs.
 *
 * @param {object} Constants - `expo-constants` export
 * @returns {string | undefined}
 */
export function resolveExpoProjectId(Constants: any) {
    if (!Constants)
        return undefined;
    const expoConfig = Constants.expoConfig;
    const cfgProjectId = expoConfig?.extra?.eas?.projectId;
    if (cfgProjectId)
        return cfgProjectId;
    const manifest = Constants.manifest || Constants.manifest2;
    const legacy = manifest?.extra?.eas?.projectId ||
        manifest?.data?.extra?.eas?.projectId ||
        undefined;
    return legacy;
}
/**
 * Build the payload body for `POST /api/devices`.
 * Exposed so tests can assert the exact contract without spinning up fetch.
 *
 * @param {string} token
 * @param {string} platform
 * @returns {{ token: string, platform: string }}
 */
export function buildDeviceRegistrationBody(token: any, platform: any) {
    return { token, platform };
}
/**
 * Run the full registration flow:
 *  - ask for permission if not already granted
 *  - fetch an Expo push token
 *  - POST it to the server
 *
 * All native modules are injected so this can be imported and unit-tested
 * in isolation.
 *
 * @param {{
 *   api: { registerDeviceToken: (token: string, platform: string) => Promise<any> },
 *   Notifications: {
 *     getPermissionsAsync: () => Promise<{ status: string }>,
 *     requestPermissionsAsync: () => Promise<{ status: string }>,
 *     getExpoPushTokenAsync: (opts?: { projectId?: string }) => Promise<{ data: string }>,
 *   },
 *   Device?: { isDevice?: boolean },
 *   Constants?: any,
 *   Platform?: { OS?: string },
 *   log?: (msg: string, err?: unknown) => void,
 * }} args
 * @returns {Promise<{ token: string | null, permissionStatus: string }>}
 */
export async function registerForPushNotifications({ api, Notifications, Device, Constants, Platform, log = console.warn, }: any) {
    if (!canReceivePush(Device)) {
        return { token: null, permissionStatus: 'unsupported' };
    }
    let perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') {
        perm = await Notifications.requestPermissionsAsync();
    }
    if (perm.status !== 'granted') {
        return { token: null, permissionStatus: perm.status };
    }
    const projectId = resolveExpoProjectId(Constants);
    let tokenResp;
    try {
        tokenResp = projectId
            ? await Notifications.getExpoPushTokenAsync({ projectId })
            : await Notifications.getExpoPushTokenAsync();
    }
    catch (err: any) {
        log('[push] getExpoPushTokenAsync failed', err);
        return { token: null, permissionStatus: perm.status };
    }
    const token = tokenResp?.data;
    if (!token)
        return { token: null, permissionStatus: perm.status };
    const platform = Platform?.OS === 'android' ? 'android' : 'ios';
    try {
        await api.registerDeviceToken(token, platform);
    }
    catch (err: any) {
        log('[push] registerDeviceToken failed', err);
        return { token, permissionStatus: perm.status };
    }
    return { token, permissionStatus: perm.status };
}
/**
 * Show a local notification (foreground banner) — typically used for events
 * arriving via the already-open WebSocket so the user sees them even when
 * OS-level push delivery is suppressed for foregrounded apps.
 *
 * @param {{ Notifications: { scheduleNotificationAsync: (req: object) => Promise<string> } }} deps
 * @param {{ title: string, body: string, data?: object }} content
 * @returns {Promise<string | null>} scheduler-returned id, or null on failure
 */
export async function presentLocalNotification({ Notifications }: any, { title, body, data }: any) {
    if (!Notifications?.scheduleNotificationAsync)
        return null;
    try {
        return await Notifications.scheduleNotificationAsync({
            content: { title, body, data },
            trigger: null,
        });
    }
    catch (err: any) {
        console.warn('[push] scheduleNotificationAsync failed', err);
        return null;
    }
}
