import { describe, it, expect } from 'vitest';
import { getRequest } from './helpers.js';

/**
 * Integration tests for the mobile push device endpoints:
 *   POST   /api/devices
 *   GET    /api/devices/:token
 *   DELETE /api/devices/:token
 *
 * Push preferences are per user (`/api/me/notification-preferences`); the
 * per-device preferences route is gone.
 */

describe('device token preference routes', () => {
  it('registers a token, returns prefs with all events enabled by default', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-default-${Date.now()}]`;

    await request.post('/api/devices').send({ token, platform: 'ios' }).expect(200);

    const res = await request.get(`/api/devices/${encodeURIComponent(token)}`).expect(200);
    expect(res.body.token).toBe(token);
    expect(res.body.platform).toBe('ios');
    expect(res.body.enabledEvents).toBeNull();
    expect(Array.isArray(res.body.supportedEvents)).toBe(true);
    expect(res.body.supportedEvents).toContain('awaiting_feedback');
    expect(res.body.supportedEvents).toContain('pr_merged');
  });

  it('no longer accepts per-device preference writes', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-retired-${Date.now()}]`;
    await request.post('/api/devices').send({ token, platform: 'android' }).expect(200);

    await request
      .put(`/api/devices/${encodeURIComponent(token)}/preferences`)
      .send({ enabledEvents: ['pr_merged'] })
      .expect(404);

    const get = await request.get(`/api/devices/${encodeURIComponent(token)}`).expect(200);
    expect(get.body.enabledEvents).toBeNull();
  });

  it('returns 404 for an unknown token', async () => {
    const request = await getRequest();
    await request.get('/api/devices/does-not-exist').expect(404);
  });

  it('DELETE removes the token entirely', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-delete-${Date.now()}]`;
    await request.post('/api/devices').send({ token }).expect(200);
    await request.delete(`/api/devices/${encodeURIComponent(token)}`).expect(200);
    await request.get(`/api/devices/${encodeURIComponent(token)}`).expect(404);
  });
});
