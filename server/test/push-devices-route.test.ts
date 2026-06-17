import { describe, it, expect } from 'vitest';
import { getRequest } from './helpers.js';

/**
 * Integration tests for the mobile push device + preference endpoints:
 *   POST   /api/devices
 *   GET    /api/devices/:token
 *   PUT    /api/devices/:token/preferences
 *   DELETE /api/devices/:token
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

  it('updates preferences to a specific subset and strips unknown events', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-subset-${Date.now()}]`;
    await request.post('/api/devices').send({ token, platform: 'android' }).expect(200);

    const put = await request
      .put(`/api/devices/${encodeURIComponent(token)}/preferences`)
      .send({ enabledEvents: ['thread_message', 'pr_merged', 'definitely-bogus'] })
      .expect(200);
    expect(put.body.enabledEvents).toEqual(['thread_message', 'pr_merged']);

    const get = await request.get(`/api/devices/${encodeURIComponent(token)}`).expect(200);
    expect(get.body.enabledEvents).toEqual(['thread_message', 'pr_merged']);
  });

  it('clears preferences when null is passed (back to all events)', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-null-${Date.now()}]`;
    await request.post('/api/devices').send({ token }).expect(200);

    await request
      .put(`/api/devices/${encodeURIComponent(token)}/preferences`)
      .send({ enabledEvents: ['thread_message'] })
      .expect(200);

    const cleared = await request
      .put(`/api/devices/${encodeURIComponent(token)}/preferences`)
      .send({ enabledEvents: null })
      .expect(200);
    expect(cleared.body.enabledEvents).toBeNull();

    const get = await request.get(`/api/devices/${encodeURIComponent(token)}`).expect(200);
    expect(get.body.enabledEvents).toBeNull();
  });

  it('rejects non-array preferences with 400', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-bad-${Date.now()}]`;
    await request.post('/api/devices').send({ token }).expect(200);

    const res = await request
      .put(`/api/devices/${encodeURIComponent(token)}/preferences`)
      .send({ enabledEvents: 'not-an-array' })
      .expect(400);
    expect(res.body.error).toMatch(/array or null/);
  });

  it('returns 404 for an unknown token', async () => {
    const request = await getRequest();
    await request.get('/api/devices/does-not-exist').expect(404);
    await request
      .put('/api/devices/does-not-exist/preferences')
      .send({ enabledEvents: [] })
      .expect(404);
  });

  it('DELETE removes the token entirely', async () => {
    const request = await getRequest();
    const token = `ExponentPushToken[pref-delete-${Date.now()}]`;
    await request.post('/api/devices').send({ token }).expect(200);
    await request.delete(`/api/devices/${encodeURIComponent(token)}`).expect(200);
    await request.get(`/api/devices/${encodeURIComponent(token)}`).expect(404);
  });
});
